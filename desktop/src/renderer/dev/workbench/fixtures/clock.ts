// The ONE clock the workbench's made-up chats are dated from (card #178).
//
// WHY not Date.now(): fixtures must replay identically, and a moving clock makes bubble grouping and
// screenshots differ run to run. WHY not a fixed 2025 date (what every file used to copy): since message
// times name the day (formatBubbleTime), every picture then read "Jul 29, 2025" under each bubble instead of
// a time like "7:40 AM". So the base is TODAY at a fixed LOCAL clock time: bubbles read "7:40 AM" (the
// formatter shows a clock time for anything dated today), and a picture taken tomorrow is the same picture.
//
// Built from local calendar fields (not "midnight + N hours"), so a daylight-saving day is still 07:40 on the
// wall clock. Because the label uses the local zone, a laptop and a CI box in different zones both print
// "7:40 AM" — the epoch value differs by zone, the pixels do not.
//
// Offsets: fixtures place things BEFORE the base (up to ~14 h, the session list's older rows) and a few
// seconds/minutes AFTER it (the last scripted subagent step, reply-script's one-second stamps). 07:40 puts
// the oldest row at ~17:45 the previous evening, which reads "Yesterday at 5:45 PM" — a plausible spread
// that keeps the original relative gaps (and so the original ordering) intact.
//
// Early-morning rule: if the tools run before the base (plus a margin for the "after" offsets), the base
// would be in the FUTURE, and anything measured against the real clock ("just now", "5m ago") would read
// oddly. So the base falls back to YESTERDAY's 07:40. Such a run's pictures show "Yesterday at 7:40 AM"
// instead of "7:40 AM"; that is the accepted cost of never showing a time that has not happened yet.

const BASE_HOUR = 7;
const BASE_MINUTE = 40;
/** Room for the offsets that land after the base (largest fixture offset is +348 s; reply-script adds 1 s per event). */
const FUTURE_MARGIN_MS = 10 * 60_000;

/** The shared base for a given "now": that local day at 07:40, or the day before if that is not safely past. */
export function fixtureBase(now: number = Date.now()): number {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), BASE_HOUR, BASE_MINUTE).getTime();
  if (today + FUTURE_MARGIN_MS <= now) return today;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, BASE_HOUR, BASE_MINUTE).getTime();
}

/** Fixed for the page's life: every consumer reads the same value even if the page stays open past midnight. */
export const FIXTURE_BASE = fixtureBase();

/** The base shifted by `offsetMs` (negative = earlier). */
export const at = (offsetMs: number): number => FIXTURE_BASE + offsetMs;

// Fixture .jsonl files cannot import this, so a time there is written as a NEGATIVE number: milliseconds
// relative to the base (e.g. "startedAt":-4999000). Real epoch times are never negative, so the sign is the
// marker; only these time-bearing keys are touched. The pattern also matches inside an escaped JSON string
// (`\"scheduledFor\":-4700000` in a tool result), which is why it tolerates a backslash before the quote.
const RELATIVE_TIME = /("(?:timestamp|startedAt|endedAt|at|scheduledFor)\\?":\s*)(-\d+)/g;

/** Turn the base-relative negative times in one fixture line into real epoch milliseconds. */
export function rebaseFixtureTimes(text: string, base: number = FIXTURE_BASE): string {
  return text.replace(RELATIVE_TIME, (_m, key: string, rel: string) => `${key}${base + Number(rel)}`);
}
