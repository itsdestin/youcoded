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
    setDesired: vi.fn(), setHidden: vi.fn(), setSuspended: vi.fn(), setIdle: vi.fn(), send: vi.fn(() => true),
    isHiddenConfirmed: vi.fn(() => false),
    isConnected: vi.fn(() => false), repairIfStalled: vi.fn(() => false), destroy: vi.fn(),
  };
  const probe = vi.fn(async (): Promise<'yes' | 'no' | 'unknown'> => 'yes');
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

import { startSocial, destroySocialHandlers, getSocialOps } from '../src/main/social-handlers';

describe('presence-connect while incognito', () => {
  beforeEach(() => {
    for (const f of Object.values(h.sock)) (f as ReturnType<typeof vi.fn>).mockClear?.();
    h.sent.length = 0;
    // WHY startSocial + getSocialOps (merge of master, 2026-10-13): social:presence-connect became a channel-table
    // entry (main/ipc/social.ts) that calls this operation; nothing is registered with ipcMain any more.
    startSocial({ getToken: () => 'tok' } as never);
  });
  afterEach(() => { destroySocialHandlers(); });

  it('connects hidden when the server supports it', async () => {
    h.probe.mockResolvedValueOnce('yes');
    await getSocialOps()!.presenceConnect({ hidden: true });
    expect(h.sock.setHidden).toHaveBeenCalledWith(true);
    expect(h.sock.setDesired).toHaveBeenLastCalledWith(true);
  });

  it('an older server means NO connection at all, and the renderer is told why', async () => {
    h.probe.mockResolvedValueOnce('no');
    await getSocialOps()!.presenceConnect({ hidden: true });
    expect(h.sock.setDesired).not.toHaveBeenCalledWith(true);
    expect(h.sent).toContainEqual({ type: 'hidden-unsupported' });
  });

  // Final review F2: the order is the privacy guarantee — mode first (which opens nothing), the
  // server's answer second, and only then the one call that opens a socket.
  it('asks the server before anything can connect hidden', async () => {
    const order: string[] = [];
    h.sock.setHidden.mockImplementationOnce(() => { order.push('setHidden'); });
    h.probe.mockImplementationOnce(async () => { order.push('probe'); return 'yes'; });
    h.sock.setDesired.mockImplementationOnce(() => { order.push('setDesired'); });
    await getSocialOps()!.presenceConnect({ hidden: true });
    expect(order).toEqual(['setHidden', 'probe', 'setDesired']);
  });

  // Final review F26: a check still in flight must not act after a newer choice.
  it('a check that returns after a disconnect connects nothing', async () => {
    let answer!: (v: 'yes') => void;
    h.probe.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const pending = getSocialOps()!.presenceConnect({ hidden: true });
    getSocialOps()!.presenceDisconnect();
    answer('yes'); await pending;
    expect(h.sock.setDesired).not.toHaveBeenCalledWith(true);
  });

  it('a stale failed check cannot turn off a newer visible connection', async () => {
    let answer!: (v: 'no') => void;
    h.probe.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const stale = getSocialOps()!.presenceConnect({ hidden: true });
    await getSocialOps()!.presenceConnect({});
    expect(h.sock.setDesired).toHaveBeenLastCalledWith(true);
    answer('no'); await stale;
    expect(h.sock.setDesired).toHaveBeenLastCalledWith(true);
    expect(h.sent).not.toContainEqual({ type: 'hidden-unsupported' });
  });

  it('a hidden connection the server already confirmed is not re-checked', async () => {
    h.sock.isHiddenConfirmed.mockReturnValueOnce(true);
    h.probe.mockClear();
    await getSocialOps()!.presenceConnect({ hidden: true });
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.sock.setDesired).toHaveBeenLastCalledWith(true);
  });

  // Final review F4: "couldn't check" is not "the server can't": stay disconnected, say so, try again.
  describe('when the check cannot be made', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('stays disconnected, tells the renderer the check failed, and connects once a retry gets a yes', async () => {
      h.probe.mockResolvedValueOnce('unknown').mockResolvedValueOnce('unknown').mockResolvedValueOnce('yes');
      await getSocialOps()!.presenceConnect({ hidden: true });
      expect(h.sock.setDesired).not.toHaveBeenCalledWith(true);
      expect(h.sent).toContainEqual({ type: 'hidden-check-failed' });
      expect(h.sent).not.toContainEqual({ type: 'hidden-unsupported' });
      await vi.advanceTimersByTimeAsync(5_000);   // first retry: still unknown
      expect(h.sock.setDesired).not.toHaveBeenCalledWith(true);
      await vi.advanceTimersByTimeAsync(15_000);  // second retry: yes
      expect(h.sock.setDesired).toHaveBeenLastCalledWith(true);
    });

    it('a disconnect or sign-out stops the retries', async () => {
      h.probe.mockResolvedValue('unknown');
      await getSocialOps()!.presenceConnect({ hidden: true });
      getSocialOps()!.presenceDisconnect();
      h.probe.mockClear();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.probe).not.toHaveBeenCalled();
      h.probe.mockResolvedValue('yes');
    });

    it('an older server ("no") is final: no retries', async () => {
      h.probe.mockResolvedValueOnce('no');
      await getSocialOps()!.presenceConnect({ hidden: true });
      h.probe.mockClear();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.probe).not.toHaveBeenCalled();
    });
  });

  // Final review F30: a frame the hidden socket dropped is reported as not sent.
  it('presenceSend reports a dropped frame as a failure', () => {
    h.sock.isConnected.mockReturnValueOnce(true);
    h.sock.send.mockReturnValueOnce(false);
    expect(getSocialOps()!.presenceSend({ type: 'status', status: 'idle' })).toMatchObject({ ok: false });
  });

  it('not incognito connects visibly without asking', async () => {
    h.probe.mockClear();
    await getSocialOps()!.presenceConnect({});
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.sock.setHidden).toHaveBeenCalledWith(false);
    expect(h.sock.setDesired).toHaveBeenLastCalledWith(true);
  });
});

// WHY (2026-11-01 phone: Games stuck on "Connecting…"): startSocial builds a fresh socket that starts with desired=off. A connect
// the renderer already made must carry over to it, or the new socket sits idle until the page happens to ask again.
describe('a rebuilt social service keeps the renderer\'s wish to be connected', () => {
  afterEach(() => { destroySocialHandlers(); });

  it('re-applies a visible connect to the new socket', async () => {
    startSocial({ getToken: () => 'tok' } as never);
    await getSocialOps()!.presenceConnect({ hidden: false });
    h.sock.setDesired.mockClear();
    startSocial({ getToken: () => 'tok' } as never); // the rebuild
    await Promise.resolve();
    expect(h.sock.setDesired).toHaveBeenCalledWith(true);
  });

  it('does not connect a rebuilt socket after the renderer disconnected', async () => {
    startSocial({ getToken: () => 'tok' } as never);
    await getSocialOps()!.presenceConnect({ hidden: false });
    getSocialOps()!.presenceDisconnect();
    h.sock.setDesired.mockClear();
    startSocial({ getToken: () => 'tok' } as never);
    await Promise.resolve();
    expect(h.sock.setDesired).not.toHaveBeenCalledWith(true);
  });
});
