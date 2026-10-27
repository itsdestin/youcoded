// @vitest-environment jsdom
// Red means "the assistant is waiting on you", every time (notify-user plan Part 1): the Browser's card, Claude Code's terminal cards and a
// native session that failed to start turn the dot red on the computer (the REAL reducer + useSessionAttention) AND in the phone's summary
// (the REAL session record), and a phone can answer the Browser's card.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, render, screen, fireEvent } from '@testing-library/react';
import { makeStoreWrapper } from './helpers/chat-store-harness';
import { useSessionAttention, statusFromSummary } from '../src/renderer/hooks/useSessionAttention';
import { SessionRecords } from '../src/main/session-record';
import { routeSessionLive } from '../src/renderer/state/transcript-batch';
import { PhoneBrowserAskCard } from '../src/renderer/components/browser/BrowserAskCard';
import type { ChatAction } from '../src/renderer/state/chat-types';
import type { SessionLive } from '../src/shared/session-live-types';
import type { BrowserPrompt } from '../src/shared/browser-types';

const S = 's1';
const ask: BrowserPrompt = { kind: 'final', id: 'p1', message: 'Allow the assistant to place this order?', host: 'shop.example' };

function setup() {
  const { wrapper, store } = makeStoreWrapper([S]);
  const { result } = renderHook(() => useSessionAttention([{ id: S }, { id: 'other' }], new Set([S]), 'other'), { wrapper });
  const records = new SessionRecords();
  records.begin(S);
  // One host fact, delivered the way it really travels: noted by the record (phones), routed to the reducer (this window).
  const live = (body: Record<string, unknown>) => {
    const payload = { sessionId: S, ...body } as SessionLive;
    records.note(S, 'session:live', payload);
    act(() => routeSessionLive(payload, { batcher: { push: (a: ChatAction) => store.dispatch(a) }, contextTokens: () => null }));
  };
  const both = () => ({ computer: result.current.get(S)!.status, phone: statusFromSummary(records.summary(S)!, false) });
  return { live, both, store, records };
}

describe('the dot is red while the assistant waits on you', () => {
  it('for a Browser card, on both screens, and back once it is answered', () => {
    const { live, both, records } = setup();
    expect(both()).toEqual({ computer: 'gray', phone: 'gray' });
    live({ kind: 'browser-ask', prompt: ask });
    expect(both()).toEqual({ computer: 'red', phone: 'red' });
    // A phone that opens the conversation now is handed the card.
    expect(records.liveFill(S)).toContainEqual({ type: 'session:live', payload: { sessionId: S, kind: 'browser-ask', prompt: ask } });
    live({ kind: 'browser-ask', prompt: null });
    expect(both()).toEqual({ computer: 'gray', phone: 'gray' });
  });

  it("for Claude Code's terminal cards until answered or dismissed", () => {
    const { live, both, store } = setup();
    live({ kind: 'prompt-show', promptId: 'usage', title: 'Usage limit reached', buttons: [{ label: 'Wait', input: '1' }] });
    live({ kind: 'prompt-show', promptId: 'flag', title: 'Message flagged', buttons: [{ label: 'OK', input: '1' }] });
    expect(both()).toEqual({ computer: 'red', phone: 'red' });
    act(() => store.dispatch({ type: 'COMPLETE_PROMPT', sessionId: S, promptId: 'usage', selection: 'Wait' } as ChatAction));
    live({ kind: 'prompt-dismiss', promptId: 'usage' });
    expect(both()).toEqual({ computer: 'red', phone: 'red' });
    live({ kind: 'prompt-dismiss', promptId: 'flag' });
    expect(both()).toEqual({ computer: 'gray', phone: 'gray' });
  });

  it('for a native session that failed to start', () => {
    const { store, records, both } = setup();
    const failed = { phase: 'failed', attemptId: 'a', cause: 'tools', issues: [], canContinue: true, hostId: 'h', generation: 1, revision: 1 };
    records.note(S, 'session:live', { sessionId: S, kind: 'native-startup', state: failed });
    act(() => store.dispatch({ type: 'NATIVE_STARTUP_FAILED', sessionId: S, failed: true }));
    expect(both()).toEqual({ computer: 'red', phone: 'red' });
  });
});

describe("a phone answers the Browser's card", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const bridge = () => {
    const answer = vi.fn(async () => true);
    vi.stubGlobal('claude', { browser: { answer } });
    (window as any).claude = { browser: { answer } };
    return answer;
  };

  it('with the same choices as the computer', () => {
    const answer = bridge();
    render(<PhoneBrowserAskCard sessionId={S} prompt={ask} />);
    expect(screen.getByText('Allow the assistant to place this order?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow this once' }));
    expect(answer).toHaveBeenCalledWith(S, 'p1', 'once');
  });

  it("a hand-off says to do it on the computer and offers only I can't do this", () => {
    const answer = bridge();
    render(<PhoneBrowserAskCard sessionId={S} prompt={{ kind: 'handoff', id: 'p2', message: 'Sign in to your account.' }} />);
    expect(screen.getByText(/Do this in the browser on your computer/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: "I'm done" })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: "I can't do this" }));
    expect(answer).toHaveBeenCalledWith(S, 'p2', 'cant');
  });
});
