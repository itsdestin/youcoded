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

  it('does not throw on a bad timestamp', () => {
    expect(() => formatBubbleTime(NaN)).not.toThrow();
  });
});
