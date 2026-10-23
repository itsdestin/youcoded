import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { parseDesignatedRequirement, stageAppImage, stageMacApp, stagedPathFor, sweepStaging, type RunCommand } from '../src/main/update-staging';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-staging-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
const sha = (p: string) => Promise.resolve(createHash('sha256').update(fs.readFileSync(p)).digest('hex'));

describe('staging a verified AppImage', () => {
  it('copies it to a hidden file beside the running one and returns only its name', async () => {
    const dir = path.join(root, 'apps'); fs.mkdirSync(dir);
    const running = path.join(dir, 'YouCoded.AppImage'); fs.writeFileSync(running, 'old');
    const download = path.join(root, 'dl.AppImage'); fs.writeFileSync(download, 'new image');
    const name = await stageAppImage({ filePath: download, runningAppImage: running, version: '2.0.0', expectedSha256: await sha(download), hashFile: sha });
    expect(name).toBe('.YouCoded-update-2.0.0.AppImage');
    expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe('new image');
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, name)).mode & 0o111).toBeTruthy(); // POSIX-only bits
    expect(fs.readFileSync(running, 'utf8')).toBe('old'); // staging never touches the running image
  });

  it('refuses and leaves nothing behind when the copy does not match the signed hash', async () => {
    const dir = path.join(root, 'apps'); fs.mkdirSync(dir);
    const download = path.join(root, 'dl.AppImage'); fs.writeFileSync(download, 'new image');
    await expect(stageAppImage({ filePath: download, runningAppImage: path.join(dir, 'Y.AppImage'), version: '2.0.0', expectedSha256: 'deadbeef', hashFile: sha }))
      .rejects.toMatchObject({ code: 'verify-failed' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses a version that is not a plain version string', async () => {
    await expect(stageAppImage({ filePath: 'a', runningAppImage: path.join(root, 'Y.AppImage'), version: '../../x', expectedSha256: '', hashFile: sha }))
      .rejects.toMatchObject({ code: 'verify-failed' });
  });
});

describe('staging a Mac update', () => {
  const requirement = 'anchor apple generic and certificate leaf[subject.OU] = "TEAMID"';
  /** A fake machine: hdiutil "mounts" a folder holding YouCoded.app, ditto copies it, codesign answers. */
  function fakeMac(opts: { codesignOk?: boolean } = {}) {
    const calls: Array<[string, string[]]> = [];
    const run: RunCommand = async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'hdiutil' && args[0] === 'attach') {
        const mountPoint = args[args.indexOf('-mountpoint') + 1];
        fs.mkdirSync(path.join(mountPoint, 'YouCoded.app', 'Contents'), { recursive: true });
        fs.writeFileSync(path.join(mountPoint, 'YouCoded.app', 'Contents', 'x'), 'bin');
      }
      if (cmd === 'ditto') fs.cpSync(args[0], args[1], { recursive: true });
      if (cmd === 'codesign' && args[0] === '-d') return { code: 0, stdout: '', stderr: `Executable=/x\ndesignated => ${requirement}\n` };
      if (cmd === 'codesign' && args[0] === '--verify') return { code: opts.codesignOk === false ? 3 : 0, stdout: '', stderr: opts.codesignOk === false ? 'does not satisfy' : '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    return { run, calls };
  }
  const bundle = () => { const b = path.join(root, 'Applications', 'YouCoded.app'); fs.mkdirSync(b, { recursive: true }); return b; };

  it('mounts read-only and hidden, copies beside the app, unmounts, and checks the signer against the RUNNING app', async () => {
    const { run, calls } = fakeMac();
    const running = bundle();
    const name = await stageMacApp({ dmgPath: '/dl/YouCoded.dmg', version: '2.0.0', runningBundle: running, needsPassword: false, tmpDir: root, run });
    expect(name).toBe('.YouCoded-update-2.0.0.app');
    const staged = path.join(path.dirname(running), name);
    expect(fs.existsSync(path.join(staged, 'Contents', 'x'))).toBe(true);
    const attach = calls.find(([c, a]) => c === 'hdiutil' && a[0] === 'attach')!;
    expect(attach[1]).toEqual(expect.arrayContaining(['-nobrowse', '-readonly', '-mountpoint']));
    expect(attach[1][attach[1].length - 1]).toBe('/dl/YouCoded.dmg');
    expect(calls.map(([c, a]) => `${c} ${a[0]}`)).toEqual(['hdiutil attach', 'ditto ' + path.join(attach[1][attach[1].indexOf('-mountpoint') + 1], 'YouCoded.app'), 'hdiutil detach', 'codesign -d', 'codesign --verify']);
    expect(calls.find(([c, a]) => c === 'codesign' && a[0] === '-d')![1]).toEqual(['-d', '-r-', running]);
    expect(calls.find(([c, a]) => c === 'codesign' && a[0] === '--verify')![1]).toEqual(['--verify', '--deep', '--strict', `-R=${requirement}`, staged]);
  });

  it('removes the staged copy and refuses when it is not signed by us', async () => {
    const { run } = fakeMac({ codesignOk: false });
    const running = bundle();
    await expect(stageMacApp({ dmgPath: '/dl/a.dmg', version: '2.0.0', runningBundle: running, needsPassword: false, tmpDir: root, run }))
      .rejects.toMatchObject({ code: 'verify-failed' });
    expect(fs.existsSync(path.join(path.dirname(running), '.YouCoded-update-2.0.0.app'))).toBe(false);
  });

  it('detaches the image even when the copy fails', async () => {
    const { run, calls } = fakeMac();
    const failing: RunCommand = async (cmd, args) => cmd === 'ditto' ? { code: 1, stdout: '', stderr: 'no space' } : run(cmd, args);
    await expect(stageMacApp({ dmgPath: '/dl/a.dmg', version: '2.0.0', runningBundle: bundle(), needsPassword: false, tmpDir: root, run: failing }))
      .rejects.toMatchObject({ code: 'spawn-failed' });
    expect(calls.some(([c, a]) => c === 'hdiutil' && a[0] === 'detach')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('stages in a private mode-700 temp folder when installing needs a password', async () => { // mode bits are POSIX-only
    const { run } = fakeMac();
    const name = await stageMacApp({ dmgPath: '/dl/a.dmg', version: '2.0.0', runningBundle: bundle(), needsPassword: true, tmpDir: root, run });
    expect(name).toBe('youcoded-update-2.0.0');
    const folder = path.join(root, name);
    expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(folder, 'YouCoded.app', 'Contents', 'x'))).toBe(true);
  });

  it('reads the designated requirement from codesign output', () => {
    expect(parseDesignatedRequirement(`Executable=/a\ndesignated => ${requirement}\n`)).toBe(requirement);
    expect(parseDesignatedRequirement('nothing here')).toBeNull();
  });
});

describe('staged names are re-validated before they become a path', () => {
  const ctx = { platform: 'linux' as const, runningAppImage: '/home/u/YouCoded.AppImage' };
  it('builds paths only from names it would have made itself', () => {
    expect(stagedPathFor('.YouCoded-update-2.0.0.AppImage', ctx)).toBe(path.join('/home/u', '.YouCoded-update-2.0.0.AppImage'));
    expect(stagedPathFor('../evil.AppImage', ctx)).toBeNull();
    expect(stagedPathFor('.YouCoded-update-../x.AppImage', ctx)).toBeNull();
    expect(stagedPathFor('/etc/passwd', ctx)).toBeNull();
  });

  it('the startup sweep removes stray staging files but not the kept one or other files', async () => {
    const dir = path.join(root, 'apps'); fs.mkdirSync(dir);
    for (const n of ['.YouCoded-update-1.0.0.AppImage', '.YouCoded-update-2.0.0.AppImage', 'YouCoded.AppImage', 'notes.txt']) fs.writeFileSync(path.join(dir, n), 'x');
    await sweepStaging({ platform: 'linux', runningAppImage: path.join(dir, 'YouCoded.AppImage') }, new Set(['.YouCoded-update-2.0.0.AppImage']));
    expect(fs.readdirSync(dir).sort()).toEqual(['.YouCoded-update-2.0.0.AppImage', 'YouCoded.AppImage', 'notes.txt']);
  });
});
