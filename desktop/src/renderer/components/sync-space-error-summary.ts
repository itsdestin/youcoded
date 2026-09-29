// desktop/src/renderer/components/sync-space-error-summary.ts
//
// Turns a raw space-sync error string (thrown by the git transport / engine and
// surfaced verbatim before this) into a user-friendly summary for the Sync card.
//
// WHY this exists: the card used to render the raw git stderr directly — e.g.
// "fatal: Unable to create '…/index.lock': File exists. Another git process…" —
// which violates docs/error-message-standards.md (a wall of jargon, no next
// step). This maps the one cause we can identify with certainty (an interrupted
// write that left a git lock, now auto-healed by GitTransport.reapStaleLocks) to
// a specific+accurate message, and everything else to a general, non-committal
// message that points at the existing report path (Settings → Help & feedback since
// Development was folded in, 2026-09-28). It
// never INVENTS a cause: unknown stays unknown. The raw text is still shown by
// the card behind a "Show details" toggle, so nothing is lost for debugging.
//
// Pure + string-only so it's trivially unit-tested (mirrors sync-error-classifier.ts).

export interface SpaceSyncErrorSummary {
  /** True when the failure is a stale/held git lock from an interrupted write —
   *  the self-healing case (reapStaleLocks clears it within a few minutes). */
  interrupted: boolean;
  /** One-line, plain-language summary shown as the card sub-text. */
  summary: string;
}

// Substrings that identify an interrupted-write / leftover-git-lock failure.
// Matched case-insensitively against the raw error. Kept as specific phrases
// (not loose regex) to avoid misclassifying unrelated errors as self-healing.
const INTERRUPTED_MARKERS = [
  'index.lock',            // index write collision
  'unable to create',      // "Unable to create '<path>.lock': File exists" (index OR ref locks)
  'another git process',   // git's own follow-on line for a held lock
  'could not complete',    // "Sync merge could not complete for <id>: …"
];

export function summarizeSpaceSyncError(raw: string | null | undefined, errorCode?: string): SpaceSyncErrorSummary {
  // Coded errors (Phase 2: 'github-auth' from github-client / the transport)
  // are ALREADY plain-language by contract — pass them through verbatim
  // instead of flattening "reconnect your GitHub account" into the generic
  // "unexpected problem" line. Gated on the machine-readable code, never on
  // matching the prose itself.
  if (errorCode === 'github-auth' && raw) {
    return { interrupted: false, summary: raw };
  }
  // Corruption-family codes (two-tier repair, 2026-07-30 spec). Matched on the
  // machine-readable code like 'github-auth' above — never the prose. WHY
  // explicit mappings (PR #276 review): the generic fallback below promises
  // sync "will keep retrying automatically", which is actively WRONG here —
  // the engine attempts corruption repair exactly ONCE per app launch
  // (engine.ts healedSpaces guard), so the honest next step is a restart, not
  // waiting. Both messages stay within what the code guarantees
  // (docs/error-message-standards.md: never guess): the damage is confined to
  // sync's own hidden records (repair() writes only under .youcoded/, never
  // the user's files), the corruption signatures matched are crash/power-loss
  // truncation fatals (sync-error-classifier.ts CORRUPTION_PATTERNS), and a
  // restart re-runs the repair because the once-per-launch guard resets.
  if (errorCode === 'repo-corrupt') {
    return {
      interrupted: false,
      summary:
        'Sync’s internal records got damaged — usually from a crash or power loss. ' +
        'Your files are safe. Restart the app and sync will repair itself automatically.',
    };
  }
  if (errorCode === 'repo-repair-failed') {
    // The repair already ran and failed this launch — never claim retrying
    // will fix it. Restarting is the accurate remedy (repair re-arms), with
    // the standard report path if it still fails.
    return {
      interrupted: false,
      summary:
        'Sync’s internal records got damaged, and the automatic repair couldn’t finish. ' +
        'Your files are safe. Restarting the app will try the repair again; if it keeps ' +
        'failing, report it from Settings → Help & feedback.',
    };
  }
  const text = (raw ?? '').toLowerCase();
  const interrupted = INTERRUPTED_MARKERS.some((m) => text.includes(m));

  if (interrupted) {
    // Specific + accurate: we know the cause, and the transport now clears the
    // leftover lock automatically, so we tell the user it resolves on its own.
    return {
      interrupted: true,
      summary:
        'A previous sync was interrupted before it finished. It’s being cleaned up ' +
        'automatically and usually clears on its own within a few minutes.',
    };
  }

  // General but non-committal — no guessed cause, plus where to report it.
  return {
    interrupted: false,
    summary:
      'Sync hit an unexpected problem. It will keep retrying automatically; if it ' +
      'keeps failing, report it from Settings → Help & feedback.',
  };
}
