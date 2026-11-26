import type { NativeSendResult } from '../../shared/types';
import { MESSAGE_NOT_SENT, MESSAGE_UNSURE, SEND_HELD_BACK } from '../utils/notice-words';
import { raiseNotice } from './raise-notice';

/** The sentence for a refusal the app has words for (held back: the message keeps its place), or nothing for any other answer. */
function heldBackCopy(result: NativeSendResult | undefined): string | undefined {
  // WHY the lookup, not a second list of reasons (review): SEND_HELD_BACK is the one place that names them, so a reason added to
  // NativeSendResult but missing here is caught by the type check there. A reason from a newer host that the app does not know is "unsure".
  if (result?.status === 'failed' && Object.hasOwn(SEND_HELD_BACK, result.reason)) return SEND_HELD_BACK[result.reason];
  return undefined;
}

/**
 * Says why a send to `sessionId` did not go. WHY split (waiting-notice T2): a known refusal ("compacting", "queue full"…) is a
 * HELD-BACK notice and keeps its place; the two that mean "not sent / can't tell" are the deck's unsure notices and go in that chat's
 * strip until you send again. `floating` is the old toast, used for the first kind. Returns nothing.
 */
export function reportSendFailure(sessionId: string, result: NativeSendResult | undefined, floating: (message: string) => void): void {
  const held = heldBackCopy(result);
  if (held) { floating(held); return; }
  // A missing acknowledgement MAY have run: checking is safer than automatic retry.
  raiseNotice(sessionId, 'warn', result ? 'send-failed-generic' : 'send-unconfirmed', result ? MESSAGE_NOT_SENT : MESSAGE_UNSURE, { leave: 'resolved' });
}
