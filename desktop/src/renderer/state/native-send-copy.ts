import type { NativeSendResult } from '../../shared/types';

/** A refused request is not an unanswered one: never invent why a send failed. */
export function sendFailureCopy(result: NativeSendResult | undefined): string {
  if (result?.status === 'failed') switch (result.reason) {
    case 'compacting': return 'Conversation is compacting. Wait for it to finish, then send your message.';
    case 'queue-full': return 'Send queue is full (10 messages waiting). Wait for the current turn to finish.';
    case 'changed': return 'This conversation changed while your message was being prepared. Your message is still here.';
    case 'initializing': return 'This conversation is not ready to send yet. Your message is still here.';
    case 'starting': return 'Starting up — the model is still loading, and ten messages are already waiting.';
    case 'not-live': return 'This session is no longer running. Start or resume it to send messages.';
  }
  // A missing acknowledgement MAY have run: checking is safer than automatic retry.
  if (!result) return "YouCoded couldn't confirm your message was sent — check the conversation before sending it again.";
  return 'The message could not be sent.';
}
