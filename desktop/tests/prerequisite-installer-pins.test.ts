// desktop/tests/prerequisite-installer-pins.test.ts
// Pins the Windows-spawn invariants in prerequisite-installer.ts that previously
// had no unit guard (see .claude/rules/prereq-installer.md — "Guard: none — candidate").
import { describe, it, expect } from 'vitest';
import {
  shouldUseShell,
  getRegPath,
  getPowerShellPath,
  buildRefreshedPath,
  installWithWinget,
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

// Invariant 4: a winget install treats "already installed" as success. The app's PATH dates
// from launch, so a tool installed since then looks missing; winget then exits non-zero
// ("already installed") and setup dead-ended on "Command failed: winget install Git.Git"
// although Git was on disk (clean Windows 11 VM, 2026-10-02).
describe('installWithWinget (Windows prerequisite install)', () => {
  const found = { installed: true, version: 'git version 2.56.0' };
  const missing = { installed: false };
  const deps = (run: () => Promise<unknown>) => ({
    refresh: () => {},
    winget: async () => ({ installed: true, version: 'v1.29' }),
    run,
  });

  it('skips winget when a fresh PATH already finds the tool', async () => {
    let ran = false;
    const r = await installWithWinget('Git.Git', async () => found, deps(async () => { ran = true; }));
    expect(r).toEqual({ done: true, result: { success: true } });
    expect(ran).toBe(false);
  });

  it('counts a winget failure as success when the tool is there afterwards', async () => {
    const seen = [missing, found];
    const r = await installWithWinget('Git.Git', async () => seen.shift()!, deps(async () => {
      throw new Error('Command failed: winget install Git.Git');
    }));
    expect(r).toEqual({ done: true, result: { success: true } });
  });

  it('still reports a real winget failure', async () => {
    await expect(installWithWinget('Git.Git', async () => missing, deps(async () => {
      throw new Error('Command failed: winget install Git.Git');
    }))).rejects.toThrow('Command failed');
  });

  it('hands back to the caller after a clean winget run', async () => {
    const r = await installWithWinget('Git.Git', async () => missing, deps(async () => undefined));
    expect(r).toEqual({ done: false });
  });
});
