import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runLeaseTakeoverGate } from '../src/renderer/state/resume-lease-gate';

// The gate's three invisible rules. Two resume surfaces run this now (App's
// Resume Browser path and the buddy floater's list), so a change here that only
// one of them notices is exactly what this pins.

const leaseQuery = vi.fn();
const leaseTakeover = vi.fn();
const leaseForce = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).window = {
    claude: { syncSpaces: { leaseQuery, leaseTakeover, leaseForce } },
  };
});

const run = (askTakeover: any, onWarn = vi.fn()) =>
  runLeaseTakeoverGate({ claudeSessionId: 'sid', askTakeover, onWarn });

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
