// @vitest-environment jsdom
// The Browser's ask card in the chat: one card for both session kinds, with the
// buttons each kind of ask offers and the answer each sends back.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BrowserAskCard, { browserCardCopy } from '../src/renderer/components/browser/BrowserAskCard';
import { isBrowserPaneOpen, setBrowserState } from '../src/renderer/state/browser-store';
import { browserState, installBrowserBridge } from './helpers/browser-bridge';

afterEach(() => cleanup());

function show(prompt: Parameters<typeof browserCardCopy>[0], over = {}) {
  const b = installBrowserBridge();
  setBrowserState(browserState({ prompt, ...over }));
  render(<BrowserAskCard sessionId="s1" />);
  return b;
}

describe('Browser ask card', () => {
  it('draws nothing when the browser is not asking', () => {
    installBrowserBridge();
    setBrowserState(browserState());
    const { container } = render(<BrowserAskCard sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('site permission: for this chat by default, Always as a second choice, Not now', async () => {
    const b = show({ kind: 'site', id: 'p1', host: 'github.com', allowAlways: true, message: 'Let the assistant click and type on github.com?' });
    expect(screen.getByText('Let the assistant click and type on github.com?')).toBeInTheDocument();
    expect(screen.getByText(/It still asks before sending, buying or deleting/)).toBeInTheDocument();
    // Each answer disables the buttons until it is sent; wait for them to come back.
    for (const [name, answer] of [['Always allow github.com', 'allow_always'], ['Allow for this chat', 'allow_chat'], ['Not now', 'no']] as const) {
      await waitFor(() => expect(screen.getByRole('button', { name })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name }));
      expect(b.bridge.answer).toHaveBeenLastCalledWith('s1', 'p1', answer);
    }
  });

  it('My Chrome never offers Always', () => {
    show({ kind: 'site', id: 'p1', host: 'mail.example', allowAlways: false, message: 'Let the assistant click and type on mail.example in your Chrome, where you\'re signed in?' });
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull();
    expect(screen.getByText(/This is your own Chrome/)).toBeInTheDocument();
  });

  it('final step: only "Allow this once" or "Don\'t"', () => {
    const b = show({ kind: 'final', id: 'p2', host: 'shop.example', message: 'The assistant wants to click "Place order" on shop.example.' });
    expect(screen.queryByRole('button', { name: /Always/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Allow this once' }));
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

  it('home-network address: explains why it asks', () => {
    show({ kind: 'local', id: 'p5', host: '192.168.1.1:80', message: 'The assistant wants to open 192.168.1.1:80, an address on this computer or your home network.' });
    expect(screen.getByText(/can control your router, your devices or programs/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow for this chat' })).toBeInTheDocument();
  });
});
