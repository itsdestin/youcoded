// Card #146: after a window reloads it must reopen the chat it was on. Rules live in
// state/desktop-place.ts as pure functions (App cannot be mounted in a unit test).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readDesktopPlace, writeDesktopPlace, chooseDesktopPlace, chooseDesktopPlaceFromList } from '../src/renderer/state/desktop-place';

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

// WHY (invariant): the save effect must never run with "list loaded" true while the restored chat is
// still null, or it would erase the saved place before it is restored. React batches both updates
// only when they are made in the same synchronous block, so this pins that setSessionListLoaded(true)
// and the restoring setSessionId stay in the one session.list().then callback with no await between.
describe('App keeps the loaded flag and the place restore in one block', () => {
  const src = readFileSync(path.resolve(__dirname, '../src/renderer/App.tsx'), 'utf8');
  it('setSessionListLoaded(true) and chooseDesktopPlaceFromList share one callback with no await between', () => {
    const loadedAt = src.indexOf('setSessionListLoaded(true)');
    const restoreAt = src.indexOf('chooseDesktopPlaceFromList(list');
    expect(loadedAt).toBeGreaterThan(0);
    expect(restoreAt).toBeGreaterThan(loadedAt);
    const between = src.slice(loadedAt, restoreAt);
    expect(between).not.toMatch(/\bawait\b|setTimeout|queueMicrotask/);
    expect(src.lastIndexOf('window.claude.session.list().then', loadedAt)).toBeGreaterThan(loadedAt - 800);
  });
  it('picks from a list by id, reading this window storage', () => {
    (globalThis as any).window = { sessionStorage: memoryStorage() };
    writeDesktopPlace((globalThis as any).window.sessionStorage, 'b');
    expect(chooseDesktopPlaceFromList([{ id: 'a' }, { id: 'b' }], true)).toBe('b');
    delete (globalThis as any).window;
  });
});
