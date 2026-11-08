// Pins the packaging step that keeps the packaged app's files from being writable by other users (Electron 44's own
// download ships them 0666/0777; scripts/after-pack-permissions.cjs).
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
const hook = req('../scripts/after-pack-permissions.cjs');
const posix = process.platform !== 'win32';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

describe('after-pack permissions', () => {
  it('is wired into electron-builder.yml', () => {
    const yml = fs.readFileSync(path.resolve(__dirname, '../electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/^afterPack: scripts\/after-pack-permissions\.cjs$/m);
  });

  it.runIf(posix)('takes the group/other write bit off every file and folder, keeping read and run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'locales'));
    fs.writeFileSync(path.join(root, 'chrome-sandbox'), 'x');
    fs.writeFileSync(path.join(root, 'locales', 'en-US.pak'), 'x');
    fs.chmodSync(path.join(root, 'chrome-sandbox'), 0o777);
    fs.chmodSync(path.join(root, 'locales', 'en-US.pak'), 0o666);
    fs.chmodSync(path.join(root, 'locales'), 0o777);
    await hook({ electronPlatformName: 'linux', appOutDir: root });
    const mode = (p: string) => fs.statSync(path.join(root, p)).mode & 0o7777;
    expect(mode('chrome-sandbox')).toBe(0o755);
    expect(mode('locales/en-US.pak')).toBe(0o644);
    expect(mode('locales')).toBe(0o755);
  });
});
