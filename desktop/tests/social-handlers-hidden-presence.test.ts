// Incognito connects HIDDEN — but only to a server that promised to hide this device
// (presence-socket.ts HIDDEN MODE, guard 1). An older server would show the user online, so a
// "no" (or no answer) must leave presence OFF, never fall back to a visible connection.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events') as typeof import('events');
  const powerMonitor = Object.assign(new EE(), { getSystemIdleTime: () => 0 });
  const app = new EE();
  const sent: unknown[] = [];
  const wc = Object.assign(new EE(), { isDestroyed: () => false, send: (_ch: string, ev: unknown) => sent.push(ev) });
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const sock = {
    setDesired: vi.fn(), setHidden: vi.fn(), setSuspended: vi.fn(), setIdle: vi.fn(), send: vi.fn(),
    isConnected: vi.fn(() => false), repairIfStalled: vi.fn(() => false), destroy: vi.fn(),
  };
  const probe = vi.fn(async () => true);
  return { powerMonitor, app, wc, handlers, sock, probe, sent };
});

vi.mock('electron', () => ({
  app: h.app,
  powerMonitor: h.powerMonitor,
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(ch, fn),
    removeHandler: (ch: string) => h.handlers.delete(ch),
  },
  webContents: { getAllWebContents: () => [h.wc], fromId: () => h.wc },
}));
vi.mock('../src/main/logger', () => ({ log: () => {} }));
vi.mock('../src/main/presence-socket', async (orig) => ({
  ...(await orig<typeof import('../src/main/presence-socket')>()),
  createPresenceSocket: () => h.sock,
  probeHiddenPresence: () => h.probe(),
}));

import { registerSocialHandlers, destroySocialHandlers } from '../src/main/social-handlers';

describe('presence-connect while incognito', () => {
  beforeEach(() => {
    for (const f of Object.values(h.sock)) (f as ReturnType<typeof vi.fn>).mockClear?.();
    h.sent.length = 0;
    registerSocialHandlers({ getToken: () => 'tok' } as never);
  });
  afterEach(() => { destroySocialHandlers(); });

  it('connects hidden when the server supports it', async () => {
    h.probe.mockResolvedValueOnce(true);
    await h.handlers.get('social:presence-connect')!({}, { hidden: true });
    expect(h.sock.setHidden).toHaveBeenCalledWith(true);
    expect(h.sock.setDesired).toHaveBeenLastCalledWith(true);
  });

  it('an older server means NO connection at all, and the renderer is told why', async () => {
    h.probe.mockResolvedValueOnce(false);
    await h.handlers.get('social:presence-connect')!({}, { hidden: true });
    expect(h.sock.setDesired).not.toHaveBeenCalledWith(true);
    expect(h.sent).toContainEqual({ type: 'hidden-unsupported' });
  });

  it('not incognito connects visibly without asking', async () => {
    h.probe.mockClear();
    await h.handlers.get('social:presence-connect')!({}, {});
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.sock.setHidden).toHaveBeenCalledWith(false);
    expect(h.sock.setDesired).toHaveBeenLastCalledWith(true);
  });
});
