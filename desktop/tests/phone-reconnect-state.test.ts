// A phone that reconnects while sessions are live (one-core sync-fix2, Destin 2026-10-02: "on reconnect, the active sessions show up in the switcher but the remote
// device can show them as stuck at 'session initializing' with a 'check terminal view' button even while the session is fine on desktop. terminal view doesn't work
// until loading finishes").
//
// Three facts this pins, each of which was false before:
//  1. A session announced as already started (`session:created` sent to a reconnecting phone, no `awaitingStart`) counts as started on the screen.
//  2. The computer's per-session summary says whether a session has started, for EVERY session, so a phone that missed the first hook (it was away, or never watched
//     that conversation) learns it from the summary.
//  3. The terminal no longer waits for the chat page: a `ptyOnly` open is answered with the terminal's cut alone, and the phone is joined to the terminal stream
//     (and only that) so frames after the cut reach it.
import { describe, it, expect, vi } from 'vitest';
import { SessionRecords } from '../src/main/session-record';
import { openPtyOnly } from '../src/main/session-open';
import { WindowRegistry } from '../src/main/window-registry';
import { announcedAsStarted, startedFromSummaries, startedIds } from '../src/renderer/state/startup-dialog-store';

const S = 's1';
const hook = (type = 'SessionStart') => ({ type, sessionId: S, payload: {}, timestamp: 1 });

describe('a session that has started, as every screen is told', () => {
  it('the announcement of a running session (no awaitingStart) is a started session; a brand-new one is not', () => {
    expect(announcedAsStarted({})).toBe(true);
    expect(announcedAsStarted({ awaitingStart: true })).toBe(false);
    // The list path agrees (it always did): both ways in now say the same thing.
    expect(startedIds([{ id: 'a' }, { id: 'b', awaitingStart: true }])).toEqual(['a']);
  });

  it("the computer's summary carries `started` for every session, flips on the first hook, and announces the change", () => {
    const r = new SessionRecords();
    const changed: string[] = [];
    r.onSummaryChange((id) => changed.push(id));
    r.begin(S); r.begin('s2');
    expect(r.summaries()[S].started).toBe(false);
    r.note(S, 'hook:event', hook());
    expect(r.summaries()[S].started).toBe(true);
    expect(r.summaries()['s2'].started).toBe(false);          // an unwatched, still-starting session is not called started
    expect(changed).toContain(S);                              // a phone is pushed the change (it reads this, not events it does not receive)
  });

  it('a screen takes from the summaries exactly the sessions it does not already hold as started', () => {
    const summaries = { a: { started: true }, b: { started: false }, c: { started: true }, d: undefined };
    expect(startedFromSummaries(summaries, new Set(['c']))).toEqual(['a']);
    expect(startedFromSummaries(null, new Set())).toEqual([]);
  });
});

describe('the terminal alone, before the chat page', () => {
  const rig = () => {
    const records = new SessionRecords();
    records.begin(S);
    records.notePty(S, 'screen so far');
    const pageRead = vi.fn();
    return { records, pageRead, deps: { knows: (id: string) => id === S, records } };
  };

  it('answers with the whole terminal on a first ask, and with only what is past a position the phone holds', () => {
    const { records, deps } = rig();
    const first = openPtyOnly(deps, { sessionId: S, pty: {} }) as any;
    expect(first).toMatchObject({ ok: true, ptyOnly: true });
    expect(first.pty.data).toBe('screen so far');
    records.notePty(S, ' + more');
    const next = openPtyOnly(deps, { sessionId: S, pty: { epoch: first.pty.epoch, units: 13 } }) as any;
    expect(next.pty).toMatchObject({ data: ' + more', offset: 13, reset: false });
  });

  it('is "gone" for a session the computer does not run', () => {
    const { deps } = rig();
    expect(openPtyOnly(deps, { sessionId: 'nope', pty: {} })).toMatchObject({ ok: false, gone: true });
  });

  it('joins the phone to the terminal stream ONLY: chat events are still not sent to a phone that has not opened the conversation', () => {
    const reg = new WindowRegistry();
    reg.registerSocket(-1001); reg.registerSocket(-1002);
    reg.subscribePty(S, -1001);
    reg.subscribe(S, -1002);                                    // a phone that opened it in full
    expect(reg.getPtyWatchers(S).sort()).toEqual([-1002, -1001].sort());
    expect(reg.getSocketWatchers(S)).toEqual([-1002]);          // the chat audience did not widen
    expect(reg.resolveAudience(S).socketIds).toEqual([-1002]);
  });

  it('forgets the terminal subscription when the phone leaves, unwatches, or the session ends', () => {
    const reg = new WindowRegistry();
    reg.registerSocket(-1001); reg.registerSocket(-1002); reg.registerSocket(-1003);
    reg.subscribePty('a', -1001); reg.subscribePty('b', -1002); reg.subscribePty('c', -1003);
    reg.unregisterSocket(-1001);
    expect(reg.getPtyWatchers('a')).toEqual([]);
    reg.unsubscribe('b', -1002);
    expect(reg.getPtyWatchers('b')).toEqual([]);
    reg.endSession('c');
    expect(reg.getPtyWatchers('c')).toEqual([]);
  });
});
