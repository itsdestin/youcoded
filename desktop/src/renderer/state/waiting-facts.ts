// What the assistant is blocked on the person for beyond permission-style asks (2026-10-26, notify-user plan Part 1), kept in chat
// state so the dot turns red (useSessionAttention): the Browser's open card, Claude Code's unanswered terminal cards, and a native
// session that failed to start. Its own file, applied by chatReducer's wrapper, so the reducer's cases stay as they were.
import type { ChatAction, ChatState } from './chat-types';

/** The two facts that arrive as actions of their own. Returns the new state (the same state when nothing changed), or null for any
 *  other action. */
export function applyWaitingAction(state: ChatState, action: ChatAction): ChatState | null {
  if (action.type !== 'BROWSER_ASK_CHANGED' && action.type !== 'NATIVE_STARTUP_FAILED') return null;
  const session = state.get(action.sessionId);
  if (!session) return state;
  const next = new Map(state);
  if (action.type === 'BROWSER_ASK_CHANGED') {
    if ((session.browserAsk?.id ?? null) === (action.prompt?.id ?? null)) return state;
    next.set(action.sessionId, { ...session, browserAsk: action.prompt });
  } else {
    if (!!session.startupFailed === action.failed) return state;
    next.set(action.sessionId, { ...session, startupFailed: action.failed });
  }
  return next;
}

/** A terminal card joins the open list when shown and leaves it when answered or dismissed (red until then). Runs after the
 *  reducer's own SHOW/COMPLETE/DISMISS_PROMPT cases, which draw and remove the card. */
export function applyOpenPrompts(next: ChatState, id: string, action: ChatAction): ChatState {
  if (action.type !== 'SHOW_PROMPT' && action.type !== 'COMPLETE_PROMPT' && action.type !== 'DISMISS_PROMPT') return next;
  const s = next.get(id);
  if (!s) return next;
  const ids = s.openPromptIds ?? [];
  const has = ids.includes(action.promptId);
  if (action.type === 'SHOW_PROMPT' ? has : !has) return next;
  const out = new Map(next);
  out.set(id, { ...s, openPromptIds: action.type === 'SHOW_PROMPT' ? [...ids, action.promptId] : ids.filter((p) => p !== action.promptId) });
  return out;
}
