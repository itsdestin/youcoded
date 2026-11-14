// When a scheduled automation is due, and how its times are worded.
import { describe, it, expect } from 'vitest';
import { dueSince, nextDue, wordAsked, wordWhen } from '../src/main/automations/schedule';

// Local times, so the test holds in any timezone. 2026-11-14 is a Saturday.
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();
const show = (t: number) => { const d = new Date(t); return `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

describe('automation schedule', () => {
  it('daily runs at its time today if that is still ahead, otherwise tomorrow', () => {
    expect(show(nextDue({ kind: 'schedule', every: 'day', at: '7:00' }, at(14, 6, 59)))).toBe('14 7:00');
    expect(show(nextDue({ kind: 'schedule', every: 'day', at: '7:00' }, at(14, 7, 0)))).toBe('15 7:00');
  });

  it('weekdays skips Saturday and Sunday', () => {
    expect(show(nextDue({ kind: 'schedule', every: 'weekday', at: '9:00' }, at(13, 10)))).toBe('16 9:00');
  });

  it('weekly runs on its day, next week once this week\'s time has passed', () => {
    const friday = { kind: 'schedule' as const, every: 'week' as const, day: 'Friday', at: '17:00' };
    expect(show(nextDue(friday, at(14, 12)))).toBe('20 17:00');
    expect(show(nextDue(friday, at(13, 16)))).toBe('13 17:00');
    expect(show(nextDue(friday, at(13, 17)))).toBe('20 17:00');
  });

  it('every 3 hours runs on the hour, counted from midnight', () => {
    const three = { kind: 'schedule' as const, every: 'hour' as const, hours: 3 };
    expect(show(nextDue(three, at(14, 13, 20)))).toBe('14 15:00');
    expect(show(nextDue(three, at(14, 22, 5)))).toBe('15 0:00');
    expect(show(nextDue({ kind: 'schedule', every: 'hour' }, at(14, 13, 20)))).toBe('14 14:00');
  });

  it('a time that just passed is due; one that passed a while ago was missed', () => {
    const daily = { kind: 'schedule' as const, every: 'day' as const, at: '7:00' };
    expect(dueSince(daily, at(14, 6, 59, ), at(14, 6, 59) + 30_000)).toEqual({ kind: 'none' });
    expect(dueSince(daily, at(14, 6, 59), at(14, 7, 0))).toEqual({ kind: 'due', dueAt: at(14, 7) });
    expect(dueSince(daily, at(14, 6, 59), at(14, 9, 40))).toEqual({ kind: 'missed', dueAt: at(14, 7) });
  });

  it('several missed times count once, as the most recent', () => {
    const hourly = { kind: 'schedule' as const, every: 'hour' as const };
    expect(dueSince(hourly, at(12, 8, 30), at(14, 9, 40))).toEqual({ kind: 'missed', dueAt: at(14, 9) });
  });

  it('words a time relative to today', () => {
    const now = at(14, 12);
    expect(wordWhen(at(14, 7), now)).toBe('Today at 7:00');
    expect(wordWhen(at(13, 15), now)).toBe('Yesterday at 15:00');
    expect(wordWhen(at(15, 7, 5), now)).toBe('Tomorrow at 7:05');
    expect(wordWhen(at(20, 17), now)).toBe('Friday at 17:00');
    expect(wordWhen(at(3, 7), now)).toBe('Nov 3 at 7:00');
  });

  it('words how long ago a question was asked', () => {
    const now = at(14, 12);
    expect(wordAsked(now - 20_000, now)).toBe('Asked just now');
    expect(wordAsked(now - 12 * 60_000, now)).toBe('Asked 12 min ago');
    expect(wordAsked(now - 2 * 3600_000, now)).toBe('Asked 2 h ago');
    expect(wordAsked(now - 26 * 3600_000, now)).toBe('Asked 1 day ago');
  });
});
