/**
 * User-role history messages that are NOT turns the user took.
 *
 * Two kinds are pushed into a session's history as role:'user' but never came
 * from the user's own message:
 *  - `<project-rule source="…">` — a path-triggered rule injection
 *    (HarnessSession.injectPathTriggers);
 *  - `<plan-comment>` — the model-only note riding a plan Comment's follow-up
 *    turn (plans 5b follow-up, plan-host-bridge.ts COMMENT_MODEL_NOTE).
 *
 * WHY one shared test: code that asks "where does a user turn start?" —
 * compaction's protected window and the oversized-tail salvage — must skip
 * both. Counting the Comment note as a turn let compaction cut between the
 * user's Comment and its note (5b review). Detected by content shape because
 * that is all history carries; neither kind ever reaches the transcript.
 */
export const PLAN_COMMENT_TAG = '<plan-comment>';
const HISTORY_ONLY_PREFIXES = ['<project-rule ', PLAN_COMMENT_TAG] as const;

export function isHistoryOnlyUserMessage(message: { role?: unknown; content?: unknown }): boolean {
  const c = message.content;
  return message.role === 'user' && typeof c === 'string' && HISTORY_ONLY_PREFIXES.some((p) => c.startsWith(p));
}
