// Unit tests for the lease-client (Plan 2b, Task 6). No network, no real hub —
// hubRequest is injected as a vi.fn() whose responses each test scripts. Renew
// timers are driven by vitest fake timers; the lease-file fallback is asserted
// against a REAL temp dir (readFileSync/existsSync), not mocks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// WHY default import (not `import * as fs`): a namespace import produces a
// frozen ES module namespace object whose properties vi.spyOn cannot redefine
// ("Cannot redefine property: writeFileSync") — needed below to prove the
// hung-write guard never touches the SYNC fs surface.
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLeaseClient, type LeaseClient } from '../src/main/conversations/lease-client';
import type { LeaseResult } from '../src/main/sync-hub-socket';

const DEVICE_ID = 'dev-A';
const DEVICE_NAME = 'laptop-A';
const RENEW_MS = 30_000;

function okResult(op: string, sessionId: string, expiresAt: number): LeaseResult {
  return { ok: true, op, sessionId, holder: { deviceId: DEVICE_ID, device: DEVICE_NAME, expiresAt } };
}
function lostResult(op: string, sessionId: string): LeaseResult {
  // Force-acquired by another device: ok=false, holder is now someone else.
  return { ok: false, op, sessionId, holder: { deviceId: 'dev-B', device: 'phone-B', expiresAt: Date.now() + 300_000 } };
}

function leaseFilePath(root: string, sessionId: string): string {
  return path.join(root, 'Leases', `${sessionId}.json`);
}

describe('lease-client', () => {
  let tmpRoot: string;
  let hubRequest: ReturnType<typeof vi.fn>;
  let takeoverSpy: ReturnType<typeof vi.fn>;
  let client: LeaseClient;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-test-'));
    hubRequest = vi.fn();
    takeoverSpy = vi.fn();
    client = createLeaseClient({
      deviceId: DEVICE_ID,
      deviceName: DEVICE_NAME,
      // leaseDir is the DIRECTORY holding lease files, and in production it
      // resolves under userData — NOT under the personal sync space. Leases are a
      // 30s heartbeat; writing them into a synced folder made every renew a git
      // commit (2026-07-30 churn fix). The tests keep the same on-disk shape so
      // the existing fallback assertions still describe real layout.
      leaseDir: () => path.join(tmpRoot, 'Leases'),
      hubRequest: hubRequest as any,
      onTakeoverRequest: takeoverSpy as any,
    });
  });

  afterEach(() => {
    client.destroy();
    vi.useRealTimers();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('acquire starts a renew timer and writes the lease file', async () => {
    const expiresAt = Date.now() + 300_000;
    hubRequest.mockResolvedValue(okResult('acquire', 's1', expiresAt));

    await client.acquire('s1');

    expect(client.isHeld('s1')).toBe(true);
    // Lease file written on acquire.
    const file = leaseFilePath(tmpRoot, 's1');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.deviceId).toBe(DEVICE_ID);
    expect(parsed.device).toBe(DEVICE_NAME);
    expect(parsed.expiresAt).toBe(expiresAt);

    // Renew timer fires at 30s.
    hubRequest.mockClear();
    hubRequest.mockResolvedValue(okResult('renew', 's1', Date.now() + 300_000));
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    expect(hubRequest).toHaveBeenCalledWith('renew', 's1', DEVICE_ID);
  });

  it('release stops the timer, deletes the file, and calls the hub', async () => {
    hubRequest.mockResolvedValue(okResult('acquire', 's1', Date.now() + 300_000));
    await client.acquire('s1');
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(true);

    hubRequest.mockClear();
    hubRequest.mockResolvedValue(okResult('release', 's1', 0));
    await client.release('s1');

    expect(client.isHeld('s1')).toBe(false);
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(false);
    expect(hubRequest).toHaveBeenCalledWith('release', 's1', DEVICE_ID);

    // No further renew after release.
    hubRequest.mockClear();
    await vi.advanceTimersByTimeAsync(RENEW_MS * 2);
    expect(hubRequest).not.toHaveBeenCalledWith('renew', 's1', DEVICE_ID);
  });

  it('query prefers the hub result (holder is another device -> self:false)', async () => {
    hubRequest.mockResolvedValue({ ok: true, op: 'get', sessionId: 's1', holder: { deviceId: 'dev-B', device: 'phone-B', expiresAt: Date.now() + 100 } });
    const r = await client.query('s1');
    // deviceId carried through; self false because holder deviceId !== our DEVICE_ID.
    expect(r).toEqual({ held: true, device: 'phone-B', deviceId: 'dev-B', self: false, expiresAt: expect.any(Number), source: 'hub' });
  });

  it('query hub result with OUR deviceId reports self:true (label is irrelevant)', async () => {
    // Same-label collision guard: even if the holder label differs, self keys on
    // the per-install deviceId. Here deviceId === DEVICE_ID -> self:true.
    hubRequest.mockResolvedValue({ ok: true, op: 'get', sessionId: 's1', holder: { deviceId: DEVICE_ID, device: 'some-other-label', expiresAt: Date.now() + 100 } });
    const r = await client.query('s1');
    expect(r).toEqual({ held: true, device: 'some-other-label', deviceId: DEVICE_ID, self: true, expiresAt: expect.any(Number), source: 'hub' });
  });

  it('query hub free reports self:false', async () => {
    hubRequest.mockResolvedValue({ ok: true, op: 'get', sessionId: 's1', holder: null });
    const r = await client.query('s1');
    expect(r).toEqual({ held: false, self: false, source: 'hub' });
  });

  it('query falls back to an unexpired lease file when the hub returns null (self:false for another device)', async () => {
    hubRequest.mockResolvedValue(null);
    const dir = path.join(tmpRoot, 'Leases');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(leaseFilePath(tmpRoot, 's1'), JSON.stringify({ deviceId: 'dev-B', device: 'phone-B', expiresAt: Date.now() + 100_000 }));

    const r = await client.query('s1');
    expect(r).toEqual({ held: true, device: 'phone-B', deviceId: 'dev-B', self: false, expiresAt: expect.any(Number), source: 'file' });
  });

  it('query file fallback with OUR deviceId reports self:true', async () => {
    hubRequest.mockResolvedValue(null);
    const dir = path.join(tmpRoot, 'Leases');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(leaseFilePath(tmpRoot, 's1'), JSON.stringify({ deviceId: DEVICE_ID, device: DEVICE_NAME, expiresAt: Date.now() + 100_000 }));

    const r = await client.query('s1');
    expect(r).toEqual({ held: true, device: DEVICE_NAME, deviceId: DEVICE_ID, self: true, expiresAt: expect.any(Number), source: 'file' });
  });

  it('query treats an expired lease file as free', async () => {
    hubRequest.mockResolvedValue(null);
    const dir = path.join(tmpRoot, 'Leases');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(leaseFilePath(tmpRoot, 's1'), JSON.stringify({ deviceId: 'dev-B', device: 'phone-B', expiresAt: Date.now() - 1000 }));

    const r = await client.query('s1');
    expect(r).toEqual({ held: false, self: false, source: 'none' });
  });

  it('query with hub null and no file reports free', async () => {
    hubRequest.mockResolvedValue(null);
    const r = await client.query('s1');
    expect(r).toEqual({ held: false, self: false, source: 'none' });
  });

  it('handleTakeoverRequest invokes the callback only for a HELD session', async () => {
    hubRequest.mockResolvedValue(okResult('acquire', 's1', Date.now() + 300_000));
    await client.acquire('s1');

    const from = { deviceId: 'dev-B', device: 'phone-B' };
    client.handleTakeoverRequest('s1', from);
    expect(takeoverSpy).toHaveBeenCalledWith('s1', from);

    // Unheld session — ignored.
    takeoverSpy.mockClear();
    client.handleTakeoverRequest('s-unheld', from);
    expect(takeoverSpy).not.toHaveBeenCalled();
  });

  it('handleTakeoverRequest is the victim-only guard for BOTH takeover-request AND taken', async () => {
    // main.ts routes BOTH 'takeover-request' and 'taken' (force-acquire) lease events
    // into handleTakeoverRequest. The 'taken' frame carries NO deviceId to compare, so
    // the held.has() guard is what separates VICTIM from ATTACKER: the device that
    // forced the steal does NOT hold the session (no-op), the device that holds it is
    // the victim (tears down). Pin that contract here — if the guard ever keyed on a
    // payload field instead of held.has(), a force would tear down the wrong device.
    hubRequest.mockResolvedValue(okResult('acquire', 's-held', Date.now() + 300_000));
    await client.acquire('s-held'); // WE hold it -> we are the victim

    // A 'taken' event arrives with NO `from` (the DO's taken frame has no deviceId).
    client.handleTakeoverRequest('s-held', undefined);
    expect(takeoverSpy).toHaveBeenCalledWith('s-held', undefined);

    // The attacker's perspective: it does NOT hold the session, so the same event
    // no-ops (it must NOT tear down the session it just stole).
    takeoverSpy.mockClear();
    client.handleTakeoverRequest('s-not-ours', undefined);
    expect(takeoverSpy).not.toHaveBeenCalled();
  });

  it('renew failure (force-acquired) stops the timer, deletes the file, and attributes the takeover', async () => {
    hubRequest.mockResolvedValue(okResult('acquire', 's1', Date.now() + 300_000));
    await client.acquire('s1');
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(true);

    // WHY spy-and-await, not a vi.waitFor poll: the renew tick's
    // deleteLeaseFile is fire-and-forget (`void deleteLeaseFile(...)`),
    // queued through the per-session fs.promises chain — the file removal is
    // off the event loop. Polling fs.existsSync on the 1s vi.waitFor budget
    // flaked once under a full-suite run (2026-09-10: `expected true to be
    // false` at the poll's clock deadline). Awaiting the delete's OWN promise
    // instead makes the assertion fire exactly when the queued delete has
    // settled, however slow the disk is — a deterministic signal, not a clock.
    const rmSpy = vi.spyOn(fs.promises, 'rm');

    // Next renew fails — another device force-acquired (holder is now dev-B).
    hubRequest.mockClear();
    hubRequest.mockResolvedValue(lostResult('renew', 's1'));
    await vi.advanceTimersByTimeAsync(RENEW_MS);

    expect(client.isHeld('s1')).toBe(false);
    expect(rmSpy).toHaveBeenCalledWith(leaseFilePath(tmpRoot, 's1'), { force: true });
    await rmSpy.mock.results[0].value;
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(false);
    rmSpy.mockRestore();
    // The renew reply carries the new holder — the takeover is attributed so
    // the MovedGate can name the device instead of "another device".
    expect(takeoverSpy).toHaveBeenCalledWith('s1', { deviceId: 'dev-B', device: 'phone-B' });

    // Timer is stopped — no further renew.
    hubRequest.mockClear();
    await vi.advanceTimersByTimeAsync(RENEW_MS * 2);
    expect(hubRequest).not.toHaveBeenCalledWith('renew', 's1', DEVICE_ID);
  });

  // Regression (2026-07-16): a renew that fails because the lease lazily
  // EXPIRED (heartbeat suspended by system sleep / screen lock / OS throttling
  // past the 300s TTL) carries holder:null — nobody took the session. That is
  // a lapse, not a takeover, and must NOT fire the "taken over on another
  // device" teardown. The client re-acquires in place instead.
  it('renew ok:false with NO holder (lapsed lease) re-acquires instead of tearing down', async () => {
    hubRequest.mockResolvedValue(okResult('acquire', 's1', Date.now() + 300_000));
    await client.acquire('s1');

    hubRequest.mockClear();
    hubRequest.mockImplementation(async (op: string) =>
      op === 'renew'
        ? { ok: false, op: 'renew', sessionId: 's1', holder: null }
        : okResult('acquire', 's1', Date.now() + 300_000),
    );
    await vi.advanceTimersByTimeAsync(RENEW_MS);

    expect(hubRequest).toHaveBeenCalledWith('acquire', 's1', DEVICE_ID);
    expect(client.isHeld('s1')).toBe(true);
    expect(takeoverSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(true);

    // The heartbeat loop survived — the next tick renews again.
    hubRequest.mockClear();
    hubRequest.mockResolvedValue(okResult('renew', 's1', Date.now() + 300_000));
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    expect(hubRequest).toHaveBeenCalledWith('renew', 's1', DEVICE_ID);
    expect(client.isHeld('s1')).toBe(true);
  });

  it('lapsed renew whose re-acquire is rejected tears down with the new holder attributed', async () => {
    hubRequest.mockResolvedValue(okResult('acquire', 's1', Date.now() + 300_000));
    await client.acquire('s1');

    // WHY spy-and-await, not a vi.waitFor poll: same fire-and-forget delete
    // as the renew-failure teardown test above — see its WHY for the
    // 2026-09-10 flake this replaces.
    const rmSpy = vi.spyOn(fs.promises, 'rm');

    // Renew reports the lease lapsed (no holder); the re-acquire then loses a
    // race — dev-B claimed it between the expiry and our re-acquire.
    hubRequest.mockClear();
    hubRequest.mockImplementation(async (op: string) =>
      op === 'renew'
        ? { ok: false, op: 'renew', sessionId: 's1', holder: null }
        : lostResult('acquire', 's1'),
    );
    await vi.advanceTimersByTimeAsync(RENEW_MS);

    expect(client.isHeld('s1')).toBe(false);
    expect(rmSpy).toHaveBeenCalledWith(leaseFilePath(tmpRoot, 's1'), { force: true });
    await rmSpy.mock.results[0].value;
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(false);
    rmSpy.mockRestore();
    expect(takeoverSpy).toHaveBeenCalledWith('s1', { deviceId: 'dev-B', device: 'phone-B' });
  });

  it('lapsed renew with the hub down during re-acquire keeps the lease optimistically', async () => {
    hubRequest.mockResolvedValue(okResult('acquire', 's1', Date.now() + 300_000));
    await client.acquire('s1');

    hubRequest.mockClear();
    hubRequest.mockImplementation(async (op: string) =>
      op === 'renew' ? { ok: false, op: 'renew', sessionId: 's1', holder: null } : null,
    );
    await vi.advanceTimersByTimeAsync(RENEW_MS);

    // Never-block: hub loss mid-recovery must not drop the lease.
    expect(client.isHeld('s1')).toBe(true);
    expect(takeoverSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(true);
  });

  it('transient-null renew keeps the lease and keeps renewing', async () => {
    hubRequest.mockResolvedValue(okResult('acquire', 's1', Date.now() + 300_000));
    await client.acquire('s1');

    // Next renew: hub transiently disconnected (null). Lease must NOT drop.
    hubRequest.mockClear();
    hubRequest.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(RENEW_MS);

    expect(hubRequest).toHaveBeenCalledWith('renew', 's1', DEVICE_ID);
    expect(client.isHeld('s1')).toBe(true);
    // File fallback still present and fresh (local-clock deadline in the future).
    const file = leaseFilePath(tmpRoot, 's1');
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).expiresAt).toBeGreaterThan(Date.now());

    // A SECOND renew is attempted on the next tick — the timer kept running.
    hubRequest.mockClear();
    hubRequest.mockResolvedValue(okResult('renew', 's1', Date.now() + 300_000));
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    expect(hubRequest).toHaveBeenCalledWith('renew', 's1', DEVICE_ID);
    expect(client.isHeld('s1')).toBe(true);
  });

  it('query treats a malformed lease file as free', async () => {
    hubRequest.mockResolvedValue(null);
    const dir = path.join(tmpRoot, 'Leases');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(leaseFilePath(tmpRoot, 's1'), '{ not json');

    const r = await client.query('s1');
    expect(r).toEqual({ held: false, self: false, source: 'none' });
  });

  it('destroy clears all renew timers', async () => {
    hubRequest.mockResolvedValue(okResult('acquire', 's1', Date.now() + 300_000));
    await client.acquire('s1');
    hubRequest.mockResolvedValue(okResult('acquire', 's2', Date.now() + 300_000));
    await client.acquire('s2');

    client.destroy();
    expect(client.isHeld('s1')).toBe(false);
    expect(client.isHeld('s2')).toBe(false);

    hubRequest.mockClear();
    await vi.advanceTimersByTimeAsync(RENEW_MS * 2);
    expect(hubRequest).not.toHaveBeenCalledWith('renew', 's1', DEVICE_ID);
    expect(hubRequest).not.toHaveBeenCalledWith('renew', 's2', DEVICE_ID);
  });

  it('acquire on a hub reject (someone else holds it) does not start a timer or write a file', async () => {
    hubRequest.mockResolvedValue(lostResult('acquire', 's1'));
    const res = await client.acquire('s1');

    expect(res && res.ok).toBe(false);
    expect(client.isHeld('s1')).toBe(false);
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(false);

    hubRequest.mockClear();
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    expect(hubRequest).not.toHaveBeenCalledWith('renew', 's1', DEVICE_ID);
  });

  it('acquire on hub-disconnected (null) optimistically holds locally', async () => {
    hubRequest.mockResolvedValue(null);
    const res = await client.acquire('s1');

    expect(res && res.ok).toBe(true);
    expect(client.isHeld('s1')).toBe(true);
    // File written with a locally-synthesized expiry.
    const file = leaseFilePath(tmpRoot, 's1');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.deviceId).toBe(DEVICE_ID);
    expect(typeof parsed.expiresAt).toBe('number');
  });

  it('acquire then release in the same tick leaves no lease file (write/delete stay ordered)', async () => {
    hubRequest.mockResolvedValue({ ok: true, op: 'acquire', sessionId: 's1', holder: { deviceId: DEVICE_ID, device: DEVICE_NAME, expiresAt: Date.now() + 100_000 } });
    const p1 = client.acquire('s1');
    const p2 = client.release('s1');
    await Promise.all([p1, p2]);
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(false);
  });

  it('a hung lease-file write does not hang the event loop', async () => {
    // WHY: this is the 2026-09-08 freeze shape — a disk stall inside the lease
    // write. The write must be off the event loop, so a real timer still fires
    // while the write is pending. Controller decision (task-1-brief deviation):
    // also assert the SYNC fs writers were never called and that fs.promises
    // writeFile WAS called, so a fast writeFileSync can't make this pass by
    // accident.
    vi.useRealTimers(); // afterEach re-enables fake timers for the next case
    hubRequest.mockResolvedValue({ ok: true, op: 'acquire', sessionId: 's1', holder: { deviceId: DEVICE_ID, device: DEVICE_NAME, expiresAt: Date.now() + 100_000 } });
    const never = new Promise<void>(() => {});
    const writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockReturnValue(never as any);
    const syncWriteSpy = vi.spyOn(fs, 'writeFileSync');
    const syncMkdirSpy = vi.spyOn(fs, 'mkdirSync');
    try {
      void client.acquire('s1');
      const ticked = await new Promise<boolean>((r) => setTimeout(() => r(true), 20));
      expect(ticked).toBe(true);
      expect(syncWriteSpy).not.toHaveBeenCalled();
      expect(syncMkdirSpy).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(writeFileSpy).toHaveBeenCalled());
    } finally { writeFileSpy.mockRestore(); syncWriteSpy.mockRestore(); syncMkdirSpy.mockRestore(); }
  });
});
