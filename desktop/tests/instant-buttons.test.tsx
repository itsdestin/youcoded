// @vitest-environment jsdom
// Instant buttons on a phone (one-core R6-2): Stop, a permission answer, Close, Send and the permission-mode chip draw their change on the phone's
// own screen AT ONCE, marked as waiting, and then one of four things happens:
//   instant   - the change is on screen before the computer has said anything;
//   confirm   - the computer says yes (a reply, or the record's own published state): the waiting mark goes and the change stays;
//   refused   - the computer says no or errors: the change is undone and the person is told, in the computer's words (never a guessed cause);
//   dropped   - the connection drops while it is waiting: the screen WAITS, and after the reconnect's fill it keeps whatever the record shows.
// Plus: nothing is drawn twice (a stop echoed by the record, a card answered and then re-announced), nothing is ever resent, and the
// computer's own window is exactly as before.
//
// The screen half is real: the chat store and reducer, the helper, the action functions, the send path. The computer is a stand-in whose
// replies the test releases by hand, so "before the computer answered" is something a test can look at.
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { createChatStore, useChatState } from '../src/renderer/state/chat-context';
import { makeStoreWrapper } from './helpers/chat-store-harness';
import { SessionRecords } from '../src/main/session-record';
import { openSession } from '../src/main/session-open';
import { hookEventToAction } from '../src/renderer/state/hook-dispatcher';
import type { ChatAction } from '../src/renderer/state/chat-types';
import { setConnectionMode } from '../src/renderer/platform';
import { isPending, resetPendingForTests, registerPendingResume, reconcilePending, confirmPending, runPending } from '../src/renderer/state/pending-action';
import { stopTurn, answerPermission, STOP_SETTLE_MS } from '../src/renderer/state/phone-actions';
import { closeSession, setNativeModeNow, cycleClaudeModeNow } from '../src/renderer/state/phone-session-actions';
import { sendToNative, sendToClaudeCode, canDrawSendNow, CC_SEND_CHECK_MS } from '../src/renderer/state/submit-outgoing';
import { APP_NOTICE_EVENT } from '../src/renderer/utils/announce';
import StopButton from '../src/renderer/components/StopButton';
import ToolCard from '../src/renderer/components/ToolCard';

const S = 'sess-1';

/** The phone's chat screen: the real store. */
function phone() {
  const store = createChatStore();
  store.dispatch({ type: 'SESSION_INIT', sessionId: S });
  const dispatch = (a: ChatAction) => act(() => store.dispatch(a));
  const session = () => store.getSession(S);
  return { store, dispatch, session };
}

/** The same screen with real components mounted over it (the store handle works once the wrapper has mounted). */
function mounted(ui: React.ReactElement) {
  const { wrapper, store } = makeStoreWrapper([S]);
  const view = render(ui, { wrapper });
  return {
    view, store,
    dispatch: (a: ChatAction) => act(() => store.dispatch(a)),
    session: () => store.getSession(S),
  };
}

/** A reply the test releases by hand. */
function deferred<T = unknown>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const lostAnswer = () => Object.assign(new Error('Lost the connection before the computer answered.'), { outcomeUnknown: true });

let up = true;
let notices: string[] = [];
const onNotice = (e: Event) => notices.push((e as CustomEvent).detail.message);

function wire(extra: Record<string, unknown> = {}) {
  const claude: any = {
    session: {
      canSend: () => up,
      sendInput: vi.fn(),
      respondToPermission: vi.fn(),
      destroy: vi.fn(),
      list: vi.fn(async () => []),
    },
    native: { interrupt: vi.fn(), send: vi.fn(), setPermissionMode: vi.fn() },
    remote: { broadcastAction: vi.fn() },
    ...extra,
  };
  (window as any).claude = claude;
  return claude;
}

beforeEach(() => {
  up = true; notices = [];
  resetPendingForTests();
  window.addEventListener(APP_NOTICE_EVENT, onNotice);
  setConnectionMode('remote');                       // a phone (or the Android app paired to a computer)
});
afterEach(() => {
  window.removeEventListener(APP_NOTICE_EVENT, onNotice);
  setConnectionMode('local');
  resetPendingForTests();
  delete (window as any).claude;
  vi.useRealTimers();
});

// A turn in flight: the user's message, then some of the answer.
function turnRunning(p: ReturnType<typeof phone>) {
  p.dispatch({ type: 'USER_PROMPT', sessionId: S, content: 'build it', timestamp: 1 });
  p.dispatch({ type: 'TRANSCRIPT_USER_MESSAGE', sessionId: S, uuid: 'u1', text: 'build it', timestamp: 2 } as ChatAction);
  p.dispatch({ type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: S, uuid: 'a1', text: 'working on it', timestamp: 3 } as ChatAction);
}
const interrupt = (uuid = 'i1'): ChatAction => ({ type: 'TRANSCRIPT_INTERRUPT', sessionId: S, uuid, timestamp: 9, kind: 'plain' } as ChatAction);
const turnWatch = (p: ReturnType<typeof phone>) => ({ running: () => p.session().isThinking, subscribe: (cb: () => void) => p.store.subscribeSession(S, cb) });
const interruptedTurns = (p: ReturnType<typeof phone>) => [...p.session().assistantTurns.values()].filter((t: any) => t.stopReason === 'interrupted').length;

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe('Stop', () => {
  it('INSTANT: the button is marked "stopping" the moment it is pressed, before the computer has said anything, and the stop is sent exactly once', () => {
    const w = wire(); const p = phone(); turnRunning(p);
    act(() => stopTurn({ sessionId: S, provider: 'claude', turn: turnWatch(p) }));
    expect(isPending(`stop:${S}`)).toBe(true);
    expect(w.session.sendInput).toHaveBeenCalledTimes(1);
    expect(w.session.sendInput).toHaveBeenCalledWith(S, '\x1b');
    // Nothing is drawn on the timeline by the press itself: the "Interrupted" line is the transcript's, not ours.
    expect(interruptedTurns(p)).toBe(0);
    // A second press while the first is waiting does nothing (no second stop).
    act(() => stopTurn({ sessionId: S, provider: 'claude', turn: turnWatch(p) }));
    expect(w.session.sendInput).toHaveBeenCalledTimes(1);
  });

  it('INSTANT, native: the in-process interrupt is used, not an ESC byte', () => {
    const w = wire(); const p = phone(); turnRunning(p);
    act(() => stopTurn({ sessionId: S, provider: 'native', turn: turnWatch(p) }));
    expect(isPending(`stop:${S}`)).toBe(true);
    expect(w.native.interrupt).toHaveBeenCalledWith(S);
    expect(w.session.sendInput).not.toHaveBeenCalled();
  });

  it('CONFIRM + NO DOUBLE: the record\'s interrupt ends the turn and takes the mark away; replaying that same event (a reconnect) draws no second "Interrupted"', () => {
    wire(); const p = phone(); turnRunning(p);
    act(() => stopTurn({ sessionId: S, provider: 'claude', turn: turnWatch(p) }));
    p.dispatch(interrupt());
    expect(isPending(`stop:${S}`)).toBe(false);
    expect(p.session().isThinking).toBe(false);
    expect(interruptedTurns(p)).toBe(1);
    p.dispatch(interrupt());                                   // the same event played again by a resume
    expect(interruptedTurns(p)).toBe(1);
    expect(notices).toEqual([]);                               // a stop that worked says nothing
  });

  it('A turn that had already ended when Stop was pressed (its button still up) clears the mark at once, not after the wait', () => {
    wire(); const p = phone();                                     // no turn running: isThinking is false
    act(() => stopTurn({ sessionId: S, provider: 'claude', turn: turnWatch(p) }));
    expect(isPending(`stop:${S}`)).toBe(false);
  });

  it('CONFIRM: a turn that simply finished by itself while the stop was on its way also clears the mark (nothing left to stop)', () => {
    wire(); const p = phone(); turnRunning(p);
    act(() => stopTurn({ sessionId: S, provider: 'claude', turn: turnWatch(p) }));
    p.dispatch({ type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: S, uuid: 'end', timestamp: 8, stopReason: null, model: null, anthropicRequestId: null, usage: null } as ChatAction);
    expect(isPending(`stop:${S}`)).toBe(false);
  });

  it('REFUSED: nothing was sent while the connection is down: no mark is drawn, and the person is told it was not sent', () => {
    const w = wire(); const p = phone(); turnRunning(p);
    up = false;
    act(() => stopTurn({ sessionId: S, provider: 'claude', turn: turnWatch(p) }));
    expect(isPending(`stop:${S}`)).toBe(false);
    expect(w.session.sendInput).not.toHaveBeenCalled();
    expect(notices).toEqual(["Not connected — Stop wasn't sent. Press it again once you're back online."]);
  });

  it('UNDO: the turn is still running after the wait and a look at the record: the mark goes, the person is told, and Stop can be pressed again', async () => {
    vi.useFakeTimers();
    const w = wire(); const p = phone(); turnRunning(p);
    registerPendingResume(async () => {});
    act(() => stopTurn({ sessionId: S, provider: 'claude', turn: turnWatch(p) }));
    await act(async () => { await vi.advanceTimersByTimeAsync(STOP_SETTLE_MS + 10); });
    expect(isPending(`stop:${S}`)).toBe(false);
    expect(notices).toEqual(["Your computer hasn't confirmed the stop. If the assistant is still working, press Stop again."]);
    act(() => stopTurn({ sessionId: S, provider: 'claude', turn: turnWatch(p) }));
    expect(w.session.sendInput).toHaveBeenCalledTimes(2);      // a NEW press by the person, never an automatic resend
  });

  it('DROPPED, then the record says it ended: the mark stays while offline (nothing guessed), and after the reconnect\'s fill it simply goes, with nothing said', async () => {
    vi.useFakeTimers();
    wire(); const p = phone(); turnRunning(p);
    act(() => stopTurn({ sessionId: S, provider: 'claude', turn: turnWatch(p) }));
    up = false;                                                // the socket drops
    await act(async () => { await vi.advanceTimersByTimeAsync(STOP_SETTLE_MS * 3); });
    expect(isPending(`stop:${S}`)).toBe(true);                 // offline: the screen waits, it does not decide
    expect(notices).toEqual([]);
    up = true;
    p.dispatch(interrupt());                                   // the reconnect's fill plays the events it missed
    await act(async () => { await reconcilePending(); });
    expect(isPending(`stop:${S}`)).toBe(false);
    expect(interruptedTurns(p)).toBe(1);
    expect(notices).toEqual([]);
  });

  it('DROPPED, then the record says it is still running: the stop never arrived, so the mark goes and the person is told', async () => {
    vi.useFakeTimers();
    wire(); const p = phone(); turnRunning(p);
    act(() => stopTurn({ sessionId: S, provider: 'claude', turn: turnWatch(p) }));
    up = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(STOP_SETTLE_MS * 2); });
    up = true;
    await act(async () => { await reconcilePending(); });      // the fill brought nothing new: the turn is still going
    expect(isPending(`stop:${S}`)).toBe(false);
    expect(notices).toHaveLength(1);
  });

  it('THE COMPUTER\'S OWN WINDOW is unchanged: the same single write, no mark, no notice', () => {
    setConnectionMode('local');
    const w = wire(); const p = phone(); turnRunning(p);
    act(() => stopTurn({ sessionId: S, provider: 'claude', turn: turnWatch(p) }));
    expect(w.session.sendInput).toHaveBeenCalledWith(S, '\x1b');
    expect(isPending(`stop:${S}`)).toBe(false);
  });

  it('THE BUTTON draws the mark: "stopping" is disabled and busy, and goes back to a live Stop when the mark is undone', async () => {
    vi.useFakeTimers();
    wire();
    registerPendingResume(async () => {});
    const p = mounted(<StopButton sessionId={S} provider="claude" visible live />);
    turnRunning(p as any);
    const button = () => screen.getByRole('button', { name: 'Stop generating' });
    expect(button()).not.toBeDisabled();
    fireEvent.click(button());
    expect(button()).toBeDisabled();
    expect(button().getAttribute('aria-busy')).toBe('true');
    await act(async () => { await vi.advanceTimersByTimeAsync(STOP_SETTLE_MS + 10); });
    expect(button()).not.toBeDisabled();
    p.view.unmount();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe('Permission answer', () => {
  const ask = (p: ReturnType<typeof phone>, requestId = 'req-1') => {
    p.dispatch({ type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'tu', toolUseId: 'tool-1', toolName: 'Bash', toolInput: { command: 'ls' }, timestamp: 4 } as ChatAction);
    p.dispatch({ type: 'PERMISSION_REQUEST', sessionId: S, toolName: 'Bash', input: { command: 'ls' }, requestId });
  };
  const card = (p: ReturnType<typeof phone>) => p.session().toolCalls.get('tool-1')!;
  const answer = (p: ReturnType<typeof phone>, decision: object = { decision: { behavior: 'allow' } }) =>
    act(() => { answerPermission({ sessionId: S, requestId: 'req-1', decision, dispatch: p.store.dispatch, tools: () => p.session().toolCalls, broadcast: (window as any).claude.remote.broadcastAction }); });

  it('INSTANT: Yes, No and Always allow each draw the card as answered before the computer replies, and send the answer once', () => {
    for (const decision of [{ decision: { behavior: 'allow' } }, { decision: { behavior: 'deny' } }, { decision: { behavior: 'allow' }, updatedPermissions: [{ rule: 'x' }] }]) {
      resetPendingForTests();
      const w = wire(); const reply = deferred<boolean>(); w.session.respondToPermission.mockReturnValue(reply.promise);
      const p = phone(); ask(p);
      expect(card(p).status).toBe('awaiting-approval');
      answer(p, decision);
      expect(card(p).status).toBe('running');                    // no buttons: it is drawn as answered
      expect(card(p).requestId).toBeUndefined();
      expect(card(p).answerPending).toEqual({ requestId: 'req-1', inFlight: true });
      expect(w.session.respondToPermission).toHaveBeenCalledTimes(1);
      expect(w.session.respondToPermission).toHaveBeenCalledWith('req-1', decision);
      expect(w.remote.broadcastAction).not.toHaveBeenCalled();   // the other screens are told only once the computer confirmed
    }
  });

  it('CONFIRM + NO DOUBLE: the computer says yes: the mark goes, the other screens are told, and the card does not come back when the record re-announces the ask or echoes the result', async () => {
    const w = wire(); const reply = deferred<boolean>(); w.session.respondToPermission.mockReturnValue(reply.promise);
    const p = phone(); ask(p); answer(p);
    // A beat that was already in the air when the answer left: must NOT draw the card a second time.
    p.dispatch({ type: 'PERMISSION_REQUEST', sessionId: S, toolName: 'Bash', input: { command: 'ls' }, requestId: 'req-1' });
    expect(card(p).status).toBe('running');
    await act(async () => { reply.resolve(true); await Promise.resolve(); });
    expect(card(p).answerPending).toBeUndefined();
    expect(card(p).status).toBe('running');
    expect(w.remote.broadcastAction).toHaveBeenCalledWith({ type: 'PERMISSION_RESPONDED', sessionId: S, requestId: 'req-1' });
    // The record's later published state: the heartbeat of an ask that is no longer open stops, and the tool's own result lands.
    p.dispatch({ type: 'TRANSCRIPT_TOOL_RESULT', sessionId: S, uuid: 'tr', toolUseId: 'tool-1', result: 'ok', isError: false, timestamp: 5 } as ChatAction);
    expect(card(p).status).toBe('complete');
    expect([...p.session().toolCalls.values()].filter((t) => t.toolName === 'Bash')).toHaveLength(1);   // one card, never two
  });

  it('REFUSED: the computer cannot take the answer (request already closed): the card goes back, then expires the way the computer\'s own card does', async () => {
    const w = wire(); const reply = deferred<boolean>(); w.session.respondToPermission.mockReturnValue(reply.promise);
    const p = phone(); ask(p); answer(p);
    await act(async () => { reply.resolve(false); await Promise.resolve(); });
    expect(card(p).answerPending).toBeUndefined();
    expect(card(p).status).toBe('failed');                       // existing treatment: "This request closed before an answer reached it."
    expect(w.remote.broadcastAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'PERMISSION_EXPIRED', reason: 'delivery-failed' }));
  });

  it('REFUSED: the answer errors (a reply that is not a lost one): the card is put back, answerable, with the card\'s own "couldn\'t confirm" note', async () => {
    const w = wire(); const reply = deferred<boolean>(); w.session.respondToPermission.mockReturnValue(reply.promise);
    const p = phone(); ask(p); answer(p);
    await act(async () => { reply.reject(new Error('host failed')); await Promise.resolve(); });
    expect(card(p).status).toBe('awaiting-approval');
    expect(card(p).requestId).toBe('req-1');
    expect(card(p).answerUnconfirmed).toBe(true);
    expect(card(p).answerPending).toBeUndefined();
    expect(w.remote.broadcastAction).not.toHaveBeenCalled();
    // And a second try is possible: it is the person's button.
    w.session.respondToPermission.mockResolvedValue(true);
    answer(p);
    expect(w.session.respondToPermission).toHaveBeenCalledTimes(2);
  });

  it('DROPPED, the record still lists the ask as open: the answer never arrived, so the card comes back and says it could not confirm; nothing is resent', async () => {
    const w = wire(); const reply = deferred<boolean>(); w.session.respondToPermission.mockReturnValue(reply.promise);
    const p = phone(); ask(p); answer(p);
    up = false;
    await act(async () => { reply.reject(lostAnswer()); await Promise.resolve(); });
    expect(card(p).status).toBe('running');                      // waiting: still drawn as answered (the screen does not guess)
    expect(card(p).answerPending).toEqual({ requestId: 'req-1', inFlight: false });
    up = true;
    // The reconnect's fill: the record lists the ask among those still open (it is re-announced), then the fill ends.
    p.dispatch({ type: 'PERMISSION_REQUEST', sessionId: S, toolName: 'Bash', input: { command: 'ls' }, requestId: 'req-1' });
    await act(async () => { await reconcilePending(); });
    expect(card(p).status).toBe('awaiting-approval');
    expect(card(p).requestId).toBe('req-1');
    expect(card(p).answerUnconfirmed).toBe(true);
    expect(w.session.respondToPermission).toHaveBeenCalledTimes(1);   // never resent
    expect(isPending('perm:req-1')).toBe(false);
  });

  // The computer's side is the REAL record and the REAL `session:open` answer (events path: a reconnect or a timeout asks with where it got to), played into the
  // real reducer the way App's listeners play it. The events path sends NO ask events, only the list of asks still open at the end.
  function realHost() {
    const records = new SessionRecords(); records.begin(S);
    const askEvent = { type: 'PermissionRequest', sessionId: S, payload: { _requestId: 'req-1', tool_name: 'Bash', tool_input: { command: 'ls' } }, timestamp: 1 } as any;
    records.note(S, 'hook:event', askEvent);
    const have = () => ({ epoch: records.epochOf(S)!, seq: records.resume(S, null)!.headSeq });
    const deps = { records, knows: () => true, native: () => null, page: async () => ({ events: [], cursor: null, hasMore: false }) } as any;
    const replies: any[] = [];
    const resume = (p: ReturnType<typeof phone>, cursor: { epoch: string; seq: number }) => async () => {
      const reply: any = await openSession(deps, { sessionId: S, have: cursor }, { remote: true });
      replies.push(reply);
      for (const push of reply.after as Array<{ type: string; payload: any }>) {
        if (push.type === 'hook:event') { const a = hookEventToAction(push.payload); if (a) p.store.dispatch(a); }
        else if (push.type === 'hook:replay-complete') p.store.dispatch({ type: 'PERMISSION_REPLAY_COMPLETE', sessionId: S, pendingRequestIds: push.payload.pendingRequestIds });
      }
      return 'ok';
    };
    return { records, askEvent, have, resume, replies, resolve: () => records.note(S, 'hook:event', { type: 'PermissionResolved', sessionId: S, payload: { _requestId: 'req-1' }, timestamp: 2 } as any) };
  }
  /** The phone shows the ask (played from the same event) and answers it; the answer's reply is lost while the connection stays up. */
  async function answeredWithLostReply(host: ReturnType<typeof realHost>) {
    const w = wire(); const reply = deferred<boolean>(); w.session.respondToPermission.mockReturnValue(reply.promise);
    const p = phone();
    p.dispatch({ type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'tu', toolUseId: 'tool-1', toolName: 'Bash', toolInput: { command: 'ls' }, timestamp: 4 } as ChatAction);
    p.dispatch(hookEventToAction(host.askEvent)!);
    answer(p);
    await act(async () => { reply.reject(lostAnswer()); await Promise.resolve(); });
    return { w, p };
  }

  it('TIMEOUT, the computer still lists the ask (and sends no ask event on this path): the answer never arrived, so the card goes back answerable with a note, and nothing is resent', async () => {
    vi.useFakeTimers();
    const host = realHost(); const cursor = host.have();
    const { w, p } = await answeredWithLostReply(host);
    registerPendingResume(host.resume(p, cursor));
    expect(card(p).answerPending).toEqual({ requestId: 'req-1', inFlight: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(7100); });
    expect(host.replies[0].resume).toBe('events');
    expect(host.replies[0].after.some((x: any) => x.type === 'hook:event')).toBe(false);   // the list is the only evidence
    expect(card(p).status).toBe('awaiting-approval');
    expect(card(p).requestId).toBe('req-1');
    expect(card(p).answerUnconfirmed).toBe(true);
    expect(isPending('perm:req-1')).toBe(false);
    expect(w.session.respondToPermission).toHaveBeenCalledTimes(1);
  });

  it('TIMEOUT, the computer no longer lists the ask: the computer had the answer, so the mark goes, the card stays answered, no note', async () => {
    vi.useFakeTimers();
    const host = realHost(); const cursor = host.have();
    const { w, p } = await answeredWithLostReply(host);
    host.resolve();
    registerPendingResume(host.resume(p, cursor));
    await act(async () => { await vi.advanceTimersByTimeAsync(7100); });
    expect(card(p).status).toBe('running');
    expect(card(p).answerPending).toBeUndefined();
    expect(card(p).answerUnconfirmed).toBeUndefined();
    expect(w.remote.broadcastAction).toHaveBeenCalledWith({ type: 'PERMISSION_RESPONDED', sessionId: S, requestId: 'req-1' });
  });

  it('DROPPED, then the reconnect\'s fill (real host answer) lists the ask: the card goes back answerable; after the fill the mark is not "confirmed" by silence', async () => {
    const host = realHost(); const cursor = host.have();
    const { p } = await answeredWithLostReply(host);
    await act(async () => { await host.resume(p, cursor)(); await reconcilePending(); });
    expect(card(p).status).toBe('awaiting-approval');
    expect(card(p).answerUnconfirmed).toBe(true);
  });

  it('A FAILED RESUME is not confirmation: the card is asked about again, and after a few failures it goes back answerable (never left "allowed")', async () => {
    vi.useFakeTimers();
    const host = realHost();
    const { w, p } = await answeredWithLostReply(host);
    const failing = vi.fn(async () => 'failed');
    registerPendingResume(failing);
    await act(async () => { await vi.advanceTimersByTimeAsync(7000 * 4); });
    expect(failing).toHaveBeenCalledTimes(3);
    expect(card(p).status).toBe('awaiting-approval');
    expect(card(p).answerUnconfirmed).toBe(true);
    expect(w.session.respondToPermission).toHaveBeenCalledTimes(1);
  });

  it('A RESUME THAT SUCCEEDS BUT CARRIES NO LIST of open asks is not confirmation either: the mark is still there, so the card goes back answerable', async () => {
    vi.useFakeTimers();
    const host = realHost();
    const { p } = await answeredWithLostReply(host);
    registerPendingResume(async () => 'ok');                       // nothing reached the reducer
    await act(async () => { await vi.advanceTimersByTimeAsync(7000 * 4); });
    expect(card(p).status).toBe('awaiting-approval');
    expect(card(p).answerUnconfirmed).toBe(true);
  });

  it('A THROWING RESUME counts the same as a failed one', async () => {
    vi.useFakeTimers();
    const host = realHost();
    const { p } = await answeredWithLostReply(host);
    registerPendingResume(async () => { throw new Error('socket closed'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(7000 * 4); });
    expect(card(p).status).toBe('awaiting-approval');
    expect(card(p).answerUnconfirmed).toBe(true);
  });

  it('a list that names an ask while its answer is STILL on its way leaves the card answered (the reply decides)', () => {
    const w = wire(); w.session.respondToPermission.mockReturnValue(deferred<boolean>().promise);
    const p = phone(); ask(p); answer(p);
    p.dispatch({ type: 'PERMISSION_REPLAY_COMPLETE', sessionId: S, pendingRequestIds: ['req-1'] });
    expect(card(p).status).toBe('running');
    expect(card(p).answerPending?.inFlight).toBe(true);
  });

  it('THE REAL TOOL-USE arriving while the answer waits keeps the mark (the synthetic card is replaced, the pending answer travels with it)', () => {
    const w = wire(); w.session.respondToPermission.mockReturnValue(deferred<boolean>().promise);
    const p = phone();
    // The ask arrives BEFORE its tool-use (a synthetic card), is answered, then the transcript's tool-use lands.
    p.dispatch({ type: 'PERMISSION_REQUEST', sessionId: S, toolName: 'Bash', input: { command: 'ls' }, requestId: 'req-1' });
    answer(p);
    p.dispatch({ type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'tu', toolUseId: 'tool-1', toolName: 'Bash', toolInput: { command: 'ls' }, timestamp: 4 } as ChatAction);
    expect(card(p).answerPending?.requestId).toBe('req-1');
    p.dispatch({ type: 'PERMISSION_REQUEST', sessionId: S, toolName: 'Bash', input: { command: 'ls' }, requestId: 'req-1' });   // a beat
    expect(card(p).status).toBe('running');
  });

  it('an ask announced with no request id (an older shape) never matches a card that holds no pending answer', () => {
    wire(); const p = phone(); ask(p);
    expect(() => p.dispatch({ type: 'PERMISSION_REQUEST', sessionId: S, toolName: 'Bash', input: { command: 'ls' } } as any)).not.toThrow();
    expect(card(p).status).toBe('awaiting-approval');
  });

  it('THE COMPUTER\'S OWN WINDOW (and a helper\'s ask) answer the old way: nothing is taken over', () => {
    setConnectionMode('local');
    wire(); const p = phone(); ask(p);
    const taken = answerPermission({ sessionId: S, requestId: 'req-1', decision: {}, dispatch: p.store.dispatch, tools: () => p.session().toolCalls });
    expect(taken).toBe(false);
    expect(card(p).status).toBe('awaiting-approval');
  });

  it('THE CARD: pressing Yes on a phone removes the buttons at once, and shows a quiet "waiting" line only if the wait is noticeable', async () => {
    vi.useFakeTimers();
    const w = wire(); w.session.respondToPermission.mockReturnValue(deferred<boolean>().promise);
    function Harness() { const s = useChatState(S); const t = s.toolCalls.get('tool-1'); return t ? <ToolCard tool={t} sessionId={S} /> : null; }
    const p = mounted(<Harness />);
    ask(p as any);
    fireEvent.click(screen.getByRole('button', { name: /^Yes|Allow/i }));
    expect(screen.queryByRole('button', { name: /^Yes|Allow/i })).toBeNull();      // the buttons are gone before any reply
    expect(screen.queryByTestId('tool-card-answer-pending')).toBeNull();           // a quick confirmation never flashes the line
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(screen.getByTestId('tool-card-answer-pending').textContent).toBe('Waiting for your computer to confirm your answer');
    p.view.unmount();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe('Close', () => {
  /** App's side of a close, reduced to what the helper needs: a list of conversations and the open one. */
  function strip(ids = ['a', 'b', 'c'], open: string | null = 'b') {
    const state = { ids: [...ids], open, gone: [] as string[] };
    return {
      state,
      leave: vi.fn(() => {
        if (state.open !== 'b') return () => {};
        const moved = state.ids.filter((i) => i !== 'b')[0] ?? null;
        state.open = moved;
        return () => { if (state.open === moved) state.open = 'b'; };
      }),
      finish: vi.fn(() => { state.ids = state.ids.filter((i) => i !== 'b'); state.gone.push('b'); }),
    };
  }
  const close = (s: ReturnType<typeof strip>, destroy: () => Promise<unknown>, list: () => Promise<Array<{ id: string }>> = async () => s.state.ids.map((id) => ({ id }))) =>
    act(() => { closeSession({ id: 'b', name: 'Build', destroy, list, leave: s.leave, finish: s.finish }); });

  it('INSTANT: the conversation leaves the strip (and the screen moves off it) before the computer has said anything', () => {
    wire(); const s = strip(); const reply = deferred<boolean>();
    close(s, () => reply.promise);
    expect(isPending('close:b')).toBe(true);                       // App hides every pill whose key is pending
    expect(s.leave).toHaveBeenCalledTimes(1);
    expect(s.state.open).toBe('a');
    expect(s.finish).not.toHaveBeenCalled();
  });

  it('CONFIRM: the computer says it closed it (true, or false = it was already gone): the removal is finished here, once', async () => {
    for (const answer of [true, false]) {
      resetPendingForTests();
      wire(); const s = strip(); const reply = deferred<boolean>();
      close(s, () => reply.promise);
      await act(async () => { reply.resolve(answer); await Promise.resolve(); });
      expect(isPending('close:b')).toBe(false);
      expect(s.finish).toHaveBeenCalledTimes(1);
      expect(notices).toEqual([]);
    }
  });

  it('CONFIRM, by the computer\'s own "closed" notice arriving first: the mark goes without waiting for the reply, and a late reply changes nothing', async () => {
    wire(); const s = strip(); const reply = deferred<boolean>();
    close(s, () => reply.promise);
    act(() => confirmPending('close:b'));                          // App's session-destroyed handler
    expect(isPending('close:b')).toBe(false);
    await act(async () => { reply.resolve(true); await Promise.resolve(); });
    expect(s.finish).toHaveBeenCalledTimes(1);                     // not twice
  });

  it('REFUSED: the computer refuses (in its own words): the conversation is back in the strip and the selection returns, and the person is told what the computer said', async () => {
    wire(); const s = strip(); const reply = deferred<boolean>();
    close(s, () => reply.promise);
    await act(async () => { reply.reject(new Error('Session is busy handing off')); await Promise.resolve(); });
    expect(isPending('close:b')).toBe(false);
    expect(s.state.open).toBe('b');
    expect(s.finish).not.toHaveBeenCalled();
    expect(notices).toEqual(['Couldn\'t close "Build": Session is busy handing off']);
  });

  it('REFUSED, with no reason given (the computer does not offer the channel): says only what is known', async () => {
    wire(); const s = strip(); const reply = deferred<boolean>();
    close(s, () => reply.promise);
    await act(async () => { reply.reject(new Error('remote-unsupported: session:destroy')); await Promise.resolve(); });
    expect(notices).toEqual(['Couldn\'t close "Build". Your computer didn\'t accept the request.']);
  });

  it('DROPPED, the computer\'s list still has it: it never closed, so the pill returns and the person is told; nothing is resent', async () => {
    const w = wire(); const s = strip(); const reply = deferred<boolean>();
    close(s, () => { w.session.destroy('b'); return reply.promise; }, async () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    up = false;
    await act(async () => { reply.reject(lostAnswer()); await Promise.resolve(); });
    expect(isPending('close:b')).toBe(true);                       // offline: still hidden, nothing decided
    up = true;
    await act(async () => { await reconcilePending(); });
    expect(isPending('close:b')).toBe(false);
    expect(s.state.open).toBe('b');
    expect(notices).toEqual(['Couldn\'t confirm "Build" closed on your computer, so it is back.']);
    expect(w.session.destroy).toHaveBeenCalledTimes(1);
  });

  it('DROPPED, the computer\'s list no longer has it: it did close, so the removal is finished and nothing is said', async () => {
    wire(); const s = strip(); const reply = deferred<boolean>();
    close(s, () => reply.promise, async () => [{ id: 'a' }, { id: 'c' }]);
    up = false;
    await act(async () => { reply.reject(lostAnswer()); await Promise.resolve(); });
    up = true;
    await act(async () => { await reconcilePending(); });
    expect(isPending('close:b')).toBe(false);
    expect(s.finish).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
  });

  it('DROPPED, and the computer\'s list cannot be read either: it is asked again a little later, and after a few failures the conversation is put back rather than left hidden', async () => {
    vi.useFakeTimers();
    const w = wire(); const s = strip(); const reply = deferred<boolean>();
    const list = vi.fn(async () => { throw new Error('timed out'); });
    close(s, () => reply.promise, list);
    await act(async () => { reply.reject(lostAnswer()); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(8000 * 4); });
    expect(list).toHaveBeenCalledTimes(3);
    expect(isPending('close:b')).toBe(false);
    expect(s.state.open).toBe('b');
    expect(notices).toHaveLength(1);
    expect(w.session.destroy).not.toHaveBeenCalled();
  });

  it('THE COMPUTER\'S OWN WINDOW closes the old way: the one call, nothing hidden', () => {
    setConnectionMode('local');
    const w = wire(); const s = strip();
    close(s, async () => w.session.destroy('b'));
    expect(w.session.destroy).toHaveBeenCalledWith('b');
    expect(isPending('close:b')).toBe(false);
    expect(s.leave).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe('Send', () => {
  const bubbles = (p: ReturnType<typeof phone>) => p.session().timeline.filter((e: any) => e.kind === 'user') as any[];
  const nativeSend = (p: ReturnType<typeof phone>, instant = true) => sendToNative({ sessionId: S, provider: 'native', ptyText: 'hello', content: 'hello', paths: [], dispatch: p.store.dispatch, instant });

  it('INSTANT (native, idle): the bubble is on screen before the computer has answered, with its send id', async () => {
    const w = wire(); const reply = deferred<any>(); w.native.send.mockReturnValue(reply.promise);
    const p = phone();
    let out: Promise<any>;
    act(() => { out = nativeSend(p); });
    expect(bubbles(p)).toHaveLength(1);
    expect(bubbles(p)[0].pending).toBe(true);
    expect(bubbles(p)[0].sendId).toMatch(/^s/);
    expect(p.session().isThinking).toBe(true);
    await act(async () => { reply.resolve({ status: 'sent' }); await out!; });
    expect(bubbles(p)).toHaveLength(1);                            // confirmed: still one bubble
  });

  it('only a conversation this screen sees as completely quiet gets the instant bubble: a turn, a tool or a waiting message each send it down the wait-for-the-answer path', () => {
    const quiet = phone().session();
    expect(canDrawSendNow(quiet)).toBe(true);
    expect(canDrawSendNow(undefined)).toBe(false);
    expect(canDrawSendNow({ ...quiet, isThinking: true })).toBe(false);
    expect(canDrawSendNow({ ...quiet, currentTurnId: 'turn-1' })).toBe(false);
    expect(canDrawSendNow({ ...quiet, activeTurnToolIds: new Set(['t']) })).toBe(false);
    expect(canDrawSendNow({ ...quiet, queuedMessages: [{ queueId: 'q', content: 'x', timestamp: 1 }] })).toBe(false);
  });

  it('NOT INSTANT when a turn is running (the computer queues it and draws its own strip): the bubble waits for the answer, exactly as before', async () => {
    const w = wire(); const reply = deferred<any>(); w.native.send.mockReturnValue(reply.promise);
    const p = phone();
    let out: Promise<any>;
    act(() => { out = nativeSend(p, false); });
    expect(bubbles(p)).toHaveLength(0);
    await act(async () => { reply.resolve({ status: 'queued' }); await out!; });
    expect(bubbles(p)).toHaveLength(0);                            // queued: no bubble, the queue strip is the computer's
  });

  it('CONFIRM + NO DOUBLE: the echo of the message confirms the one bubble; it does not add a second', async () => {
    const w = wire(); w.native.send.mockResolvedValue({ status: 'sent' });
    const p = phone();
    await act(async () => { await nativeSend(p); });
    p.dispatch({ type: 'TRANSCRIPT_USER_MESSAGE', sessionId: S, uuid: 'u1', text: 'hello', timestamp: 5 } as ChatAction);
    expect(bubbles(p)).toHaveLength(1);
    expect(bubbles(p)[0].pending).toBe(false);
  });

  it('REFUSED: the computer refuses (it is not live): the bubble comes down and the caller is told it failed, so the composer keeps the words', async () => {
    const w = wire(); w.native.send.mockResolvedValue({ status: 'failed', reason: 'not-live' });
    const p = phone();
    let out: any;
    await act(async () => { out = await nativeSend(p); });
    expect(out.status).toBe('failed');
    expect(bubbles(p)).toHaveLength(0);
    expect(p.session().isThinking).toBe(false);                    // no spinner for a message nobody has
  });

  it('REDIRECTED: the computer found a turn running after all and queued it: the optimistic bubble comes down (the queue strip is the computer\'s) and no failure is reported', async () => {
    const w = wire(); w.native.send.mockResolvedValue({ status: 'queued' });
    const p = phone();
    let out: any;
    await act(async () => { out = await nativeSend(p); });
    expect(out.status).toBe('queued');
    expect(bubbles(p)).toHaveLength(0);
  });

  it('DROPPED: the answer never came: the bubble STAYS with "Not sure this was sent", a check is requested, and nothing is resent', async () => {
    const w = wire(); w.native.send.mockRejectedValue(lostAnswer());
    const checks: Event[] = []; const onCheck = (e: Event) => checks.push(e);
    window.addEventListener('youcoded:check-sends', onCheck);
    const p = phone();
    let out: any;
    await act(async () => { out = await nativeSend(p); });
    window.removeEventListener('youcoded:check-sends', onCheck);
    expect(out.status).toBe('unsure');
    expect(bubbles(p)).toHaveLength(1);
    expect(bubbles(p)[0].sendNote).toBe('unsure');
    expect(checks).toHaveLength(1);
    expect(w.native.send).toHaveBeenCalledTimes(1);
  });

  it('THE COMPUTER\'S OWN WINDOW is unchanged: with instant off, the bubble still waits for the answer', async () => {
    setConnectionMode('local');
    const w = wire(); const reply = deferred<any>(); w.native.send.mockReturnValue(reply.promise);
    const p = phone();
    let out: Promise<any>;
    act(() => { out = nativeSend(p, false); });
    expect(bubbles(p)).toHaveLength(0);
    await act(async () => { reply.resolve({ status: 'sent' }); await out!; });
    expect(bubbles(p)).toHaveLength(1);
  });

  it('INSTANT (Claude Code): the bubble is up before the write, and a phone asks the record once, a few seconds on, whether the computer took it', () => {
    vi.useFakeTimers();
    const w = wire(); const p = phone();
    const checks: Event[] = []; const onCheck = (e: Event) => checks.push(e);
    window.addEventListener('youcoded:check-sends', onCheck);
    act(() => { sendToClaudeCode({ sessionId: S, provider: 'claude', ptyText: 'hello', content: 'hello', paths: [], dispatch: p.store.dispatch }); });
    expect(bubbles(p)).toHaveLength(1);                            // before any timer ran: before the write itself
    expect(w.session.sendInput).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(10); });
    expect(w.session.sendInput).toHaveBeenCalledTimes(1);
    expect(checks).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(CC_SEND_CHECK_MS + 10); });
    window.removeEventListener('youcoded:check-sends', onCheck);
    expect(checks).toHaveLength(1);
  });

  it('INSTANT (Claude Code), the computer\'s own window: no extra check is scheduled', () => {
    setConnectionMode('local');
    vi.useFakeTimers();
    wire(); const p = phone();
    const checks: Event[] = []; const onCheck = (e: Event) => checks.push(e);
    window.addEventListener('youcoded:check-sends', onCheck);
    act(() => { sendToClaudeCode({ sessionId: S, provider: 'claude', ptyText: 'hello', content: 'hello', paths: [], dispatch: p.store.dispatch }); });
    act(() => { vi.advanceTimersByTime(CC_SEND_CHECK_MS + 100); });
    window.removeEventListener('youcoded:check-sends', onCheck);
    expect(checks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe('Permission mode', () => {
  /** App's map of modes, reduced to a Map and a way to read it back. */
  function modes(initial: string) {
    const m = new Map<string, string>([[S, initial]]);
    return { m, read: () => m.get(S), write: (mode: string) => { m.set(S, mode); } };
  }
  const NATIVE = ['ask', 'auto-edit', 'full-auto'];
  /** The native chip: `set` is the computer's answer to the change, `host` what the computer says the session's mode is when asked. */
  const nativeChip = (md: ReturnType<typeof modes>, set: () => Promise<unknown>, host: () => Promise<unknown> = async () => md.read()) =>
    act(() => { setNativeModeNow({ sessionId: S, from: 'ask', to: 'auto-edit', valid: NATIVE, read: md.read, write: md.write, set, readHost: host }); });

  it('INSTANT (native): the chip shows the new mode before the computer has answered', () => {
    wire(); const md = modes('ask'); const reply = deferred<string>();
    nativeChip(md, () => reply.promise);
    expect(md.read()).toBe('auto-edit');
    expect(isPending(`mode:${S}`)).toBe(true);
  });

  it('CONFIRM (native): the answer is the mode the computer APPLIED, and that is what stays (even if it differs)', async () => {
    wire(); const md = modes('ask'); const reply = deferred<string>();
    nativeChip(md, () => reply.promise);
    await act(async () => { reply.resolve('full-auto'); await Promise.resolve(); });
    expect(md.read()).toBe('full-auto');
    expect(isPending(`mode:${S}`)).toBe(false);
    expect(notices).toEqual([]);
  });

  it('REFUSED (native): the computer refuses: the old mode is back and the person is told', async () => {
    wire(); const md = modes('ask'); const reply = deferred<unknown>();
    nativeChip(md, () => reply.promise);
    await act(async () => { reply.resolve({ ok: false, error: 'no' }); await Promise.resolve(); });   // the shim's shape for a host failure
    expect(md.read()).toBe('ask');
    expect(isPending(`mode:${S}`)).toBe(false);
    expect(notices).toEqual(["The permission mode didn't change. Your computer didn't confirm it."]);
  });

  it('REFUSED (native), a rejection: the same, and a newer mode the record has pushed meanwhile is NOT overwritten by the undo', async () => {
    wire(); const md = modes('ask'); const reply = deferred<unknown>();
    nativeChip(md, () => reply.promise);
    md.write('full-auto');                                         // the computer's own push (another device changed it)
    await act(async () => { reply.reject(new Error('refused')); await Promise.resolve(); });
    expect(md.read()).toBe('full-auto');
  });

  it('DROPPED (native), the computer says the change took: the chip keeps it and nothing is said', async () => {
    wire(); const md = modes('ask'); const reply = deferred<unknown>();
    nativeChip(md, () => reply.promise, async () => 'auto-edit');
    up = false;
    await act(async () => { reply.reject(lostAnswer()); await Promise.resolve(); });
    expect(isPending(`mode:${S}`)).toBe(true);                     // offline: the screen waits
    up = true;
    await act(async () => { await reconcilePending(); });
    expect(md.read()).toBe('auto-edit');
    expect(isPending(`mode:${S}`)).toBe(false);
    expect(notices).toEqual([]);
  });

  it('DROPPED (native), the computer says it did NOT: the chip shows the computer\'s mode (a reconnect carries no mode push when none changed) and the person is told', async () => {
    wire(); const md = modes('ask'); const reply = deferred<unknown>();
    nativeChip(md, () => reply.promise, async () => 'ask');
    up = false;
    await act(async () => { reply.reject(lostAnswer()); await Promise.resolve(); });
    up = true;
    await act(async () => { await reconcilePending(); });          // no push arrived: only asking the computer can show the truth
    expect(md.read()).toBe('ask');
    expect(isPending(`mode:${S}`)).toBe(false);
    expect(notices).toHaveLength(1);
  });

  it('DROPPED (native), and the computer cannot be asked either: after a few tries the old mode is put back rather than a mode nobody confirmed being left on screen', async () => {
    vi.useFakeTimers();
    wire(); const md = modes('ask'); const reply = deferred<unknown>();
    const host = vi.fn(async () => { throw new Error('timed out'); });
    nativeChip(md, () => reply.promise, host);
    await act(async () => { reply.reject(lostAnswer()); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(7000 * 4); });
    expect(host).toHaveBeenCalledTimes(3);
    expect(md.read()).toBe('ask');
    expect(isPending(`mode:${S}`)).toBe(false);
    expect(notices).toHaveLength(1);
  });

  it('INSTANT + CONFIRM (Claude Code): Shift+Tab is sent once and the chip shows the new mode at once; the computer\'s reading of the terminal confirms it', () => {
    const w = wire(); const md = modes('normal');
    act(() => { cycleClaudeModeNow({ sessionId: S, from: 'normal', to: 'auto-accept', read: md.read, write: md.write, sendKey: () => w.session.sendInput(S, '\x1b[Z') }); });
    expect(md.read()).toBe('auto-accept');
    expect(w.session.sendInput).toHaveBeenCalledWith(S, '\x1b[Z');
    expect(w.session.sendInput).toHaveBeenCalledTimes(1);
    expect(isPending(`mode:${S}`)).toBe(true);
    // The record's reading arrives (the host read the footer): App writes it and tells the helper.
    md.write('auto-accept'); act(() => confirmPending(`mode:${S}`));
    expect(isPending(`mode:${S}`)).toBe(false);
    expect(notices).toEqual([]);
  });

  it('CONFIRM (Claude Code), the computer reads a different mode than the phone guessed (a different cycle order): the chip shows the computer\'s, with no complaint', () => {
    const w = wire(); const md = modes('normal');
    act(() => { cycleClaudeModeNow({ sessionId: S, from: 'normal', to: 'plan', read: md.read, write: md.write, sendKey: () => w.session.sendInput(S, '\x1b[Z') }); });
    md.write('auto-accept'); act(() => confirmPending(`mode:${S}`));
    expect(md.read()).toBe('auto-accept');
    expect(notices).toEqual([]);
  });

  it('UNDO (Claude Code): no reading ever arrives (and the record, asked, has none): the old mode is back and the person is told', async () => {
    vi.useFakeTimers();
    const w = wire(); const md = modes('normal');
    registerPendingResume(async () => {});
    act(() => { cycleClaudeModeNow({ sessionId: S, from: 'normal', to: 'auto-accept', read: md.read, write: md.write, sendKey: () => w.session.sendInput(S, '\x1b[Z') }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    expect(md.read()).toBe('normal');
    expect(isPending(`mode:${S}`)).toBe(false);
    expect(notices).toHaveLength(1);
    expect(w.session.sendInput).toHaveBeenCalledTimes(1);          // never resent
  });

  it('DROPPED (Claude Code): offline the chip waits; after the reconnect\'s fill brings the reading it is confirmed, with the record asked first', async () => {
    vi.useFakeTimers();
    const w = wire(); const md = modes('normal');
    const resume = vi.fn(async () => { md.write('auto-accept'); confirmPending(`mode:${S}`); });   // the fill replays the host's mode push
    registerPendingResume(resume);
    act(() => { cycleClaudeModeNow({ sessionId: S, from: 'normal', to: 'auto-accept', read: md.read, write: md.write, sendKey: () => w.session.sendInput(S, '\x1b[Z') }); });
    up = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(isPending(`mode:${S}`)).toBe(true);
    expect(resume).not.toHaveBeenCalled();                         // no asking while there is no connection
    up = true;
    await act(async () => { await reconcilePending({ resume: true }); });
    expect(resume).toHaveBeenCalledWith(S);
    expect(md.read()).toBe('auto-accept');
    expect(isPending(`mode:${S}`)).toBe(false);
    expect(notices).toEqual([]);
  });

  it('THE COMPUTER\'S OWN WINDOW: both functions decline, so App\'s existing code runs unchanged', () => {
    setConnectionMode('local');
    wire(); const md = modes('ask');
    expect(setNativeModeNow({ sessionId: S, from: 'ask', to: 'auto-edit', valid: NATIVE, read: md.read, write: md.write, set: async () => 'auto-edit', readHost: async () => 'ask' })).toBe(false);
    expect(cycleClaudeModeNow({ sessionId: S, from: 'normal', to: 'plan', read: md.read, write: md.write, sendKey: () => {} })).toBe(false);
    expect(md.read()).toBe('ask');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe('the helper itself', () => {
  it('applies once per key: a second action with a key that is still unconfirmed is ignored and its change is not applied', async () => {
    wire();
    const apply = vi.fn();
    const first = deferred<'answered'>();
    const mk = () => ({ key: 'k', apply, send: () => first.promise, undo: vi.fn(), check: () => 'present' as const });
    const a = runPending(mk());
    expect(await runPending(mk())).toBe('duplicate');
    expect(apply).toHaveBeenCalledTimes(1);
    first.resolve('answered');
    expect(await a).toBe('confirmed');
  });

  it('a mark is never dropped twice and an undo never runs after a confirm', async () => {
    wire();
    const confirm = vi.fn(); const undo = vi.fn();
    const reply = deferred<'answered'>();
    const a = runPending({ key: 'k2', apply() {}, send: () => reply.promise, confirm, undo, check: () => 'absent' });
    confirmPending('k2');                                          // the record settled it first
    reply.resolve('answered');
    await a;
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
  });
});
