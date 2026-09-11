/**
 * Whether the welcome screen shows its first-time version ("Start your first session") rather
 * than the everyday "No Active Session".
 *
 * WHY this is a function with its own test (Destin, 2026-09-11, on his phone: "sometimes
 * erroneously showing me the very first run 'start your first session' screen when i connect
 * via remote access"): the screen was decided by `sessions.length === 0 && hasResumable ===
 * false`, and `hasResumable` was set to false whenever the question about past conversations
 * FAILED — which over remote access happens on every dropped connection, and the question was
 * never asked again. A failed question is not an answer of "none", and the list of open
 * sessions arrives after the screen first renders, so "not asked yet" and "not answered yet"
 * must both keep the everyday screen.
 */
export function showFirstRunWelcome(state: {
  /** Open sessions this device knows about. */
  sessionCount: number;
  /** true: past conversations exist. false: there are none. null: unknown — not asked yet, the
   *  question failed, or the computer answered something that was not a list. */
  hasResumable: boolean | null;
  /** Whether the list of open sessions has arrived at least once. */
  sessionListLoaded: boolean;
}): boolean {
  if (!state.sessionListLoaded) return false;
  if (state.sessionCount > 0) return false;
  return state.hasResumable === false;
}
