// schedule.ts — when a scheduled automation is due, and how a time is worded on the screens (finishing
// Pages, step 4; build plan decision 6). Pure: every function takes the time it should reason about, so a
// test can stand at any moment without touching the clock.
//
// All times are this device's local time: "Daily at 7:00" means 7:00 where the computer is, including
// across a daylight-saving change (the Date built from year/month/day/hour does that for us).
import type { AutomationStart } from '../../shared/automation-types';

type Schedule = Extract<AutomationStart, { kind: 'schedule' }>;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "7:00" / "17:30" → hours and minutes; anything unreadable is 9:00, the screen's own starting value. */
function clock(at: string | undefined): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at ?? '');
  if (!m) return { h: 9, m: 0 };
  const h = Number(m[1]), min = Number(m[2]);
  return h < 24 && min < 60 ? { h, m: min } : { h: 9, m: 0 };
}

/** The first time strictly after `after` that this schedule is due. */
export function nextDue(start: Schedule, after: number): number {
  const from = new Date(after);
  if (start.every === 'hour') {
    // WHY on the hour, counted from midnight: "Every 3 hours" then means 0:00, 3:00, 6:00… every day, a time
    // the person can predict, instead of drifting with whenever the app happened to be opened.
    const step = Math.max(1, Math.floor(start.hours ?? 1));
    const t = new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), 0, 0, 0);
    do { t.setHours(t.getHours() + 1); } while (t.getHours() % step !== 0 || t.getTime() <= after);
    return t.getTime();
  }
  const { h, m } = clock(start.at);
  const wantDay = start.every === 'week' ? Math.max(0, DAYS.indexOf(start.day ?? 'Monday')) : -1;
  // At most eight days ahead covers every case (a weekly run whose time today has just passed).
  for (let add = 0; add <= 8; add++) {
    const t = new Date(from.getFullYear(), from.getMonth(), from.getDate() + add, h, m, 0, 0);
    if (t.getTime() <= after) continue;
    const dow = t.getDay();
    if (start.every === 'weekday' && (dow === 0 || dow === 6)) continue;
    if (start.every === 'week' && dow !== wantDay) continue;
    return t.getTime();
  }
  return after + 24 * 3600_000; // unreachable; keeps the type honest
}

/** How late a run may start and still count as on time (a due check happens every 30 seconds). */
const ON_TIME_MS = 5 * 60_000;

/** What the due check found for one schedule since it last looked.
 *  - 'none'   nothing came due
 *  - 'due'    a time came due just now
 *  - 'missed' its time passed a while ago (the app was closed or the computer asleep). Several missed
 *             times count once (plan decision 6); `dueAt` is the most recent one. */
export function dueSince(start: Schedule, lastChecked: number, now: number): { kind: 'none' } | { kind: 'due' | 'missed'; dueAt: number } {
  let dueAt = nextDue(start, lastChecked);
  if (dueAt > now) return { kind: 'none' };
  // Walk to the latest due time that has already passed. Bounded: an hourly job missed for a month is ~720 steps.
  for (let guard = 0; guard < 5000; guard++) {
    const later = nextDue(start, dueAt);
    if (later > now) break;
    dueAt = later;
  }
  return { kind: now - dueAt <= ON_TIME_MS ? 'due' : 'missed', dueAt };
}

const two = (n: number): string => String(n).padStart(2, '0');
const startOfDay = (t: number): number => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Today at 7:00", "Yesterday at 15:00", "Tomorrow at 7:00", "Friday at 17:00", "Nov 3 at 7:00". */
export function wordWhen(at: number, now: number): string {
  const d = new Date(at);
  const time = `${d.getHours()}:${two(d.getMinutes())}`;
  // WHY rounded: a day with a daylight-saving change is 23 or 25 hours long.
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  if (days === 0) return `Today at ${time}`;
  if (days === -1) return `Yesterday at ${time}`;
  if (days === 1) return `Tomorrow at ${time}`;
  if (Math.abs(days) < 7) return `${DAYS[d.getDay()]} at ${time}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} at ${time}`;
}

/** "Asked just now", "Asked 12 min ago", "Asked 2 h ago", "Asked 3 days ago". */
export function wordAsked(askedAt: number, now: number): string {
  const min = Math.floor((now - askedAt) / 60_000);
  if (min < 1) return 'Asked just now';
  if (min < 60) return `Asked ${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `Asked ${h} h ago`;
  const days = Math.floor(h / 24);
  return `Asked ${days} ${days === 1 ? 'day' : 'days'} ago`;
}
