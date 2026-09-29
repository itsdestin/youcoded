// The channel table (one-core R2): an entry placed in it is served by BOTH doors, the desktop's
// ipcMain and the phone's RemoteServer, from the same handler and the same policy.
//
// R2 ships the table EMPTY, so every entry below is a test-only name (`test:*`), never a real
// channel. The empty-table pin at the top is meant to be deleted by R3, the run that moves the
// first real channel in.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('electron', () => {
  const BrowserWindowMock: any = vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }));
  BrowserWindowMock.getAllWindows = vi.fn(() => []);
  return {
    app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0-test'), whenReady: vi.fn(() => new Promise(() => {})), on: vi.fn(), quit: vi.fn(), setAppUserModelId: vi.fn(), commandLine: { appendSwitch: vi.fn() }, getGPUInfo: vi.fn(() => new Promise(() => {})) },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    BrowserWindow: BrowserWindowMock,
    Menu: { setApplicationMenu: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    dialog: { showOpenDialog: vi.fn() },
    clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) },
    nativeImage: {},
    shell: { openExternal: vi.fn() },
    powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
    webContents: { getAllWebContents: vi.fn(() => []) },
  };
});

import { registerIpcHandlers } from '../src/main/ipc-handlers';
import { registerWithRuntime } from './helpers/register-ipc';
import { RemoteServer } from '../src/main/remote-server';
import { CHANNEL_TABLE, type MainChannelDef } from '../src/main/ipc/channel-table';

const calls: Array<{ name: string; payload: any; door: string }> = [];
const testEntries: MainChannelDef[] = [
  {
    name: 'test:echo', kind: 'handle', messageKind: 'read',
    handler: (payload, ctx) => { calls.push({ name: 'test:echo', payload, door: ctx.door }); return { echoed: payload.value, doubled: payload.value * 2 }; },
  },
  {
    name: 'test:desktop-only', kind: 'handle', messageKind: 'user-action', desktopOnly: true,
    handler: (payload, ctx) => { calls.push({ name: 'test:desktop-only', payload, door: ctx.door }); return { ran: true }; },
  },
  {
    name: 'test:refused-with-answer', kind: 'handle', messageKind: 'user-action', remoteAllowed: false,
    refusal: { kind: 'reply', payload: { ok: false, error: 'host-admin' } },
    handler: (payload, ctx) => { calls.push({ name: 'test:refused-with-answer', payload, door: ctx.door }); return { ran: true }; },
  },
  {
    name: 'test:fire', kind: 'on', messageKind: 'transport',
    handler: (payload, ctx) => { calls.push({ name: 'test:fire', payload, door: ctx.door }); },
  },
  {
    name: 'test:throws', kind: 'handle', messageKind: 'read',
    handler: () => { throw new Error('boom from the handler'); },
  },
];

let server: RemoteServer;
let handlers: Map<string, (...args: any[]) => any>;
let listeners: Map<string, (...args: any[]) => any>;
let cleanup: () => Promise<void>;

function fakeClient() {
  const frames: any[] = [];
  const ws: any = Object.assign(new EventEmitter(), { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)), close: vi.fn(), ping: vi.fn() });
  return { frames, client: { id: 'sock', ws, deviceId: 'phone-1', ip: '127.0.0.1', connectedAt: Date.now() } };
}
let nextRequest = 0;
async function overRemote(type: string, payload: any) {
  const who = fakeClient();
  const id = `phone-1:1:${++nextRequest}`;
  await (server as any).handleMessage(who.client, JSON.stringify({ type, id, payload }));
  return who.frames.find((f) => f.type === `${type}:response` && f.id === id)?.payload;
}
const overIpc = (channel: string, payload: any) => handlers.get(channel)!({ sender: { id: 7 } }, payload);

beforeAll(() => {
  CHANNEL_TABLE.push(...testEntries);
  const sessionManager: any = Object.assign(new EventEmitter(), {
    createSession: vi.fn(), destroySession: vi.fn(), listSessions: vi.fn(() => []), sendInput: vi.fn(), resizeSession: vi.fn(),
  });
  const hookRelay: any = Object.assign(new EventEmitter(), { respond: vi.fn(() => true) });
  const config: any = { enabled: false, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
  server = new RemoteServer(sessionManager, hookRelay, config);
  const mockIpcMain: any = { handle: vi.fn(), on: vi.fn() };
  const mockWindow: any = { webContents: { send: vi.fn() }, isDestroyed: () => false };
  const mockSkillProvider: any = { configStore: { getPackages: vi.fn(() => ({})) }, install: vi.fn(), installMany: vi.fn(), ensureBundledPluginsInstalled: vi.fn(), ensureMigrated: vi.fn() };
  const wiring = registerWithRuntime(registerIpcHandlers, mockIpcMain, sessionManager, mockWindow, mockSkillProvider, undefined as any, hookRelay, config, server);
  cleanup = wiring.cleanup;
  handlers = new Map(mockIpcMain.handle.mock.calls.map((c: any) => [c[0], c[1]]));
  listeners = new Map(mockIpcMain.on.mock.calls.map((c: any) => [c[0], c[1]]));
});

afterAll(async () => {
  CHANNEL_TABLE.length = 0; // leave the module the way R2 ships it
  await cleanup?.();
});

describe('a table entry is served by both doors', () => {
  it('a handle entry answers the same value over Electron and over the phone socket', async () => {
    calls.length = 0;
    const ipc = await overIpc('test:echo', { value: 21 });
    const remote = await overRemote('test:echo', { value: 21 });
    expect(remote).toEqual(ipc);
    expect(remote).toEqual({ echoed: 21, doubled: 42 });
    // One handler, told which door called it.
    expect(calls.map((c) => c.door)).toEqual(['desktop', 'remote']);
    expect(calls.every((c) => c.payload.value === 21)).toBe(true);
  });

  it('desktop-only: Electron runs it, the phone gets the standard "not available" answer and the handler never runs', async () => {
    calls.length = 0;
    expect(await overIpc('test:desktop-only', { x: 1 })).toEqual({ ran: true });
    const remote = await overRemote('test:desktop-only', { x: 1 });
    expect(remote).toMatchObject({ ok: false, unsupported: true });
    expect(remote.error).toContain('test:desktop-only');
    expect(calls.map((c) => c.door)).toEqual(['desktop']);
  });

  it('a phone-refused entry answers its declared refusal, not the handler', async () => {
    calls.length = 0;
    expect(await overRemote('test:refused-with-answer', {})).toEqual({ ok: false, error: 'host-admin' });
    expect(calls).toHaveLength(0);
  });

  it('a fire-and-forget entry is registered with ipcMain.on and the phone gets no reply', async () => {
    calls.length = 0;
    listeners.get('test:fire')!({ sender: { id: 7 } }, { n: 1 });
    await new Promise((r) => setTimeout(r, 0));
    const who = fakeClient();
    await (server as any).handleMessage(who.client, JSON.stringify({ type: 'test:fire', payload: { n: 2 } }));
    expect(who.frames).toEqual([]);
    expect(calls.map((c) => [c.door, c.payload.n])).toEqual([['desktop', 1], ['remote', 2]]);
    expect(handlers.has('test:fire')).toBe(false);
  });

  it('a throwing handler rejects on Electron and answers {ok:false,error} on the phone', async () => {
    await expect(Promise.resolve().then(() => overIpc('test:throws', {}))).rejects.toThrow('boom from the handler');
    expect(await overRemote('test:throws', {})).toEqual({ ok: false, error: 'boom from the handler' });
  });

  it('a name that is not in the table still falls to the old switch (the phone default answer)', async () => {
    const remote = await overRemote('test:not-in-table', {});
    expect(remote).toMatchObject({ ok: false, unsupported: true });
  });
});
