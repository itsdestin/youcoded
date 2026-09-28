import { describe, expect, it, vi } from 'vitest';
import { createResumeAdmission } from '../src/main/conversations/resume-admission';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function fixture() {
  const sessions = new Map<string, { id: string }>();
  const acquire = vi.fn(async (_id: string): Promise<{ ok: boolean; holder?: { device: string } } | null> => ({ ok: true }));
  const release = vi.fn(async (_id: string) => {});
  const admission = createResumeAdmission({ acquire, release, getLive: (id) => sessions.get(id) });
  return { sessions, acquire, release, admission };
}

describe('resumed conversation admission', () => {
  it('refuses confirmed denial before invoking create', async () => {
    const f = fixture();
    f.acquire.mockResolvedValueOnce({ ok: false, holder: { device: 'Other computer' } });
    const start = vi.fn(async () => ({ id: 'c1' }));
    expect(await f.admission.open('c1', start)).toEqual({ status: 'lease-denied', device: 'Other computer' });
    expect(start).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });

  it('coalesces concurrent starts and reuses a live writer', async () => {
    const f = fixture();
    const gate = deferred<void>();
    const start = vi.fn(async () => { await gate.promise; f.sessions.set('c1', { id: 'c1' }); return { id: 'c1' }; });
    const a = f.admission.open('c1', start);
    const b = f.admission.open('c1', start);
    await vi.waitFor(() => expect(f.acquire).toHaveBeenCalledTimes(1));
    gate.resolve();
    expect(await a).toEqual({ id: 'c1' });
    expect(await b).toEqual({ id: 'c1' });
    expect(await f.admission.open('c1', start)).toEqual({ id: 'c1' });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('releases a hold after startup exits before the create promise settles', async () => {
    const f = fixture();
    const finish = deferred<{ id: string }>();
    const opening = f.admission.open('c1', () => finish.promise);
    await vi.waitFor(() => expect(f.acquire).toHaveBeenCalledOnce());
    // A worker exit removed the SessionManager entry during native startup.
    f.admission.markExit('c1');
    finish.resolve({ id: 'c1' });
    await expect(opening).rejects.toThrow('ended before startup completed');
    expect(f.release).toHaveBeenCalledWith('c1');
  });

  it('retains the hold when startup cleanup fails and a writer remains live', async () => {
    const f = fixture();
    // Test a writer appearing during acquisition (not one that existed before open).
    f.acquire.mockImplementationOnce(async () => { f.sessions.set('c1', { id: 'c1' }); return { ok: true }; });
    f.sessions.delete('c1');
    await expect(f.admission.open('c1', async () => { throw new Error('teardown failed'); })).rejects.toThrow('teardown failed');
    expect(f.release).not.toHaveBeenCalled();
  });

  it('keeps an unsafe writer from being reused and releases after explicit safe teardown', async () => {
    const f = fixture();
    f.admission.protect('c1');
    f.sessions.set('c1', { id: 'c1' });
    await expect(f.admission.open('c1', async () => ({ id: 'new' }))).rejects.toThrow('previous writer could not be stopped');
    f.sessions.delete('c1');
    expect(f.admission.clearProtection('c1')).toBe(true);
    f.admission.end('c1');
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledWith('c1'));
  });

  it('waits for normal native teardown before releasing or admitting a new writer', async () => {
    const f = fixture();
    const stop = deferred<void>();
    f.admission.markExit('c1', stop.promise);
    const reopening = f.admission.open('c1', async () => ({ id: 'next' }));
    expect(f.release).not.toHaveBeenCalled();
    expect(f.acquire).not.toHaveBeenCalled();
    stop.resolve();
    expect(await reopening).toEqual({ id: 'next' });
    expect(f.release).toHaveBeenCalledBefore(f.acquire);
  });

  it.each([false, true])('a handoff cannot bypass an exiting writer stop barrier (stop fails: %s)', async (fails) => {
    const f = fixture();
    const stop = deferred<void>();
    f.admission.markExit('c1', stop.promise.then(() => { if (fails) throw new Error('stop failed'); }));
    // The holder's no-live path would release immediately if invoked too soon.
    const noLiveHandoff = vi.fn(async () => { await f.release('c1'); });
    const handingOff = f.admission.handoff('c1', noLiveHandoff);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(noLiveHandoff).not.toHaveBeenCalled();
      expect(f.release).not.toHaveBeenCalled();
    } finally { stop.resolve(); }
    await handingOff;
    expect(noLiveHandoff).toHaveBeenCalledTimes(fails ? 0 : 1);
    if (fails) expect(f.release).not.toHaveBeenCalled();
  });

  it('a failed native exit teardown retains the hold and refuses new opens', async () => {
    const f = fixture();
    f.admission.markExit('c1', Promise.reject(new Error('append chain failed')));
    await expect(f.admission.open('c1', async () => ({ id: 'new' }))).rejects.toThrow('previous writer could not be stopped');
    expect(f.release).not.toHaveBeenCalled();
    expect(f.acquire).not.toHaveBeenCalled();
  });

  it('an exit during opening waits for late teardown before cleanup releases', async () => {
    const f = fixture();
    const finish = deferred<{ id: string }>();
    const stop = deferred<void>();
    const opening = f.admission.open('c1', () => finish.promise);
    await vi.waitFor(() => expect(f.acquire).toHaveBeenCalledOnce());
    f.admission.markExit('c1', stop.promise);
    finish.resolve({ id: 'c1' });
    await vi.waitFor(() => expect(f.release).not.toHaveBeenCalled());
    stop.resolve();
    await expect(opening).rejects.toThrow('ended before startup completed');
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('releases its acquisition on failed startup and permits a later retry', async () => {
    const f = fixture();
    await expect(f.admission.open('c1', async () => { throw new Error('startup'); })).rejects.toThrow('startup');
    expect(f.release).toHaveBeenCalledOnce();
    expect(await f.admission.open('c1', async () => ({ id: 'c1' }))).toEqual({ id: 'c1' });
  });

  it('waits for an old writer’s asynchronous release before reacquiring', async () => {
    const f = fixture();
    const release = deferred<void>();
    f.release.mockImplementationOnce(() => release.promise);
    f.admission.end('c1');
    const open = f.admission.open('c1', async () => ({ id: 'c1' }));
    expect(f.acquire).not.toHaveBeenCalled();
    release.resolve();
    expect(await open).toEqual({ id: 'c1' });
    expect(f.acquire).toHaveBeenCalledOnce();
  });

  it('an unavailable hub allows an offline open after null or throw', async () => {
    const f = fixture();
    f.acquire.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'));
    expect(await f.admission.open('c1', async () => ({ id: 'first' }))).toEqual({ id: 'first' });
    expect(await f.admission.open('c2', async () => ({ id: 'second' }))).toEqual({ id: 'second' });
    expect(f.release).not.toHaveBeenCalled();
  });

  it('offline startup failure clears its optimistic local hold', async () => {
    const f = fixture();
    f.acquire.mockResolvedValueOnce(null);
    await expect(f.admission.open('c1', async () => { throw new Error('startup'); })).rejects.toThrow('startup');
    expect(f.release).toHaveBeenCalledWith('c1');
  });

  it('holds a handoff across an in-flight native startup and blocks new opens', async () => {
    const f = fixture();
    const startup = deferred<{ id: string }>();
    const teardown = deferred<void>();
    const start = vi.fn(() => startup.promise);
    const opening = f.admission.open('c1', start);
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const move = vi.fn(() => teardown.promise);
    const handoff = f.admission.handoff('c1', move);
    const next = vi.fn(async () => ({ id: 'next' }));
    const reopened = f.admission.open('c1', next);
    expect(move).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    startup.resolve({ id: 'c1' });
    await opening;
    await vi.waitFor(() => expect(move).toHaveBeenCalledOnce());
    expect(next).not.toHaveBeenCalled();
    teardown.resolve();
    await handoff;
    expect(await reopened).toEqual({ id: 'next' });
  });

  it('invalidates an in-flight acquire before handoff, waiting until startup settles', async () => {
    const f = fixture();
    const grant = deferred<{ ok: boolean }>();
    f.acquire.mockImplementationOnce(() => grant.promise);
    const start = vi.fn(async () => ({ id: 'c1' }));
    const opening = f.admission.open('c1', start);
    const handoff = f.admission.handoff('c1', async () => {});
    grant.resolve({ ok: true });
    expect(await opening).toEqual({ status: 'lease-denied' });
    expect(start).not.toHaveBeenCalled();
    await handoff;
    expect(f.release).toHaveBeenCalledOnce();
  });
});
