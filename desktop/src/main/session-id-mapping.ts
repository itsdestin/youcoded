// Decision logic for the desktop→Claude session id map in ipc-handlers.ts.
//
// WHY this exists: the map used to be set-once per desktop session, but
// Claude Code rotates its session id mid-PTY on `/clear` (verified: `--resume`
// does NOT rotate — it appends the same file). With a stale mapping, close-time
// flags and topic lookups landed on the pre-/clear session id. Only
// SessionStart is trusted for a REMAP because subagent/tool hook events can
// carry child session ids — adopting those would point flags and topic
// watchers at a subagent transcript.

export type MappingAction = 'adopt' | 'ignore';

// CC tags every SessionStart with a `source` (it shows up in transcripts as
// `SessionStart:<source>`): startup | resume | clear | compact. Only `clear`
// and an in-session `/resume` are real mid-PTY rotations of OUR session.
//
// Fix (2026-07-26): a `startup` on an ALREADY-MAPPED desktop session is never
// our own rotation — it is a foreign `claude` process announcing itself into
// our session. CLAUDE_DESKTOP_SESSION_ID is inherited by every descendant of
// the PTY, so any nested `claude` run reports our desktop id alongside its own
// session id. Adopting that repointed the transcript watcher at an unrelated
// JSONL; because startWatching begins at offset 0, the whole file replayed into
// the chat view (observed: a 44MB, 15k-line conversation from months earlier)
// while the terminal kept showing the real session.
export function resolveMappingAction(
  currentClaudeId: string | undefined,
  incomingClaudeId: string,
  hookEventName: string | undefined,
  // CC's SessionStart `source`. Optional and FAIL-OPEN on purpose — see below.
  source?: string,
): MappingAction {
  if (!currentClaudeId) return 'adopt';                      // first sighting
  if (currentClaudeId === incomingClaudeId) return 'ignore'; // no change
  if (hookEventName !== 'SessionStart') return 'ignore';

  // Fail open: `source` is CC-supplied, so a version that drops or renames it
  // must degrade to the OLD behavior (adopt), never to a chat view stranded on
  // a stale transcript. Only a positively-identified 'startup' is refused;
  // 'clear'/'resume' (and anything unrecognized) still adopt.
  return source === 'startup' ? 'ignore' : 'adopt';
}

// Which live desktop session, if any, already holds a conversation. Used by
// session:create before it resumes one.
//
// WHY: resuming a conversation that is already open in a tab used to spawn a
// SECOND session on the same transcript — a second tab with the same name, and
// two writers appending to one file. The Resume browser hides live rows, but
// other doors (a chat-search card, a project's conversation list, the buddy's
// list) do not, so the check belongs at the one place every resume passes.
//
// A native session's desktop id IS its conversation id; a Claude Code session's
// conversation id is whatever the map last adopted for it. Only sessions still
// in `liveSessions` count — the map is a cache that can outlive an exit (the
// same reason session:browse filters it, "Bug 1").
export function findLiveSessionForConversation<T extends { id: string; status?: string }>(
  conversationId: string,
  liveSessions: ReadonlyArray<T>,
  // desktop id → the conversation id it last adopted (undefined = not mapped)
  conversationIdOf: (desktopId: string) => string | undefined,
): T | undefined {
  const live = liveSessions.filter((s) => s.status !== 'destroyed');
  return live.find((s) => s.id === conversationId)
    ?? live.find((s) => conversationIdOf(s.id) === conversationId);
}
