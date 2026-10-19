#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { run, npmCli, isMain } from './ci-policy.mjs';
import { hash, identity, manifest, verifyCore, verifyInstalled, transport, unpack } from './ci-evidence.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), desktop = path.join(root, 'desktop');
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const formats = ['AppImage', 'deb', 'rpm', 'pacman'];
export function lockedParser(desktopDirectory) {
  const packages = read(path.join(desktopDirectory, 'package-lock.json')).packages;
  assert.equal(typeof packages?.['node_modules/app-builder-lib']?.dependencies?.['js-yaml'], 'string', 'Unsupported builder parser dependency');
  // WHY: mirror Node's builder-local then hoisted dependency resolution from
  // CURRENT lock metadata, without installed modules or a producer assertion.
  const candidates = ['node_modules/app-builder-lib/node_modules/js-yaml', 'node_modules/js-yaml'];
  assert.ok(!Object.keys(packages).some(key => key.startsWith('node_modules/app-builder-lib/') && key.endsWith('/js-yaml') && !candidates.includes(key)), 'Unsupported nested builder parser layout');
  const location = candidates.find(key => Object.hasOwn(packages, key));
  const dependency = packages[location];
  // WHY: trust the consumer's current lock, never a producer-supplied digest or
  // requested-profile map. Unsupported SRI must fail closed before loading code.
  assert.match(dependency?.integrity ?? '', /^sha512-[A-Za-z0-9+/]{86}==$/, 'Unsupported parser integrity');
  assert.equal(dependency.link, undefined, 'Unsupported linked parser');
  return { ...dependency, location };
}
function installedBuilderParser(desktopDirectory) {
  const require = createRequire(path.join(desktopDirectory, 'package.json'));
  const builderRequire = createRequire(require.resolve('app-builder-lib/out/util/config/load.js'));
  const dependency = lockedParser(desktopDirectory);
  const expected = path.join(desktopDirectory, dependency.location, 'index.js');
  assert.equal(builderRequire.resolve('js-yaml'), expected, 'Installed builder parser disagrees with current lock');
  assert.equal(read(path.join(desktopDirectory, dependency.location, 'package.json')).version, dependency.version);
  return builderRequire('js-yaml');
}
async function verifyParser(file, dependency) {
  const digest = createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  assert.equal(`sha512-${digest.digest('base64')}`, dependency.integrity, 'Parser capsule integrity mismatch');
}
export async function packParserCapsule(desktopDirectory, evidence, temporaryBase = process.env.RUNNER_TEMP || tmpdir()) {
  const dependency = lockedParser(desktopDirectory);
  assert.match(dependency.resolved ?? '', /^https:\/\//, 'Unsupported parser URL');
  const temporary = fs.mkdtempSync(path.join(temporaryBase, 'ci-parser-pack-'));
  try {
    // WHY: pack just the already-locked parser, never install the desktop tree
    // or execute lifecycle hooks. Prefer the npm cache used by preparation.
    // npm 12 gates URL specs: permit this one pack child, verified by SRI below.
    const packed = JSON.parse((await run(process.execPath, [npmCli(), 'pack', dependency.resolved, '--prefer-offline', '--ignore-scripts', '--json', '--pack-destination', temporary], temporary, true, { npm_config_allow_remote: 'all' })).toString());
    const entries = Object.values(packed); assert.equal(entries.length, 1);
    const filename = entries[0].filename; assert.equal(typeof filename, 'string'); assert.equal(path.basename(filename), filename);
    const archive = path.join(temporary, filename); await verifyParser(archive, dependency);
    const capsule = path.join(evidence, 'yaml-parser.tgz'); fs.copyFileSync(archive, capsule); return capsule;
  } finally { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5 }); }
}
export async function readEncoderInputs(desktopDirectory, capsule, temporaryBase = process.env.RUNNER_TEMP || tmpdir()) {
  const dependency = lockedParser(desktopDirectory);
  const temporary = fs.mkdtempSync(path.join(temporaryBase, 'ci-parser-read-'));
  try {
    // WHY: verify a private snapshot before extraction/import, preventing an
    // artifact swap after hashing. No installed dependencies exist in aggregation.
    const archive = path.join(temporary, 'parser.tgz'); fs.copyFileSync(capsule, archive);
    await verifyParser(archive, dependency);
    await run('tar', ['-xzf', archive, '-C', temporary, '--no-same-owner', '--no-same-permissions']);
    const { load } = createRequire(path.join(temporary, 'package/package.json'))('./index.js');
    const config = load(fs.readFileSync(path.join(desktopDirectory, 'electron-builder.yml'), 'utf8'));
    const pkg = read(path.join(desktopDirectory, 'package.json'));
    assert.ok(config && typeof config === 'object' && !Array.isArray(config));
    assert.ok(pkg && typeof pkg === 'object' && !Array.isArray(pkg));
    return { config, pkg };
  } finally { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5 }); }
}
export function encoderProfile(format, mode, config, pkg) {
  // WHY: builder merges FPM arrays opaquely. Never replace user flags or guess
  // what an extends/package preset supplies; optimize only plain known config.
  const empty = value => value === undefined || value === null || (Array.isArray(value) && value.length === 0);
  if (mode !== 'fast' || !['deb', 'rpm'].includes(format) || !config || !pkg
    || Object.hasOwn(config, 'extends') || Object.hasOwn(pkg, 'build')
    // WHY: installed builder tests key presence, even for empty/null specs;
    // electron-webpack is an implicit preset only under devDependencies.
    || 'react-scripts' in (pkg.dependencies ?? {}) || 'react-scripts' in (pkg.devDependencies ?? {})
    || 'electron-webpack' in (pkg.devDependencies ?? {})
    || !empty(config.linux?.fpm) || !empty(config[format]?.fpm)) return null;
  return { compressor: 'gzip', level: 1 };
}
export function writeEncoderConfig(format, requested, original, directory) {
  if (!requested) return undefined;
  assert.deepEqual(requested, { compressor: 'gzip', level: 1 });
  assert.ok(['deb', 'rpm'].includes(format)); assert.ok(path.isAbsolute(original) && path.isAbsolute(directory));
  // WHY: JSON dot values are strings in the real CLI. A private config file
  // retains a genuine array and absolute inheritance, including asset paths.
  const file = path.join(directory, `encoder-${format}.json`);
  fs.writeFileSync(file, JSON.stringify({ extends: original, [format]: { fpm: [`--${format}-compression-level=1`] } }), { mode: 0o600, flag: 'wx' });
  return file;
}
export function packageEnvironment(env = process.env) {
  // WHY: preserve memory/preset flags; XZ_DEFAULTS is honored even where FPM
  // supplies XZ_OPT. This requests threading only, not a different preset.
  return { ...env, XZ_DEFAULTS: [env.XZ_DEFAULTS, '--threads=0'].filter(Boolean).join(' ') };
}
export function gzipHeader(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 10, 'Truncated gzip header');
  assert.equal(bytes.readUInt16BE(0), 0x1f8b, 'Not gzip'); assert.equal(bytes[2], 8, 'Not deflate');
  assert.equal(bytes[3] & 0xe0, 0, 'Reserved gzip flags');
  return { compressor: 'gzip', xfl: bytes[8] };
}
export function validateEncoder(format, requested, observed) {
  // WHY: explicit null is a real profile, not permission to omit evidence or
  // attach an unexpected observation. Undefined/false requests are malformed.
  if (requested === null) { assert.equal(observed, null, 'Unexpected encoder observation'); return; }
  assert.deepEqual(requested, { compressor: 'gzip', level: 1 });
  assert.equal(observed?.compressor, 'gzip', 'Requested gzip encoder not observed');
  if (format === 'deb') assert.equal(observed.xfl, 4, 'Requested fastest gzip not observed');
  else { assert.equal(format, 'rpm'); assert.equal(observed.flags, '1', 'Requested RPM payload level not observed'); }
}
export async function observeEncoder(format, installer, requested, temporary) {
  if (!requested) return null;
  let observed;
  if (format === 'rpm') {
    const values = (await run('rpm', ['-qp', '--queryformat', '%{PAYLOADCOMPRESSOR}\\n%{PAYLOADFLAGS}\\n', installer])).toString().trim().split('\n');
    assert.equal(values.length, 2, 'Invalid RPM encoder query');
    observed = { compressor: values[0], flags: values[1] };
  } else {
    assert.equal(format, 'deb');
    // WHY: compressed payload is huge, not evidence. Extract only the named ar
    // member into the private build area, read ten bytes, always delete it.
    const directory = fs.mkdtempSync(path.join(temporary, 'encoder-'));
    try {
      await run('ar', ['x', installer, 'data.tar.gz'], directory);
      const descriptor = fs.openSync(path.join(directory, 'data.tar.gz'), 'r');
      try {
        const bytes = Buffer.alloc(10), count = fs.readSync(descriptor, bytes, 0, 10, 0);
        observed = gzipHeader(bytes.subarray(0, count));
      } finally { fs.closeSync(descriptor); }
    } finally { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); }
  }
  validateEncoder(format, requested, observed); return observed;
}
export function packageArgs(format, mode, app, output, configFile) {
  assert.ok(formats.includes(format)); assert.ok(['default', 'fast'].includes(mode));
  assert.ok(path.isAbsolute(app) && path.isAbsolute(output) && app !== output);
  const codec = { deb: 'gz', rpm: 'gzip', pacman: 'gz' }[format];
  return ['--linux', format, '--x64', '--prepackaged', app, `-c.directories.output=${output}`,
    ...(mode === 'fast' && codec ? [`-c.${format}.compression=${codec}`] : []),
    ...(configFile ? ['--config', configFile] : []), '--publish', 'never'];
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
export async function expectedMetadata(configFile = path.join(desktop, 'electron-builder.yml')) {
  // WHY: builder uses js-yaml.load's default schema (including YAML merges),
  // not yaml.parse's core schema. Eligibility must see the same inherited flags.
  const config = installedBuilderParser(desktop).load(fs.readFileSync(configFile, 'utf8'));
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
    await run(process.execPath, [npmCli(), 'run', 'build', '--', '--linux', '--x64', '--dir', '--publish', 'never'], desktop, false);
    const app = path.join(desktop, 'release/linux-unpacked'), prepared = { identity: input, mode, manifest: await manifest(app), transport: await transport(app, output) };
    await packParserCapsule(desktop, evidence);
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
    const requested = encoderProfile(format, mode, expected.config, read(path.join(desktop, 'package.json')));
    const configFile = writeEncoderConfig(format, requested, path.join(desktop, 'electron-builder.yml'), temporary);
    const env = packageEnvironment({ ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp });
    const started = performance.now(), timingFile = path.join(directory, 'package-time.txt');
    // WHY: GNU time includes the builder's descendants (FPM/compressors), unlike
    // process.resourceUsage(), which would misleadingly measure only this shim.
    await run('/usr/bin/time', ['-f', '%U %S %e', '-o', timingFile, process.execPath, path.join(desktop, 'node_modules/electron-builder/cli.js'), ...packageArgs(format, mode, app, output, configFile)], desktop, false, env);
    const elapsedSeconds = (performance.now() - started) / 1000;
    const [cpuUserSeconds, cpuSystemSeconds, builderWallSeconds] = fs.readFileSync(timingFile, 'utf8').trim().split(/\s+/).map(Number);
    assert.ok([cpuUserSeconds, cpuSystemSeconds, builderWallSeconds].every(value => Number.isFinite(value) && value >= 0));
    const post = await manifest(app); verifyCore(prepared.manifest, post);
    const suffix = { AppImage: '.AppImage', deb: '.deb', rpm: '.rpm', pacman: '.pacman' }[format];
    const installers = fs.readdirSync(output).filter(name => name.endsWith(suffix)); assert.equal(installers.length, 1);
    const installer = path.join(output, installers[0]);
    const observed = await observeEncoder(format, installer, requested, temporary);
    let installed;
    if (format === 'AppImage') installed = (await appImagePayload(installer, payload, post, directory, expected)).installed;
    else installed = await manifest(await nativeMetadata(format, installer, payload, directory, expected));
    verifyInstalled(post, installed); assert.deepEqual(await identity(root, process.env.GITHUB_SHA), input);
    json(path.join(directory, 'package.json'), { identity: input, mode, format, prepared: prepared.manifest, post, installed, validated: true,
      bytes: fs.statSync(installer).size, sha256: await hash(installer), elapsedSeconds, cpuUserSeconds, cpuSystemSeconds, builderWallSeconds,
      encoder: { requested, observed, xzThreadsRequested: 0 },
      compression: mode === 'fast' && format !== 'AppImage' ? { deb: 'gz', rpm: 'gzip', pacman: 'gz' }[format] : 'release defaults' });
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5 });
  } else throw new Error('Use prepare|package <format>');
}
if (isMain(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
