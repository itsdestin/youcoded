import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runLeaseTakeoverGate } from '../src/renderer/state/resume-lease-gate';
import type { SessionInfo } from '../src/shared/types';

const leaseQuery = vi.fn();
const leaseTakeover = vi.fn();
const leaseForce = vi.fn();
const open = vi.fn();
const session = { id: 'live-session' } as SessionInfo;
const denied = { status: 'lease-denied', device: 'laptop' };

beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as any).window = { claude: { syncSpaces: { leaseQuery, leaseTakeover, leaseForce } } };
  leaseQuery.mockResolvedValue({ held: false });
  open.mockResolvedValue(session);
});

const run = (askTakeover = vi.fn(), onWarn = vi.fn()) =>
  runLeaseTakeoverGate({ claudeSessionId: 'sid', askTakeover, onWarn, open });

describe('runLeaseTakeoverGate', () => {
  it('opens through the backend after the free check', async () => {
    expect(await run()).toBe(session);
    expect(open).toHaveBeenCalledOnce();
    expect(leaseQuery.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]);
  });

  it('opens without asking when this install holds the conversation', async () => {
    leaseQuery.mockResolvedValue({ held: true, self: true, device: 'this-machine' });
    const ask = vi.fn();
    expect(await run(ask)).toBe(session);
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks to take over a known holder directly, not to retry an imaginary race', async () => {
    leaseQuery.mockResolvedValue({ held: true, self: false, device: 'laptop' });
    leaseTakeover.mockResolvedValue({ outcome: 'ready' });
    const ask = vi.fn().mockResolvedValue(true);
    expect(await run(ask)).toBe(session);
    expect(ask.mock.calls).toEqual([['laptop', 'confirm']]);
    expect(leaseTakeover.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]);
  });

  it('never falls through to ordinary create when pending handoff routing fails', async () => {
    leaseQuery.mockResolvedValue({ held: true, self: false, device: 'laptop' });
    const onHandoff = vi.fn().mockRejectedValue(new Error('main window unavailable'));
    await expect(runLeaseTakeoverGate({ claudeSessionId: 'sid', askTakeover: vi.fn().mockResolvedValue(true),
      onHandoff, onWarn: vi.fn(), open })).rejects.toThrow('main window unavailable');
    expect(onHandoff).toHaveBeenCalledWith('laptop');
    expect(open).not.toHaveBeenCalled();
  });

  it('creates nothing when the user declines the handoff', async () => {
    leaseQuery.mockResolvedValue({ held: true, self: false, device: 'laptop' });
    expect(await run(vi.fn().mockResolvedValue(false))).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(leaseTakeover).not.toHaveBeenCalled();
  });

  it.each(['undeliverable', 'timeout'])('uses the honest confirmation for %s', async (outcome) => {
    leaseQuery.mockResolvedValue({ held: true, self: false, device: 'laptop' });
    leaseTakeover.mockResolvedValue({ outcome });
    leaseForce.mockResolvedValue({ ok: true });
    const ask = vi.fn().mockResolvedValue(true);
    expect(await run(ask)).toBe(session);
    expect(ask).toHaveBeenNthCalledWith(2, 'laptop', outcome === 'timeout' ? 'force' : 'undeliverable');
    expect(open).toHaveBeenCalledOnce();
  });

  it('creates nothing when force is declined', async () => {
    leaseQuery.mockResolvedValue({ held: true, self: false, device: 'laptop' });
    leaseTakeover.mockResolvedValue({ outcome: 'timeout' });
    expect(await run(vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false))).toBeNull();
    expect(leaseForce).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps the outage escape hatch without inventing ownership', async () => {
    leaseQuery.mockRejectedValue(new Error('hub down'));
    const warn = vi.fn();
    expect(await run(vi.fn(), warn)).toBe(session);
    expect(open).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it('works on a bridge without lease support', async () => {
    (globalThis as any).window = { claude: {} };
    expect(await run()).toBe(session);
  });

  it('surfaces startup failures instead of swallowing them as lease failures', async () => {
    open.mockRejectedValue(new Error('startup failed'));
    await expect(run()).rejects.toThrow('startup failed');
    expect(open).toHaveBeenCalledOnce();
  });

  it('treats a missing create response as failure, not user cancellation', async () => {
    open.mockResolvedValue(undefined);
    await expect(run()).rejects.toThrow('No session');
  });

  it('returns no session when a raced claim is declined', async () => {
    open.mockResolvedValue(denied);
    const ask = vi.fn().mockResolvedValue(false);
    expect(await run(ask)).toBeNull();
    expect(ask.mock.calls).toEqual([['laptop', 'claim-denied']]);
    expect(open).toHaveBeenCalledOnce();
  });

  it('offers normal handoff only after a second denial, with the latest holder', async () => {
    open.mockResolvedValueOnce(denied)
      .mockResolvedValueOnce({ status: 'lease-denied', device: 'phone' })
      .mockResolvedValueOnce(session);
    leaseTakeover.mockResolvedValue({ outcome: 'ready' });
    const ask = vi.fn().mockResolvedValue(true);
    expect(await run(ask)).toBe(session);
    expect(ask.mock.calls).toEqual([['laptop', 'claim-denied'], ['phone', 'confirm']]);
    expect(leaseTakeover).toHaveBeenCalledOnce();
    expect(leaseTakeover.mock.invocationCallOrder[0]).toBeGreaterThan(ask.mock.invocationCallOrder[1]);
    expect(open).toHaveBeenCalledTimes(3);
    expect(leaseForce).not.toHaveBeenCalled();
  });

  it('stops before takeover if handoff after retry is declined', async () => {
    open.mockResolvedValueOnce(denied).mockResolvedValueOnce({ status: 'lease-denied', device: 'phone' });
    const ask = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await run(ask)).toBeNull();
    expect(ask.mock.calls).toEqual([['laptop', 'claim-denied'], ['phone', 'confirm']]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(leaseTakeover).not.toHaveBeenCalled();
    expect(leaseForce).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'undeliverable'])('requires separate force consent after retry handoff %s', async (outcome) => {
    open.mockResolvedValueOnce(denied).mockResolvedValueOnce({ status: 'lease-denied', device: 'phone' });
    leaseTakeover.mockResolvedValue({ outcome });
    const ask = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await run(ask)).toBeNull();
    expect(ask.mock.calls).toEqual([
      ['laptop', 'claim-denied'], ['phone', 'confirm'],
      ['phone', outcome === 'timeout' ? 'force' : 'undeliverable'],
    ]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(leaseForce).not.toHaveBeenCalled();
  });

  it('only forces after explicit separate consent following retry handoff', async () => {
    open.mockResolvedValueOnce(denied).mockResolvedValueOnce({ status: 'lease-denied', device: 'phone' })
      .mockResolvedValueOnce(session);
    leaseTakeover.mockResolvedValue({ outcome: 'timeout' });
    leaseForce.mockResolvedValue({ ok: true });
    const ask = vi.fn().mockResolvedValue(true);
    expect(await run(ask)).toBe(session);
    expect(ask.mock.calls).toEqual([
      ['laptop', 'claim-denied'], ['phone', 'confirm'], ['phone', 'force'],
    ]);
    expect(leaseForce).toHaveBeenCalledOnce();
    expect(ask.mock.invocationCallOrder[2]).toBeLessThan(leaseForce.mock.invocationCallOrder[0]);
    expect(leaseForce.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[2]);
  });

  it('does not bypass admission if backend denies again after retry handoff', async () => {
    open.mockResolvedValue(denied);
    leaseTakeover.mockResolvedValue({ outcome: 'ready' });
    const ask = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await run(ask)).toBeNull();
    expect(ask.mock.calls).toEqual([
      ['laptop', 'claim-denied'], ['laptop', 'confirm'], ['laptop', 'claim-denied'],
    ]);
    expect(open).toHaveBeenCalledTimes(3);
    expect(leaseTakeover).toHaveBeenCalledOnce();
    expect(leaseForce).not.toHaveBeenCalled();
  });

  it('surfaces startup failure on the retry instead of treating it as a claim denial', async () => {
    open.mockResolvedValueOnce(denied).mockRejectedValueOnce(new Error('retry startup failed'));
    await expect(run(vi.fn().mockResolvedValue(true))).rejects.toThrow('retry startup failed');
    expect(leaseTakeover).not.toHaveBeenCalled();
  });

  it('keeps the outage escape hatch when the lease query fails before a denied open', async () => {
    leaseQuery.mockRejectedValue(new Error('hub down'));
    open.mockResolvedValueOnce(denied).mockResolvedValueOnce(session);
    const ask = vi.fn().mockResolvedValue(true);
    expect(await run(ask)).toBe(session);
    expect(ask.mock.calls).toEqual([['laptop', 'claim-denied']]);
    expect(leaseTakeover).not.toHaveBeenCalled();
  });

  it('returns the successfully opened session after retry', async () => {
    open.mockResolvedValueOnce(denied).mockResolvedValueOnce(session);
    expect(await run(vi.fn().mockResolvedValue(true))).toBe(session);
    expect(open).toHaveBeenCalledTimes(2);
    expect(leaseQuery).toHaveBeenCalledOnce();
  });

  it('still respects a denial after an apparently successful handoff', async () => {
    leaseQuery.mockResolvedValue({ held: true, self: false, device: 'laptop' });
    leaseTakeover.mockResolvedValue({ outcome: 'ready' });
    open.mockResolvedValue(denied);
    const ask = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await run(ask)).toBeNull();
    expect(ask.mock.calls).toEqual([['laptop', 'confirm'], ['laptop', 'claim-denied']]);
  });

  it('warns about a failed force but does not bypass backend admission', async () => {
    leaseQuery.mockResolvedValue({ held: true, self: false, device: 'laptop' });
    leaseTakeover.mockResolvedValue({ outcome: 'timeout' });
    leaseForce.mockResolvedValue({ ok: false });
    open.mockResolvedValue(denied);
    const warn = vi.fn();
    expect(await run(vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false), warn)).toBeNull();
    expect(warn).toHaveBeenCalledWith("Couldn't confirm the handoff from laptop.");
  });
});
