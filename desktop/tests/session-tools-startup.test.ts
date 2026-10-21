import { describe, expect, it, vi } from 'vitest';
import { SessionToolsStartup } from '../src/main/harness/session-tools-startup';
import { McpManager, type McpLease } from '../src/main/harness/mcp/mcp-manager';
import type { ResolvedMcpServer } from '../src/main/harness/mcp/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function lease(unavailable = false) {
  return { servers: [], release: vi.fn(async () => {}), unavailableServers: unavailable
    ? [{ id: 'slow', label: 'Slow tools', error: 'The server did not respond.' }] : [] };
}
function fixture(acquire = vi.fn(async (_retry: boolean) => lease())) {
  const changed = vi.fn();
  const install = vi.fn(async () => {});
  const ready = vi.fn();
  let current = true;
  const startup = new SessionToolsStartup({ acquire, changed });
  const activate = () => startup.activate({ isCurrent: () => current, install, ready });
  return { startup, acquire, changed, install, ready, activate, obsolete: () => { current = false; } };
}

describe('session tool initialization', () => {
  it('opens independently of a pending connector and only becomes ready after installation', async () => {
    const pending = deferred<ReturnType<typeof lease>>();
    const f = fixture(vi.fn(() => pending.promise));
    f.startup.connect();
    f.activate();
    expect(f.startup.state.phase).toBe('connecting');
    expect(f.startup.isReady).toBe(false);
    expect(f.install).not.toHaveBeenCalled();
    const result = lease();
    pending.resolve(result);
    await f.startup.pending;
    expect(f.install).toHaveBeenCalledWith(result, expect.any(Function));
    expect(f.ready).toHaveBeenCalledOnce();
    expect(f.startup.isReady).toBe(true);
  });

  it('keeps a settled connection blocked until the session is actually wired', async () => {
    const f = fixture();
    f.startup.connect();
    await f.startup.pending;
    expect(f.startup.hasOutcome).toBe(true);
    expect(f.startup.isReady).toBe(false);
    expect(f.ready).not.toHaveBeenCalled();
    f.activate();
    await f.startup.pending;
    expect(f.startup.isReady).toBe(true);
  });

  it('requires explicit consent after failure and never submits a message', async () => {
    const broken = lease(true);
    const f = fixture(vi.fn(async () => broken));
    f.startup.connect(); f.activate();
    await f.startup.pending;
    expect(f.startup.state).toMatchObject({ phase: 'failed', canContinue: true, cause: 'tools' });
    expect(f.install).not.toHaveBeenCalled();
    expect(f.startup.isReady).toBe(false);
    const state = f.startup.state;
    if (state.phase !== 'failed') throw Error('Expected failed state');
    expect(f.startup.act('stale-attempt', 'continue')).toBe(false);
    expect(f.startup.act(state.attemptId, 'continue')).toBe(true);
    await f.startup.pending;
    expect(f.install).toHaveBeenCalledWith(broken, expect.any(Function));
    expect(f.startup.isReady).toBe(true);
    expect(f.startup.act(state.attemptId, 'retry')).toBe(false);
  });

  it('retries with a new attempt and releases only its previous lease', async () => {
    const first = lease(true), next = lease();
    const acquire = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(next);
    const f = fixture(acquire);
    f.startup.connect(); f.activate(); await f.startup.pending;
    const failed = f.startup.state;
    if (failed.phase !== 'failed') throw Error('Expected failed state');
    expect(f.startup.act(failed.attemptId, 'retry')).toBe(true);
    expect(f.startup.act(failed.attemptId, 'continue')).toBe(false);
    await f.startup.pending;
    expect(acquire.mock.calls).toEqual([[false], [true]]);
    expect(first.release).toHaveBeenCalledOnce();
    expect(next.release).not.toHaveBeenCalled();
    expect(f.startup.isReady).toBe(true);
    await f.startup.dispose();
    expect(next.release).toHaveBeenCalledOnce();
  });

  it('retries only the failed connection while retaining the healthy manager instance', async () => {
    const base: ResolvedMcpServer = { id: 'good', label: 'Good', enabled: true,
      origin: { kind: 'user' }, missingSecrets: [], transport: { type: 'stdio', command: 'node' } };
    let failures = 0;
    const connections: Array<{ id: string; close: ReturnType<typeof vi.fn> }> = [];
    const manager = new McpManager({ registry: { resolveAllEnabled: async () => [base, { ...base, id: 'bad' }] },
      connectionFactory: server => {
        const failed = server.id === 'bad' && ++failures === 1;
        let closed = false;
        const close = vi.fn(async () => { closed = true; });
        connections.push({ id: server.id, close });
        return { get state() { return closed ? 'idle' as const : failed ? 'error' as const : 'ready' as const; },
          lastError: failed ? 'failed' : null,
          connect: async () => {}, listTools: () => [], close,
          callTool: async () => ({ text: server.id, isError: closed }) };
      } });
    const install = vi.fn(async (_lease: McpLease | undefined) => {});
    const startup = new SessionToolsStartup({ acquire: retry => manager.acquire('same', { retryFailed: retry }), changed: vi.fn() });
    startup.connect(); startup.activate({ isCurrent: () => true, install, ready: vi.fn() });
    await startup.pending;
    const healthy = startup.lease!.servers[0];
    const state = startup.state;
    if (state.phase !== 'failed') throw Error('Expected failed state');
    startup.act(state.attemptId, 'retry'); await startup.pending;
    expect(connections.map(c => c.id)).toEqual(['good', 'bad', 'bad']);
    expect(connections[0].close).not.toHaveBeenCalled();
    expect(await healthy.call('tool', {}, new AbortController().signal)).toEqual({ text: 'good', isError: false });
    expect(startup.isReady).toBe(true);
    await startup.dispose();
    expect(connections.map(c => c.close.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it.each(['before', 'after'] as const)('retains the old lease until dispose when replacement settles %s disposal', async timing => {
    const first = lease(true), next = lease();
    const replacement = deferred<ReturnType<typeof lease>>();
    const f = fixture(vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(replacement.promise));
    f.startup.connect(); f.activate(); await f.startup.pending;
    const state = f.startup.state;
    if (state.phase !== 'failed') throw Error('Expected failed state');
    f.startup.act(state.attemptId, 'retry');
    await vi.waitFor(() => expect(f.acquire).toHaveBeenCalledTimes(2));
    expect(f.startup.lease).toBe(first);
    expect(first.release).not.toHaveBeenCalled();
    f.startup.cancel();
    const changes = f.changed.mock.calls.length;
    expect(first.release).not.toHaveBeenCalled();
    if (timing === 'after') await f.startup.dispose();
    replacement.resolve(next); await f.startup.pending;
    expect(next.release).toHaveBeenCalledOnce();
    if (timing === 'before') expect(first.release).not.toHaveBeenCalled();
    await f.startup.dispose(); await f.startup.dispose();
    expect(first.release).toHaveBeenCalledOnce();
    expect(next.release).toHaveBeenCalledOnce();
    expect(f.changed).toHaveBeenCalledTimes(changes);
    expect(f.install).not.toHaveBeenCalled();
    expect(f.ready).not.toHaveBeenCalled();
  });

  it('releases only the stale replacement lease when a newer attempt has already acquired', async () => {
    const first = lease(true), stale = lease(), current = lease();
    const replacement = deferred<ReturnType<typeof lease>>();
    const f = fixture(vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(replacement.promise).mockResolvedValueOnce(current));
    f.startup.connect(); f.activate(); await f.startup.pending;
    const state = f.startup.state;
    if (state.phase !== 'failed') throw Error('Expected failed state');
    f.startup.act(state.attemptId, 'retry');
    const staleTask = f.startup.pending;
    f.startup.connect(); await f.startup.pending;
    expect(f.startup.lease).toBe(current);
    expect(first.release).toHaveBeenCalledOnce();
    replacement.resolve(stale); await staleTask;
    expect(stale.release).toHaveBeenCalledOnce();
    expect(current.release).not.toHaveBeenCalled();
    expect(f.ready).toHaveBeenCalledOnce();
    await f.startup.dispose();
    expect(first.release).toHaveBeenCalledOnce();
    expect(stale.release).toHaveBeenCalledOnce();
    expect(current.release).toHaveBeenCalledOnce();
  });

  it('does not wait for a pending handshake when disposed and releases the late lease once', async () => {
    const pending = deferred<ReturnType<typeof lease>>();
    const f = fixture(vi.fn(() => pending.promise));
    f.startup.connect(); f.activate();
    await vi.waitFor(() => expect(f.acquire).toHaveBeenCalledOnce());
    await f.startup.dispose();
    const result = lease(); pending.resolve(result);
    await f.startup.pending;
    expect(result.release).toHaveBeenCalledOnce();
    expect(f.install).not.toHaveBeenCalled();
    expect(f.ready).not.toHaveBeenCalled();
    expect(f.startup.isReady).toBe(false);
  });

  it('does not attach or announce readiness to an obsolete session generation', async () => {
    const pending = deferred<ReturnType<typeof lease>>();
    const f = fixture(vi.fn(() => pending.promise));
    f.startup.connect(); f.activate();
    await vi.waitFor(() => expect(f.acquire).toHaveBeenCalledOnce());
    f.obsolete();
    const result = lease(); pending.resolve(result); await f.startup.pending;
    expect(result.release).toHaveBeenCalledOnce();
    expect(f.install).not.toHaveBeenCalled();
    expect(f.ready).not.toHaveBeenCalled();
  });

  it('blocks after installation/history preparation fails and does not offer skipping history', async () => {
    const f = fixture(); f.install.mockRejectedValueOnce(new Error('history locked'));
    f.startup.connect(); f.activate(); await f.startup.pending;
    expect(f.startup.state).toMatchObject({ phase: 'failed', cause: 'preparation', canContinue: false });
    expect(f.startup.isReady).toBe(false);
    const failed = f.startup.state;
    if (failed.phase !== 'failed') throw Error('Expected failed state');
    expect(f.startup.act(failed.attemptId, 'continue')).toBe(false);
  });

  it('ignores completion after disposal during final history installation', async () => {
    const installing = deferred<void>();
    const f = fixture(); f.install.mockImplementation(() => installing.promise);
    f.startup.connect(); f.activate();
    await vi.waitFor(() => expect(f.install).toHaveBeenCalledOnce());
    await f.startup.dispose(); installing.resolve(); await f.startup.pending;
    expect(f.ready).not.toHaveBeenCalled();
    expect(f.startup.isReady).toBe(false);
  });
});
