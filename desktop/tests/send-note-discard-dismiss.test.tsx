// @vitest-environment jsdom
// Discard / Dismiss on the "didn't send" / "not sure" note (sync-fix4, Destin: "there doesn't seem to be any way to dismiss if I don't want to send.
// Just a send again button"). Neither button ever sends anything.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import UserMessage from '../src/renderer/components/UserMessage';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { discardUnsent, RESTORE_UNSENT_EVENT } from '../src/renderer/state/submit-outgoing';

afterEach(() => { cleanup(); delete (window as any).claude; });
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

function state(note: 'unsure' | 'not-sent') {
  let s = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: S } as any);
  s = chatReducer(s, { type: 'USER_PROMPT', sessionId: S, content: 'hello', timestamp: 1, sendId: 'id1' } as any);
  return chatReducer(s, { type: 'SEND_NOTE', sessionId: S, sendId: 'id1', note } as any);
}
const bubbles = (s: any) => s.get(S).timeline.filter((e: any) => e.kind === 'user');

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
