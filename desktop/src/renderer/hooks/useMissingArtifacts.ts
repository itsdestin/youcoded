// Which tracked files are no longer on disk — ONE shared answer for the whole
// renderer.
//
// WHY this exists (the "deleted files flash", 2026-08-30): a tracked file can
// vanish without leaving any trace in the sidecar — `rm` from a Bash tool call
// emits no artifact event, so the record stays status:'active' while the file
// is gone. The only way to know is to ask main (`artifacts:check-existence`),
// which is asynchronous. Both the Session Drawer and the header badge used to
// keep their OWN copy of that answer, each starting EMPTY on mount and the
// drawer's clearing itself back to empty every time it closed. So every drawer
// open rendered the full list (deleted rows included), waited one IPC round
// trip, then yanked rows out from under the user — a visible flash, with the
// badge counting down alongside it.
//
// The fix is to treat "which ids are missing" as project-scoped knowledge that
// OUTLIVES any one component: a module-level cache keyed by project root, in
// the same shape as the useSpecialists roster cache (Map + subscriber set).
// Two invariants make the flash impossible:
//
//   1. An entry is NEVER cleared before its replacement has arrived. A refresh
//      overwrites only once the new answer resolves, so there is no window in
//      which the renderer believes everything is present.
//   2. A consumer mounting against an already-checked project reads the last
//      answer SYNCHRONOUSLY on its first render, before any effect runs. The
//      header badge is mounted for the whole session and checks continuously,
//      so by the time a human clicks the drawer open the answer is already
//      here and the list renders settled on frame one.
//
// `known` is false only for a project nothing has checked yet (first open of a
// fresh launch). Callers hold the list blank for that one round trip rather
// than show rows they are about to remove.

import { useEffect, useRef, useState } from 'react';
import { canonicalize } from '../../shared/artifacts/canonicalize';

const EMPTY: ReadonlySet<string> = new Set<string>();

interface Entry {
  /** Last resolved answer. Replaced wholesale, never emptied in advance. */
  missing: ReadonlySet<string>;
  /** False until the first check for this project has SETTLED (ok or not). */
  known: boolean;
  /** Id set of the check currently in flight, so identical requests coalesce. */
  inFlight: string | null;
  /** Start order of checks, and which check last answered each id — see refresh. */
  seq: number;
  verdictSeq: Map<string, number>;
  /** A request that arrived after files changed while an identical one was running. */
  again: string[] | null;
}

/** Quiet period before a file-change burst triggers one re-check. */
export const CHANGE_RECHECK_DELAY_MS = 300;

const cache = new Map<string, Entry>();
const subs = new Map<string, Set<() => void>>();

/** Cache key. Two surfaces can hold the SAME folder spelled differently (a
 *  Windows drive letter cased either way, a trailing slash) and must still
 *  share one answer — the same "canonicalize both sides" rule the sidecar
 *  comparisons follow. The IPC call still receives the caller's own spelling:
 *  main resolves artifact paths against it. */
function keyFor(root: string): string {
  return canonicalize(root, null);
}

function notify(key: string): void {
  for (const cb of subs.get(key) ?? []) cb();
}

function entryFor(key: string): Entry {
  let e = cache.get(key);
  if (!e) { e = { missing: EMPTY, known: false, inFlight: null, seq: 0, verdictSeq: new Map(), again: null }; cache.set(key, e); }
  return e;
}

/** Test seam — the cache is module-scoped, so suites must be able to reset it. */
export function __resetMissingArtifactsCache(): void {
  cache.clear();
  subs.clear();
}

/**
 * Ask main which of `ids` are gone, then publish the answer to every consumer
 * of this project root. Safe to call concurrently: a request for an identical
 * id set that is already in flight is not re-issued — unless `afterChange` says
 * files changed since that check may have started, in which case it runs once
 * more when the running one lands.
 */
export async function refreshMissingArtifacts(
  root: string,
  ids: string[],
  opts?: { afterChange?: boolean },
): Promise<void> {
  if (!root || ids.length === 0) return;
  const key = keyFor(root);
  const request = ids.join(',');
  const entry = entryFor(key);
  if (entry.inFlight === request) {
    if (opts?.afterChange) entry.again = ids;
    return;
  }
  entry.inFlight = request;
  const seq = ++entry.seq;
  try {
    const res: any = await (window.claude as any)?.artifacts?.checkExistence?.(root, ids);
    if (res?.ok) {
      const missingNow = new Set<string>(res.missingIds ?? []);
      // Ids that were NOT part of this request keep their previous verdict: the
      // drawer and the badge check slightly different id sets (the badge drops
      // explicit tombstones, the drawer drops on-disk discovered rows), and
      // neither may erase what the other established.
      const next = new Set<string>(entry.missing);
      for (const id of ids) {
        // WHY: two overlapping checks (the drawer's and the badge's, or one
        // started before a file appeared and one after) can land out of order.
        // A check that STARTED later has already answered this id, so an older
        // answer arriving afterwards must not put back a stale "not found".
        if ((entry.verdictSeq.get(id) ?? 0) > seq) continue;
        entry.verdictSeq.set(id, seq);
        if (missingNow.has(id)) next.add(id); else next.delete(id);
      }
      entry.missing = next;
    }
    // `known` flips even when the check FAILED or the surface does not
    // implement it (mobile answers not-implemented-on-mobile). Holding it
    // false there would leave the drawer's list blank forever waiting for an
    // answer that is never coming; falling back to the previous verdict shows
    // the unfiltered list, which is the old behaviour, not a hang.
    entry.known = true;
    notify(key);
  } catch {
    entry.known = true;
    notify(key);
  } finally {
    if (entry.inFlight === request) entry.inFlight = null;
    const again = entry.again;
    if (again && again.join(',') === request) {
      entry.again = null;
      void refreshMissingArtifacts(root, again);
    }
  }
}

/**
 * The missing-file verdict for one project root, refreshed whenever the
 * CONTENT of `ids` changes. Pass `enabled: false` to subscribe to the shared
 * answer without triggering a check of your own.
 */
export function useMissingArtifacts(
  root: string | null | undefined,
  ids: string[],
  enabled = true
): { missingIds: ReadonlySet<string>; known: boolean } {
  const [, force] = useState(0);
  const key = root ? keyFor(root) : '';
  const idsKey = ids.join(',');
  // The caller rebuilds this array every render; only its CONTENT may drive
  // the refresh effect, so the ids ride a ref and idsKey is the dep.
  const idsRef = useRef(ids);
  idsRef.current = ids;

  useEffect(() => {
    if (!key) return;
    let s = subs.get(key);
    if (!s) { s = new Set(); subs.set(key, s); }
    const set = s;
    const cb = () => force((n) => n + 1);
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0) subs.delete(key);
    };
  }, [key]);

  useEffect(() => {
    if (!root || !enabled) return;
    void refreshMissingArtifacts(root, idsRef.current);
  }, [root, idsKey, enabled]);

  // Re-check when files change on disk. WHY (2026-09-11): nothing re-asked
  // while a surface stayed open, so a file removed by a Bash `rm`, or one that
  // appeared after its check, kept the wrong verdict until the drawer was
  // closed and reopened. artifacts:changed fires for every tracked write and,
  // on desktop while the drawer holds a project watch, for outside changes too.
  // A burst of events becomes one check after a quiet period.
  useEffect(() => {
    if (!root || !enabled) return;
    const api = (window.claude as any)?.artifacts;
    if (typeof api?.onChanged !== 'function') return;
    const rootKey = keyFor(root);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = api.onChanged((evt: any) => {
      if (typeof evt?.projectRoot !== 'string' || keyFor(evt.projectRoot) !== rootKey) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refreshMissingArtifacts(root, idsRef.current, { afterChange: true });
      }, CHANGE_RECHECK_DELAY_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [root, enabled]);

  const entry = key ? cache.get(key) : undefined;
  return { missingIds: entry?.missing ?? EMPTY, known: entry?.known ?? false };
}
