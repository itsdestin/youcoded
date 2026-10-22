/**
 * Format an epoch-ms timestamp for a chat bubble: "2:34 PM" today, "Yesterday at 2:34 PM" yesterday, and
 * just the date before that ("Oct 3", with the year when it is not this year: "Oct 3, 2025").
 *
 * WHY the day (Destin, 2026-10-21): a reopened chat from last week read "2:34 PM" exactly like a message
 * sent a minute ago. Days are the computer's local calendar days, so "Yesterday" means before midnight.
 */
export function formatBubbleTime(timestamp: number): string {
  // WHY a cached formatter (2026-10-04, perf fix 5): toLocaleTimeString builds a brand-new Intl formatter on
  // EVERY call, and the streaming bubble calls this on every redraw (60+ a second while a reply streams). The
  // CPU profile put it at ~1.5% of the whole window's time. Same output as
  // toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }): same locale list, same options.
  // A bad timestamp keeps the old path: Intl's format() throws on an invalid date where toLocaleTimeString
  // returns "Invalid Date".
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // WHY the zone check, and why on NOW (not on the message's own date): an Intl formatter fixes the time zone when
  // it is built, while toLocaleTimeString re-read it on every call, so a system zone change (travel, a laptop
  // waking elsewhere) would otherwise keep the old zone until restart. The formatter already knows a zone's
  // historical offsets, so a message on either side of a daylight-saving change is shown correctly by one
  // formatter; only a change of ZONE needs a rebuild. (abs(): a clock set backwards also re-checks.) Comparing each message's own offset rebuilt it every time two
  // neighbouring messages straddled the change. The current offset is re-read at most once a minute.
  const now = Date.now();
  if (!bubbleTimeFormat || Math.abs(now - bubbleTimeCheckedAt) >= 60_000) {
    bubbleTimeCheckedAt = now;
    const today = new Date(now);
    const offset = today.getTimezoneOffset();
    if (!bubbleTimeFormat || offset !== bubbleTimeOffset) {
      bubbleTimeFormat = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
      bubbleDateFormat = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' });
      bubbleDateYearFormat = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', year: 'numeric' });
      bubbleTimeOffset = offset;
    }
    // WHY re-read on the same once-a-minute check: past midnight, "today" moves within a minute.
    // Built from calendar fields (not now minus 24 h) so a daylight-saving day is still one day.
    todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    yesterdayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime();
    thisYear = today.getFullYear();
  }
  const time = bubbleTimeFormat.format(d);
  // A time a little ahead of this computer's clock (another device's) still reads as today.
  if (timestamp >= todayStart) return time;
  if (timestamp >= yesterdayStart) return `Yesterday at ${time}`;
  return (d.getFullYear() === thisYear ? bubbleDateFormat! : bubbleDateYearFormat!).format(d);
}
let bubbleTimeFormat: Intl.DateTimeFormat | null = null;
let bubbleDateFormat: Intl.DateTimeFormat | null = null;
let bubbleDateYearFormat: Intl.DateTimeFormat | null = null;
let bubbleTimeOffset = NaN;
let bubbleTimeCheckedAt = 0;
let todayStart = 0;
let yesterdayStart = 0;
let thisYear = 0;

/**
 * Compact relative-time label ("just now", "5m ago", "3h ago", "2d ago", then
 * a locale date). Accepts epoch-ms OR an ISO string — the artifact sidecar
 * stores ISO while session lists carry epoch, and this was previously
 * re-implemented five times with three different signatures.
 */
export function formatRelativeTime(when: number | string): string {
  const ms = typeof when === 'number' ? when : Date.parse(when);
  if (!when || Number.isNaN(ms)) return '';
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}
