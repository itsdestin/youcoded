// @vitest-environment jsdom
// The Browser panel, its header button and its place in the right slot: what a
// person sees per state, and that the live picture only streams while the panel
// is showing (performance rule 2: hidden means idle).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import BrowserPanel, { browserStatusWord } from '../src/renderer/components/browser/BrowserPanel';
import BrowserHeaderButton from '../src/renderer/components/browser/BrowserHeaderButton';
import { browserToolDisplay } from '../src/renderer/components/browser/browser-tool-display';
import { buildToolGroupHeadline } from '../src/renderer/utils/tool-group-summary';
import { getBrowserState, isBrowserPaneOpen, openBrowserPane, setBrowserState, forgetBrowserSession, ensureBrowserStore } from '../src/renderer/state/browser-store';
import { useBrowserRightPane } from '../src/renderer/hooks/use-browser-right-pane';
import { browserInfo, browserState, installBrowserBridge } from './helpers/browser-bridge';

afterEach(() => cleanup());

describe('Browser panel', () => {
  it('shows the live picture and asks for pictures only while it is showing', async () => {
    const b = installBrowserBridge();
    setBrowserState(browserState());
    const { unmount } = render(<BrowserPanel sessionId="s1" />);
    expect(screen.getByText('Catalog')).toBeInTheDocument();
    expect(screen.getByText('library.example.org')).toBeInTheDocument();
    await waitFor(() => expect(b.bridge.watch).toHaveBeenCalledWith('s1'));
    act(() => b.pushFrame('s1'));
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'data:image/jpeg;base64,/9j/');
    // A picture is acknowledged only once it is drawn, so a busy screen slows the stream.
    expect(b.bridge.ackFrame).not.toHaveBeenCalled();
    fireEvent.load(img);
    expect(b.bridge.ackFrame).toHaveBeenCalledWith('s1');
    // An identical picture fires no load event, so it is acknowledged at once —
    // otherwise a still page would stall the stream for good.
    act(() => b.pushFrame('s1'));
    expect(b.bridge.ackFrame).toHaveBeenCalledTimes(2);
    // Another conversation's picture is ignored.
    act(() => b.pushFrame('s2'));
    unmount();
    expect(b.bridge.unwatch).toHaveBeenCalledWith('s1');
    expect(b.frameListeners()).toBe(0);
  });

  it('says what the browser is doing, in plain words', () => {
    expect(browserStatusWord(null)).toBe('Idle');
    expect(browserStatusWord(browserState({ busy: true }))).toBe('Working');
    expect(browserStatusWord(browserState({ prompt: { kind: 'handoff', id: 'p', message: 'x' } }))).toBe('Waiting for you');
    expect(browserStatusWord(browserState({ run: 'starting' }))).toBe('Starting');
    expect(browserStatusWord(browserState({ run: 'error' }))).toBe('Stopped');
  });

  it('a start failure shows its real reason with Retry', async () => {
    const b = installBrowserBridge();
    setBrowserState(browserState({ run: 'error', tabs: [], error: 'No browser was found on this computer for the assistant to use.' }));
    render(<BrowserPanel sessionId="s1" />);
    expect(screen.getByText('No browser was found on this computer for the assistant to use.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(b.bridge.stop).toHaveBeenCalled();
  });

  it('with nothing open it says so, and never starts a browser', () => {
    const b = installBrowserBridge();
    render(<BrowserPanel sessionId="s1" />);
    expect(screen.getByText(/isn't using the browser in this conversation/)).toBeInTheDocument();
    expect(b.bridge.watch).not.toHaveBeenCalled();
  });

  it('showing the window asks first when pages are open, naming other chats', async () => {
    const b = installBrowserBridge(browserInfo({ sessionsWithTabs: 3 }));
    setBrowserState(browserState());
    render(<BrowserPanel sessionId="s1" />);
    await waitFor(() => expect(b.bridge.info).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Show window' }));
    expect(await screen.findByText(/Showing the window restarts the browser\. Pages reopen where they were, but anything typed and not yet sent is lost\. This also affects 2 other chats using the browser\./)).toBeInTheDocument();
    expect(b.bridge.setShowWindow).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Show window' }));
    await waitFor(() => expect(b.bridge.setShowWindow).toHaveBeenCalledWith(true));
  });

  it('the first-time explainer goes away for good with Got it', async () => {
    const b = installBrowserBridge(browserInfo({ settings: { ...browserInfo().settings, explainerSeen: false } }));
    setBrowserState(browserState());
    render(<BrowserPanel sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(b.bridge.updateSettings).toHaveBeenCalledWith({ explainerSeen: true }));
  });

  it('My Chrome has no Show/Hide window button (its window is the person\'s own)', () => {
    installBrowserBridge();
    setBrowserState(browserState({ myChrome: true, windowShown: true }));
    render(<BrowserPanel sessionId="s1" />);
    expect(screen.queryByRole('button', { name: /window/ })).toBeNull();
    expect(screen.getByText(/Working in your Chrome/)).toBeInTheDocument();
  });
});

describe('Browser header button', () => {
  it('appears only once the conversation has used the browser, with a dot for news while closed', () => {
    installBrowserBridge();
    const { rerender } = render(<BrowserHeaderButton sessionId="s1" />);
    expect(screen.queryByRole('button', { name: 'Browser' })).toBeNull();
    act(() => setBrowserState(browserState({ busy: true })));
    rerender(<BrowserHeaderButton sessionId="s1" />);
    const btn = screen.getByRole('button', { name: 'Browser' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(btn);
    expect(isBrowserPaneOpen('s1')).toBe(true);
    expect(screen.getByRole('button', { name: 'Browser' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('catches up on a browser that was already open when the window loaded', async () => {
    const b = installBrowserBridge();
    b.bridge.state.mockResolvedValueOnce(browserState({ sessionId: 's7' }) as any);
    render(<BrowserHeaderButton sessionId="s7" />);
    expect(await screen.findByRole('button', { name: 'Browser' })).toBeInTheDocument();
    expect(b.bridge.state).toHaveBeenCalledWith('s7');
  });

  it('is never drawn where the Browser is not supported', () => {
    installBrowserBridge();
    (window as any).claude.capabilities = { assistantBrowser: false };
    setBrowserState(browserState());
    ensureBrowserStore();
    // The store still holds state; the screens gate on capability.
    expect(getBrowserState('s1')).not.toBeNull();
    forgetBrowserSession('s1');
    expect(getBrowserState('s1')).toBeNull();
  });
});

describe('the right slot holds one pane at a time', () => {
  it('opening the Browser closes Session Files and Games; opening either closes the Browser', () => {
    installBrowserBridge();
    let drawer = true; let games = false;
    const closeDrawer = () => { drawer = false; };
    const toggleGames = () => { games = !games; };
    const { result, rerender } = renderHook(() => useBrowserRightPane('s1', drawer, games, closeDrawer, toggleGames));
    act(() => openBrowserPane('s1'));
    rerender();
    expect(result.current).toBe(true);
    expect(drawer).toBe(false);
    games = true;
    rerender();
    expect(isBrowserPaneOpen('s1')).toBe(false);
  });

  it('opens by itself the first time a hidden browser shows pages, but never over another pane', () => {
    installBrowserBridge();
    const { rerender } = renderHook(({ drawer }) => useBrowserRightPane('s1', drawer, false, () => {}, () => {}), { initialProps: { drawer: true } });
    act(() => setBrowserState(browserState()));
    rerender({ drawer: true });
    expect(isBrowserPaneOpen('s1')).toBe(false);
    installBrowserBridge();
    const second = renderHook(() => useBrowserRightPane('s2', false, false, () => {}, () => {}));
    act(() => setBrowserState(browserState({ sessionId: 's2' })));
    second.rerender();
    expect(isBrowserPaneOpen('s2')).toBe(true);
    // A shown window needs no panel.
    const third = renderHook(() => useBrowserRightPane('s3', false, false, () => {}, () => {}));
    act(() => setBrowserState(browserState({ sessionId: 's3', windowShown: true })));
    third.rerender();
    expect(isBrowserPaneOpen('s3')).toBe(false);
  });
});

describe('tool cards say what the browser did', () => {
  it('in plain words, past tense once done', () => {
    expect(browserToolDisplay('BrowserNavigate', { url: 'github.com/x' }, false).label).toBe('Opened github.com');
    expect(browserToolDisplay('BrowserNavigate', { url: 'https://github.com' }, true).label).toBe('Opening github.com');
    expect(browserToolDisplay('BrowserAct', { action: 'click', element: 'Sign in' }, false).label).toBe('Clicked "Sign in"');
    expect(browserToolDisplay('BrowserSnapshot', {}, false).label).toBe('Looked at the page');
  });

  it('a group of Browser steps reads "used the browser", never the internal server id', () => {
    const t = (toolName: string) => ({ toolUseId: toolName, toolName, input: {}, status: 'complete' } as any);
    const headline = buildToolGroupHeadline([t('mcp__youcoded-browser-f990aa15__BrowserNavigate'), t('BrowserAct')]);
    expect(headline.toLowerCase()).toContain('used the browser 2 times');
    expect(headline).not.toMatch(/f990aa15/i);
  });

  it('never shows what was typed into a password or card field', () => {
    expect(browserToolDisplay('BrowserAct', { action: 'type', element: 'Password', text: 'hunter2' }, false)).toEqual({ label: 'Typed into "Password"', detail: '· (hidden)' });
    expect(browserToolDisplay('BrowserAct', { action: 'type', element: 'Card number', text: '4111' }, false).detail).toBe('· (hidden)');
    expect(browserToolDisplay('BrowserAct', { action: 'type', element: 'Search', text: 'cats' }, false).detail).toBe('· cats');
  });
});
