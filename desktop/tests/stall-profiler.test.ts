// The stall profiler keeps rolling CPU profiles in memory and writes them only when a 2 s+ stall is reported
// (2026-10-22 freeze hunt). Pins: nothing written without a stall, the file carries the stall's timestamp,
// the file cap, and the off switch.
import { describe, it, expect, afterEach, vi } from 'vitest';
import inspector from 'node:inspector';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StallProfiler, startStallProfiler, stallProfilerDisabled, sliceProfile } from '../src/main/stall-profiler';

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

  // Restarting V8's profiler blocks the main thread (Profiler.start re-logs all compiled code: 50-170 ms measured),
  // so the recorder must not cause the stalls it records: no restart inside ten minutes when nothing stalls.
  it('does not restart the profiler more than once in ten minutes while nothing stalls', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const post = vi.spyOn(inspector.Session.prototype, 'post');
    try {
      const p = new StallProfiler({ dir: tmp() });
      p.start();
      const startsAfterBoot = post.mock.calls.filter((c) => (c[0] as string) === 'Profiler.start').length;
      vi.advanceTimersByTime(9 * 60_000);
      expect(post.mock.calls.filter((c) => (c[0] as string) === 'Profiler.start').length).toBe(startsAfterBoot);
      vi.advanceTimersByTime(60_000);
      expect(post.mock.calls.filter((c) => (c[0] as string) === 'Profiler.start').length).toBe(startsAfterBoot + 1);
      await p.stop();
    } finally { post.mockRestore(); vi.useRealTimers(); }
  });

  it('a saved profile keeps only the samples around the stall, with recounted hits', () => {
    // 600 samples one second apart (profile clock in microseconds), window closed at wall time 1,000,000 ms.
    // Tree: root 0 → 1, 2, 3; samples alternate 1/2 except the first 100 (node 3, early, outside the slice).
    const samples = Array.from({ length: 600 }, (_, i) => (i < 100 ? 3 : (i % 2) + 1));
    const profile = { nodes: [{ id: 0, children: [1, 2, 3] }, { id: 1, hitCount: 250 }, { id: 2, hitCount: 250 }, { id: 3, hitCount: 100 }], startTime: 0, endTime: 600e6, samples, timeDeltas: samples.map(() => 1e6) };
    const end = 1_000_000;
    const cut = sliceProfile(profile, end, end - 40_000, end - 10_000);   // the 30 s ending 10 s before the window closed
    expect(cut.samples.length).toBe(31);
    expect(cut.timeDeltas[0]).toBe(0);
    expect(cut.endTime - cut.startTime).toBe(30e6);
    expect(cut.nodes.reduce((n, x) => n + (x.hitCount ?? 0), 0)).toBe(31);
    // Nodes the slice never uses are dropped, ancestors kept, and children lists follow.
    expect(cut.nodes.map((n) => n.id).sort()).toEqual([0, 1, 2]);
    expect(cut.nodes.find((n) => n.id === 0)!.children).toEqual([1, 2]);
    // A range that matches nothing keeps the whole window rather than losing it.
    expect(sliceProfile(profile, end, 0, 1).samples.length).toBe(600);
  });

  // 140-350 ms stalls locked to a timer ran hundreds of times an hour and no profile ever named them. One per 10 minutes is
  // noted and saved at the NEXT scheduled rotation (no extra profiler restart, which would itself stall).
  it('saves one short stall per ten minutes at the next scheduled rotation, under its own small cap', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const dir = tmp();
    let clock = Date.parse('2026-11-28T10:00:00Z');
    // maxFiles 2: with one shared cap, three short samples would have evicted the long freeze's profile.
    const p = new StallProfiler({ dir, now: () => clock, windowMs: 60_000, maxFiles: 2 });
    try {
      p.start();
      // A long freeze's profile exists first; short samples must never push it out.
      await p.onStall(clock, 3000);
      for (let i = 0; i < 6; i++) {
        clock += 10 * 60_000;
        p.onShortStall(clock, 400);
        p.onShortStall(clock + 1000, 350);           // a second one inside the ten minutes is ignored
        vi.advanceTimersByTime(60_000);              // the scheduled rotation saves it
        await p.stop().catch(() => {}); p.start();   // flush pending writes, keep going
      }
      const names = fs.readdirSync(dir).filter((n) => n.endsWith('.cpuprofile'));
      const shorts = names.filter((n) => n.startsWith('short-stall-'));
      expect(shorts).toHaveLength(3);
      expect(shorts.every((n) => n.endsWith('-400ms.cpuprofile'))).toBe(true);
      expect(names.some((n) => n.startsWith('stall-') && n.includes('3000ms'))).toBe(true);
      // Under 120 ms is never noted; a 2 s+ stall belongs to onStall.
      clock += 10 * 60_000;
      p.onShortStall(clock, 110);
      vi.advanceTimersByTime(60_000);
      await p.stop();
      expect(fs.readdirSync(dir).filter((n) => n.includes('110ms'))).toEqual([]);
    } finally { await p.stop().catch(() => {}); vi.useRealTimers(); }
  });

  it('notes at most one short stall per ten minutes, even after the last one was saved', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const dir = tmp();
    let clock = Date.parse('2026-11-28T12:00:00Z');
    const p = new StallProfiler({ dir, now: () => clock, windowMs: 60_000 });
    try {
      p.start();
      clock += 5000; p.onShortStall(clock, 400);
      clock += 60_000; vi.advanceTimersByTime(60_000);   // saved at this rotation
      clock += 2 * 60_000; p.onShortStall(clock, 500);    // three minutes after the first: too soon
      clock += 60_000; vi.advanceTimersByTime(60_000);
      await p.stop();
      const shorts = fs.readdirSync(dir).filter((n) => n.startsWith('short-stall-') && n.endsWith('.cpuprofile'));
      expect(shorts).toHaveLength(1);
      expect(shorts[0]).toMatch(/-400ms\.cpuprofile$/);
    } finally { await p.stop().catch(() => {}); vi.useRealTimers(); }
  });

  it('ignores a short stall that ends right after a rotation (most likely the profiler restart itself)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const dir = tmp();
    let clock = Date.parse('2026-11-28T13:00:00Z');
    const p = new StallProfiler({ dir, now: () => clock, windowMs: 60_000 });
    try {
      p.start();
      clock += 500; p.onShortStall(clock, 150);           // 0.5 s into the window
      clock += 60_000; vi.advanceTimersByTime(60_000);
      await p.stop();
      expect(fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith('short-stall-')) : []).toEqual([]);
    } finally { await p.stop().catch(() => {}); vi.useRealTimers(); }
  });
});

