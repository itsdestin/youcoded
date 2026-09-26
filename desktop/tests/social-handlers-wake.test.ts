// Review B1 (2026-09-23): pins the WIRING in social-handlers.ts that releases
// the presence suspend latch — the input-type filter on webContents
// 'input-event' and the poller's wakeEvidence() call. The pure pieces are
// pinned in presence-socket.test.ts; this drives the real registration with a
// fake Electron (no windows, no network, no real sleep).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events') as typeof import('events');
  const powerMonitor = Object.assign(new EE(), { getSystemIdleTime: () => 0 });
  const app = new EE();
  const wc = Object.assign(new EE(), { isDestroyed: () => false, send: () => {} });
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const sock = {
    setDesired: vi.fn(), setSuspended: vi.fn(), setIdle: vi.fn(), send: vi.fn(),
    isConnected: vi.fn(() => false), repairIfStalled: vi.fn(() => false), destroy: vi.fn(),
  };
  return { powerMonitor, app, wc, handlers, sock };
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
}));

import { registerSocialHandlers, destroySocialHandlers } from '../src/main/social-handlers';

const MIN = 60_000;

describe('presence suspend latch — social-handlers wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
    for (const f of Object.values(h.sock)) (f as ReturnType<typeof vi.fn>).mockClear?.();
    registerSocialHandlers({ getToken: () => 'tok' } as never);
    h.handlers.get('social:presence-connect')!();
    h.powerMonitor.emit('suspend');
    expect(h.sock.setSuspended).toHaveBeenLastCalledWith(true);
    h.sock.setSuspended.mockClear();
  });
  afterEach(() => { destroySocialHandlers(); vi.useRealTimers(); });

  it('a resting cursor re-entering the window after wake does NOT release the latch', () => {
    vi.advanceTimersByTime(2 * MIN);
    (h.wc as EventEmitter).emit('input-event', {}, { type: 'mouseMove' });
    (h.wc as EventEmitter).emit('input-event', {}, { type: 'mouseEnter' });
    vi.advanceTimersByTime(15_000);
    expect(h.sock.setSuspended).not.toHaveBeenCalledWith(false);
  });

  it('an idle clock that reads 0 after sleep does NOT release the latch', () => {
    // getSystemIdleTime() is stubbed to 0 throughout — what a reset clock reports.
    vi.advanceTimersByTime(60 * MIN);
    expect(h.sock.setSuspended).not.toHaveBeenCalledWith(false);
  });

  it('a click in a YouCoded window after the grace period releases it on the next tick', () => {
    vi.advanceTimersByTime(2 * MIN);
    (h.wc as EventEmitter).emit('input-event', {}, { type: 'mouseDown' });
    vi.advanceTimersByTime(15_000);
    expect(h.sock.setSuspended).toHaveBeenCalledWith(false);
  });
});
