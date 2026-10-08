// Batching, rotation and "never hold the file open" for the hitch recorder's writer.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RotatingJsonlWriter } from '../src/main/hitch-log-writer';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hitch-writer-')); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

describe('RotatingJsonlWriter', () => {
  it('buffers lines and writes them in ONE flush after 2 s (fake timers)', async () => {
    vi.useFakeTimers();
    const open = vi.fn(fsp.open);
    const w = new RotatingJsonlWriter({ dir, fs: { ...fsp, open } as any });
    for (let i = 0; i < 50; i++) w.append({ i });
    expect(existsSync(join(dir, 'hitches.jsonl'))).toBe(false); // nothing on disk yet
    await vi.advanceTimersByTimeAsync(1999);
    expect(open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    vi.useRealTimers();
    await w.flush();
    expect(open).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, 'hitches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(50);
  });

  it('arms no timer while idle', () => {
    vi.useFakeTimers();
    new RotatingJsonlWriter({ dir });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never holds the file open: every flush closes its handle', async () => {
    const closes: number[] = [];
    let opens = 0;
    const fs = { ...fsp, open: async (...a: Parameters<typeof fsp.open>) => { opens++; const h = await fsp.open(...a); const c = h.close.bind(h); h.close = async () => { closes.push(1); return c(); }; return h; } };
    const w = new RotatingJsonlWriter({ dir, fs: fs as any });
    w.append({ a: 1 }); await w.flush();
    w.append({ a: 2 }); await w.flush();
    expect(opens).toBe(2);
    expect(closes).toHaveLength(2);
  });

  it('rotates at the cap to hitches.1.jsonl and keeps only two files', async () => {
    const w = new RotatingJsonlWriter({ dir, maxBytes: 1000 });
    for (let round = 0; round < 8; round++) {
      for (let i = 0; i < 5; i++) w.append({ round, pad: 'x'.repeat(60) });
      await w.flush();
    }
    expect(w.rotations).toBeGreaterThan(2);
    expect(readdirSync(dir).sort()).toEqual(['hitches.1.jsonl', 'hitches.jsonl']);
    expect(statSync(join(dir, 'hitches.jsonl')).size).toBeLessThanOrEqual(1000);
    // the rotated file holds the previous generation, the live one the newest
    const last = readFileSync(join(dir, 'hitches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(last.at(-1).round).toBe(7);
  });

  it('at the real 5 MiB cap, 60 MB of lines leave exactly two files totalling <= 10 MiB', async () => {
    const w = new RotatingJsonlWriter({ dir });
    // a realistic mix: minute-line-sized (~510 B) and frame-line-sized (~280 B) rows
    for (let i = 0; i < 100_000; i++) { w.append({ pad: 'x'.repeat(i % 3 ? 250 : 480) }); if (i % 500 === 499) await w.flush(); }
    await w.flush();
    expect(w.lost).toBe(0);
    expect(w.rotations).toBeGreaterThanOrEqual(5);
    const sizes = readdirSync(dir).sort().map((f) => statSync(join(dir, f)).size);
    expect(readdirSync(dir).sort()).toEqual(['hitches.1.jsonl', 'hitches.jsonl']);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(5 * 1024 * 1024);
  });

  it('writes a private file in a private folder', async () => {
    const w = new RotatingJsonlWriter({ dir: join(dir, 'perf') });
    w.append({ a: 1 }); await w.flush();
    expect(statSync(join(dir, 'perf')).mode & 0o077).toBe(0);
    expect(statSync(join(dir, 'perf', 'hitches.jsonl')).mode & 0o077).toBe(0);
  });

  it('drops (and counts) lines once the in-memory queue is full', () => {
    const w = new RotatingJsonlWriter({ dir, maxQueueBytes: 100 });
    for (let i = 0; i < 20; i++) w.append({ pad: 'y'.repeat(30) });
    expect(w.lost).toBeGreaterThan(10);
  });

  it('a failing disk drops the batch, counts it, and does not throw', async () => {
    const w = new RotatingJsonlWriter({ dir, fs: { ...fsp, open: async () => { throw new Error('EIO'); } } as any });
    w.append({ a: 1 }); w.append({ a: 2 });
    await expect(w.flush()).resolves.toBeUndefined();
    expect(w.lost).toBe(2);
  });

  it('a second append during a flush gets its own flush', async () => {
    const w = new RotatingJsonlWriter({ dir, flushMs: 5 });
    w.append({ a: 1 });
    const p = w.flush();
    w.append({ a: 2 });
    await p;
    await new Promise((r) => setTimeout(r, 60));
    expect(readFileSync(join(dir, 'hitches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
