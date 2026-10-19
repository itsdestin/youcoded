import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageArgs, validateMetadata } from './ci-linux.mjs';
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
