// Hand-rolled clock/day formatting for reset times. Shared between main and
// renderer; keep free of Node/Electron/browser-only imports.
//
// WHY hand-rolled instead of `toLocaleTimeString`: that call follows the
// computer's locale, so a UK, German or Japanese machine prints "18:43" where
// a US one prints "6:43 PM". The status bar chip has always used the fixed
// 12-hour form below; the ChatGPT limit card used to use the locale call, so
// on a non-US machine the card would have said "(Resets @ 18:43)" beside a
// chip saying "6:43pm" (review of T1, 2026-09-05). Both now format here, so
// they cannot drift.

/** "6:43pm" — the status bar's reset format. */
export function formatTime12(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, '0')}${ampm}`;
}

/** Full day names. Used by BOTH the status bar's 7-day chip and the ChatGPT
 *  limit card, so the two read identically side by side — the three-letter
 *  variant was removed on 2026-09-05 when Destin chose the long form. */
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function formatDayLong(d: Date): string {
  return DAY_NAMES[d.getDay()];
}

/** "Oct 3" — for a reset more than a week away, where a weekday alone is ambiguous. */
export const MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatMonthDay(d: Date): string {
  return `${MONTH_NAMES_SHORT[d.getMonth()]} ${d.getDate()}`;
}
