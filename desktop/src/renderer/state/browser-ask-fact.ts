// The Browser's open card as a per-conversation fact (card #205). The computer publishes it (session:live `browser-ask`); a phone has no
// Browser of its own, so this is the only way it learns the assistant is waiting on an approval. Kept in its own file, applied by
// chatReducer's wrapper, so the reducer's cases stay as they were.
import type { ChatAction, ChatState } from './chat-types';

/** Returns the new state for BROWSER_ASK_CHANGED (the same state when the card did not change), or null for any other action. */
export function applyBrowserAsk(state: ChatState, action: ChatAction): ChatState | null {
  if (action.type !== 'BROWSER_ASK_CHANGED') return null;
  const session = state.get(action.sessionId);
  if (!session || (session.browserAsk?.id ?? null) === (action.prompt?.id ?? null)) return state;
  const next = new Map(state);
  next.set(action.sessionId, { ...session, browserAsk: action.prompt });
  return next;
}
