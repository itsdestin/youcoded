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
  it('fills in every permission override the file leaves out', () => {
    fs.writeFileSync(defaultsFile, JSON.stringify({ model: 'opus', permissionOverrides: { approveAll: true } }));
    const d = readDefaults(defaultsFile);
    expect(d.model).toBe('opus');
    expect(d.projectFolder).toBe('');
    expect(d.permissionOverrides).toEqual({ ...PERMISSION_OVERRIDES_DEFAULT, approveAll: true });
  });

  it('answers the built-in defaults when there is no file', () => {
    expect(readDefaults(defaultsFile)).toEqual({
      skipPermissions: false, model: 'sonnet', projectFolder: '', permissionOverrides: { ...PERMISSION_OVERRIDES_DEFAULT },
    });
  });

  it('a save merges into the saved overrides instead of replacing them', () => {
    fs.writeFileSync(defaultsFile, JSON.stringify({ permissionOverrides: { approveAll: true } }));
    const merged = writeDefaults({ permissionOverrides: { protectedDirectories: true } }, defaultsFile);
    expect(merged!.permissionOverrides).toMatchObject({ approveAll: true, protectedDirectories: true });
    expect(JSON.parse(fs.readFileSync(defaultsFile, 'utf-8')).permissionOverrides)
      .toMatchObject({ approveAll: true, protectedDirectories: true });
  });

  it('a save refreshes what the app enforces, not only the file', () => {
    const sink = vi.fn();
    setPermissionOverridesSink(sink);
    writeDefaults({ permissionOverrides: { approveAll: true } }, defaultsFile);
    expect(sink).toHaveBeenLastCalledWith(expect.objectContaining({ approveAll: true }));
  });

  it('a save that cannot be written answers null', () => {
    fs.mkdirSync(defaultsFile);                  // a directory where the file should be
    expect(writeDefaults({ model: 'opus' }, defaultsFile)).toBeNull();
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
