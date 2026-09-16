import type { TranscriptPageResult } from '../../shared/types';

/**
 * What to do with the answer to a FIRST-page request (App.loadFirstPage).
 *
 * Extracted from App.tsx so it can be tested: App.tsx cannot be mounted in a
 * test (see tests/app-resume-session-listener.test.ts for the established
 * reasoning), and this is the decision that determines whether a conversation
 * comes up with its history or comes up blank.
 */
export type FirstPageDecision =
  /** Record it: this is the real state of the conversation's history. */
  | 'accept'
  /** Ask again shortly. */
  | 'retry'
  /** Stop asking, and record NOTHING — see below. */
  | 'give-up';

/** Attempts for an AMBIGUOUS empty page — one that could equally mean "this
 *  session has no history" or "main has not resolved the transcript yet". Kept
 *  short so a genuinely new session does not feel slow. */
export const FIRST_PAGE_ATTEMPTS = 3;

/** Attempts for a page main explicitly reported as UNRESOLVED. Longer, because
 *  this is no longer a guess about what the empty answer meant: main said it
 *  has not located the file, and the usual reason is a just-resumed Claude Code
 *  session whose SessionStart hook has not landed yet. Bounded so a session
 *  that will never have a transcript (a plain shell session) stops asking. */
export const FIRST_PAGE_UNRESOLVED_ATTEMPTS = 8;

/** Delay between attempts, for every caller of decideFirstPage. */
export const FIRST_PAGE_RETRY_MS = 400;

export function decideFirstPage(page: TranscriptPageResult, attempt: number): FirstPageDecision {
  if (page.unresolved) {
    // 'accept' would write hasMore:false and a null cursor into the reducer —
    // the state that means "you have reached the beginning of the conversation"
    // and permanently removes the scroll-up sentinel. Never record a page main
    // told us it could not find (Destin, 2026-09-07).
    return attempt < FIRST_PAGE_UNRESOLVED_ATTEMPTS - 1 ? 'retry' : 'give-up';
  }
  const ambiguousEmpty = page.events.length === 0 && !page.hasMore;
  if (ambiguousEmpty && attempt < FIRST_PAGE_ATTEMPTS - 1) return 'retry';
  return 'accept';
}
