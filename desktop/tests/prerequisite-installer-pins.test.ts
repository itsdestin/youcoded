// desktop/tests/prerequisite-installer-pins.test.ts
// Pins the Windows-spawn invariants in prerequisite-installer.ts that previously
// had no unit guard (see .claude/rules/prereq-installer.md — "Guard: none — candidate").
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  shouldUseShell,
  getRegPath,
  getPowerShellPath,
  buildRefreshedPath,
  nodeAsset,
  gitWindowsAsset,
  fileMatchesSha256,
  mergeUserPath,
  windowsToolsRoot,
  windowsNodeDir,
  windowsGitCmdDir,
  pollUntilInstalled,
} from '../src/main/prerequisite-installer';

// Invariant 1: runCommand flips `shell: true` ONLY for Windows .cmd/.bat shims
// (the CVE-2024-27980 EINVAL mitigation). Real .exe/bare paths must stay
// shell:false so the no-shell-injection guarantee holds; non-Windows never
// needs the shell flag.
describe('shouldUseShell (runCommand shell-flag decision)', () => {
  it('uses shell for .cmd/.bat on win32 (case-insensitive)', () => {
    expect(shouldUseShell('C:\\Program Files\\nodejs\\npm.cmd', 'win32')).toBe(true);
    expect(shouldUseShell('npm.CMD', 'win32')).toBe(true);
    expect(shouldUseShell('foo.bat', 'win32')).toBe(true);
  });

  it('does NOT use shell for .exe or bare commands on win32', () => {
    expect(shouldUseShell('C:\\Windows\\System32\\reg.exe', 'win32')).toBe(false);
    expect(shouldUseShell('claude.exe', 'win32')).toBe(false);
    expect(shouldUseShell('git', 'win32')).toBe(false);
  });

  it('never uses shell off Windows, even for .cmd/.bat', () => {
    expect(shouldUseShell('npm.cmd', 'darwin')).toBe(false);
    expect(shouldUseShell('foo.bat', 'linux')).toBe(false);
  });
});

// Invariant 2: getRegPath() returns a QUOTED path (interpolated into a cmd.exe
// execSync string) while getPowerShellPath() returns an UNQUOTED path (passed as
// the file arg of execFile with shell:false — embedded quotes would become part
// of the filename and CreateProcess fails with ENOENT). The asymmetry is
// load-bearing. These read System32 via fs.existsSync, so they only resolve to
// the real absolute paths on Windows; on other OSes both fall back to bare names.
describe.runIf(process.platform === 'win32')('reg/powershell path quoting asymmetry', () => {
  it('getRegPath() is quoted and points at reg.exe', () => {
    const reg = getRegPath();
    expect(reg.startsWith('"')).toBe(true);
    expect(reg.endsWith('"')).toBe(true);
    expect(reg.endsWith('reg.exe"')).toBe(true);
  });

  it('getPowerShellPath() is UNQUOTED and points at powershell.exe', () => {
    const ps = getPowerShellPath();
    expect(ps.includes('"')).toBe(false);
    expect(ps.endsWith('powershell.exe')).toBe(true);
  });
});

// Invariant 3: refreshPath() expands the registry's %VARS% and keeps the app's other PATH
// entries. Unexpanded `%SystemRoot%\system32` / `%USERPROFILE%\...\WindowsApps` entries are
// invisible to Windows' PATH search, which made winget vanish right after it installed Node
// (clean Windows 11 VM, 2026-10-02: setup then dead-ended at Git with "winget is missing").
describe('buildRefreshedPath (Windows PATH rebuilt from the registry)', () => {
  const env = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Ann' };

  it('expands %VARS% so System32 and WindowsApps (winget) stay findable', () => {
    const out = buildRefreshedPath(
      '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps',
      '%SystemRoot%\\system32;C:\\Program Files\\nodejs\\',
      '',
      env,
    ).split(';');
    expect(out).toEqual([
      'C:\\Users\\Ann\\AppData\\Local\\Microsoft\\WindowsApps',
      'C:\\Windows\\system32',
      'C:\\Program Files\\nodejs\\',
    ]);
  });

  it('looks names up case-insensitively and leaves unknown names as written', () => {
    expect(buildRefreshedPath('%systemroot%\\x;%NOPE%\\y', '', '', env)).toBe('C:\\Windows\\x;%NOPE%\\y');
  });

  it('keeps launch-time entries the registry lacks, after the registry ones, without duplicates', () => {
    const out = buildRefreshedPath(
      'C:\\Program Files\\Git\\cmd',
      '%SystemRoot%\\system32',
      'C:\\WINDOWS\\System32\\;C:\\Users\\Ann\\.local\\bin;;',
      env,
    ).split(';');
    expect(out).toEqual([
      'C:\\Program Files\\Git\\cmd',
      'C:\\Windows\\system32',
      'C:\\Users\\Ann\\.local\\bin',
    ]);
  });
});

// Invariant 4: Node and Git are installed by direct download (no winget), and every archive is
// pinned to a sha256 that is verified before anything is extracted or run (Destin, 2026-10-02).
// The tests never touch the network.
describe('pinned download assets', () => {
  it('pins Node v24.21.0 with the published sha256 for every platform', () => {
    const want: Array<[NodeJS.Platform, string, string, string]> = [
      ['darwin', 'arm64', 'node-v24.21.0-darwin-arm64.tar.gz', 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057'],
      ['darwin', 'x64', 'node-v24.21.0-darwin-x64.tar.gz', '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097'],
      ['linux', 'arm64', 'node-v24.21.0-linux-arm64.tar.gz', '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5'],
      ['linux', 'x64', 'node-v24.21.0-linux-x64.tar.gz', '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff'],
      ['win32', 'arm64', 'node-v24.21.0-win-arm64.zip', '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921'],
      ['win32', 'x64', 'node-v24.21.0-win-x64.zip', '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'],
    ];
    for (const [plat, arch, name, sha] of want) {
      expect(nodeAsset(plat, arch)).toEqual({ name, sha256: sha, url: `https://nodejs.org/dist/v24.21.0/${name}` });
    }
  });

  it('has no Node build for unsupported platforms or 32-bit', () => {
    expect(nodeAsset('win32', 'ia32')).toBeNull();
    expect(nodeAsset('freebsd', 'x64')).toBeNull();
  });

  it('pins Portable Git (has bash; MinGit does not) for x64 and arm64', () => {
    expect(gitWindowsAsset('x64')).toEqual({
      name: 'PortableGit-2.56.0-64-bit.7z.exe',
      url: 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.1/PortableGit-2.56.0-64-bit.7z.exe',
      sha256: 'eceb5e061aa90df2f69ddd3e90f0030e1b8037a7829934bc40e4be1caa1accc1',
    });
    expect(gitWindowsAsset('arm64')?.sha256).toBe('edd9bd32aefa5d2bd4b938c38c18ceca306a7f6b29a6951cd6a4bb16d9d28d8f');
    expect(gitWindowsAsset('arm64')?.name).toBe('PortableGit-2.56.0-arm64.7z.exe');
    expect(gitWindowsAsset('ia32')).toBeNull();
  });

  it('accepts a matching file and rejects a different one', async () => {
    const f = path.join(os.tmpdir(), `yc-sha-${process.pid}.bin`);
    fs.writeFileSync(f, 'abc');
    try {
      const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
      expect(await fileMatchesSha256(f, abc)).toBe(true);
      expect(await fileMatchesSha256(f, abc.toUpperCase())).toBe(true);
      expect(await fileMatchesSha256(f, '0'.repeat(64))).toBe(false);
    } finally {
      fs.rmSync(f, { force: true });
    }
  });
});

// Invariant 5: the user PATH write keeps existing (possibly %VAR%) entries verbatim, prepends
// only when absent, and never duplicates.
describe('mergeUserPath (registry PATH value)', () => {
  const dir = 'C:\\Users\\Ann\\AppData\\Local\\YouCoded\\node';

  it('prepends and keeps %VARS% unexpanded', () => {
    expect(mergeUserPath('%USERPROFILE%\\bin;C:\\Tools', dir)).toBe(`${dir};%USERPROFILE%\\bin;C:\\Tools`);
  });

  it('handles an empty or missing PATH', () => {
    expect(mergeUserPath('', dir)).toBe(dir);
  });

  it('returns null when the dir is already listed (case and trailing slash ignored)', () => {
    expect(mergeUserPath(`C:\\x;${dir.toUpperCase()}\\`, dir)).toBeNull();
  });

  it('drops empty entries so it never writes ";;"', () => {
    expect(mergeUserPath('C:\\x;;', dir)).toBe(`${dir};C:\\x`);
  });
});

describe('Windows install layout', () => {
  it('uses %LOCALAPPDATA%\\YouCoded, falling back to the home folder', () => {
    expect(windowsToolsRoot({ LOCALAPPDATA: 'D:\\L' }, 'C:\\Users\\Ann')).toBe('D:\\L\\YouCoded');
    expect(windowsToolsRoot({}, 'C:\\Users\\Ann')).toBe('C:\\Users\\Ann\\AppData\\Local\\YouCoded');
  });

  it('puts git.exe at git\\cmd so tools/bash.ts finds git\\bin\\bash.exe from it', () => {
    const root = windowsToolsRoot({ LOCALAPPDATA: 'D:\\L' }, '');
    const cmd = windowsGitCmdDir(root);
    expect(cmd).toBe('D:\\L\\YouCoded\\git\\cmd');
    // The same derivation harness/tools/bash.ts uses: <root>\\cmd\\git.exe -> <root>\\bin\\bash.exe
    const gitExe = path.win32.join(cmd, 'git.exe');
    const derived = path.win32.join(path.win32.dirname(path.win32.dirname(gitExe)), 'bin', 'bash.exe');
    expect(derived).toBe('D:\\L\\YouCoded\\git\\bin\\bash.exe');
    expect(windowsNodeDir(root)).toBe('D:\\L\\YouCoded\\node');
  });
});

// Invariant 6: on macOS, Git waits for Apple's installer instead of failing; the poll stops on
// success, and on timeout reports "not installed" (installGit then returns the actionable error).
describe('pollUntilInstalled (macOS Command Line Tools wait)', () => {
  it('keeps polling until Git appears, sleeping between checks', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const r = await pollUntilInstalled(
      async () => (++calls >= 3 ? { installed: true, version: 'git version 2.50' } : { installed: false }),
      { intervalMs: 5000, timeoutMs: 1_800_000, sleep: async (ms) => { sleeps.push(ms); }, now: () => 0 },
    );
    expect(r?.installed).toBe(true);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([5000, 5000]);
  });

  it('gives up with null once the deadline passes', async () => {
    let t = 0;
    const r = await pollUntilInstalled(async () => ({ installed: false }), {
      intervalMs: 5000, timeoutMs: 20000, sleep: async (ms) => { t += ms; }, now: () => t,
    });
    expect(r).toBeNull();
    expect(t).toBe(20000);
  });
});
