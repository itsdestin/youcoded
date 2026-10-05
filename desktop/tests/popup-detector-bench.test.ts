// Pop-up detector bench — replays every capture in tests/fixtures/popup-corpus/
// (recorded from the real `claude` by test-conpty/capture-popup-corpus.mjs)
// chunk by chunk through a headless xterm and the app's own screen reader,
// and scores each candidate detector against the recorded ground truth.
//
// WHY: a pop-up the app misses swallows the user's chat message (and the
// lost-message Enter can answer it); a pop-up the app imagines refuses a send
// or shows a card for nothing. Both are scored the way a user would notice:
//   • missed pop-up   — a pop-up region the detector never settled on;
//   • gap             — a moment (≥ GAP_MS) inside a pop-up the detector let go;
//   • false alarm     — a moment (≥ FALSE_ALARM_MS) with no pop-up where it fired;
//   • latency         — how long after the pop-up was drawn it was noticed.
// POPUP_CORPUS_DIR in the environment points at a fresh capture instead.
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterAll } from 'vitest';
import { CANDIDATES } from './popup-bench/candidates';
import { replay, score, type Fixture, type Score } from './popup-bench/bench-lib';

const DIR = process.env.POPUP_CORPUS_DIR || path.join(__dirname, 'fixtures', 'popup-corpus');
/** The candidate the app ships — must be perfect on the corpus. */
const SHIPPED = process.env.POPUP_BENCH_REQUIRE ?? 'shipped';

const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((x) => x.endsWith('.json')).sort() : [];
const totals = new Map<string, Score>(CANDIDATES.map((c) => [c.name, { popupRegions: 0, missed: [], gaps: [], falseAlarms: [], falseAlarmMs: 0, latencies: [] }]));

describe('pop-up detector bench', () => {
  it('has a corpus to score', () => { expect(files.length).toBeGreaterThan(0); });

  for (const file of files) {
    it(`scores ${file}`, async () => {
      const fx: Fixture = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
      expect(fx.outcome.error ?? null, `capture failed: ${fx.outcome.error}`).toBeNull();
      const segs = await replay(fx);
      for (const c of CANDIDATES) {
        const s = score(fx, segs, c);
        const t = totals.get(c.name)!;
        t.popupRegions += s.popupRegions; t.missed.push(...s.missed); t.gaps.push(...s.gaps);
        t.falseAlarms.push(...s.falseAlarms); t.falseAlarmMs += s.falseAlarmMs; t.latencies.push(...s.latencies);
        if (c.name === SHIPPED) {
          expect(s.missed, 'missed pop-ups').toEqual([]);
          expect(s.falseAlarms, 'false alarms').toEqual([]);
          expect(s.gaps, 'gaps inside a pop-up').toEqual([]);
        }
      }
    }, 120_000);
  }

  afterAll(() => {
    const lines = ['', `POP-UP DETECTOR BENCH — ${files.length} captures`, ''];
    lines.push('candidate        missed        gaps  false-alarms (ms)   median/max latency');
    for (const c of CANDIDATES) {
      const t = totals.get(c.name)!;
      const lat = [...t.latencies].sort((a, b) => a - b);
      const med = lat.length ? lat[Math.floor(lat.length / 2)] : NaN;
      lines.push(`${c.name.padEnd(16)} ${`${t.missed.length}/${t.popupRegions}`.padEnd(13)} ${String(t.gaps.length).padEnd(5)} ${`${t.falseAlarms.length} (${t.falseAlarmMs})`.padEnd(19)} ${med}/${lat.at(-1) ?? NaN}`);
    }
    for (const c of CANDIDATES) {
      const t = totals.get(c.name)!;
      if (!t.missed.length && !t.gaps.length && !t.falseAlarms.length) continue;
      lines.push('', `— ${c.name}`);
      for (const m of t.missed) lines.push(`   MISSED  ${m}`);
      for (const m of t.gaps) lines.push(`   GAP     ${m}`);
      for (const m of t.falseAlarms) lines.push(`   FALSE   ${m}`);
    }
    const out = lines.join('\n');
    if (process.env.POPUP_BENCH_REPORT) fs.writeFileSync(process.env.POPUP_BENCH_REPORT, out);
    console.log(out);
  });
});
