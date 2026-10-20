import type { AssistantTurn, SessionChatState } from './chat-types';

/** Mark the affected bubble without changing its partial text, segments or measured usage. */
export function interruptedAssistantTurns(session: Pick<SessionChatState, 'assistantTurns' | 'currentTurnId'>): Map<string, AssistantTurn> {
  const assistantTurns = new Map(session.assistantTurns);
  const turnId = session.currentTurnId;
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
