// @vitest-environment jsdom
// The Browser's ask card in the chat: one card for both session kinds, with the
// buttons each kind of ask offers and the answer each sends back.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BrowserAskCard, { browserCardCopy } from '../src/renderer/components/browser/BrowserAskCard';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { isBrowserPaneOpen, setBrowserState } from '../src/renderer/state/browser-store';
import { browserState, installBrowserBridge } from './helpers/browser-bridge';

afterEach(() => cleanup());

function show(prompt: Parameters<typeof browserCardCopy>[0], over = {}) {
  const b = installBrowserBridge();
  setBrowserState(browserState({ prompt, ...over }));
  // ChatProvider: the permission asks are drawn by ToolCard, which reads the chat store like it does in the chat.
  render(<ChatProvider><BrowserAskCard sessionId="s1" /></ChatProvider>);
  return b;
}

describe('Browser ask card', () => {
  it('draws nothing when the browser is not asking', () => {
    installBrowserBridge();
    setBrowserState(browserState());
    const { container } = render(<ChatProvider><BrowserAskCard sessionId="s1" /></ChatProvider>);
    expect(container).toBeEmptyDOMElement();
  });

  it('site permission is the standard card: Yes (this chat), Always allow, No', async () => {
    const site = { kind: 'site', id: 'p1', host: 'github.com', allowAlways: true, message: 'Let the assistant click and type on github.com?' } as const;
    show(site);
    expect(screen.getByText('Let the assistant click and type on github.com?')).toBeInTheDocument();
    expect(screen.getByText('Using a website')).toBeInTheDocument();
    expect(screen.getByText(/It still asks before sending, buying or deleting/)).toBeInTheDocument();
    cleanup();
    // The card keeps its buttons off after an answer until the ask goes away, so each answer gets a fresh card.
    for (const [name, answer] of [['Always allow', 'allow_always'], ['Yes', 'allow_chat'], ['No', 'no']] as const) {
      const b = show(site);
      fireEvent.click(screen.getByRole('button', { name }));
      await waitFor(() => expect(b.bridge.answer).toHaveBeenLastCalledWith('s1', 'p1', answer));
      cleanup();
    }
  });

  it('My Chrome never offers Always', () => {
    show({ kind: 'site', id: 'p1', host: 'mail.example', allowAlways: false, message: 'Let the assistant click and type on mail.example in your Chrome, where you\'re signed in?' });
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull();
    expect(screen.getByText(/This is your own Chrome/)).toBeInTheDocument();
  });

  it('every permission ask is drawn BY ToolCard inside the chat\'s frosted ask bubble (reuse, not a look-alike)', () => {
    // Destin, 2026-11-02, rejecting two look-alikes: "we should reuse the existing style. why is it
    // transparent instead of frosted?" The bubble is the same wrapper ChatView puts tool asks in, and
    // the card is ToolCard's own (data-tool-use-id is ToolCard's root attribute).
    for (const kind of ['site', 'form', 'final', 'local'] as const) {
      show({ kind, id: 'p9', host: 'x.example', allowAlways: true, message: 'Question?' });
      const card = document.querySelector('[data-tool-use-id="browser-ask-p9"]');
      expect(card, kind).not.toBeNull();
      // glass rule is `.in-view .bg-inset`: the bubble must be a DESCENDANT of .in-view, not the same element
      const bubble = card!.closest('.assistant-bubble');
      expect(bubble, kind).toHaveClass('bg-inset');
      expect(bubble!.parentElement, kind).toHaveClass('in-view');
      expect(bubble, kind).not.toHaveClass('in-view');
      cleanup();
    }
  });

  it('form submit: Yes (once), Always allow, No; My Chrome never offers Always; Enter answers Yes like every ask', async () => {
    const form = { kind: 'form', id: 'p7', host: 'shop.example', allowAlways: true, message: 'Let the assistant submit a form on shop.example?' } as const;
    for (const [name, answer] of [['Always allow', 'allow_always'], ['Yes', 'once'], ['No', 'no']] as const) {
      const b = show(form);
      fireEvent.click(screen.getByRole('button', { name }));
      await waitFor(() => expect(b.bridge.answer).toHaveBeenLastCalledWith('s1', 'p7', answer));
      cleanup();
    }
    show(form);
    expect(screen.getByText('Let the assistant submit a form on shop.example?')).toBeInTheDocument();
    expect(screen.getByText('Sending a form')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes' })).toHaveClass('bg-green-400/60');
    expect(screen.getByRole('button', { name: 'No' })).toHaveClass('bg-red-400/60');
    expect(screen.getByText(/Always allow remembers shop.example/)).toBeInTheDocument();
    cleanup();
    // The standard keyboard walk: Enter takes the focused (first) button, Yes.
    const k = show({ kind: 'form', id: 'p10', host: 'shop.example', allowAlways: true, message: 'Send?' });
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(k.bridge.answer).toHaveBeenCalledWith('s1', 'p10', 'once'));
    cleanup();
    show({ kind: 'form', id: 'p8', host: 'mail.example', allowAlways: false, message: 'Let the assistant submit a form on mail.example in your Chrome, where you\'re signed in?' });
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull();
  });

  it('final step: Yes / No only, click-only (a stray Enter never buys)', () => {
    const b = show({ kind: 'final', id: 'p2', host: 'shop.example', message: 'The assistant wants to click "Place order" on shop.example.' });
    expect(screen.queryByRole('button', { name: /Always/ })).toBeNull();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(b.bridge.answer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(b.bridge.answer).toHaveBeenCalledWith('s1', 'p2', 'once');
  });

  it('needs you: I\'m done, Can\'t do this, open a window to sign in, show the browser', async () => {
    const b = show({ kind: 'handoff', id: 'p3', message: 'Please sign in to your library account.' });
    expect(screen.getByText('The assistant needs you in the browser')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show window' }));
    expect(b.bridge.openWindowForHandoff).toHaveBeenCalledWith('s1');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show the browser' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Show the browser' }));
    expect(isBrowserPaneOpen('s1')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'I can\'t do this' }));
    expect(b.bridge.answer).toHaveBeenCalledWith('s1', 'p3', 'cant');
    await waitFor(() => expect(screen.getByRole('button', { name: 'I\'m done' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'I\'m done' }));
    expect(b.bridge.answer).toHaveBeenCalledWith('s1', 'p3', 'done');
  });

  it('needs you, with the window already shown: no "Open window" button', () => {
    show({ kind: 'handoff', id: 'p3', message: 'Sign in please.' }, { windowShown: true });
    expect(screen.queryByRole('button', { name: 'Show window' })).toBeNull();
  });

  it('no browser: Download, then progress with Cancel', () => {
    const b = show({ kind: 'no-browser', id: 'p4', message: 'The assistant needs a browser for this.' });
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(b.bridge.answer).toHaveBeenCalledWith('s1', 'p4', 'download');
    act(() => setBrowserState(browserState({ prompt: null, downloadPercent: 42 })));
    expect(screen.getByText('Downloading a browser for the assistant… 42%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(b.bridge.cancelDownload).toHaveBeenCalled();
  });

  it('home-network address: explains why it asks; Yes covers the chat', () => {
    const b = show({ kind: 'local', id: 'p5', host: '192.168.1.1:80', message: 'The assistant wants to open 192.168.1.1:80, an address on this computer or your home network.' });
    expect(screen.getByText(/can control your router, your devices or programs/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Always/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(b.bridge.answer).toHaveBeenCalledWith('s1', 'p5', 'allow_chat');
  });
});
