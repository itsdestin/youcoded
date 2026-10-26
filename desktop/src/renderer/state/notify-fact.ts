// The session's `latestNotify` fact (chat-types.ts): the assistant's last
// "Notify user" call since the person last spoke. Kept up by chatReducer's
// wrapper after every action, so every path that adds a tool card or starts a
// user turn — live events, a phone's fill, a reload's replay — keeps it right
// without a case of its own in the big reducer.
import type { ChatAction, ChatState } from './chat-types';
import { isNotifyUserToolName, notifyFieldsOf } from '../../shared/notify-user';

/** Actions that start a new user turn: once the person has spoken, the earlier
 *  notification is answered and no longer labels the conversation. */
function startsUserTurn(action: ChatAction): boolean {
  switch (action.type) {
    case 'USER_PROMPT':
    case 'TRANSCRIPT_SKILL_INVOKED':
    case 'CLEAR_TIMELINE':
      return true;
    case 'TRANSCRIPT_USER_MESSAGE':
      // A helper's briefing or a host-injected report is not the person speaking;
      // a slash command starts no turn.
      return !action.parentAgentToolUseId && !action.slashCommand && !action.injected;
    default:
      return false;
  }
}

export function applyNotifyFact(prev: ChatState, next: ChatState, id: string, action: ChatAction): ChatState {
  const s = next.get(id);
  if (!s) return next;
  if (action.type === 'TRANSCRIPT_TOOL_USE') {
    if (action.parentAgentToolUseId || !isNotifyUserToolName(action.toolName)) return next;
    // Only a call this action actually ADDED counts: the reducer dedups a
    // re-delivered tool use by id, and a re-delivery must not resurrect a
    // notification the person has since answered.
    if (prev.get(id)?.toolCalls.has(action.toolUseId) || !s.toolCalls.has(action.toolUseId)) return next;
    const { label } = notifyFieldsOf(action.toolInput);
    const out = new Map(next);
    out.set(id, { ...s, latestNotify: { toolUseId: action.toolUseId, label } });
    return out;
  }
  if (s.latestNotify && startsUserTurn(action)) {
    const out = new Map(next);
    out.set(id, { ...s, latestNotify: null });
    return out;
  }
  return next;
}
