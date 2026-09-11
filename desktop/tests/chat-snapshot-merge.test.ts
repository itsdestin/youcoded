// Remote access batch 2, design §2 (T3), contract R1: the phone's copy of a
// conversation comes from whichever desktop window holds it. The snapshot asks
// every main window at once, takes each session from its owner, omits (and
// marks degraded) any session whose owner did not answer or whose copy is still
// arriving, and names the session the desktop is showing.
//
// Drives the real request path (requestMergedChatSnapshot → per-window
// chat:export-snapshot → chat:snapshot-response over a mocked ipcMain) and the
// real WindowRegistry — ownership, transfer marks and focus are its state, not
// flags this test sets on a fake.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('events');
  return { ipcMain: new EventEmitter() };
});

import { ipcMain } from 'electron';
import { WindowRegistry } from '../src/main/window-registry';
import { requestMergedChatSnapshot } from '../src/main/chat-snapshot';

type Copy = { marker: string };
/** A renderer window: answers the export with its own copies, or never. */
function fakeWindow(copies: Record<string, Copy> | null, loadingSessionIds: string[] = []) {
  return {
    isDestroyed: () => false,
    send(channel: string, requestId: string) {
      if (channel !== 'chat:export-snapshot' || copies === null) return;
      const snapshot = { sessions: Object.entries(copies).map(([id, c]) => [id, { timeline: [c] }]) };
      (ipcMain as any).emit('chat:snapshot-response', {}, { requestId, snapshot, loadingSessionIds });
    },
  };
}

const W1 = 101;
const W2 = 102;
let registry: WindowRegistry;
let windows: Map<number, ReturnType<typeof fakeWindow>>;
let mainWindowId: number | undefined;

function ask(known: string[] = ['s1', 's2']) {
  return requestMergedChatSnapshot({
    registry,
    webContentsFor: (id) => (windows.get(id) as any) ?? null,
    fallbackWindowId: () => mainWindowId,
    knownSessionIds: () => known,
    timeoutMs: 2000,
  });
}
const markers = (snap: any) => Object.fromEntries(snap.sessions.map(([id, s]: any) => [id, s.timeline[0].marker]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  (ipcMain as any).removeAllListeners();
  registry = new WindowRegistry();
  registry.registerWindow(W1, 1);
  registry.registerWindow(W2, 2);
  mainWindowId = W1;
  windows = new Map();
});
afterEach(() => { vi.useRealTimers(); });

describe('the snapshot comes from every window, and a session from its owner', () => {
  it('two windows, session 2 owned by window 2: the merged snapshot holds window 2\'s copy', async () => {
    registry.assignSession('s1', W1);
    registry.assignSession('s2', W2);
    // Every window seeds a key for every session; only the owner's copy has the events.
    windows.set(W1, fakeWindow({ s1: { marker: 'w1-s1' }, s2: { marker: 'w1-stale-s2' } }));
    windows.set(W2, fakeWindow({ s1: { marker: 'w2-stale-s1' }, s2: { marker: 'w2-s2' } }));
    const snap = await ask();
    expect(markers(snap)).toEqual({ s1: 'w1-s1', s2: 'w2-s2' });
    expect(snap.degraded).toBeUndefined();
  });

  it('window 2 times out: session 2 is omitted and the snapshot is degraded', async () => {
    registry.assignSession('s1', W1);
    registry.assignSession('s2', W2);
    windows.set(W1, fakeWindow({ s1: { marker: 'w1-s1' }, s2: { marker: 'w1-stale-s2' } }));
    windows.set(W2, fakeWindow(null));
    const pending = ask();
    await vi.advanceTimersByTimeAsync(2000);
    const snap = await pending;
    expect(markers(snap)).toEqual({ s1: 'w1-s1' });
    expect(snap.degraded).toBe(true);
  });

  it('the first window destroyed while every owner answers: non-empty, not degraded', async () => {
    registry.assignSession('s2', W2);
    registry.unregisterWindow(W1);          // window 1 closed; main.ts's mainWindow is gone with it
    mainWindowId = undefined;
    windows.set(W2, fakeWindow({ s2: { marker: 'w2-s2' } }));
    const snap = await ask(['s2']);
    expect(markers(snap)).toEqual({ s2: 'w2-s2' });
    expect(snap.degraded).toBeUndefined();
  });

  it('an unowned session comes from the first window while it lives, then from the leader', async () => {
    windows.set(W1, fakeWindow({ s9: { marker: 'w1-s9' } }));
    windows.set(W2, fakeWindow({ s9: { marker: 'w2-s9' } }));
    expect(markers(await ask(['s9']))).toEqual({ s9: 'w1-s9' });

    mainWindowId = undefined;               // the first window's BrowserWindow is destroyed
    registry.unregisterWindow(W1);
    expect(markers(await ask(['s9']))).toEqual({ s9: 'w2-s9' });
  });

  it('a transfer gap created by moving a session and closing the emptied window makes it pending: omitted, degraded', async () => {
    registry.assignSession('s1', W1);
    registry.assignSession('s2', W2);
    // Re-dock: drag session 2's pill into window 1, and the emptied window 2 closes.
    expect(registry.transferSession('s2', W2, W1)).toBe(true);
    registry.unregisterWindow(W2);
    windows.set(W1, fakeWindow({ s1: { marker: 'w1-s1' }, s2: { marker: 'w1-partial-s2' } }));

    const during = await ask();
    expect(markers(during)).toEqual({ s1: 'w1-s1' });
    expect(during.degraded).toBe(true);

    // Window 1 reads its first page of session 2's history: the gap is closed.
    expect(registry.consumeInheritedByTransfer('s2', W1)).toBe(true);
    const after = await ask();
    expect(markers(after)).toEqual({ s1: 'w1-s1', s2: 'w1-partial-s2' });
    expect(after.degraded).toBeUndefined();
  });

  it('a session whose owner reports its history still loading is omitted, degraded', async () => {
    registry.assignSession('s1', W1);
    windows.set(W1, fakeWindow({ s1: { marker: 'w1-s1' } }, ['s1']));
    windows.set(W2, fakeWindow({}));
    const snap = await ask(['s1']);
    expect(snap.sessions).toEqual([]);
    expect(snap.degraded).toBe(true);
  });

  it('a window whose own export failed counts as not answering', async () => {
    registry.assignSession('s1', W1);
    windows.set(W1, {
      isDestroyed: () => false,
      send(channel: string, requestId: string) {
        if (channel !== 'chat:export-snapshot') return;
        (ipcMain as any).emit('chat:snapshot-response', {}, { requestId, snapshot: { sessions: [], degraded: true } });
      },
    });
    windows.set(W2, fakeWindow({ s1: { marker: 'w2-stale-s1' } }));
    const snap = await ask(['s1']);
    expect(snap.sessions).toEqual([]);
    expect(snap.degraded).toBe(true);
  });

  it('names the session the last-focused main window shows, else the leader\'s', async () => {
    windows.set(W1, fakeWindow({}));
    windows.set(W2, fakeWindow({}));
    registry.setSelectedSession(W1, 's1');
    registry.setSelectedSession(W2, 's2');
    registry.noteFocused(W2);
    expect((await ask([])).focus).toEqual({ sessionId: 's2' });

    registry.unregisterWindow(W2);
    expect((await ask([])).focus).toEqual({ sessionId: 's1' });
  });
});
