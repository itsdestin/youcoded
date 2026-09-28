/**
 * Shared guards for anything that cold-scans a transcript lane.
 *
 * WHY one implementation: both guards encode incidents, and both used to live in
 * exactly one place each — so a new scanner could not inherit them by imitation.
 *  - Symlink skip: the LEGACY sync system symlinked every conversation into the
 *    home-dir project slug (687 found on a real machine). Following them tags
 *    every linked conversation with the home basename. lstat does not follow the
 *    link, so the symlink is detected and skipped; the real transcript is
 *    processed normally in its true slug. Lived only in reconciler.ts (CC-only).
 *  - Lane assertion: a record's transcriptRef must live under its OWN provider's
 *    lane, or a native record could be materialized through the claude lane.
 *    Was duplicated at two service.ts sites.
 * The chatsearch index builder is the first thing to cold-scan the NATIVE lane,
 * which is why these moved here rather than being copied a third time.
 */

/** Junk threshold: below this a transcript is startup noise, not a conversation. */
export const MIN_TRANSCRIPT_BYTES = 500;

export type TranscriptSkipReason = 'symlink' | 'too-small';

/** The only stat members these guards need — fs.Stats satisfies it structurally. */
export interface StatLike {
  isSymbolicLink(): boolean;
  size: number;
}

/**
 * Why a transcript entry must be skipped, or null to process it.
 *
 * `minBytes` defaults to 0 so the size gate is OPT-IN: NativeHome.listSessionFiles
 * enumerates every native session regardless of size and must not start dropping
 * small ones by adopting this helper. Callers that want the junk gate pass
 * MIN_TRANSCRIPT_BYTES explicitly.
 *
 * Pass an lstat result (`fs.lstatSync()` or `fs.promises.lstat()`) — never a
 * `stat`, which follows the symlink and defeats the first check.
 */
export function transcriptSkipReason(
  st: StatLike,
  minBytes: number = 0
): TranscriptSkipReason | null {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.size < minBytes) return 'too-small';
  return null;
}

/**
 * Does this record's transcriptRef live under its own provider's lane?
 *
 * Pure string check on the record's own fields (no IO), so it runs before any
 * path resolution. An empty ref (phantom metadata-only seed) fails by design.
 * The trailing slash matters: 'native' must not match 'native-other/...'.
 */
export function laneMatches(provider: string, transcriptRef: string): boolean {
  return transcriptRef.startsWith(`${provider}/`);
}
