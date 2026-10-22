// The session-defaults and game-preference files, read and written the same way whether
// the request came from a desktop window or a remote device (src/main/prefs-service.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readDefaults, writeDefaults, setPermissionOverridesSink,
  getFavorites, setFavorites, getIncognito, setIncognito,
} from '../src/main/prefs-service';
import { PERMISSION_OVERRIDES_DEFAULT } from '../src/shared/types';

let dir: string;
let defaultsFile: string;
let gameFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-service-'));
  defaultsFile = path.join(dir, 'youcoded-defaults.json');
  gameFile = path.join(dir, 'youcoded-favorites.json');
});
afterEach(() => {
  setPermissionOverridesSink(() => {});
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('session defaults', () => {
  it('fills in every permission override the file leaves out', async () => {
    fs.writeFileSync(defaultsFile, JSON.stringify({ model: 'opus', permissionOverrides: { approveAll: true } }));
    const d = await readDefaults(defaultsFile);
    expect(d.model).toBe('opus');
    expect(d.projectFolder).toBe('');
    expect(d.permissionOverrides).toEqual({ ...PERMISSION_OVERRIDES_DEFAULT, approveAll: true });
  });

  it('answers the built-in defaults when there is no file', async () => {
    expect(await readDefaults(defaultsFile)).toEqual({
      skipPermissions: false, model: 'sonnet', projectFolder: '', permissionOverrides: { ...PERMISSION_OVERRIDES_DEFAULT },
    });
  });

  it('a save merges into the saved overrides instead of replacing them', async () => {
    fs.writeFileSync(defaultsFile, JSON.stringify({ permissionOverrides: { approveAll: true } }));
    const merged = await writeDefaults({ permissionOverrides: { protectedDirectories: true } }, defaultsFile);
    expect(merged!.permissionOverrides).toMatchObject({ approveAll: true, protectedDirectories: true });
    expect(JSON.parse(fs.readFileSync(defaultsFile, 'utf-8')).permissionOverrides)
      .toMatchObject({ approveAll: true, protectedDirectories: true });
  });

  it('a save refreshes what the app enforces, not only the file', async () => {
    const sink = vi.fn();
    setPermissionOverridesSink(sink);
    await writeDefaults({ permissionOverrides: { approveAll: true } }, defaultsFile);
    expect(sink).toHaveBeenLastCalledWith(expect.objectContaining({ approveAll: true }));
  });

  it('a save that cannot be written answers null', async () => {
    fs.mkdirSync(defaultsFile);                  // a directory where the file should be
    expect(await writeDefaults({ model: 'opus' }, defaultsFile)).toBeNull();
  });

  // The read is cached; these pin that the cache can never show a stale value.
  it('a read after a save sees the save (cache invalidated on write)', async () => {
    fs.writeFileSync(defaultsFile, JSON.stringify({ model: 'opus' }));
    expect((await readDefaults(defaultsFile)).model).toBe('opus');   // primes the cache
    await writeDefaults({ model: 'haiku' }, defaultsFile);
    expect((await readDefaults(defaultsFile)).model).toBe('haiku');
  });

  it('a read sees a change made by another writer (cache validated against the file)', async () => {
    fs.writeFileSync(defaultsFile, JSON.stringify({ model: 'opus' }));
    await readDefaults(defaultsFile);
    fs.writeFileSync(defaultsFile, JSON.stringify({ model: 'sonnet-but-longer' }));
    expect((await readDefaults(defaultsFile)).model).toBe('sonnet-but-longer');
  });

  it('a caller changing a result cannot corrupt the cache', async () => {
    fs.writeFileSync(defaultsFile, JSON.stringify({ model: 'opus' }));
    const first = await readDefaults(defaultsFile);
    first.model = 'tampered'; first.permissionOverrides.approveAll = true;
    const second = await readDefaults(defaultsFile);
    expect(second.model).toBe('opus');
    expect(second.permissionOverrides.approveAll).toBe(PERMISSION_OVERRIDES_DEFAULT.approveAll);
  });

  it('overlapping saves both land (none drops the other\'s keys)', async () => {
    await Promise.all([
      writeDefaults({ model: 'opus' }, defaultsFile),
      writeDefaults({ projectFolder: '/x' }, defaultsFile),
    ]);
    expect(JSON.parse(fs.readFileSync(defaultsFile, 'utf-8'))).toMatchObject({ model: 'opus', projectFolder: '/x' });
  });

  it('saves atomically: no temp file is left behind', async () => {
    await writeDefaults({ model: 'opus' }, defaultsFile);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp.'))).toEqual([]);
  });
});

describe('game favorites and incognito', () => {
  it('favorites come back as the list, and saving keeps the incognito choice', () => {
    expect(getFavorites(gameFile)).toEqual([]);
    expect(setIncognito(true, gameFile)).toBe(true);
    expect(setFavorites(['chess'], gameFile)).toBe(true);
    expect(getFavorites(gameFile)).toEqual(['chess']);
    expect(getIncognito(gameFile)).toBe(true);
  });
});

describe('session defaults: a slow read cannot undo a newer save', () => {
  it('a read that began before a save does not push its older overrides to the enforcement sink', async () => {
    fs.writeFileSync(defaultsFile, JSON.stringify({ permissionOverrides: { approveAll: false } }));
    const sink = vi.fn();
    setPermissionOverridesSink(sink);
    const slow = readDefaults(defaultsFile);               // starts first, finishes after the save
    await writeDefaults({ permissionOverrides: { approveAll: true } }, defaultsFile);
    await slow;
    expect(sink).toHaveBeenLastCalledWith(expect.objectContaining({ approveAll: true }));
    expect((await readDefaults(defaultsFile)).permissionOverrides.approveAll).toBe(true);
  });
});
