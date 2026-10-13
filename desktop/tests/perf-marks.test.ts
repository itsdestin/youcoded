// tests/perf-marks.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('perfMark', () => {
  let dir: string;
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('appends one JSON line per mark when YOUCODED_PERF_LOG is set', async () => {
    dir = mkdtempSync(join(tmpdir(), 'perf-marks-'));
    const file = join(dir, 'marks.jsonl');
    vi.stubEnv('YOUCODED_PERF_LOG', file);
    const { perfMark } = await import('../src/main/perf-marks');
    perfMark('main:a'); perfMark('main:b');
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.name)).toEqual(['main:a', 'main:b']);
    expect(typeof lines[0].t).toBe('number');
    expect(lines[0].pid).toBe(process.pid);
  });

  // Not just "doesn't throw": that passes even if the guard is replaced by a
  // write to some default path. Spy on the only syscall the module can make and
  // assert it never happens.
  it('writes NOTHING when YOUCODED_PERF_LOG is unset', async () => {
    vi.stubEnv('YOUCODED_PERF_LOG', undefined);
    const fs = await import('fs');
    const appendSpy = vi.spyOn(fs.default, 'appendFileSync').mockImplementation(() => {});
    const { perfMark } = await import('../src/main/perf-marks');
    expect(() => perfMark('main:x')).not.toThrow();
    expect(appendSpy).toHaveBeenCalledTimes(0);
    appendSpy.mockRestore();
  });
});

describe('perfMark keeps marks in memory for the hitch recorder', () => {
  it('keeps marks even when YOUCODED_PERF_LOG is unset, and caps how many', async () => {
    vi.stubEnv('YOUCODED_PERF_LOG', undefined);
    vi.resetModules();
    const { perfMark, getPerfMarks } = await import('../src/main/perf-marks');
    perfMark('main:a'); perfMark('main:b');
    expect(getPerfMarks().map((m) => m.name)).toEqual(['main:a', 'main:b']);
    for (let i = 0; i < 500; i++) perfMark('bg:repeat');
    expect(getPerfMarks().length).toBe(120);
    vi.unstubAllEnvs(); vi.resetModules();
  });
});
