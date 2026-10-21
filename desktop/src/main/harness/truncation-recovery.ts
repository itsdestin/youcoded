// What to do when a reply step stops at its output limit (finishReason
// 'length'), 2026-10-21. Pure: the turn loop asks, this answers.
//
// What happened before: the turn ended with "Response truncated". If the model
// was mid-way through a tool call (writing a file, say), the SDK dropped the
// half-built call entirely — so nothing was saved — and "continue" from the
// user made it attempt the same oversized write again, hitting the same wall
// (85765071, three times on 2026-10-21, on a 16,000-token cap).
//
// Now, inside the same turn and at most MAX_TRUNCATION_RECOVERIES times:
//  - a step cut off in TEXT gets a short "continue exactly where you stopped"
//    message (Anthropic's documented remedy, handling-stop-reasons), so the
//    answer completes instead of ending mid-sentence;
//  - a step cut off while WRITING A TOOL CALL (pendingPreparing non-empty: the
//    call was announced but never completed) is never run — its partial
//    arguments are discarded, exactly as before — and the model is told the
//    call was cut off and to split the work into smaller pieces.
// WHY a cap: a model that keeps writing past every limit must not spend
// without end; after the cap the turn ends with the footer as before.
// WHY history-only (no transcript event), like a <steer>: the note is guidance
// for the next step, not something the person said. On reopen the rebuild
// joins the cut-off and continued text into one assistant message (adjacent
// assistant-text events coalesce), which is valid history; the split note is
// simply absent, which is harmless — the cut-off call never ran.
// WHY only when nothing else is pending: a step that also produced COMPLETE
// tool calls runs them normally; the loop only reaches this on a step with no
// runnable call.
const MAX_TRUNCATION_RECOVERIES = 2;

/** Try again / Keep going (HarnessSession.continueTurn, 2026-10-21) runs the model
 *  again on the history as it stands — after a provider error or a step limit —
 *  with NO new person message, so the conversation does not grow a "continue"
 *  bubble and work the turn already did stays done. When the history ends on the
 *  assistant (a failed turn's kept partial), this history-only note — like a steer,
 *  no transcript event — is added so the request never ends on the assistant. */
export const CONTINUE_TURN_TEXT = 'Continue from where you left off.';

type TruncationAction = { kind: 'continue-text' | 'split-tool-call'; message: string } | { kind: 'stop' };

export function truncationRecovery(opts: { recoveriesSoFar: number; cutOffToolNames: string[]; maxTokens: number; wroteText: boolean }): TruncationAction {
  if (opts.recoveriesSoFar >= MAX_TRUNCATION_RECOVERIES) return { kind: 'stop' };
  // WHY: a step stopped at the limit with NOTHING to show (no text, no half-built
  // call — a reasoning-only step, say) has no "where you stopped" to continue
  // from; asking would only repeat it. End as before.
  if (!opts.wroteText && !opts.cutOffToolNames.length) return { kind: 'stop' };
  if (opts.cutOffToolNames.length) {
    const names = [...new Set(opts.cutOffToolNames)].join(', ');
    return { kind: 'split-tool-call', message:
      `Your last ${names} call was cut off at the ${opts.maxTokens.toLocaleString('en-US')}-token reply limit before it was complete, so it was NOT run and nothing was changed. `
      + `Split the work into smaller pieces: write a large file in parts (Write the first part, then Edit to append the rest), or make several smaller calls. Then continue the task.` };
  }
  return { kind: 'continue-text', message:
    'Your reply was cut off at the reply length limit. Continue exactly where you stopped — do not repeat anything you already wrote.' };
}
