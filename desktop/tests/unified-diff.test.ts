// Pins the jsdiff row output against the DiffRow shape the renderer draws
// (spec §6) — the fallback replaced a hand-rolled LCS, so the row contract
// (kinds, 1-indexed per-side numbering, interleave order) must not drift.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { canDiffInline } from '../src/renderer/components/diff/diff-rows';
import { createDiffQueue } from '../src/renderer/components/diff/diff-jobs';
import { diffRowsFromStrings, rowsFromHunk } from '../src/renderer/components/diff/UnifiedDiff';

describe('diffRowsFromStrings (jsdiff fallback)', () => {
  it('produces ctx/del/add rows with per-side 1-indexed numbering', () => {
    const rows = diffRowsFromStrings('a\nb\nc', 'a\nx\nc');
    expect(rows).toEqual([
      { kind: 'ctx', oldN: 1, newN: 1, text: 'a' },
      { kind: 'del', oldN: 2, text: 'b' },
      { kind: 'add', newN: 2, text: 'x' },
      { kind: 'ctx', oldN: 3, newN: 3, text: 'c' },
    ]);
  });

  it('handles pure insertion and pure deletion', () => {
    expect(diffRowsFromStrings('a', 'a\nb')).toEqual([
      { kind: 'ctx', oldN: 1, newN: 1, text: 'a' },
      { kind: 'add', newN: 2, text: 'b' },
    ]);
    expect(diffRowsFromStrings('a\nb', 'a')).toEqual([
      { kind: 'ctx', oldN: 1, newN: 1, text: 'a' },
      { kind: 'del', oldN: 2, text: 'b' },
    ]);
  });

  it('does not emit a phantom row for the trailing newline', () => {
    const rows = diffRowsFromStrings('a\n', 'a\n');
    expect(rows).toEqual([{ kind: 'ctx', oldN: 1, newN: 1, text: 'a' }]);
  });

  it('identical inputs are all context', () => {
    const rows = diffRowsFromStrings('x\ny', 'x\ny');
    expect(rows.every((r) => r.kind === 'ctx')).toBe(true);
    expect(rows).toHaveLength(2);
  });
});

describe('bounded comparison work', () => {
  afterEach(() => vi.useRealTimers());
  const input = { oldStr: 'old', newStr: 'new' };
  function fakeWorker() {
    return { onmessage: null as ((event: { data: unknown }) => void) | null,
      onerror: null as ((event: { preventDefault: () => void }) => void) | null,
      postMessage: vi.fn(), terminate: vi.fn() };
  }
  it('bounds both character count and line count before choosing the render fast path', () => {
    expect(canDiffInline('a', 'b')).toBe(true);
    expect(canDiffInline('a'.repeat(32769), '')).toBe(false);
    expect(canDiffInline('a\n'.repeat(1000), 'b')).toBe(false);
    expect(canDiffInline('a\n'.repeat(100), 'b\n'.repeat(100))).toBe(true);
    expect(canDiffInline('a\n'.repeat(100), 'b\n'.repeat(100) + 'tail')).toBe(false);
  });

  it('runs only one worker at a time and removes queued cancellations without starting them', async () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const queue = createDiffQueue(() => { const w = fakeWorker(); workers.push(w); return w as unknown as Worker; });
    const a = queue.request(input), b = queue.request(input), c = queue.request(input);
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    b.cancel();
    await expect(b.promise).resolves.toBeNull();
    expect(workers).toHaveLength(1);
    workers[0].onmessage?.({ data: { ok: true, rows: [] } });
    await expect(a.promise).resolves.toEqual([]);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    c.cancel();
    await expect(c.promise).resolves.toBeNull();
    expect(workers.every(w => w.terminate.mock.calls.length === 1)).toBe(true);
  });

  it('bounds a stuck comparison and makes the queue available for the next one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const queue = createDiffQueue(() => { const w = fakeWorker(); workers.push(w); return w as unknown as Worker; }, 20);
    const a = queue.request(input);
    const rejected = expect(a.promise).rejects.toThrow('took too long');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    const b = queue.request(input);
    await Promise.resolve();
    expect(workers).toHaveLength(2);
    workers[1].onmessage?.({ data: { ok: true, rows: [] } });
    await expect(b.promise).resolves.toEqual([]);
  });

  it('rejects constructor and worker errors without computing inline', async () => {
    const queue = createDiffQueue(() => { throw new Error('unavailable'); });
    await expect(queue.request(input).promise).rejects.toThrow('start this comparison');
    const w = fakeWorker();
    const job = createDiffQueue(() => w as unknown as Worker).request(input);
    const failed = expect(job.promise).rejects.toThrow('calculate this comparison');
    await Promise.resolve();
    w.onerror?.({ preventDefault: vi.fn() });
    await failed;
    expect(w.terminate).toHaveBeenCalledOnce();
  });
});

describe('rowsFromHunk (structuredPatch path — unchanged behavior)', () => {
  it('uses ABSOLUTE file line numbers from the hunk header', () => {
    const rows = rowsFromHunk({
      oldStart: 100, oldLines: 3, newStart: 100, newLines: 3,
      lines: [' ctx1', '-gone', '+here', ' ctx2'],
    } as any);
    expect(rows).toEqual([
      { kind: 'ctx', oldN: 100, newN: 100, text: 'ctx1' },
      { kind: 'del', oldN: 101, text: 'gone' },
      { kind: 'add', newN: 101, text: 'here' },
      { kind: 'ctx', oldN: 102, newN: 102, text: 'ctx2' },
    ]);
  });
});
