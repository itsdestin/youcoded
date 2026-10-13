import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatBubbleTime } from '../src/renderer/utils/format-time';

// The streaming bubble formats its timestamp on every redraw (60+/s while a reply streams). Building an Intl
// formatter per call was ~1.5% of the window's time in the CPU profile (2026-10-04, perf fix 5).
describe('formatBubbleTime', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gives the same text as toLocaleTimeString for the same options', () => {
    for (const ms of [0, 1_700_000_000_000, 1_735_732_800_000, Date.now()]) {
      expect(formatBubbleTime(ms)).toBe(new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    }
  });

  it('builds the formatter once, not once per call', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleTimeString');
    for (let i = 0; i < 200; i++) formatBubbleTime(1_700_000_000_000 + i * 1000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('follows a system time-zone change made while the app is running', () => {
    const before = process.env.TZ;
    const ms = 1_700_000_000_000;
    vi.useFakeTimers();
    try {
      process.env.TZ = 'UTC';
      const utc = formatBubbleTime(ms);
      process.env.TZ = 'Asia/Tokyo';
      vi.advanceTimersByTime(61_000); // the zone is re-checked once a minute, not on every call
      const tokyo = formatBubbleTime(ms);
      expect(tokyo).toBe(new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
      expect(tokyo).not.toBe(utc);
    } finally {
      vi.useRealTimers();
      if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
    }
  });

  it('a chat spanning a daylight-saving change keeps ONE formatter and shows each message in its own offset', () => {
    const before = process.env.TZ;
    vi.useFakeTimers();
    try {
      process.env.TZ = 'America/New_York';
      vi.advanceTimersByTime(300_000); // a fresh fake clock: move well away from the previous test's last check
      formatBubbleTime(1_700_000_000_000); // settle the zone check first
      const made = vi.spyOn(Intl, 'DateTimeFormat');
      const summer = Date.UTC(2025, 6, 1, 16, 0), winter = Date.UTC(2025, 0, 1, 16, 0);
      for (let i = 0; i < 20; i++) {
        for (const ms of [summer, winter]) {
          expect(formatBubbleTime(ms)).toBe(new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
        }
      }
      expect(made).not.toHaveBeenCalled();
      // a real zone change is still noticed, with exactly one rebuild
      process.env.TZ = 'Asia/Tokyo';
      vi.advanceTimersByTime(61_000);
      formatBubbleTime(summer); formatBubbleTime(winter); formatBubbleTime(summer);
      expect(made).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
    }
  });

  it('does not throw on a bad timestamp', () => {
    expect(() => formatBubbleTime(NaN)).not.toThrow();
  });
});
