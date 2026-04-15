import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Stub listInstalledPluginDirs before importing symlink-cleanup (the real
// registry captures ~/.claude at module load, which breaks homedir stubs).
let pluginDirsForTest: string[] = [];
vi.mock('../src/main/claude-code-registry', () => ({
  listInstalledPluginDirs: () => pluginDirsForTest,
}));

const { cleanupOrphanSymlinks } = await import('../src/main/symlink-cleanup');

describe('cleanupOrphanSymlinks', () => {
  let tmpHome: string;
  let origHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'destincode-symlink-cleanup-'));
    origHomedir = os.homedir;
    (os as any).homedir = () => tmpHome;
    pluginDirsForTest = [];
  });

  afterEach(() => {
    (os as any).homedir = origHomedir;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  function mkdir(p: string) { fs.mkdirSync(p, { recursive: true }); }
  function write(p: string, content: string) { mkdir(path.dirname(p)); fs.writeFileSync(p, content); }
  function trySymlink(src: string, dst: string): boolean {
    mkdir(path.dirname(dst));
    try {
      fs.symlinkSync(src, dst, fs.statSync(src).isDirectory() ? 'junction' : 'file');
      return true;
    } catch {
      // On Windows without Developer Mode, symlinks may fail — skip the test in that case
      return false;
    }
  }

  it('no-ops when no plugins are installed', () => {
    const result = cleanupOrphanSymlinks();
    expect(result.removed).toBe(0);
    expect(result.scanned).toBe(0);
  });

  it('removes a broken symlink whose target is inside a plugin root', () => {
    const pluginRoot = path.join(tmpHome, '.claude', 'plugins', 'destinclaude');
    pluginDirsForTest = [pluginRoot];
    // plugin.json makes the plugin dir discoverable (test uses a stub regardless)
    write(path.join(pluginRoot, 'plugin.json'), '{"name":"destinclaude"}');

    // Create a real file inside the plugin so the symlink has a valid target at setup time,
    // then delete the target to simulate a post-decomposition orphan.
    const deletedHook = path.join(pluginRoot, 'core', 'hooks', 'sync.sh');
    write(deletedHook, '#!/bin/bash\n');
    const userHookLink = path.join(tmpHome, '.claude', 'hooks', 'sync.sh');
    if (!trySymlink(deletedHook, userHookLink)) return; // skip on Windows without Dev Mode
    fs.unlinkSync(deletedHook); // target now missing

    const result = cleanupOrphanSymlinks();
    expect(result.removed).toBe(1);
    expect(fs.existsSync(userHookLink)).toBe(false);
  });

  it('leaves a valid symlink alone', () => {
    const pluginRoot = path.join(tmpHome, '.claude', 'plugins', 'destinclaude');
    pluginDirsForTest = [pluginRoot];
    write(path.join(pluginRoot, 'plugin.json'), '{"name":"destinclaude"}');
    const liveHook = path.join(pluginRoot, 'hooks', 'session-start.sh');
    write(liveHook, '#!/bin/bash\n');
    const link = path.join(tmpHome, '.claude', 'hooks', 'session-start.sh');
    if (!trySymlink(liveHook, link)) return;

    const result = cleanupOrphanSymlinks();
    expect(result.removed).toBe(0);
    expect(fs.existsSync(link)).toBe(true);
  });

  it('leaves a broken symlink alone when its target is outside every plugin root', () => {
    const pluginRoot = path.join(tmpHome, '.claude', 'plugins', 'destinclaude');
    pluginDirsForTest = [pluginRoot];
    write(path.join(pluginRoot, 'plugin.json'), '{"name":"destinclaude"}');

    // Create a symlink under ~/.claude/hooks/ pointing outside the plugin root to a missing target
    const userTarget = path.join(tmpHome, 'custom', 'my-hook.sh');
    write(userTarget, '#!/bin/bash\n');
    const link = path.join(tmpHome, '.claude', 'hooks', 'my-hook.sh');
    if (!trySymlink(userTarget, link)) return;
    fs.unlinkSync(userTarget); // now broken, but user-owned — do not touch

    const result = cleanupOrphanSymlinks();
    expect(result.removed).toBe(0);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('leaves regular (non-symlink) files alone', () => {
    const pluginRoot = path.join(tmpHome, '.claude', 'plugins', 'destinclaude');
    pluginDirsForTest = [pluginRoot];
    write(path.join(pluginRoot, 'plugin.json'), '{"name":"destinclaude"}');

    const realFile = path.join(tmpHome, '.claude', 'hooks', 'regular.sh');
    write(realFile, '#!/bin/bash\n');

    const result = cleanupOrphanSymlinks();
    expect(result.removed).toBe(0);
    expect(fs.existsSync(realFile)).toBe(true);
  });
});
