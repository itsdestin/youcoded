#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { run } from './ci-policy.mjs';
import { hash, identity, manifest, verifyCore, verifyInstalled, transport, unpack } from './ci-evidence.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), desktop = path.join(root, 'desktop');
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const formats = ['AppImage', 'deb', 'rpm', 'pacman'];
export function packageArgs(format, mode, app, output) {
  assert.ok(formats.includes(format)); assert.ok(['default', 'fast'].includes(mode));
  assert.ok(path.isAbsolute(app) && path.isAbsolute(output) && app !== output);
  const codec = { deb: 'gz', rpm: 'gzip', pacman: 'gz' }[format];
  return ['--linux', format, '--x64', '--prepackaged', app, `-c.directories.output=${output}`,
    ...(mode === 'fast' && codec ? [`-c.${format}.compression=${codec}`] : []), '--publish', 'never'];
}
export function validateMetadata(format, value, expected) {
  assert.equal(value.name, expected.name); assert.equal(value.version, expected.version);
  assert.ok(Array.isArray(value.dependencies) && value.dependencies.length > 0, 'Missing runtime dependencies');
  if (format === 'pacman') assert.deepEqual([...value.dependencies].sort(), [...expected.pacmanDependencies].sort());
  else for (const dependency of expected.nativeDependencies[format]) assert.ok(value.dependencies.includes(dependency), `Missing current configured dependency ${dependency}`);
  assert.ok(value.scripts.trim().length > 0, 'Missing install/remove scripts');
  assert.ok(value.scripts.includes(`/opt/${expected.productName}/`), 'Scripts do not address current app path');
  assert.ok(value.scripts.includes('chrome-sandbox') && value.scripts.includes('update-desktop-database'), 'Missing sandbox/desktop install integration');
  assert.ok(value.desktop.includes('[Desktop Entry]') && value.desktop.includes(`Name=${expected.productName}`));
  assert.match(value.desktop, /^Type=Application\r?$/m); assert.match(value.desktop, /^Exec=.+/m);
  assert.ok(value.desktop.includes(`Categories=${expected.category}`), 'Wrong current desktop category');
  assert.ok(value.icons.length > 0, 'No installed icons');
}
export async function expectedMetadata() {
  const { parse } = await import('../desktop/node_modules/yaml/dist/index.js');
  const config = parse(fs.readFileSync(path.join(desktop, 'electron-builder.yml'), 'utf8'));
  const pkg = read(path.join(desktop, 'package.json'));
  // WHY: this installed builder exports the class as exports.default, not a
  // named ESM export. Resolve its real CJS API from the desktop dependency root.
  const require = createRequire(path.join(desktop, 'package.json'));
  const FpmTarget = require('app-builder-lib/out/targets/FpmTarget.js').default;
  const dependencies = format => config[format]?.depends ?? config.linux.depends ?? FpmTarget.prototype.getDefaultDepends(format);
  return { name: pkg.name, version: pkg.version, productName: config.productName, category: config.linux.category,
    pacmanDependencies: dependencies('pacman'), nativeDependencies: { deb: dependencies('deb'), rpm: dependencies('rpm') }, config };
}
async function nativeMetadata(format, installer, payload, directory, expected) {
  const metadata = path.join(directory, 'metadata'); fs.mkdirSync(metadata);
  let name, version, dependencies, scripts;
  const text = async (command, args, filename) => {
    const result = (await run(command, args)).toString(); fs.writeFileSync(path.join(metadata, filename), result); return result.trim();
  };
  if (format === 'deb') {
    await run('dpkg-deb', ['-x', installer, payload]); await run('dpkg-deb', ['-e', installer, metadata]);
    name = await text('dpkg-deb', ['-f', installer, 'Package'], 'name'); version = await text('dpkg-deb', ['-f', installer, 'Version'], 'version');
    dependencies = (await text('dpkg-deb', ['-f', installer, 'Depends'], 'dependencies')).split(',').map(x => x.trim());
    for (const key of ['control', 'postinst', 'postrm']) assert.ok(fs.statSync(path.join(metadata, key)).size > 0);
    scripts = ['postinst', 'postrm'].map(key => fs.readFileSync(path.join(metadata, key), 'utf8')).join('\n');
    for (const key of ['postinst', 'postrm']) await run('bash', ['-n', path.join(metadata, key)]);
  } else {
    await run('bsdtar', ['-xpf', installer, '-C', payload]);
    if (format === 'rpm') {
      await text('rpm', ['-qp', '--xml', installer], 'raw.xml');
      const values = (await text('rpm', ['-qp', '--queryformat', '%{NAME}\n%{VERSION}\n', installer], 'identity')).split('\n');
      [name, version] = values;
      dependencies = (await text('rpm', ['-qp', '--requires', installer], 'requires')).split('\n');
      scripts = await text('rpm', ['-qp', '--scripts', installer], 'scripts');
      for (const tag of ['PREIN', 'POSTIN', 'PREUN', 'POSTUN']) {
        const body = await text('rpm', ['-qp', '--queryformat', `%{${tag}}`, installer], tag);
        if (body && body !== '(none)') await run('bash', ['-n', path.join(metadata, tag)]);
      }
      for (const query of ['provides', 'conflicts', 'obsoletes', 'recommends', 'suggests', 'supplements', 'enhances', 'triggers', 'dump']) await text('rpm', ['-qp', `--${query}`, installer], query);
      for (const dependency of ['REQUIRE', 'PROVIDE', 'CONFLICT', 'OBSOLETE', 'RECOMMEND', 'SUGGEST', 'SUPPLEMENT', 'ENHANCE']) {
        await text('rpm', ['-qp', '--queryformat', `[%{${dependency}NAME}\t%{${dependency}FLAGS}\t%{${dependency}VERSION}\n]`, installer], `flags-${dependency}`);
      }
    } else {
      for (const key of ['.PKGINFO', '.MTREE', '.INSTALL']) { assert.ok(fs.statSync(path.join(payload, key)).size > 0); fs.copyFileSync(path.join(payload, key), path.join(metadata, key)); }
      const info = fs.readFileSync(path.join(payload, '.PKGINFO'), 'utf8');
      const field = key => [...info.matchAll(new RegExp(`^${key} = (.+)$`, 'gm'))].map(match => match[1]);
      name = field('pkgname')[0]; version = field('pkgver')[0].replace(/-\d+$/, ''); dependencies = field('depend'); scripts = fs.readFileSync(path.join(payload, '.INSTALL'), 'utf8');
      await run('bash', ['-n', path.join(payload, '.INSTALL')]);
    }
  }
  const payloadManifest = await manifest(payload), appPrefix = `opt/${expected.productName}/`;
  const integration = payloadManifest.filter(entry => !entry.path.startsWith(appPrefix) && entry.path !== `opt/${expected.productName}`);
  const desktops = integration.filter(entry => entry.path === `usr/share/applications/${expected.name}.desktop`); assert.equal(desktops.length, 1);
  const desktopFile = fs.readFileSync(path.join(payload, desktops[0].path), 'utf8');
  // WHY: compare icon bytes with THIS checkout, not a cached installer receipt.
  const icons = integration.filter(entry => /^usr\/share\/icons\/hicolor\/\d+x\d+\/apps\/[^/]+\.png$/.test(entry.path));
  for (const icon of icons) {
    const size = icon.path.split('/')[4]; assert.equal(icon.sha256, await hash(path.join(desktop, 'assets', expected.config.linux.icon, `${size}.png`)));
  }
  const value = { name, version, dependencies, scripts, desktop: desktopFile, icons: icons.map(entry => entry.path) };
  validateMetadata(format, value, expected);
  json(path.join(directory, 'integration.json'), { ...value, entries: integration, controls: await manifest(metadata) });
  return path.join(payload, 'opt', expected.productName);
}
export async function extractSquashfs(installer, destination, offset) {
  assert.ok(path.isAbsolute(installer) && path.isAbsolute(destination));
  assert.ok(Number.isSafeInteger(offset) && offset >= 0 && offset <= fs.statSync(installer).size - 4, 'Invalid SquashFS offset');
  const descriptor = fs.openSync(installer, 'r');
  try {
    const magic = Buffer.alloc(4);
    assert.equal(fs.readSync(descriptor, magic, 0, 4, offset), 4);
    assert.equal(magic.toString('ascii'), 'hsqs', 'Offset does not address a SquashFS filesystem');
  } finally {
    fs.closeSync(descriptor);
  }
  await run('timeout', ['120s', 'unsquashfs', '-no-progress', '-o', String(offset), '-d', destination, installer]);
}
export async function appImagePayload(installer, payload, post, directory, expected) {
  // WHY: the checksummed FUSE2 runtime's --appimage-extract recreates every
  // directory as 0700, discarding the stored 0755/0750 modes. Read its filesystem
  // offset only, then preserve the actual stored modes with unsquashfs. Never
  // normalize or exempt directory permissions, and never launch AppRun/Electron.
  const offset = (await run('timeout', ['120s', installer, '--appimage-offset'], payload)).toString().trim();
  assert.match(offset, /^[1-9][0-9]*$/, 'AppImage runtime did not return a filesystem offset');
  const app = path.join(payload, 'squashfs-root');
  await extractSquashfs(installer, app, Number(offset));
  const installed = await manifest(app), corePaths = new Set(post.map(entry => entry.path));
  verifyInstalled(post, installed.filter(entry => corePaths.has(entry.path)));
  const extras = installed.filter(entry => !corePaths.has(entry.path));
  for (const entry of extras) {
    // WHY: current builder output includes these two structural parents of the
    // verified library/icon trees. Permit only directories with stored 0755,
    // not arbitrary files or an exemption of anything beneath usr/share.
    const structuralParent = ['usr', 'usr/share'].includes(entry.path) && entry.type === 'directory' && entry.mode === 0o755;
    assert.ok(structuralParent || entry.path === 'AppRun' || entry.path === '.DirIcon' || entry.path === `${expected.name}.desktop` || entry.path === `${expected.name}.png` || /^usr\/(?:lib|share\/icons)(?:\/|$)/.test(entry.path), `Unexpected AppImage integration ${entry.path}`);
  }
  const desktopFile = fs.readFileSync(path.join(app, `${expected.name}.desktop`), 'utf8');
  assert.ok(desktopFile.includes(`Name=${expected.productName}`)); assert.match(desktopFile, /^Exec=.+/m);
  assert.ok(installed.some(entry => entry.path === 'AppRun' && entry.type === 'file' && (entry.mode & 0o111) !== 0));
  await run('bash', ['-n', path.join(app, 'AppRun')]);
  const icons = extras.filter(entry => /^usr\/share\/icons\/hicolor\/\d+x\d+\/apps\/[^/]+\.png$/.test(entry.path)); assert.ok(icons.length > 0);
  for (const icon of icons) assert.equal(icon.sha256, await hash(path.join(desktop, 'assets', expected.config.linux.icon, `${icon.path.split('/')[4]}.png`)));
  for (const name of ['.DirIcon', `${expected.name}.png`]) {
    const link = extras.find(entry => entry.path === name); assert.equal(link?.type, 'link');
    assert.ok(icons.some(icon => icon.path === link.target), 'AppImage icon link does not address a verified current icon');
  }
  // WHY: AppImage's bundled runtime libraries are payload, not ignorable
  // metadata. Compare them against this lockfile's checksummed builder toolset.
  const require = createRequire(path.join(desktop, 'package.json'));
  const { getAppImageTools } = require('app-builder-lib/out/toolsets/linux.js');
  const { runtimeLibraries } = await getAppImageTools(expected.config.toolsets?.appimage ?? '0.0.0', require('builder-util').Arch.x64);
  const libraries = await manifest(runtimeLibraries);
  verifyInstalled(libraries, extras.filter(entry => entry.path.startsWith('usr/lib/')).map(entry => ({ ...entry, path: entry.path.slice('usr/lib/'.length) })));
  json(path.join(directory, 'integration.json'), { entries: extras, desktop: desktopFile, runtimeLibraries: libraries, limit: 'AppImage runtime extraction only; no application launch or package-manager installation.' });
  return { app, installed: installed.filter(entry => corePaths.has(entry.path)) };
}
async function main() {
  const [command, format] = process.argv.slice(2), mode = process.env.CI_PACKAGE_MODE;
  assert.ok(['default', 'fast'].includes(mode), 'Missing/invalid packaging mode');
  const input = await identity(root, process.env.GITHUB_SHA);
  if (command === 'prepare') {
    const output = path.join(root, 'ci-prepared'), evidence = path.join(root, 'ci-results/prepared-evidence');
    fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(evidence, { recursive: true });
    // WHY: forward only --dir to the unchanged production build. All build
    // inputs, native payloads, legal files and release defaults stay intact.
    await run('npm', ['run', 'build', '--', '--linux', '--x64', '--dir', '--publish', 'never'], desktop, false);
    const app = path.join(desktop, 'release/linux-unpacked'), prepared = { identity: input, mode, manifest: await manifest(app), transport: await transport(app, output) };
    assert.deepEqual(await identity(root, process.env.GITHUB_SHA), input);
    json(path.join(output, 'prepared.json'), prepared); json(path.join(evidence, 'prepared.json'), prepared);
  } else if (command === 'package') {
    assert.ok(formats.includes(format));
    // WHY: fail on builder/config API incompatibility before transport restore
    // and expensive package construction, rather than after producing installers.
    const expected = await expectedMetadata();
    const inputDir = path.join(root, 'ci-prepared'), prepared = read(path.join(inputDir, 'prepared.json'));
    assert.deepEqual(prepared.identity, input); assert.equal(prepared.mode, mode);
    const temporary = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || root, `ci-${format}-`));
    const app = path.join(temporary, 'app'), output = path.join(temporary, 'output'), payload = path.join(temporary, 'payload');
    const directory = path.join(root, 'ci-results', `format-${format}`); fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(payload);
    await unpack(inputDir, app, prepared.transport); verifyInstalled(prepared.manifest, await manifest(app));
    // WHY: target-specific FPM metadata must never mutate a shared or hardlinked
    // prepared tree. Each runner restores its own mode/symlink-preserving TAR.
    const tmp = path.join(temporary, 'tmp'); fs.mkdirSync(tmp);
    process.env.TMPDIR = tmp; process.env.TMP = tmp; process.env.TEMP = tmp;
    const started = performance.now(), timingFile = path.join(directory, 'package-time.txt');
    // WHY: GNU time includes the builder's descendants (FPM/compressors), unlike
    // process.resourceUsage(), which would misleadingly measure only this shim.
    await run('/usr/bin/time', ['-f', '%U %S %e', '-o', timingFile, process.execPath, path.join(desktop, 'node_modules/electron-builder/cli.js'), ...packageArgs(format, mode, app, output)], desktop, false);
    const elapsedSeconds = (performance.now() - started) / 1000;
    const [cpuUserSeconds, cpuSystemSeconds, builderWallSeconds] = fs.readFileSync(timingFile, 'utf8').trim().split(/\s+/).map(Number);
    assert.ok([cpuUserSeconds, cpuSystemSeconds, builderWallSeconds].every(value => Number.isFinite(value) && value >= 0));
    const post = await manifest(app); verifyCore(prepared.manifest, post);
    const suffix = { AppImage: '.AppImage', deb: '.deb', rpm: '.rpm', pacman: '.pacman' }[format];
    const installers = fs.readdirSync(output).filter(name => name.endsWith(suffix)); assert.equal(installers.length, 1);
    const installer = path.join(output, installers[0]);
    let installed;
    if (format === 'AppImage') installed = (await appImagePayload(installer, payload, post, directory, expected)).installed;
    else installed = await manifest(await nativeMetadata(format, installer, payload, directory, expected));
    verifyInstalled(post, installed); assert.deepEqual(await identity(root, process.env.GITHUB_SHA), input);
    json(path.join(directory, 'package.json'), { identity: input, mode, format, prepared: prepared.manifest, post, installed, validated: true,
      bytes: fs.statSync(installer).size, sha256: await hash(installer), elapsedSeconds, cpuUserSeconds, cpuSystemSeconds, builderWallSeconds,
      compression: mode === 'fast' && format !== 'AppImage' ? { deb: 'gz', rpm: 'gzip', pacman: 'gz' }[format] : 'release defaults' });
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5 });
  } else throw new Error('Use prepare|package <format>');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
