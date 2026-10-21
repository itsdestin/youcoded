import type { AssistantTurn, ChatAction, ChatState } from './chat-types';

/** Actions that mean "the reply in progress just changed". Their time becomes the reply's shown time. */
const TURN_ACTIVITY_TYPES: ReadonlySet<ChatAction['type']> = new Set<ChatAction['type']>([
  'TRANSCRIPT_ASSISTANT_TEXT', 'TRANSCRIPT_ASSISTANT_REASONING', 'TRANSCRIPT_TOOL_USE',
  'TRANSCRIPT_TOOL_RESULT', 'TRANSCRIPT_TURN_COMPLETE', 'TRANSCRIPT_INTERRUPT',
]);

/**
 * Move the reply's `timestamp` forward to the time of the latest thing that happened in it.
 *
 * WHY (Destin, 2026-10-21: "they should always show the actual time that the message/turn was last
 * updated so they don't become stale"): a reply's time was taken from its FIRST event and never moved,
 * so a reply that ran 40 minutes of tool steps showed when it started under its final words. Done once,
 * after every reducer case (chatReducer), rather than in each of the six cases: a case added later cannot
 * forget it. The time is the EVENT's own (the recorded time on a reopened chat), never the screen's clock,
 * so a history page replays to the same time the live view showed. Only ever forward: a late or replayed
 * event cannot pull the time back.
 */
export function touchTurnTime(prev: ChatState, next: ChatState, id: string, action: ChatAction): ChatState {
  if (!TURN_ACTIVITY_TYPES.has(action.type)) return next;
  const at = (action as { timestamp?: number }).timestamp;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return next;
  const session = next.get(id);
  if (!session) return next;
  // A turn-ending action has already cleared currentTurnId; the turn it ended is the one before.
  const turnId = session.currentTurnId ?? prev.get(id)?.currentTurnId;
  const turn = turnId ? session.assistantTurns.get(turnId) : undefined;
  if (!turnId || !turn || (turn.timestamp ?? 0) >= at) return next;
  // WHY reuse a map this action already copied (performance.md rule 4): streamed text copies
  // assistantTurns on every word anyway; a second whole-map copy per word would double that cost.
  const fresh = session.assistantTurns !== prev.get(id)?.assistantTurns;
  const assistantTurns = fresh ? session.assistantTurns as Map<string, AssistantTurn> : new Map(session.assistantTurns);
  assistantTurns.set(turnId, { ...turn, timestamp: at });
  const out = new Map(next);
  out.set(id, { ...session, assistantTurns });
  return out;
}
