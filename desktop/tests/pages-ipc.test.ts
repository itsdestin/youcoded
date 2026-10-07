// The computer-window side of the live socket channels (table entries in main/ipc/pages.ts, owner plumbing in
// pages/page-owner.ts): who a socket's events go to, what happens when the window cannot be written to, and that a
// window going away closes what it held.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PAGE_SOCKET_CHANNELS, type PageSocketEvent } from '../src/shared/pages-types';
import type { SocketOwner } from '../src/main/pages/page-live-socket';

const service = vi.hoisted(() => ({ current: null as any }));
vi.mock('../src/main/pages/pages-service', () => ({ getPagesService: () => service.current }));

import { findChannel } from '../src/main/ipc/channel-table';
import { IPC } from '../src/shared/backend-contract';

let nextId = 7; // a window id is watched once per process, so each rig is its own window
function rig(send: (channel: string, event: unknown) => void, destroyed = () => false) {
  let owner: SocketOwner | null = null;
  const id = nextId++;
  const sender = { id, isDestroyed: destroyed, send, once: vi.fn(), on: vi.fn() };
  service.current = {
    sockets: { open: vi.fn(async (o: SocketOwner) => { owner = o; return { ok: true, socket: 's1' }; }), send: vi.fn(() => ({ ok: true })) },
    videos: { stop: vi.fn(() => ({ ok: true })) },
    closeOwner: vi.fn(),
    approve: vi.fn(async () => ({ ok: true })),
  };
  const call = (name: string, payload: unknown, s: unknown = sender) =>
    findChannel(name)!.handler(payload, { door: 'desktop', runtime: null, windowId: (s as any)?.id, sender: s, broadcast: () => {} } as never);
  return { sender, call, owner: () => owner!, service: service.current };
}
const event: PageSocketEvent = { socket: 's1', kind: 'messages', texts: ['x'] };
beforeEach(() => { service.current = null; });

describe('the window that owns a live socket', () => {
  it('is reached through the window that asked, on the socket event channel', async () => {
    const sent: Array<[string, unknown]> = [];
    const r = rig((c, e) => { sent.push([c, e]); });
    await r.call(PAGE_SOCKET_CHANNELS.open, { page: 'p', frame: 'f', url: 'u' });
    expect(r.owner().key).toBe(`window:${r.sender.id}`);
    expect(r.owner().push(event)).toBe('sent');
    expect(sent).toEqual([[PAGE_SOCKET_CHANNELS.event, event]]);
  });

  it('is reported gone, without throwing, when the window is destroyed or cannot be written to', async () => {
    // The push runs inside timers and socket callbacks: a throw there would be an uncaught error in the main process.
    const torn = rig(() => { throw new Error('Object has been destroyed'); });
    await torn.call(PAGE_SOCKET_CHANNELS.open, { page: 'p', frame: 'f', url: 'u' });
    expect(torn.owner().push(event)).toBe('gone');
    const dead = rig(() => {}, () => true);
    await dead.call(PAGE_SOCKET_CHANNELS.open, { page: 'p', frame: 'f', url: 'u' });
    expect(dead.owner().push(event)).toBe('gone');
  });

  it('is the calling window for send and video-stop too: the owner key is never read from the request', async () => {
    const r = rig(() => {});
    await r.call(IPC.PAGES_SOCKET_SEND, { page: 'p', frame: 'f', socket: 's1', text: 't', owner: 'window:99' });
    expect(r.service.sockets.send).toHaveBeenCalledWith(`window:${r.sender.id}`, expect.anything());
    await r.call(IPC.PAGES_VIDEO_STOP, { page: 'p', frame: 'f', video: 'v', owner: 'window:99' });
    expect(r.service.videos.stop).toHaveBeenCalledWith(`window:${r.sender.id}`, expect.anything());
  });

  it('closes everything it held when its page navigates (main frame only), crashes or is destroyed', async () => {
    const r = rig(() => {});
    await r.call(PAGE_SOCKET_CHANNELS.open, { page: 'p', frame: 'f', url: 'u' });
    await r.call(PAGE_SOCKET_CHANNELS.open, { page: 'p', frame: 'f', url: 'u' }); // watched once per window
    expect(r.sender.once).toHaveBeenCalledTimes(1);
    const nav = r.sender.on.mock.calls.find((c) => c[0] === 'did-start-navigation')![1];
    nav({ isMainFrame: false, isSameDocument: false }); nav({ isMainFrame: true, isSameDocument: true });
    expect(r.service.closeOwner).not.toHaveBeenCalled(); // an iframe or a hash change is not a reload
    nav({ isMainFrame: true, isSameDocument: false });
    expect(r.service.closeOwner).toHaveBeenLastCalledWith(`window:${r.sender.id}`);
    r.sender.on.mock.calls.find((c) => c[0] === 'render-process-gone')![1]();
    expect(r.service.closeOwner).toHaveBeenCalledTimes(2);
    r.sender.once.mock.calls[0][1]();
    expect(r.service.closeOwner).toHaveBeenCalledTimes(3);
  });

  it('refuses, rather than guesses, when the door cannot say which window is asking', async () => {
    const r = rig(() => {});
    expect(await r.call(PAGE_SOCKET_CHANNELS.open, { page: 'p', frame: 'f', url: 'u' }, null)).toMatchObject({ ok: false });
    expect(r.service.sockets.open).not.toHaveBeenCalled();
  });
});

describe('pages:approve, one entry for both doors', () => {
  it('a window may paste a key and a phone may not: the DOOR decides, and both pass the allowed addresses', async () => {
    const r = rig(() => {});
    const body = { id: 'personal:home', keys: { ha: 'k' }, addresses: { ha: '192.168.4.54:8123' } };
    await r.call(IPC.PAGES_APPROVE, body);
    expect(r.service.approve).toHaveBeenLastCalledWith('personal:home', { ha: 'k' }, { remote: false, addresses: { ha: '192.168.4.54:8123' } });
    const { serveRemoteChannel } = await import('../src/main/ipc/channel-table');
    await serveRemoteChannel(findChannel(IPC.PAGES_APPROVE)!, body, { door: 'remote', runtime: null, clientId: 'A', broadcast: () => {} } as never);
    expect(r.service.approve).toHaveBeenLastCalledWith('personal:home', { ha: 'k' }, { remote: true, addresses: { ha: '192.168.4.54:8123' } });
  });
});
