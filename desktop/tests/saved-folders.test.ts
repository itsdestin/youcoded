import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readFolders, writeFolders, updateFolderPath } from '../src/main/saved-folders';

let tmp: string;
let file: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-folders-'));
  file = path.join(tmp, 'youcoded-folders.json');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

// WHY (card #151 item 4): updateFolderPath finds its entry through pathKey — case-blind on
// Windows/macOS only. Platform stubbed so each OS's CI checks all three.
describe('updateFolderPath with a differently-cased old path', () => {
  const realPlatform = process.platform;
  afterEach(() => Object.defineProperty(process, 'platform', { value: realPlatform }));
  for (const [platform, matches] of [['win32', true], ['darwin', true], ['linux', false]] as const) {
    it(`${platform}: ${matches ? 'matches' : 'does not match'}`, () => {
      Object.defineProperty(process, 'platform', { value: platform });
      writeFolders([{ path: path.join(tmp, 'Docs'), nickname: 'd', addedAt: 1 }], file);
      expect(updateFolderPath(path.join(tmp, 'docs'), path.join(tmp, 'moved'), file)).toBe(matches);
    });
  }
});

describe('saved-folders store', () => {
  it('readFolders returns [] for a missing file', () => {
    expect(readFolders(file)).toEqual([]);
  });

  it('readFolders returns [] for corrupt JSON', () => {
    fs.writeFileSync(file, '{nope');
    expect(readFolders(file)).toEqual([]);
  });

  it('write/read round-trips entries', () => {
    const entries = [{ path: 'C:\\proj', nickname: 'Proj', addedAt: 123 }];
    writeFolders(entries, file);
    expect(readFolders(file)).toEqual(entries);
  });

  it('updateFolderPath rewrites the matching entry, preserving nickname and addedAt', () => {
    writeFolders([
      { path: path.join(tmp, 'old'), nickname: 'Budget', addedAt: 42 },
      { path: path.join(tmp, 'other'), nickname: 'Other', addedAt: 7 },
    ], file);
    const ok = updateFolderPath(path.join(tmp, 'old'), path.join(tmp, 'new'), file);
    expect(ok).toBe(true);
    const after = readFolders(file);
    expect(after[0]).toEqual({ path: path.join(tmp, 'new'), nickname: 'Budget', addedAt: 42 });
    expect(after[1].path).toBe(path.join(tmp, 'other'));
  });

  it('updateFolderPath returns false when no entry matches', () => {
    writeFolders([{ path: path.join(tmp, 'a'), nickname: 'A', addedAt: 1 }], file);
    expect(updateFolderPath(path.join(tmp, 'zzz'), path.join(tmp, 'new'), file)).toBe(false);
  });
});
