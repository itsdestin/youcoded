// Startup timing marks for the perf lab (docs/active/specs/2026-08-23-perf-lab-*.md).
// WHY: the app had zero startup instrumentation, so nobody could say which boot
// chore was slow. Marks are written ONLY when YOUCODED_PERF_LOG names a file —
// in normal use this module costs one env read and nothing else.
// Sync append on purpose: a mark must survive a crash a millisecond later, and
// ~20 tiny writes per boot are far below anything a user could feel.
import fs from 'fs';

const PERF_LOG = process.env.YOUCODED_PERF_LOG || '';

// `detail` (optional) rides along on the line — e.g. how many conversations a
// Resume scan read. WHY: background work that repeats (a scan per Resume open)
// needs a count beside its time to be comparable across machines and runs.
// WHY (hitch recorder, 2026-10-05): the startup line of the always-on hitch recorder
// (hitch-recorder.ts) needs the boot marks in normal use too, not only under the rig.
// They are kept in memory — a tiny array, no I/O — and only the first MAX_KEPT marks
// are retained, so repeating marks (the bg:* scans fire per Resume open) cannot grow it.
const MAX_KEPT = 120;
const kept: Array<{ name: string; t: number }> = [];

/** The marks recorded so far this launch (name + epoch ms), oldest first. A copy. */
export function getPerfMarks(): Array<{ name: string; t: number }> { return kept.slice(); }

export function perfMark(name: string, detail?: Record<string, unknown>): void {
  if (kept.length < MAX_KEPT) kept.push({ name, t: Date.now() });
  if (!PERF_LOG) return;
  try {
    fs.appendFileSync(PERF_LOG, JSON.stringify({ ...detail, name, t: Date.now(), pid: process.pid }) + '\n');
  } catch { /* never let instrumentation break boot */ }
}
