// @vitest-environment jsdom
// The host side of a page's live socket: what PageHost does between the page's
// `youcoded.socket(...)` and main. Two layers — the hub on its own (shape checks,
// id mapping, pause while hidden, lease pings), and PageHost itself (a frame going
// away or its document changing closes every socket; a forged message resolves nothing).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import { PageHost } from '../src/renderer/components/pages/PageHost';
import { createPageSocketHub, RESUME_RETRY_MS, SOCKET_PING_MS } from '../src/renderer/components/pages/page-socket-host';
import type { PageSocketEvent } from '../src/shared/pages-types';

const snapshot = vi.hoisted(() => ({ current: { pages: [] as any[], loaded: true, failed: false } }));
vi.mock('../src/renderer/components/pages/use-pages', () => ({
  usePages: () => snapshot.current,
  refreshPages: vi.fn().mockResolvedValue(undefined),
  setPagePinned: vi.fn(),
}));

/** A scripted bridge: main's side of the four calls and the event push. */
function makeBridge() {
  let n = 0;
  const listeners = new Set<(e: PageSocketEvent) => void>();
  const bridge = {
    socketOpen: vi.fn(async () => ({ ok: true as const, socket: `m${++n}` })),
    socketSend: vi.fn(async () => ({ ok: true as const })),
    socketClose: vi.fn(async () => ({ ok: true as const })),
    socketPing: vi.fn(async () => ({ ok: true as const })),
    onSocketEvent: vi.fn((cb: (e: PageSocketEvent) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; }),
  };
  return { bridge, push: (e: PageSocketEvent) => listeners.forEach((l) => l(e)), listeners };
}

let visibility: 'visible' | 'hidden' = 'visible';
function setVisibility(v: 'visible' | 'hidden') {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
}
beforeEach(() => {
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

const OPEN = { type: 'youcoded:socket:open', id: 's1', url: 'http://ha.local:8123/api/websocket' };
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

function hubRig() {
  const m = makeBridge();
  const posted: any[] = [];
  const hub = createPageSocketHub({ pageId: 'personal:home', bridge: () => m.bridge as any, post: (x) => posted.push(x) });
  return { m, posted, hub };
}

describe('the hub between a page and main', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('opens through main, maps main\'s id to the page\'s own, and passes events both ways', async () => {
    const { m, posted, hub } = hubRig();
    expect(hub.handleFrameMessage(OPEN)).toBe(true);
    await flush();
    expect(m.bridge.socketOpen).toHaveBeenCalledWith(expect.objectContaining({ page: 'personal:home', url: OPEN.url, frame: expect.any(String) }));
    expect(posted[0]).toMatchObject({ type: 'youcoded:socket:event', id: 's1', kind: 'state', state: 'connecting' });
    m.push({ socket: 'm1', kind: 'state', state: 'open' });
    m.push({ socket: 'm1', kind: 'messages', texts: ['hello'] });
    expect(posted.at(-2)).toMatchObject({ id: 's1', kind: 'state', state: 'open' });
    expect(posted.at(-1)).toEqual({ type: 'youcoded:socket:event', id: 's1', kind: 'messages', texts: ['hello'] });
    // The page never sees main's id anywhere.
    expect(JSON.stringify(posted)).not.toContain('m1');
    hub.handleFrameMessage({ type: 'youcoded:socket:send', id: 's1', text: '{"type":"ping"}' });
    expect(m.bridge.socketSend).toHaveBeenCalledWith(expect.objectContaining({ socket: 'm1', text: '{"type":"ping"}' }));
    hub.dispose();
  });

  it('resolves nothing for a forged id, a wrong shape or an event it never mapped', async () => {
    const { m, posted, hub } = hubRig();
    hub.handleFrameMessage(OPEN);
    await flush();
    m.push({ socket: 'm1', kind: 'state', state: 'open' });
    const before = posted.length;
    m.push({ socket: 'someone-elses-socket', kind: 'messages', texts: ['x'] }); // not ours
    hub.handleFrameMessage({ type: 'youcoded:socket:send', id: 'sNope', text: '{"type":"ping"}' });
    hub.handleFrameMessage({ type: 'youcoded:socket:send', id: 's1', text: 42 });
    hub.handleFrameMessage({ type: 'youcoded:socket:send', id: 's1', text: 'x'.repeat(64_001) });
    hub.handleFrameMessage({ type: 'youcoded:socket:close', id: 'sNope' });
    hub.handleFrameMessage({ ...OPEN, id: 42 });
    hub.handleFrameMessage({ ...OPEN, id: 's1' }); // the page repeating an id it already opened
    expect(posted).toHaveLength(before);
    expect(m.bridge.socketSend).not.toHaveBeenCalled();
    expect(m.bridge.socketClose).not.toHaveBeenCalled();
    expect(m.bridge.socketOpen).toHaveBeenCalledTimes(1);
    expect(hub.handleFrameMessage({ type: 'youcoded:data:set' })).toBe(false); // not a socket message
    hub.dispose();
  });

  it('answers every open it will not make with "closed" and a plain reason, so the page never waits forever', async () => {
    const { m, posted, hub } = hubRig();
    hub.handleFrameMessage({ ...OPEN, id: 's2', url: 7 });
    expect(posted.at(-1)).toMatchObject({ id: 's2', kind: 'state', state: 'closed', why: expect.stringContaining('could not read') });
    hub.handleFrameMessage({ ...OPEN, id: 's3', url: 'x'.repeat(3000) });
    expect(posted.at(-1)).toMatchObject({ id: 's3', state: 'closed' });
    for (let i = 0; i < 8; i++) hub.handleFrameMessage({ ...OPEN, id: `k${i}` });
    hub.handleFrameMessage({ ...OPEN, id: 'ninth' });
    expect(posted.at(-1)).toMatchObject({ id: 'ninth', state: 'closed', why: expect.stringContaining('at most 8') });
    expect(m.bridge.socketOpen).toHaveBeenCalledTimes(8);
    hub.dispose();
  });

  it('tells the page every live socket is closed when the hub ends, so no handle is left "open"', async () => {
    const { m, posted, hub } = hubRig();
    hub.handleFrameMessage(OPEN);
    hub.handleFrameMessage({ ...OPEN, id: 's2' });
    await flush();
    m.push({ socket: 'm1', kind: 'state', state: 'open' });
    posted.length = 0;
    hub.dispose();
    expect(posted.map((p) => [p.id, p.state])).toEqual([['s1', 'closed'], ['s2', 'closed']]);
    expect(posted[0].why).toContain('not on screen');
  });

  it('stays paused, and asks again later, when main refuses the reopen after the window is shown again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { m, posted, hub } = hubRig();
    hub.handleFrameMessage(OPEN);
    await flush();
    m.push({ socket: 'm1', kind: 'state', state: 'open' });
    setVisibility('hidden');
    m.bridge.socketOpen.mockResolvedValueOnce({ ok: false, message: 'This page is opening live connections faster than the app allows.' } as any);
    setVisibility('visible');
    await flush();
    // Not 'closed': the page's socket worked before the hide, and the limit is momentary.
    expect(posted.at(-1)).toMatchObject({ id: 's1', state: 'paused', why: expect.stringContaining('faster than the app allows') });
    await vi.advanceTimersByTimeAsync(RESUME_RETRY_MS);
    await flush();
    expect(m.bridge.socketOpen).toHaveBeenCalledTimes(3);
    m.push({ socket: 'm2', kind: 'state', state: 'open' });
    expect(posted.at(-1)).toMatchObject({ id: 's1', state: 'open' });
    hub.dispose();
  });

  it('gives up with "closed" after repeated refusals when reopening, and a refused FIRST open is closed at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { m, posted, hub } = hubRig();
    hub.handleFrameMessage(OPEN);
    await flush();
    setVisibility('hidden');
    m.bridge.socketOpen.mockResolvedValue({ ok: false, message: 'No.' } as any);
    setVisibility('visible');
    for (let i = 0; i < 6; i++) { await flush(); await vi.advanceTimersByTimeAsync(RESUME_RETRY_MS); }
    await flush();
    expect(posted.at(-1)).toMatchObject({ id: 's1', state: 'closed', why: 'No.' });
    expect(vi.getTimerCount()).toBe(0);
    hub.dispose();
  });

  it('never sends before the socket is open', async () => {
    const { m, hub } = hubRig();
    hub.handleFrameMessage(OPEN);
    await flush();
    hub.handleFrameMessage({ type: 'youcoded:socket:send', id: 's1', text: '{"type":"ping"}' }); // still connecting
    expect(m.bridge.socketSend).not.toHaveBeenCalled();
    hub.dispose();
  });

  it('closes every socket when disposed, and one opened while the host waited is closed at once', async () => {
    const { m, hub } = hubRig();
    hub.handleFrameMessage(OPEN);
    hub.handleFrameMessage({ ...OPEN, id: 's2' });
    await flush();
    hub.dispose();
    expect(m.bridge.socketClose).toHaveBeenCalledTimes(2);
    expect(m.listeners.size).toBe(0);

    // The frame went away while main was still answering the open.
    const slow = hubRig();
    let release!: (r: { ok: true; socket: string }) => void;
    slow.m.bridge.socketOpen.mockImplementationOnce(() => new Promise((r) => { release = r as typeof release; }));
    slow.hub.handleFrameMessage(OPEN);
    slow.hub.dispose();
    release({ ok: true, socket: 'late' });
    await flush();
    expect(slow.m.bridge.socketClose).toHaveBeenCalledWith(expect.objectContaining({ socket: 'late' }));
  });

  it('closes in main when the window is hidden, tells the page "paused", and reopens when visible', async () => {
    const { m, posted, hub } = hubRig();
    hub.handleFrameMessage(OPEN);
    await flush();
    m.push({ socket: 'm1', kind: 'state', state: 'open' });
    setVisibility('hidden');
    expect(m.bridge.socketClose).toHaveBeenCalledWith(expect.objectContaining({ socket: 'm1' }));
    expect(posted.at(-1)).toMatchObject({ id: 's1', kind: 'state', state: 'paused' });
    // A late event from the closed connection is not the page's any more.
    m.push({ socket: 'm1', kind: 'messages', texts: ['late'] });
    expect(JSON.stringify(posted)).not.toContain('late');
    setVisibility('visible');
    await flush();
    expect(m.bridge.socketOpen).toHaveBeenCalledTimes(2); // one new slot, not one per event
    m.push({ socket: 'm2', kind: 'state', state: 'open' });
    expect(posted.at(-1)).toMatchObject({ id: 's1', state: 'open' });
    hub.dispose();
  });

  it('a socket the page opens while hidden waits, paused, until visible', async () => {
    visibility = 'hidden';
    const { m, posted, hub } = hubRig();
    hub.handleFrameMessage(OPEN);
    await flush();
    expect(m.bridge.socketOpen).not.toHaveBeenCalled();
    expect(posted[0]).toMatchObject({ state: 'paused' });
    setVisibility('visible');
    await flush();
    expect(m.bridge.socketOpen).toHaveBeenCalledTimes(1);
    hub.dispose();
  });

  it('a close while main is still answering an open leaves nothing behind (hide during connecting)', async () => {
    const { m, hub } = hubRig();
    let release!: (r: { ok: true; socket: string }) => void;
    m.bridge.socketOpen.mockImplementationOnce(() => new Promise((r) => { release = r as typeof release; }));
    hub.handleFrameMessage(OPEN);
    setVisibility('hidden');
    release({ ok: true, socket: 'orphan' });
    await flush();
    expect(m.bridge.socketClose).toHaveBeenCalledWith(expect.objectContaining({ socket: 'orphan' }));
    hub.dispose();
  });

  it('pings every 20 seconds while visible and open, and not while hidden', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { m, hub } = hubRig();
    hub.handleFrameMessage(OPEN);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SOCKET_PING_MS);
    expect(m.bridge.socketPing).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(SOCKET_PING_MS * 5);
    expect(m.bridge.socketPing).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    hub.dispose();
  });

  it('reports a refusal or a missing bridge plainly, as closed', async () => {
    const { m, posted, hub } = hubRig();
    m.bridge.socketOpen.mockResolvedValueOnce({ ok: false, message: 'A page may keep at most 2 live connections open.' } as any);
    hub.handleFrameMessage(OPEN);
    await flush();
    expect(posted.at(-1)).toMatchObject({ state: 'closed', why: expect.stringContaining('at most 2') });
    const none = createPageSocketHub({ pageId: 'p', bridge: () => undefined, post: (x) => posted.push(x) });
    none.handleFrameMessage({ ...OPEN, id: 's7' });
    expect(posted.at(-1)).toMatchObject({ id: 's7', state: 'closed', why: expect.stringContaining('cannot open live connections') });
    hub.dispose(); none.dispose();
  });
});

describe('PageHost closes a page\'s sockets with its frame', () => {
  const page = (html: string) => ({ id: 'personal:home', name: 'Home', description: '', icon: 'page', home: { kind: 'personal' }, pinned: false, updatedAt: '', htmlStamp: 1, connections: [], html, data: null });
  let m: ReturnType<typeof makeBridge>;
  let current = page('<p>one</p>');

  function Host({ pageId = 'personal:home', open = true }: { pageId?: string | null; open?: boolean }) {
    return (
      <ArtifactProvider value={{ state: { ...initialArtifactState, pageViewOpen: open, openPageId: pageId }, dispatch: vi.fn() }}>
        <PageHost settingsOpen={false} onToggleSettings={() => {}} onCreatePage={() => {}} />
      </ArtifactProvider>
    );
  }
  beforeEach(() => {
    m = makeBridge();
    current = page('<p>one</p>');
    snapshot.current.pages = [{ ...current, html: undefined }];
    (window as any).claude = { pages: { ...m.bridge, get: vi.fn(async () => ({ ok: true, page: current })), setData: vi.fn(async () => ({ ok: true })), list: vi.fn(async () => []) } };
  });
  afterEach(() => { delete (window as any).claude; });

  /** The page's script posting from inside its frame. */
  const fromFrame = (data: unknown, source?: Window | null) => {
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    act(() => { window.dispatchEvent(new MessageEvent('message', { data, source: source === undefined ? frame.contentWindow : source })); });
  };
  const openLive = async () => {
    // The page's script runs once its frame loads, so the host may not be listening yet on the
    // first try; the same id is ignored by the hub if it is sent twice.
    await waitFor(() => { fromFrame(OPEN); expect(m.bridge.socketOpen).toHaveBeenCalledTimes(1); });
    await flush();
  };

  it('opens through the bridge for the frame\'s page, and answers events into the frame', async () => {
    const view = render(<Host />);
    await waitFor(() => expect(document.querySelector('iframe')).toBeTruthy());
    await openLive();
    expect(m.bridge.socketOpen).toHaveBeenCalledWith(expect.objectContaining({ page: 'personal:home', url: OPEN.url }));
    view.unmount();
  });

  it('ignores a message that did not come from the frame', async () => {
    const view = render(<Host />);
    await waitFor(() => expect(document.querySelector('iframe')).toBeTruthy());
    await openLive(); // proves the host is listening, so the refusals below mean something
    fromFrame({ ...OPEN, id: 's2' }, null);
    fromFrame({ ...OPEN, id: 's3' }, window); // another sandboxed frame or the app itself is not this page
    await flush();
    expect(m.bridge.socketOpen).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('unmounting closes every socket', async () => {
    const view = render(<Host />);
    await waitFor(() => expect(document.querySelector('iframe')).toBeTruthy());
    await openLive();
    view.unmount();
    await waitFor(() => expect(m.bridge.socketClose).toHaveBeenCalledWith(expect.objectContaining({ socket: 'm1' })));
  });

  it('a new document in the frame (the page was edited) closes every socket', async () => {
    const view = render(<Host />);
    await waitFor(() => expect(document.querySelector('iframe')).toBeTruthy());
    await openLive();
    // The page's code changes: the list's stamp moves, the document is read again.
    current = page('<p>two</p>');
    snapshot.current.pages = [{ ...current, htmlStamp: 2, html: undefined }];
    view.rerender(<Host />);
    await waitFor(() => expect(m.bridge.socketClose).toHaveBeenCalledWith(expect.objectContaining({ socket: 'm1' })));
    view.unmount();
  });

  it('closing the page view closes every socket', async () => {
    const view = render(<Host />);
    await waitFor(() => expect(document.querySelector('iframe')).toBeTruthy());
    await openLive();
    view.rerender(<Host open={false} />);
    await waitFor(() => expect(m.bridge.socketClose).toHaveBeenCalledWith(expect.objectContaining({ socket: 'm1' })));
    view.unmount();
  });
});
