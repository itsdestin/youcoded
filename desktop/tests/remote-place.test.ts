// Remote access batch 2, design §3/§4 (T4), contract R2 and R5: where a phone
// opens. The rules live in state/remote-place.ts as pure functions because App
// cannot be mounted in a unit test; App's use of them is pinned separately
// (remote-place-app-wiring.test.ts).
import { describe, it, expect } from 'vitest';
import {
  remotePlaceHostId,
  readRemotePlace,
  writeRemotePlace,
  choosePlaceOnHydrate,
  chooseAfterDestroyed,
  shouldLoadFirstPage,
} from '../src/renderer/state/remote-place';

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

describe('which host a stored place belongs to', () => {
  it('the paired target\'s host:port when the Android app stored one', () => {
    expect(remotePlaceHostId('ws://100.64.0.5:9900/ws', 'localhost')).toBe('100.64.0.5:9900');
  });
  it('the page\'s own host when a phone browser has no stored target', () => {
    expect(remotePlaceHostId(null, 'desk.tail1234.ts.net:9900')).toBe('desk.tail1234.ts.net:9900');
  });
  it('a target that cannot be parsed falls back to the page\'s host', () => {
    expect(remotePlaceHostId('not a url', 'desk:9900')).toBe('desk:9900');
  });
});

describe('the stored place is per tab, with a per-host reload fallback', () => {
  it('two tabs keep separate places; a fresh tab gets the last one written', () => {
    const local = memoryStorage();
    const tabA = { session: memoryStorage(), local };
    const tabB = { session: memoryStorage(), local };
    writeRemotePlace(tabA, 'desk:9900', 's1');
    writeRemotePlace(tabB, 'desk:9900', 's2');
    expect(readRemotePlace(tabA, 'desk:9900')).toBe('s1');
    expect(readRemotePlace(tabB, 'desk:9900')).toBe('s2');
    expect(readRemotePlace({ session: memoryStorage(), local }, 'desk:9900')).toBe('s2');
  });

  it('a place on one host is not the place on another', () => {
    const tab = { session: memoryStorage(), local: memoryStorage() };
    writeRemotePlace(tab, '100.64.0.5:9900', 's1');
    expect(readRemotePlace(tab, 'other:9900')).toBeNull();
  });

  it('storage that throws (a private window) reads as no place and writes nothing', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
    const tab = { session: broken, local: broken };
    expect(() => writeRemotePlace(tab, 'h', 's1')).not.toThrow();
    expect(readRemotePlace(tab, 'h')).toBeNull();
  });
});

describe('where the phone opens when its copy arrives', () => {
  it('first connect: the session the desktop is showing', () => {
    expect(choosePlaceOnHydrate({ stored: null, existingSessionIds: ['s1', 's2'], focusSessionId: 's2' })).toBe('s2');
  });
  it('reconnect with a stored place that still exists keeps it', () => {
    expect(choosePlaceOnHydrate({ stored: 's1', existingSessionIds: ['s1', 's2'], focusSessionId: 's2' })).toBe('s1');
  });
  it('stored place gone: the desktop\'s focus', () => {
    expect(choosePlaceOnHydrate({ stored: 'gone', existingSessionIds: ['s1', 's2'], focusSessionId: 's2' })).toBe('s2');
  });
  it('no usable focus: the first session', () => {
    expect(choosePlaceOnHydrate({ stored: null, existingSessionIds: ['s1', 's2'], focusSessionId: 'gone' })).toBe('s1');
    expect(choosePlaceOnHydrate({ stored: null, existingSessionIds: ['s1'], focusSessionId: null })).toBe('s1');
  });
  it('no sessions at all: nothing', () => {
    expect(choosePlaceOnHydrate({ stored: 's1', existingSessionIds: [], focusSessionId: 's2' })).toBeNull();
  });
});

describe('when the conversation on screen goes away', () => {
  it('another session going away changes nothing', () => {
    expect(chooseAfterDestroyed({ destroyedId: 's9', currentId: 's1', remainingIds: ['s1', 's2'], focusSessionId: 's2' })).toBe('s1');
  });
  it('the desktop\'s focus when it names a remaining session', () => {
    expect(chooseAfterDestroyed({ destroyedId: 's1', currentId: 's1', remainingIds: ['s2', 's3'], focusSessionId: 's3' })).toBe('s3');
  });
  it('the first remaining when the focus IS the destroyed session', () => {
    expect(chooseAfterDestroyed({ destroyedId: 's1', currentId: 's1', remainingIds: ['s2', 's3'], focusSessionId: 's1' })).toBe('s2');
  });
  it('nothing remaining: nothing', () => {
    expect(chooseAfterDestroyed({ destroyedId: 's1', currentId: 's1', remainingIds: [], focusSessionId: null })).toBeNull();
  });
});

describe('the computer\'s copy is the only source', () => {
  it('a remote client waits for its copy before asking for any first page', () => {
    expect(shouldLoadFirstPage({ remote: true, placeDecided: false, hydrated: false })).toBe(false);
  });
  it('a session the copy delivered never loads its own first page', () => {
    expect(shouldLoadFirstPage({ remote: true, placeDecided: true, hydrated: true })).toBe(false);
  });
  it('a session created after the copy — or one an incomplete first copy omitted — loads its first page', () => {
    expect(shouldLoadFirstPage({ remote: true, placeDecided: true, hydrated: false })).toBe(true);
  });
  it('the desktop is unaffected', () => {
    expect(shouldLoadFirstPage({ remote: false, placeDecided: false, hydrated: false })).toBe(true);
  });
});
