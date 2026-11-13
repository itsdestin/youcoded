// @vitest-environment jsdom
// Card #205: the assistant's Browser asks for approvals a phone could not see (the click waited, timed out, then was refused as "already
// declined"). The computer now publishes the open card as a session fact; a phone draws it like every other approval card and answers it.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PhoneBrowserAskCard } from '../src/renderer/components/browser/BrowserAskCard';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { createSessionChatState } from '../src/renderer/state/chat-types';
import { routeSessionLive } from '../src/renderer/state/transcript-batch';
import { SessionRecords } from '../src/main/session-record';
import { SessionLiveFacts } from '../src/main/session-live';
import { installBrowserBridge } from './helpers/browser-bridge';
import type { BrowserPrompt } from '../src/shared/browser-types';

afterEach(() => cleanup());
const final: BrowserPrompt = { kind: 'final', id: 'p1', message: 'Allow the assistant to post this reply on reddit.com?', host: 'reddit.com' };

function host() {
  const out: any[] = [];
  const records = new SessionRecords();
  records.begin('s');
  const publish = (_s: string, _t: string, p: any) => { out.push(p); records.note('s', 'session:live', p); };
  return { out, records, live: new SessionLiveFacts({ publish, records, isClaude: () => true } as any) };
}

describe('the computer publishes the Browser card', () => {
  it('once when it opens, once when it closes, not on every Browser state push', () => {
    const { out, live } = host();
    live.browserAsk('s', final);
    live.browserAsk('s', final); // tabs/loading pushes carry the same card
    live.browserAsk('s', null);
    live.browserAsk('s', null);
    expect(out.map((p) => [p.kind, p.prompt?.id ?? null])).toEqual([['browser-ask', 'p1'], ['browser-ask', null]]);
  });

  it('a phone that opens the conversation while the card is waiting is handed it', () => {
    const { records, live } = host();
    live.browserAsk('s', final);
    expect(records.liveFill('s')).toContainEqual({ type: 'session:live', payload: { sessionId: 's', kind: 'browser-ask', prompt: final } });
    live.browserAsk('s', null);
    expect(records.liveFill('s').some((e: any) => e.payload.kind === 'browser-ask')).toBe(false);
  });
});

describe('the phone keeps the card in the conversation', () => {
  it('the fact reaches the conversation state and clears again', () => {
    let state: any = new Map([['s', createSessionChatState()]]);
    const push = (a: any) => { state = chatReducer(state, a); };
    routeSessionLive({ sessionId: 's', kind: 'browser-ask', prompt: final }, { batcher: { push }, contextTokens: () => null } as any);
    expect(state.get('s').browserAsk).toEqual(final);
    routeSessionLive({ sessionId: 's', kind: 'browser-ask', prompt: null }, { batcher: { push }, contextTokens: () => null } as any);
    expect(state.get('s').browserAsk).toBeNull();
  });
});

describe('the phone card', () => {
  const draw = (prompt: BrowserPrompt) => {
    const b = installBrowserBridge();
    render(<ChatProvider><PhoneBrowserAskCard sessionId="s1" prompt={prompt} /></ChatProvider>);
    return b;
  };

  it('is the same ToolCard ask as on the computer, and answers over browser:answer', async () => {
    const b = draw(final);
    expect(screen.getByText(final.message)).toBeInTheDocument();
    expect(document.querySelector('[data-tool-use-id="browser-ask-p1"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(b.bridge.answer).toHaveBeenCalledWith('s1', 'p1', 'once'));
  });

  it('No refuses', async () => {
    const b = draw(final);
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    await waitFor(() => expect(b.bridge.answer).toHaveBeenCalledWith('s1', 'p1', 'no'));
  });

  it('a hand-off says to do it on the computer and offers only I can\'t do this', async () => {
    const b = draw({ kind: 'handoff', id: 'p2', message: 'Please sign in to your account.' });
    expect(screen.getByText(/Do this in the browser on your computer/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "I'm done" })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: "I can't do this" }));
    await waitFor(() => expect(b.bridge.answer).toHaveBeenCalledWith('s1', 'p2', 'cant'));
  });
});
