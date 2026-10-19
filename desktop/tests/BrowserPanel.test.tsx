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
    expect(screen.getByRole('tab', { name: 'Catalog' })).toHaveAttribute('aria-selected', 'true');
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

  it('the zoom pill shows the shared zoom and sends the person\'s steps to the browser', async () => {
    const b = installBrowserBridge();
    setBrowserState(browserState({ zoom: { percent: 45, auto: true } }));
    render(<BrowserPanel sessionId="s1" />);
    act(() => b.pushFrame('s1'));
    expect(screen.getByRole('button', { name: 'Reset to fit (currently 45%)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    await waitFor(() => expect(b.bridge.open).toHaveBeenCalledWith({ sessionId: 's1', zoom: 33 }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(b.bridge.open).toHaveBeenCalledWith({ sessionId: 's1', zoom: 50 }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to fit (currently 45%)' }));
    await waitFor(() => expect(b.bridge.open).toHaveBeenCalledWith({ sessionId: 's1', zoom: 'auto' }));
    // A zoom the assistant picked shows here too.
    act(() => setBrowserState(browserState({ zoom: { percent: 100, auto: false } })));
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    // A shown window or My Chrome can't be zoomed: no pill.
    act(() => setBrowserState(browserState({ zoom: null })));
    expect(screen.queryByRole('button', { name: 'Zoom out' })).not.toBeInTheDocument();
  });

  it('"Got it" hides the explainer at once, even if an older settings answer lands after', async () => {
    const b = installBrowserBridge(browserInfo({ settings: { ...browserInfo().settings, explainerSeen: false } }));
    setBrowserState(browserState());
    render(<BrowserPanel sessionId="s1" />);
    const gotIt = await screen.findByRole('button', { name: 'Got it' });
    // A settings load already on its way still says "not seen".
    let finishStale!: (i: ReturnType<typeof browserInfo>) => void;
    b.bridge.info.mockImplementationOnce(() => new Promise((r) => { finishStale = r; }));
    act(() => { for (const cb of b.bridge.onInfoChanged.mock.calls.map((c) => c[0])) cb(); });
    fireEvent.click(gotIt);
    expect(screen.queryByRole('button', { name: 'Got it' })).not.toBeInTheDocument();
    await act(async () => { finishStale(browserInfo({ settings: { ...browserInfo().settings, explainerSeen: false } })); });
    expect(screen.queryByRole('button', { name: 'Got it' })).not.toBeInTheDocument();
    expect(b.bridge.updateSettings).toHaveBeenCalledWith({ explainerSeen: true });
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
    fireEvent.click(screen.getByRole('button', { name: 'Try again' })); // every retry reads "Try again" (error-notices-1#EN-Q1)
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
    fireEvent.mouseDown(img, { button: 0, clientX: 150, clientY: 100, detail: 1 });
    fireEvent.mouseUp(window, { button: 0, clientX: 150, clientY: 100 });
    expect(b.bridge.input).toHaveBeenCalledWith('s1', { type: 'mouse', action: 'down', x: 100, y: 100, clickCount: 1 });
    expect(b.bridge.input).toHaveBeenCalledWith('s1', { type: 'mouse', action: 'up', x: 100, y: 100, clickCount: 1 });
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

  it('tabs: switch, close, open a new one, and Chrome\'s tab shortcuts on the page', async () => {
    const b = installBrowserBridge();
    const tab = (index: number, title: string, active = false) => ({ index, title, url: `https://example.org/${index}`, active, loading: false, canGoBack: false, canGoForward: false });
    setBrowserState(browserState({ tabs: [tab(0, 'First', true), tab(1, 'Second'), tab(2, 'Third')] }));
    render(<BrowserPanel sessionId="s1" />);
    // The tab is the title: no second row repeats it above the tabs.
    expect(screen.getAllByText('First')).toHaveLength(1);
    fireEvent.click(screen.getByRole('tab', { name: 'Second' }));
    expect(b.bridge.open).toHaveBeenCalledWith({ sessionId: 's1', tab: 'select', index: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Close Third' }));
    expect(b.bridge.open).toHaveBeenCalledWith({ sessionId: 's1', tab: 'close', index: 2 });
    // A new tab: opened, then the address box takes the typing.
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    expect(b.bridge.open).toHaveBeenCalledWith({ sessionId: 's1', tab: 'new' });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Address or search' })).toHaveFocus());
    // On the page: Ctrl+Tab goes to the next tab (wrapping), Ctrl+W closes this one.
    act(() => b.pushFrame('s1'));
    const page = screen.getByRole('application');
    b.bridge.open.mockClear();
    fireEvent.keyDown(page, { key: 'Tab', ctrlKey: true, shiftKey: true });
    expect(b.bridge.open).toHaveBeenCalledWith({ sessionId: 's1', tab: 'select', index: 2 });
    fireEvent.keyDown(page, { key: 'w', ctrlKey: true });
    expect(b.bridge.open).toHaveBeenCalledWith({ sessionId: 's1', tab: 'close', index: 0 });
    // None of them reached the page as keys.
    expect(b.bridge.input.mock.calls.filter(([, ev]: any) => ev.type === 'key')).toEqual([]);
  });

  it('back and forward grey out with nowhere to go, and reload becomes Stop while a page loads', () => {
    installBrowserBridge();
    setBrowserState(browserState({ tabs: [{ index: 0, title: 'Slow', url: 'https://example.org/', active: true, loading: true, canGoBack: true, canGoForward: false }] }));
    render(<BrowserPanel sessionId="s1" />);
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop loading' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
  });

  it('a new tab is named "New tab", its address box is empty and it says what to do', async () => {
    installBrowserBridge();
    setBrowserState(browserState({ tabs: [{ index: 0, title: 'about:blank', url: 'about:blank', active: true, loading: false, canGoBack: false, canGoForward: false }] }));
    render(<BrowserPanel sessionId="s1" />);
    expect(screen.getByRole('tab', { name: 'New tab' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Address or search' })).toHaveValue('');
    expect(screen.getByText('Type an address or a search above.')).toBeInTheDocument();
  });

  it('a mouse drag highlights on the page, and copy puts the highlight on the clipboard', async () => {
    const b = installBrowserBridge();
    b.bridge.selection.mockResolvedValue('alpha beta');
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText: vi.fn(async () => '') } });
    setBrowserState(browserState());
    render(<BrowserPanel sessionId="s1" />);
    act(() => b.pushFrame('s1')); // a 1280×800 page
    const img = screen.getByRole('img');
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 400, right: 640, bottom: 400, x: 0, y: 0, toJSON() {} });
    // Hovering (no button held) moves the page's pointer too: hover menus open.
    fireEvent.pointerMove(img, { pointerType: 'mouse', clientX: 50, clientY: 25 });
    await waitFor(() => expect(b.bridge.input).toHaveBeenCalledWith('s1', { type: 'mouse', action: 'move', x: 100, y: 50, clickCount: 1 }));
    fireEvent.mouseDown(img, { button: 0, clientX: 10, clientY: 10, detail: 1 });
    // Dragged past the picture's right edge: the highlight follows to the page's edge.
    fireEvent.mouseMove(window, { clientX: 900, clientY: 10 });
    await waitFor(() => expect(b.bridge.input).toHaveBeenCalledWith('s1', { type: 'mouse', action: 'move', x: 1280, y: 20, clickCount: 1 }));
    fireEvent.mouseUp(window, { clientX: 900, clientY: 10 });
    expect(b.bridge.input).toHaveBeenCalledWith('s1', { type: 'mouse', action: 'up', x: 1280, y: 20, clickCount: 1 });
    // Ctrl+C copies the page's highlight to the computer's clipboard.
    fireEvent.keyDown(screen.getByRole('application'), { key: 'c', ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('alpha beta'));
    // Right-click offers Copy for the same highlight.
    writeText.mockClear();
    fireEvent.contextMenu(img, { clientX: 20, clientY: 20 });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Copy/ }));
    expect(writeText).toHaveBeenCalledWith('alpha beta');
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
    fireEvent.mouseDown(img, { button: 0, clientX: 102, clientY: 101, detail: 1 });
    fireEvent.mouseUp(window, { button: 0, clientX: 102, clientY: 101 });
    const clicks = b.bridge.input.mock.calls.filter(([, ev]: any) => ev.type === 'click' || ev.type === 'mouse');
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
    expect(k('c', { ctrlKey: true })).toBe('copy');
    expect(k('x', { metaKey: true })).toBe('cut');
    expect(k('t', { ctrlKey: true })).toEqual({ panel: 'new-tab' });
    expect(k('l', { metaKey: true })).toEqual({ panel: 'address' });
    expect(k('ArrowLeft', { altKey: true })).toEqual({ panel: 'back' });
    expect(k('F5')).toEqual({ panel: 'reload' });
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
    expect(browserToolDisplay('BrowserHistory', { direction: 'back' }, false).label).toBe('Went back');
    expect(browserToolDisplay('BrowserZoom', { zoom: 50 }, true).label).toBe('Setting page zoom');
    expect(browserToolDisplay('BrowserNavigate', { zoom: 50 }, false).label).toBe('Set page zoom');
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
