// @vitest-environment jsdom
// "Did the computer get my message?" (one-core R5-4b, Destin approved the lost-send note). A message carries an id the screen makes up; the computer's
// record notes the ids it received; after a connection drop the screen asks the record and says what it learned on the message — received (the note
// clears itself), provably not received ("This didn't send"), or cannot tell ("Not sure this was sent") — and NEVER sends anything again by itself.
//
// The host half is real: the record, and the real `session:input` / `native:send` / `session:send-outcomes` channel handlers. The screen half is real: the
// chat reducer, the reconcile hook, the message bubble. Only the wire between them is a stand-in, so a test can drop a message or restart the computer.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { SessionRecords } from '../src/main/session-record';
import { findChannel } from '../src/main/ipc/channel-table';
import { bindSessionOps } from '../src/main/ipc/session';
import { ChatProvider, useChatDispatch, useChatStore } from '../src/renderer/state/chat-context';
import { useSendReconcile } from '../src/renderer/hooks/useSendReconcile';
import { sendToClaudeCode, sendToNative, sendAgain, splitSentContent } from '../src/renderer/state/submit-outgoing';
import { REMOTE_RECONNECTED_EVENT, OUTCOME_UNKNOWN_EVENT } from '../src/renderer/remote-events';
import UserMessage from '../src/renderer/components/UserMessage';
import { newSendId } from '../src/renderer/state/send-ids';
import { isSendId } from '../src/shared/send-outcome-types';

const S = 'sess-1';

/** The computer: a real record behind the real channel handlers, which the stand-in wire calls (or does not, when a message is lost). */
function computer() {
  let records = new SessionRecords();
  records.begin(S);
  const sendInput = vi.fn(() => true);
  const nativeSend = vi.fn((_s: string, _t: string, _f: string[]) => ({ status: 'sent' as const }));
  bindSessionOps({ sessionManager: { sendInput } } as any);
  const ctx = () => ({ door: 'remote', runtime: { records, nativeHost: { send: nativeSend } }, broadcast: () => {}, audienceId: -1000 } as any);
  const call = (name: string, req: any) => findChannel(name)!.handler(req, ctx());
  return {
    get records() { return records; },
    sendInput, nativeSend,
    /** The computer restarts: its record is gone, and a new one (another epoch) starts. */
    restart() { records = new SessionRecords(); records.begin(S); },
    call,
  };
}

/** The phone's window.claude over a wire that can drop messages. `epoch` is what the phone last filled the session at. */
function phoneWire(host: ReturnType<typeof computer>) {
  let up = true;
  const epoch = host.records.epochOf(S)!;
  const sendOutcomes = vi.fn(async (sessionId: string, ids: string[]) => host.call('session:send-outcomes', { sessionId, ids, epoch }));
  const wire = {
    drop() { up = false; }, restore() { up = true; },
    session: {
      sendInput: vi.fn((sessionId: string, text: string, notice?: string, sendId?: string) => { if (up) host.call('session:input', { sessionId, text, notice, sendId }); }),
      sendOutcomes,
    },
    native: { send: vi.fn(async (sessionId: string, text: string, attachments?: string[], sendId?: string) => {
      if (!up) throw Object.assign(new Error('Lost the connection before the computer answered.'), { outcomeUnknown: true });
      return host.call('native:send', { sessionId, text, attachments, sendId });
    }) },
  };
  (window as any).claude = wire;
  return wire;
}

function mountPhone() {
  const wrapper = ({ children }: { children: React.ReactNode }) => <ChatProvider>{children}</ChatProvider>;
  const view = renderHook(() => { useSendReconcile(); return { store: useChatStore(), dispatch: useChatDispatch() }; }, { wrapper });
  act(() => { view.result.current.dispatch({ type: 'SESSION_INIT', sessionId: S }); });
  const bubbles = () => view.result.current.store.getState().get(S)!.timeline.filter((e: any) => e.kind === 'user') as any[];
  return { view, bubbles, dispatch: (a: any) => act(() => view.result.current.dispatch(a)) };
}
const reconnect = () => act(() => { window.dispatchEvent(new CustomEvent(REMOTE_RECONNECTED_EVENT)); });

let host: ReturnType<typeof computer>;
beforeEach(() => { host = computer(); });
afterEach(() => { bindSessionOps(null); delete (window as any).claude; });

describe('the computer\'s record of the sends it received', () => {
  it('notes the id of a terminal write it accepted, and of a native message its host took (sent or queued), but not one that was refused', async () => {
    host.call('session:input', { sessionId: S, text: 'hi\r', sendId: 'a1' });
    host.nativeSend.mockReturnValueOnce({ status: 'queued' } as any);
    await host.call('native:send', { sessionId: S, text: 'queued one', sendId: 'a2' });
    host.nativeSend.mockReturnValueOnce({ status: 'failed', reason: 'queue-full' } as any);
    await host.call('native:send', { sessionId: S, text: 'refused', sendId: 'a3' });
    const epoch = host.records.epochOf(S);
    const r = await host.call('session:send-outcomes', { sessionId: S, ids: ['a1', 'a2', 'a3'], epoch });
    expect(r.outcomes).toEqual({ a1: 'received', a2: 'received', a3: 'not-received' });
  });

  it('a write the terminal refused is not "received"', async () => {
    host.sendInput.mockReturnValueOnce(false as any);
    host.call('session:input', { sessionId: S, text: 'hi\r', sendId: 'b1' });
    const r = await host.call('session:send-outcomes', { sessionId: S, ids: ['b1'], epoch: host.records.epochOf(S) });
    expect(r.outcomes.b1).toBe('not-received');
  });

  it('cannot tell once the computer restarted (another epoch) or once older ids were let go, and says so instead of "not received"', async () => {
    host.call('session:input', { sessionId: S, text: 'hi\r', sendId: 'c1' });
    const oldEpoch = host.records.epochOf(S);
    host.restart();
    expect((await host.call('session:send-outcomes', { sessionId: S, ids: ['c1'], epoch: oldEpoch })).outcomes.c1).toBe('unknown');
    expect((await host.call('session:send-outcomes', { sessionId: S, ids: ['c1'] })).outcomes.c1).toBe('unknown');   // a screen with no epoch at all
    for (let i = 0; i < 600; i++) host.records.noteSend(S, `fill-${i}`);
    expect((await host.call('session:send-outcomes', { sessionId: S, ids: ['never'], epoch: host.records.epochOf(S) })).outcomes.never).toBe('unknown');
    expect((await host.call('session:send-outcomes', { sessionId: 'no-such-session', ids: ['x'], epoch: 'e' })).outcomes.x).toBe('unknown');
  });

  it('refuses ids that are not plain ids, and answers at most 50', async () => {
    const r = await host.call('session:send-outcomes', { sessionId: S, ids: ['ok1', '<script>', 'x'.repeat(200), 7, null], epoch: host.records.epochOf(S) });
    expect(Object.keys(r.outcomes)).toEqual(['ok1']);
    const many = await host.call('session:send-outcomes', { sessionId: S, ids: Array.from({ length: 120 }, (_, i) => `id${i}`), epoch: host.records.epochOf(S) });
    expect(Object.keys(many.outcomes)).toHaveLength(50);
  });

  it('ids the screen makes up are always ones the computer accepts', () => {
    for (let i = 0; i < 50; i++) expect(isSendId(newSendId())).toBe(true);
    expect(new Set(Array.from({ length: 200 }, () => newSendId())).size).toBe(200);
  });
});

describe('after the connection drops (a Claude Code session: the message is written, not asked)', () => {
  const claudeSend = (m: ReturnType<typeof mountPhone>, text = 'build it') =>
    sendToClaudeCode({ sessionId: S, provider: 'claude', ptyText: text, content: text, paths: [], dispatch: m.dispatch });

  it('RECEIVED: the computer got it but the echo never reached the phone: the note clears itself and nothing is sent again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const wire = phoneWire(host);
    const m = mountPhone();
    claudeSend(m);
    act(() => { vi.advanceTimersByTime(10); });                     // the write goes out
    vi.useRealTimers();
    expect(host.sendInput).toHaveBeenCalledTimes(1);
    expect(m.bubbles()[0].pending).toBe(true);                      // no echo came back
    reconnect();
    await waitFor(() => expect(wire.session.sendOutcomes).toHaveBeenCalled());
    expect(m.bubbles()[0].sendNote).toBeUndefined();
    expect(host.sendInput).toHaveBeenCalledTimes(1);                // never resent
  });

  it('NOT RECEIVED: the write never reached the computer: "This didn\'t send" with Send again, and nothing is sent again by itself', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const wire = phoneWire(host);
    const m = mountPhone();
    wire.drop();
    claudeSend(m);
    act(() => { vi.advanceTimersByTime(10); });
    vi.useRealTimers();
    expect(host.sendInput).not.toHaveBeenCalled();
    wire.restore();
    reconnect();
    await waitFor(() => expect(m.bubbles()[0].sendNote).toBe('not-sent'));
    await new Promise((r) => setTimeout(r, 20));                    // give an automatic resend every chance to happen
    expect(wire.session.sendInput).toHaveBeenCalledTimes(1);        // the one original write, and no second
    expect(host.sendInput).not.toHaveBeenCalled();
  });

  it('CANNOT TELL: the computer restarted meanwhile: "Not sure this was sent" with Send again, and nothing is sent again by itself', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const wire = phoneWire(host);
    const m = mountPhone();
    claudeSend(m);
    act(() => { vi.advanceTimersByTime(10); });
    vi.useRealTimers();
    host.restart();                                                 // the record that knew is gone
    reconnect();
    await waitFor(() => expect(m.bubbles()[0].sendNote).toBe('unsure'));
    expect(wire.session.sendInput).toHaveBeenCalledTimes(1);
  });

  it('a note clears itself the moment the transcript echoes the message (it can never outlive its doubt)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const wire = phoneWire(host);
    const m = mountPhone();
    wire.drop();
    claudeSend(m);
    act(() => { vi.advanceTimersByTime(10); });
    vi.useRealTimers();
    wire.restore();
    reconnect();
    await waitFor(() => expect(m.bubbles()[0].sendNote).toBe('not-sent'));
    m.dispatch({ type: 'TRANSCRIPT_USER_MESSAGE', sessionId: S, text: 'build it', timestamp: 5, uuid: 'echo-1' });
    expect(m.bubbles()).toHaveLength(1);
    expect(m.bubbles()[0].pending).toBe(false);
    expect(m.bubbles()[0].sendNote).toBeUndefined();
    expect(m.bubbles()[0].sendId).toBeUndefined();
  });

  it('nothing is asked about a message that already has its echo, and a screen with no host record (the Android app\'s own runtime) is not asked at all', async () => {
    const wire = phoneWire(host);
    const m = mountPhone();
    m.dispatch({ type: 'USER_PROMPT', sessionId: S, content: 'hello', timestamp: 1 });     // no id: nothing to ask about
    reconnect();
    await new Promise((r) => setTimeout(r, 10));
    expect(wire.session.sendOutcomes).not.toHaveBeenCalled();
    wire.session.sendOutcomes.mockResolvedValue(undefined as any);
    m.dispatch({ type: 'USER_PROMPT', sessionId: S, content: 'again', timestamp: 2, sendId: 'sx1' });
    reconnect();
    await waitFor(() => expect(wire.session.sendOutcomes).toHaveBeenCalledTimes(1));
    expect(m.bubbles().at(-1).sendNote).toBeUndefined();
  });
});

describe('a message sent as a request (a native session) whose answer never came', () => {
  const nativeSend = (m: ReturnType<typeof mountPhone>, text = 'native hi') =>
    sendToNative({ sessionId: S, provider: 'native', ptyText: text, content: text, paths: [], dispatch: m.dispatch });

  it('is drawn with "Not sure this was sent" at once, then settled by the record: RECEIVED clears it', async () => {
    const wire = phoneWire(host);
    const m = mountPhone();
    // The computer takes the message, but the answer is lost (the connection drops after the host accepted).
    wire.native.send.mockImplementationOnce(async (sessionId: string, text: string, attachments?: string[], sendId?: string) => {
      await host.call('native:send', { sessionId, text, attachments, sendId });
      throw Object.assign(new Error('Lost the connection before the computer answered.'), { outcomeUnknown: true });
    });
    const out = await nativeSend(m);
    expect(out.status).toBe('unsure');
    await waitFor(() => expect(wire.session.sendOutcomes).toHaveBeenCalled());
    await waitFor(() => expect(m.bubbles()[0].sendNote).toBeUndefined());
    expect(m.bubbles()).toHaveLength(1);
    expect(host.nativeSend).toHaveBeenCalledTimes(1);               // asked once, never resent
  });

  it('NOT RECEIVED: the request never arrived: "This didn\'t send" with Send again, and the computer was never asked twice', async () => {
    const wire = phoneWire(host);
    const m = mountPhone();
    wire.drop();
    const out = await nativeSend(m);
    expect(out.status).toBe('unsure');
    wire.restore();
    act(() => { window.dispatchEvent(new CustomEvent(OUTCOME_UNKNOWN_EVENT, { detail: { id: 'dev:1:7', type: 'native:send', outcome: 'unknown', sendId: (out as any).sendId } })); });
    await waitFor(() => expect(m.bubbles()[0].sendNote).toBe('not-sent'));
    expect(host.nativeSend).not.toHaveBeenCalled();
    expect(wire.native.send).toHaveBeenCalledTimes(1);
  });

  it('a lost answer for any OTHER kind of request does not touch a message', async () => {
    const wire = phoneWire(host);
    const m = mountPhone();
    wire.drop();
    await nativeSend(m);
    wire.restore();
    act(() => { window.dispatchEvent(new CustomEvent(OUTCOME_UNKNOWN_EVENT, { detail: { id: 'dev:1:9', type: 'permission:respond', outcome: 'unknown' } })); });
    await new Promise((r) => setTimeout(r, 10));
    expect(wire.session.sendOutcomes).toHaveBeenCalledTimes(1);     // only the one the send itself asked for
  });

  it('a refusal the computer actually gave is a failure the composer handles, not a note', async () => {
    const wire = phoneWire(host);
    const m = mountPhone();
    host.nativeSend.mockReturnValueOnce({ status: 'failed', reason: 'queue-full' } as any);
    const out = await nativeSend(m);
    expect(out.status).toBe('failed');
    expect(m.bubbles()).toHaveLength(0);
    expect(wire.session.sendOutcomes).not.toHaveBeenCalled();
  });
});

describe('the note on the message, and Send again', () => {
  it('shows what is known and how, with one button; a confirmed message shows no note at all', () => {
    const { rerender } = render(<UserMessage message={{ id: 'm1', role: 'user', content: 'hello', timestamp: 1 }} sessionId={S} showTimestamps={false} sendNote="unsure" onSendAgain={() => {}} />);
    expect(screen.getByRole('status').textContent).toContain('Not sure this was sent.');
    expect(screen.getByRole('button', { name: 'Send again' })).toBeTruthy();
    rerender(<UserMessage message={{ id: 'm1', role: 'user', content: 'hello', timestamp: 1 }} sessionId={S} showTimestamps={false} sendNote="not-sent" onSendAgain={() => {}} />);
    expect(screen.getByRole('status').textContent).toContain("This didn't send");
    expect(screen.getByRole('status').textContent).toContain('never received it');
    rerender(<UserMessage message={{ id: 'm1', role: 'user', content: 'hello', timestamp: 1 }} sessionId={S} showTimestamps={false} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send again' })).toBeNull();
  });

  it('Send again runs the person\'s own callback and nothing runs before that', () => {
    const again = vi.fn();
    render(<UserMessage message={{ id: 'm1', role: 'user', content: 'hello', timestamp: 1 }} sessionId={S} showTimestamps={false} sendNote="not-sent" onSendAgain={again} />);
    expect(again).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }));
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('sends the same words again as a NEW message with its own id, and the old bubble goes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const wire = phoneWire(host);
    const m = mountPhone();
    wire.drop();
    sendToClaudeCode({ sessionId: S, provider: 'claude', ptyText: 'build it', content: '/tmp/a.png build it', paths: ['/tmp/a.png'], dispatch: m.dispatch });
    act(() => { vi.advanceTimersByTime(2000); });
    wire.restore();
    const first = m.bubbles()[0];
    expect(first.message.attachments).toEqual(['/tmp/a.png']);
    sendAgain({ sessionId: S, sendId: first.sendId, provider: 'claude', content: first.message.content, attachments: first.message.attachments, dispatch: m.dispatch });
    act(() => { vi.advanceTimersByTime(2000); });
    vi.useRealTimers();
    const now = m.bubbles();
    expect(now).toHaveLength(1);
    expect(now[0].sendId).not.toBe(first.sendId);
    // The file path and then the text with its own id went out, once each.
    const writes = wire.session.sendInput.mock.calls.slice(-2).map((c) => c[1]);
    expect(writes).toEqual(['/tmp/a.png ', 'build it\r']);
    expect(host.sendInput).toHaveBeenCalledTimes(2);
  });

  it('takes the words and the files back out of a bubble the way the composer put them in', () => {
    expect(splitSentContent('/a b/c.png /d.txt look at these', ['/a b/c.png', '/d.txt'])).toEqual({ ptyText: 'look at these', paths: ['/a b/c.png', '/d.txt'] });
    expect(splitSentContent('plain', undefined)).toEqual({ ptyText: 'plain', paths: [] });
  });
});
