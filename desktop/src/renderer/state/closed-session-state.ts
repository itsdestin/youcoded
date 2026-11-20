// closed-session-state.ts — the screen-side "chat closed" tidy-ups, written once.
//
// WHY (R-4 phase 3): App.tsx had two hand-written lists of per-chat state to drop (the session:destroyed handler and
// removeSessionLocally), and both forgot `viewedSessions` (the "has this chat been looked at" marks): every chat opened in a day
// left an id behind. Both lists now call these two helpers so the rule lives in one place.

/** The set without `id`; the SAME set object when `id` is absent (React then skips a redraw). */
export function withoutSession(prev: ReadonlySet<string>, id: string): Set<string> {
  if (!prev.has(id)) return prev as Set<string>;
  const next = new Set(prev); next.delete(id); return next;
}

/**
 * The "switching model" pill belongs to the chat that is open when the switch starts, not to a chat id of its own.
 * Closing THAT chat ends the wait (its verify listener only ever hears the active chat, so it would wait forever);
 * closing any other chat leaves a switch still in progress alone, so a live chat's pill never vanishes.
 */
export function pendingModelAfterClose<T>(pending: T | null, closedId: string, activeId: string | null): T | null {
  return closedId === activeId ? null : pending;
}
