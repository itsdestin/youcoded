// Sizing a tool result to the room left in the model's window (fault 1, 2026-11-08).
// WHY: Read caps at 100,000 characters regardless of the model, so on a 32k local window one file
// (52,733 characters, ~15-18k tokens) filled what was left and the next request could not be sent.
// The cut happens BEFORE the result enters history and the transcript, so what the user sees, what
// the model sees and what a reopened chat rebuilds are all the same text (a history-only cut would
// disagree with the saved event). The model is told it was cut and how to ask for the rest.

/** Characters per token used ONLY to turn room into a cap. Deliberately pessimistic (the history
 *  estimator uses 4): code measured ~3 on the real chats, and an over-cut is recoverable (the notice
 *  says how to read more) while an over-fit is not. */
export const CAP_CHARS_PER_TOKEN = 3;
/** The model always gets at least this much, however little room is left; compaction (not a
 *  zero-length result) is the way out of a nearly-full window. */
export const MIN_RESULT_CHARS = 2_000;

/** Cap `text` to `roomTokens`. Returns `text` untouched when it fits. `hint` is the tool's own
 *  "how to get the rest" sentence (FIT_MORE_HINT); absent for tools that cannot narrow. */
export function capResultToRoom(text: string, roomTokens: number, hint?: string): string {
  const allowed = Math.max(MIN_RESULT_CHARS, Math.floor(roomTokens * CAP_CHARS_PER_TOKEN));
  if (text.length <= allowed) return text;
  const dropped = text.length - allowed;
  return text.slice(0, allowed) +
    `\n\n[truncated — ${dropped.toLocaleString()} more characters were dropped because only ${allowed.toLocaleString()} fit in the room left in this model's context window.${hint ? ` ${hint}.` : ''}]`;
}
