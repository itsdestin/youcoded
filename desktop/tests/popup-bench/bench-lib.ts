// Replay + scoring for the pop-up detector bench (tests/popup-detector-bench.test.ts).
// Kept apart from the test file so debugging helpers can import it without
// re-registering the bench's tests.
import { Terminal } from '@xterm/headless';
import { registerTerminal, unregisterTerminal, getVisibleScreenText } from '../../src/renderer/hooks/terminal-registry';
import type { Candidate } from './candidates';

export const FALSE_ALARM_MS = 300;
export const GAP_MS = 100;

export type State = 'none' | 'popup' | 'modal' | 'pending';
interface Mark { t: number; label: string; chunkIndex: number; data?: any }
export interface Fixture { scenario: string; cols: number; rows: number; chunks: { t: number; b64: string }[]; marks: Mark[]; outcome: any; ccVersion: string }
/** A stretch of time with one screen and one truth. A pop-up that just sits
 *  there produces no output — so time, not output, is what gets scored. */
export interface Segment { t: number; ms: number; frame: number; screen: string; state: State; note: string }

export async function replay(fx: Fixture): Promise<Segment[]> {
  // Our own replay terminal (not FixtureTerminal): a capture may resize
  // several times, and every resize must land at its own chunk or later
  // redraws garble. Read through the app's own serializer.
  const id = `popup-bench-${fx.scenario}-${Math.random()}`;
  const term = new Terminal({ cols: fx.cols, rows: fx.rows, allowProposedApi: true, scrollback: 1000 });
  registerTerminal(id, term as never);
  const resizes = fx.marks.filter((m) => m.label.startsWith('resize ')).map((m) => {
    const [cols, rows] = m.label.split(' ')[1].split('x').map(Number);
    return { at: m.chunkIndex, cols, rows };
  });
  const frames: { t: number; screen: string }[] = [];
  try {
    for (let k = 0; k < fx.chunks.length; k++) {
      for (const r of resizes) if (r.at === k) term.resize(r.cols, r.rows);
      await new Promise<void>((res) => term.write(Buffer.from(fx.chunks[k].b64, 'base64'), res));
      frames.push({ t: fx.chunks[k].t, screen: getVisibleScreenText(id) ?? '' });
    }
  } finally { unregisterTerminal(id); term.dispose(); }
  // Truth starts: a mark's own time — or, with `from`, the time of the first
  // frame since the previous mark where Claude Code had drawn it.
  const starts: { t: number; state: State; note: string }[] = [];
  let prevT = 0;
  for (const m of fx.marks.filter((x) => x.label === 'truth')) {
    let t = m.t;
    if (m.data.from) {
      const re = new RegExp(m.data.from, 'm');
      const f = frames.find((fr) => fr.t >= prevT && fr.t <= m.t && re.test(fr.screen));
      if (f) t = f.t;
    }
    starts.push({ t, state: m.data.state, note: m.data.note });
    prevT = t;
  }
  starts.sort((a, b) => a.t - b.t);
  const end = Math.max(frames.at(-1)?.t ?? 0, fx.marks.at(-1)?.t ?? 0) + 1;
  const cuts = [...new Set([...frames.map((f) => f.t), ...starts.map((s) => s.t), end])].sort((a, b) => a - b);
  const segs: Segment[] = [];
  let fi = -1; let si = -1;
  for (let c = 0; c + 1 < cuts.length; c++) {
    const t = cuts[c];
    while (fi + 1 < frames.length && frames[fi + 1].t <= t) fi++;
    while (si + 1 < starts.length && starts[si + 1].t <= t) si++;
    if (fi < 0 || si < 0) continue;
    segs.push({ t, ms: cuts[c + 1] - t, frame: fi, screen: frames[fi].screen, state: starts[si].state, note: starts[si].note });
  }
  return segs;
}

export interface Score {
  popupRegions: number; missed: string[]; gaps: string[]; falseAlarms: string[];
  falseAlarmMs: number; latencies: number[];
}

export function score(fx: Fixture, segs: Segment[], c: Candidate): Score {
  const s: Score = { popupRegions: 0, missed: [], gaps: [], falseAlarms: [], falseAlarmMs: 0, latencies: [] };
  const cache = new Map<number, boolean>();
  const hit = (g: Segment) => { if (!cache.has(g.frame)) cache.set(g.frame, c.blocked(g.screen)); return cache.get(g.frame)!; };
  let a = 0;
  while (a < segs.length) {
    const { state, note } = segs[a];
    let b = a;
    while (b + 1 < segs.length && segs[b + 1].state === state && segs[b + 1].note === note) b++;
    const t0 = segs[a].t;
    // Runs of equal detector output inside this region.
    const runs: { on: boolean; t: number; ms: number }[] = [];
    for (let k = a; k <= b; k++) {
      const on = hit(segs[k]);
      if (runs.length && runs[runs.length - 1].on === on) runs[runs.length - 1].ms += segs[k].ms;
      else runs.push({ on, t: segs[k].t, ms: segs[k].ms });
    }
    if (state === 'none') {
      for (const r of runs) if (r.on && r.ms >= FALSE_ALARM_MS) {
        s.falseAlarms.push(`${fx.scenario} [${note}] +${r.t - t0}ms for ${r.ms}ms`);
        s.falseAlarmMs += r.ms;
      }
    } else if (state === 'popup' || state === 'modal') {
      s.popupRegions++;
      const first = runs.findIndex((r) => r.on);
      if (first < 0) s.missed.push(`${fx.scenario} [${note}] (${runs.reduce((x, r) => x + r.ms, 0)}ms)`);
      else {
        s.latencies.push(runs[first].t - t0);
        for (const r of runs.slice(first + 1)) if (!r.on && r.ms >= GAP_MS) s.gaps.push(`${fx.scenario} [${note}] +${r.t - t0}ms for ${r.ms}ms`);
      }
    }
    a = b + 1;
  }
  return s;
}

