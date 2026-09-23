import type { PermissionMode } from '../../shared/types';

/**
 * Reads Claude Code's in-terminal permission-mode footer ("bypass permissions
 * on", "auto mode on (shift+tab to cycle)", "plan mode off", …) out of one raw
 * PTY chunk. Returns null when the chunk names no mode.
 *
 * WHY a prefilter (perf, 2026-09-23): App subscribes to EVERY open session's
 * raw terminal stream, and this ran per chunk — lower-casing the whole chunk
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

/**
 * Keeps exactly one live subscription per id in `subs`, touching only what
 * changed: ids that left are unsubscribed, new ids are subscribed, and ids
 * that stayed keep the subscription they already have.
 *
 * WHY (perf, 2026-09-23): the permission-mode watcher used to tear down and
 * re-create the listener for EVERY session whenever the session list changed
 * at all (a rename, a status flip, a new tab) — N IPC unsubscribes and N
 * resubscribes for a one-session change. Diffing by id makes that one.
 */
export function syncKeyedSubscriptions(
  subs: Map<string, () => void>,
  ids: Iterable<string>,
  subscribe: (id: string) => (() => void) | void,
): void {
  const wanted = new Set(ids);
  for (const [id, remove] of subs) {
    if (wanted.has(id)) continue;
    subs.delete(id);
    try { remove(); } catch { /* unsubscribe API may no-op */ }
  }
  for (const id of wanted) {
    if (subs.has(id)) continue;
    const remove = subscribe(id);
    subs.set(id, typeof remove === 'function' ? remove : () => {});
  }
}

/** Unsubscribes everything in `subs` and empties it (component unmount). */
export function clearKeyedSubscriptions(subs: Map<string, () => void>): void {
  for (const remove of subs.values()) {
    try { remove(); } catch { /* unsubscribe API may no-op */ }
  }
  subs.clear();
}
