import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

// The launch chores that touch ~/.claude/settings.json (2026-09-16 audit
// W3/W4/D5): hook scripts staged once per build, hook entries written once,
// and the three later chores landing in one write. Temp home throughout.

let pluginDirsForTest: string[] = [];
vi.mock('../src/main/claude-code-registry', () => ({
  listInstalledPluginDirs: () => pluginDirsForTest,
}));

const { runInstallHooksChore, runSettingsChores } = await import('../src/main/launch-settings-chores');
const { __resetSettingsMemo } = await import('../src/main/claude-settings');
const installHooks = createRequire(__filename)(
  path.join(__dirname, '..', 'scripts', 'install-hooks.js'),
) as { isWorktreeSource(srcDir?: string): boolean; FIRE_AND_FORGET_EVENTS: string[] };

let tmpHome: string;
let origHomedir: typeof os.homedir;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-launch-chores-'));
  origHomedir = os.homedir;
  (os as any).homedir = () => tmpHome;
  pluginDirsForTest = [];
  __resetSettingsMemo();
});

afterEach(() => {
  (os as any).homedir = origHomedir;
  vi.restoreAllMocks();
  try { fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 3 }); } catch {}
});

const settingsFile = () => path.join(tmpHome, '.claude', 'settings.json');
const stableDir = () => path.join(tmpHome, '.claude', 'youcoded-hooks');
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
const BUILD = { version: '1.2.3', packaged: true };

describe('install-hooks chore', () => {
  it('first launch stages the scripts, stamps the build and writes the hook entries', async () => {
    const r = await runInstallHooksChore(BUILD);
    expect(r.copied).toBe(true);
    expect(r.written).toBe(true);
    expect(fs.readFileSync(path.join(stableDir(), '.version'), 'utf8')).toBe('1.2.3|packaged');
    expect(fs.existsSync(path.join(stableDir(), 'relay.js'))).toBe(true);
    const s = readSettings();
    for (const event of installHooks.FIRE_AND_FORGET_EVENTS) {
      expect(s.hooks[event][0].hooks[0].command).toBe(`node ${JSON.stringify(path.join(stableDir(), 'relay.js'))}`);
    }
    expect(s.hooks.PermissionRequest[0].hooks[0].command).toContain('relay-blocking.js');
    expect(s.statusLine.command).toBe(`bash ${JSON.stringify(path.join(stableDir(), 'statusline.sh'))}`);
    expect(fs.readFileSync(path.join(tmpHome, '.claude', 'CLAUDE.md'), 'utf8')).toContain('## Auto-Title');
  });

  it('second launch of the same build copies nothing and writes nothing', async () => {
    await runInstallHooksChore(BUILD);
    const settingsBefore = fs.readFileSync(settingsFile(), 'utf8');
    const settingsMtime = fs.statSync(settingsFile()).mtimeMs;
    const relayMtime = fs.statSync(path.join(stableDir(), 'relay.js')).mtimeMs;
    const cp = vi.spyOn(fs, 'cpSync');

    const r = await runInstallHooksChore(BUILD);

    expect(r.copied).toBe(false);
    expect(r.written).toBe(false);
    expect(r.repaired).toBe(0);
    expect(cp).not.toHaveBeenCalled();
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(settingsBefore);
    expect(fs.statSync(settingsFile()).mtimeMs).toBe(settingsMtime);
    expect(fs.statSync(path.join(stableDir(), 'relay.js')).mtimeMs).toBe(relayMtime);
  });

  it('a different version, or the same version unpackaged, restages', async () => {
    await runInstallHooksChore(BUILD);
    expect((await runInstallHooksChore({ version: '1.2.4', packaged: true })).copied).toBe(true);
    expect((await runInstallHooksChore({ version: '1.2.4', packaged: false })).copied).toBe(true);
    expect((await runInstallHooksChore({ version: '1.2.4', packaged: false })).copied).toBe(false);
  });

  it('a matching stamp over an emptied stable dir restages anyway', async () => {
    await runInstallHooksChore(BUILD);
    fs.rmSync(path.join(stableDir(), 'relay.js'));
    const r = await runInstallHooksChore(BUILD);
    expect(r.copied).toBe(true);
    expect(fs.existsSync(path.join(stableDir(), 'relay.js'))).toBe(true);
  });

  it('repairs a stale relay path and counts it, leaving user hooks alone', async () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({
      hooks: {
        Stop: [
          { matcher: '', hooks: [{ type: 'command', command: 'node "/tmp/.mount_abc/relay.js"', timeout: 10 }] },
          { matcher: '', hooks: [{ type: 'command', command: 'bash /opt/mine/notify.sh' }] },
        ],
      },
      statusLine: { type: 'command', command: 'bash /home/me/custom-bar.sh' },
    }));
    const r = await runInstallHooksChore(BUILD);
    expect(r.written).toBe(true);
    expect(r.repaired).toBe(1);
    const s = readSettings();
    expect(s.hooks.Stop[0].hooks[0].command).toBe(`node ${JSON.stringify(path.join(stableDir(), 'relay.js'))}`);
    expect(s.hooks.Stop[1].hooks[0].command).toBe('bash /opt/mine/notify.sh');
    // A custom statusline that is not ours is never overwritten.
    expect(s.statusLine.command).toBe('bash /home/me/custom-bar.sh');
  });

  it('a corrupt settings.json is backed up with its original bytes and rewritten with the hooks; the next launch makes no second backup', async () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), '{ "hooks": ');
    const r = await runInstallHooksChore(BUILD);
    expect(r.written).toBe(true);
    expect(r.repairedFile?.backupPath).toContain('settings.json.corrupt-');
    expect(fs.readFileSync(r.repairedFile!.backupPath, 'utf8')).toBe('{ "hooks": ');
    const s = readSettings();
    expect(s.hooks.Stop[0].hooks[0].command).toBe(`node ${JSON.stringify(path.join(stableDir(), 'relay.js'))}`);

    const again = await runInstallHooksChore(BUILD);
    expect(again.repairedFile).toBeUndefined();
    expect(again.written).toBe(false);
    const backups = fs.readdirSync(path.dirname(settingsFile())).filter((n) => n.includes('.corrupt-'));
    expect(backups).toHaveLength(1);
  });

  it('recognises a dev worktree as a source it must not stage from', () => {
    expect(installHooks.isWorktreeSource(path.join('x', '.worktrees', 'y', 'desktop', 'hook-scripts'))).toBe(true);
    expect(installHooks.isWorktreeSource(path.join('x', 'worktrees', 'y', 'desktop', 'hook-scripts'))).toBe(false);
  });
});

describe('the three settings chores after install-hooks', () => {
  it('land in ONE write when the file needs them, in order, with each chore reporting its own change', async () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ promptSuggestionEnabled: true }));
    const rename = vi.spyOn(fs.promises, 'rename');

    const r = await runSettingsChores();

    expect(r.written).toBe(true);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(r.promptSuggestion).toEqual({ changed: true, prior: true });
    expect(r.retention).toEqual({ changed: true, effective: 365 });
    expect(r.hooks.manifestCount).toBe(0);
    expect(readSettings()).toEqual({ promptSuggestionEnabled: false, cleanupPeriodDays: 365, hooks: {} });
  });

  it('write nothing when the file is already correct', async () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    const correct = JSON.stringify({ promptSuggestionEnabled: false, cleanupPeriodDays: 30, hooks: {} });
    fs.writeFileSync(settingsFile(), correct);
    const rename = vi.spyOn(fs.promises, 'rename');

    const r = await runSettingsChores();

    expect(r.written).toBe(false);
    expect(rename).not.toHaveBeenCalled();
    expect(r.promptSuggestion.changed).toBe(false);
    expect(r.retention).toEqual({ changed: false, effective: 30 });
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(correct);
  });

  it('on the phone, also start Claude Code in fullscreen, only when no display mode is set', async () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ promptSuggestionEnabled: false, cleanupPeriodDays: 30, hooks: {} }));
    const r = await runSettingsChores({ phone: true });
    expect(r.tui).toEqual({ changed: true, effective: 'fullscreen' });
    expect(readSettings().tui).toBe('fullscreen');
    // The user's own `/tui default` survives every later boot.
    fs.writeFileSync(settingsFile(), JSON.stringify({ promptSuggestionEnabled: false, cleanupPeriodDays: 30, hooks: {}, tui: 'default' }));
    __resetSettingsMemo();
    expect((await runSettingsChores({ phone: true })).tui.changed).toBe(false);
    expect(readSettings().tui).toBe('default');
  });

  it('on the phone, a missing or corrupt file still gets fullscreen, the corrupt one kept beside it', async () => {
    expect((await runSettingsChores({ phone: true })).tui.changed).toBe(true); // no file at all
    fs.writeFileSync(settingsFile(), 'not json');
    __resetSettingsMemo();
    const r = await runSettingsChores({ phone: true });
    expect(fs.readFileSync(r.repaired!.backupPath, 'utf8')).toBe('not json');
    expect(readSettings().tui).toBe('fullscreen');
  });

  it('on a computer, never set a display mode (the desktop keeps Claude Code\'s own default)', async () => {
    const r = await runSettingsChores();
    expect(r.tui.changed).toBe(false);
    expect(readSettings().tui).toBeUndefined();
  });

  it('reconcile a required plugin hook in the same cycle', async () => {
    const pluginRoot = path.join(tmpHome, '.claude', 'plugins', 'marketplaces', 'youcoded', 'plugins', 'p');
    const script = path.join(pluginRoot, 'hooks', 'start.sh');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '#!/bin/bash\n');
    fs.writeFileSync(path.join(pluginRoot, 'hooks', 'hooks-manifest.json'), JSON.stringify({
      hooks: { SessionStart: [{ command: `bash ${script}`, required: true }] },
    }));
    pluginDirsForTest = [pluginRoot];

    const r = await runSettingsChores();

    expect(r.hooks.added).toBe(1);
    expect(readSettings().hooks.SessionStart[0].hooks[0].command).toBe(`bash ${script}`);
  });

  it('repair a corrupt file together, in one write, keeping the original beside it', async () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), 'not json');
    const rename = vi.spyOn(fs.promises, 'rename');

    const r = await runSettingsChores();

    expect(r.repaired?.backupPath).toContain('settings.json.corrupt-');
    expect(fs.readFileSync(r.repaired!.backupPath, 'utf8')).toBe('not json');
    expect(r.promptSuggestion).toEqual({ changed: true, prior: undefined });
    expect(r.retention).toEqual({ changed: true, effective: 365 });
    expect(readSettings()).toEqual({ promptSuggestionEnabled: false, cleanupPeriodDays: 365, hooks: {} });
    expect(rename).toHaveBeenCalledTimes(2); // the corrupt-file backup and the fresh write (both async now)
  });
});

// Card #11 (b): another program holding settings.json's lock for more than the
// shared 3 s used to make the launch edits skip silently. The launch attempt is
// unchanged (it runs before the window appears); one background retry later
// waits up to ~10 s for THIS file only.
describe('a launch edit refused for the lock is retried once, later, with a longer wait', () => {
  afterEach(() => { vi.useRealTimers(); });

  const deps = (order: string[], install: { refused?: 'locked' } = {}, chores: { refused?: 'locked' } = {}) => ({
    runInstallHooks: vi.fn(async (o: { lockWaitMs: number }) => { order.push(`install:${o.lockWaitMs}`); return install; }),
    runChores: vi.fn(async (o: { lockWaitMs: number }) => { order.push(`chores:${o.lockWaitMs}`); return chores; }),
    log: vi.fn(),
  });

  it('schedules nothing when the launch edits went through', async () => {
    const { scheduleLockedSettingsRetry } = await import('../src/main/launch-settings-chores');
    expect(scheduleLockedSettingsRetry({ installLocked: false, choresLocked: false }, deps([]))).toBeNull();
  });

  it('waits before retrying, then runs install-hooks before the chores, each allowed the longer wait', async () => {
    vi.useFakeTimers();
    const { scheduleLockedSettingsRetry, SETTINGS_RETRY_DELAY_MS, SETTINGS_RETRY_LOCK_WAIT_MS } = await import('../src/main/launch-settings-chores');
    const order: string[] = [];
    const d = deps(order);
    const done = scheduleLockedSettingsRetry({ installLocked: true, choresLocked: false }, d)!;
    await vi.advanceTimersByTimeAsync(SETTINGS_RETRY_DELAY_MS - 1);
    expect(order).toEqual([]);                      // nothing happens at launch itself
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(SETTINGS_RETRY_LOCK_WAIT_MS).toBe(10_000);
    expect(order).toEqual(['install:10000', 'chores:10000']);
  });

  it('stops after install-hooks if the lock is still held, and logs it', async () => {
    vi.useFakeTimers();
    const { scheduleLockedSettingsRetry, SETTINGS_RETRY_DELAY_MS } = await import('../src/main/launch-settings-chores');
    const order: string[] = [];
    const d = deps(order, { refused: 'locked' });
    const done = scheduleLockedSettingsRetry({ installLocked: true, choresLocked: true }, d)!;
    await vi.advanceTimersByTimeAsync(SETTINGS_RETRY_DELAY_MS);
    await done;
    expect(order).toEqual(['install:10000']);
    expect(d.log).toHaveBeenCalledWith('WARN', expect.stringMatching(/still not written/), expect.anything());
  });

  // A real held lock, real 10 ms polls, and a faked clock so "3 s" and "10 s"
  // pass instantly. Polls are counted on the lock folder so each clock jump
  // happens only once the writer is provably waiting.
  describe('with another program holding the lock', () => {
    const lockDir = () => settingsFile() + '.lock';
    let polls = 0;
    beforeEach(() => {
      fs.mkdirSync(lockDir(), { recursive: true });
      polls = 0;
      const realMkdir = fs.promises.mkdir.bind(fs.promises);
      vi.spyOn(fs.promises, 'mkdir').mockImplementation(((p: any, o?: any) => {
        if (p === lockDir()) polls++;
        return realMkdir(p, o);
      }) as any);
      vi.useFakeTimers({ toFake: ['Date'] });
    });
    const waitForPolls = async (n: number) => { const target = polls + n; await vi.waitFor(() => expect(polls).toBeGreaterThanOrEqual(target)); };

    it('the ordinary launch attempt still gives up just past 3 s', async () => {
      const pending = runSettingsChores();
      await waitForPolls(2);
      vi.setSystemTime(Date.now() + 3_100);
      expect((await pending).refused).toBe('locked');
    });

    it('the retry keeps waiting past 3 s and writes once the holder lets go', async () => {
      const { SETTINGS_RETRY_LOCK_WAIT_MS } = await import('../src/main/launch-settings-chores');
      let settled = false;
      const pending = runSettingsChores({ lockWaitMs: SETTINGS_RETRY_LOCK_WAIT_MS }).finally(() => { settled = true; });
      await waitForPolls(2);
      vi.setSystemTime(Date.now() + 5_000);
      await waitForPolls(3);                          // still polling 5 s in
      expect(settled).toBe(false);
      fs.rmSync(lockDir(), { recursive: true, force: true });
      const r = await pending;
      expect(r.refused).toBeUndefined();
      expect(r.promptSuggestion.changed).toBe(true);
      expect(readSettings().promptSuggestionEnabled).toBe(false);
    });

    it('the retry gives up too, just past 10 s', async () => {
      const { SETTINGS_RETRY_LOCK_WAIT_MS } = await import('../src/main/launch-settings-chores');
      const pending = runSettingsChores({ lockWaitMs: SETTINGS_RETRY_LOCK_WAIT_MS });
      await waitForPolls(2);
      vi.setSystemTime(Date.now() + 10_100);
      expect((await pending).refused).toBe('locked');
    });
  });
});
