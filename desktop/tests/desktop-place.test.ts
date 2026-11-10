// Card #146: after a window reloads it must reopen the chat it was on. Rules live in
// state/desktop-place.ts as pure functions (App cannot be mounted in a unit test).
import { describe, it, expect } from 'vitest';
import { readDesktopPlace, writeDesktopPlace, chooseDesktopPlace } from '../src/renderer/state/desktop-place';

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}
const throwing = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
  removeItem: () => { throw new Error('blocked'); },
};

describe('desktop place storage', () => {
  it('remembers what was written', () => {
    const s = memoryStorage();
    writeDesktopPlace(s, 'a');
    expect(readDesktopPlace(s)).toBe('a');
  });
  it('reads nothing when empty', () => {
    expect(readDesktopPlace(memoryStorage())).toBeNull();
  });
  it('writing null forgets the place', () => {
    const s = memoryStorage();
    writeDesktopPlace(s, 'a');
    writeDesktopPlace(s, null);
    expect(readDesktopPlace(s)).toBeNull();
  });
  it('two separate storages (two windows) do not share a place', () => {
    const w1 = memoryStorage(), w2 = memoryStorage();
    writeDesktopPlace(w1, 'a');
    writeDesktopPlace(w2, 'b');
    expect(readDesktopPlace(w1)).toBe('a');
    expect(readDesktopPlace(w2)).toBe('b');
  });
  it('storage that throws reads as no place and never throws', () => {
    expect(readDesktopPlace(throwing)).toBeNull();
    expect(() => writeDesktopPlace(throwing, 'a')).not.toThrow();
  });
});

describe('which chat a desktop window opens on', () => {
  it('the saved chat when it is still in this window', () => {
    expect(chooseDesktopPlace({ stored: 'b', ownedSessionIds: ['a', 'b'], mayAutoSelect: true })).toBe('b');
  });
  it('the first chat when the saved one is gone', () => {
    expect(chooseDesktopPlace({ stored: 'x', ownedSessionIds: ['a', 'b'], mayAutoSelect: true })).toBe('a');
  });
  it('the first chat when nothing was saved', () => {
    expect(chooseDesktopPlace({ stored: null, ownedSessionIds: ['a', 'b'], mayAutoSelect: true })).toBe('a');
  });
  it('nothing when auto-selecting is not allowed, even with a saved chat', () => {
    expect(chooseDesktopPlace({ stored: 'b', ownedSessionIds: ['a', 'b'], mayAutoSelect: false })).toBeNull();
  });
  it('nothing when the window owns no chats', () => {
    expect(chooseDesktopPlace({ stored: 'b', ownedSessionIds: [], mayAutoSelect: true })).toBeNull();
  });
});
