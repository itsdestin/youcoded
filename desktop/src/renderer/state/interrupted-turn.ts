import type { AssistantTurn, SessionChatState } from './chat-types';

/** Mark the affected bubble without changing its partial text, segments or measured usage. */
export function interruptedAssistantTurns(session: Pick<SessionChatState, 'assistantTurns' | 'currentTurnId' | 'timeline'>): Map<string, AssistantTurn> {
  const assistantTurns = new Map(session.assistantTurns);
  const turnId = session.currentTurnId ?? cutOffTurnId(session);
  const turn = turnId ? assistantTurns.get(turnId) : undefined;
  // WHY: interruption is a lifecycle fact, not replacement assistant content or a fabricated usage reading.
  if (turnId && turn) {
    assistantTurns.set(turnId, {
      ...turn,
      stopReason: 'interrupted',
    });
  }
  return assistantTurns;
}

/**
 * The newest reply when it never finished, for an interrupt that arrives with no turn in flight.
 *
 * WHY (Destin, 2026-11-23: after a PC restart the cut-off reply should say "Interrupted."): a reopened
 * chat's history is loaded as a page, and merging a page never makes its open turn the live
 * `currentTurnId`. Claude Code's resume placeholder (read as an interrupt, transcript-watcher.ts) then
 * arrives live with nothing to mark. A reply that is still the newest entry (only unconfirmed
 * bubbles of the message being sent sit below it) and never got a stop reason was cut off. A reply
 * that ended normally carries its stop reason, and one followed by a confirmed message is not the
 * newest, so an ordinary Stop never marks an older reply.
 */
function cutOffTurnId(session: Pick<SessionChatState, 'assistantTurns' | 'timeline'>): string | null {
  for (let i = session.timeline.length - 1; i >= 0; i--) {
    const entry = session.timeline[i];
    if (entry.kind === 'user' && entry.pending) continue;
    if (entry.kind !== 'assistant-turn') return null;
    return session.assistantTurns.get(entry.turnId)?.stopReason ? null : entry.turnId;
  }
  return null;
}
