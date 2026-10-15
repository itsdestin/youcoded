// The socket door's local mode (remote-local.ts): what the Android app's own page may do on the
// backend running beside it. A wrong token must never sign in, and the owner must get a window's
// answers — including for channels a visiting phone is refused — while Electron-only channels still refuse.
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => {
  const BrowserWindow: any = vi.fn();
  BrowserWindow.getAllWindows = () => [];
  BrowserWindow.fromWebContents = () => null;
  return {
    app: { relaunch: vi.fn(), exit: vi.fn(), dock: undefined },
    BrowserWindow,
    dialog: { showOpenDialog: vi.fn() },
    clipboard: { readImage: vi.fn() },
    nativeImage: {},
    shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    systemPreferences: {},
    powerSaveBlocker: { start: vi.fn(), stop: vi.fn() },
    webContents: { getAllWebContents: () => [], fromId: () => null },
    utilityProcess: { fork: vi.fn() },
  };
});

import { serveRemoteChannel } from '../src/main/ipc/channel-table';
import { localTokenMatches, ownerDesktopServices } from '../src/main/remote-local';

const ctx = (): any => ({ door: 'remote', runtime: null, broadcast: vi.fn() });
const def = (extra: Record<string, unknown>): any => ({ name: 'test:thing', kind: 'handle', handler: vi.fn(async (p: unknown) => ({ got: p })), ...extra });

describe('local sign-in token', () => {
  const token = 'x'.repeat(40);
  it('accepts only this run\'s token', () => {
    expect(localTokenMatches(token, token)).toBe(true);
    expect(localTokenMatches('y'.repeat(40), token)).toBe(false);
    expect(localTokenMatches(token.slice(1), token)).toBe(false);
    expect(localTokenMatches(undefined, token)).toBe(false);
    expect(localTokenMatches({ toString: () => token }, token)).toBe(false);
  });
});

describe('the owner page through the channel table', () => {
  it('runs a channel a visiting phone is refused', async () => {
    const d = def({ remoteAllowed: false });
    const visitor = await serveRemoteChannel(d, 1, ctx());
    expect(visitor).toMatchObject({ reply: true, payload: { ok: false, unsupported: true } });
    expect(d.handler).not.toHaveBeenCalled();
    const owner = await serveRemoteChannel(d, 1, ctx(), { owner: true });
    expect(owner).toEqual({ reply: true, payload: { got: 1 } });
  });

  it('runs a channel that is this device\'s own (desktopOnly), which a visiting phone is refused', async () => {
    const d = def({ desktopOnly: true });
    expect(await serveRemoteChannel(d, 1, ctx())).toMatchObject({ reply: true, payload: { unsupported: true } });
    expect(d.handler).not.toHaveBeenCalled();
    expect(await serveRemoteChannel(d, 1, ctx(), { owner: true })).toEqual({ reply: true, payload: { got: 1 } });
  });

  it('skips the phone\'s folder gate and size caps, keeps the reply shaping', async () => {
    const remoteGuard = vi.fn(async () => ({ ok: false, error: 'not your folder' }));
    const d = def({ remoteGuard, remotePayload: (p: any) => ({ ...p, maxBytes: 10 }), remoteReply: (r: any) => ({ wrapped: r }) });
    expect(await serveRemoteChannel(d, { a: 1 }, ctx(), { owner: true })).toEqual({ reply: true, payload: { wrapped: { got: { a: 1 } } } });
    expect(remoteGuard).not.toHaveBeenCalled();
    expect(await serveRemoteChannel(d, { a: 1 }, ctx())).toEqual({ reply: true, payload: { ok: false, error: 'not your folder' } });
  });
});

describe('window services for the owner page', () => {
  it('sends what a window would have been told to the sockets', () => {
    const broadcast = vi.fn();
    const s = ownerDesktopServices({ broadcast, sessionRoots: () => ['/a'], sessionManager: {} as any });
    s.sendToWindows('files:changed', { p: 1 });
    s.sendToPhones({ type: 'theme:changed', payload: 2 });
    expect(broadcast.mock.calls).toEqual([[{ type: 'files:changed', payload: { p: 1 } }], [{ type: 'theme:changed', payload: 2 }]]);
    expect(s.sessionRoots()).toEqual(['/a']);
  });
});
