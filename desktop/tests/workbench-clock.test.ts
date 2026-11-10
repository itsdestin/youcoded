// Pins card #178: the workbench's made-up chats are dated TODAY at a fixed local clock time, so a
// picture reads "7:40 AM" (not "Jul 29, 2025") and is the same picture tomorrow.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fixtureBase, fixtureNow, rebaseFixtureTimes } from '../src/renderer/dev/workbench/fixtures/clock';
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
        });
      }

      it('base and "now at load" are the same local times at any hour, now after every made-up time', () => {
        process.env.TZ = tz;
        for (const [h, m] of [[0, 5], [3, 0], [5, 0], [7, 45], [12, 0], [23, 30]]) {
          const real = new Date(2026, 10, 10, h, m).getTime();
          const base = new Date(fixtureBase(real));
          const now = new Date(fixtureNow(real));
          expect([base.getDate(), base.getHours(), base.getMinutes()]).toEqual([10, 7, 40]);
          expect([now.getDate(), now.getHours(), now.getMinutes()]).toEqual([10, 8, 0]);
          // The latest made-up time is base + 348 s (+ 1 s per scripted reply event).
          expect(fixtureBase(real) + 400_000).toBeLessThanOrEqual(fixtureNow(real));
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

  describe('the workbench clock shim', () => {
    const RealDate = Date;
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
      (globalThis as { Date: DateConstructor }).Date = RealDate;
      vi.resetModules();
    });
    const load = async (realNow: Date, search = '?mode=workbench') => {
      vi.useFakeTimers();
      vi.setSystemTime(realNow);
      vi.stubGlobal('location', { search });
      vi.resetModules();
      await import('../src/renderer/dev/workbench/clock-shim');
    };

    for (const [h, m] of [[3, 0], [8, 0], [15, 30], [23, 30]]) {
      it(`a page loaded at ${h}:${String(m).padStart(2, '0')} starts at 08:00 today and keeps ticking`, async () => {
        await load(new RealDate(2026, 10, 10, h, m));
        const n = new Date();
        expect([n.getDate(), n.getHours(), n.getMinutes()]).toEqual([10, 8, 0]);
        expect(new Date(Date.now()).getHours()).toBe(8);
        vi.advanceTimersByTime(90_000);
        expect(new Date().getMinutes()).toBe(1); // still ticking, from 08:00
        // A date that names its own moment is left alone.
        expect(new Date(2020, 0, 2, 3, 4).getHours()).toBe(3);
        expect(new Date('2020-01-02T03:04:05Z').getTime()).toBe(Date.UTC(2020, 0, 2, 3, 4, 5));
        expect(new Date() instanceof Date).toBe(true);
      });
    }

    it('does nothing outside a workbench page or with ?realClock=1', async () => {
      await load(new RealDate(2026, 10, 10, 3, 0), '');
      expect(new Date().getHours()).toBe(3);
      await load(new RealDate(2026, 10, 10, 3, 0), '?mode=workbench&realClock=1');
      expect(new Date().getHours()).toBe(3);
    });

    it('is the first import of the renderer entry and sits behind the same build-time gate as the workbench boot', () => {
      const entry = readFileSync(join(__dirname, '../src/renderer/index.tsx'), 'utf8');
      const firstImport = entry.split('\n').find((l) => l.startsWith('import '));
      expect(firstImport).toContain('clock-shim');
      const shim = readFileSync(join(WORKBENCH, 'clock-shim.ts'), 'utf8');
      expect(shim).toContain("import.meta.env.DEV || import.meta.env.VITE_WORKBENCH === '1'");
      expect(shim).toContain("q.get('mode') === 'workbench'");
    });
  });

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
