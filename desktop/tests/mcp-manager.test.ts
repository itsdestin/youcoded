import { describe, it, expect, vi } from 'vitest';
import { McpManager, redactSecrets } from '../src/main/harness/mcp/mcp-manager';
import type { ResolvedMcpServer } from '../src/main/harness/mcp/types';

const server = (over: Partial<ResolvedMcpServer> = {}): ResolvedMcpServer => ({ id: 'demo', label: 'Demo', enabled: true,
  origin: { kind: 'user' }, missingSecrets: [], transport: { type: 'stdio', command: 'node' }, ...over });
// WHY descriptors, not spread: callers pass a `state` getter that must stay live.
const conn = (over: Record<string, unknown> = {}): any => Object.defineProperties({ state: 'ready', lastError: null, connect: async () => {},
  listTools: () => [{ name: 'search', inputSchema: { type: 'object' } }],
  callTool: async () => ({ text: 'ok', isError: false }), close: async () => {} }, Object.getOwnPropertyDescriptors(over));
const mgrOf = (servers: ResolvedMcpServer[], connectionFactory: (s: ResolvedMcpServer) => unknown) =>
  new McpManager({ registry: { resolveAllEnabled: async () => servers }, connectionFactory: connectionFactory as any });
function deps(connectSpy = vi.fn(), closeSpy = vi.fn()) {
  return { registry: { resolveAllEnabled: async () => [server()] } as any,
    connectionFactory: (() => conn({ connect: async () => { connectSpy(); }, close: async () => { closeSpy(); } })) as any };
}

describe('McpManager', () => {
  function generationHarness() {
    let current: ResolvedMcpServer[] = [{ id: 'demo', label: 'Demo', enabled: true,
      transport: { type: 'stdio', command: 'old', args: ['a'] }, origin: { kind: 'user' }, missingSecrets: [], env: { TOKEN: 'OLD' } }];
    const connections: Array<{ config: ResolvedMcpServer; close: ReturnType<typeof vi.fn>; get closed(): boolean }> = [];
    const manager = new McpManager({ registry: { resolveAllEnabled: async () => current },
      connectionFactory: (config) => {
        let closed = false;
        const entry = { config, close: vi.fn(async () => { closed = true; }), get closed() { return closed; } };
        connections.push(entry);
        return { get state() { return closed ? 'idle' as const : 'ready' as const; }, lastError: null,
          connect: async () => {}, listTools: () => [{ name: 'search', inputSchema: { type: 'object' } }],
          callTool: async () => ({ text: config.env?.TOKEN ?? '', isError: closed }), close: entry.close };
      } });
    return { manager, connections, get current() { return current; }, set current(value: ResolvedMcpServer[]) { current = value; } };
  }

  it('keeps existing holders on old config while command and resolved credential changes create a new connection', async () => {
    const h = generationHarness();
    const old = await h.manager.acquire('old');
    h.current[0].transport = { type: 'stdio', command: 'new', args: ['b'] }; // mutate SAME registry object
    h.current[0].env!.TOKEN = 'NEW';
    const fresh = await h.manager.acquire('fresh');
    expect(h.connections).toHaveLength(2);
    expect((await old.servers[0].call('search', {}, new AbortController().signal)).text).toBe('OLD');
    expect((await fresh.servers[0].call('search', {}, new AbortController().signal)).text).toBe('NEW');
    expect(h.manager.status().map(s => s.id)).toEqual(['demo']);
    await old.release();
    expect(h.connections[0].close).toHaveBeenCalledTimes(1);
    expect(h.connections[1].close).not.toHaveBeenCalled();
    await fresh.release();
    expect(h.connections[1].close).toHaveBeenCalledTimes(1);
  });

  it('reuses unchanged config despite label changes and creates new generations for A to B to A', async () => {
    const h = generationHarness();
    const a1 = await h.manager.acquire('a1');
    h.current = [{ ...h.current[0], label: 'Renamed' }];
    const a2 = await h.manager.acquire('a2');
    expect(h.connections).toHaveLength(1);
    expect(a2.servers[0].label).toBe('Renamed');
    h.current = [{ ...h.current[0], env: { TOKEN: 'B' } }];
    const b = await h.manager.acquire('b');
    h.current = [{ ...h.current[0], env: { TOKEN: 'OLD' } }];
    const a3 = await h.manager.acquire('a3');
    expect(h.connections).toHaveLength(3);
    await a1.release(); await a2.release(); await b.release();
    expect(h.connections[2].close).not.toHaveBeenCalled();
    await a3.release();
    expect(h.connections.map(c => c.close.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it('compares HTTP url and headers, stdio cwd and args, and setup state without leaking old holders', async () => {
    const h = generationHarness();
    const leases = [await h.manager.acquire('a')];
    for (const transport of [
      { type: 'stdio' as const, command: 'old', args: ['a'], cwd: '/work' },
      { type: 'http' as const, url: 'https://one.invalid' },
      { type: 'http' as const, url: 'https://two.invalid' },
    ]) {
      h.current = [{ ...h.current[0], transport }];
      leases.push(await h.manager.acquire('next'));
    }
    h.current = [{ ...h.current[0], headers: { Authorization: 'BEARER' } }];
    leases.push(await h.manager.acquire('header'));
    h.current = [{ ...h.current[0], missingSecrets: ['AUTH'], headers: {} }];
    leases.push(await h.manager.acquire('missing'));
    expect(leases.at(-1)!.servers).toEqual([]);
    h.current = [{ ...h.current[0], missingSecrets: [], headers: { Authorization: 'BEARER' } }];
    leases.push(await h.manager.acquire('restored'));
    expect(h.connections).toHaveLength(6);
    expect(leases.at(-1)!.servers).toHaveLength(1);
    expect(h.manager.status()).toHaveLength(1);
    for (const lease of leases) await lease.release();
    expect(h.connections.every(c => c.close.mock.calls.length === 1)).toBe(true);
  });

  it('does not attach a disabled server to a new lease while an older snapshot works', async () => {
    const h = generationHarness();
    const old = await h.manager.acquire('old');
    h.current = [];
    const next = await h.manager.acquire('next');
    expect(next.servers).toEqual([]);
    expect((await old.servers[0].call('search', {}, new AbortController().signal)).text).toBe('OLD');
    await next.release(); await old.release();
    expect(h.connections[0].close).toHaveBeenCalledTimes(1);
  });

  it('closes retired and current generations in destroyAll without double closing after release', async () => {
    const h = generationHarness();
    const a = await h.manager.acquire('a');
    h.current = [{ ...h.current[0], env: { TOKEN: 'B' } }];
    const b = await h.manager.acquire('b');
    await h.manager.destroyAll();
    expect(h.connections.map(c => c.close.mock.calls.length)).toEqual([1, 1]);
    expect(h.manager.status()).toEqual([]);
    await a.release(); await b.release();
    expect(h.connections.map(c => c.close.mock.calls.length)).toEqual([1, 1]);
  });
  it('destroyAll waits for a released generation already closing, including repeated teardown', async () => {
    let finishClose!: () => void;
    const closeBlocked = new Promise<void>(resolve => { finishClose = resolve; });
    let closeStarted!: () => void;
    const started = new Promise<void>(resolve => { closeStarted = resolve; });
    const close = vi.fn(async () => { closeStarted(); await closeBlocked; });
    const mgr = new McpManager({ registry: deps().registry, connectionFactory: () => ({
      state: 'ready' as const, lastError: null, connect: async () => {}, listTools: () => [],
      callTool: async () => ({ text: 'ok', isError: false }), close,
    }) });
    const lease = await mgr.acquire('old');
    const releasing = lease.release();
    await started; // deterministic: close has begun; no timer or sleep
    let firstSettled = false;
    let secondSettled = false;
    const first = mgr.destroyAll().then(() => { firstSettled = true; });
    const second = mgr.destroyAll().then(() => { secondSettled = true; });
    try {
      // Let every already-resolved close and teardown continuation run; the
      // blocked close alone must keep destroyAll pending.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      finishClose();
      await Promise.all([releasing, first, second]);
    }
    expect(close).toHaveBeenCalledTimes(1);
    expect(mgr.status()).toEqual([]);
  });

  it('destroyAll waits for retiring generations and does not clobber a newly current ID', async () => {
    let command = 'A';
    let finishOld!: () => void;
    const oldBlocked = new Promise<void>(resolve => { finishOld = resolve; });
    let oldStarted!: () => void;
    const started = new Promise<void>(resolve => { oldStarted = resolve; });
    const closes = new Map<string, ReturnType<typeof vi.fn>>();
    const factory = vi.fn((server: ResolvedMcpServer) => {
      const name = server.transport.type === 'stdio' ? server.transport.command : '';
      const close = vi.fn(async () => { if (name === 'A') { oldStarted(); await oldBlocked; } });
      closes.set(name, close);
      return { state: 'ready' as const, lastError: null, connect: async () => {}, listTools: () => [],
        callTool: async () => ({ text: name, isError: false }), close };
    });
    const mgr = new McpManager({ registry: { resolveAllEnabled: async (): Promise<ResolvedMcpServer[]> => [
      { id: 'demo', label: 'Demo', enabled: true, origin: { kind: 'user' }, missingSecrets: [],
        transport: { type: 'stdio', command } },
    ] }, connectionFactory: factory });
    const a = await mgr.acquire('a');
    command = 'B';
    const b = await mgr.acquire('b');
    const releaseA = a.release();
    await started;
    let settled = false;
    const destroying = mgr.destroyAll().then(() => { settled = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false); // B closed; released A still pending
      expect(closes.get('B')).toHaveBeenCalledTimes(1);
      // A post-destroy acquisition gets C, not a stale entry or a hold on A/B.
      command = 'C';
      const c = await mgr.acquire('c');
      try {
        expect(factory).toHaveBeenCalledTimes(3);
        expect(mgr.status()).toHaveLength(1);
        await b.release(); // old lease cannot remove current C
        expect(mgr.status()).toHaveLength(1);
      } finally {
        await c.release();
      }
    } finally {
      finishOld();
      await Promise.all([releaseA, destroying]);
    }
    expect(closes.get('A')).toHaveBeenCalledTimes(1);
    expect(closes.get('B')).toHaveBeenCalledTimes(1);
    expect(closes.get('C')).toHaveBeenCalledTimes(1);
  });

  it('a new acquisition during an old generation close cannot inherit the closing connection', async () => {
    let command = 'A';
    let finishClose!: () => void;
    const closing = new Promise<void>(resolve => { finishClose = resolve; });
    const close = vi.fn();
    const factory = vi.fn((s: ResolvedMcpServer) => ({ state: 'ready' as const, lastError: null,
      connect: async () => {}, listTools: () => [],
      callTool: async () => ({ text: (s.transport as { command: string }).command, isError: false }),
      close: async () => { close(s.transport); if ((s.transport as { command: string }).command === 'A') await closing; } }));
    const mgr = new McpManager({ registry: { resolveAllEnabled: async () => [{ id: 'demo', label: 'Demo', enabled: true,
      origin: { kind: 'user' as const }, missingSecrets: [], transport: { type: 'stdio' as const, command } }] }, connectionFactory: factory });
    const a = await mgr.acquire('a');
    command = 'B';
    const b = await mgr.acquire('b');
    const releaseA = a.release();
    expect(close).toHaveBeenCalledTimes(1);
    command = 'A';
    const next = await mgr.acquire('next');
    expect(factory).toHaveBeenCalledTimes(3);
    expect((await next.servers[0].call('tool', {}, new AbortController().signal)).text).toBe('A');
    finishClose(); await releaseA;
    expect(mgr.status()).toHaveLength(1);
    await b.release(); await next.release();
    expect(close).toHaveBeenCalledTimes(3);
  });

  it('keeps a failed connect generation for existing holders but replaces it after settings change', async () => {
    let command = 'broken';
    const factory = vi.fn((s: ResolvedMcpServer) => ({
      state: s.transport.type === 'stdio' && s.transport.command === 'broken' ? 'error' as const : 'ready' as const,
      lastError: s.transport.type === 'stdio' && s.transport.command === 'broken' ? 'spawn failed' : null,
      connect: async () => {}, listTools: () => [], callTool: async () => ({ text: 'ok', isError: false }), close: async () => {},
    }));
    const mgr = new McpManager({ registry: { resolveAllEnabled: async () => [{ id: 'demo', label: 'Demo', enabled: true,
      origin: { kind: 'user' as const }, missingSecrets: [], transport: { type: 'stdio' as const, command } }] }, connectionFactory: factory });
    const failed = await mgr.acquire('failed');
    expect(failed.servers).toEqual([]);
    command = 'fixed';
    const good = await mgr.acquire('good');
    expect(good.servers).toHaveLength(1);
    expect(mgr.status()).toEqual([{ id: 'demo', state: 'ready', error: null }]);
    expect(factory).toHaveBeenCalledTimes(2);
    await failed.release(); await good.release();
  });

  it('reports redacted unavailable servers alongside working servers in registry order', async () => {
    const base: ResolvedMcpServer = { id: 'good', label: 'Working', enabled: true,
      origin: { kind: 'user' }, missingSecrets: [], transport: { type: 'stdio', command: 'node' } };
    const servers: ResolvedMcpServer[] = [base,
      { ...base, id: 'bad', label: 'Broken', env: { TOKEN: 'env-secret' }, headers: { Authorization: 'Bearer header-secret' },
        transport: { type: 'http', url: 'https://user-secret:pass-secret@example.invalid/?key=query-secret' } },
      { ...base, id: 'setup', label: 'Setup', missingSecrets: ['API_KEY'] },
      { ...base, id: 'args', label: 'Arguments', transport: { type: 'stdio', command: 'node', args: ['--token=arg-secret'] } },
    ];
    const mgr = new McpManager({ registry: { resolveAllEnabled: async () => servers }, connectionFactory: server => ({
      state: server.id === 'good' ? 'ready' : 'error',
      lastError: server.id === 'bad' ? 'env-secret header-secret user-secret pass-secret query-secret' : 'arg-secret',
      connect: async () => {}, listTools: () => [], callTool: async () => ({ text: 'ok', isError: false }), close: async () => {},
    }) });
    const lease = await mgr.acquire('mixed');
    expect(lease.servers.map(s => s.id)).toEqual(['good']);
    expect(lease.unavailableServers).toEqual([
      { id: 'bad', label: 'Broken', error: '[redacted] [redacted] [redacted] [redacted] [redacted]' },
      { id: 'setup', label: 'Setup', error: 'Setup needs setup — missing secret(s): API_KEY.' },
      { id: 'args', label: 'Arguments', error: '[redacted]' },
    ]);
    await lease.release();
  });

  it.each(['error', 'needs-setup'] as const)('explicit retry replaces only settled %s entries and preserves exact lease generations', async failure => {
    const closeOld = vi.fn();
    const closeNew = vi.fn();
    const closeReady = vi.fn();
    let attempts = 0;
    const base: ResolvedMcpServer = { id: 'bad', label: 'Broken', enabled: true,
      origin: { kind: 'user' }, missingSecrets: [], transport: { type: 'stdio', command: 'node' } };
    const factory = vi.fn((server: ResolvedMcpServer) => {
      const firstFailure = server.id === 'bad' && ++attempts === 1;
      return { state: firstFailure ? failure : 'ready' as const, lastError: firstFailure ? 'failed' : null,
        connect: async () => {}, listTools: () => [], callTool: async () => ({ text: 'ok', isError: false }),
        close: server.id === 'good' ? closeReady : firstFailure ? closeOld : closeNew };
    });
    const mgr = new McpManager({ registry: { resolveAllEnabled: async () => [base, { ...base, id: 'good' }] }, connectionFactory: factory });
    const old = await mgr.acquire('same');
    const ordinary = await mgr.acquire('ordinary');
    expect(factory).toHaveBeenCalledTimes(2); // default acquire must not retry
    const fresh = await mgr.acquire('same', { retryFailed: true });
    expect(factory).toHaveBeenCalledTimes(3); // working entry is reused
    expect(fresh.servers.map(s => s.id)).toEqual(['bad', 'good']);
    await old.release(); await old.release();
    expect(closeOld).not.toHaveBeenCalled(); // ordinary still holds OLD
    expect(closeNew).not.toHaveBeenCalled();
    await fresh.release(); await fresh.release();
    expect(closeNew).toHaveBeenCalledTimes(1);
    expect(closeOld).not.toHaveBeenCalled(); // NEW release cannot close OLD
    expect(closeReady).not.toHaveBeenCalled();
    await ordinary.release();
    expect(closeOld).toHaveBeenCalledTimes(1);
    expect(closeReady).toHaveBeenCalledTimes(1);
    expect(mgr.status()).toEqual([]);
  });

  it('coalesces simultaneous explicit retries on the new connecting generation', async () => {
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    let started!: () => void;
    const connecting = new Promise<void>(resolve => { started = resolve; });
    let attempts = 0;
    const factory = vi.fn(() => {
      const first = ++attempts === 1;
      // Even an error state during a pending handshake is not a settled failure.
      return { state: 'error' as const, lastError: 'failed', connect: async () => { if (!first) { started(); await blocked; } },
        listTools: () => [], callTool: async () => ({ text: '', isError: true }), close: vi.fn(async () => {}) };
    });
    const mgr = new McpManager({ registry: deps().registry, connectionFactory: factory });
    const old = await mgr.acquire('old');
    const p1 = mgr.acquire('one', { retryFailed: true });
    const p2 = mgr.acquire('two', { retryFailed: true });
    await new Promise<void>(resolve => setImmediate(resolve)); // settle both registry continuations
    expect(factory).toHaveBeenCalledTimes(2);
    await connecting;
    finish();
    const [one, two] = await Promise.all([p1, p2]);
    await old.release(); await one.release();
    expect(factory.mock.results[1].value.close).not.toHaveBeenCalled();
    await two.release();
    expect(factory.mock.results.map(r => r.value.close.mock.calls.length)).toEqual([1, 1]);
  });

  it('joins the replacement generation even when delayed retry registry resolution sees it already failed', async () => {
    const servers: ResolvedMcpServer[] = [{ id: 'demo', label: 'Demo', enabled: true,
      origin: { kind: 'user' }, missingSecrets: [], transport: { type: 'stdio', command: 'node' } }];
    let resolveDelayed!: (value: ResolvedMcpServer[]) => void;
    const delayed = new Promise<ResolvedMcpServer[]>(resolve => { resolveDelayed = resolve; });
    const registry = { resolveAllEnabled: vi.fn().mockResolvedValueOnce(servers)
      .mockResolvedValueOnce(servers).mockReturnValueOnce(delayed) };
    const factory = vi.fn(() => ({ state: 'error' as const, lastError: 'failed',
      connect: async () => {}, listTools: () => [],
      callTool: async () => ({ text: '', isError: true }), close: vi.fn(async () => {}) }));
    const manager = new McpManager({ registry, connectionFactory: factory });
    const old = await manager.acquire('same');
    const a = manager.acquire('same', { retryFailed: true });
    const b = manager.acquire('same', { retryFailed: true });
    const one = await a; // replacement E1 is already a settled failure before B resumes
    resolveDelayed(servers);
    const two = await b;
    expect(factory).toHaveBeenCalledTimes(2);
    await old.release(); await old.release();
    expect(factory.mock.results[0].value.close).toHaveBeenCalledOnce();
    expect(factory.mock.results[1].value.close).not.toHaveBeenCalled();
    await one.release(); await one.release();
    expect(factory.mock.results[1].value.close).not.toHaveBeenCalled();
    expect(manager.status()).toHaveLength(1);
    await two.release(); await two.release();
    expect(factory.mock.results.map(r => r.value.close.mock.calls.length)).toEqual([1, 1]);
    expect(manager.status()).toEqual([]);
  });

  it('joins a connecting replacement even if it fails while the later retry resolves its registry', async () => {
    const servers: ResolvedMcpServer[] = [{ id: 'demo', label: 'Demo', enabled: true,
      origin: { kind: 'user' }, missingSecrets: [], transport: { type: 'stdio', command: 'node' } }];
    let resolveRegistry!: (value: ResolvedMcpServer[]) => void, finish!: () => void, started!: () => void;
    const delayed = new Promise<ResolvedMcpServer[]>(resolve => { resolveRegistry = resolve; });
    const handshake = new Promise<void>(resolve => { finish = resolve; });
    const connecting = new Promise<void>(resolve => { started = resolve; });
    const registry = { resolveAllEnabled: vi.fn().mockResolvedValueOnce(servers)
      .mockResolvedValueOnce(servers).mockReturnValueOnce(delayed) };
    let created = 0;
    const factory = vi.fn(() => {
      const replacement = ++created > 1;
      return { state: 'error' as const, lastError: 'failed',
        connect: async () => { if (replacement) { started(); await handshake; } },
        listTools: () => [], callTool: async () => ({ text: '', isError: true }), close: vi.fn(async () => {}) };
    });
    const manager = new McpManager({ registry, connectionFactory: factory });
    const old = await manager.acquire('old');
    const a = manager.acquire('one', { retryFailed: true });
    await connecting; // B arrives only after E1 was installed and began its handshake.
    const b = manager.acquire('two', { retryFailed: true });
    finish(); const one = await a;
    resolveRegistry(servers); const two = await b;
    try {
      expect(factory).toHaveBeenCalledTimes(2);
      await old.release(); await one.release();
      expect(factory.mock.results[1].value.close).not.toHaveBeenCalled();
      await two.release();
      expect(factory.mock.results.map(r => r.value.close.mock.calls.length)).toEqual([1, 1]);
    } finally { await manager.destroyAll(); }
  });

  it('does not connect when registry resolution spans destroyAll and permits a later acquire', async () => {
    let resolveRegistry!: (servers: ResolvedMcpServer[]) => void;
    const pending = new Promise<ResolvedMcpServer[]>(resolve => { resolveRegistry = resolve; });
    const d = deps();
    const factory = vi.fn(() => d.connectionFactory());
    const resolveAllEnabled = vi.fn().mockReturnValueOnce(pending).mockImplementation(d.registry.resolveAllEnabled);
    const mgr = new McpManager({ registry: { resolveAllEnabled }, connectionFactory: factory });
    const acquiring = mgr.acquire('stale');
    const rejected = expect(acquiring).rejects.toThrow('MCP acquisition invalidated by destroyAll');
    await mgr.destroyAll();
    resolveRegistry(await d.registry.resolveAllEnabled());
    await rejected;
    expect(factory).not.toHaveBeenCalled();
    expect(mgr.status()).toEqual([]);
    const fresh = await mgr.acquire('fresh');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fresh.servers).toHaveLength(1);
    await fresh.release();
  });

  it('pools one connection across sessions, refcounts holders (release is idempotent), and destroyAll closes regardless of refcount', async () => {
    const connect = vi.fn(), close = vi.fn();
    const mgr = new McpManager(deps(connect, close));
    const l1 = await mgr.acquire('s1');
    const l2 = await mgr.acquire('s2');
    expect(connect).toHaveBeenCalledTimes(1);
    // WHY: a session torn down on two routes must not double-decrement and close a server another session still uses.
    await l1.release(); await l1.release(); await l1.release();
    expect(close).not.toHaveBeenCalled();
    await l2.release();
    expect(close).toHaveBeenCalledTimes(1);

    const close2 = vi.fn();
    const mgr2 = new McpManager(deps(vi.fn(), close2));
    await mgr2.acquire('s1'); await mgr2.acquire('s2');
    await mgr2.destroyAll();
    expect(close2).toHaveBeenCalledTimes(1);
  });

  // WHY: a resumed session reuses its id; under the old release(sessionId) API the outgoing generation's
  // release closed the connection the incoming generation had just been handed. Each acquire mints its own
  // lease id. `state` transitions so a premature close is observable as more than a spy count.
  it('the outgoing generation of a resumed session cannot close the incoming one\'s connection', async () => {
    let state: 'idle' | 'ready' = 'idle';
    const close = vi.fn();
    const mgr = mgrOf([server()], () => conn({
      get state() { return state; }, connect: async () => { state = 'ready'; },
      listTools: () => [{ name: 'search', inputSchema: { type: 'object' } }],
      close: async () => { state = 'idle'; close(); },
    }));
    const outgoing = await mgr.acquire('s1');
    const incoming = await mgr.acquire('s1');
    expect(incoming.servers).toHaveLength(1);
    await outgoing.release();
    expect(close).not.toHaveBeenCalled();
    await expect(incoming.servers[0].call('search', {}, new AbortController().signal))
      .resolves.toEqual({ text: 'ok', isError: false });
    await incoming.release();
    expect(close).toHaveBeenCalledTimes(1);
  });

  // Overlap (NativeSessionHost.destroy() releasing while resume() acquires): the old connection may legitimately
  // close and respawn once; what matters is the incoming lease ends with exactly one WORKING connection.
  it('an overlapping release and re-acquire of one session id leave a working connection', async () => {
    let live = 0;
    const mgr = mgrOf([server()], () => {
      let state: 'idle' | 'ready' = 'idle';
      return conn({ get state() { return state; }, connect: async () => { state = 'ready'; live++; },
        close: async () => { state = 'idle'; live--; } });
    });
    const gen1 = await mgr.acquire('s1');
    const acquiring = mgr.acquire('s1');
    const releasing = gen1.release();
    const [gen2] = await Promise.all([acquiring, releasing]);
    expect(gen2.servers).toHaveLength(1);
    await expect(gen2.servers[0].call('search', {}, new AbortController().signal))
      .resolves.toEqual({ text: 'ok', isError: false });
    expect(live).toBe(1);
    await gen2.release();
    expect(live).toBe(0);
    expect(mgr.status()).toEqual([]);
  });

  it('connects once when two acquire()s race before connect() resolves', async () => {
    const connect = vi.fn();
    let resolveConnect: () => void = () => {};
    const mgr = mgrOf([server()], () => conn({
      connect: () => { connect(); return new Promise<void>((r) => { resolveConnect = r; }); },
    }));
    const p1 = mgr.acquire('s1');
    const p2 = mgr.acquire('s2');
    await new Promise<void>((r) => setImmediate(r)); // settle: both calls are past registry resolution
    resolveConnect();
    await Promise.all([p1, p2]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  // WHY: the only path where holders register without a lease reaching a caller is acquire() throwing midway;
  // it must clean up or the pooled subprocess is stranded for the life of the app.
  it('an acquire() that throws mid-flight releases the holders it already registered', async () => {
    const close = vi.fn();
    const mgr = mgrOf([server()], () => conn({
      connect: async () => { throw new Error('spawn node ENOENT'); }, close: async () => { close(); },
    }));
    await expect(mgr.acquire('s1')).rejects.toThrow('spawn node ENOENT'); // original error survives
    expect(close).toHaveBeenCalledTimes(1);
    expect(mgr.status()).toEqual([]);
  });

  // WHY: mcp-reconciler skips servers with missingSecrets, but acquire() used to connect them with a partial
  // env, surfacing an opaque auth error instead of naming the missing secret.
  it('a server with missingSecrets is never connected and reports needs-setup naming the key', async () => {
    const connect = vi.fn();
    const mgr = mgrOf([server({ id: 'gmail', missingSecrets: ['GMAIL_TOKEN'] })], () => conn({ connect: async () => { connect(); } }));
    const lease = await mgr.acquire('s1');
    expect(connect).not.toHaveBeenCalled();
    expect(lease.servers).toEqual([]);
    const status = mgr.status().find((s) => s.id === 'gmail');
    expect(status?.state).toBe('needs-setup');
    expect(status?.error).toContain('GMAIL_TOKEN');
  });

  // WHY: an unguarded `await conn.close()` in the release loop let one rejecting close strand later servers.
  it('a close() that rejects for one server does not strand the others in the same release', async () => {
    const closeGood = vi.fn();
    const mgr = mgrOf([server({ id: 'bad' }), server({ id: 'good' })], (s: ResolvedMcpServer) => conn({
      close: async () => { if (s.id === 'bad') throw new Error('close failed'); closeGood(); },
    }));
    const lease = await mgr.acquire('s1');
    await expect(lease.release()).resolves.toBeUndefined();
    expect(closeGood).toHaveBeenCalledTimes(1);
  });

  it('a failing server does not prevent healthy ones from being returned', async () => {
    const mgr = mgrOf([server({ id: 'bad' }), server({ id: 'good' })], (s: ResolvedMcpServer) =>
      s.id === 'bad' ? conn({ state: 'error', lastError: 'spawn x ENOENT' }) : conn());
    const lease = await mgr.acquire('s1');
    expect(lease.servers.map(r => r.id)).toEqual(['good']);
    expect(mgr.status().find(s => s.id === 'bad')?.error).toContain('ENOENT');
  });
});

describe('redactSecrets', () => {
  it('keeps the real failure reason but blanks every credential the server was given', () => {
    const server = { env: { API_KEY: 'sk-live-123456', DEBUG: '1' }, headers: { Authorization: 'Bearer tok_abcdefgh' } };
    const text = 'spawn node ENOENT; key sk-live-123456 rejected; token tok_abcdefgh expired; DEBUG=1';
    expect(redactSecrets(text, server)).toBe('spawn node ENOENT; key [redacted] rejected; token [redacted] expired; DEBUG=1');
    expect(redactSecrets(null, server)).toBeNull();
  });

  it('also blanks credentials written into the launch command or the server address', () => {
    const stdio = { env: {}, headers: {}, transport: { type: 'stdio' as const, command: 'npx',
      args: ['-y', 'some-server', '--api-key', 'sk-cmd-9876', '--token=tok-inline-5432', '--root', '/home/me/notes'] } };
    expect(redactSecrets('spawn failed: npx -y some-server --api-key sk-cmd-9876 --token=tok-inline-5432 --root /home/me/notes', stdio))
      .toBe('spawn failed: npx -y some-server --api-key [redacted] --token=[redacted] --root /home/me/notes');

    const http = { env: {}, headers: {}, transport: { type: 'http' as const, url: 'https://bobby:hunter22@mcp.example.com/sse?api_key=live%2Fabc123&region=eu-west' } };
    expect(redactSecrets('GET https://bobby:hunter22@mcp.example.com/sse?api_key=live%2Fabc123&region=eu-west -> 401 for live/abc123', http))
      .toBe('GET https://[redacted]:[redacted]@mcp.example.com/sse?api_key=[redacted]&region=[redacted] -> 401 for [redacted]');
  });
});
