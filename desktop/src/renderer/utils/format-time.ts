/** Format an epoch-ms timestamp as a short time string for chat bubbles (e.g. "2:34 PM"). */
export function formatBubbleTime(timestamp: number): string {
  // WHY a cached formatter (2026-10-04, perf fix 5): toLocaleTimeString builds a brand-new Intl formatter on
  // EVERY call, and the streaming bubble calls this on every redraw (60+ a second while a reply streams). The
  // CPU profile put it at ~1.5% of the whole window's time. Same output as
  // toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }): same locale list, same options.
  // A bad timestamp keeps the old path: Intl's format() throws on an invalid date where toLocaleTimeString
  // returns "Invalid Date".
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // WHY the offset check: an Intl formatter fixes the time zone when it is built, while toLocaleTimeString re-read it
  // on every call, so a system zone change (travel, daylight-saving rule update, a laptop waking elsewhere) would
  // otherwise keep the old zone until restart. getTimezoneOffset() is cheap; any change rebuilds the formatter.
  const offset = d.getTimezoneOffset();
  if (!bubbleTimeFormat || offset !== bubbleTimeOffset) {
    bubbleTimeFormat = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
    bubbleTimeOffset = offset;
  }
  return bubbleTimeFormat.format(d);
}
let bubbleTimeFormat: Intl.DateTimeFormat | null = null;
let bubbleTimeOffset = NaN;

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
