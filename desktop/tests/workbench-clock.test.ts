// Pins card #178: the workbench's made-up chats are dated TODAY at a fixed local clock time, so a
// picture reads "7:40 AM" (not "Jul 29, 2025") and is the same picture tomorrow.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fixtureBase, rebaseFixtureTimes } from '../src/renderer/dev/workbench/fixtures/clock';
import { formatBubbleTime } from '../src/renderer/utils/format-time';

const WORKBENCH = join(__dirname, '../src/renderer/dev/workbench');
const realTZ = process.env.TZ;
afterEach(() => {
  vi.useRealTimers();
  if (realTZ === undefined) delete process.env.TZ; else process.env.TZ = realTZ;
});

// Local-calendar "now" values (month is 0-based): ordinary day, both US daylight-saving change days, year end.
const AFTER_BASE: Array<[string, number[]]> = [
  ['ordinary afternoon', [2026, 10, 10, 15, 0]],
  ['spring-forward day', [2026, 2, 8, 12, 0]],
  ['fall-back day', [2026, 10, 1, 12, 0]],
  ['just after midnight rollover evening', [2026, 11, 31, 23, 59]],
];

describe('workbench fixture clock', () => {
  for (const tz of ['UTC', 'America/New_York', 'Asia/Kolkata']) {
    describe(`in ${tz}`, () => {
      for (const [label, now] of AFTER_BASE) {
        it(`${label}: base is that day at 07:40 local`, () => {
          process.env.TZ = tz;
          const [y, mo, d, h, mi] = now;
          const n = new Date(y, mo, d, h, mi);
          const base = new Date(fixtureBase(n.getTime()));
          expect([base.getFullYear(), base.getMonth(), base.getDate()]).toEqual([y, mo, d]);
          expect([base.getHours(), base.getMinutes(), base.getSeconds()]).toEqual([7, 40, 0]);
          expect(base.getTime()).toBeLessThanOrEqual(n.getTime());
        });
      }

      it('run before 07:40: falls back to YESTERDAY 07:40, never in the future', () => {
        process.env.TZ = tz;
        const n = new Date(2026, 10, 10, 5, 0).getTime();
        const base = new Date(fixtureBase(n));
        expect([base.getMonth(), base.getDate(), base.getHours(), base.getMinutes()]).toEqual([10, 9, 7, 40]);
        expect(base.getTime()).toBeLessThanOrEqual(n);
      });

      it('run just after 07:40 but inside the margin still stays clear of the future', () => {
        process.env.TZ = tz;
        for (const [h, m] of [[7, 40], [7, 55], [8, 9], [8, 10], [8, 11]]) {
          const n = new Date(2026, 10, 10, h, m).getTime();
          // The latest made-up time is base + 348 s (+ 1 s per scripted reply event): all must be in the past.
          expect(fixtureBase(n) + 400_000).toBeLessThanOrEqual(n);
        }
      });

      it('a bubble stamped at the base reads as a clock time, not a date', () => {
        process.env.TZ = tz;
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 10, 10, 15, 0));
        const text = formatBubbleTime(fixtureBase());
        expect(text).toMatch(/^\d{1,2}:40\s?(AM|PM)?$/i);
        expect(text).not.toMatch(/Yesterday|,|Jul|2025/);
      });
    });
  }

  it('relative fixture times (negative numbers) become base + offset; real epochs are untouched', () => {
    const out = rebaseFixtureTimes('{"timestamp":-1000,"startedAt": -5000,"x":-3,"endedAt":42,"r":"{\\"scheduledFor\\":-7}"}', 1_000_000);
    expect(out).toBe('{"timestamp":999000,"startedAt": 995000,"x":-3,"endedAt":42,"r":"{\\"scheduledFor\\":999993}"}');
  });

  it('no file under dev/workbench still hardcodes the old 2025 epoch', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!['.ts', '.tsx', '.js', '.mjs', '.json', '.jsonl', '.html', '.css'].includes(extname(p))) continue;
        if (/\b1_?753_?\d{3}_?\d{3}_?\d{3}\b/.test(readFileSync(p, 'utf8'))) offenders.push(p.slice(WORKBENCH.length + 1));
      }
    };
    walk(WORKBENCH);
    expect(offenders).toEqual([]);
  });
});
