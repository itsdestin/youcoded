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

  it('a phone may use every native channel, /clear and /skill-name included, and the old refusal is gone', async () => {
    const refused = CHANNEL_TABLE.filter((d) => FAMILY.test(d.name) && (d.desktopOnly || d.remoteAllowed === false)).map((d) => d.name).sort();
    expect(refused).toEqual([]);
    // The old refusal is gone: the phone's door now reaches the assistant host for both.
    const clear = vi.fn(() => ({ ok: true }));
    const invokeSkill = vi.fn(async () => ({ ok: true }));
    const rt = { nativeHost: { clear, invokeSkill } };
    expect(await serveRemoteChannel(findChannel('native:clear')!, { sessionId: 's' }, phoneCtx(rt))).toEqual({ reply: true, payload: { ok: true } });
    expect(await serveRemoteChannel(findChannel('native:invoke-skill')!, { sessionId: 's', skill: 'x', args: 'a' }, phoneCtx(rt))).toEqual({ reply: true, payload: { ok: true } });
    expect(clear).toHaveBeenCalledWith('s');
    expect(invokeSkill).toHaveBeenCalledWith('s', 'x', 'a');
  });

  it('the push channels and the capability flag are not entries', () => {
    for (const n of NOT_ENTRIES) expect(findChannel(n)).toBeUndefined();
  });
});

describe('cancelling a queued message from a phone (one-core R5-4a)', () => {
  it('the phone may cancel and send-now a waiting message, with the same host call the computer makes', async () => {
    for (const name of ['native:queue-remove', 'native:queue-send-now']) {
      const def = findChannel(name)!;
      expect(def.desktopOnly, name).toBeFalsy();
      expect(def.remoteAllowed, name).not.toBe(false);
    }
    const removeQueued = vi.fn(() => true);
    const rt: any = { nativeHost: { removeQueued } };
    expect(await call('native:queue-remove', { sessionId: 's', queueId: 'q1' }, phoneCtx(rt))).toBe(true);
    expect(await call('native:queue-remove', { sessionId: 's', queueId: 'q1' }, desktopCtx(rt))).toBe(true);
    expect(removeQueued).toHaveBeenNthCalledWith(1, 's', 'q1');
    expect(removeQueued).toHaveBeenNthCalledWith(2, 's', 'q1');
  });
});

describe('native:send', () => {
  it('hands the host only text paths, for a window and for a phone alike', async () => {
    const send = vi.fn(() => ({ status: 'sent' }));
    const rt: any = { nativeHost: { send } };
    await call('native:send', { sessionId: 's', text: 'hi', attachments: ['/a.png', 7, null, '/b.txt'] }, desktopCtx(rt));
    await call('native:send', { sessionId: 's', text: 'hi', attachments: '/not-an-array' }, phoneCtx(rt));
    expect(send).toHaveBeenNthCalledWith(1, 's', 'hi', ['/a.png', '/b.txt'], ['/a.png', '/b.txt']);
    expect(send).toHaveBeenNthCalledWith(2, 's', 'hi', [], []);
  });
  it('prepares every picture attachment against the session limits and hands the host the model-facing paths', async () => {
    const send = vi.fn(() => ({ status: 'sent' }));
    const prepare = vi.fn(async (p: string, _limits: unknown) => p.endsWith('huge.png') ? { kind: 'prepared', path: '/cache/abc-huge.png' } : { kind: 'unchanged' });
    const limits = { maxEdgePx: 8192, maxPatches: 30_000 };
    const rt: any = { nativeHost: { send, imageLimitsFor: () => limits }, records: { noteSend: vi.fn() }, imagePreparer: { prepare, preparedPathFor: () => null } };
    expect(await call('native:send', { sessionId: 's', text: 'hi', attachments: ['/a/huge.png', 7, '/b.txt', '/c/ok.png'] }, desktopCtx(rt))).toEqual({ status: 'sent' });
    expect(prepare.mock.calls.map((c: any[]) => c[0])).toEqual(['/a/huge.png', '/c/ok.png']);   // only deliverable images are prepared
    expect(prepare.mock.calls[0][1]).toBe(limits);
    expect(send).toHaveBeenCalledWith('s', 'hi', ['/a/huge.png', '/b.txt', '/c/ok.png'], ['/cache/abc-huge.png', '/b.txt', '/c/ok.png']);
  });
  it('a refused preparation reaches the host as a marker carrying the reason, so the note says what really happened', async () => {
    const send = vi.fn(() => ({ status: 'sent' }));
    const reason = 'is 20000×20000 px — too large to downscale for the model (over 80 megapixels). Crop or shrink it with Bash (e.g. magick in.png -resize 4000x4000 out.png) and Read the copy.';
    const rt: any = { nativeHost: { send, imageLimitsFor: () => ({ maxEdgePx: 8192, maxPatches: 30_000 }) }, records: { noteSend: vi.fn() },
      imagePreparer: { prepare: async () => ({ kind: 'refused', reason, width: 20000, height: 20000 }), preparedPathFor: () => null } };
    await call('native:send', { sessionId: 's', text: 'hi', attachments: ['/vast.png'] }, desktopCtx(rt));
    expect(send).toHaveBeenCalledWith('s', 'hi', ['/vast.png'], [{ path: '/vast.png', prepareFailed: reason }]);
  });
  it('a preparer that throws never blocks the send; the original path is used', async () => {
    const send = vi.fn(() => ({ status: 'sent' }));
    const rt: any = { nativeHost: { send, imageLimitsFor: () => ({ maxEdgePx: 1, maxPatches: 1 }) }, records: { noteSend: vi.fn() }, imagePreparer: { prepare: async () => { throw new Error('boom'); }, preparedPathFor: () => null } };
    expect(await call('native:send', { sessionId: 's', text: 'hi', attachments: ['/a.png'] }, desktopCtx(rt))).toEqual({ status: 'sent' });
    expect(send).toHaveBeenCalledWith('s', 'hi', ['/a.png'], ['/a.png']);
  });
  it('sends to one session are serialised: a plain follow-up waits behind a message whose picture is still being prepared', async () => {
    const order: string[] = [];
    const send = vi.fn((_s: string, text: string) => { order.push(text); return { status: 'sent' }; });
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const preparing = new Promise<void>((r) => { entered = r; });   // resolved the moment the preparer is entered — no microtask guessing
    const rt: any = { nativeHost: { send, imageLimitsFor: () => ({ maxEdgePx: 8192, maxPatches: 30_000 }) }, records: { noteSend: vi.fn() },
      imagePreparer: { prepare: async () => { entered(); await gate; return { kind: 'prepared', path: '/cache/x.png' }; }, preparedPathFor: () => null } };
    const first = call('native:send', { sessionId: 's', text: 'with picture', attachments: ['/a.png'] }, desktopCtx(rt));
    const second = call('native:send', { sessionId: 's', text: 'plain follow-up' }, desktopCtx(rt));
    const other = call('native:send', { sessionId: 'other', text: 'another session' }, desktopCtx(rt));
    await preparing;
    await other;
    expect(order).toEqual(['another session']);          // the picture is still being prepared; the follow-up waits; another session is not held back
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['another session', 'with picture', 'plain follow-up']);
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
  it('a phone with no session folder to consult still gets the assistant host\'s answer only (the instruction-file read needs one; see phone-abilities.test.ts)', async () => {
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

// WHY (2026-09-30 one-core R3-6, R3-5 review): the screen fires the preference write without waiting, so two
// quick writes must land in the order asked, and a read during a write must see a whole file.
describe('model preference writes are atomic and in order', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'r36-model-')); vi.spyOn(os, 'homedir').mockReturnValue(home); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  it('two quick sets leave the LATER choice on disk even when the first write is the slow one', async () => {
    const real = fs.promises.writeFile.bind(fs.promises);
    let n = 0;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation((async (...args: Parameters<typeof real>) => {
      if (n++ === 0) await new Promise((r) => setTimeout(r, 40)); // the first write takes longer than the second
      return real(...args);
    }) as any);
    const first = call('model:set-preference', { model: 'opus' }, desktopCtx(null));
    const second = call('model:set-preference', { model: 'haiku' }, desktopCtx(null));
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(await call('model:get-preference', undefined, phoneCtx(null))).toBe('haiku');
  });
  it('a read in the middle of a write sees the old whole file, never half of the new one, and no temp file is left', async () => {
    expect(await call('model:set-preference', { model: 'opus' }, desktopCtx(null))).toBe(true);
    const real = fs.promises.writeFile.bind(fs.promises);
    let midRead: unknown;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation((async (file: any, data: any, ...rest: any[]) => {
      await (real as any)(file, String(data).slice(0, 4), ...rest); // the file as a reader could catch it mid-write
      midRead = await call('model:get-preference', undefined, phoneCtx(null));
      return (real as any)(file, data, ...rest);
    }) as any);
    expect(await call('model:set-preference', { model: 'sonnet-5' }, desktopCtx(null))).toBe(true);
    expect(midRead).toBe('opus');
    expect(await call('model:get-preference', undefined, phoneCtx(null))).toBe('sonnet-5');
    expect(fs.readdirSync(path.join(home, '.claude')).filter((f) => f.includes('.tmp.'))).toEqual([]);
  });
});

// WHY (2026-09-30 one-core R3-7, R3-6 review): model.ts carried a private copy of the temp-file-and-rename helper
// that sync-state.ts already had. One shared helper (main/atomic-write.ts); a second copy would drift again.
describe('the model preference uses the one shared atomic write', () => {
  const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', rel), 'utf8');
  it('model.ts and sync-state.ts import it, and neither renames a temp file itself', () => {
    for (const file of ['ipc/model.ts', 'sync-state.ts']) {
      expect(src(file), `${file} must use the shared helper`).toMatch(/from '\.\.?\/atomic-write'/);
      expect(src(file), `${file} carries its own temp-file-and-rename`).not.toContain('fs.promises.rename(');
    }
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
