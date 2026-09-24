import { describe, it, expect, vi } from 'vitest';
import { createHandoffAttempts } from '../src/main/conversations/handoff-attempt';
import { createResumeAdmission } from '../src/main/conversations/resume-admission';

const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const owner = 'window:3';
function setup() {
  let live: { id: string } | undefined;
  const acquire = vi.fn(async () => ({ ok: true }));
  const release = vi.fn(async () => {});
  const admission = createResumeAdmission({ acquire, release, getLive: () => live });
  const pin = { active: vi.fn(() => true), release: vi.fn() };
  const query = vi.fn().mockResolvedValueOnce({ held: true, deviceId: 'sender', self: false })
    .mockResolvedValue({ held: false, deviceId: 'sender', self: false });
  const takeover = vi.fn(async (_id: string, _nonce: string) => null);
  const forceIfHolder = vi.fn(async (_id: string, _expected: string): Promise<{
    ok: boolean; op: string; sessionId: string; holder: { deviceId: string } | null
  } | null> => null);
  const sync = vi.fn(async () => {});
  const confirm = vi.fn(async (_context: unknown) => ({ status: 'confirmed' as const, receipt: {} as never }));
  const project = vi.fn(async () => '/project');
  const start = vi.fn(async (_owner: string, _context: unknown, _cwd: string, check: () => void, _opts: unknown) => { check(); live = { id: 'writer' }; return live; });
  const dispose = vi.fn(async (session: { id: string }) => { if (live === session) live = undefined; });
  const attempts = createHandoffAttempts({ deviceId: 'receiver', query, takeover, sync, confirm,
    pin: () => pin, project, start, dispose, admission, forceIfHolder,
    releaseForced: release, delay: async () => {}, pollCount: 2 });
  const begin = () => attempts.begin(owner, 'conversation', 'native', { model: 'draft' });
  return { attempts, begin, admission, acquire, release, pin, query, takeover, forceIfHolder, sync, confirm, project, start, dispose, get live() { return live; } };
}

describe('handoff attempt admission', () => {
  it('keeps original sender and nonce across lost acknowledgement, retry and competing receipt', async () => {
    const s = setup(); s.confirm.mockResolvedValueOnce({ status: 'incomplete', reason: 'other nonce' } as never)
      .mockResolvedValueOnce({ status: 'incomplete', reason: 'other nonce' } as never);
    const a = s.begin(); expect(a.status).toBe('waiting');
    expect((await s.attempts.wait(owner, a.id)).status).toBe('incomplete');
    expect(s.pin.release).not.toHaveBeenCalled(); // waiting/retry still fences ordinary import
    const b = await s.attempts.retry(owner, a.id);
    expect(b.status).toBe('admitted'); expect(s.takeover).toHaveBeenCalledTimes(1);
    expect(s.takeover.mock.calls[0]?.[1]).toBe(s.attempts.context(owner, a.id).transferNonce);
    expect(s.confirm.mock.calls[2]?.[0]).toEqual(s.attempts.context(owner, a.id));
    expect(s.acquire).toHaveBeenCalledTimes(3);
  });
  it('lets the same owner re-adopt its attempt after a lost begin reply, but refuses other owners', async () => {
    const s = setup(); s.confirm.mockResolvedValue({ status: 'incomplete', reason: 'no receipt' } as never);
    const a = s.begin();
    const again = s.begin();
    expect(again.id).toBe(a.id);
    expect(() => s.attempts.begin('window:other', 'conversation', 'native', { model: 'draft' })).toThrow();
    expect((await s.attempts.wait(owner, again.id)).status).toBe('incomplete');
    expect(s.begin().id).toBe(a.id); // incomplete stays adoptable; one nonce, one takeover request
    expect(s.takeover).toHaveBeenCalledTimes(1);
  });
  it('requires separate confirmed force consent for the original displayed holder before strict saved-copy startup', async () => {
    const s = setup(); s.confirm.mockResolvedValue({ status: 'incomplete', reason: 'no receipt' } as never);
    s.query.mockReset().mockResolvedValue({ held: true, source: 'hub', deviceId: 'sender', device: 'Other computer', self: false });
    s.acquire.mockResolvedValueOnce({ ok: false, holder: { device: 'Other computer' } } as never);
    const a = s.begin(); const incomplete = await s.attempts.wait(owner, a.id);
    expect(incomplete).toMatchObject({ status: 'incomplete', holder: { deviceId: 'sender', device: 'Other computer' } });
    expect(await s.attempts.savedCopy(owner, a.id, true)).toMatchObject({ status: 'incomplete', cause: 'lease-denied' });
    await expect(s.attempts.force('window:other', a.id, true, 'sender')).rejects.toThrow();
    await expect(s.attempts.force(owner, a.id, false, 'sender')).rejects.toThrow();
    await expect(s.attempts.force(owner, a.id, true, 'different')).rejects.toThrow();
    expect(s.forceIfHolder).not.toHaveBeenCalled();
    s.forceIfHolder.mockResolvedValue({ ok: true, op: 'force-acquire-if-holder', sessionId: 'conversation', holder: { deviceId: 'receiver' } });
    expect(await s.attempts.force(owner, a.id, true, 'sender')).toMatchObject({ status: 'admitted', source: 'saved-copy' });
    expect(s.forceIfHolder).toHaveBeenCalledWith('conversation', 'sender');
    expect(s.confirm).not.toHaveBeenCalled(); // force is never freshness confirmation
    expect(s.start).toHaveBeenCalledTimes(1);
  });

  it('refuses a changed holder, a legacy/null reply, and cancellation after the force query', async () => {
    const s = setup(); s.query.mockReset().mockResolvedValueOnce({ held: true, deviceId: 'sender', device: 'Original', source: 'hub', self: false })
      .mockResolvedValue({ held: true, deviceId: 'replacement', source: 'hub', self: false });
    const a = s.begin(); await s.attempts.wait(owner, a.id);
    expect(await s.attempts.force(owner, a.id, true, 'sender')).toMatchObject({ status: 'incomplete' });
    expect(s.forceIfHolder).not.toHaveBeenCalled(); expect(s.start).not.toHaveBeenCalled();
    s.query.mockResolvedValue({ held: true, deviceId: 'sender', source: 'hub', self: false });
    s.forceIfHolder.mockResolvedValueOnce(null).mockResolvedValueOnce({ ok: true, op: 'force-acquire', sessionId: 'conversation', holder: { deviceId: 'receiver' } });
    expect(await s.attempts.force(owner, a.id, true, 'sender')).toMatchObject({ status: 'incomplete' });
    expect(await s.attempts.force(owner, a.id, true, 'sender')).toMatchObject({ status: 'incomplete' });
    const q = deferred<{ held: boolean; deviceId: string; source: 'hub'; self: boolean }>();
    s.query.mockImplementationOnce(() => q.promise);
    const work = s.attempts.force(owner, a.id, true, 'sender');
    s.attempts.cancel(owner, a.id);
    q.resolve({ held: true, deviceId: 'sender', source: 'hub', self: false });
    expect(await work).toMatchObject({ status: 'cancelled' });
    expect(s.forceIfHolder).toHaveBeenCalledTimes(2); expect(s.start).not.toHaveBeenCalled();
  });

  it('never starts on a conditional grant without strict admission, and releases a late cancelled grant', async () => {
    const s = setup(); s.query.mockReset().mockResolvedValue({ held: true, deviceId: 'sender', source: 'hub', self: false });
    const a = s.begin(); await s.attempts.wait(owner, a.id);
    s.forceIfHolder.mockResolvedValueOnce({ ok: true, op: 'force-acquire-if-holder', sessionId: 'conversation', holder: { deviceId: 'receiver' } });
    s.acquire.mockResolvedValueOnce({ ok: false, holder: { device: 'Other holder' } } as never);
    expect(await s.attempts.force(owner, a.id, true, 'sender')).toMatchObject({ status: 'incomplete', cause: 'lease-denied' });
    expect(s.start).not.toHaveBeenCalled(); expect(s.pin.release).not.toHaveBeenCalled();
    const reply = deferred<{ ok: boolean; op: string; sessionId: string; holder: { deviceId: string } }>();
    s.forceIfHolder.mockImplementationOnce(() => reply.promise);
    const pending = s.attempts.force(owner, a.id, true, 'sender');
    await vi.waitFor(() => expect(s.forceIfHolder).toHaveBeenCalledTimes(2));
    s.attempts.cancel(owner, a.id);
    reply.resolve({ ok: true, op: 'force-acquire-if-holder', sessionId: 'conversation', holder: { deviceId: 'receiver' } });
    expect(await pending).toMatchObject({ status: 'cancelled' });
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.start).not.toHaveBeenCalled();
  });

  it('returns at the waiting deadline without starting after a stalled sync resolves', async () => {
    const s = setup(); const blocked = deferred<void>(); s.sync.mockImplementationOnce(() => blocked.promise);
    vi.useFakeTimers();
    try {
      const a = s.begin();
      for (let i = 0; i < 20 && !s.sync.mock.calls.length; i++) await Promise.resolve();
      expect(s.sync).toHaveBeenCalled();
      const work = s.attempts.wait(owner, a.id);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await work).toMatchObject({ status: 'incomplete', cause: 'receipt not confirmed' });
      expect(s.pin.release).not.toHaveBeenCalled();
      blocked.resolve();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(s.attempts.status(owner, a.id).status).toBe('incomplete');
      expect(s.start).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('rediscovers the sender on retry before sending, but never changes it after sending', async () => {
    const s = setup(); s.query.mockReset().mockResolvedValueOnce({ held: false, source: 'none' })
      .mockResolvedValueOnce({ held: true, source: 'hub', deviceId: 'sender', self: false })
      .mockResolvedValue({ held: false, source: 'hub', deviceId: 'sender', self: false });
    const a = s.begin();
    expect(await s.attempts.wait(owner, a.id)).toMatchObject({ status: 'incomplete' });
    expect(s.takeover).not.toHaveBeenCalled();
    expect((await s.attempts.retry(owner, a.id)).status).toBe('admitted');
    expect(s.takeover).toHaveBeenCalledTimes(1);
    expect(s.attempts.context(owner, a.id).senderDeviceId).toBe('sender');
  });
  it('retries a failed first holder query without sending to an empty sender', async () => {
    const s = setup(); s.query.mockReset().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ held: true, source: 'hub', deviceId: 'sender', self: false })
      .mockResolvedValue({ held: false, source: 'hub', deviceId: 'sender', self: false });
    const a = s.begin();
    expect(await s.attempts.wait(owner, a.id)).toMatchObject({ status: 'incomplete', cause: 'lease query unavailable' });
    expect(s.takeover).not.toHaveBeenCalled();
    expect((await s.attempts.retry(owner, a.id)).status).toBe('admitted');
    expect(s.takeover).toHaveBeenCalledWith('conversation', s.attempts.context(owner, a.id).transferNonce);
  });
  it('does not reserve on uncloneable create parameters', async () => {
    const s = setup();
    expect(() => s.attempts.begin(owner, 'conversation', 'native', { callback: () => {} })).toThrow();
    expect(await s.admission.open('conversation', async () => ({ id: 'ordinary' }), false)).toEqual({ id: 'ordinary' });
  });
  it('blocks generic opens during wait but leaves ordinary offline opens intact', async () => {
    const s = setup(); const pending = deferred<void>(); s.sync.mockImplementationOnce(() => pending.promise);
    const a = s.begin();
    expect(await s.admission.open('conversation', async () => ({ id: 'wrong' }))).toEqual({ status: 'lease-denied' });
    expect(await s.admission.open('other', async () => ({ id: 'offline' }), false)).toEqual({ id: 'offline' });
    s.attempts.cancel(owner, a.id); pending.resolve(); await s.attempts.wait(owner, a.id);
    expect(s.start).not.toHaveBeenCalled();
  });
  it('refuses stale owner, stale generation and force-less saved copy after denial', async () => {
    const s = setup(); const a = s.begin();
    expect(() => s.attempts.cancel('window:4', a.id)).toThrow();
    expect(await s.attempts.wait(owner, a.id)).toMatchObject({ status: 'admitted' });
    await expect(s.attempts.retry(owner, a.id)).rejects.toThrow();
    const t = setup(); t.acquire.mockResolvedValueOnce({ ok: false } as never);
    const b = t.begin(); t.attempts.cancel(owner, b.id); await t.attempts.wait(owner, b.id);
    t.confirm.mockResolvedValue({ status: 'incomplete', reason: 'absent' } as never);
    const c = t.begin(); await t.attempts.wait(owner, c.id);
    expect(await t.attempts.savedCopy(owner, c.id, true)).toMatchObject({ status: 'incomplete', cause: 'lease-denied' });
  });
  it('keeps saved-copy distinct from confirmed and refuses missing create parameters', async () => {
    const s = setup();
    s.confirm.mockResolvedValue({ status: 'incomplete', reason: 'receipt absent' } as never);
    const a = s.attempts.begin(owner, 'conversation', 'native');
    expect((await s.attempts.wait(owner, a.id)).status).toBe('incomplete');
    expect(s.start).not.toHaveBeenCalled();
    s.attempts.setCreateParams(owner, a.id, { model: 'later' });
    expect(() => s.attempts.setCreateParams(owner, a.id, { model: 'overwrite' })).toThrow();
    expect(await s.attempts.savedCopy(owner, a.id, true)).toMatchObject({ status: 'admitted', source: 'saved-copy' });
    expect(s.start.mock.calls[0]?.[4]).toEqual({ model: 'later' });
  });
  it('removes an optimistic hold when strict acquire has no hub response', async () => {
    const s = setup(); s.acquire.mockResolvedValueOnce(null as never);
    const a = s.begin();
    expect(await s.attempts.wait(owner, a.id)).toMatchObject({ status: 'incomplete', cause: 'lease-denied' });
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.start).not.toHaveBeenCalled();
  });
  it('cancels while acquire awaits without starting or leaking a hold', async () => {
    const s = setup(); const waiting = deferred<{ ok: boolean }>(); s.acquire.mockImplementationOnce(() => waiting.promise);
    const a = s.begin(); const work = s.attempts.wait(owner, a.id);
    await vi.waitFor(() => expect(s.acquire).toHaveBeenCalled());
    s.attempts.cancel(owner, a.id); waiting.resolve({ ok: true });
    expect((await work).status).toBe('cancelled'); expect(s.start).not.toHaveBeenCalled();
    expect(s.release).toHaveBeenCalledTimes(1);
  });
  it('cancels before a delayed holder query without asking for transfer', async () => {
    const s = setup(); const q = deferred<{ held: boolean; deviceId: string; self: boolean }>();
    s.query.mockImplementationOnce(() => q.promise);
    const a = s.begin(); s.attempts.cancel(owner, a.id);
    q.resolve({ held: true, deviceId: 'sender', self: false });
    expect((await s.attempts.wait(owner, a.id)).status).toBe('cancelled');
    expect(s.takeover).not.toHaveBeenCalled(); expect(s.acquire).not.toHaveBeenCalled();
  });
  it('retains the destination pin after startup until only its session has ended', async () => {
    const s = setup(); const a = s.begin();
    expect((await s.attempts.wait(owner, a.id)).status).toBe('admitted');
    expect(s.pin.release).not.toHaveBeenCalled();
    s.attempts.ended('another-writer'); expect(s.pin.release).not.toHaveBeenCalled();
    s.attempts.ended('writer'); expect(s.pin.release).toHaveBeenCalledTimes(1);
  });
  it('keeps an admitted destination fenced after an unproven destroy and frees it only on proven stop', async () => {
    const s = setup(); const a = s.begin();
    expect((await s.attempts.wait(owner, a.id)).status).toBe('admitted');
    expect(s.attempts.hasSession('writer')).toBe(true);
    expect(s.pin.release).not.toHaveBeenCalled();
    s.attempts.ended('writer');
    expect(s.pin.release).toHaveBeenCalledTimes(1);
  });
  it('does not release twice when disposal itself schedules the session-exit release', async () => {
    const s = setup(); const boot = deferred<void>();
    s.start.mockImplementationOnce(async () => { await boot.promise; return { id: 'writer' }; });
    s.dispose.mockImplementationOnce(async () => { s.admission.end('conversation'); });
    const a = s.begin(); const work = s.attempts.wait(owner, a.id);
    await vi.waitFor(() => expect(s.start).toHaveBeenCalled());
    s.attempts.cancel(owner, a.id); boot.resolve();
    expect((await work).status).toBe('cancelled');
    expect(s.release).toHaveBeenCalledTimes(1);
  });
  it('retains unsafe protection and destination fence if canceled startup cannot be disposed', async () => {
    const s = setup(); const boot = deferred<void>();
    s.start.mockImplementationOnce(async () => { await boot.promise; return { id: 'writer' }; });
    s.dispose.mockRejectedValueOnce(new Error('disposal failed'));
    const a = s.begin(); const work = s.attempts.wait(owner, a.id);
    await vi.waitFor(() => expect(s.start).toHaveBeenCalled());
    s.attempts.cancel(owner, a.id); boot.resolve();
    expect((await work).status).toBe('cancelled');
    expect(s.admission.isUnsafe('conversation')).toBe(true);
    expect(s.release).not.toHaveBeenCalled(); expect(s.pin.release).not.toHaveBeenCalled();
  });
  it('cancels during import and cleans up only an attempt-owned native startup', async () => {
    const s = setup(); const waiting = deferred<{ status: 'confirmed'; receipt: never }>();
    s.confirm.mockImplementationOnce(() => waiting.promise);
    const a = s.begin(); const work = s.attempts.wait(owner, a.id);
    await vi.waitFor(() => expect(s.confirm).toHaveBeenCalled());
    s.attempts.cancel(owner, a.id); waiting.resolve({ status: 'confirmed', receipt: {} as never });
    expect((await work).status).toBe('cancelled'); expect(s.start).not.toHaveBeenCalled();
    expect(s.release).toHaveBeenCalledTimes(1); expect(s.pin.release).toHaveBeenCalled();
    const t = setup(); const boot = deferred<void>();
    t.start.mockImplementationOnce(async (_owner, _context, _cwd, check) => { await boot.promise; check(); return { id: 'writer' }; });
    const b = t.begin(); const work2 = t.attempts.wait(owner, b.id);
    await vi.waitFor(() => expect(t.start).toHaveBeenCalled());
    t.attempts.cancel(owner, b.id); boot.resolve();
    expect((await work2).status).toBe('cancelled'); expect(t.release).toHaveBeenCalledTimes(1);
    const u = setup(); const late = deferred<void>();
    u.start.mockImplementationOnce(async () => { await late.promise; return { id: 'writer' }; });
    const d = u.begin(); const work3 = u.attempts.wait(owner, d.id);
    await vi.waitFor(() => expect(u.start).toHaveBeenCalled());
    u.attempts.cancel(owner, d.id); late.resolve();
    expect((await work3).status).toBe('cancelled');
    expect(u.dispose).toHaveBeenCalledWith({ id: 'writer' });
    expect(u.release).toHaveBeenCalledTimes(1);
  });
});
