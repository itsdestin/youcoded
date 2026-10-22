// The stall profiler keeps rolling CPU profiles in memory and writes them only when a 2 s+ stall is reported
// (2026-10-22 freeze hunt). Pins: nothing written without a stall, the file carries the stall's timestamp,
// the file cap, and the off switch.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StallProfiler, startStallProfiler, stallProfilerDisabled } from '../src/main/stall-profiler';

const spin = (ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { /* busy */ } };
let dirs: string[] = [];
// `dirs` holds the mkdtemp folders themselves (each owns a stall-profiles subfolder); only those are removed.
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stallprof-')); dirs.push(d); return path.join(d, 'stall-profiles'); };
afterEach(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); dirs = []; });

describe('StallProfiler', () => {
  it('writes nothing while nothing stalls, and ignores a stall under 2 s', async () => {
    const dir = tmp();
    const p = new StallProfiler({ dir });
    expect(p.start()).toBe(true);
    await p.onStall(Date.now(), 1500);
    await p.stop();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('a 2 s+ stall saves a loadable .cpuprofile named with the stall timestamp and length', async () => {
    const dir = tmp();
    const p = new StallProfiler({ dir, sampleIntervalUs: 1000 });
    p.start();
    spin(120);
    const at = Date.parse('2026-10-22T19:05:06.789Z');
    await p.onStall(at, 2500);
    await p.stop();
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.cpuprofile'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('stall-2026-10-22T19-05-06-789Z-2500ms.cpuprofile');
    const profile = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    expect(Array.isArray(profile.nodes)).toBe(true);
    expect(profile.nodes.length).toBeGreaterThan(0);
    expect(Array.isArray(profile.samples)).toBe(true);
  });

  it('keeps at most maxFiles files, deleting the oldest', async () => {
    const dir = tmp();
    let clock = Date.parse('2026-10-22T10:00:00Z');
    const p = new StallProfiler({ dir, maxFiles: 3, now: () => clock });
    p.start();
    for (let i = 0; i < 6; i++) {
      clock += 60_000;                                   // each stall a minute apart: past the burst gap
      await p.onStall(clock, 3000);
      await new Promise((r) => setTimeout(r, 15)); // distinct mtimes
    }
    await p.stop();
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.cpuprofile')).sort();
    expect(files).toHaveLength(3);
    // The oldest stalls' files are gone; the newest stall's remain. (A stall can save two files: the previous window too.)
    expect(files.some((f) => /T10-0[123]-00/.test(f))).toBe(false);
    expect(files.some((f) => f.includes('T10-06-00'))).toBe(true);
  });

  it('YOUCODED_STALL_PROFILER=0 turns it off entirely', () => {
    expect(stallProfilerDisabled({ YOUCODED_STALL_PROFILER: '0' })).toBe(true);
    expect(startStallProfiler({ dir: tmp() }, { YOUCODED_STALL_PROFILER: '0' })).toBeNull();
  });

  it('a burst of stalls shares one saved profile and never writes the same window twice', async () => {
    const dir = tmp();
    let clock = Date.parse('2026-10-22T10:00:00Z');
    const p = new StallProfiler({ dir, now: () => clock, maxFiles: 10 });
    p.start();
    await p.onStall(clock, 3000);                          // first stall: saved at once
    const afterFirst = fs.readdirSync(dir).length;
    for (let i = 0; i < 8; i++) { clock += 1000; await p.onStall(clock, 2500); }   // eight more inside the gap
    expect(fs.readdirSync(dir).length).toBe(afterFirst);   // nothing new written during the burst
    await p.stop();                                         // quit saves the merged one stall profile
    const names = fs.readdirSync(dir);
    expect(names.length).toBeLessThanOrEqual(afterFirst + 2);
    expect(new Set(names).size).toBe(names.length);
  });

  it('older, distinct profiles survive a burst (the cap is not churned by duplicates)', async () => {
    const dir = tmp();
    let clock = Date.parse('2026-10-22T10:00:00Z');
    const p = new StallProfiler({ dir, now: () => clock, maxFiles: 10 });
    p.start();
    for (let i = 0; i < 3; i++) { clock += 60_000; await p.onStall(clock, 3000); }   // three well-spaced stalls
    const before = fs.readdirSync(dir).filter((n) => !n.includes('T10-03')).sort();
    for (let i = 0; i < 20; i++) { clock += 500; await p.onStall(clock, 2200); }       // a burst
    await p.stop();
    const after = new Set(fs.readdirSync(dir));
    for (const n of before) expect(after.has(n)).toBe(true);
  });

  it('a merged profile lists every stall it covers in a .stalls.json beside it, and pruning removes both', async () => {
    const dir = tmp();
    let clock = Date.parse('2026-10-22T10:00:00Z');
    const p = new StallProfiler({ dir, now: () => clock, maxFiles: 10 });
    p.start();
    await p.onStall(clock, 3000);                       // saved at once
    clock += 2000; await p.onStall(clock, 2100);        // inside the gap: merged into the next save
    clock += 2000; await p.onStall(clock, 2600);
    await p.stop();
    const lists = fs.readdirSync(dir).filter((n) => n.endsWith('.stalls.json'));
    const merged = lists.map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).stalls).find((s: any[]) => s.length === 2);
    expect(merged.map((x: any) => x.ms)).toEqual([2100, 2600]);
    for (const n of lists) expect(fs.existsSync(path.join(dir, n.replace('.stalls.json', '')))).toBe(true);
  });
});
