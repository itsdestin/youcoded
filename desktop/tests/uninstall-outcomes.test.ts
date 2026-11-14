// Card #134 round 4: an uninstall only FAILS when a delete was attempted and the folder is still there afterwards.
// A refused id, or a folder that is already gone, clears the entry as before (no false "could not be removed").
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const reg = vi.hoisted(() => ({ root: '', unregister: vi.fn(async () => {}) }));
vi.mock('../src/main/claude-code-registry', async (orig) => {
  const real = await orig<typeof import('../src/main/claude-code-registry')>();
  const root = (await import('fs')).mkdtempSync((await import('path')).join((await import('os')).tmpdir(), 'uninst-'));
  reg.root = root;
  return {
    ...real,
    YOUCODED_PLUGINS_DIR: (await import('path')).join(root, 'plugins'),
    pluginInstallDir: (id: string) => (reg.root ? (require('path') as typeof path).join(reg.root, 'plugins', id) : id),
    unregisterPluginInstall: reg.unregister,
  };
});
vi.mock('../src/main/logger', () => ({ log: vi.fn() }));

import { uninstallPlugin } from '../src/main/plugin-installer';

let plugins: string;
beforeEach(() => { plugins = path.join(reg.root, 'plugins'); fs.mkdirSync(plugins, { recursive: true }); reg.unregister.mockClear(); reg.unregister.mockResolvedValue(undefined); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(plugins, { recursive: true, force: true }); });

describe('uninstallPlugin outcomes', () => {
  it('removes the folder and says ok', async () => {
    fs.mkdirSync(path.join(plugins, 'tidy')); fs.writeFileSync(path.join(plugins, 'tidy', 'a'), 'x');
    expect(await uninstallPlugin('tidy')).toEqual({ ok: true });
    expect(fs.existsSync(path.join(plugins, 'tidy'))).toBe(false);
  });
  it('a refused id (a "." in it) is not a delete failure', async () => {
    const r = await uninstallPlugin('my.plugin');
    expect(r).toEqual({ ok: false, reason: 'id-refused' });
  });
  it('a folder that is already gone is ok', async () => {
    expect(await uninstallPlugin('never-here')).toEqual({ ok: true });
  });
  it('a delete that throws but leaves the folder is a delete-failed, saying whether Claude Code already let go', async () => {
    fs.mkdirSync(path.join(plugins, 'stuck'));
    vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw new Error('EBUSY: resource busy'); });
    const r = await uninstallPlugin('stuck');
    expect(r).toMatchObject({ ok: false, reason: 'delete-failed', unregistered: true });
    expect((r as any).detail).toContain('EBUSY');
    reg.unregister.mockRejectedValue(new Error('x'));
    expect(await uninstallPlugin('stuck')).toMatchObject({ reason: 'delete-failed', unregistered: false });
  });
  it('a delete that throws but whose folder is gone anyway is ok', async () => {
    vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw new Error('ENOENT late'); });
    expect(await uninstallPlugin('ghost')).toEqual({ ok: true });
  });
});
