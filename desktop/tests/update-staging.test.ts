import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { MAC_HELPER_SCRIPT, macGoPaths, macHelperArgv, macRootStartArgs, nsisArgs, readAttempt, runExitPlan } from '../src/main/update-exit';
import { commandTimeoutMs, parseDesignatedRequirement, runWithTimeout, stageAppImage, stageMacApp, stagedPathFor, sweepStaging, type RunCommand } from '../src/main/update-staging';

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
    expect(attach[1]).toEqual(expect.arrayContaining(['-nobrowse', '-noautoopen', '-readonly', '-mountpoint']));
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

  it('forces the detach when the plain one fails', async () => {
    const { run, calls } = fakeMac();
    const stubborn: RunCommand = async (cmd, args) => cmd === 'hdiutil' && args[0] === 'detach' && args[1] !== '-force' ? { code: 16, stdout: '', stderr: 'busy' } : run(cmd, args);
    await stageMacApp({ dmgPath: '/dl/a.dmg', version: '2.0.0', runningBundle: bundle(), needsPassword: false, tmpDir: root, run: stubborn });
    expect(calls.filter(([c, a]) => c === 'hdiutil' && a[0] === 'detach' && a[1] === '-force')).toHaveLength(1);
  });

  it('removes a half-copied staged app when ditto fails', async () => {
    const { run } = fakeMac();
    const running = bundle();
    const failing: RunCommand = async (cmd, args) => {
      if (cmd === 'ditto') { fs.mkdirSync(args[1], { recursive: true }); fs.writeFileSync(path.join(args[1], 'half'), 'x'); return { code: 1, stdout: '', stderr: 'no space' }; }
      return run(cmd, args);
    };
    await expect(stageMacApp({ dmgPath: '/dl/a.dmg', version: '2.0.0', runningBundle: running, needsPassword: false, tmpDir: root, run: failing })).rejects.toBeTruthy();
    expect(fs.existsSync(path.join(path.dirname(running), '.YouCoded-update-2.0.0.app'))).toBe(false);
  });

  it('gives every command a time limit, and a timeout is a failure', async () => {
    expect(commandTimeoutMs('hdiutil', ['attach', 'x'])).toBe(300_000);
    expect(commandTimeoutMs('ditto', ['a', 'b'])).toBe(300_000);
    expect(commandTimeoutMs('codesign', ['--verify'])).toBe(120_000);
    expect(commandTimeoutMs('hdiutil', ['detach', 'x'])).toBe(30_000);
    const res = await runWithTimeout(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], 100);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('timed out');
  });

  it('reads the designated requirement from codesign output, with or without a leading "# "', () => {
    expect(parseDesignatedRequirement(`Executable=/a\n# designated => ${requirement}\n`)).toBe(requirement);
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

// ─── #183 T3: the exit hook and the Mac swap helper ────────────────────────────────────────────

describe('the exit hook (update-exit.ts)', () => {
  const attemptPath = () => path.join(root, 'attempt.json');
  const fakeSpawn = () => { const child = { on: vi.fn(), unref: vi.fn() }; return { child, spawn: vi.fn(() => child) }; };

  it('Windows: one detached, unref-ed installer spawn with /S --updated, plus --force-run to reopen', () => {
    expect(nsisArgs(false)).toEqual(['/S', '--updated']);
    expect(nsisArgs(true)).toEqual(['/S', '--updated', '--force-run']);
    const f = fakeSpawn();
    const ok = runExitPlan({ kind: 'win-nsis', version: '2.0.0', installer: 'C:\\cache\\Setup.exe' }, true, { spawn: f.spawn as never, attemptPath: attemptPath(), failures: 0, relaunch: vi.fn(), now: () => 123 });
    expect(ok).toBe(true);
    expect(f.spawn).toHaveBeenCalledWith('C:\\cache\\Setup.exe', ['/S', '--updated', '--force-run'], expect.objectContaining({ detached: true, stdio: 'ignore' }));
    expect(f.child.unref).toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(attemptPath(), 'utf8'))).toEqual({ version: '2.0.0', at: 123, failures: 0 });
  });

  it('AppImage: one rename over the running image; reopens only for Restart', () => {
    const target = path.join(root, 'YouCoded.AppImage'); fs.writeFileSync(target, 'old');
    const staged = path.join(root, '.YouCoded-update-2.0.0.AppImage'); fs.writeFileSync(staged, 'new');
    const relaunch = vi.fn();
    runExitPlan({ kind: 'appimage', version: '2.0.0', staged, target }, false, { attemptPath: attemptPath(), failures: 1, relaunch });
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.existsSync(staged)).toBe(false);
    expect(relaunch).not.toHaveBeenCalled(); // a plain quit install does not reopen the app
    expect(JSON.parse(fs.readFileSync(attemptPath(), 'utf8')).failures).toBe(1); // earlier failures are carried forward
    fs.writeFileSync(staged, 'newer');
    runExitPlan({ kind: 'appimage', version: '2.0.0', staged, target }, true, { attemptPath: attemptPath(), failures: 0, relaunch });
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('Mac: writes the go file the waiting helper looks for; its text says whether to reopen', () => {
    const goFile = path.join(root, 'go');
    runExitPlan({ kind: 'mac-go', version: '2.0.0', goFile }, true, { attemptPath: attemptPath(), failures: 0, relaunch: vi.fn() });
    expect(fs.readFileSync(goFile, 'utf8')).toBe('relaunch\n');
    runExitPlan({ kind: 'mac-go', version: '2.0.0', goFile }, false, { attemptPath: attemptPath(), failures: 0, relaunch: vi.fn() });
    expect(fs.readFileSync(goFile, 'utf8')).toBe('install\n');
  });

  it('is synchronous and awaits nothing (the process is about to end)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'update-exit.ts'), 'utf8');
    const body = src.slice(src.indexOf('export function runExitPlan'), src.indexOf('// ─── Attempt record'));
    expect(body).not.toMatch(/\bawait\b|\.then\(|fs\.promises|async /);
    const result = runExitPlan({ kind: 'mac-go', version: '2.0.0', goFile: path.join(root, 'go') }, false, { attemptPath: attemptPath(), failures: 0, relaunch: vi.fn() });
    expect(result).toBe(true); // a boolean, not a promise
  });

  it('reads an attempt record back and ignores garbage', async () => {
    fs.writeFileSync(attemptPath(), JSON.stringify({ version: '2.0.0', at: 5, failures: 1 }));
    expect(await readAttempt(attemptPath())).toEqual({ version: '2.0.0', at: 5, failures: 1, seen: false });
    fs.writeFileSync(attemptPath(), JSON.stringify({ version: '../../etc', failures: 1 }));
    expect(await readAttempt(attemptPath())).toBeNull();
  });
});

describe('the Mac helper arguments', () => {
  it('writable case: the go file is a sibling of the staged app, which is deleted when finished', () => {
    const staged = '/Applications/.YouCoded-update-2.0.0.app';
    expect(macGoPaths(staged)).toEqual({ goFile: staged + '.go', cleanup: staged, mode: 'user' });
    const argv = macHelperArgv({ pid: 42, oldBundle: '/Applications/YouCoded.app', staged, mode: 'user', uid: 501 });
    expect(argv).toEqual(['-c', MAC_HELPER_SCRIPT, 'sh', '42', '/Applications/YouCoded.app', staged, staged + '.go', staged, 'user', 'none', '501']);
  });

  it('password case: the go file sits in the private folder with the staged app, which the helper deletes whole', () => {
    const staged = '/var/tmp/youcoded-update-2.0.0/YouCoded.app';
    expect(macGoPaths(staged)).toEqual({ goFile: '/var/tmp/youcoded-update-2.0.0/go', cleanup: '/var/tmp/youcoded-update-2.0.0', mode: 'root' });
  });

  it('the one password box: fixed AppleScript, everything else is an argument quoted by AppleScript itself', () => {
    const args = macRootStartArgs({ pid: 7, oldBundle: "/Applications/It's \"YouCoded\".app", staged: '/var/tmp/youcoded-update-2.0.0/YouCoded.app', mode: 'root', requirement: 'identifier "x"', uid: 501 });
    const script = args.filter((_, i) => args[i - 1] === '-e').join('\n');
    expect(script).toContain('quoted form of');
    expect(script).toContain('with administrator privileges');
    expect(script).not.toContain("It's"); // no path is ever written into the AppleScript text
    const rest = args.slice(args.lastIndexOf('-e') + 2);
    expect(rest[0]).toBe(MAC_HELPER_SCRIPT);
    expect(rest).toContain("/Applications/It's \"YouCoded\".app");
    expect(rest.every((a) => a.length > 0 && !a.startsWith('-'))).toBe(true); // osascript would read "-x" as its own option
  });
});

// The helper script itself, run for real with /bin/sh against temp folders (a Linux runner has no
// codesign/open/launchctl, so the YC_* seams stand in for them).
describe.skipIf(process.platform === 'win32')('the Mac swap helper script', () => {
  let bin: string; let log: string;
  const dead = () => { const r = spawnSync('true'); return String(spawnSync('sh', ['-c', 'true & echo $!']).stdout).trim() || String(r.pid); };
  beforeEach(() => {
    bin = path.join(root, 'bin'); fs.mkdirSync(bin); log = path.join(root, 'log.txt'); fs.writeFileSync(log, '');
    const stub = (name: string, body: string) => { const f = path.join(bin, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return f; };
    stub('open', `echo "open $*" >> "${log}"`);
    stub('launchctl', `echo "launchctl $*" >> "${log}"; shift; shift; "$@"`);
    stub('chown', `echo "chown $*" >> "${log}"`);
    stub('codesign-ok', `echo "codesign $*" >> "${log}"`);
    stub('codesign-bad', `echo "codesign $*" >> "${log}"; exit 1`);
    // mv that fails when the destination is the installed bundle (the second move of a swap)
    stub('mv-fail-second', `case "$2" in *.bak) /bin/mv "$@";; *) exit 1;; esac`);
  });
  const env = (extra: Record<string, string> = {}) => ({ ...process.env, YC_SLEEP: '0.05', YC_OPEN: path.join(bin, 'open'), YC_LAUNCHCTL: path.join(bin, 'launchctl'), YC_CHOWN: path.join(bin, 'chown'), YC_CODESIGN: path.join(bin, 'codesign-ok'), ...extra });
  function layout(base: string) {
    const parent = path.join(root, base); fs.mkdirSync(parent, { recursive: true });
    const old = path.join(parent, 'YouCoded.app'); fs.mkdirSync(old); fs.writeFileSync(path.join(old, 'v'), 'old');
    const staged = path.join(parent, '.YouCoded-update-2.0.0.app'); fs.mkdirSync(staged); fs.writeFileSync(path.join(staged, 'v'), 'new');
    return { old, staged, go: staged + '.go' };
  }
  const run = (l: { old: string; staged: string; go: string }, e = env(), mode: 'user' | 'root' = 'user', pid = dead()) =>
    spawnSync('/bin/sh', macHelperArgv({ pid: Number(pid), oldBundle: l.old, staged: l.staged, mode, requirement: 'req', uid: 501 }), { env: e, encoding: 'utf8' });

  it('go present: swaps the staged app in, removes the backup, and reopens the app when the go file says so', () => {
    const l = layout('a'); fs.writeFileSync(l.go, 'relaunch\n');
    expect(run(l).status).toBe(0);
    expect(fs.readFileSync(path.join(l.old, 'v'), 'utf8')).toBe('new');
    expect(fs.existsSync(l.old + '.bak')).toBe(false);
    expect(fs.existsSync(l.staged)).toBe(false);
    expect(fs.existsSync(l.go)).toBe(false);
    expect(fs.readFileSync(log, 'utf8')).toContain(`open ${l.old}`);
  });

  it('go present without relaunch: swaps and does not reopen', () => {
    const l = layout('b'); fs.writeFileSync(l.go, 'install\n');
    run(l);
    expect(fs.readFileSync(path.join(l.old, 'v'), 'utf8')).toBe('new');
    expect(fs.readFileSync(log, 'utf8')).not.toContain('open ');
  });

  it('go absent: touches nothing in the installed app and removes the staging (a held Restart, a crash, a plain quit)', () => {
    const l = layout('c');
    expect(run(l).status).toBe(0);
    expect(fs.readFileSync(path.join(l.old, 'v'), 'utf8')).toBe('old');
    expect(fs.existsSync(l.staged)).toBe(false);
    expect(fs.readFileSync(log, 'utf8')).toBe('');
  });

  it('a failing move puts the old app back and removes the staging', () => {
    const l = layout('d'); fs.writeFileSync(l.go, 'relaunch\n');
    const r = run(l, env({ YC_MV: path.join(bin, 'mv-fail-second') }));
    expect(r.status).toBe(1);
    expect(fs.readFileSync(path.join(l.old, 'v'), 'utf8')).toBe('old');
    expect(fs.existsSync(l.old + '.bak')).toBe(false);
    expect(fs.readFileSync(log, 'utf8')).not.toContain('open ');
  });

  it('works with spaces, quotes and dollar signs in every path', () => {
    const l = layout(`it's a "dir" $HOME & more`); fs.writeFileSync(l.go, 'install\n');
    expect(run(l).status).toBe(0);
    expect(fs.readFileSync(path.join(l.old, 'v'), 'utf8')).toBe('new');
  });

  it('waits for the app to exit, and gives up after its limit without swapping or deleting', () => {
    const l = layout('e'); fs.writeFileSync(l.go, 'install\n');
    const alive = spawn('sleep', ['30']);
    try {
      const r = run(l, env({ YC_MAX_WAIT: '4' }), 'user', String(alive.pid));
      expect(r.status).toBe(0);
      expect(fs.readFileSync(path.join(l.old, 'v'), 'utf8')).toBe('old');
      expect(fs.existsSync(l.staged)).toBe(true);
      expect(fs.existsSync(l.go)).toBe(true);
    } finally { alive.kill(); }
  });

  it('root mode: takes ownership, re-checks the signature, swaps, then gives the bundle back to its original owner and reopens as the user', () => {
    const parent = path.join(root, 'r'); const folder = path.join(parent, 'youcoded-update-2.0.0'); fs.mkdirSync(folder, { recursive: true });
    const old = path.join(parent, 'YouCoded.app'); fs.mkdirSync(old); fs.writeFileSync(path.join(old, 'v'), 'old');
    const staged = path.join(folder, 'YouCoded.app'); fs.mkdirSync(staged); fs.writeFileSync(path.join(staged, 'v'), 'new');
    fs.writeFileSync(path.join(folder, 'go'), 'relaunch\n');
    const r = spawnSync('/bin/sh', macHelperArgv({ pid: Number(dead()), oldBundle: old, staged, mode: 'root', requirement: 'identifier "x"', uid: 501 }), { env: env(), encoding: 'utf8' });
    expect(r.status).toBe(0);
    const calls = fs.readFileSync(log, 'utf8');
    expect(calls.indexOf('chown -R root:wheel')).toBeGreaterThanOrEqual(0);
    expect(calls).toContain(`codesign --verify --deep --strict -R=identifier "x" ${staged}`);
    expect(calls).toMatch(/chown -R \d+:\d+ /); // the original owner restored after the swap
    expect(calls).toContain(`launchctl asuser 501 ${path.join(bin, 'open')} ${old}`);
    expect(fs.readFileSync(path.join(old, 'v'), 'utf8')).toBe('new');
  });

  it('root mode: an app that fails the signature re-check is never moved in', () => {
    const parent = path.join(root, 'r2'); const folder = path.join(parent, 'youcoded-update-2.0.0'); fs.mkdirSync(folder, { recursive: true });
    const old = path.join(parent, 'YouCoded.app'); fs.mkdirSync(old); fs.writeFileSync(path.join(old, 'v'), 'old');
    const staged = path.join(folder, 'YouCoded.app'); fs.mkdirSync(staged); fs.writeFileSync(path.join(staged, 'v'), 'evil');
    fs.writeFileSync(path.join(folder, 'go'), 'install\n');
    const r = spawnSync('/bin/sh', macHelperArgv({ pid: Number(dead()), oldBundle: old, staged, mode: 'root', requirement: 'req', uid: 501 }), { env: env({ YC_CODESIGN: path.join(bin, 'codesign-bad') }), encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(fs.readFileSync(path.join(old, 'v'), 'utf8')).toBe('old');
    expect(fs.existsSync(folder)).toBe(false);
  });
});
