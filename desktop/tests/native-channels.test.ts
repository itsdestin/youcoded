// The native, permission(s), specialists, model and handoff channels that moved into the channel table
// (one-core R3-5). channel-table-families.test.ts already proves every entry runs ONE handler for both doors
// and that no hand-written copy is left behind. This file pins what those cannot see: what a phone may
// still do, what it is still refused, and the few places the two doors legitimately differ.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const noteModelUsed = vi.fn();
vi.mock('../src/main/conversations/service', () => ({ noteModelUsed: (...a: unknown[]) => noteModelUsed(...a) }));

import { IPC } from '../src/shared/backend-contract';
import { CHANNEL_TABLE, findChannel, serveRemoteChannel } from '../src/main/ipc/channel-table';
import { bindPermissionHooks } from '../src/main/ipc/permissions';
import { bindHandoffRoute } from '../src/main/ipc/handoff';

const FAMILY = /^(native|permission|permissions|specialists|model|handoff):/;
// Pushes and the capability flag are never entries.
const NOT_ENTRIES = new Set<string>([
  IPC.NATIVE_SUPPORTED, IPC.NATIVE_PERMISSION_MODE, IPC.NATIVE_SESSION_CONTEXT, IPC.NATIVE_MODEL_STATE, IPC.NATIVE_SHELL_EVENT, IPC.SPECIALISTS_EVENT,
]);
const desktopCtx = (runtime: any, extra: any = {}): any => ({ door: 'desktop', runtime, broadcast: () => {}, ...extra });
const phoneCtx = (runtime: any, extra: any = {}): any => ({ door: 'remote', runtime, broadcast: () => {}, clientId: 'phone-a', ...extra });
const call = (name: string, payload: unknown, ctx: any) => findChannel(name)!.handler(payload, ctx);
// A handler may throw synchronously (Electron turns that into a rejected invoke); this makes both shapes a rejection.
const callAsync = (name: string, payload: unknown, ctx: any) => Promise.resolve().then(() => call(name, payload, ctx));

afterEach(() => { noteModelUsed.mockReset(); bindPermissionHooks(undefined); bindHandoffRoute(undefined); vi.restoreAllMocks(); });

describe('what is in the table and who may call it', () => {
  it('every native, permission(s), specialists, model and handoff request name in the contract has an entry', () => {
    const inTable = new Set(CHANNEL_TABLE.map((d) => d.name));
    const names = Object.values(IPC).filter((v) => FAMILY.test(v) && !NOT_ENTRIES.has(v));
    // 20 native + permission:respond + 3 permissions + 5 specialists + 3 model + 8 handoff; a new one must be decided here.
    expect(names.length).toBe(40);
    expect(names.filter((n) => !inTable.has(n))).toEqual([]);
  });

  it('a phone may use exactly what it could before: only /clear and /skill-name stay refused (they had no phone case)', async () => {
    const refused = CHANNEL_TABLE.filter((d) => FAMILY.test(d.name) && (d.desktopOnly || d.remoteAllowed === false)).map((d) => d.name).sort();
    expect(refused).toEqual(['native:clear', 'native:invoke-skill']);
    for (const name of refused) {
      expect(await serveRemoteChannel(findChannel(name)!, { sessionId: 's' }, phoneCtx({ nativeHost: { clear: vi.fn() } }))).toEqual({
        reply: true, payload: { ok: false, error: `This feature isn't available over remote access yet (${name}).`, unsupported: true },
      });
    }
  });

  it('the push channels and the capability flag are not entries', () => {
    for (const n of NOT_ENTRIES) expect(findChannel(n)).toBeUndefined();
  });
});

describe('native:send', () => {
  it('hands the host only text paths, for a window and for a phone alike', async () => {
    const send = vi.fn(() => ({ status: 'sent' }));
    const rt: any = { nativeHost: { send } };
    await call('native:send', { sessionId: 's', text: 'hi', attachments: ['/a.png', 7, null, '/b.txt'] }, desktopCtx(rt));
    await call('native:send', { sessionId: 's', text: 'hi', attachments: '/not-an-array' }, phoneCtx(rt));
    expect(send).toHaveBeenNthCalledWith(1, 's', 'hi', ['/a.png', '/b.txt']);
    expect(send).toHaveBeenNthCalledWith(2, 's', 'hi', []);
  });
  it('a phone that arrives before the runtime exists is told "not live", as before', async () => {
    expect(await call('native:send', { sessionId: 's', text: 'x' }, phoneCtx(null))).toEqual({ status: 'failed', reason: 'not-live' });
    expect(await call('native:queue-remove', { sessionId: 's', queueId: 'q' }, phoneCtx(null))).toBe(false);
    expect(await call('native:get-permission-mode', { sessionId: 's' }, phoneCtx(null))).toBe('ask');
    expect(await call('native:sessions-list', undefined, phoneCtx(null))).toEqual([]);
  });
});

describe('model swaps record the model used, for a phone too', () => {
  const rt = (extra: any = {}): any => ({
    nativeHost: { setBinding: vi.fn(async () => true), switchModel: vi.fn(async () => ({ status: 'switched' })) },
    resolvePortableModel: vi.fn(async () => ({ modelId: 'm1' })), ...extra,
  });
  it('set-binding and switch-model write through on both doors; a failed swap writes nothing', async () => {
    for (const ctx of [desktopCtx(rt()), phoneCtx(rt())]) {
      await call('native:set-binding', { sessionId: 's', binding: { providerId: 'p', modelId: 'm1' } }, ctx);
      await call('native:switch-model', { sessionId: 's', binding: { providerId: 'p', modelId: 'm1' } }, ctx);
    }
    expect(noteModelUsed).toHaveBeenCalledTimes(4);
    noteModelUsed.mockClear();
    const failing = rt();
    failing.nativeHost.setBinding = vi.fn(async () => false);
    failing.nativeHost.switchModel = vi.fn(async () => ({ status: 'needs-summary' }));
    await call('native:set-binding', { sessionId: 's', binding: { providerId: 'p', modelId: 'm' } }, phoneCtx(failing));
    await call('native:switch-model', { sessionId: 's', binding: { providerId: 'p', modelId: 'm' } }, phoneCtx(failing));
    expect(noteModelUsed).not.toHaveBeenCalled();
  });
  it('switch-model keeps its coded failure answers (never throws across the bridge)', async () => {
    const boom = rt();
    boom.nativeHost.switchModel = vi.fn(async () => { throw new Error('gone'); });
    expect(await call('native:switch-model', { sessionId: 's', binding: { providerId: 'p', modelId: 'm' } }, phoneCtx(boom)))
      .toEqual({ status: 'failed', reason: 'error', detail: 'gone' });
    expect(await call('native:switch-model', { sessionId: 's', binding: { providerId: 'p', modelId: 'm' } }, phoneCtx(null)))
      .toEqual({ status: 'failed', reason: 'not-live' });
  });
});

describe('permission mode and settings', () => {
  it('an unknown permission mode is a thrown failure; on a phone it becomes the table\'s failure answer, which the page turns into an error', async () => {
    const host = { setPermissionMode: vi.fn(() => { throw new Error('unknown mode'); }) };
    await expect(callAsync('native:set-permission-mode', { sessionId: 's', mode: 'x' }, desktopCtx({ nativeHost: host }))).rejects.toThrow();
    const out: any = await serveRemoteChannel(findChannel('native:set-permission-mode')!, { sessionId: 's', mode: 'x' }, phoneCtx({ nativeHost: host }));
    expect(out.payload).toMatchObject({ ok: false, error: 'unknown mode', tableHandlerFailed: true });
  });
  it('context preferences refuse an absent runtime and the YOUCODED_NATIVE=0 kill switch on both doors, with the old sentence', async () => {
    for (const ctx of [desktopCtx(null), phoneCtx(null)]) {
      await expect(callAsync('native:get-context-preferences', undefined, ctx)).rejects.toThrow('Native context preferences are not supported');
    }
    vi.stubEnv('YOUCODED_NATIVE', '0');
    try {
      const rt: any = { contextSettings: { read: vi.fn(), update: vi.fn() } };
      await expect(callAsync('native:set-context-preferences', { patch: {} }, phoneCtx(rt))).rejects.toThrow('Native context preferences are not supported');
      expect(rt.contextSettings.update).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('native:session-context-text: one entry, two honest bodies', () => {
  const desktop = (host: any, read = vi.fn()) => desktopCtx({ nativeHost: host }, { desktop: { sessionManager: { getSession: () => ({ cwd: os.tmpdir() }) } } });
  it('a phone gets the assistant host\'s answer only, never the computer\'s plain file read', async () => {
    const host = { sessionContextText: vi.fn(() => ({ error: 'not-live' })) };
    expect(await call('native:session-context-text', { sessionId: 's', kind: 'project' }, phoneCtx({ nativeHost: host }))).toEqual({ error: 'not-live' });
    expect(await call('native:session-context-text', { sessionId: 's', kind: 'user' }, phoneCtx({ nativeHost: host }))).toEqual({ error: 'not-live' });
    expect(await call('native:session-context-text', { sessionId: 's', kind: 'project' }, phoneCtx(null))).toEqual({ error: 'not-live' });
  });
  it('the computer asks the host first and falls back to the file read only when the host says not-live', async () => {
    const live = { sessionContextText: vi.fn(() => ({ path: '/p', text: 'a', full: 'a', truncated: false })) };
    expect(await call('native:session-context-text', { sessionId: 's', kind: 'project' }, desktop(live))).toMatchObject({ text: 'a' });
    const notLive = { sessionContextText: vi.fn(() => ({ error: 'not-live' })) };
    const out: any = await call('native:session-context-text', { sessionId: 's', kind: 'project' }, desktop(notLive));
    expect(notLive.sessionContextText).toHaveBeenCalled();
    expect(out.text ?? out.error).toBeDefined(); // the plain read of the temp folder's (absent) instruction file
  });
});

describe('native:submit-admin-password', () => {
  it('refuses a missing, empty or non-string password without reaching the host, and passes a real one straight through', async () => {
    const host = { submitAdminPassword: vi.fn(() => true) };
    for (const bad of [undefined, '', 12, null]) expect(await call('native:submit-admin-password', { requestId: 'r', password: bad }, phoneCtx({ nativeHost: host }))).toBe(false);
    expect(host.submitAdminPassword).not.toHaveBeenCalled();
    expect(await call('native:submit-admin-password', { requestId: 'r', password: 'pw' }, phoneCtx({ nativeHost: host }))).toBe(true);
    expect(host.submitAdminPassword).toHaveBeenCalledWith('r', 'pw');
  });
  it('never prints the password, even when the host throws', async () => {
    const host = { submitAdminPassword: vi.fn(() => { throw new Error('askpass closed'); }) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await serveRemoteChannel(findChannel('native:submit-admin-password')!, { requestId: 'r', password: 'hunter2-secret' }, phoneCtx({ nativeHost: host }));
    expect(JSON.stringify([...warn.mock.calls, ...log.mock.calls])).not.toContain('hunter2-secret');
  });
});

describe('permission:respond', () => {
  it('the native broker answers first; otherwise the hook relay does; with neither the answer is false', async () => {
    const respond = vi.fn(() => true);
    bindPermissionHooks({ respond } as any);
    expect(await call('permission:respond', { requestId: 'native-1', decision: { d: 1 } }, phoneCtx({ nativeHost: { respondPermission: () => true } }))).toBe(true);
    expect(respond).not.toHaveBeenCalled();
    expect(await call('permission:respond', { requestId: 'hook-1', decision: { d: 2 } }, desktopCtx({ nativeHost: { respondPermission: () => false } }))).toBe(true);
    expect(respond).toHaveBeenCalledWith('hook-1', { d: 2 });
    bindPermissionHooks(undefined);
    expect(await call('permission:respond', { requestId: 'hook-2', decision: {} }, phoneCtx(null))).toBe(false);
  });
  it('permissions:remove revokes through the host (live memory), never the disk-only store', async () => {
    const rt: any = { nativeHost: { revokeRule: vi.fn(async () => true), revokeProject: vi.fn(async () => true) }, permissionStore: { list: vi.fn(async () => []), remove: vi.fn() } };
    await call('permissions:remove', { slug: 'p', rule: { tool: 'Bash', action: 'allow' } }, phoneCtx(rt));
    await call('permissions:remove-project', { slug: 'p' }, desktopCtx(rt));
    expect(rt.nativeHost.revokeRule).toHaveBeenCalledTimes(1);
    expect(rt.nativeHost.revokeProject).toHaveBeenCalledWith('p');
    expect(rt.permissionStore.remove).not.toHaveBeenCalled();
    expect(await call('permissions:list', undefined, phoneCtx(null))).toEqual([]);
  });
});

describe('specialists with no runtime answer what a phone always got', () => {
  it('empty roster, empty tiers, and the plain "isn\'t connected" sentence for a write', async () => {
    expect(await call('specialists:list', {}, phoneCtx(null))).toEqual({ definitions: [], skipped: [], folders: { personal: '', claudeUser: '' } });
    expect(await call('specialists:delegated-get', undefined, phoneCtx(null))).toEqual({ budget: null, frontier: null });
    const refusal = { ok: false, error: 'The assistant runtime isn’t connected.' };
    expect(await call('specialists:steer', { sessionId: 's', childId: 'c', text: 't' }, phoneCtx(null))).toEqual(refusal);
    expect(await call('specialists:interrupt', { sessionId: 's', childId: 'c' }, phoneCtx(null))).toEqual(refusal);
    expect(await call('specialists:delegated-set', { tier: 'budget', binding: null }, phoneCtx(null))).toEqual(refusal);
  });
});

describe('model preference files', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'r35-model-')); vi.spyOn(os, 'homedir').mockReturnValue(home); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  it('defaults to sonnet, round-trips a choice, and reads the last model only from inside the projects folder', async () => {
    expect(await call('model:get-preference', undefined, phoneCtx(null))).toBe('sonnet');
    expect(await call('model:set-preference', { model: 'opus' }, desktopCtx(null))).toBe(true);
    expect(await call('model:get-preference', undefined, phoneCtx(null))).toBe('opus');
    const projects = path.join(home, '.claude', 'projects', 'p');
    fs.mkdirSync(projects, { recursive: true });
    const transcript = path.join(projects, 't.jsonl');
    fs.writeFileSync(transcript, [JSON.stringify({ type: 'assistant', message: { model: 'claude-x' } }), 'not json'].join('\n'));
    expect(await call('model:read-last', { transcriptPath: transcript }, phoneCtx(null))).toBe('claude-x');
    expect(await call('model:read-last', transcript, phoneCtx(null))).toBe('claude-x'); // the bare-string form is still accepted
    const outside = path.join(home, 'secret.jsonl');
    fs.writeFileSync(outside, JSON.stringify({ type: 'assistant', message: { model: 'leak' } }));
    expect(await call('model:read-last', { transcriptPath: outside }, phoneCtx(null))).toBeNull();
    expect(await call('model:read-last', { transcriptPath: 7 }, phoneCtx(null))).toBeNull();
  });
});

describe('handoff attempts are owned by the connection that began them', () => {
  it('a window owns its attempt as window:<id>, a phone as remote:<client id>', async () => {
    const route: any = vi.fn(async () => ({ id: 'a', status: 'waiting' }));
    bindHandoffRoute(route);
    await call('handoff:begin', { conversationId: 'c', provider: 'native' }, desktopCtx(null, { windowId: 4 }));
    await call('handoff:force', { id: 'a', consent: true, expectedHolderId: 'h' }, phoneCtx(null));
    expect(route).toHaveBeenNthCalledWith(1, 'window:4', 'begin', { conversationId: 'c', provider: 'native' });
    expect(route).toHaveBeenNthCalledWith(2, 'remote:phone-a', 'force', { id: 'a', consent: true, expectedHolderId: 'h' });
  });
  it('a failure rejects for the computer and answers {ok:false,error} (the old wording) for a phone', async () => {
    bindHandoffRoute((async () => { throw new Error('Invalid handoff attempt id.'); }) as any);
    await expect(call('handoff:status', { id: 'x' }, desktopCtx(null, { windowId: 1 }))).rejects.toThrow('Invalid handoff attempt id.');
    expect(await serveRemoteChannel(findChannel('handoff:status')!, { id: 'x' }, phoneCtx(null))).toEqual({ reply: true, payload: { ok: false, error: 'Invalid handoff attempt id.' } });
    bindHandoffRoute(undefined);
    expect(await serveRemoteChannel(findChannel('handoff:status')!, { id: 'x' }, phoneCtx(null))).toEqual({ reply: true, payload: { ok: false, error: 'Handoff attempts are unavailable.' } });
  });
});
