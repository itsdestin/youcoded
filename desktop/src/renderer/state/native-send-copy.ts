import type { NativeSendResult } from '../../shared/types';
import { MESSAGE_NOT_SENT, MESSAGE_UNSURE } from '../utils/notice-words';
import { raiseUnsure } from './raise-notice';

/** A refused request is not an unanswered one: never invent why a send failed. */
function sendFailureCopy(result: NativeSendResult | undefined): string {
  if (result?.status === 'failed') switch (result.reason) {
    case 'compacting': return 'Conversation is compacting. Wait for it to finish, then send your message.';
    case 'queue-full': return 'Send queue is full (10 messages waiting). Wait for the current turn to finish.';
    case 'changed': return 'This conversation changed while your message was being prepared. Your message is still here.';
    case 'initializing': return 'This conversation is not ready to send yet. Your message is still here.';
    case 'starting': return 'Starting up — the model is still loading, and ten messages are already waiting.';
    case 'not-live': return 'This session is no longer running. Start or resume it to send messages.';
  }
  // A missing acknowledgement MAY have run: checking is safer than automatic retry.
  if (!result) return MESSAGE_UNSURE;
  return MESSAGE_NOT_SENT;
}

/**
 * Says why a send to `sessionId` did not go. WHY split (waiting-notice T2): a known refusal ("compacting", "queue full"…) is a
 * HELD-BACK notice and keeps its place; the two that mean "not sent / can't tell" are the deck's unsure notices and go in that chat's
 * strip until you send again. `floating` is the old toast, used for the first kind. Returns nothing; the words come from sendFailureCopy.
 */
const HELD_REASONS = new Set(['compacting', 'queue-full', 'changed', 'initializing', 'starting', 'not-live']);
export function reportSendFailure(sessionId: string, result: NativeSendResult | undefined, floating: (message: string) => void): void {
  const text = sendFailureCopy(result);
  if (result?.status === 'failed' && HELD_REASONS.has(result.reason)) { floating(text); return; }
  raiseUnsure(sessionId, result ? 'send-failed-generic' : 'send-unconfirmed', text);
}
