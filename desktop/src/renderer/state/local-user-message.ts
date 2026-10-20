import type { ChatAction, SessionChatState } from './chat-types';

type LocalUserAction = Extract<ChatAction, { type: 'USER_PROMPT' | 'UNSENT_RETAINED' }>;

/** A local bubble is either an admitted send or retained text; only the former starts a turn. */
export function localUserMessage(session: SessionChatState, action: LocalUserAction, messageId: string): SessionChatState {
  const message = {
    id: messageId, role: 'user' as const, content: action.content, timestamp: action.timestamp,
    // Exact paths preserve file chips with spaces; content remains the transcript's matching key.
    ...(action.attachments?.length ? { attachments: action.attachments } : {}),
  };
  if (action.type === 'UNSENT_RETAINED') {
    // WHY: a refused draft is not a new turn. Keep the host's error/park/prefill state and recovery controls intact.
    return { ...session, timeline: [...session.timeline,
      { kind: 'user', message, pending: true, sendId: action.sendId, sendNote: action.note,
        ...(action.note === 'not-sent' ? { sendRefused: true as const } : {}) }] };
  }
  // WHY no content dedup: two identical explicit submissions are two messages.
  // Recorded echoes confirm submitted pending bubbles; directly refused retained text cannot be confirmed by older identical history.
  return {
    ...session,
    timeline: [...session.timeline, { kind: 'user', message, pending: true, ...(action.sendId ? { sendId: action.sendId } : {}),
      ...(action.sendTransport ? { sendTransport: action.sendTransport } : {}) }],
    // WHY: preserve upstream addressed-Stop fencing; a new send is not the old recorded turn.
    transcriptTurnUuid: undefined,
    isThinking: true,
    // Keep an in-flight reply's grouping until its recorded turn boundary; optimistic input must not split the sender's stream.
    currentGroupId: session.currentTurnId ? session.currentGroupId : null,
    currentTurnId: session.currentTurnId,
    // Only an admitted new prompt clears the previous error/park/prefill state.
    attentionState: 'ok', errorMessage: null, errorCode: null, stallWarning: null, stalledSince: null, promptProcessing: null,
  };
}
