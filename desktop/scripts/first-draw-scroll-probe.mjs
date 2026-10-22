#!/usr/bin/env node
// first-draw-scroll-probe — proves a long conversation opened with the "first draw" plan
// (src/renderer/state/first-draw-plan.ts) neither jumps nor pops in, in REAL layout.
//
// WHY a probe and not a vitest test: scroll stability is layout. jsdom has no layout, so a test
// there could only assert the plan's arithmetic. This drives the UI Workbench in headless Chrome
// through scripts/ui-probe.mjs (the repo's own page-probe) over `?seed=long-<N>` (a deterministic
// long, uneven transcript - dev/workbench/seed-chat.ts `longConversation`).
//
//   bash scripts/run-workbench.sh <worktree>          # note the port it prints
//   node desktop/scripts/first-draw-scroll-probe.mjs http://127.0.0.1:<port> [--turns 60] [--json]
//
// What it measures (all in paint frames, via requestAnimationFrame):
//   1. OPEN: the newest message stays pinned to the bottom edge for 2 s after the tab opens
//      (gap between the scroller's end and the viewport never moves more than 1 px) and
//      only the newest entries are drawn (spacers stand in for the rest).
//   2. SCROLL UP, 400 px at a time to the very top, waiting ~0.8 s each step (long enough for
//      the 100 ms unfold debounce and every spacer-to-body swap): the entry in the middle of the
//      window must not move on screen (<= 1 px), and no spacer may ever sit inside the visible window.
//   3. At the top, everything within 1,000 px of the window has its body.
// Exit 1 when any bound fails. It also prints the numbers.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:/.test(a));
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
if (!base) { console.error('usage: first-draw-scroll-probe.mjs http://127.0.0.1:<workbench port> [--turns 60] [--json]'); process.exit(2); }
const turns = Number(flag('--turns', 60));
const probe = flag('--probe', resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/ui-probe.mjs'));

// Runs INSIDE the page (the workbench frames the app in an <iframe>).
const inPage = `(async () => {
  const d = document.querySelector('iframe').contentDocument;
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const entriesOf = (s) => [...s.querySelectorAll('.timeline-entry')];
  const isSpacer = (e) => !e.firstElementChild;
  // 1. OPEN the long conversation's tab and watch its bottom for 2 s.
  const t0 = performance.now();
  d.querySelector('[data-session-strip] [data-session-id="wb-2"]').click();
  let s = null;
  while (!s && performance.now() - t0 < 10000) { await raf(); s = d.querySelector('[data-chat-session-id="wb-2"] .chat-scroll'); if (s && !entriesOf(s).length) s = null; }
  if (!s) return JSON.stringify({ error: 'the long conversation never appeared' });
  const out = { open: { clickToFirstFrameMs: Math.round(performance.now() - t0) }, up: [], end: {} };
  const gap = () => s.scrollHeight - s.scrollTop - s.clientHeight;
  const all0 = entriesOf(s);
  out.open.entries = all0.length;
  out.open.drawnAtFirstFrame = all0.filter((e) => !isSpacer(e)).length;
  let maxGapMove = 0; const g0 = gap(); const tOpen = performance.now();
  while (performance.now() - tOpen < 2000) { await raf(); maxGapMove = Math.max(maxGapMove, Math.abs(gap() - g0)); }
  out.open.startGap = Math.round(g0 * 10) / 10; out.open.maxGapMovePx = Math.round(maxGapMove * 10) / 10;
  out.open.drawnAfter2s = entriesOf(s).filter((e) => !isSpacer(e)).length;
  // 1b. A FAST FLICK up (250 px every frame, about 15,000 px/s - a hard wheel fling), no waiting: the harshest
  // case for entries that must be drawn before they come into view. Counts frames with a blank spacer in view.
  const visibleSpacersNow = () => { const r = s.getBoundingClientRect(); return entriesOf(s).filter((e) => { const b = e.getBoundingClientRect(); return isSpacer(e) && b.bottom > r.top && b.top < r.bottom; }).length; };
  let flickSpacerFrames = 0, flickFrames = 0;
  for (let i = 0; i < 16; i++) {
    s.dispatchEvent(new WheelEvent('wheel', { deltaY: -250, bubbles: true }));
    s.scrollTop = Math.max(0, s.scrollTop - 250);
    await raf(); flickFrames++;
    if (visibleSpacersNow() > 0) flickSpacerFrames++;
  }
  await wait(1200);
  out.open.flickFrames = flickFrames; out.open.flickFramesWithSpacerInView = flickSpacerFrames;
  // 2. SCROLL UP to the top in 400 px steps.
  const visibleSpacers = () => { const r = s.getBoundingClientRect(); return entriesOf(s).filter((e) => { const b = e.getBoundingClientRect(); return isSpacer(e) && b.bottom > r.top && b.top < r.bottom; }).length; };
  let guard = 0;
  while (s.scrollTop > 0 && guard++ < 400) {
    // The chat un-pins on WHEEL INTENT (use-stick-to-bottom.ts), so announce it as a real wheel would, then move.
    s.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
    s.scrollTop = Math.max(0, s.scrollTop - 400);
    const r = s.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    const ref = entriesOf(s).find((e) => { const b = e.getBoundingClientRect(); return b.top <= mid && b.bottom >= mid && !isSpacer(e); }) || entriesOf(s).find((e) => { const b = e.getBoundingClientRect(); return b.top <= mid && b.bottom >= mid; });
    const key = ref && ref.dataset.entryKey;
    const top0 = ref ? ref.getBoundingClientRect().top : 0;
    let drift = 0, spacerFrames = 0; const ts = performance.now();
    while (performance.now() - ts < 800) {
      await raf();
      const cur = key && s.querySelector('[data-entry-key="' + CSS.escape(key) + '"]');
      if (cur) drift = Math.max(drift, Math.abs(cur.getBoundingClientRect().top - top0));
      if (visibleSpacers() > 0) spacerFrames++;
    }
    out.up.push({ scrollTop: Math.round(s.scrollTop), driftPx: Math.round(drift * 10) / 10, framesWithSpacerInView: spacerFrames });
  }
  await wait(1500);
  const fin = entriesOf(s);
  const rr = s.getBoundingClientRect();
  out.end.entries = fin.length;
  // Entries far below are rightly still spacers; the ones within the 1,000 px around the window must be drawn.
  out.end.spacersLeftNearTop = fin.filter((e) => { const b = e.getBoundingClientRect(); return isSpacer(e) && b.bottom > rr.top - 1000 && b.top < rr.bottom + 1000; }).length;
  return JSON.stringify(out);
})()`;

const run = spawnSync('node', [probe, `${base}/?mode=workbench&seed=long-${turns}&latency=0`, '--size', '1400x900',
  '--wait', "!!document.querySelector('iframe')?.contentDocument?.querySelector('[data-session-strip] [data-session-id=\"wb-2\"]')",
  '--eval', inPage, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (run.status !== 0) { console.error(run.stdout, run.stderr); process.exit(1); }
const parsed = JSON.parse(run.stdout);
const ev = parsed.results?.[0]?.evals?.[0];
let result;
try { if (ev?.error) throw new Error(ev.error); result = JSON.parse(ev.value); } catch { console.error('unreadable probe output:', run.stdout.slice(0, 2000)); process.exit(1); }
if (result.error) { console.error(result.error); process.exit(1); }

const worstDrift = Math.max(0, ...result.up.map((u) => u.driftPx));
const spacerFrames = result.up.reduce((n, u) => n + u.framesWithSpacerInView, 0);
const failures = [];
if (result.open.drawnAtFirstFrame >= result.open.entries * 0.5) failures.push(`drew ${result.open.drawnAtFirstFrame} of ${result.open.entries} entries at first frame (expected only the newest screens)`);
if (result.open.flickFramesWithSpacerInView > 0) failures.push(`${result.open.flickFramesWithSpacerInView} of ${result.open.flickFrames} flick frames showed a blank spacer in view`);
if (result.open.maxGapMovePx > 1) failures.push(`bottom moved ${result.open.maxGapMovePx}px after open`);
if (worstDrift > 1) failures.push(`scroll-up drift ${worstDrift}px`);
if (spacerFrames > 0) failures.push(`${spacerFrames} frames showed a blank spacer inside the visible window while scrolling up`);
if (result.end.spacersLeftNearTop > 0) failures.push(`${result.end.spacersLeftNearTop} entries within 1,000 px of the window are still spacers after reaching the top`);
const report = { turns, ...result.open, scrollUpSteps: result.up.length, worstDriftPx: worstDrift, framesWithSpacerInView: spacerFrames, ...result.end, failures };
console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : Object.entries(report).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') || 'none' : v}`).join('\n'));
process.exit(failures.length ? 1 : 0);
