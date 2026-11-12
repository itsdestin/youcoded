// The page's saves between "save this" and the file (renderer/components/pages/page-save-queue.ts), and Put back's
// hold on them (2026-11-10 review, findings 5 and 10).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageSaveQueue } from '../src/renderer/components/pages/page-save-queue';

describe('the page save queue', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function make() {
    const written: unknown[] = [];
    const flags: boolean[] = [];
    const q = createPageSaveQueue({ write: (d) => { written.push(d); return Promise.resolve(); }, setSaving: (s) => flags.push(s) });
    return { q, written, flags };
  }

  it('groups saves made within a pause into one write of the last', async () => {
    const { q, written, flags } = make();
    q.push({ n: 1 }); q.push({ n: 2 }); q.push({ n: 3 });
    expect(written).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(written).toEqual([{ n: 3 }]);
    expect(flags[0]).toBe(true);
    expect(flags[flags.length - 1]).toBe(false);
  });

  it('Put back: writes what is waiting at once, then takes nothing from the old page', async () => {
    const { q, written } = make();
    q.push({ n: 1 });
    q.hold();
    await q.flushNow();
    expect(written).toEqual([{ n: 1 }]);
    q.push({ n: 'late save from the old page' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(written).toEqual([{ n: 1 }]);
    q.release();
    q.push({ n: 2 });
    await vi.advanceTimersByTimeAsync(500);
    expect(written).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('flushNow waits for a write already on its way', async () => {
    let finish: () => void = () => {};
    const done: string[] = [];
    const q = createPageSaveQueue({ write: () => new Promise<void>((r) => { finish = () => { done.push('written'); r(); }; }), setSaving: () => {} });
    q.push(1);
    await vi.advanceTimersByTimeAsync(500);
    const waited = q.flushNow().then(() => done.push('flushed'));
    finish();
    await waited;
    expect(done).toEqual(['written', 'flushed']);
  });

  it('closing the view writes what is waiting', () => {
    const { q, written } = make();
    q.push({ n: 9 });
    q.dispose();
    expect(written).toEqual([{ n: 9 }]);
  });

  it('a window that cannot save lowers the flag instead of waiting forever', async () => {
    const flags: boolean[] = [];
    const q = createPageSaveQueue({ write: () => undefined, setSaving: (s) => flags.push(s) });
    q.push(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(flags).toEqual([true, false]);
  });
});
