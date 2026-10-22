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
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('stall-2026-10-22T19-05-06-789Z-2500ms.cpuprofile');
    const profile = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    expect(Array.isArray(profile.nodes)).toBe(true);
    expect(profile.nodes.length).toBeGreaterThan(0);
    expect(Array.isArray(profile.samples)).toBe(true);
  });

  it('keeps at most maxFiles files, deleting the oldest', async () => {
    const dir = tmp();
    const p = new StallProfiler({ dir, maxFiles: 3 });
    p.start();
    for (let i = 0; i < 6; i++) {
      await p.onStall(Date.parse('2026-10-22T10:00:00Z') + i * 60_000, 3000);
      await new Promise((r) => setTimeout(r, 15)); // distinct mtimes
    }
    await p.stop();
    const files = fs.readdirSync(dir).sort();
    expect(files).toHaveLength(3);
    // The oldest stalls' files are gone; the newest stall's remain. (A stall can save two files: the previous window too.)
    expect(files.some((f) => /T10-0[012]-00/.test(f))).toBe(false);
    expect(files.some((f) => f.includes('T10-05-00'))).toBe(true);
  });

  it('YOUCODED_STALL_PROFILER=0 turns it off entirely', () => {
    expect(stallProfilerDisabled({ YOUCODED_STALL_PROFILER: '0' })).toBe(true);
    expect(startStallProfiler({ dir: tmp() }, { YOUCODED_STALL_PROFILER: '0' })).toBeNull();
  });
});
