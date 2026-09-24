// Plan 2b Task 9 — pins the requester-side takeover flow (createRequesterTakeover).
// When the user resumes a conversation another device holds, THIS device asks the
// holder to hand off, polls the lease until it frees (or times out at MAX_MS), then
// pulls the peer's final turn; admission during creation acquires the lease. All collaborators are
// injected fakes; the poll loop is driven with fake timers. The flow must NEVER
// throw (spec §3 never-block) — errors surface as {outcome:'error'}/{ok:false}.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequesterTakeover } from '../src/main/conversations/takeover';

// Build a deps bundle whose success-path fakes push a label into a shared order
// log so tests can assert BOTH which steps ran and in WHAT order.
function makeDeps(opts: {
  // query returns these results in sequence; the last one repeats forever.
  // `self` is the deviceId-derived "held by US" flag the lease client computes —
  // the requester keys on it, NOT on the `device` label (which collides across
  // installs that share a hostname).
  queryResults: Array<{ held: boolean; device?: string; self?: boolean }>;
  takeoverThrows?: boolean;
  // Undeliverable: leaseClient.takeover resolves null (hub had no delivery
  // path — see takeover.ts). Distinct from takeoverThrows (which simulates an
  // exception, mapped to 'error').
  takeoverReturnsNull?: boolean;
  queryThrows?: boolean;
  forceThrows?: boolean;
}) {
  const order: string[] = [];
  let qi = 0;
  const deps = {
    order,
    leaseClient: {
      takeover: vi.fn(async (sid: string) => {
        order.push(`takeover:${sid}`);
        if (opts.takeoverThrows) throw new Error('takeover blew up');
        if (opts.takeoverReturnsNull) return null;
      }),
      query: vi.fn(async (_sid: string) => {
        if (opts.queryThrows) throw new Error('query blew up');
        const r = opts.queryResults[Math.min(qi, opts.queryResults.length - 1)];
        qi += 1;
        return r;
      }),
      acquire: vi.fn(async (sid: string) => { order.push(`acquire:${sid}`); }),
    },
    syncNow: vi.fn(async () => { order.push('syncNow'); }),
    materializeOne: vi.fn(async (sid: string) => { order.push(`materialize:${sid}`); }),
    forceAcquire: vi.fn(async (sid: string) => {
      order.push(`force:${sid}`);
      if (opts.forceThrows) throw new Error('force blew up');
      return { ok: true };
    }),
    // Real timer-backed delay so vi.advanceTimersByTimeAsync drives the poll.
    delay: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  };
  return deps;
}

describe('createRequesterTakeover', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('takeover: holder releases after 2 polls -> acquired, in order syncNow -> materialize -> acquire', async () => {
    // held twice (holder hasn't released yet), then free.
    const deps = makeDeps({
      queryResults: [{ held: true, device: 'Laptop-B' }, { held: true, device: 'Laptop-B' }, { held: false }],
    });
    const flow = createRequesterTakeover(deps as any);
    const p = flow.takeover('c1');
    // Drive the two 1s poll gaps.
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await p;
    expect(res).toEqual({ outcome: 'ready' });
    // takeover first, then the free-path trio in the required order.
    expect(deps.order).toEqual(['takeover:c1', 'syncNow', 'materialize:c1']);
    expect(deps.leaseClient.query).toHaveBeenCalledTimes(3);
  });

  it('takeover: already free on the FIRST query -> acquired fast without waiting a poll', async () => {
    const deps = makeDeps({ queryResults: [{ held: false }] });
    const flow = createRequesterTakeover(deps as any);
    // No timer advance — the free check happens BEFORE the first sleep.
    const res = await flow.takeover('c1');
    expect(res).toEqual({ outcome: 'ready' });
    expect(deps.leaseClient.query).toHaveBeenCalledTimes(1);
    expect(deps.order).toEqual(['takeover:c1', 'syncNow', 'materialize:c1']);
  });

  it('takeover: a lease held by US (self:true, deviceId match) counts as free', async () => {
    // The lease client sets self:true when the holder's deviceId === our deviceId.
    const deps = makeDeps({ queryResults: [{ held: true, device: 'This-Device', self: true }] });
    const flow = createRequesterTakeover(deps as any);
    const res = await flow.takeover('c1');
    expect(res).toEqual({ outcome: 'ready' });
    expect(deps.leaseClient.acquire).not.toHaveBeenCalled();
  });

  it('takeover: a DIFFERENT install with the SAME device label is NOT self — the requester waits, never short-circuits', async () => {
    // Two installs share a hostname (the dev instance + built app dogfood gate,
    // or two same-hostname machines). The holder's label equals ours but its
    // per-install deviceId differs, so the lease client returns self:false. The
    // requester MUST NOT treat this as free — it polls until a genuine release,
    // here never happening, so it times out.
    //
    // Regression guard: the OLD label-based check (`q.device === selfDevice`)
    // would see device 'This-Device' === selfDevice 'This-Device' → treat it as
    // free → syncNow/materialize/acquire immediately → outcome 'acquired'. This
    // test asserts the opposite, so it FAILS against the old label-based code.
    const deps = makeDeps({ queryResults: [{ held: true, device: 'This-Device', self: false }] });
    const flow = createRequesterTakeover(deps as any);
    const p = flow.takeover('c1');
    // Advance past the 25s MAX_MS (raised from 10s once the holder's flush genuinely
    // awaits its push — see takeover.ts) so the poll loop exhausts its budget.
    await vi.advanceTimersByTimeAsync(26_000);
    const res = await p;
    expect(res).toEqual({ outcome: 'timeout' });
    // Did NOT short-circuit on a same-label lease: no free-path work ran.
    expect(deps.leaseClient.acquire).not.toHaveBeenCalled();
    expect(deps.syncNow).not.toHaveBeenCalled();
    expect(deps.materializeOne).not.toHaveBeenCalled();
  });

  it('takeover: holder never releases -> timeout after MAX_MS (no acquire)', async () => {
    const deps = makeDeps({ queryResults: [{ held: true, device: 'Laptop-B' }] });
    const flow = createRequesterTakeover(deps as any);
    const p = flow.takeover('c1');
    // Advance well past MAX_MS (now 25s — see takeover.ts) so every poll interval
    // elapses and the loop exits.
    await vi.advanceTimersByTimeAsync(26_000);
    const res = await p;
    expect(res).toEqual({ outcome: 'timeout' });
    expect(deps.leaseClient.acquire).not.toHaveBeenCalled();
    expect(deps.syncNow).not.toHaveBeenCalled();
    expect(deps.materializeOne).not.toHaveBeenCalled();
  });

  it('takeover: takeover() throwing -> error', async () => {
    const deps = makeDeps({ queryResults: [{ held: false }], takeoverThrows: true });
    const flow = createRequesterTakeover(deps as any);
    const res = await flow.takeover('c1');
    expect(res).toEqual({ outcome: 'error' });
  });

  it('takeover: leaseClient.takeover() resolving null -> undeliverable, poll never runs', async () => {
    // Hub had no delivery path (offline / not connected to any device) — the
    // holder was never asked, so the 25s poll must be skipped entirely: no
    // timer advance here, and query must never be called.
    const deps = makeDeps({ queryResults: [{ held: true, device: 'Laptop-B' }], takeoverReturnsNull: true });
    const flow = createRequesterTakeover(deps as any);
    const res = await flow.takeover('c1');
    expect(res).toEqual({ outcome: 'undeliverable' });
    expect(deps.leaseClient.query).not.toHaveBeenCalled();
    expect(deps.leaseClient.acquire).not.toHaveBeenCalled();
    expect(deps.syncNow).not.toHaveBeenCalled();
    expect(deps.materializeOne).not.toHaveBeenCalled();
    expect(deps.order).toEqual(['takeover:c1']);
  });

  it('takeover: query() throwing -> error', async () => {
    const deps = makeDeps({ queryResults: [{ held: false }], queryThrows: true });
    const flow = createRequesterTakeover(deps as any);
    const res = await flow.takeover('c1');
    expect(res).toEqual({ outcome: 'error' });
  });

  it('force: forceAcquire + syncNow + materialize -> ok, in order', async () => {
    const deps = makeDeps({ queryResults: [{ held: false }] });
    const flow = createRequesterTakeover(deps as any);
    const res = await flow.force('c1');
    expect(res).toEqual({ ok: true });
    expect(deps.order).toEqual(['force:c1', 'syncNow', 'materialize:c1']);
  });

  it('force: a hub timeout is not a confirmed takeover', async () => {
    const deps = makeDeps({ queryResults: [{ held: false }] });
    deps.forceAcquire.mockResolvedValueOnce(null as never);
    expect(await createRequesterTakeover(deps as any).force('c1')).toEqual({ ok: false });
    expect(deps.syncNow).not.toHaveBeenCalled();
  });

  it('force: forceAcquire throwing -> {ok:false}', async () => {
    const deps = makeDeps({ queryResults: [{ held: false }], forceThrows: true });
    const flow = createRequesterTakeover(deps as any);
    const res = await flow.force('c1');
    expect(res).toEqual({ ok: false });
  });

  it('takeover: materializeOne is NOT called until the syncNow promise RESOLVES (mirror-before-pull)', async () => {
    // §3.2 regression guard. The requester pulls the peer's final turn via
    // materializeOne right after syncNow. If syncNow is fire-and-forget (resolves
    // before the git push/pull actually runs), materialize grabs the STALE copy —
    // the lost-turns bug. The flow must AWAIT the injected syncNow before calling
    // materializeOne. Today's real syncNow is syncSpacesSyncNowAwaited (resolves only
    // after the push lands); this test pins that the flow honors the promise.
    const deps = makeDeps({ queryResults: [{ held: false }] });
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((r) => { releaseSync = r; });
    (deps.syncNow as any) = vi.fn(() => { deps.order.push('syncNow'); return syncGate; });
    const flow = createRequesterTakeover(deps as any);
    const p = flow.takeover('c1');

    // Let the microtask queue drain: takeover + query + syncNow have run, but the
    // flow is now parked awaiting syncGate. materializeOne must NOT have run yet.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(deps.syncNow).toHaveBeenCalled();
    expect(deps.materializeOne).not.toHaveBeenCalled();
    expect(deps.leaseClient.acquire).not.toHaveBeenCalled();

    // Release the sync (push landed) -> NOW materialize + acquire run.
    releaseSync();
    const res = await p;
    expect(res).toEqual({ outcome: 'ready' });
    expect(deps.order).toEqual(['takeover:c1', 'syncNow', 'materialize:c1']);
  });
});
