import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runLeaseTakeoverGate } from '../src/renderer/state/resume-lease-gate';

// The gate's three invisible rules. Two resume surfaces run this now (App's
// Resume Browser path and the buddy floater's list), so a change here that only
// one of them notices is exactly what this pins.

const leaseQuery = vi.fn();
const leaseTakeover = vi.fn();
const leaseForce = vi.fn();
const leaseClaim = vi.fn();
const leaseRelease = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).window = {
    claude: { syncSpaces: { leaseQuery, leaseTakeover, leaseForce, leaseClaim, leaseRelease } },
  };
});

const run = (askTakeover: any, onWarn = vi.fn(), extra: Record<string, unknown> = {}) =>
  runLeaseTakeoverGate({ claudeSessionId: 'sid', askTakeover, onWarn, ...extra });

const claimRun = (askTakeover: any, onWarn = vi.fn(), opts: { ask?: any } = {}) =>
  runLeaseTakeoverGate({
    claudeSessionId: 'sid',
    askTakeover,
    onWarn,
    claimLease: (id: string) => leaseClaim(id),
    askClaimDenied: opts.ask ?? ((device: string) => askTakeover(device, 'claim-denied')),
    onAbandon: leaseRelease,
  });

describe('runLeaseTakeoverGate', () => {
  it('proceeds without asking when the lease is not held', async () => {
    leaseQuery.mockResolvedValue({ held: false });
    const ask = vi.fn();
    expect(await run(ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('proceeds without asking when THIS install holds the lease', async () => {
    // `self` comes from the per-install deviceId, not the hostname. Without this
    // branch a lease left over from our own unclean shutdown pops a dialog
    // offering to take the conversation over from ourselves.
    leaseQuery.mockResolvedValue({ held: true, self: true, device: 'this-machine' });
    const ask = vi.fn();
    expect(await run(ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('aborts when the user declines the first ask', async () => {
    leaseQuery.mockResolvedValue({ held: true, self: false, device: 'laptop' });
    const ask = vi.fn().mockResolvedValue(false);
    expect(await run(ask)).toBe(false);
    expect(ask).toHaveBeenCalledWith('laptop', 'confirm');
    expect(leaseTakeover).not.toHaveBeenCalled();
  });

  it('never blames a device that was never asked', async () => {
    // 'undeliverable' means the hub had no delivery path at all. Re-using the
    // 'force' phase here would print "didn't answer" about a request that was
    // never sent — the dishonest framing the 3-state redesign replaced.
    leaseQuery.mockResolvedValue({ held: true, self: false, device: 'laptop' });
    leaseTakeover.mockResolvedValue({ outcome: 'undeliverable' });
    leaseForce.mockResolvedValue({ ok: true });
    const ask = vi.fn().mockResolvedValue(true);
    expect(await run(ask)).toBe(true);
    expect(ask).toHaveBeenNthCalledWith(2, 'laptop', 'undeliverable');
  });

  it('uses the force phase when the device WAS asked and stayed silent', async () => {
    leaseQuery.mockResolvedValue({ held: true, self: false, device: 'laptop' });
    leaseTakeover.mockResolvedValue({ outcome: 'timeout' });
    leaseForce.mockResolvedValue({ ok: true });
    const ask = vi.fn().mockResolvedValue(true);
    expect(await run(ask)).toBe(true);
    expect(ask).toHaveBeenNthCalledWith(2, 'laptop', 'force');
  });

  it('warns, but still proceeds, when the force did not actually take the lease', async () => {
    // The other device may still be live and writing. Silence here is what
    // masked the 2026-07-18 bug.
    leaseQuery.mockResolvedValue({ held: true, self: false, device: 'laptop' });
    leaseTakeover.mockResolvedValue({ outcome: 'timeout' });
    leaseForce.mockResolvedValue({ ok: false });
    const onWarn = vi.fn();
    expect(await run(vi.fn().mockResolvedValue(true), onWarn)).toBe(true);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('laptop'));
  });

  it('warns, but still proceeds, when the takeover request itself errored', async () => {
    leaseQuery.mockResolvedValue({ held: true, self: false, device: 'laptop' });
    leaseTakeover.mockResolvedValue({ outcome: 'error' });
    const onWarn = vi.fn();
    expect(await run(vi.fn().mockResolvedValue(true), onWarn)).toBe(true);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('laptop'));
  });

  it('NEVER hard-blocks: a thrown lease query still resumes', async () => {
    // A hub hiccup must not make the Resume button look broken (spec §3).
    leaseQuery.mockRejectedValue(new Error('hub down'));
    expect(await run(vi.fn())).toBe(true);
  });

  it('proceeds when the bridge has no syncSpaces at all', async () => {
    (globalThis as any).window = { claude: {} };
    expect(await run(vi.fn())).toBe(true);
  });
});

// Claim-before-open (deck Q-1/Q-2, 2026-09-21): the gate's first step claims the
// lease; a denial is the Q-2 message + Try again; a claim that cannot run is the
// escape hatch and proceeds exactly as the old path.
describe('runLeaseTakeoverGate — claim-before-open', () => {
  it('claims BEFORE the query gate: an acquired claim skips the query entirely', async () => {
    leaseClaim.mockResolvedValue({ outcome: 'acquired' });
    const ask = vi.fn();
    expect(await claimRun(ask)).toBe(true);
    expect(leaseQuery).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it('a denied claim asks Try again / Leave it and does NOT query', async () => {
    leaseClaim.mockResolvedValue({ outcome: 'denied', device: 'laptop' });
    const ask = vi.fn().mockResolvedValue(false); // Leave it
    expect(await claimRun(ask)).toBe(false);
    expect(ask).toHaveBeenCalledWith('laptop', 'claim-denied');
    expect(leaseQuery).not.toHaveBeenCalled();
  });

  it('Leave it after a denial also releases — a harmless no-op the hub confirms', async () => {
    // On a denial the DO granted nothing (acquire was refused, nothing was
    // re-stamped), so the release is a no-op — but calling onAbandon
    // unconditionally on every decline branch keeps ONE decline path, not two
    // to keep apart. Idempotent at the hub (release of a free lease = ok).
    leaseClaim.mockResolvedValue({ outcome: 'denied', device: 'laptop' });
    const ask = vi.fn().mockResolvedValue(false);
    await claimRun(ask);
    expect(leaseRelease).toHaveBeenCalled();
  });

  it('Try again + still denied falls through to the takeover gate, not warn-and-proceed', async () => {
    // Proceeding with a warned toast would open a session WITHOUT the lease
    // beside a live writer — the audit's H1 shape with a blessing. The takeover
    // gate is the real override path (its outcome is ownership via force, or an
    // honest abort); it must stay reachable now that the claim runs first.
    leaseClaim.mockResolvedValue({ outcome: 'denied', device: 'laptop' });
    leaseQuery.mockResolvedValue({ held: true, self: false, device: 'laptop' });
    // The takeover gate asks 'confirm'; the user accepts the takeover.
    const ask = vi.fn().mockImplementation((_device: string, phase: string) =>
      Promise.resolve(phase === 'claim-denied' || phase === 'confirm'));
    leaseTakeover.mockResolvedValue({ outcome: 'acquired' });
    expect(await claimRun(ask)).toBe(true);
    expect(leaseQuery).toHaveBeenCalled();
    expect(ask).toHaveBeenCalledWith('laptop', 'confirm');
    expect(leaseTakeover).toHaveBeenCalled();
  });

  it('Try again + still denied + user declines the takeover → abort, no session', async () => {
    leaseClaim.mockResolvedValue({ outcome: 'denied', device: 'laptop' });
    leaseQuery.mockResolvedValue({ held: true, self: false, device: 'laptop' });
    const ask = vi.fn().mockImplementation((_device: string, phase: string) =>
      Promise.resolve(phase === 'claim-denied')); // Try again yes, confirm no
    expect(await claimRun(ask)).toBe(false);
    expect(leaseRelease).toHaveBeenCalled(); // onAbandon on the takeover decline
  });

  it('Try again after a denial re-claims once; then acquired → proceed cleanly', async () => {
    leaseClaim.mockResolvedValueOnce({ outcome: 'denied', device: 'laptop' })
      .mockResolvedValueOnce({ outcome: 'acquired' });
    const ask = vi.fn().mockResolvedValue(true);
    expect(await claimRun(ask)).toBe(true);
    expect(leaseClaim).toHaveBeenCalledTimes(2);
    expect(leaseQuery).not.toHaveBeenCalled();
  });

  it('free-unconfirmed is the escape hatch: falls through to the query gate and proceeds', async () => {
    // Sync down → the socket answers null → claim says free-unconfirmed. The
    // Q-1 rider: never block a resume on sync being unreachable.
    leaseClaim.mockResolvedValue({ outcome: 'free-unconfirmed' });
    leaseQuery.mockResolvedValue({ held: false });
    expect(await claimRun(vi.fn())).toBe(true);
    expect(leaseQuery).toHaveBeenCalled();
  });

  it('error claim is the same escape hatch', async () => {
    leaseClaim.mockResolvedValue({ outcome: 'error' });
    leaseQuery.mockResolvedValue({ held: false });
    expect(await claimRun(vi.fn())).toBe(true);
  });

  it('a THROWN claim degrades to the old path (never-block)', async () => {
    leaseClaim.mockRejectedValue(new Error('bridge gone'));
    leaseQuery.mockResolvedValue({ held: false });
    expect(await claimRun(vi.fn())).toBe(true);
  });

  it('no claim member at all → the old path unchanged', async () => {
    leaseQuery.mockResolvedValue({ held: false });
    expect(await run(vi.fn())).toBe(true);
    expect(leaseClaim).not.toHaveBeenCalled();
  });

  it('a declined takeover (old path) releases the claim this run took', async () => {
    // The claim fell through to the takeover gate (free-unconfirmed), the user
    // saw a holder and declined the takeover: the claim DID take a hold (the
    // lease client held optimistically), so Leave-it must release it.
    leaseClaim.mockResolvedValue({ outcome: 'free-unconfirmed' });
    leaseQuery.mockResolvedValue({ held: true, self: false, device: 'laptop' });
    const ask = vi.fn().mockResolvedValue(false);
    expect(await claimRun(ask)).toBe(false);
    expect(leaseRelease).toHaveBeenCalled();
  });
});
