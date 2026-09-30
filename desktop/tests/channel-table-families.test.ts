// The families moved into the channel table (one-core R3-1: tags, folders, defaults, modes,
// analytics, settings). Three kinds of check:
//   1. EVERY real table entry is served by both doors through its ONE handler (generic, so the
//      next run's families are covered the moment they are listed in the table).
//   2. No hand-written registration or `case` is left behind for a table name.
//   3. What the doors do that the handler does not: the phone's soft failure answers, refusals,
//      the tag change reaching every screen, and settings refusing unsafe paths on both doors.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'fs';
import os from 'os';
import path from 'path';

const windowSends: Array<[string, unknown]> = [];
vi.mock('electron', () => {
  const fakeWindow = { isDestroyed: () => false, webContents: { send: (c: string, p: unknown) => windowSends.push([c, p]) } };
  const BrowserWindowMock: any = vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }));
  BrowserWindowMock.getAllWindows = vi.fn(() => [fakeWindow]);
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

// A registry we control, so the tag entries can be driven without the sync-space plumbing.
const fakeRegistry = {
  create: vi.fn(async (label: string, color: string) => ({ id: 'tag_1', label, color, archived: false, createdAt: 'now' })),
  update: vi.fn(async (id: string, patch: any) => ({ id, label: patch.label ?? 'x', color: patch.color ?? 'tag-gray', archived: !!patch.archived, createdAt: 'now' })),
  delete: vi.fn(async () => {}),
  list: vi.fn(async () => []),
};
let registryOn = true;
vi.mock('../src/main/conversations/tag-registry-service', () => ({
  getTagRegistry: () => (registryOn ? fakeRegistry : null),
  listTagsForHost: async () => (registryOn ? [] : { ok: false, error: "tag storage isn't available" }),
}));
const metaChanged = vi.fn();
vi.mock('../src/main/conversations/service', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  emitConversationMetaChanged: () => metaChanged(),
}));

import { registerIpcHandlers } from '../src/main/ipc-handlers';
import { registerWithRuntime } from './helpers/register-ipc';
import { RemoteServer } from '../src/main/remote-server';
import { CHANNEL_TABLE } from '../src/main/ipc/channel-table';
import { foldersChannels } from '../src/main/ipc/folders';
import { IPC } from '../src/shared/backend-contract';
import { bindFirstRunManager } from '../src/main/ipc/first-run';

// R3-3: the skills family runs through these (bound by registerIpcHandlers).
const broadcastReloadPlugins = vi.fn();
const install = vi.fn(async () => ({ status: 'installed', type: 'plugin' }));
const uninstall = vi.fn(async () => ({ type: 'plugin' }));
// Stands in for the provider's own id resolution: a skill id names its parent plugin (see skill-provider-bundled.test.ts for the real one).
const resolveUninstallTarget = vi.fn(async (id: string) => (id === 'youcoded-chatsearch:chatsearch' ? 'youcoded-chatsearch' : id === 'some-plugin' ? 'some-plugin' : null));

let server: RemoteServer;
let handlers: Map<string, (...args: any[]) => any>;
let onHandlers: Map<string, (...args: any[]) => any>;
let cleanup: () => Promise<void>;
const windowBroadcasts: Array<[string, unknown]> = [];

function fakeClient() {
  const frames: any[] = [];
  const ws: any = Object.assign(new EventEmitter(), { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)), close: vi.fn(), ping: vi.fn() });
  return { frames, client: { id: 'sock', ws, deviceId: 'phone-1', ip: '127.0.0.1', connectedAt: Date.now() } };
}
let nextRequest = 0;
async function overRemote(type: string, payload?: any) {
  const who = fakeClient();
  const id = `phone-1:1:${++nextRequest}`;
  await (server as any).handleMessage(who.client, JSON.stringify({ type, id, payload }));
  return { answer: who.frames.find((f) => f.type === `${type}:response` && f.id === id)?.payload, frames: who.frames };
}
const overIpc = (channel: string, payload?: any) => handlers.get(channel)!({ sender: { id: 7 } }, payload);

beforeAll(() => {
  const sessionManager: any = Object.assign(new EventEmitter(), {
    createSession: vi.fn(), destroySession: vi.fn(), listSessions: vi.fn(() => []), sendInput: vi.fn(), resizeSession: vi.fn(),
    broadcastReloadPlugins,
  });
  const hookRelay: any = Object.assign(new EventEmitter(), { respond: vi.fn(() => true) });
  const config: any = { enabled: false, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
  server = new RemoteServer(sessionManager, hookRelay, config, undefined, {
    broadcastToWindows: (channel, payload) => windowBroadcasts.push([channel, payload]),
  });
  const mockIpcMain: any = { handle: vi.fn(), on: vi.fn() };
  const mockWindow: any = { webContents: { send: vi.fn() }, isDestroyed: () => false };
  const mockSkillProvider: any = { configStore: { getPackages: vi.fn(() => ({})) }, install, uninstall, resolveUninstallTarget, getInstalled: vi.fn(async () => [{ id: 'a-skill' }]), installMany: vi.fn(), ensureBundledPluginsInstalled: vi.fn(), ensureMigrated: vi.fn() };
  const wiring = registerWithRuntime(registerIpcHandlers, mockIpcMain, sessionManager, mockWindow, mockSkillProvider, undefined as any, hookRelay, config, server);
  cleanup = wiring.cleanup;
  handlers = new Map(mockIpcMain.handle.mock.calls.map((c: any) => [c[0], c[1]]));
  onHandlers = new Map(mockIpcMain.on.mock.calls.map((c: any) => [c[0], c[1]]));
});
afterAll(async () => { await cleanup?.(); });
beforeEach(() => { windowSends.length = 0; windowBroadcasts.length = 0; registryOn = true; metaChanged.mockClear(); });

describe('every table entry is served by both doors through its one handler', () => {
  it('the table lists the tags, folders, defaults, modes, analytics and settings channels', () => {
    const families = new Set(CHANNEL_TABLE.map((d) => d.name.split(':')[0]));
    for (const f of ['tags', 'folders', 'defaults', 'modes', 'analytics', 'settings']) expect(families.has(f)).toBe(true);
    expect(CHANNEL_TABLE.length).toBeGreaterThanOrEqual(17);
  });

  for (const def of CHANNEL_TABLE) {
    it(`${def.name}: desktop and phone run the same handler`, async () => {
      const original = def.handler;
      const seen: string[] = [];
      def.handler = (_payload: any, ctx: any) => { seen.push(ctx.door); return { sentinel: def.name }; };
      try {
        // A fire-and-forget entry has no answer on either door: it is called, and only that is visible.
        const desktop = def.kind === 'on' ? (onHandlers.get(def.name)!({ sender: { id: 7 } }, {}), undefined) : await overIpc(def.name, {});
        const phone = await overRemote(def.name, {});
        if (def.kind !== 'on') expect(desktop).toEqual({ sentinel: def.name });
        if (def.desktopOnly || def.remoteAllowed === false) {
          // Refused from the table: the handler never runs for a phone, and it gets the entry's declared refusal.
          expect(seen).toEqual(['desktop']);
          const refusal = def.refusal ?? { kind: 'unsupported' };
          if (refusal.kind === 'silent') expect(phone.frames).toEqual([]);
          else if (refusal.kind === 'reply') expect(phone.answer).toEqual(refusal.payload);
          else expect(phone.answer).toMatchObject({ ok: false, unsupported: true });
        } else {
          expect(seen).toEqual(['desktop', 'remote']);
          if (def.kind === 'on') expect(phone.frames).toEqual([]);
          else expect(phone.answer).toEqual({ sentinel: def.name });
        }
      } finally {
        def.handler = original;
      }
    });
  }
});

describe('nothing hand-written is left behind for a table name', () => {
  const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', f), 'utf-8');
  const remote = src('remote-server.ts');
  const desktop = src('ipc-handlers.ts');
  for (const def of CHANNEL_TABLE) {
    it(`${def.name} has no remote-server case and no ipcMain.handle of its own`, () => {
      expect(remote).not.toContain(`case '${def.name}'`);
      expect(desktop).not.toContain(`ipcMain.handle('${def.name}'`);
      // account:* used to be registered with double quotes in marketplace-api-handlers.ts.
      expect(src('marketplace-api-handlers.ts')).not.toContain(`ipcMain.handle("${def.name}"`);
      expect(desktop).not.toMatch(new RegExp(`ipcMain\\.handle\\(IPC\\.${def.name.toUpperCase().replace(/[:-]/g, '_')}\\b`));
    });
  }
});

describe('analytics is the computer\'s own switch: refused to a phone as before', () => {
  it('a phone gets the standard "not available over remote access" answer', async () => {
    const { answer } = await overRemote('analytics:get-opt-in');
    expect(answer).toEqual({ ok: false, error: "This feature isn't available over remote access yet (analytics:get-opt-in).", unsupported: true });
  });
});

describe('folders: a phone keeps the soft answers it always got when a folder call fails', () => {
  const boom = () => { throw new Error('disk trouble'); };
  const swap = async (name: string, run: () => Promise<void>) => {
    const def = foldersChannels.find((d) => d.name === name)!;
    const original = def.handler;
    def.handler = boom;
    try { await run(); } finally { def.handler = original; }
  };
  it('list falls back to Home, add to null, remove/rename/set-description to false', async () => {
    await swap('folders:list', async () => {
      const list = (await overRemote('folders:list')).answer;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ nickname: 'Home', path: os.homedir(), exists: true });
    });
    await swap('folders:add', async () => { expect((await overRemote('folders:add', { folderPath: '/x' })).answer).toBeNull(); });
    for (const n of ['folders:remove', 'folders:rename', 'folders:set-description']) {
      await swap(n, async () => { expect((await overRemote(n, { folderPath: '/x' })).answer).toBe(false); });
    }
  });
  it('the desktop still rejects (its renderer handles the failure), unchanged', async () => {
    await swap('folders:list', async () => {
      await expect(Promise.resolve().then(() => overIpc('folders:list'))).rejects.toThrow('disk trouble');
    });
  });
  it('a folder added from the phone shows in the computer\'s list, and the reverse', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r31-folder-'));
    try {
      await overRemote('folders:add', { folderPath: dir, nickname: 'from phone' });
      expect((await overIpc('folders:list') as any[]).some((f) => f.path === path.resolve(dir) && f.nickname === 'from phone')).toBe(true);
      expect(await overIpc('folders:remove', { folderPath: dir })).toBe(true);
      expect((await overRemote('folders:list')).answer.some((f: any) => f.path === path.resolve(dir))).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('tags: one body, and a change reaches every screen', () => {
  it('a tag created on a phone tells the phones AND the computer\'s windows', async () => {
    const { answer } = await overRemote('tags:create', { label: 'Work', color: 'tag-red' });
    expect(answer).toMatchObject({ ok: true, tag: { label: 'Work', color: 'tag-red' } });
    expect(windowBroadcasts).toEqual([['tags:changed', {}]]);
  });
  it('a tag created on the computer tells the computer\'s windows', async () => {
    await overIpc('tags:create', { label: 'Home', color: 'tag-blue' });
    expect(windowSends).toEqual([['tags:changed', {}]]);
  });
  it('an invalid colour becomes grey and a non-text label is made text, on the phone too', async () => {
    await overRemote('tags:create', { label: 'X', color: 'not-a-colour' });
    expect(fakeRegistry.create).toHaveBeenLastCalledWith('X', 'tag-gray');
    await overRemote('tags:update', { id: 'tag_1', patch: { label: 5, color: 'nope', archived: 1 } });
    expect(fakeRegistry.update).toHaveBeenLastCalledWith('tag_1', { label: '5', color: 'tag-gray', archived: true });
  });
  it('renaming or deleting a tag on a phone refreshes the search index, like the computer', async () => {
    await overRemote('tags:update', { id: 'tag_1', patch: { label: 'New' } });
    await overRemote('tags:delete', { id: 'tag_1' });
    expect(metaChanged).toHaveBeenCalledTimes(2);
  });
  it('with no registry, both doors answer the same failure and never an empty list', async () => {
    registryOn = false;
    for (const [name, payload] of [['tags:create', { label: 'a', color: 'tag-red' }], ['tags:update', { id: 'x', patch: {} }], ['tags:delete', { id: 'x' }]] as const) {
      expect((await overRemote(name, payload)).answer).toEqual({ ok: false, error: 'tag registry unavailable' });
      expect(await overIpc(name, payload)).toEqual({ ok: false, error: 'tag registry unavailable' });
    }
    expect((await overRemote('tags:list')).answer).toEqual({ ok: false, error: "tag storage isn't available" });
  });
});

describe('modes and defaults: same answer, same file, through either door', () => {
  it('modes set on a phone is read back by the computer, and the default is fast:false effort:auto', async () => {
    const file = path.join(os.homedir(), '.claude', 'youcoded-model-modes.json');
    fs.rmSync(file, { force: true });
    expect(await overIpc('modes:get')).toEqual({ fast: false, effort: 'auto' });
    expect((await overRemote('modes:set', { fast: true })).answer).toEqual({ fast: true, effort: 'auto' });
    expect(await overIpc('modes:get')).toEqual({ fast: true, effort: 'auto' });
    expect((await overRemote('modes:get')).answer).toEqual({ fast: true, effort: 'auto' });
    fs.rmSync(file, { force: true });
  });
  it('defaults: a non-object save writes nothing and both doors read the same record', async () => {
    const before = await overIpc('defaults:get');
    expect((await overRemote('defaults:set', 'junk')).answer).toEqual(before);
    expect((await overRemote('defaults:get')).answer).toEqual(before);
  });
});

describe('settings: an unsafe path is refused on BOTH doors (audit D6/B3)', () => {
  it('a paired phone cannot write onto Object.prototype, and neither can the computer', async () => {
    expect((await overRemote('settings:set', { field: '__proto__.polluted', value: 1 })).answer).toBe(false);
    expect(await overIpc('settings:set', { field: 'constructor.prototype.polluted', value: 1 })).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
    expect((await overRemote('settings:get', { field: '__proto__' })).answer).toBeUndefined();
    expect(await overIpc('settings:get', { field: '__proto__' })).toBeUndefined();
  });
  it('a real field written by a phone is read by the computer', async () => {
    expect((await overRemote('settings:set', { field: 'r31Probe.nested', value: 'yes' })).answer).toBe(true);
    expect(await overIpc('settings:get', { field: 'r31Probe.nested' })).toBe('yes');
    await overIpc('settings:set', { field: 'r31Probe', value: undefined });
  });
});

// WHY (2026-09-30 one-core R3-2): dev, update and account moved in.
describe('dev, update and account: every channel is in the table, and phones are refused as before', () => {
  const PUSHES = new Set(['update:progress', 'dev:install-progress']);
  it('every dev:*, update:* and account:* name in the contract has a table entry (pushes excepted)', () => {
    const inTable = new Set(CHANNEL_TABLE.map((d) => d.name));
    const names = Object.values(IPC).filter((v) => /^(dev|update|account):/.test(v) && !PUSHES.has(v));
    expect(names.length).toBe(26); // 9 dev + 7 update + 10 account; a new one must be decided here
    expect(names.filter((n) => !inTable.has(n))).toEqual([]);
  });
  it('exactly these are open to a phone; everything else answers "not available over remote access"', () => {
    const open = CHANNEL_TABLE.filter((d) => /^(dev|update|account):/.test(d.name) && !d.desktopOnly && d.remoteAllowed !== false).map((d) => d.name).sort();
    expect(open).toEqual(['account:signed-in', 'account:user', 'update:get-beta-channel', 'update:set-beta-channel']);
  });
  it('a phone asking for an installer launch or a bug report is refused without the handler running', async () => {
    for (const type of ['update:launch', 'update:download', 'update:changelog', 'dev:submit-issue', 'dev:log-tail', 'dev:install-workspace', 'dev:open-session-in']) {
      expect((await overRemote(type, {})).answer, type).toEqual({ ok: false, error: `This feature isn't available over remote access yet (${type}).`, unsupported: true });
    }
  });
  it('the beta channel reads the same over both doors', async () => {
    const desktop = await overIpc('update:get-beta-channel');
    expect((await overRemote('update:get-beta-channel')).answer).toEqual(desktop);
    expect(desktop).toEqual({ betaChannel: expect.toSatisfy((v: unknown) => v === null || typeof v === 'boolean'), effective: expect.any(Boolean) });
  });
  it('a failed beta-channel save keeps the phone\'s old {ok:false,error} answer, and the computer still rejects', async () => {
    const def = CHANNEL_TABLE.find((d) => d.name === 'update:set-beta-channel')!;
    const original = def.handler;
    def.handler = () => { throw new Error('config locked'); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await overRemote('update:set-beta-channel', { enabled: true })).answer).toEqual({ ok: false, error: 'config locked' });
      await expect(Promise.resolve().then(() => overIpc('update:set-beta-channel', { enabled: true }))).rejects.toThrow('config locked');
    } finally { def.handler = original; warn.mockRestore(); }
  });
  it('the dev-only session opener needs the computer\'s session manager and refuses without it', async () => {
    const def = CHANNEL_TABLE.find((d) => d.name === 'dev:open-session-in')!;
    expect(def.desktopOnly).toBe(true);
    expect(() => def.handler({ cwd: '/x' }, { door: 'remote', runtime: null, broadcast: () => {} })).toThrow('session manager');
  });
});

// WHY (2026-09-30 one-core R3-3): skills, marketplace, theme-marketplace and first-run moved in.
describe('skills, marketplace, theme-marketplace and first-run: every channel is in the table', () => {
  const PUSHES = new Set<string>();
  const FAMILY = /^(skills|marketplace|theme-marketplace|first-run):/;
  it('every name in the contract has a table entry', () => {
    const inTable = new Set(CHANNEL_TABLE.map((d) => d.name));
    const names = Object.values(IPC).filter((v) => FAMILY.test(v) && !PUSHES.has(v));
    expect(names.length).toBe(55); // 23 skills + 13 marketplace + 9 theme-marketplace + 10 first-run; a new one must be decided here
    expect(names.filter((n) => !inTable.has(n))).toEqual([]);
  });
  it('exactly these are open to a phone (what a phone could do before); everything else is refused', () => {
    const open = CHANNEL_TABLE.filter((d) => FAMILY.test(d.name) && !d.desktopOnly && d.remoteAllowed !== false).map((d) => d.name).sort();
    expect(open).toEqual([
      'skills:apply-output-style', 'skills:create-prompt', 'skills:delete-prompt', 'skills:get-chips', 'skills:get-curated-defaults',
      'skills:get-detail', 'skills:get-favorites', 'skills:get-integration-info', 'skills:get-override', 'skills:get-share-link',
      'skills:import-from-link', 'skills:install', 'skills:install-many', 'skills:list', 'skills:list-marketplace', 'skills:publish',
      'skills:search', 'skills:set-chips', 'skills:set-favorite', 'skills:set-override', 'skills:uninstall',
    ]);
  });
  it('a phone asking for anything else here gets the standard refusal, and the handler never runs', async () => {
    for (const type of ['skills:update', 'skills:get-featured', 'marketplace:install', 'marketplace:rate', 'marketplace:get-config', 'theme-marketplace:install', 'theme-marketplace:publish', 'first-run:skip', 'first-run:state', 'first-run:local-download']) {
      expect((await overRemote(type, {})).answer, type).toEqual({ ok: false, error: `This feature isn't available over remote access yet (${type}).`, unsupported: true });
    }
  });
  it('the first-run local-download handlers take no argument (the sessionId they used to be sent was never read)', () => {
    for (const name of ['first-run:local-download', 'first-run:resume-local-download']) {
      expect(CHANNEL_TABLE.find((d) => d.name === name)!.handler.length, name).toBe(0);
    }
  });
});

describe('skills: install and uninstall keep working from a phone, and a bundled plugin cannot be removed from it', () => {
  beforeEach(() => { broadcastReloadPlugins.mockClear(); install.mockClear(); uninstall.mockClear(); });
  it('a phone installing a plugin gets the real result and running chats reload their plugins', async () => {
    expect((await overRemote('skills:install', { id: 'some-plugin' })).answer).toEqual({ status: 'installed', type: 'plugin' });
    expect(install).toHaveBeenCalledWith('some-plugin');
    expect(broadcastReloadPlugins).toHaveBeenCalledTimes(1);
  });
  it('a phone uninstalling an ordinary plugin gets the real result, like the computer', async () => {
    const phone = (await overRemote('skills:uninstall', { id: 'some-plugin' })).answer;
    expect(phone).toEqual({ type: 'plugin' });
    expect(await overIpc('skills:uninstall', { id: 'some-plugin' })).toEqual(phone);
    expect(broadcastReloadPlugins).toHaveBeenCalledTimes(2);
  });
  it('a phone uninstalling a bundled plugin is refused exactly as the computer refuses it, and nothing is removed', async () => {
    const refusal = { ok: false, error: 'bundled', type: 'plugin' };
    expect((await overRemote('skills:uninstall', { id: 'youcoded-chatsearch' })).answer).toEqual(refusal);
    expect(await overIpc('skills:uninstall', { id: 'youcoded-chatsearch' })).toEqual(refusal);
    expect(uninstall).not.toHaveBeenCalled();
    expect(broadcastReloadPlugins).not.toHaveBeenCalled();
  });
  it('a bundled plugin cannot be removed through the id of one of its skills either, from either door', async () => {
    const refusal = { ok: false, error: 'bundled', type: 'plugin' };
    expect((await overRemote('skills:uninstall', { id: 'youcoded-chatsearch:chatsearch' })).answer).toEqual(refusal);
    expect(await overIpc('skills:uninstall', { id: 'youcoded-chatsearch:chatsearch' })).toEqual(refusal);
    expect(uninstall).not.toHaveBeenCalled();
    expect(broadcastReloadPlugins).not.toHaveBeenCalled();
  });
  it('a failing skills call reaches the phone as a failure marker, not as a value', async () => {
    const def = CHANNEL_TABLE.find((d) => d.name === 'skills:list')!;
    const original = def.handler;
    def.handler = () => { throw new Error('disk trouble'); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await overRemote('skills:list')).answer).toMatchObject({ ok: false, error: 'disk trouble', tableHandlerFailed: true });
    } finally { def.handler = original; warn.mockRestore(); }
  });
});

describe('first-run: the wizard channels reach whichever manager main.ts bound', () => {
  const ctx: any = { door: 'desktop', runtime: null, broadcast: () => {} };
  const run = (name: string, payload?: unknown) => CHANNEL_TABLE.find((d) => d.name === name)!.handler(payload, ctx);
  const manager = () => ({ retry: vi.fn(async () => {}), handleOAuthLogin: vi.fn(async () => {}), handleChatGptLogin: vi.fn(async () => {}), handleApiKeySubmit: vi.fn(async () => {}), handleDevModeDone: vi.fn(async () => {}), getState: vi.fn(() => ({ currentStep: 'AUTHENTICATE' })) });
  it('with no manager bound, state says COMPLETE and connect-local-app says setup is not running', async () => {
    bindFirstRunManager({ getManager: () => null, getState: () => ({ currentStep: 'COMPLETE' }), chatgptAuth: null });
    expect(await run('first-run:state')).toEqual({ currentStep: 'COMPLETE' });
    expect(await run('first-run:connect-local-app', { baseUrl: 'http://x', name: 'x' })).toEqual({ ok: false, message: 'Setup is not running.' });
    await expect(run('first-run:retry')).resolves.toBeUndefined();
  });
  it('the ChatGPT arm runs only when an account was bound (the kill switch binds none)', async () => {
    const m = manager();
    bindFirstRunManager({ getManager: () => m as any, getState: () => m.getState(), chatgptAuth: null });
    await run('first-run:start-auth', { mode: 'chatgpt' });
    expect(m.handleChatGptLogin).not.toHaveBeenCalled();
    await run('first-run:start-auth', { mode: 'oauth' });
    expect(m.handleOAuthLogin).toHaveBeenCalledTimes(1);
    const account: any = {};
    bindFirstRunManager({ getManager: () => m as any, getState: () => m.getState(), chatgptAuth: account });
    await run('first-run:start-auth', { mode: 'chatgpt' });
    expect(m.handleChatGptLogin).toHaveBeenCalledWith(account);
    expect(await run('first-run:state')).toEqual({ currentStep: 'AUTHENTICATE' });
  });
  it('a failing step is logged and swallowed, never thrown into the window', async () => {
    const m = manager();
    m.handleDevModeDone.mockRejectedValue(new Error('nope'));
    bindFirstRunManager({ getManager: () => m as any, getState: () => m.getState(), chatgptAuth: null });
    await expect(run('first-run:dev-mode-done')).resolves.toBeUndefined();
  });
});
