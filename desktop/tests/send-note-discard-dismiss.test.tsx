// @vitest-environment jsdom
// Discard / Dismiss on the "didn't send" / "not sure" note (sync-fix4, Destin: "there doesn't seem to be any way to dismiss if I don't want to send.
// Just a send again button"). Neither button ever sends anything.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import UserMessage from '../src/renderer/components/UserMessage';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { discardUnsent, sendAgain, retainFailedOutgoing, RESTORE_UNSENT_EVENT } from '../src/renderer/state/submit-outgoing';
import { resetNativeStartups, setNativeStartup } from '../src/renderer/state/native-startup-store';

afterEach(() => { cleanup(); resetNativeStartups(); delete (window as any).claude; });
const msg = { id: 'm1', role: 'user' as const, content: 'hello', timestamp: 1 };
const S = 's';

describe('the buttons on the note', () => {
  it('"didn\'t send" offers Send again and Discard, and no Dismiss', () => {
    render(<UserMessage message={msg} sessionId={S} showTimestamps={false} sendNote="not-sent" onSendAgain={() => {}} onDiscard={() => {}} />);
    expect(screen.getByRole('button', { name: 'Send again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard unsent message' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dismiss this note' })).toBeNull();
  });
  it('"not sure" offers Send again and Dismiss, and no Discard', () => {
    render(<UserMessage message={msg} sessionId={S} showTimestamps={false} sendNote="unsure" onSendAgain={() => {}} onDismiss={() => {}} />);
    expect(screen.getByRole('button', { name: 'Dismiss this note' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Discard unsent message' })).toBeNull();
  });
  it('each button runs only its own callback, and Send again is not among them', () => {
    const again = vi.fn(), discard = vi.fn(), dismiss = vi.fn();
    render(<UserMessage message={msg} sessionId={S} showTimestamps={false} sendNote="not-sent" onSendAgain={again} onDiscard={discard} onDismiss={dismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsent message' }));
    expect([again.mock.calls.length, discard.mock.calls.length, dismiss.mock.calls.length]).toEqual([0, 1, 0]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss this note' }));
    expect([again.mock.calls.length, discard.mock.calls.length, dismiss.mock.calls.length]).toEqual([0, 1, 1]);
  });
  it('the buttons are real buttons in reading order: Send again first, then the secondary one', () => {
    render(<UserMessage message={msg} sessionId={S} showTimestamps={false} sendNote="not-sent" onSendAgain={() => {}} onDiscard={() => {}} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Send again', 'Discard']);
  });
});

function state(note: 'unsure' | 'not-sent', attachments: string[] = []) {
  let s = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: S } as any);
  s = chatReducer(s, { type: 'USER_PROMPT', sessionId: S, content: [...attachments, 'hello'].join(' '), attachments, timestamp: 1, sendId: 'id1' } as any);
  return chatReducer(s, { type: 'SEND_NOTE', sessionId: S, sendId: 'id1', note } as any);
}
const bubbles = (s: any) => s.get(S).timeline.filter((e: any) => e.kind === 'user');

describe('retaining a refused message is not a new turn', () => {
  it('does not mistake an older identical transcript message for a known-refused draft', () => {
    let s = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: S });
    retainFailedOutgoing({ sessionId: S, provider: 'native', ptyText: 'same words', content: 'same words', paths: [],
      dispatch: action => { s = chatReducer(s, action); } },
    { status: 'failed', sendId: 'refused-earlier', result: { status: 'failed', reason: 'changed' } });
    s = chatReducer(s, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: S, text: 'same words', timestamp: 1, uuid: 'older-message' });
    expect(bubbles(s)).toHaveLength(2);
    expect(bubbles(s)).toContainEqual(expect.objectContaining({ sendId: 'refused-earlier', sendNote: 'not-sent', pending: true }));
    expect(bubbles(s)).toContainEqual(expect.objectContaining({ uuid: 'older-message', pending: false }));
  });
  it.each(['error', 'stalled'] as const)('preserves the existing %s state and its recovery controls', attentionState => {
    let s = state('not-sent');
    const runtime = { attentionState, errorMessage: attentionState === 'error' ? 'Existing provider error' : null,
      stalledSince: attentionState === 'stalled' ? 123 : null, isThinking: attentionState === 'stalled',
      currentTurnId: attentionState === 'stalled' ? 'parked-turn' : null };
    s.set(S, { ...s.get(S)!, ...runtime });
    retainFailedOutgoing({ sessionId: S, provider: 'native', ptyText: 'earlier text', content: '/tmp/a.png earlier text',
      paths: ['/tmp/a.png'], dispatch: action => { s = chatReducer(s, action); } },
    { status: 'failed', sendId: 'refused-earlier', result: { status: 'failed', reason: 'changed' } });
    expect(s.get(S)).toMatchObject(runtime);
    expect(bubbles(s).at(-1)).toMatchObject({ sendId: 'refused-earlier', sendNote: 'not-sent',
      message: { content: '/tmp/a.png earlier text', attachments: ['/tmp/a.png'] } });
  });
});

describe('Send again keeps the original recoverable message until admission', () => {
  it('keeps text and attachments if a native retry is refused', async () => {
    let finish!: (value: unknown) => void;
    const send = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    (window as any).claude = { native: { send }, session: {} };
    let s = state('not-sent', ['/tmp/a.png']);
    sendAgain({ sessionId: S, sendId: 'id1', provider: 'native', content: '/tmp/a.png hello', attachments: ['/tmp/a.png'], dispatch: action => { s = chatReducer(s, action); } });
    expect(bubbles(s)).toHaveLength(1);
    finish({ status: 'failed', reason: 'initializing' });
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(bubbles(s)[0]).toMatchObject({ sendId: 'id1', message: { content: '/tmp/a.png hello', attachments: ['/tmp/a.png'] } });
  });
  it('sends only once when Send again is pressed twice before its answer', async () => {
    let finish!: (value: unknown) => void;
    const send = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const notify = vi.fn();
    (window as any).claude = { native: { send }, session: {} };
    const args = { sessionId: S, sendId: 'double-retry', provider: 'native' as const, content: 'hello', attachments: [], dispatch: vi.fn(), onToast: notify };
    sendAgain(args);
    sendAgain(args);
    expect(send).toHaveBeenCalledOnce();
    finish({ status: 'failed', reason: 'initializing' });
    await waitFor(() => expect(notify).toHaveBeenCalledOnce());
    // A refusal keeps the old bubble usable: an explicit later retry is allowed.
    sendAgain(args);
    expect(send).toHaveBeenCalledTimes(2);
    finish({ status: 'sent' });
    await waitFor(() => expect(args.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'SEND_DISCARD', sendId: 'double-retry' })));
  });
  it('replaces the old bubble before drawing an accepted retry, preserving its thinking state', async () => {
    let finish!: (value: unknown) => void;
    const send = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    (window as any).claude = { native: { send }, session: {} };
    let s = state('not-sent');
    sendAgain({ sessionId: S, sendId: 'id1', provider: 'native', content: 'hello', attachments: [], dispatch: action => { s = chatReducer(s, action); } });
    expect(bubbles(s)[0].sendId).toBe('id1');
    finish({ status: 'sent' });
    await waitFor(() => expect(bubbles(s)[0].sendId).not.toBe('id1'));
    expect(bubbles(s)).toHaveLength(1);
    expect(s.get(S)!.isThinking).toBe(true);
  });
  it('does not submit or remove the old message while startup is blocked', () => {
    const send = vi.fn(); (window as any).claude = { native: { send }, session: {} };
    setNativeStartup(S, { phase: 'connecting', attemptId: 'a', hostId: 'h', generation: 1, revision: 1 });
    let s = state('not-sent');
    sendAgain({ sessionId: S, sendId: 'id1', provider: 'native', content: 'hello', attachments: [], dispatch: action => { s = chatReducer(s, action); } });
    expect(send).not.toHaveBeenCalled();
    expect(bubbles(s)[0].sendId).toBe('id1');
  });
});

describe('Dismiss keeps the bubble', () => {
  it('hides the note, keeps the pending bubble, and a later "still not sure" does not bring the note back', () => {
    let s = chatReducer(state('unsure'), { type: 'SEND_NOTE', sessionId: S, sendId: 'id1', note: null, dismissed: true } as any);
    expect(bubbles(s)).toHaveLength(1);
    expect(bubbles(s)[0].sendNote).toBeUndefined();
    expect(bubbles(s)[0].pending).toBe(true);
    const again = chatReducer(s, { type: 'SEND_NOTE', sessionId: S, sendId: 'id1', note: 'unsure' } as any);
    expect(again).toBe(s);
    // A definite answer still lands.
    s = chatReducer(s, { type: 'SEND_NOTE', sessionId: S, sendId: 'id1', note: 'not-sent' } as any);
    expect(bubbles(s)[0].sendNote).toBe('not-sent');
  });
  it('if the computer later confirms the message, it becomes a normal bubble', () => {
    let s = chatReducer(state('unsure'), { type: 'SEND_NOTE', sessionId: S, sendId: 'id1', note: null, dismissed: true } as any);
    s = chatReducer(s, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: S, text: 'hello', timestamp: 2, uuid: 'u1' } as any);
    expect(bubbles(s)).toHaveLength(1);
    expect(bubbles(s)[0].pending).toBeFalsy();
  });
});

describe('Discard removes the bubble and offers the words back, sending nothing', () => {
  it('removes only the unsent bubble and announces its words for the composer', () => {
    const send = vi.fn();
    (window as any).claude = { session: { sendInput: send }, native: { send } };
    const heard: any[] = [];
    const on = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener(RESTORE_UNSENT_EVENT, on);
    let s = state('not-sent');
    discardUnsent({ sessionId: S, sendId: 'id1', content: '/tmp/a.png hello there', attachments: ['/tmp/a.png'], dispatch: (a) => { s = chatReducer(s, a); } });
    window.removeEventListener(RESTORE_UNSENT_EVENT, on);
    expect(bubbles(s)).toHaveLength(0);
    expect(heard).toEqual([{ sessionId: S, text: 'hello there' }]);
    expect(send).not.toHaveBeenCalled();
  });
});
