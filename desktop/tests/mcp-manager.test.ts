import { describe, it, expect, vi } from 'vitest';
import { McpManager, redactSecrets } from '../src/main/harness/mcp/mcp-manager';
import type { ResolvedMcpServer } from '../src/main/harness/mcp/types';

function deps(connectSpy = vi.fn(), closeSpy = vi.fn()) {
  const registry = {
    resolveAllEnabled: async () => ([
      { id: 'demo', label: 'Demo', enabled: true, transport: { type: 'stdio', command: 'node' },
        origin: { kind: 'user' }, missingSecrets: [] },
    ] as any),
  };
  const connectionFactory = () => ({
    state: 'ready' as const, lastError: null,
    connect: async () => { connectSpy(); },
    listTools: () => [{ name: 'search', description: 'd', inputSchema: { type: 'object' } }],
    callTool: async () => ({ text: 'ok', isError: false }),
    close: async () => { closeSpy(); },
  });
  return { registry: registry as any, connectionFactory: connectionFactory as any };
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

  it('connects a server once for two sessions', async () => {
    const connect = vi.fn();
    const mgr = new McpManager(deps(connect));
    await mgr.acquire('s1');
    await mgr.acquire('s2');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('keeps the connection while another session still holds it', async () => {
    const close = vi.fn();
    const mgr = new McpManager(deps(vi.fn(), close));
    const l1 = await mgr.acquire('s1');
    const l2 = await mgr.acquire('s2');
    await l1.release();
    expect(close).not.toHaveBeenCalled();
    await l2.release();
    expect(close).toHaveBeenCalledTimes(1);
  });

  // Releasing twice must not double-decrement. A session torn down on two
  // routes (an error path AND the normal destroy()) would otherwise drop the
  // refcount below what it actually holds and close a server ANOTHER session
  // is still using. Fails if release() ever stops being idempotent.
  it('releasing the same lease twice is a no-op, not a double decrement', async () => {
    const close = vi.fn();
    const mgr = new McpManager(deps(vi.fn(), close));
    const l1 = await mgr.acquire('s1');
    const l2 = await mgr.acquire('s2');
    await l1.release();
    await l1.release();
    await l1.release();
    // s2 still holds it — three release() calls on s1's lease must not have
    // taken the count past zero.
    expect(close).not.toHaveBeenCalled();
    await l2.release();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('destroyAll closes everything regardless of refcount', async () => {
    const close = vi.fn();
    const mgr = new McpManager(deps(vi.fn(), close));
    await mgr.acquire('s1'); await mgr.acquire('s2');
    await mgr.destroyAll();
    expect(close).toHaveBeenCalledTimes(1);
  });

  // THE regression test for the resumed-session bug (ROADMAP, 2026-07-31),
  // the reason acquire() returns a lease at all.
  //
  // A resumed session reuses its session id. Under the old
  // `release(sessionId)` API both generations wrote to ONE holder-set entry
  // keyed by that id, so the outgoing generation's release emptied the set and
  // closed the connection the INCOMING generation had just been handed — every
  // subsequent tool call in the resumed session returned "<server> is not
  // connected."
  //
  // This test fails on the old code: two acquire('s1') calls put a single
  // 's1' in `holders` (Set.add of a present member is a no-op), so the first
  // release closes it. It passes now because each acquire() mints its own
  // lease id, so the two generations are two distinct holders.
  //
  // The fake's `state` deliberately TRANSITIONS rather than being hardcoded
  // 'ready' — a premature close() has to be observable as more than a spy
  // count for this to be worth anything.
  it('the outgoing generation of a resumed session cannot close the incoming one\'s connection', async () => {
    let state: 'idle' | 'ready' = 'idle';
    const close = vi.fn();
    const registry = {
      resolveAllEnabled: async () => ([
        { id: 'demo', label: 'Demo', enabled: true, transport: { type: 'stdio', command: 'node' },
          origin: { kind: 'user' }, missingSecrets: [] },
      ] as any),
    };
    const connectionFactory = () => ({
      get state() { return state; },
      lastError: null as string | null,
      connect: async () => { state = 'ready'; },
      listTools: () => [{ name: 'search', inputSchema: { type: 'object' } }],
      callTool: async () => ({ text: 'ok', isError: false }),
      close: async () => { state = 'idle'; close(); },
    });
    const mgr = new McpManager({ registry: registry as any, connectionFactory: connectionFactory as any });

    // Generation 1 of session 's1'.
    const outgoing = await mgr.acquire('s1');
    expect(outgoing.servers).toHaveLength(1);

    // Generation 2 — a RESUME, so the very same session id.
    const incoming = await mgr.acquire('s1');
    expect(incoming.servers).toHaveLength(1);

    // The outgoing generation tears down. This is the exact call that used to
    // kill the incoming session's tools.
    await outgoing.release();

    expect(close).not.toHaveBeenCalled();
    // Not just "not closed" — still actually usable, which is what the user
    // experiences as the bug.
    await expect(
      incoming.servers[0].call('search', {}, new AbortController().signal),
    ).resolves.toEqual({ text: 'ok', isError: false });

    // And still not a leak: the last holder closes it.
    await incoming.release();
    expect(close).toHaveBeenCalledTimes(1);
  });

  // The same scenario with the two generations genuinely OVERLAPPING, which is
  // how it actually arises (NativeSessionHost.destroy() releasing while
  // resume() acquires under the same id).
  //
  // NOTE WHAT THIS DOES AND DOES NOT ASSERT. When the release lands before the
  // re-acquire has registered, the refcount legitimately hits zero, the old
  // connection closes, and the re-acquire spawns a FRESH one. That is correct —
  // one wasted respawn, no stolen connection. So this does not assert
  // "close was never called"; it asserts the thing the user actually
  // experiences: the incoming generation ends up holding a WORKING server, and
  // nothing is left pooled once it releases. An earlier draft of this test
  // asserted the stricter no-close and failed — the assertion was wrong, not
  // the code.
  it('an overlapping release and re-acquire of one session id leave a working connection', async () => {
    const close = vi.fn();
    let live = 0;
    const registry = {
      resolveAllEnabled: async () => ([
        { id: 'demo', label: 'Demo', enabled: true, transport: { type: 'stdio', command: 'node' },
          origin: { kind: 'user' }, missingSecrets: [] },
      ] as any),
    };
    // Each call builds its OWN connection object with its own state, so a
    // respawn is distinguishable from reuse of a closed one.
    const connectionFactory = () => {
      let state: 'idle' | 'ready' = 'idle';
      return {
        get state() { return state; },
        lastError: null as string | null,
        connect: async () => { state = 'ready'; live++; },
        listTools: () => [{ name: 'search', inputSchema: { type: 'object' } }],
        callTool: async () => ({ text: 'ok', isError: false }),
        close: async () => { state = 'idle'; live--; close(); },
      };
    };
    const mgr = new McpManager({ registry: registry as any, connectionFactory: connectionFactory as any });

    const gen1 = await mgr.acquire('s1');

    // Start the resume's acquire and the outgoing destroy's release together,
    // then let both settle in whatever order the microtask queue picks.
    const acquiring = mgr.acquire('s1');
    const releasing = gen1.release();
    const [gen2] = await Promise.all([acquiring, releasing]);

    // The incoming generation holds a usable server either way.
    expect(gen2.servers).toHaveLength(1);
    await expect(
      gen2.servers[0].call('search', {}, new AbortController().signal),
    ).resolves.toEqual({ text: 'ok', isError: false });
    expect(live).toBe(1); // exactly one connection open, not zero and not two

    // And it all unwinds cleanly — no entry left holding a spawned process.
    await gen2.release();
    expect(live).toBe(0);
    expect(mgr.status()).toEqual([]);
  });

  // The brief's other tests are all sequential awaits, which would not catch
  // a manager that calls connect() twice when two sessions start at nearly
  // the same moment. Real sessions DO start concurrently (Task 6 calls
  // acquire() per session), so this race is genuinely reachable, not
  // speculative — hence a real test, not just analysis in a report.
  it('connects once when two acquire()s race before connect() resolves', async () => {
    const connect = vi.fn();
    let resolveConnect: () => void = () => {};
    const registry = {
      resolveAllEnabled: async () => ([
        { id: 'demo', label: 'Demo', enabled: true, transport: { type: 'stdio', command: 'node' },
          origin: { kind: 'user' }, missingSecrets: [] },
      ] as any),
    };
    const connectionFactory = () => ({
      state: 'ready' as const, lastError: null,
      connect: () => { connect(); return new Promise<void>((r) => { resolveConnect = r; }); },
      listTools: () => [],
      callTool: async () => ({ text: 'ok', isError: false }),
      close: async () => {},
    });
    const mgr = new McpManager({ registry: registry as any, connectionFactory: connectionFactory as any });
    const p1 = mgr.acquire('s1');
    const p2 = mgr.acquire('s2');
    // Let both calls run past their `await resolveAllEnabled()` and into the
    // connect() call before we resolve it — setImmediate yields a full
    // macrotask, well past any number of microtask hops either call needs.
    await new Promise<void>((r) => setImmediate(r));
    resolveConnect();
    await Promise.all([p1, p2]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  // Every leak window this file used to pin (a release() landing before
  // resolveAllEnabled() resolved; between two servers' connects; during
  // pass 2) had one shape: release() running before acquire() had finished
  // registering its holders. Those tests are gone because the scenario is no
  // longer constructible — release() lives on the object acquire() returns, so
  // a caller cannot invoke it early. What survives is the ONE path where
  // holders can still be registered without a lease ever reaching a caller:
  // acquire() throwing partway through. That must clean up after itself, or
  // the pooled subprocess is stranded for the life of the app with nothing
  // left that could ever release it.
  it('an acquire() that throws mid-flight releases the holders it already registered', async () => {
    const close = vi.fn();
    const registry = {
      resolveAllEnabled: async () => ([
        { id: 'demo', label: 'Demo', enabled: true, transport: { type: 'stdio', command: 'node' },
          origin: { kind: 'user' }, missingSecrets: [] },
      ] as any),
    };
    const connectionFactory = () => ({
      state: 'ready' as const, lastError: null,
      // Pass 1 has already registered the holder by the time this rejects.
      connect: async () => { throw new Error('spawn node ENOENT'); },
      listTools: () => [],
      callTool: async () => ({ text: 'ok', isError: false }),
      close: async () => { close(); },
    });
    const mgr = new McpManager({ registry: registry as any, connectionFactory: connectionFactory as any });

    // The ORIGINAL error must survive — never replaced with a guessed cause.
    await expect(mgr.acquire('s1')).rejects.toThrow('spawn node ENOENT');
    // Holder cleaned up, connection closed, pool empty: a later acquire()
    // starts from scratch rather than inheriting a dead entry nobody holds.
    expect(close).toHaveBeenCalledTimes(1);
    expect(mgr.status()).toEqual([]);
  });

  // Regression test for Finding 6: mcp-reconciler.ts's projectToClaudeJson
  // already skips a server with missingSecrets (a synced entry whose secret
  // ciphertext isn't on THIS device) so Claude Code never sees it — but
  // McpManager.acquire() connected it anyway with a partial env/headers
  // object, handing a real subprocess a missing token and surfacing whatever
  // opaque auth error IT emits instead of a message naming the actual
  // missing secret. Fails on the pre-fix code (connect IS called); passes
  // once ensureConnected treats missingSecrets as needs-setup without ever
  // touching connectionFactory.
  it('a server with missingSecrets is never connected and reports needs-setup naming the key', async () => {
    const connect = vi.fn();
    const registry = {
      resolveAllEnabled: async () => ([
        {
          id: 'gmail', label: 'Gmail', enabled: true,
          transport: { type: 'stdio', command: 'npx', args: ['gmail-mcp'] },
          origin: { kind: 'user' }, missingSecrets: ['GMAIL_TOKEN'],
        },
      ] as any),
    };
    // A connectionFactory that WOULD prove the bug if ever invoked — asserted
    // never-called below rather than merely unused, so a regression that
    // calls it is caught even if its behavior happens to look harmless.
    const connectionFactory = () => ({
      state: 'ready' as const, lastError: null,
      connect: async () => { connect(); },
      listTools: () => [{ name: 'search', inputSchema: { type: 'object' } }],
      callTool: async () => ({ text: 'ok', isError: false }),
      close: async () => {},
    });
    const mgr = new McpManager({ registry: registry as any, connectionFactory: connectionFactory as any });

    const lease = await mgr.acquire('s1');

    expect(connect).not.toHaveBeenCalled();
    expect(lease.servers).toEqual([]); // excluded, same as any other not-ready server
    const status = mgr.status().find((s) => s.id === 'gmail');
    expect(status?.state).toBe('needs-setup');
    expect(status?.error).toContain('GMAIL_TOKEN');
  });

  // Regression test for Minor 9: `await entry.conn.close()` in the release
  // loop was unguarded — a close() that rejects (the real McpConnection's
  // never does, but the injected McpConnectionLike type permits it) would
  // throw OUT of the loop, stranding every remaining holder the same call had
  // not yet reached. Fails on the pre-fix code (the release rejects, and the
  // second server's close() is never even attempted); passes once the close()
  // call is wrapped in its own try/catch.
  it('a close() that rejects for one server does not strand the others in the same release', async () => {
    const closeGood = vi.fn();
    const registry = {
      resolveAllEnabled: async () => ([
        { id: 'bad', label: 'Bad', enabled: true, transport: { type: 'stdio', command: 'x' }, origin: { kind: 'user' }, missingSecrets: [] },
        { id: 'good', label: 'Good', enabled: true, transport: { type: 'stdio', command: 'y' }, origin: { kind: 'user' }, missingSecrets: [] },
      ] as any),
    };
    const connectionFactory = (s: any) => s.id === 'bad'
      ? { state: 'ready' as const, lastError: null, connect: async () => {}, listTools: () => [], callTool: async () => ({ text: '', isError: false }), close: async () => { throw new Error('close failed'); } }
      : { state: 'ready' as const, lastError: null, connect: async () => {}, listTools: () => [], callTool: async () => ({ text: '', isError: false }), close: async () => { closeGood(); } };
    const mgr = new McpManager({ registry: registry as any, connectionFactory: connectionFactory as any });

    const lease = await mgr.acquire('s1');
    await expect(lease.release()).resolves.toBeUndefined();
    expect(closeGood).toHaveBeenCalledTimes(1);
  });

  it('a failing server does not prevent healthy ones from being returned', async () => {
    const registry = { resolveAllEnabled: async () => ([
      { id: 'bad', label: 'Bad', enabled: true, transport: { type: 'stdio', command: 'x' }, origin: { kind: 'user' }, missingSecrets: [] },
      { id: 'good', label: 'Good', enabled: true, transport: { type: 'stdio', command: 'y' }, origin: { kind: 'user' }, missingSecrets: [] },
    ] as any) };
    const connectionFactory = (s: any) => s.id === 'bad'
      ? { state: 'error', lastError: 'spawn x ENOENT', connect: async () => {}, listTools: () => [], callTool: async () => ({ text: '', isError: true }), close: async () => {} }
      : { state: 'ready', lastError: null, connect: async () => {}, listTools: () => [{ name: 't', inputSchema: { type: 'object' } }], callTool: async () => ({ text: 'ok', isError: false }), close: async () => {} };
    const mgr = new McpManager({ registry: registry as any, connectionFactory: connectionFactory as any });
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
});
