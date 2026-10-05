// What the window-moving handlers DO (main/ipc/detach.ts): hand a conversation to another window, adopt a drag that
// landed, and find which window a drop landed on.
//
// WHY (R4-1, a leftover from the R3-8 review): these bodies moved out of main.ts into the channel table unchanged, but
// nothing exercised them, so a slip while moving them (or any later edit) would only show up as "my conversation went
// to the wrong window" on a real desktop. These tests use the real ownership registry and the real hold-until-ready
// queue, with stand-in windows that only record what they were told.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The cursor is wherever the test says. `screen` is the only part of Electron this file touches.
const cursor = { x: 500, y: 300 };
vi.mock('electron', () => ({ screen: { getCursorScreenPoint: () => ({ ...cursor }) } }));

import { WindowRegistry } from '../src/main/window-registry';
import { PendingAcquireQueue } from '../src/main/pending-acquire';
import { bindDetach, detachChannels } from '../src/main/ipc/detach';
import { IPC } from '../src/shared/backend-contract';
import { AudienceFills } from '../src/main/audience-fill';

type FakeWin = {
  id: number;
  closed: boolean;
  focused: boolean;
  sent: Array<{ channel: string; payload: any }>;
  positions: Array<[number, number]>;
  ignoreMouse: boolean[];
  js: (code: string) => Promise<any>;
  webContents: { id: number; send: (c: string, p: any) => void; once: any; executeJavaScript: (c: string) => Promise<any> };
  close(): void;
  focus(): void;
  isDestroyed(): boolean;
  setPosition(x: number, y: number): void;
  setIgnoreMouseEvents(v: boolean): void;
};

let windows: Map<number, FakeWin>;
let registry: WindowRegistry;
let pending: PendingAcquireQueue<any>;
let fills: AudienceFills;
let nextId: number;
let created: Array<{ opts: any; win: FakeWin }>;
const sessions: Record<string, any> = { s1: { id: 's1', cwd: '/p' }, s2: { id: 's2', cwd: '/q' } };

function fakeWindow(id: number): FakeWin {
  const w: FakeWin = {
    id, closed: false, focused: false, sent: [], positions: [], ignoreMouse: [],
    js: async () => false,
    webContents: {
      id,
      send: (channel, payload) => { w.sent.push({ channel, payload }); },
      once: vi.fn(),
      executeJavaScript: (code) => w.js(code),
    },
    close() { w.closed = true; },
    focus() { w.focused = true; },
    isDestroyed: () => w.closed,
    setPosition(x, y) { w.positions.push([x, y]); },
    setIgnoreMouseEvents(v) { w.ignoreMouse.push(v); },
  };
  windows.set(id, w);
  registry.registerWindow(id, id);
  return w;
}

/** Run a table entry the way the computer's door does: handler(payload, ctx). `from` is the calling window. */
function call(name: string, payload?: unknown, from = -1): any {
  const def = detachChannels.find((d) => d.name === name);
  if (!def) throw new Error(`no entry ${name}`);
  return def.handler(payload as any, { sender: { id: from } } as any);
}

beforeEach(() => {
  windows = new Map();
  registry = new WindowRegistry();
  pending = new PendingAcquireQueue();
  fills = new AudienceFills();
  nextId = 100;
  created = [];
  cursor.x = 500; cursor.y = 300;
  bindDetach({
    windowRegistry: registry,
    sessionManager: { getSession: (id: string) => sessions[id] } as any,
    pendingAcquire: pending,
    fills,
    createAppWindow: (opts) => { const win = fakeWindow(nextId++); created.push({ opts, win }); return win as any; },
    windowFromWcId: (id) => (windows.get(id) as any) ?? null,
  });
});

const acquired = (w: FakeWin) => w.sent.filter((m) => m.channel === IPC.SESSION_OWNERSHIP_ACQUIRED);
const lost = (w: FakeWin) => w.sent.filter((m) => m.channel === IPC.SESSION_OWNERSHIP_LOST);

describe('detach: dragging a conversation into a window of its own', () => {
  it('opens a new window near the cursor, moves ownership to it, and closes the source window if that left it empty', () => {
    const src = fakeWindow(1); fakeWindow(2); // a peer exists, so the emptied source may close
    registry.assignSession('s1', 1);
    call(IPC.SESSION_DETACH_START, { sessionId: 's1', screenX: 800, screenY: 400 }, 1);
    expect(created).toHaveLength(1);
    expect(created[0].opts).toMatchObject({ x: 740, y: 360, width: 900, height: 700 });
    expect(registry.getOwner('s1')).toBe(created[0].win.id);
    expect(lost(src)).toEqual([{ channel: IPC.SESSION_OWNERSHIP_LOST, payload: { sessionId: 's1' } }]);
    expect(src.closed).toBe(true);
  });

  it('holds the new window\'s pushes for the conversation from the moment it owns it, until its fill is answered', () => {
    fakeWindow(1); fakeWindow(2);
    registry.assignSession('s1', 1);
    call(IPC.SESSION_DETACH_START, { sessionId: 's1', screenX: 0, screenY: 0 }, 1);
    const fresh = created[0].win;
    // WHY (one-core R5-2): a push that reached the new window before its answer would be applied to a conversation with no history yet.
    expect(fills.filling(`w${fresh.id}`, 's1')).toBe(true);
    const got: number[] = [];
    fills.hold(`w${fresh.id}`, 's1', () => got.push(1));
    fills.release(`w${fresh.id}`, 's1');
    expect(got).toEqual([1]);
  });

  it('queues the handoff for a window that has not mounted yet, and delivers it exactly once when it pulls', () => {
    fakeWindow(1); fakeWindow(2);
    registry.assignSession('s1', 1);
    call(IPC.SESSION_DETACH_START, { sessionId: 's1', screenX: 0, screenY: 0 }, 1);
    const fresh = created[0].win;
    expect(acquired(fresh)).toEqual([]); // nothing pushed at a window that cannot listen yet
    const first = call(IPC.DETACH_CLAIM_PENDING, undefined, fresh.id);
    expect(first).toEqual([expect.objectContaining({ sessionId: 's1', freshWindow: true })]);
    expect(call(IPC.DETACH_CLAIM_PENDING, undefined, fresh.id)).toEqual([]);
  });

  it('does nothing when the caller no longer owns the session (a stale claim)', () => {
    fakeWindow(1); fakeWindow(2);
    registry.assignSession('s1', 2);
    call(IPC.SESSION_DETACH_START, { sessionId: 's1', screenX: 0, screenY: 0 }, 1);
    expect(registry.getOwner('s1')).toBe(2);
  });

  it('keeps the source window open when it still holds another conversation', () => {
    const src = fakeWindow(1); fakeWindow(2);
    registry.assignSession('s1', 1); registry.assignSession('s2', 1);
    call(IPC.SESSION_DETACH_START, { sessionId: 's1', screenX: 0, screenY: 0 }, 1);
    expect(src.closed).toBe(false);
    expect(registry.getOwner('s2')).toBe(1);
  });

  it('refuses a malformed handoff draft instead of silently dropping the text', () => {
    fakeWindow(1);
    registry.assignSession('s1', 1);
    call(IPC.WINDOW_OPEN_DETACHED, { sessionId: 's1', draft: { text: 5 } }, 1);
    expect(created).toHaveLength(0);
    expect(registry.getOwner('s1')).toBe(1);
  });

  it('carries a valid unsent draft to the new window', () => {
    fakeWindow(1);
    registry.assignSession('s1', 1);
    call(IPC.WINDOW_OPEN_DETACHED, { sessionId: 's1', draft: { text: 'hi', attachments: ['/a.png'] } }, 1);
    const fresh = created[0].win;
    const [handoff] = call(IPC.DETACH_CLAIM_PENDING, undefined, fresh.id);
    expect(handoff.sessionInfo).toMatchObject({ initialInput: 'hi', initialAttachments: ['/a.png'] });
  });
});

describe('drag-adopt: the window a drop landed on claims the conversation', () => {
  it('moves the session from its registered owner to the window that asked, pushing to a window that is already listening', () => {
    const src = fakeWindow(1); const tgt = fakeWindow(2);
    registry.assignSession('s1', 1);
    pending.claim(2); // window 2 has mounted
    call(IPC.SESSION_DRAG_ADOPT, { sessionId: 's1' }, 2);
    expect(registry.getOwner('s1')).toBe(2);
    expect(lost(src)).toHaveLength(1);
    expect(acquired(tgt)).toEqual([{ channel: IPC.SESSION_OWNERSHIP_ACQUIRED, payload: expect.objectContaining({ sessionId: 's1', freshWindow: false }) }]);
    expect(src.closed).toBe(true); // emptied, and a peer exists
  });

  it('ignores a session nobody owns (a forged message cannot create ownership)', () => {
    fakeWindow(1); fakeWindow(2);
    call(IPC.SESSION_DRAG_ADOPT, { sessionId: 's1' }, 2);
    expect(registry.getOwner('s1')).toBeUndefined();
  });

  it('ignores a window adopting what it already owns', () => {
    const w = fakeWindow(1);
    registry.assignSession('s1', 1);
    call(IPC.SESSION_DRAG_ADOPT, { sessionId: 's1' }, 1);
    expect(registry.getOwner('s1')).toBe(1);
    expect(w.sent).toEqual([]);
  });

  it('never trusts a source named in the payload: the source is whoever the registry says owns it', () => {
    fakeWindow(1); fakeWindow(2); fakeWindow(3);
    registry.assignSession('s1', 1);
    call(IPC.SESSION_DRAG_ADOPT, { sessionId: 's1', from: 3 }, 2);
    expect(registry.getOwner('s1')).toBe(2);
  });
});

describe('drop-resolve: which window did the drop land on', () => {
  it('answers with the first window whose session strip holds the cursor', async () => {
    const a = fakeWindow(1); const b = fakeWindow(2);
    a.js = async () => false;
    b.js = async () => true;
    expect(await call(IPC.SESSION_DROP_RESOLVE)).toEqual({ targetWindowId: 2 });
  });

  it('asks each window with the cursor position', async () => {
    const a = fakeWindow(1);
    const seen: string[] = [];
    a.js = async (code) => { seen.push(code); return false; };
    cursor.x = 123; cursor.y = 456;
    await call(IPC.SESSION_DROP_RESOLVE);
    expect(seen[0]).toContain('123 - window.screenX');
    expect(seen[0]).toContain('456 - window.screenY');
  });

  it('answers null when no strip holds the cursor, skipping a window that is gone or not ready', async () => {
    const a = fakeWindow(1); const b = fakeWindow(2); fakeWindow(3);
    a.closed = true;
    b.js = async () => { throw new Error('not ready'); };
    expect(await call(IPC.SESSION_DROP_RESOLVE)).toEqual({ targetWindowId: null });
  });
});

describe('live tear-off: the new window follows the cursor until release', () => {
  it('detach-live opens a click-through window, defers closing the source, and drag-ended finishes the job', () => {
    const src = fakeWindow(1); fakeWindow(2);
    registry.assignSession('s1', 1);
    const { windowId } = call(IPC.SESSION_DETACH_LIVE, { sessionId: 's1', offsetX: 10, offsetY: 5 }, 1);
    const fresh = created[0].win;
    expect(windowId).toBe(fresh.id);
    expect(created[0].opts.inactive).toBe(true);
    expect(fresh.ignoreMouse).toEqual([true]);
    expect(registry.getOwner('s1')).toBe(fresh.id);
    expect(src.closed).toBe(false); // closing mid-drag would kill the pointer-up that ends it
    call(IPC.SESSION_DRAG_WINDOW_MOVE);
    expect(fresh.positions.at(-1)).toEqual([500 - 96 - 10, 300 - 12 - 5]);
    call(IPC.SESSION_DRAG_ENDED);
    expect(fresh.ignoreMouse).toEqual([true, false]);
    expect(fresh.focused).toBe(true);
    expect(src.closed).toBe(true);
    call(IPC.SESSION_DRAG_WINDOW_MOVE); // the drag is over: no further following
    expect(fresh.positions).toHaveLength(1);
  });

  it('drag-dropped on another window hands the session over without a new window', () => {
    const src = fakeWindow(1); const tgt = fakeWindow(2);
    registry.assignSession('s1', 1);
    pending.claim(2);
    call(IPC.SESSION_DRAG_DROPPED, { sessionId: 's1', targetWindowId: 2, insertIndex: 0 }, 1);
    expect(created).toHaveLength(0);
    expect(registry.getOwner('s1')).toBe(2);
    expect(acquired(tgt)).toHaveLength(1);
    expect(src.closed).toBe(true);
  });

  it('focus-and-switch focuses the window and tells it to switch, only when both exist', () => {
    const w = fakeWindow(1);
    call(IPC.WINDOW_FOCUS_AND_SWITCH, { windowId: 1, sessionId: 's1' });
    expect(w.focused).toBe(true);
    expect(acquired(w)[0].payload).toMatchObject({ sessionId: 's1', refocusOnly: true, freshWindow: false });
    const w2 = fakeWindow(2);
    call(IPC.WINDOW_FOCUS_AND_SWITCH, { windowId: 2, sessionId: 'nope' });
    expect(w2.focused).toBe(false);
  });
});
