// The desktop window's side of the live socket channels (pages-ipc.ts): who a socket's events go to,
// and what happens when the window cannot be written to.
import { describe, it, expect, vi } from 'vitest';
import { registerPagesIpc } from '../src/main/pages/pages-ipc';
import { PAGE_SOCKET_CHANNELS, type PageSocketEvent } from '../src/shared/pages-types';
import type { SocketOwner } from '../src/main/pages/page-live-socket';

function rig(send: (channel: string, event: unknown) => void, destroyed = () => false) {
  const handlers = new Map<string, (e: unknown, req?: unknown) => unknown>();
  const ipcMain = { handle: (ch: string, fn: (e: unknown, req?: unknown) => unknown) => { handlers.set(ch, fn); } };
  let owner: SocketOwner | null = null;
  const service = {
    ensureWatching: vi.fn(),
    sockets: { open: vi.fn(async (o: SocketOwner) => { owner = o; return { ok: true, socket: 's1' }; }) },
    closeOwner: vi.fn(),
  };
  registerPagesIpc(ipcMain as never, service as never);
  const sender = { id: 7, isDestroyed: destroyed, send, once: vi.fn(), on: vi.fn() };
  return { open: () => handlers.get(PAGE_SOCKET_CHANNELS.open)!({ sender }, { page: 'p', frame: 'f', url: 'u' }), owner: () => owner!, service };
}
const event: PageSocketEvent = { socket: 's1', kind: 'messages', texts: ['x'] };

describe('the window that owns a live socket', () => {
  it('is reached through the window that asked, on the socket event channel', async () => {
    const sent: Array<[string, unknown]> = [];
    const r = rig((c, e) => { sent.push([c, e]); });
    await r.open();
    expect(r.owner().key).toBe('window:7');
    expect(r.owner().push(event)).toBe('sent');
    expect(sent).toEqual([[PAGE_SOCKET_CHANNELS.event, event]]);
  });

  it('is reported gone, without throwing, when the window is destroyed or cannot be written to', async () => {
    // The push runs inside timers and socket callbacks: a throw there would be an uncaught error in the main process.
    const torn = rig(() => { throw new Error('Object has been destroyed'); });
    await torn.open();
    expect(torn.owner().push(event)).toBe('gone');
    const dead = rig(() => {}, () => true);
    await dead.open();
    expect(dead.owner().push(event)).toBe('gone');
  });
});
