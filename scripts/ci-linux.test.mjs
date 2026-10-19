import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { run } from './ci-policy.mjs';
import { manifest, verifyInstalled } from './ci-evidence.mjs';
import { extractSquashfs, packageArgs, validateMetadata, encoderProfile, packageEnvironment, gzipHeader, validateEncoder, observeEncoder } from './ci-linux.mjs';
import { gzipSync } from 'node:zlib';

test('level one is fast-only and refuses opaque/custom configuration without changing sentinels', () => {
  for (const format of ['deb', 'rpm']) {
    assert.deepEqual(encoderProfile(format, 'fast', {}, {}), { compressor: 'gzip', level: 1 });
    assert.equal(encoderProfile(format, 'default', {}, {}), null);
    for (const config of [{ linux: { fpm: ['--sentinel=keep'] } }, { [format]: { fpm: ['--sentinel=keep'] } }, { extends: 'parent.yml' }, { extends: null }, { linux: { fpm: 'opaque' } }]) {
      const original = structuredClone(config);
      assert.equal(encoderProfile(format, 'fast', config, {}), null);
      assert.deepEqual(config, original);
    }
    assert.equal(encoderProfile(format, 'fast', {}, { build: {} }), null);
  }
  for (const format of ['AppImage', 'pacman']) assert.equal(encoderProfile(format, 'fast', {}, {}), null);
});
test('implicit presets follow installed builder key presence, including falsy dependency specs and null maps', () => {
  for (const format of ['deb', 'rpm']) {
    for (const [map, name] of [['dependencies', 'react-scripts'], ['devDependencies', 'react-scripts'], ['devDependencies', 'electron-webpack']]) {
      for (const value of ['', null, false, '*']) {
        const pkg = { [map]: { [name]: value } }, before = structuredClone(pkg);
        assert.equal(encoderProfile(format, 'fast', {}, pkg), null, `${map}.${name}=${JSON.stringify(value)}`);
        assert.deepEqual(pkg, before);
      }
    }
    for (const pkg of [{}, { dependencies: null }, { devDependencies: null }, { dependencies: null, devDependencies: null }, { dependencies: {}, devDependencies: {} }, { dependencies: { 'electron-webpack': '' } }]) {
      assert.deepEqual(encoderProfile(format, 'fast', {}, pkg), { compressor: 'gzip', level: 1 });
    }
  }
});
test('null encoder proof is explicit and cannot hide an observation or a missing/false request', () => {
  assert.doesNotThrow(() => validateEncoder('deb', null, null));
  for (const request of [undefined, false, '', 0]) assert.throws(() => validateEncoder('deb', request, null));
  for (const observed of [undefined, false, { compressor: 'gzip', xfl: 4 }]) assert.throws(() => validateEncoder('deb', null, observed));
});
test('package-only environment appends threads without losing memory/preset or mutating caller', () => {
  const env = { XZ_DEFAULTS: '--memlimit=256MiB -6 --threads=1', PATH: '/sentinel', XZ_OPT: '-3' };
  const original = { ...env }, child = packageEnvironment(env);
  assert.equal(child.XZ_DEFAULTS, `${env.XZ_DEFAULTS} --threads=0`);
  assert.equal(child.XZ_OPT, '-3'); assert.equal(child.PATH, '/sentinel'); assert.deepEqual(env, original);
  assert.equal(packageEnvironment({}).XZ_DEFAULTS, '--threads=0');
});
test('encoder proof rejects bad gzip bounds/magic/method and requested-vs-observed mismatches', () => {
  const fast = gzipSync('payload', { level: 1 }), slow = gzipSync('payload', { level: 9 });
  assert.deepEqual(gzipHeader(fast), { compressor: 'gzip', xfl: 4 });
  for (const bytes of [Buffer.alloc(0), fast.subarray(0, 9), Buffer.alloc(10), Buffer.from([31, 139, 0, 0, 0, 0, 0, 0, 4, 3])]) assert.throws(() => gzipHeader(bytes));
  const requested = { compressor: 'gzip', level: 1 };
  assert.doesNotThrow(() => validateEncoder('deb', requested, gzipHeader(fast)));
  assert.throws(() => validateEncoder('deb', requested, gzipHeader(slow)));
  assert.doesNotThrow(() => validateEncoder('rpm', requested, { compressor: 'gzip', flags: '1' }));
  for (const observed of [{ compressor: 'xz', flags: '1' }, { compressor: 'gzip', flags: '9' }, { compressor: 'gzip', flags: '1x' }]) assert.throws(() => validateEncoder('rpm', requested, observed));
  assert.throws(() => validateEncoder('deb', null, gzipHeader(slow)));
});
test('actual deb ar member observation reads gzip header privately and cleans up, including rejection', { skip: process.platform !== 'linux' }, async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ci-encoder-'));
  try {
    for (const level of [1, 9]) {
      fs.writeFileSync(path.join(root, 'data.tar.gz'), gzipSync('tiny tar fixture', { level }));
      const installer = path.join(root, `fixture-${level}.deb`);
      await run('ar', ['rc', installer, 'data.tar.gz'], root);
      const proof = () => observeEncoder('deb', installer, { compressor: 'gzip', level: 1 }, root);
      if (level === 1) assert.deepEqual(await proof(), { compressor: 'gzip', xfl: 4 });
      else await assert.rejects(proof());
      assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('encoder-')), []);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('SquashFS extraction preserves stored directory, file and symlink modes at a validated image offset', { skip: process.platform !== 'linux' }, async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ci-squashfs-'));
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, 'resources', 'nested'), { recursive: true });
    fs.chmodSync(path.join(source, 'resources'), 0o755);
    fs.chmodSync(path.join(source, 'resources', 'nested'), 0o750);
    fs.writeFileSync(path.join(source, 'resources', 'nested', 'payload'), 'current payload\n');
    fs.chmodSync(path.join(source, 'resources', 'nested', 'payload'), 0o640);
    fs.symlinkSync('nested/payload', path.join(source, 'resources', 'link'));
    const squash = path.join(root, 'filesystem.squashfs');
    await run('mksquashfs', [source, squash, '-noappend', '-no-progress', '-processors', '2']);
    const image = path.join(root, 'fixture.AppImage'), offset = 4096;
    fs.writeFileSync(image, Buffer.concat([Buffer.alloc(offset), fs.readFileSync(squash)]));
    const destination = path.join(root, 'extracted');
    await extractSquashfs(image, destination, offset);
    verifyInstalled(await manifest(source), await manifest(destination));
    for (const badOffset of [-1, 1.5, NaN, '4096', Number.MAX_SAFE_INTEGER, 0]) {
      await assert.rejects(() => extractSquashfs(image, path.join(root, 'invalid'), badOffset));
    }
    fs.chmodSync(path.join(destination, 'resources'), 0o700);
    const expected = await manifest(source), changed = await manifest(destination);
    assert.throws(() => verifyInstalled(expected, changed));
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
test('format commands are fixed publish-never, private prepackaged copies with explicit safe compression mode', () => {
  for (const format of ['AppImage', 'deb', 'rpm', 'pacman']) {
    const defaults = packageArgs(format, 'default', '/private/app', '/private/out');
    assert.deepEqual(defaults.slice(0, 6), ['--linux', format, '--x64', '--prepackaged', '/private/app', '-c.directories.output=/private/out']);
    assert.deepEqual(defaults.slice(-2), ['--publish', 'never']);
    assert.ok(!defaults.some(x => x.includes('compression')));
    const fast = packageArgs(format, 'fast', '/private/app', '/private/out');
    assert.equal(fast.some(x => x === `-c.${format}.compression=${format === 'rpm' ? 'gzip' : 'gz'}`), format !== 'AppImage');
  }
  for (const format of ['zip', '--publish', '', undefined]) assert.throws(() => packageArgs(format, 'fast', '/private/app', '/private/out'));
  assert.throws(() => packageArgs('deb', 'unknown', '/private/app', '/private/out'));
});
test('current package metadata requires exact identity, dependency configuration, scripts and launch integration', () => {
  const expected = { name: 'youcoded', productName: 'YouCoded', version: '2.4.7', category: 'Development', pacmanDependencies: ['gtk3', 'nss'] };
  const value = { name: 'youcoded', version: '2.4.7', dependencies: ['gtk3', 'nss'], scripts: 'post_install() { chmod 0755 /opt/YouCoded/chrome-sandbox; update-desktop-database; }', desktop: '[Desktop Entry]\nName=YouCoded\nExec="/opt/YouCoded/youcoded" %U\nType=Application\nCategories=Development;\n', icons: ['usr/share/icons/hicolor/48x48/apps/youcoded.png'] };
  assert.doesNotThrow(() => validateMetadata('pacman', value, expected));
  for (const mutate of [x => x.version = 'old', x => x.name = 'other', x => x.dependencies.pop(), x => x.scripts = '', x => x.desktop = '', x => x.icons = []]) {
    const copy = structuredClone(value); mutate(copy); assert.throws(() => validateMetadata('pacman', copy, expected));
  }
});
