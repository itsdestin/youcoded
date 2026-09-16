/**
 * The caption channel — how the app tells KWin where to put a buddy window.
 *
 * WHY THIS EXISTS AT ALL (the whole reason the Linux buddy is broken today):
 * on native Wayland an app is NOT allowed to position its own windows. It can
 * ask, and the compositor silently ignores it — `setPosition` does nothing and
 * `getPosition` cheerfully echoes back the number you asked for, so nothing in
 * the app can even tell it failed. The buddy appears wherever KWin drops him
 * and cannot be dragged.
 *
 * A script running INSIDE the compositor is not bound by that rule. It can move
 * windows. But a KWin script has no filesystem and nothing can send it a
 * message — so we need a channel the app already owns and the compositor
 * already broadcasts. That channel is the window's own NAME: the app renames
 * its window to "YC:mascot@480,900", KWin fires `captionChanged`, and our
 * helper script reads the numbers out of the name and moves the window there.
 *
 * Measured 2026-09-04 (probe rounds 0c and 3): 120 renames at a 60fps drag
 * cadence produced 120 moves and zero drops, each landing on the exact pixel;
 * three windows renamed at once sustained 188 renames/sec with 363 of 363
 * applied. A rename is much cheaper than a DBus round trip (6-10 ms), but it
 * is not free. The de-duplication lives on the OTHER side of the channel, in
 * the helper (assets/kwin-helper/contents/code/main.js), which returns early
 * when the window is already at the requested pixel — this side renames on
 * every frame.
 *
 * WHY NO SECRET IN THE NAME: a window's name is visible in places the app
 * cannot hide it (Alt-Tab, KWin's Overview, screen-share pickers). Identity is
 * proved elsewhere — the helper matches on the process id and the app's
 * WM_CLASS — so the name carries only the coordinates it must, and leaking it
 * costs nothing.
 */

/** The three buddy windows: the character, his chat panel, his button bar. */
export type BuddyRole = 'mascot' | 'chat' | 'bar';

const CAPTION_PREFIX = 'YC:';

// Deliberately strict, and deliberately bounded. This is parsed by a script
// running with compositor privilege, so it accepts exactly the grammar the app
// writes and nothing else: known role, integers only, at most six digits plus
// an optional sign. No floats (Electron rejects fractional window coordinates
// anyway), no whitespace, no trailing text.
const CAPTION_RE = /^YC:(mascot|chat|bar)@(-?\d{1,6}),(-?\d{1,6})$/;

/**
 * The name to give a buddy window so the compositor puts it at (x, y).
 *
 * Coordinates are rounded because pointer positions on a fractionally-scaled
 * display (Destin's laptop runs 150%) arrive as floats, and a non-integer in
 * the name would simply fail to parse on the other side — the window would
 * stop moving with nothing to show for it.
 */
export function buildCaption(role: BuddyRole, x: number, y: number): string {
  return `${CAPTION_PREFIX}${role}@${safeCoord(x)},${safeCoord(y)}`;
}

/**
 * Read a caption back. Returns null for anything that is not exactly our
 * grammar — including a window that merely starts with "YC:".
 *
 * Exported because the helper script's parser and this one must agree, and the
 * only way to keep two languages honest about one grammar is to test the same
 * cases against both.
 */
export function parseCaption(caption: string): { role: BuddyRole; x: number; y: number } | null {
  // Bail before the regex on anything absurd: a caption is an arbitrary string
  // from outside, and there is no reason to run a pattern over a megabyte of it.
  if (typeof caption !== 'string' || caption.length > 64) return null;
  const m = CAPTION_RE.exec(caption);
  if (!m) return null;
  return { role: m[1] as BuddyRole, x: Number(m[2]), y: Number(m[3]) };
}

/** The largest magnitude CAPTION_RE will accept: six digits plus a sign. */
const COORD_LIMIT = 999999;

/**
 * Round to an integer, clamp to the grammar's own bound, and turn anything that
 * is not a real number into 0.
 *
 * WHY THE CLAMP: the helper's own comment claims this bound is enforced here,
 * and until now it was not — buildCaption could emit `YC:mascot@1234567,0` or
 * `YC:mascot@1e+21,0`, which BOTH readers refuse. A refused caption is
 * indistinguishable from no caption, so the buddy would freeze at his last good
 * position for the rest of the drag with nothing logged. Clamping here makes it
 * impossible by construction for the writer to emit something the reader
 * rejects, which is the only version of that invariant worth having.
 *
 * WHY 0 for a non-finite value rather than throwing: this is the last-ditch
 * guard. `place()` already refuses a non-finite coordinate outright — which is
 * the correct behaviour, because 0 is the CORNER of the screen, not a neutral
 * value. If one ever reaches here, a legal caption keeps the channel alive.
 */
function safeCoord(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, Math.round(n)));
}
