// Pins the Files tab's hidden-file rule and that the "Show hidden files" tick is remembered
// (2026-11-09 final review, Q-5: "Everywhere, remembered").
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isHiddenPath, readStoredShowHidden, storeShowHidden } from '../src/renderer/components/project-view/hidden-files';

describe('hidden files', () => {
  // This suite's environment has no storage of its own, so each test gets a small in-memory one.
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('treats dot-named files and anything inside a dot-named folder as hidden', () => {
    expect(isHiddenPath('.gitignore')).toBe(true);
    expect(isHiddenPath('.claude/settings.json')).toBe(true);
    expect(isHiddenPath('src\\.cache\\x.txt')).toBe(true);
    expect(isHiddenPath('notes.txt')).toBe(false);
    expect(isHiddenPath('a/../b.txt')).toBe(false);
  });

  it('starts unticked, and remembers a tick until it is removed', () => {
    expect(readStoredShowHidden()).toBe(false);
    storeShowHidden(true);
    expect(readStoredShowHidden()).toBe(true);
    storeShowHidden(false);
    expect(readStoredShowHidden()).toBe(false);
  });

  it('stays unticked, without failing, where storage is blocked', () => {
    const blocked = () => { throw new Error('blocked'); };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
    expect(readStoredShowHidden()).toBe(false);
    expect(() => storeShowHidden(true)).not.toThrow();
  });
});
