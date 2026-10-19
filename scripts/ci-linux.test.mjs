import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { run } from './ci-policy.mjs';
import { manifest, verifyInstalled } from './ci-evidence.mjs';
import { extractSquashfs, packageArgs, validateMetadata } from './ci-linux.mjs';
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
