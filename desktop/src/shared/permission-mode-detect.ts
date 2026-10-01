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

export function detectPermissionMode(data: string): PermissionMode | null {
  if (!MAYBE_MODE_RE.test(data)) return null;
  const lower = data.toLowerCase();
  // CC v2.1.83+ auto mode banner reads "auto mode on (shift+tab to cycle)" —
  // checked before "accept edits on" because the substring "auto mode" doesn't
  // overlap, but order is preserved for symmetry with the off-list below.
  if (lower.includes('bypass permissions on')) return 'bypass';
  if (lower.includes('auto mode on')) return 'auto';
  if (lower.includes('accept edits on')) return 'auto-accept';
  if (lower.includes('plan mode on')) return 'plan';
  if (lower.includes('bypass permissions off')
    || lower.includes('auto mode off')
    || lower.includes('accept edits off')
    || lower.includes('plan mode off')) return 'normal';
  return null;
}
