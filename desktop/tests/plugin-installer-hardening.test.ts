// Security audit SC-6 / SC-10: postInstall trust is an exact owner match, and
// plugin copies never follow symlinks out of the plugin folder.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { isPostInstallTrusted, removeEscapingSymlinks, copyDirSync } from '../src/main/plugin-installer';

const e = (sourceRef: string) => ({ id: 'x', sourceType: 'url', sourceRef, postInstall: 'echo hi' } as any);

describe('isPostInstallTrusted', () => {
  it('accepts the exact trusted owners on github.com over https', () => {
    expect(isPostInstallTrusted(e('https://github.com/itsdestin/wecoded.git'))).toBe(true);
    expect(isPostInstallTrusted(e('https://github.com/ItsDestin/wecoded'))).toBe(true);
  });
  it('rejects look-alike URLs that merely contain the trusted text', () => {
    expect(isPostInstallTrusted(e('https://evil.example/github.com/itsdestin/x.git'))).toBe(false);
    expect(isPostInstallTrusted(e('https://github.com/evil/r?x=github.com/itsdestin/'))).toBe(false);
    expect(isPostInstallTrusted(e('https://github.com.evil.example/itsdestin/x'))).toBe(false);
    expect(isPostInstallTrusted(e('https://github.com/itsdestin-evil/x'))).toBe(false);
    expect(isPostInstallTrusted(e('https://itsdestin@evil.example/itsdestin/x'))).toBe(false);
    expect(isPostInstallTrusted(e('http://github.com/itsdestin/x'))).toBe(false);
    expect(isPostInstallTrusted(e('not a url github.com/itsdestin/'))).toBe(false);
  });
  it('requires a postInstall to exist', () => {
    expect(isPostInstallTrusted({ id: 'x', sourceType: 'url', sourceRef: 'https://github.com/itsdestin/x' } as any)).toBe(false);
  });
});

describe('symlink handling', () => {
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yc-symlink-'));
  it('removeEscapingSymlinks deletes links to outside files but keeps inside links', () => {
    const outside = mk(); const plug = mk();
    fs.writeFileSync(path.join(outside, 'secret'), 'secret');
    fs.writeFileSync(path.join(plug, 'real.txt'), 'ok');
    fs.symlinkSync(path.join(outside, 'secret'), path.join(plug, 'leak'));
    fs.symlinkSync(path.join(plug, 'real.txt'), path.join(plug, 'inside'));
    expect(removeEscapingSymlinks(plug)).toBe(1);
    expect(fs.existsSync(path.join(plug, 'leak'))).toBe(false);
    expect(fs.existsSync(path.join(plug, 'inside'))).toBe(true);
  });
  it('copyDirSync never copies a file a symlink points to outside the plugin', () => {
    const outside = mk(); const plug = mk(); const dest = path.join(mk(), 'out');
    fs.writeFileSync(path.join(outside, 'secret'), 'secret');
    fs.writeFileSync(path.join(plug, 'real.txt'), 'ok');
    fs.symlinkSync(path.join(outside, 'secret'), path.join(plug, 'leak'));
    fs.symlinkSync(path.join(plug, 'real.txt'), path.join(plug, 'inside'));
    copyDirSync(plug, dest);
    expect(fs.existsSync(path.join(dest, 'leak'))).toBe(false);
    expect(fs.readFileSync(path.join(dest, 'inside'), 'utf8')).toBe('ok');
    expect(fs.readFileSync(path.join(dest, 'real.txt'), 'utf8')).toBe('ok');
  });
});
