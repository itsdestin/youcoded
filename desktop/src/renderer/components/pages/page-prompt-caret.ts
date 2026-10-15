// Where the composer's caret lands for a message a PAGE wrote (review F4,
// Destin 2026-10-14). Every other prefill keeps the caret at the end, ready to
// type on; a page's message can be thousands of characters, and a caret at the
// end scrolled its start out of sight, so the person saw only the tail.
//
// WHY a small renderer-side note keyed by the TEXT, not a SessionInfo field:
// the message reaches the composer through session.create → main →
// SessionInfo.initialInput (desktop and Android). A new field there would cross
// IPC on both platforms for a purely visual choice. And a note keyed by the new
// session's id could miss: session:created may list and select the session
// before the create call returns its id. The text is known before either.
const waiting: string[] = [];
const KEEP = 8;

/** Called when a page's request opens the window. */
export function markCaretAtStart(text: string): void {
  waiting.push(text);
  // Bounded: a window cancelled without starting leaves its note behind. The
  // only effect of a stale one is a caret at the start of the identical text.
  if (waiting.length > KEEP) waiting.shift();
}

/** InputBar's prefill asks once; the note is used up. */
export function takeCaretAtStart(text: string): boolean {
  const i = waiting.indexOf(text);
  if (i < 0) return false;
  waiting.splice(i, 1);
  return true;
}
