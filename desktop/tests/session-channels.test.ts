// The session, session-naming and transcript channels that moved into the channel table (one-core R3-4).
// The generic checks in channel-table-families.test.ts already prove every entry runs ONE handler for both
// doors and that no hand-written copy is left behind; the meta / browse / create behaviour is pinned in
// remote-server.test.ts and ipc-handlers.test.ts. This file pins what those cannot see: who may call
// what, the two hot channels, and the places the two doors legitimately differ.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { IPC } from '../src/shared/backend-contract';
import { CHANNEL_TABLE, findChannel, registerDesktopChannels, serveRemoteChannel } from '../src/main/ipc/channel-table';
import { bindSessionOps } from '../src/main/ipc/session';

const FAMILY = /^(session|session-naming|transcript):/;
// Not part of THIS family's count: the drag / detach messages are computer-window plumbing, table entries of their own
// (main/ipc/detach.ts; pinned in last-channels.test.ts);
// the ownership and attention messages are pushes, which are never entries.
const NOT_YET = new Set<string>([
  IPC.SESSION_DETACH_START, IPC.SESSION_DETACH_LIVE,
  IPC.SESSION_DRAG_WINDOW_MOVE, IPC.SESSION_DRAG_STARTED, IPC.SESSION_DRAG_ENDED, IPC.SESSION_DRAG_DROPPED,
  IPC.SESSION_DRAG_ADOPT, IPC.SESSION_DROP_RESOLVE, IPC.SESSION_FOCUS_REQUEST, IPC.SESSION_ATTENTION_SUMMARY,
  IPC.SESSION_OWNERSHIP_ACQUIRED, IPC.SESSION_OWNERSHIP_LOST, IPC.CROSS_WINDOW_CURSOR,
]);
const PUSHES = new Set<string>([
  IPC.SESSION_CREATED, IPC.SESSION_DESTROYED, IPC.SESSION_MOVED, IPC.SESSION_RENAMED, IPC.SESSION_META_CHANGED,
  IPC.TRANSCRIPT_EVENT, IPC.TRANSCRIPT_SHRINK, IPC.SESSION_REFILL, IPC.SESSION_SUMMARY, IPC.SESSION_LIVE, IPC.SESSION_PERMISSION_MODE,
]);

const desktopCtx = (extra: any = {}): any => ({ door: 'desktop', runtime: null, broadcast: () => {}, ...extra });
const phoneCtx: any = { door: 'remote', runtime: null, broadcast: () => {} };

afterEach(() => bindSessionOps(null));

describe('session channels: what is in the table and who may call it', () => {
  it('every session, naming and transcript request name in the contract has an entry, except the desktop window plumbing left for its own group', () => {
    const inTable = new Set(CHANNEL_TABLE.map((d) => d.name));
    const names = Object.values(IPC).filter((v) => FAMILY.test(v) && !PUSHES.has(v) && !NOT_YET.has(v));
    // 23 = create destroy list selected switch input resize terminal-ready menu-lock browse history read-meta
    //      page open unwatch prompt-report set-flag set-tag set-note get-meta reopen-list forget-reopen + 4 naming; a new one must be decided here.
    expect(names.length).toBe(26);
    expect(names.filter((n) => !inTable.has(n))).toEqual([]);
  });

  it('a phone may use exactly what it could before; set-flag stays refused and the window-only ones stay computer-only', () => {
    const entries = CHANNEL_TABLE.filter((d) => FAMILY.test(d.name) && !NOT_YET.has(d.name));
    const refused = entries.filter((d) => d.desktopOnly || d.remoteAllowed === false).map((d) => d.name).sort();
    expect(refused).toEqual(['session:forget-reopen', 'session:prompt-report', 'session:reopen-list', 'session:selected', 'session:set-flag', 'session:terminal-ready']);
  });

  it('a phone asking for the refused ones gets what it always got: an empty answer, silence, or the standard refusal', async () => {
    const answer = async (name: string) => serveRemoteChannel(findChannel(name)!, {}, phoneCtx);
    expect(await answer('session:reopen-list')).toEqual({ reply: true, payload: [] });
    expect(await answer('session:forget-reopen')).toEqual({ reply: true, payload: { ok: true } });
    expect(await answer('session:selected')).toEqual({ reply: false });
    expect(await answer('session:terminal-ready')).toEqual({ reply: false });
    expect(await answer('session:set-flag')).toEqual({
      reply: true, payload: { ok: false, error: "This feature isn't available over remote access yet (session:set-flag).", unsupported: true },
    });
  });
});

describe('the terminal channels run at typing speed and gain no overhead', () => {
  it('the computer\'s door calls session:input straight through: the write has happened before any other work runs', () => {
    const sendInput = vi.fn();
    bindSessionOps({ sessionManager: { sendInput } } as any);
    const listeners = new Map<string, (...a: any[]) => void>();
    registerDesktopChannels({ handle: vi.fn(), on: (c: string, l: any) => listeners.set(c, l) }, () => null, () => {});
    listeners.get('session:input')!({ sender: { id: 1 } }, { sessionId: 's1', text: 'a' });
    // No await between the call and the check: the old wrapper deferred it behind a promise.
    expect(sendInput).toHaveBeenCalledWith('s1', 'a');
  });

  it('keystrokes and resizes keep their order, and a failing one is warned about, never thrown into the main process', async () => {
    const calls: string[] = [];
    bindSessionOps({ sessionManager: { sendInput: (_s: string, t: string) => { calls.push(t); if (t === 'boom') throw new Error('pty gone'); }, resizeSession: (_s: string, c: number) => { calls.push(`resize${c}`); } } } as any);
    const listeners = new Map<string, (...a: any[]) => void>();
    registerDesktopChannels({ handle: vi.fn(), on: (c: string, l: any) => listeners.set(c, l) }, () => null, () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const input = listeners.get('session:input')!; const resize = listeners.get('session:resize')!;
      input({}, { sessionId: 's', text: 'a' }); resize({}, { sessionId: 's', cols: 80, rows: 24 }); input({}, { sessionId: 's', text: 'boom' }); input({}, { sessionId: 's', text: 'b' });
      expect(calls).toEqual(['a', 'resize80', 'boom', 'b']);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  it('a phone\'s keystroke reaches the same session manager call, with no answer sent', async () => {
    const sendInput = vi.fn();
    bindSessionOps({ sessionManager: { sendInput } } as any);
    const out = serveRemoteChannel(findChannel('session:input')!, { sessionId: 's1', text: 'x' }, phoneCtx);
    expect(sendInput).toHaveBeenCalledWith('s1', 'x'); // synchronously, before the returned promise settles
    expect(await out).toEqual({ reply: false });
  });
});

describe('session:list: the computer\'s window sees its own sessions, a phone sees them all', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const bind = () => bindSessionOps({
    sessionManager: { listSessions: () => rows },
    stampProviderTypes: async (r: any[]) => r.map((x) => ({ ...x, providerType: 'stamped' })),
    // window 1 owns a, window 2 owns b, c has no owner yet (a phone started it); window 1 is the primary.
    windowRegistry: { getLeaderId: () => 1, getOwner: (id: string) => ({ a: 1, b: 2 } as any)[id] },
  } as any);
  it('a window gets its own sessions (and the ownerless ones only if it is the primary window)', async () => {
    bind();
    const list = findChannel('session:list')!;
    expect((await list.handler(undefined, desktopCtx({ windowId: 1 }))).map((r: any) => r.id)).toEqual(['a', 'c']);
    expect((await list.handler(undefined, desktopCtx({ windowId: 2 }))).map((r: any) => r.id)).toEqual(['b']);
  });
  it('a phone gets every session, each stamped with its provider type like the computer\'s', async () => {
    bind();
    const out = await serveRemoteChannel(findChannel('session:list')!, undefined, phoneCtx);
    expect(out).toEqual({ reply: true, payload: rows.map((r) => ({ ...r, providerType: 'stamped' })) });
  });
});

describe('transcript:page: one entry, one body', () => {
  it('a window and a phone are asked through the SAME body (a page depends on the session, not on who asks)', async () => {
    const transcriptPage = vi.fn(async () => ({ events: [], cursor: null, hasMore: false }));
    bindSessionOps({ transcriptPage } as any);
    const def = findChannel('transcript:page')!;
    await def.handler({ sessionId: 's1', beforeCursor: null }, desktopCtx({ windowId: 4 }));
    expect(transcriptPage).toHaveBeenCalledWith({ sessionId: 's1', beforeCursor: null });
    transcriptPage.mockClear();
    const phone = await serveRemoteChannel(def, { sessionId: 's1', beforeCursor: null, toEnd: true }, phoneCtx);
    expect(phone).toEqual({ reply: true, payload: { events: [], cursor: null, hasMore: false } });
    expect(transcriptPage).toHaveBeenCalledWith({ sessionId: 's1', beforeCursor: null, toEnd: true });
  });
});

describe('a phone-side guard is table policy, not a check buried in a handler', () => {
  it('a guard answers for the phone and the handler never runs; the computer\'s own door is not guarded', async () => {
    const handler = vi.fn(() => 'ran');
    const def: any = { name: 'x:y', kind: 'handle', handler, remoteGuard: (p: any) => (p?.bad ? { refused: true } : undefined) };
    expect(await serveRemoteChannel(def, { bad: true }, phoneCtx)).toEqual({ reply: true, payload: { refused: true } });
    expect(handler).not.toHaveBeenCalled();
    expect(await serveRemoteChannel(def, {}, phoneCtx)).toEqual({ reply: true, payload: 'ran' });
    // Registered for the computer's windows, the guard is not consulted.
    const ipc = { handle: vi.fn(), on: vi.fn() };
    const before = CHANNEL_TABLE.length;
    CHANNEL_TABLE.push(def);
    try {
      registerDesktopChannels(ipc, () => null, () => {});
      const registered = ipc.handle.mock.calls.find((c: any[]) => c[0] === 'x:y')![1];
      expect(await registered({}, { bad: true })).toBe('ran');
    } finally { CHANNEL_TABLE.length = before; }
  });

  it('session:create declares the shell refusal on the entry itself, byte for byte', () => {
    const guard = findChannel('session:create')!.remoteGuard!;
    const phoneCtx: any = { door: 'remote', runtime: null, broadcast: () => {} };
    expect(guard({ provider: 'shell', cwd: '/' }, phoneCtx)).toEqual({ ok: false, error: 'A terminal session can only be opened from the app itself.' });
    expect(guard({ provider: 'claude' }, phoneCtx)).toBeUndefined();
    expect(guard(undefined, phoneCtx)).toBeUndefined();
  });
});

// WHY (2026-09-30 one-core R3-5, review F4): the phone's socket opens before registerIpcHandlers binds the
// session operations. A call that arrives in that window waits for the bind and then runs, instead of being
// answered "Sessions are not ready yet"; with no bind it ends in that same plain sentence.
describe('a phone call that arrives before the sessions are bound waits for them', () => {
  it('runs once the bind lands, with the real answer', async () => {
    vi.useFakeTimers();
    try {
      const out = serveRemoteChannel(findChannel('session:list')!, undefined, phoneCtx);
      await vi.advanceTimersByTimeAsync(2_000);
      bindSessionOps({ sessionManager: { listSessions: () => [{ id: 'a' }] }, stampProviderTypes: async (r: any[]) => r } as any);
      expect(await out).toEqual({ reply: true, payload: [{ id: 'a' }] });
    } finally { vi.useRealTimers(); }
  });
  // WHY (2026-09-30 one-core R3-6, R3-5 review): a request queued during the boot wait whose phone has
  // disconnected by the time the bind lands must NOT run (a create would make a session nobody asked for).
  it('skips a queued request whose phone disconnected during the wait, and still runs one whose phone stayed', async () => {
    vi.useFakeTimers();
    try {
      const createSession = vi.fn(async () => ({ id: 'made' }));
      let connected = true;
      const gone = serveRemoteChannel(findChannel('session:create')!, { cwd: '/' }, { ...phoneCtx, isConnected: () => connected });
      const stayed = serveRemoteChannel(findChannel('session:create')!, { cwd: '/' }, { ...phoneCtx, isConnected: () => true });
      await vi.advanceTimersByTimeAsync(2_000);
      connected = false; // the first phone drops while waiting
      bindSessionOps({ createSession } as any);
      await gone; await stayed;
      expect(createSession).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('gives up with the plain sentence after 15 seconds (the computer own door registers after the bind, so it never waits)', async () => {
    vi.useFakeTimers();
    try {
      const out = serveRemoteChannel(findChannel('session-naming:get')!, undefined, phoneCtx);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await out).toMatchObject({ reply: true, payload: { ok: false, error: 'Sessions are not ready yet. Try again.' } });
    } finally { vi.useRealTimers(); }
  });
  it('a bound call still runs synchronously, so session:create claims its window before its first await', () => {
    const createSession = vi.fn(async () => ({ id: 'x' }));
    bindSessionOps({ createSession } as any);
    void findChannel('session:create')!.handler({ cwd: '/' }, { door: 'desktop', runtime: null, broadcast: () => {}, sender: { id: 3 } } as any);
    expect(createSession).toHaveBeenCalledTimes(1); // no await between the call and the check
  });
});
