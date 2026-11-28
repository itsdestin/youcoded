// session-meta-view.ts — one shared, read-only copy of each session's tags, note and flags, for surfaces that only SHOW
// them (the session menu's rows).
//
// WHY (hitch audit 2026-11-27): every open of the session menu mounted two useSessionMeta hooks per row (the pin mark
// and the tag chips), each starting with nothing and asking the backend again — 2 × N round trips per open, every open,
// each answer re-rendering its row mid-animation so chips popped in and rows reflowed. Here a session's answer is
// fetched once, shared by every reader, and kept: a reopen draws the chips on its first frame. It is refreshed when the
// backend says meta changed (same unconditional rule as useSessionMeta: the event may carry a resolved id) and after a
// phone reconnect. Editing stays in useSessionMeta, whose save/rollback rules this does not duplicate.
import { useCallback, useSyncExternalStore } from 'react';
import type { SessionFlagName, SessionMetaResult } from '../../shared/types';
import { REMOTE_RECONNECTED_EVENT } from '../remote-events';

export interface SessionMetaView {
  tags: ReadonlySet<string>;
  note: string;
  flags: Partial<Record<SessionFlagName, boolean>>;
}

const EMPTY: SessionMetaView = Object.freeze({ tags: new Set<string>(), note: '', flags: {} });

const views = new Map<string, SessionMetaView>();
const readers = new Map<string, Set<() => void>>();
const reads = new Map<string, number>();   // newest read per session: only it may land
const inflight = new Set<string>();          // a first read already asked: a second reader waits for it
let wired = false;

function toView(m: SessionMetaResult | undefined): SessionMetaView {
  // An unreadable answer shows nothing (as the editing hook does); the editing surface explains why.
  if (!m || m.unreadable) return EMPTY;
  return { tags: new Set(m.tags ?? []), note: m.note ?? '', flags: m.flags ?? {} };
}

function read(sessionId: string): void {
  const mine = (reads.get(sessionId) ?? 0) + 1;
  reads.set(sessionId, mine);
  inflight.add(sessionId);
  Promise.resolve((window as any).claude?.session?.getMeta?.(sessionId))
    .then((m: SessionMetaResult | undefined) => {
      if (reads.get(sessionId) !== mine) return;
      // Nobody shows it any more: drop the answer, so a meta change missed meanwhile can't leave it stale for the next
      // reader (that reader simply asks again).
      if (!readers.get(sessionId)?.size) return;
      views.set(sessionId, toView(m));
      readers.get(sessionId)?.forEach((f) => f());
    })
    // benign: a failed read of this display-only copy keeps what is shown; editing surfaces (useSessionMeta) report their own failures.
    .catch(() => {})
    .finally(() => { if (reads.get(sessionId) === mine) inflight.delete(sessionId); });
}

function refreshAllRead(): void {
  // Sessions nobody is showing are simply forgotten, so the next reader asks fresh.
  for (const id of [...views.keys()]) if (!readers.get(id)?.size) views.delete(id);
  for (const id of readers.keys()) read(id);
}

function wire(): void {
  if (wired) return;
  wired = true;
  (window as any).claude?.on?.sessionMetaChanged?.(() => refreshAllRead());
  window.addEventListener(REMOTE_RECONNECTED_EVENT, refreshAllRead);
}

function subscribe(sessionId: string, onChange: () => void): () => void {
  wire();
  let set = readers.get(sessionId);
  if (!set) readers.set(sessionId, (set = new Set()));
  set.add(onChange);
  if (!views.has(sessionId) && !inflight.has(sessionId)) read(sessionId);
  return () => {
    set!.delete(onChange);
    if (set!.size === 0) readers.delete(sessionId);
  };
}

/** The session's tags, note and flags, shared by every reader; EMPTY until the first answer. */
export function useSessionMetaView(sessionId: string): SessionMetaView {
  const sub = useCallback((onChange: () => void) => subscribe(sessionId, onChange), [sessionId]);
  return useSyncExternalStore(sub, () => views.get(sessionId) ?? EMPTY);
}

/** Test seam: forget everything (module state outlives a test's render). */
export function resetSessionMetaViewForTests(): void {
  views.clear(); readers.clear(); reads.clear(); inflight.clear(); wired = false;
}
