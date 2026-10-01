import type { PermissionMode } from './types';

/**
 * Reads Claude Code's in-terminal permission-mode footer ("bypass permissions
 * on", "auto mode on (shift+tab to cycle)", "plan mode off", …) out of one raw
 * PTY chunk. Returns null when the chunk names no mode.
 *
 * WHY here, in shared/ (one-core R5-4a): this used to live in the renderer and run on EVERY
 * screen's copy of every session's terminal bytes, so a phone that connected after the footer
 * had scrolled off showed the launch mode. The computer's main process now runs it once per
 * session (main/session-live.ts) and publishes the result through the session's record, so main
 * needs to import it and the renderer no longer does. Real Claude Code 2.1.281 captures
 * (tests/fixtures/plan-menu/) pin it in tests/session-live-mode.test.ts.
 *
 * WHY a prefilter (perf, 2026-09-23): this ran per chunk — lower-casing the whole chunk
 * (a fresh string copy) and then scanning it with up to eight .includes().
 * Almost no chunk mentions a mode, so one case-insensitive regex pass now
 * rules the chunk out first; only a chunk that could match pays for the
 * lower-casing and the ordered checks below, which are unchanged.
 * The regex matches every string any of the eight phrases matches (each
 * phrase is "<name> on" or "<name> off"), so it can never hide a banner.
 *
 * Chunk boundaries: like the code it replaced, each chunk is judged on its
 * own — a phrase split across two chunks is not seen. Joining a carry-over
 * tail onto the next chunk was considered and rejected: with the on-before-off
 * priority below, a stale "plan mode on" in the carry would outrank a fresh
 * "plan mode off", reporting the wrong mode.
 */
const MAYBE_MODE_RE = /(?:bypass permissions|auto mode|accept edits|plan mode) o(?:n|ff)/i;
const PHRASES_RE = /(bypass permissions|auto mode|accept edits|plan mode) o(n|ff)/gi;

/**
 * Is this match the footer, not words in a reply? (review fix, one-core R5-4a: the mode now feeds the session record, so a false match
 * is no longer one screen's chip.) Claude Code draws the footer as a glyph then the phrase on ONE line — "⏸ plan mode on",
 * "⏵⏵ accept edits on (shift+tab to cycle)" (real 2.1.281 captures) — so a phrase counts only when a footer glyph sits before it on the same
 * line, or "(shift+tab" follows it. A sentence that merely says "plan mode on" has neither.
 */
function isFooterMatch(data: string, index: number, length: number): boolean {
  const lineStart = Math.max(data.lastIndexOf('\n', index), data.lastIndexOf('\r', index)) + 1;
  if (/[⏵⏸]/.test(data.slice(Math.max(lineStart, index - 60), index))) return true;
  return /^(?:\s|\x1b\[[0-9;?]*[A-Za-z])*\(shift\+tab/i.test(data.slice(index + length, index + length + 40));
}

export function detectPermissionMode(data: string): PermissionMode | null {
  if (!MAYBE_MODE_RE.test(data)) return null;
  const found = new Set<string>();
  for (const m of data.matchAll(PHRASES_RE)) {
    if (isFooterMatch(data, m.index!, m[0].length)) found.add(m[0].toLowerCase());
  }
  if (found.size === 0) return null;
  // Same priority as before: an "on" outranks an "off" wherever it sits; bypass, then auto, then accept edits, then plan.
  if (found.has('bypass permissions on')) return 'bypass';
  if (found.has('auto mode on')) return 'auto';
  if (found.has('accept edits on')) return 'auto-accept';
  if (found.has('plan mode on')) return 'plan';
  return 'normal';
}
