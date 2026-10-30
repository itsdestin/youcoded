import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// WHY: security audit SC-5 — a plugin must never rewrite a hook that belongs to
// another plugin (or the user) just because the script file name is the same.
let pluginDirsForTest: string[] = [];
vi.mock('../src/main/claude-code-registry', () => ({
  listInstalledPluginDirs: () => pluginDirsForTest,
}));

const { reconcileHooks } = await import('../src/main/hook-reconciler');

describe('reconcileHooks: hook ownership', () => {
  let tmpHome: string;
  let origHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-hook-owner-'));
    origHomedir = os.homedir;
    (os as any).homedir = () => tmpHome;
  });
  afterEach(() => {
    (os as any).homedir = origHomedir;
    pluginDirsForTest = [];
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  function write(p: string, c: string) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); }
  const base = () => path.join(tmpHome, '.claude', 'plugins', 'marketplaces', 'youcoded', 'plugins');
  const settingsPath = () => path.join(tmpHome, '.claude', 'settings.json');
  const readSettings = () => JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));

  function plugin(id: string, command: (id: string) => string) {
    const dir = path.join(base(), id);
    write(path.join(dir, 'hooks', 'session-start.sh'), '#!/bin/bash\n');
    write(path.join(dir, 'hooks', 'hooks-manifest.json'), JSON.stringify({
      hooks: { SessionStart: [{ command: command(id), required: true }] },
    }));
    return dir;
  }

  it('does not overwrite another plugin\'s hook with the same script name', async () => {
    const a = plugin('plugin-a', (id) => `bash ${path.join(base(), id, 'hooks', 'session-start.sh')}`);
    const b = plugin('plugin-b', (id) => `bash ${path.join(base(), id, 'hooks', 'session-start.sh')}`);
    pluginDirsForTest = [a, b];
    const aCmd = `bash ${path.join(a, 'hooks', 'session-start.sh')}`;
    const bCmd = `bash ${path.join(b, 'hooks', 'session-start.sh')}`;
    write(settingsPath(), JSON.stringify({
      hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: aCmd }] }] },
    }));

    await reconcileHooks();
    const first = readSettings();
    const cmds = first.hooks.SessionStart.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds).toContain(aCmd);
    expect(cmds).toContain(bCmd);

    // Second run is idempotent: no duplicates, still both present.
    await reconcileHooks();
    const second = readSettings().hooks.SessionStart.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(second.sort()).toEqual(cmds.sort());
  });

  it('does not overwrite a user-added hook with the same script name', async () => {
    const a = plugin('plugin-a', (id) => `bash ${path.join(base(), id, 'hooks', 'session-start.sh')}`);
    pluginDirsForTest = [a];
    write(settingsPath(), JSON.stringify({
      hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'bash /opt/mine/session-start.sh' }] }] },
    }));
    await reconcileHooks();
    const cmds = readSettings().hooks.SessionStart.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds).toContain('bash /opt/mine/session-start.sh');
  });

  it('still updates its own stale path (same plugin id at an older location)', async () => {
    const a = plugin('plugin-a', (id) => `bash ${path.join(base(), id, 'hooks', 'session-start.sh')}`);
    pluginDirsForTest = [a];
    // Older layout: the same plugin lived directly under the plugins dir.
    const oldDir = path.join(tmpHome, '.claude', 'plugins', 'plugin-a');
    write(path.join(oldDir, 'core', 'hooks', 'session-start.sh'), '#!/bin/bash\n');
    pluginDirsForTest = [a, oldDir];
    write(settingsPath(), JSON.stringify({
      hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: `bash ${path.join(oldDir, 'core', 'hooks', 'session-start.sh')}` }] }] },
    }));
    await reconcileHooks();
    const cmds = readSettings().hooks.SessionStart.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds).toEqual([`bash ${path.join(a, 'hooks', 'session-start.sh')}`]);
  });
});
