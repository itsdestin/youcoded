import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Stub listInstalledPluginDirs before importing hook-reconciler so the stubbed
// homedir in each test is honoured (the real registry captures ~/.claude at
// module load).
let pluginDirsForTest: string[] = [];
vi.mock('../src/main/claude-code-registry', () => ({
  listInstalledPluginDirs: () => pluginDirsForTest,
}));

const { reconcileHooks, __test } = await import('../src/main/hook-reconciler');
const { pruneDeadPluginHooks, extractScriptPath } = __test;

describe('extractScriptPath', () => {
  it('extracts script path from `bash <path>` command', () => {
    expect(extractScriptPath('bash /home/u/hooks/foo.sh'))
      .toBe('/home/u/hooks/foo.sh');
  });

  it('expands leading ~ to home', () => {
    const p = extractScriptPath('bash ~/.claude/plugins/destinclaude/hooks/foo.sh');
    expect(p).toBe(path.join(os.homedir(), '.claude', 'plugins', 'destinclaude', 'hooks', 'foo.sh'));
  });

  it('handles commands with trailing args', () => {
    expect(extractScriptPath('bash /x/y/z.sh --flag'))
      .toBe('/x/y/z.sh');
  });

  it('returns null for commands with no script file', () => {
    expect(extractScriptPath('echo hello')).toBeNull();
  });
});

describe('pruneDeadPluginHooks', () => {
  let tmpHome: string;
  let origHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'destincode-hook-prune-'));
    origHomedir = os.homedir;
    (os as any).homedir = () => tmpHome;
  });

  afterEach(() => {
    (os as any).homedir = origHomedir;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  function mkdir(p: string) { fs.mkdirSync(p, { recursive: true }); }
  function write(p: string, content: string) { mkdir(path.dirname(p)); fs.writeFileSync(p, content); }

  it('prunes a plugin-owned hook whose target file is gone', () => {
    const pluginRoot = path.join(tmpHome, '.claude', 'plugins', 'destinclaude');
    mkdir(pluginRoot);
    // File is intentionally NOT created — simulates a dropped hook
    const settings: any = {
      hooks: {
        SessionStart: [
          {
            matcher: '',
            hooks: [{
              type: 'command',
              command: `bash ${path.join(pluginRoot, 'hooks', 'sync.sh')}`,
            }],
          },
        ],
      },
    };
    const pruned = pruneDeadPluginHooks(settings, [pluginRoot]);
    expect(pruned).toBe(1);
    // The empty matcher entry AND empty event should be removed
    expect(settings.hooks.SessionStart).toBeUndefined();
  });

  it('keeps a plugin-owned hook whose target file exists', () => {
    const pluginRoot = path.join(tmpHome, '.claude', 'plugins', 'destinclaude');
    const hookPath = path.join(pluginRoot, 'hooks', 'session-start.sh');
    write(hookPath, '#!/bin/bash\n');
    const settings: any = {
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: `bash ${hookPath}` }] }],
      },
    };
    const pruned = pruneDeadPluginHooks(settings, [pluginRoot]);
    expect(pruned).toBe(0);
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it('never prunes a user-added hook outside the plugin root', () => {
    const pluginRoot = path.join(tmpHome, '.claude', 'plugins', 'destinclaude');
    mkdir(pluginRoot);
    // User-added hook points somewhere OUTSIDE the plugin root, and the file is missing.
    // We must NOT touch it — the "never remove user-added hooks" guarantee.
    const settings: any = {
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'bash /opt/custom/my-hook.sh' }],
        }],
      },
    };
    const pruned = pruneDeadPluginHooks(settings, [pluginRoot]);
    expect(pruned).toBe(0);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  it('prunes one dead hook but keeps sibling hooks in the same matcher entry', () => {
    const pluginRoot = path.join(tmpHome, '.claude', 'plugins', 'destinclaude');
    const liveHook = path.join(pluginRoot, 'hooks', 'session-start.sh');
    write(liveHook, '#!/bin/bash\n');
    const deadHook = path.join(pluginRoot, 'hooks', 'sync.sh'); // file not created
    const settings: any = {
      hooks: {
        SessionStart: [{
          matcher: '',
          hooks: [
            { type: 'command', command: `bash ${liveHook}` },
            { type: 'command', command: `bash ${deadHook}` },
          ],
        }],
      },
    };
    const pruned = pruneDeadPluginHooks(settings, [pluginRoot]);
    expect(pruned).toBe(1);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(`bash ${liveHook}`);
  });
});

describe('reconcileHooks integration: prune runs after reconcile', () => {
  let tmpHome: string;
  let origHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'destincode-hook-reconcile-'));
    origHomedir = os.homedir;
    (os as any).homedir = () => tmpHome;
  });

  afterEach(() => {
    (os as any).homedir = origHomedir;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  function mkdir(p: string) { fs.mkdirSync(p, { recursive: true }); }
  function write(p: string, content: string) { mkdir(path.dirname(p)); fs.writeFileSync(p, content); }

  it('returns pruned count in the result', () => {
    // Install a plugin with a manifest that lists session-start.sh only
    const pluginRoot = path.join(tmpHome, '.claude', 'plugins', 'destinclaude');
    pluginDirsForTest = [pluginRoot];
    const sessionStart = path.join(pluginRoot, 'hooks', 'session-start.sh');
    write(sessionStart, '#!/bin/bash\n');
    write(path.join(pluginRoot, 'hooks', 'hooks-manifest.json'), JSON.stringify({
      hooks: {
        SessionStart: [{ command: `bash ${sessionStart}`, required: true }],
      },
    }));

    // Write settings that have a dropped hook (sync.sh — not in manifest, file missing)
    const deadHookPath = path.join(pluginRoot, 'hooks', 'sync.sh');
    const settings = {
      hooks: {
        SessionStart: [{
          matcher: '',
          hooks: [
            { type: 'command', command: `bash ${sessionStart}` },
            { type: 'command', command: `bash ${deadHookPath}` },
          ],
        }],
      },
    };
    write(path.join(tmpHome, '.claude', 'settings.json'), JSON.stringify(settings));

    const result = reconcileHooks();
    expect(result.pruned).toBe(1);

    const written = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude', 'settings.json'), 'utf8'));
    expect(written.hooks.SessionStart[0].hooks).toHaveLength(1);
    expect(written.hooks.SessionStart[0].hooks[0].command).toBe(`bash ${sessionStart}`);
  });
});
