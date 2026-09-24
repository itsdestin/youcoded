// desktop/src/renderer/hooks/useSessionAvailability.ts
//
// T5 (project-plugin-controls) — CommandDrawer's own gated fetch of the
// active session's frozen skill/tool-connection availability (design §5,
// technical design doc 2026-09-24). Same demand pattern as the sibling
// `useMarketplace(open)` (marketplace-context.tsx): the drawer is mounted
// under every session whether or not it's showing, so only OPENING it (or
// switching sessions while open) is a reason to ask the main process — never
// a plain mount. WHY a bare hook and not a context: App already passes the
// active session id down as a plain prop (design §5's own call — "no new
// context"); this is the single consumer that needs the fetch, so a context
// would add a subscription surface for zero sharing benefit.
import { useEffect, useRef, useState } from 'react';
import type { ProjectExtensionsForSessionResult } from '../../shared/types';

export type SessionAvailabilityMissingRow =
  Extract<ProjectExtensionsForSessionResult, { ok: true }>['missing'][number];

export interface SessionAvailability {
  /** null = this session has no stored frozen set at all (created before
   *  T2, or its create-time resolution failed open) — render NO chips
   *  rather than guessing every installed skill is Automatic (T5 scope).
   *  A real array, INCLUDING an empty one (e.g. a B-1 "outside any
   *  project" session), is an actual frozen decision. */
  frozenSkillIds: string[] | null;
  /** Items the project has turned on but that aren't installed/set up on
   *  this device — rendered as the drawer's own dimmed "missing" cards. */
  missing: SessionAvailabilityMissingRow[];
  /** Q-2's quiet line: true when the project's CURRENT setting no longer
   *  matches what this conversation froze at create time. */
  settingsDiffer: boolean;
}

/**
 * Fetches `project-extensions:for-session` for `sessionId`, ONLY while
 * `open` is true, and again if `sessionId` changes while still open.
 * Returns null while closed, before the first session id arrives, when the
 * backend answers `not-implemented-on-mobile` (Android — B-2 hides chips
 * entirely there; a remote browser always talks to a desktop backend and
 * gets the real feature), or on any other error — a guess is worse than no
 * chip, so a failure hides them rather than showing something unverified.
 */
export function useSessionAvailability(sessionId: string | null, open: boolean): SessionAvailability | null {
  const [result, setResult] = useState<SessionAvailability | null>(null);
  // Discards a slow response once a newer (sessionId, open) pair has already
  // started a fetch — same pattern as MarketplaceProvider's fetchGeneration.
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    if (!open || !sessionId) {
      // Nothing to show while closed or session-less — and dropping any
      // held-over result here means a later reopen never flashes a STALE
      // session's chips while the fresh fetch is still in flight.
      setResult(null);
      return;
    }
    const api = (window.claude as any)?.projectExtensions;
    if (!api?.forSession) { setResult(null); return; }
    api.forSession(sessionId)
      .then((res: ProjectExtensionsForSessionResult) => {
        if (gen !== generation.current) return; // superseded by a newer request
        if (!res.ok) { setResult(null); return; }
        setResult({ frozenSkillIds: res.frozenSkillIds, missing: res.missing, settingsDiffer: res.settingsDiffer });
      })
      .catch(() => { if (gen === generation.current) setResult(null); });
    // WHY: an answer that arrives after unmount or after the next request
    // started must never land; bumping the generation retires this one.
    return () => { generation.current++; };
  }, [sessionId, open]);

  return result;
}
