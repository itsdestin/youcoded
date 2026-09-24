import { describe, it, expect, vi } from 'vitest';
import { McpManager } from '../src/main/harness/mcp/mcp-manager';

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

  // T2 (project-plugin-controls, design §3 "Enforcement"): acquire()'s new
  // optional allowIds must filter BEFORE any connect/spawn — a turned-off
  // server must never even reach connectionFactory, not merely be dropped
  // from the returned list the way a broken server is.
  describe('acquire(sessionId, allowIds)', () => {
    function twoServerDeps(connectSpy: (id: string) => void) {
      const registry = {
        resolveAllEnabled: async () => ([
          { id: 'on', label: 'On', enabled: true, transport: { type: 'stdio', command: 'x' }, origin: { kind: 'user' }, missingSecrets: [] },
          { id: 'off', label: 'Off', enabled: true, transport: { type: 'stdio', command: 'y' }, origin: { kind: 'user' }, missingSecrets: [] },
        ] as any),
      };
      const connectionFactory = (s: any) => ({
        state: 'ready' as const, lastError: null,
        connect: async () => { connectSpy(s.id); },
        listTools: () => [{ name: 't', inputSchema: { type: 'object' } }],
        callTool: async () => ({ text: 'ok', isError: false }),
        close: async () => {},
      });
      return { registry: registry as any, connectionFactory: connectionFactory as any };
    }

    it('a server left out of allowIds is never connected and never appears in the lease', async () => {
      const connected: string[] = [];
      const mgr = new McpManager(twoServerDeps((id) => connected.push(id)));
      const lease = await mgr.acquire('s1', new Set(['on']));
      expect(lease.servers.map((s) => s.id)).toEqual(['on']);
      expect(connected).toEqual(['on']); // 'off' was never even handed to connectionFactory
      expect(mgr.status().map((s) => s.id)).toEqual(['on']); // and never pooled either
    });

    it('an empty allowIds Set (B-1: outside any project) connects nothing', async () => {
      const connected: string[] = [];
      const mgr = new McpManager(twoServerDeps((id) => connected.push(id)));
      const lease = await mgr.acquire('s1', new Set());
      expect(lease.servers).toEqual([]);
      expect(connected).toEqual([]);
    });

    it('undefined allowIds keeps today\'s behaviour exactly — every enabled server is eligible', async () => {
      const connected: string[] = [];
      const mgr = new McpManager(twoServerDeps((id) => connected.push(id)));
      const lease = await mgr.acquire('s1');
      expect(lease.servers.map((s) => s.id).sort()).toEqual(['off', 'on']);
      expect(connected.sort()).toEqual(['off', 'on']);
    });
  });

  it('listEnabled reads the registry\'s raw enabled list without connecting anything', async () => {
    const connect = vi.fn();
    const registry = {
      resolveAllEnabled: async () => ([
        { id: 'demo', label: 'Demo', enabled: true, transport: { type: 'stdio', command: 'node' },
          origin: { kind: 'user' }, missingSecrets: [] },
      ] as any),
    };
    const connectionFactory = () => ({
      state: 'ready' as const, lastError: null, connect: async () => { connect(); },
      listTools: () => [], callTool: async () => ({ text: '', isError: false }), close: async () => {},
    });
    const mgr = new McpManager({ registry: registry as any, connectionFactory: connectionFactory as any });
    const rows = await mgr.listEnabled();
    expect(rows.map((r) => r.id)).toEqual(['demo']);
    expect(connect).not.toHaveBeenCalled();
    expect(mgr.status()).toEqual([]); // nothing pooled
  });
});
