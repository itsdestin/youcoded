// The buddy position file is saved by a debounced async writer (2026-10-22 freeze hunt).
// These pin the three behaviours that could silently regress: a burst makes one write, quitting
// (flush) saves a pending change immediately, and a write is atomic (no half-file, no temp left).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDebouncedJsonWriter, flushDebouncedJsonWrites } from '../src/main/debounced-json-writer';

let dir: string;
let file: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbw-')); file = path.join(dir, 'buddy.json'); });
afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

describe('debounced json writer', () => {
  it('writes nothing until the burst settles, then writes the LATEST state once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const state: any = { mascot: { x: 0, y: 0 } };
    const w = createDebouncedJsonWriter({ file, getValue: () => state, delayMs: 500 });
    for (let i = 1; i <= 50; i++) { state.mascot = { x: i, y: i }; w.schedule(); await vi.advanceTimersByTimeAsync(10); }
    expect(fs.existsSync(file)).toBe(false);          // 500 ms of quiet has not passed yet
    await vi.advanceTimersByTimeAsync(600);
    await w.flush();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ mascot: { x: 50, y: 50 } });
  });

  it('flush (quit) saves a pending change immediately, without waiting out the delay', async () => {
    const state = { dock: 'left' };
    const w = createDebouncedJsonWriter({ file, getValue: () => state, delayMs: 60_000 });
    w.schedule();
    await w.flush();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ dock: 'left' });
  });

  it('flush with nothing pending writes nothing', async () => {
    const w = createDebouncedJsonWriter({ file, getValue: () => ({}), delayMs: 10 });
    await w.flush();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('writes atomically: no temp file is left and a bad target never throws', async () => {
    const w = createDebouncedJsonWriter({ file, getValue: () => ({ a: 1 }) });
    w.schedule(); await w.flush();
    expect(fs.readdirSync(dir)).toEqual(['buddy.json']);
    fs.rmSync(file); fs.mkdirSync(file);               // a directory where the file should be
    w.schedule();
    await expect(w.flush()).resolves.toBeUndefined();   // best effort, like the old try/catch
  });

  it('the quit-time flush saves every writer that has a pending change', async () => {
    const other = path.join(dir, 'other.json');
    const a = createDebouncedJsonWriter({ file, getValue: () => ({ a: 1 }), delayMs: 60_000 });
    const b = createDebouncedJsonWriter({ file: other, getValue: () => ({ b: 2 }), delayMs: 60_000 });
    a.schedule(); b.schedule();
    await flushDebouncedJsonWrites();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 1 });
    expect(JSON.parse(fs.readFileSync(other, 'utf8'))).toEqual({ b: 2 });
  });
});
