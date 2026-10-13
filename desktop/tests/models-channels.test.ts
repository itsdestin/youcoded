// The providers, ChatGPT / OpenRouter / Claude Code sign-in, search keys, local engine and model-manager
// channels that moved into the channel table (one-core R3-6). channel-table-families.test.ts proves every entry
// runs ONE handler for both doors and that no hand-written copy is left. This file pins what that cannot see:
// what a phone may still do, the two sign-ins a phone is refused, that no key is ever in an answer, the answers
// a phone gets before the runtime exists, and the one place the doors differ (run-in-terminal).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { IPC } from '../src/shared/backend-contract';
import { CHANNEL_TABLE, findChannel, serveRemoteChannel } from '../src/main/ipc/channel-table';
import { bindSessionOps } from '../src/main/ipc/session';

const FAMILY = /^(models|engine|provider|search|chatgpt|openrouter|claude-code|endpoints):/;
// Pushes are never entries.
const PUSHES = new Set<string>([IPC.ENGINE_INSTALL_PROGRESS, IPC.ENGINE_STATUS_CHANGED, IPC.ENGINE_MODELS_CHANGED, IPC.MODELS_DOWNLOAD_PROGRESS]);
const desktopCtx = (runtime: any, extra: any = {}): any => ({ door: 'desktop', runtime, broadcast: () => {}, windowId: 1, ...extra });
const phoneCtx = (runtime: any, extra: any = {}): any => ({ door: 'remote', runtime, broadcast: () => {}, clientId: 'phone-a', ...extra });
const call = (name: string, payload: unknown, ctx: any) => findChannel(name)!.handler(payload, ctx);
const serve = (name: string, payload: unknown, ctx: any) => serveRemoteChannel(findChannel(name)!, payload, ctx);

afterEach(() => { bindSessionOps(null); vi.restoreAllMocks(); });

describe('what is in the table and who may call it', () => {
  it('every request name in the contract for these families has an entry; the pushes have none', () => {
    const inTable = new Set(CHANNEL_TABLE.map((d) => d.name));
    const names = Object.values(IPC).filter((v) => FAMILY.test(v) && !PUSHES.has(v) && v !== IPC.ENGINE_MODELS_CHANGED);
    // 13 models + 9 engine + 6 provider + 4 search + 4 chatgpt + 3 openrouter + 2 claude-code + endpoints:detect;
    // a new one must be decided here.
    expect(names.length).toBe(42);
    expect(names.filter((n) => !inTable.has(n))).toEqual([]);
    for (const p of PUSHES) expect(findChannel(p)).toBeUndefined();
  });

  it('a phone may use exactly what it could before: only the two sign-in starts are refused, and they answer false', async () => {
    const refused = CHANNEL_TABLE.filter((d) => FAMILY.test(d.name) && (d.desktopOnly || d.remoteAllowed === false)).map((d) => d.name).sort();
    expect(refused).toEqual(['chatgpt:sign-in', 'openrouter:sign-in']);
    const signIn = vi.fn(async () => true);
    const rt: any = { chatgptAuth: { signIn }, openRouterSignIn: { signIn } };
    for (const name of refused) expect(await serve(name, undefined, phoneCtx(rt))).toEqual({ reply: true, payload: false });
    expect(signIn).not.toHaveBeenCalled(); // never reached the browser-opening code
    // The computer's own window runs them.
    expect(await call('chatgpt:sign-in', undefined, desktopCtx(rt))).toBe(true);
    expect(await call('openrouter:sign-in', undefined, desktopCtx(rt))).toBe(true);
  });
});

describe('secrets never come back out', () => {
  it('provider:set-key and search:set-key answer only `true`; list answers carry no key', async () => {
    const setProviderKey = vi.fn(async () => {});
    const setSearchKey = vi.fn(async () => {});
    const rt: any = {
      providerRegistry: { setKey: setProviderKey },
      searchKeyStore: { setKey: setSearchKey, list: async () => [{ id: 'tavily', label: 'Tavily', hasKey: true }] },
    };
    for (const ctx of [desktopCtx(rt), phoneCtx(rt)]) {
      expect(await call('provider:set-key', { id: 'p', key: 'sk-secret-1' }, ctx)).toBe(true);
      expect(await call('search:set-key', { backend: 'tavily', key: 'sk-secret-2' }, ctx)).toBe(true);
    }
    expect(setProviderKey).toHaveBeenCalledWith('p', 'sk-secret-1');
    expect(JSON.stringify(await call('search:list', undefined, phoneCtx(rt)))).not.toContain('sk-secret');
  });
  it('a failing key save answers with the sentence only, never the key, and a phone with no runtime is told it was not saved', async () => {
    const rt: any = { searchKeyStore: { setKey: vi.fn(async () => { throw new Error('Keychain unavailable'); }) } };
    const out: any = await serve('search:set-key', { backend: 'exa', key: 'sk-secret-3' }, phoneCtx(rt));
    expect(JSON.stringify(out)).not.toContain('sk-secret-3');
    expect(out.payload).toMatchObject({ ok: false, error: 'Keychain unavailable', tableHandlerFailed: true });
    // A "saved" for a key that never reached a store would lose the key silently.
    for (const name of ['provider:set-key', 'search:set-key', 'search:remove-key']) {
      const none: any = await serve(name, { id: 'p', backend: 'exa', key: 'k' }, phoneCtx(null));
      expect(none.payload).toMatchObject({ ok: false, tableHandlerFailed: true });
    }
  });
});

describe('a phone that arrives before the runtime exists gets the same answers as before', () => {
  it('empty lists, null, or the plain "not available" sentence', async () => {
    const none = phoneCtx(null);
    expect(await call('provider:list', undefined, none)).toEqual([]);
    expect(await call('provider:upsert', { type: 'openai-compatible', label: 'x', enabled: true }, none)).toBeNull();
    expect(await call('provider:test', { id: 'p' }, none)).toEqual({ ok: false, message: 'Native runtime not available.' });
    expect(await call('provider:catalog', undefined, none)).toEqual([]);
    expect(await call('search:test', { backend: 'exa', key: 'k' }, none)).toEqual({ ok: false, message: 'Native runtime not available.' });
    expect(await call('chatgpt:status', undefined, none)).toEqual({ state: 'signed-out' });
    expect(await call('openrouter:sign-in-status', undefined, none)).toEqual({ state: 'idle' });
    expect(await call('claude-code:status', undefined, none)).toEqual({ state: 'unknown' });
    expect(await call('engine:status', undefined, none)).toBeNull();
    expect(await call('engine:install', undefined, none)).toBeNull();
    expect(await call('engine:models', undefined, none)).toEqual([]);
    expect(await call('models:curated', undefined, none)).toEqual([]);
    expect(await call('models:installed', undefined, none)).toEqual([]);
    // Never a made-up download id or settings record.
    expect(await call('models:add-vision', { modelId: 'm' }, none)).toBeNull();
    expect(await call('models:download', { repo: 'r', quant: {} }, none)).toBeNull();
    expect(await call('models:settings', { modelId: 'm' }, none)).toBeNull();
    expect(await call('models:set-settings', { modelId: 'm', patch: {} }, none)).toBeNull();
    expect(await call('models:memory-check', { modelId: 'm' }, none)).toEqual({ verdict: 'ok', headline: '', detail: '' });
  });
});

describe('failures, as a phone and a window see them', () => {
  it('provider:test keeps its {ok,message} for a phone; other failures carry the table marker; a window gets a rejection', async () => {
    const rt: any = { providerRegistry: { testConnection: vi.fn(async () => { throw new Error('boom'); }), upsert: vi.fn(async () => { throw new Error('Built-in providers cannot be changed.'); }) } };
    expect(((await serve('provider:test', { id: 'p' }, phoneCtx(rt))) as any).payload).toEqual({ ok: false, message: 'boom' });
    expect(((await serve('provider:upsert', { label: 'x' }, phoneCtx(rt))) as any).payload)
      .toMatchObject({ ok: false, error: 'Built-in providers cannot be changed.', tableHandlerFailed: true });
    await expect(Promise.resolve().then(() => call('provider:upsert', { label: 'x' }, desktopCtx(rt)))).rejects.toThrow('Built-in providers');
  });
  it('a refused model-settings save (context too small) reaches the caller as the reason', async () => {
    const rt: any = { engineManager: { setModelSettings: vi.fn(async () => { throw new Error('Context length must be at least 1024 tokens.'); }) } };
    const out: any = await serve('models:set-settings', { modelId: 'a', patch: { contextLength: 512 } }, phoneCtx(rt));
    expect(out.payload).toMatchObject({ ok: false, error: 'Context length must be at least 1024 tokens.', tableHandlerFailed: true });
  });
});

describe('a local-engine download or install starts once, from whichever door asked', () => {
  it('download, resume, add-vision, install and restart each make exactly one call', async () => {
    const mm = { download: vi.fn(async () => ({ downloadId: 'd' })), resume: vi.fn(async () => ({ downloadId: 'd' })), addVision: vi.fn(async () => ({ downloadId: 'd' })) };
    const em = { install: vi.fn(async () => {}), restart: vi.fn(async () => {}), status: vi.fn(() => ({ state: 'running' })) };
    const rt: any = { modelManager: mm, engineManager: em };
    for (const run of [(n: string, p: unknown) => call(n, p, desktopCtx(rt)), (n: string, p: unknown) => serve(n, p, phoneCtx(rt))]) {
      await run('models:download', { repo: 'r', quant: { file: 'f' } });
      await run('models:resume', { modelId: 'm' });
      await run('models:add-vision', { modelId: 'm' });
      await run('engine:install', undefined);
      await run('engine:restart', undefined);
    }
    expect(mm.download).toHaveBeenCalledTimes(2);
    expect(mm.resume).toHaveBeenCalledTimes(2);
    expect(mm.addVision).toHaveBeenCalledTimes(2);
    expect(em.install).toHaveBeenCalledTimes(2);
    expect(em.restart).toHaveBeenCalledTimes(2);
    expect(mm.download).toHaveBeenCalledWith('r', { file: 'f' });
  });
  it('engine changes answer with the fresh status', async () => {
    const em = { setContext: vi.fn(async () => {}), setConfig: vi.fn(async () => {}), setBackend: vi.fn(async () => {}), status: vi.fn(() => ({ state: 'running', n: 1 })) };
    const rt: any = { engineManager: em };
    expect(await call('engine:set-context', { contextSize: 8192 }, phoneCtx(rt))).toEqual({ state: 'running', n: 1 });
    expect(await call('engine:set-config', { speed: { speculative: true } }, desktopCtx(rt))).toEqual({ state: 'running', n: 1 });
    expect(em.setConfig).toHaveBeenCalledWith({ speed: { speculative: true } });
    expect(await call('engine:set-config', undefined, desktopCtx(rt))).toEqual({ state: 'running', n: 1 });
    expect(em.setConfig).toHaveBeenLastCalledWith({});
  });
});

describe('claude-code and sign-in status', () => {
  it('refresh drops the cache first; install drops it after', async () => {
    const account = { invalidate: vi.fn(), status: vi.fn(async () => ({ state: 'signed-in' })) };
    const rt: any = { claudeAccount: account };
    expect(await call('claude-code:status', { refresh: true }, phoneCtx(rt))).toEqual({ state: 'signed-in' });
    expect(account.invalidate).toHaveBeenCalledTimes(1);
    await call('claude-code:status', undefined, desktopCtx(rt));
    expect(account.invalidate).toHaveBeenCalledTimes(1);
  });
  it('the YOUCODED_CHATGPT=0 kill switch (a null account) answers signed-out / false on both doors', async () => {
    const rt: any = { chatgptAuth: null };
    for (const ctx of [desktopCtx(rt), phoneCtx(rt)]) {
      expect(await call('chatgpt:status', undefined, ctx)).toEqual({ state: 'signed-out' });
      expect(await call('chatgpt:cancel-sign-in', undefined, ctx)).toBe(false);
      expect(await call('chatgpt:sign-out', undefined, ctx)).toBe(false);
    }
  });
});

describe('engine:run-in-terminal', () => {
  const sessions = [{ id: 'a', status: 'running', cwd: '/old' }, { id: 'b', status: 'destroyed', cwd: '/gone' }, { id: 'c', status: 'running', cwd: '/new' }];
  const make = () => {
    const createSession = vi.fn((opts: any) => ({ id: 'shell-1', ...opts }));
    const registry = {
      sessionsForWindow: vi.fn(() => ['a']), getKind: vi.fn(() => 'main'), getLeaderId: vi.fn(() => 9), assignSession: vi.fn(),
    };
    const sessionManager = { listSessions: () => sessions, getSession: (id: string) => sessions.find((s) => s.id === id), createSession };
    bindSessionOps({ sessionManager, windowRegistry: registry } as any);
    return { createSession, registry };
  };
  it('a window opens it in its own newest session folder and owns the new session', async () => {
    const { createSession, registry } = make();
    expect(await call('engine:run-in-terminal', { command: 'sudo pacman -S rocm' }, desktopCtx(null, { windowId: 4 }))).toEqual({ sessionId: 'shell-1' });
    expect(createSession.mock.calls[0][0]).toMatchObject({ provider: 'shell', cwd: '/old', skipPermissions: false, initialCommand: 'sudo pacman -S rocm' });
    expect(createSession.mock.calls[0][0].shellToken).toBeTruthy();
    expect(registry.assignSession).toHaveBeenCalledWith('shell-1', 4);
  });
  it('a buddy window hands ownership to its leader', async () => {
    const { registry } = make();
    registry.getKind.mockReturnValue('buddy');
    await call('engine:run-in-terminal', { command: 'echo hi' }, desktopCtx(null, { windowId: 4 }));
    expect(registry.assignSession).toHaveBeenCalledWith('shell-1', 9);
  });
  it('a phone opens it in the computer\'s newest live session folder and the session is left unowned', async () => {
    const { createSession, registry } = make();
    expect(await call('engine:run-in-terminal', { command: 'echo hi' }, phoneCtx(null))).toEqual({ sessionId: 'shell-1' });
    expect(createSession.mock.calls[0][0].cwd).toBe('/new');
    expect(registry.assignSession).not.toHaveBeenCalled();
  });
  it('a command with a carriage return is refused on both doors before anything is opened', async () => {
    const { createSession } = make();
    for (const ctx of [desktopCtx(null), phoneCtx(null)]) {
      await expect(Promise.resolve().then(() => call('engine:run-in-terminal', { command: 'echo a\recho b' }, ctx))).rejects.toThrow(/carriage return/);
    }
    expect(createSession).not.toHaveBeenCalled();
  });
  it('a phone that asked during the boot wait and then left opens nothing', async () => {
    vi.useFakeTimers();
    try {
      const createSession = vi.fn((opts: any) => ({ id: 'x', ...opts }));
      let connected = true;
      const out = serve('engine:run-in-terminal', { command: 'echo hi' }, phoneCtx(null, { isConnected: () => connected }));
      await vi.advanceTimersByTimeAsync(1_000);
      connected = false;
      bindSessionOps({ sessionManager: { listSessions: () => [], getSession: () => undefined, createSession } } as any);
      await out;
      expect(createSession).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
