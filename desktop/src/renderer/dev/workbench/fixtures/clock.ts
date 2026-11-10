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
// "Now" (follow-up, same card): every relative label ("19m ago"), day label ("Yesterday") and load-anchored
// time ("7:57 AM" under a running helper) is measured against the page's clock, so a picture taken at 03:00
// differed from one taken at 15:00. The workbench therefore shows a clock that, at page load, always reads
// 08:00 local today (clock-shim.ts installs it; it keeps ticking). 08:00 is after every made-up time, so
// nothing is ever in the future AND no early-morning fallback is needed: the base is simply today 07:40.

const BASE_HOUR = 7;
const BASE_MINUTE = 40;
const NOW_HOUR = 8;
const NOW_MINUTE = 0;

/** The shared base for a given real "now": that local day at 07:40. */
export function fixtureBase(now: number = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), BASE_HOUR, BASE_MINUTE).getTime();
}

/** What the workbench's clock reads at page load for a given real "now": that local day at 08:00. */
export function fixtureNow(now: number = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), NOW_HOUR, NOW_MINUTE).getTime();
}

/** Fixed for the page's life: every consumer reads the same value even if the page stays open past midnight.
 *  The PURE mark lets a production bundle (which never installs the clock) drop this call. */
export const FIXTURE_BASE = /* @__PURE__ */ fixtureBase();

/** The base shifted by `offsetMs` (negative = earlier). */
export const at = (offsetMs: number): number => FIXTURE_BASE + offsetMs;

// Fixture .jsonl files cannot import this, so a time there is written as an OFFSET in milliseconds from the
// base, negative = before it ("startedAt":-4999000), positive = after it ("timestamp": 300000). A real epoch is
// ~1.7e12, so any number under these time-bearing keys whose size is far below that (OFFSET_LIMIT) is an offset and
// anything bigger passes through untouched. (First version recognised only negatives, so the two "+5 min" helper
// stamps in claude-code.jsonl came out as 1970.) The pattern also matches inside an escaped JSON string
// (`\"scheduledFor\":-4700000` in a tool result), which is why it tolerates a backslash before the quote.
const OFFSET_LIMIT = 1e11;
const RELATIVE_TIME = /("(?:timestamp|startedAt|endedAt|at|scheduledFor)\\?":\s*)(-?\d+)/g;

/** Turn the base-relative offsets in one fixture line into real epoch milliseconds. */
export function rebaseFixtureTimes(text: string, base: number = FIXTURE_BASE): string {
  return text.replace(RELATIVE_TIME, (whole: string, key: string, num: string) =>
    Math.abs(Number(num)) < OFFSET_LIMIT ? `${key}${base + Number(num)}` : whole);
}
