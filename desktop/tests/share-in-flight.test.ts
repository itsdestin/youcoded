// A browse made while an identical one is running shares its answer instead of
// running a second full scan of every conversation file (share-in-flight.ts).
import { describe, it, expect, vi } from 'vitest';
import { shareInFlight } from '../src/main/share-in-flight';

const gate = () => { let open!: (v: string) => void; const p = new Promise<string>((r) => { open = r; }); return { p, open }; };

describe('shareInFlight', () => {
  it('two identical requests while one runs start ONE job and get the same answer', async () => {
    const once = shareInFlight<string>();
    const g = gate();
    const run = vi.fn(() => g.p);
    const a = once('k', run); const b = once('k', run);
    g.open('rows');
    expect(await a).toBe('rows'); expect(await b).toBe('rows');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a request after the job settled starts a fresh one — never a stale answer', async () => {
    const once = shareInFlight<number>();
    let n = 0;
    await once('k', async () => ++n);
    expect(await once('k', async () => ++n)).toBe(2);
  });

  it('a request with different live sessions excluded runs its own job', async () => {
    const once = shareInFlight<string>();
    const run = vi.fn(async (x: string) => x);
    const [a, b] = await Promise.all([once('s1', () => run('a')), once('s1,s2', () => run('b'))]);
    expect([a, b]).toEqual(['a', 'b']);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a failed job fails every sharer, and the next request retries', async () => {
    const once = shareInFlight<string>();
    const g = Promise.reject(new Error('disk'));
    g.catch(() => {});
    const a = once('k', () => g); const b = once('k', () => g);
    await expect(a).rejects.toThrow('disk'); await expect(b).rejects.toThrow('disk');
    expect(await once('k', async () => 'ok')).toBe('ok');
  });
});
