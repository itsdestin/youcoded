// @vitest-environment jsdom
// The Browser panel, its header button and its place in the right slot: what a
// person sees per state, and that the live picture only streams while the panel
// is showing (performance rule 2: hidden means idle).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import BrowserPanel, { browserStatusWord, keyEventFor, pagePoint } from '../src/renderer/components/browser/BrowserPanel';
import BrowserHeaderButton from '../src/renderer/components/browser/BrowserHeaderButton';
import { browserToolDisplay } from '../src/renderer/components/browser/browser-tool-display';
import { buildToolGroupHeadline } from '../src/renderer/utils/tool-group-summary';
import { getBrowserState, isBrowserExpanded, isBrowserPaneOpen, openBrowserPane, setBrowserState, forgetBrowserSession, ensureBrowserStore } from '../src/renderer/state/browser-store';
import { useBrowserRightPane } from '../src/renderer/hooks/use-browser-right-pane';
import { browserInfo, browserState, installBrowserBridge } from './helpers/browser-bridge';

afterEach(() => cleanup());

describe('Browser panel', () => {
  it('shows the live picture and asks for pictures only while it is showing', async () => {
    const b = installBrowserBridge();
    setBrowserState(browserState());
    const { unmount } = render(<BrowserPanel sessionId="s1" />);
    expect(screen.getByText('Catalog')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Address or search' })).toHaveValue('https://library.example.org/catalog');
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

  it('with nothing open it says so, never starts a browser by itself, and offers no window to show', () => {
    const b = installBrowserBridge();
    render(<BrowserPanel sessionId="s1" />);
    expect(screen.getByText(/Nothing is open\. Type an address or a search above/)).toBeInTheDocument();
    expect(b.bridge.watch).not.toHaveBeenCalled();
    expect(b.bridge.open).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Show window' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });

  it('the person can type an address or a search and open it themselves', async () => {
    const b = installBrowserBridge();
    render(<BrowserPanel sessionId="s1" />);
    const box = screen.getByRole('textbox', { name: 'Address or search' });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'night circus' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(b.bridge.open).toHaveBeenCalledWith({ sessionId: 's1', address: 'night circus' }));
    // A refusal is said under the box, in the worker's words.
    b.bridge.open.mockResolvedValueOnce({ ok: false, error: 'That address is a special network address the browser never opens.' });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '169.254.169.254' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('never opens');
  });

  it('back, forward and reload work the conversation\'s current tab', async () => {
    const b = installBrowserBridge();
    setBrowserState(browserState());
    render(<BrowserPanel sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(b.bridge.open).toHaveBeenCalledWith({ sessionId: 's1', nav: 'reload' }));
    expect(b.bridge.open).toHaveBeenCalledWith({ sessionId: 's1', nav: 'back' });
  });

  it('clicks, scrolls and typing on the picture go to the page, and no key reaches the app', async () => {
    const b = installBrowserBridge();
    setBrowserState(browserState());
    render(<BrowserPanel sessionId="s1" />);
    act(() => b.pushFrame('s1')); // a 1280×800 page
    const img = screen.getByRole('img');
    // Drawn at half size: 640×400 at (100, 50).
    img.getBoundingClientRect = () => ({ left: 100, top: 50, width: 640, height: 400, right: 740, bottom: 450, x: 100, y: 50, toJSON() {} });
    fireEvent.click(img, { clientX: 150, clientY: 100, detail: 1 });
    expect(b.bridge.input).toHaveBeenCalledWith('s1', { type: 'click', x: 100, y: 100, clickCount: 1, button: 'left' });
    const page = screen.getByRole('application');
    let reachedApp = 0;
    const appListener = () => { reachedApp++; };
    window.addEventListener('keydown', appListener);
    fireEvent.keyDown(page, { key: 'a' });
    fireEvent.keyDown(page, { key: 'Escape' });
    window.removeEventListener('keydown', appListener);
    expect(b.bridge.input).toHaveBeenCalledWith('s1', { type: 'text', text: 'a' });
    expect(b.bridge.input).toHaveBeenCalledWith('s1', { type: 'key', key: 'Escape' });
    expect(reachedApp).toBe(0);
    // The app's global shortcuts treat the picture as a place being typed into.
    expect(page).toHaveAttribute('data-keyboard-owner');
  });

  it('a finger drag scrolls the page and a tap clicks it (touchscreens)', async () => {
    const b = installBrowserBridge();
    setBrowserState(browserState());
    render(<BrowserPanel sessionId="s1" />);
    act(() => b.pushFrame('s1')); // a 1280×800 page
    const img = screen.getByRole('img');
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 400, right: 640, bottom: 400, x: 0, y: 0, toJSON() {} });
    // Tap: one click, not a second one from the browser's follow-on click event.
    fireEvent.pointerDown(img, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 });
    fireEvent.pointerUp(img, { pointerId: 1, pointerType: 'touch', clientX: 102, clientY: 101 });
    fireEvent.click(img, { clientX: 102, clientY: 101, detail: 1 });
    const clicks = b.bridge.input.mock.calls.filter(([, ev]: any) => ev.type === 'click');
    expect(clicks).toEqual([['s1', { type: 'click', x: 204, y: 202, clickCount: 1, button: 'left' }]]);
    // Drag up 50 screen px = scroll down 100 page px (the picture is drawn at half size).
    fireEvent.pointerDown(img, { pointerId: 2, pointerType: 'touch', clientX: 100, clientY: 300 });
    fireEvent.pointerMove(img, { pointerId: 2, pointerType: 'touch', clientX: 100, clientY: 250 });
    await waitFor(() => expect(b.bridge.input).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'wheel', dx: 0, dy: 100 })));
  });

  it('maps keys and picture points the way the page needs them', () => {
    const k = (key: string, m: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => keyEventFor({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...m });
    expect(k('é')).toEqual({ type: 'text', text: 'é' });
    expect(k('Tab', { shiftKey: true })).toEqual({ type: 'key', key: 'Shift+Tab' });
    expect(k('a', { ctrlKey: true })).toEqual({ type: 'key', key: 'Control+a' });
    expect(k('v', { metaKey: true })).toBe('paste');
    expect(k('Shift', { shiftKey: true })).toBeNull();
    // Contained and centred: a picture area wider than the page has margins left and right.
    expect(pagePoint({ left: 0, top: 0, width: 800, height: 400 }, { w: 400, h: 400 }, 200, 10)).toEqual({ x: 0, y: 10 });
    expect(pagePoint({ left: 0, top: 0, width: 800, height: 400 }, { w: 400, h: 400 }, 100, 10)).toBeNull();
  });

  it('tells the browser the picture area\'s size, so a hidden page is laid out to fit', async () => {
    const observed: Array<(e: any[]) => void> = [];
    const original = (globalThis as any).ResizeObserver;
    (globalThis as any).ResizeObserver = class { constructor(cb: (e: any[]) => void) { observed.push(cb); } observe() {} disconnect() {} };
    try {
      const b = installBrowserBridge();
      setBrowserState(browserState());
      render(<BrowserPanel sessionId="s1" />);
      act(() => { for (const cb of observed) cb([{ contentRect: { width: 452, height: 760 } }]); });
      await waitFor(() => expect(b.bridge.viewSize).toHaveBeenCalledWith('s1', 452, 760));
    } finally {
      (globalThis as any).ResizeObserver = original;
    }
  });

  it('has Session Files\' header buttons: open in your own browser, copy link, expand, close', async () => {
    const b = installBrowserBridge();
    const openExternal = vi.fn(async () => {});
    (window as any).claude.shell = { openExternal };
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setBrowserState(browserState());
    openBrowserPane('s1');
    render(<BrowserPanel sessionId="s1" />);
    // The old window toggle and ••• menu are gone from the panel.
    expect(screen.queryByRole('button', { name: /window/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More browser actions' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open in your own browser' }));
    expect(openExternal).toHaveBeenCalledWith('https://library.example.org/catalog');
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://library.example.org/catalog'));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand panel' }));
    expect(isBrowserExpanded('s1')).toBe(true);
    expect(screen.getByRole('button', { name: 'Shrink panel' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(isBrowserPaneOpen('s1')).toBe(false);
    // Closing ends the expansion: the panel reopens at the side.
    expect(isBrowserExpanded('s1')).toBe(false);
    expect(b.bridge.setShowWindow).not.toHaveBeenCalled();
  });

  it('the first-time explainer goes away for good with Got it', async () => {
    const b = installBrowserBridge(browserInfo({ settings: { ...browserInfo().settings, explainerSeen: false } }));
    setBrowserState(browserState());
    render(<BrowserPanel sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(b.bridge.updateSettings).toHaveBeenCalledWith({ explainerSeen: true }));
  });

  it('in My Chrome it says the work happens in the person\'s own Chrome', () => {
    installBrowserBridge();
    setBrowserState(browserState({ myChrome: true, windowShown: true }));
    render(<BrowserPanel sessionId="s1" />);
    expect(screen.getByText(/Working in your Chrome/)).toBeInTheDocument();
  });
});

describe('Browser header button', () => {
  it('is on every chat — the person can open the Browser before the assistant has used it', () => {
    installBrowserBridge();
    const { rerender } = render(<BrowserHeaderButton sessionId="s1" />);
    expect(screen.getByRole('button', { name: 'Browser' })).toBeInTheDocument();
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
