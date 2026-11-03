// lease-client: no network or hub (hubRequest is an injected vi.fn() each test scripts); renew timers use fake timers; the lease-file fallback is asserted against a REAL temp dir.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// WHY default import: a namespace import is frozen, so vi.spyOn cannot redefine writeFileSync (needed to prove the hung-write guard never touches the SYNC fs surface).
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

const ACQUIRED = () => okResult('acquire', 's1', Date.now() + 300_000);

describe('lease-client', () => {
  let tmpRoot: string;
  let hubRequest: ReturnType<typeof vi.fn>;
  let takeoverSpy: ReturnType<typeof vi.fn>;
  let client: LeaseClient;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-test-'));
    // WHY a per-client copy: `tmpRoot` is reassigned by the NEXT test's beforeEach and leaseDir() is read when a queued file op runs, so a leftover write used to land in the next test's folder.
    const clientRoot = tmpRoot;
    hubRequest = vi.fn();
    takeoverSpy = vi.fn();
    client = createLeaseClient({
      deviceId: DEVICE_ID,
      deviceName: DEVICE_NAME,
      // Production resolves this under userData, NOT the synced space (a 30s heartbeat there made every renew a git commit); same on-disk shape here.
      leaseDir: () => path.join(clientRoot, 'Leases'),
      hubRequest: hubRequest as any,
      onTakeoverRequest: takeoverSpy as any,
    });
  });

  /** Acquire s1 against an ok hub, so the lease is held with a renew timer running. */
  const holdS1 = async () => { hubRequest.mockResolvedValue(ACQUIRED()); await client.acquire('s1'); };
  /** Plant a lease file for s1 (the hub-unreachable fallback). */
  const plantLeaseFile = (contents: object | string) => {
    fs.mkdirSync(path.join(tmpRoot, 'Leases'), { recursive: true });
    fs.writeFileSync(leaseFilePath(tmpRoot, 's1'), typeof contents === 'string' ? contents : JSON.stringify(contents));
  };
  /** Advance two renew periods and assert no renew was sent (the timer is gone). */
  const expectNoMoreRenews = async (sid = 's1') => {
    hubRequest.mockClear();
    await vi.advanceTimersByTimeAsync(RENEW_MS * 2);
    expect(hubRequest).not.toHaveBeenCalledWith('renew', sid, DEVICE_ID);
  };
  /** One renew period later a renew was sent, and the lease is still held (the heartbeat survived). */
  const expectRenewAndHeld = async () => {
    hubRequest.mockClear();
    hubRequest.mockResolvedValue(okResult('renew', 's1', Date.now() + 300_000));
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    expect(hubRequest).toHaveBeenCalledWith('renew', 's1', DEVICE_ID);
    expect(client.isHeld('s1')).toBe(true);
  };

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

  // WHY: open a conversation and close it within a second; the release lands while acquire awaits the hub, and the reply must NOT bring the session back held with a live heartbeat.
  it('a release that lands while acquire is still waiting on the hub wins — nothing is held afterwards', async () => {
    let answerAcquire!: (r: LeaseResult) => void;
    hubRequest.mockImplementation((op: string, sid: string) => {
      if (op === 'acquire') return new Promise<LeaseResult>((resolve) => { answerAcquire = resolve; });
      return Promise.resolve(okResult(op, sid, 0));
    });
    const acquiring = client.acquire('s1');
    await Promise.resolve();                 // let acquire reach its hub await
    // release() clears the local hold SYNCHRONOUSLY; its file delete queues behind acquire's slot, so it finishes only once the hub has answered, as in the app.
    const releasing = client.release('s1');
    answerAcquire(okResult('acquire', 's1', Date.now() + 300_000));
    expect((await acquiring)?.ok).toBe(false);
    await releasing;

    expect(client.isHeld('s1')).toBe(false);
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(false);
    // The hub may have granted after the release, so it is told again (best-effort).
    expect(hubRequest.mock.calls.filter(([op]) => op === 'release')).toHaveLength(2);
    await expectNoMoreRenews(); // no heartbeat re-armed for a gone session
  });

  it('forwards takeover during acquisition so admission can cancel a late grant', async () => {
    let answer!: (r: LeaseResult) => void;
    hubRequest.mockImplementation((op: string, sid: string) => op === 'acquire'
      ? new Promise<LeaseResult>((resolve) => { answer = resolve; })
      : Promise.resolve(okResult(op, sid, 0)));
    let released: Promise<void> | undefined;
    takeoverSpy.mockImplementation(() => { released = client.release('s1'); });
    const acquiring = client.acquire('s1');
    client.handleTakeoverRequest('s1', { deviceId: 'peer', device: 'laptop' });
    expect(takeoverSpy).toHaveBeenCalledWith('s1', { deviceId: 'peer', device: 'laptop' });
    answer(okResult('acquire', 's1', Date.now() + 300_000));
    expect((await acquiring)?.ok).toBe(false);
    await released;
    expect(client.isHeld('s1')).toBe(false);
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(false);
  });

  it('release stops the timer, deletes the file, and calls the hub', async () => {
    await holdS1();
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(true);

    hubRequest.mockClear();
    hubRequest.mockResolvedValue(okResult('release', 's1', 0));
    await client.release('s1');

    expect(client.isHeld('s1')).toBe(false);
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(false);
    expect(hubRequest).toHaveBeenCalledWith('release', 's1', DEVICE_ID);

    await expectNoMoreRenews();
  });

  it('query prefers the hub result (holder is another device -> self:false)', async () => {
    hubRequest.mockResolvedValue({ ok: true, op: 'get', sessionId: 's1', holder: { deviceId: 'dev-B', device: 'phone-B', expiresAt: Date.now() + 100 } });
    const r = await client.query('s1');
    // deviceId carried through; self false because holder deviceId !== our DEVICE_ID.
    expect(r).toEqual({ held: true, device: 'phone-B', deviceId: 'dev-B', self: false, expiresAt: expect.any(Number), source: 'hub' });
  });

  it('query hub result with OUR deviceId reports self:true (label is irrelevant)', async () => {
    // Same-label collision guard: self keys on the per-install deviceId, not the label.
    hubRequest.mockResolvedValue({ ok: true, op: 'get', sessionId: 's1', holder: { deviceId: DEVICE_ID, device: 'some-other-label', expiresAt: Date.now() + 100 } });
    const r = await client.query('s1');
    expect(r).toEqual({ held: true, device: 'some-other-label', deviceId: DEVICE_ID, self: true, expiresAt: expect.any(Number), source: 'hub' });
  });

  it('query hub free reports self:false', async () => {
    hubRequest.mockResolvedValue({ ok: true, op: 'get', sessionId: 's1', holder: null });
    const r = await client.query('s1');
    expect(r).toEqual({ held: false, self: false, source: 'hub' });
  });

  it.each([
    ['another device', { deviceId: 'dev-B', device: 'phone-B', expiresAt: Date.now() + 100_000 }, { held: true, device: 'phone-B', deviceId: 'dev-B', self: false, expiresAt: expect.any(Number), source: 'file' }],
    ['OUR deviceId', { deviceId: DEVICE_ID, device: DEVICE_NAME, expiresAt: Date.now() + 100_000 }, { held: true, device: DEVICE_NAME, deviceId: DEVICE_ID, self: true, expiresAt: expect.any(Number), source: 'file' }],
    ['an expired lease (free)', { deviceId: 'dev-B', device: 'phone-B', expiresAt: Date.now() - 1000 }, { held: false, self: false, source: 'none' }],
    ['a malformed file (free)', '{ not json', { held: false, self: false, source: 'none' }],
  ])('query falls back to the lease file when the hub returns null: %s', async (_n, file, expected) => {
    hubRequest.mockResolvedValue(null);
    plantLeaseFile(file as any);
    expect(await client.query('s1')).toEqual(expected);
  });

  it('query with hub null and no file reports free', async () => {
    hubRequest.mockResolvedValue(null);
    expect(await client.query('s1')).toEqual({ held: false, self: false, source: 'none' });
  });

  it('preserves a caller nonce and ignores a nonce for a different holder', async () => {
    const nonce = '3db07e20-1244-4a1b-85bf-bde2db925e41';
    await holdS1();
    await client.takeover('s2', nonce);
    expect(hubRequest).toHaveBeenCalledWith('takeover', 's2', DEVICE_ID, nonce);
    const from = { deviceId: 'dev-B', device: 'same-machine' };
    client.handleTakeoverRequest('s1', from, nonce, 'not-this-install');
    expect(takeoverSpy).not.toHaveBeenCalled();
    client.handleTakeoverRequest('s1', from, nonce, DEVICE_ID);
    expect(takeoverSpy).toHaveBeenCalledWith('s1', from, nonce);
  });

  it('handleTakeoverRequest invokes the callback only for a HELD session', async () => {
    await holdS1();

    const from = { deviceId: 'dev-B', device: 'phone-B' };
    client.handleTakeoverRequest('s1', from);
    expect(takeoverSpy).toHaveBeenCalledWith('s1', from);

    // Unheld session — ignored.
    takeoverSpy.mockClear();
    client.handleTakeoverRequest('s-unheld', from);
    expect(takeoverSpy).not.toHaveBeenCalled();
  });

  it('handleTakeoverRequest is the victim-only guard for BOTH takeover-request AND taken', async () => {
    // WHY: main.ts routes BOTH 'takeover-request' and 'taken' into handleTakeoverRequest, and 'taken' carries NO deviceId, so held.has() separates VICTIM (tears down) from ATTACKER (no-op); keying on a payload field would tear down the wrong device.
    hubRequest.mockResolvedValue(okResult('acquire', 's-held', Date.now() + 300_000));
    await client.acquire('s-held'); // WE hold it -> we are the victim

    // A 'taken' event arrives with NO `from` (the DO's taken frame has no deviceId).
    client.handleTakeoverRequest('s-held', undefined);
    expect(takeoverSpy).toHaveBeenCalledWith('s-held', undefined);

    // The attacker does NOT hold the session, so the same event no-ops.
    takeoverSpy.mockClear();
    client.handleTakeoverRequest('s-not-ours', undefined);
    expect(takeoverSpy).not.toHaveBeenCalled();
  });

  it('renew failure (force-acquired) stops the timer, deletes the file, and attributes the takeover', async () => {
    await holdS1();
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(true);

    // WHY spy-and-await, not a poll: the renew tick's deleteLeaseFile is fire-and-forget through a per-session fs.promises chain; polling existsSync flaked under a full-suite run, awaiting the delete's OWN promise is deterministic.
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
    // The renew reply carries the new holder, so the takeover is attributed (the MovedGate names the device).
    expect(takeoverSpy).toHaveBeenCalledWith('s1', { deviceId: 'dev-B', device: 'phone-B' });

    await expectNoMoreRenews();
  });

  // WHY: a renew failing because the lease lazily EXPIRED (sleep / lock / throttling past the 300s TTL) carries holder:null: a lapse, not a takeover, so re-acquire in place instead of the "taken over" teardown.
  it('renew ok:false with NO holder (lapsed lease) re-acquires instead of tearing down', async () => {
    await holdS1();

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

    await expectRenewAndHeld(); // the heartbeat loop survived
  });

  it('lapsed renew whose re-acquire is rejected tears down with the new holder attributed', async () => {
    await holdS1();

    // WHY spy-and-await: same fire-and-forget delete as the renew-failure test above.
    const rmSpy = vi.spyOn(fs.promises, 'rm');

    // Renew reports a lapse (no holder); the re-acquire then loses a race to dev-B.
    hubRequest.mockClear();
    hubRequest.mockImplementation(async (op: string) =>
      op === 'renew'
        ? { ok: false, op: 'renew', sessionId: 's1', holder: null }
        : lostResult('acquire', 's1'),
    );
    await vi.advanceTimersByTimeAsync(RENEW_MS);

    // WHY a wait: renew -> lost re-acquire -> teardown is a chain of awaited mocks and one clock advance does not promise every link ran (isHeld read true once on macOS CI).
    await vi.waitFor(() => {
      expect(client.isHeld('s1')).toBe(false);
      expect(rmSpy).toHaveBeenCalledWith(leaseFilePath(tmpRoot, 's1'), { force: true });
    });
    // The file is gone afterwards (once failed because the PREVIOUS test's client wrote it back; see the per-client root).
    await Promise.all(rmSpy.mock.results.map((r) => r.value));
    expect(fs.existsSync(leaseFilePath(tmpRoot, 's1'))).toBe(false);
    rmSpy.mockRestore();
    expect(takeoverSpy).toHaveBeenCalledWith('s1', { deviceId: 'dev-B', device: 'phone-B' });
  });

  it('lapsed renew with the hub down during re-acquire keeps the lease optimistically', async () => {
    await holdS1();

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
    await holdS1();

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

    await expectRenewAndHeld(); // a SECOND renew on the next tick: the timer kept running
  });

  it('destroy clears all renew timers', async () => {
    await holdS1();
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

  it('a write still queued when the client is destroyed never lands', async () => {
    // WHY: a renew write queued behind a slow one once outlived its test and wrote into the NEXT test's folder. Staged with a gate: write 1 held mid-flight, write 2 queued behind it, destroy() lands first.
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const realWrite = fs.promises.writeFile;
    const writeSpy = vi.spyOn(fs.promises, 'writeFile')
      .mockImplementation(async (...args: any[]) => { await gate; return (realWrite as any).apply(fs.promises, args); });
    hubRequest.mockResolvedValue(okResult('acquire', 's1', Date.now() + 300_000));

    const first = client.acquire('s1');
    const second = client.acquire('s1');
    await vi.waitFor(() => { expect(writeSpy).toHaveBeenCalledTimes(1); });
    client.destroy();
    open();
    await first;
    await second;   // resolves only after its own slot ran — skipped or written

    expect(writeSpy).toHaveBeenCalledTimes(1);
    writeSpy.mockRestore();
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

  it('acquire on hub-disconnected holds locally without claiming the hub confirmed ownership', async () => {
    hubRequest.mockResolvedValue(null);
    const res = await client.acquire('s1');

    expect(res).toBeNull();
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
    // WHY: the freeze shape is a disk stall inside the lease write; it must be off the event loop (a real timer still fires). Also assert the SYNC writers were never called, so a fast writeFileSync can't pass by accident.
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
