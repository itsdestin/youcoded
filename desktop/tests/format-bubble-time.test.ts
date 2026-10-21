import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { formatBubbleTime } from '../src/renderer/utils/format-time';

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// The streaming bubble formats its timestamp on every redraw (60+/s while a reply streams). Building an Intl
// formatter per call was ~1.5% of the window's time in the CPU profile (2026-10-04, perf fix 5).
describe('formatBubbleTime', () => {
  let tz: string | undefined;
  // Local noon on 2026-10-21 in New York (set once the zone is).
  let NOW = 0;
  beforeEach(() => {
    tz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    NOW = new Date(2026, 9, 21, 12, 0).getTime();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  });

  it('shows only the time for a message from today', () => {
    vi.setSystemTime(NOW);
    for (const ms of [new Date(2026, 9, 21, 0, 0).getTime(), new Date(2026, 9, 21, 9, 5).getTime(), NOW]) {
      expect(formatBubbleTime(ms)).toBe(clock(ms));
    }
  });

  it('shows "Yesterday at" and the time for a message from yesterday', () => {
    vi.setSystemTime(NOW + 3_600_000);
    const ms = new Date(2026, 9, 20, 23, 59).getTime();
    expect(formatBubbleTime(ms)).toBe(`Yesterday at ${clock(ms)}`);
    expect(formatBubbleTime(new Date(2026, 9, 20, 0, 0).getTime())).toMatch(/^Yesterday at /);
  });

  it('shows only the date for anything older, with the year only when it is not this year', () => {
    vi.setSystemTime(NOW + 7_200_000);
    const lastWeek = new Date(2026, 9, 13, 15, 0).getTime();
    expect(formatBubbleTime(lastWeek)).toBe(new Date(lastWeek).toLocaleDateString([], { month: 'short', day: 'numeric' }));
    const lastYear = new Date(2025, 2, 3, 15, 0).getTime();
    expect(formatBubbleTime(lastYear)).toBe(new Date(lastYear).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }));
    expect(formatBubbleTime(new Date(2026, 9, 19, 23, 59).getTime())).not.toMatch(/Yesterday/);
  });

  it('moves a message to "Yesterday" once midnight passes', () => {
    const ms = new Date(2026, 10, 1, 23, 50).getTime();
    vi.setSystemTime(new Date(2026, 10, 1, 23, 55));
    expect(formatBubbleTime(ms)).toBe(clock(ms));
    vi.setSystemTime(new Date(2026, 10, 2, 0, 1)); // over a minute later: "today" is re-read
    expect(formatBubbleTime(ms)).toBe(`Yesterday at ${clock(ms)}`);
  });

  it('builds the formatters once, not once per call', () => {
    vi.setSystemTime(NOW + 10_800_000);
    formatBubbleTime(NOW);
    const made = vi.spyOn(Intl, 'DateTimeFormat');
    const spy = vi.spyOn(Date.prototype, 'toLocaleTimeString');
    for (let i = 0; i < 200; i++) formatBubbleTime(NOW - i * 3_600_000); // today, yesterday and older
    expect(spy).not.toHaveBeenCalled();
    expect(made).not.toHaveBeenCalled();
  });

  it('follows a system time-zone change made while the app is running', () => {
    vi.setSystemTime(NOW + 14_400_000);
    const ms = NOW;
    process.env.TZ = 'UTC';
    vi.advanceTimersByTime(61_000);
    const utc = formatBubbleTime(ms);
    process.env.TZ = 'Asia/Tokyo';
    vi.advanceTimersByTime(61_000); // the zone is re-checked once a minute, not on every call
    const tokyo = formatBubbleTime(ms);
    expect(tokyo).toBe(clock(ms));
    expect(tokyo).not.toBe(utc);
  });

  it('a day with a daylight-saving change keeps ONE formatter and shows each message in its own offset', () => {
    // 2025-11-02 in New York: clocks went back at 2 AM. Both messages are "today".
    vi.setSystemTime(new Date(2025, 10, 2, 12, 0));
    formatBubbleTime(Date.now()); // settle the zone check first
    const made = vi.spyOn(Intl, 'DateTimeFormat');
    const beforeChange = Date.UTC(2025, 10, 2, 5, 30), afterChange = Date.UTC(2025, 10, 2, 8, 0);
    for (let i = 0; i < 20; i++) {
      for (const ms of [beforeChange, afterChange]) expect(formatBubbleTime(ms)).toBe(clock(ms));
    }
    expect(clock(beforeChange)).toMatch(/^1:30/);
    expect(clock(afterChange)).toMatch(/^3:00/);
    expect(made).not.toHaveBeenCalled();
    // a real zone change is still noticed, with exactly one rebuild of each formatter
    process.env.TZ = 'Asia/Tokyo';
    vi.advanceTimersByTime(61_000);
    formatBubbleTime(beforeChange); formatBubbleTime(afterChange); formatBubbleTime(beforeChange);
    expect(made).toHaveBeenCalledTimes(3);
  });

  it('does not throw on a bad timestamp', () => {
    expect(() => formatBubbleTime(NaN)).not.toThrow();
  });
});
