// Try again on the in-chat "Couldn't compact / clear" card (waiting-notice T4).
//
// WHY here and not in the timeline entry: the entry is data only (it must serialise and survive a fill reset), so the card's
// button is wired by the renderer from the entry's `op`. The card leaves once the retry WORKS (deck R-card "goes"); a retry
// that fails raises a fresh card in its place (runNativeSlashAction does that itself), so there is never a stale one beside it.
import type React from 'react';
import { getCapabilities } from '../platform';
import type { ChatAction, ControlFailureOp, SessionChatState } from './chat-types';
import { runNativeSlashAction } from './native-slash-actions';

export async function retryControlFailure(
  sessionId: string, op: ControlFailureOp, dispatch: React.Dispatch<ChatAction>,
  getSession?: (id: string) => SessionChatState | undefined,
): Promise<boolean> {
  // Same as typing /compact: draw the working card first, unless the computer's record draws it for every screen.
  // The card id doubles as the operation id, so a failed retry ends exactly the spinner this retry drew.
  const cardId = `compact-${Date.now()}`;
  const draws = op === 'compact' && !getCapabilities().sessionRecord;
  if (draws) dispatch({ type: 'COMPACTION_PENDING', sessionId, cardId, beforeContextTokens: null, awaitsResult: true });
  const operationId = draws ? cardId : getSession?.(sessionId)?.compactionPending?.id;
  const ok = await runNativeSlashAction({ kind: op }, { sessionId, dispatch, getSession, compactionOperationId: operationId });
  if (ok) dispatch({ type: 'CONTROL_FAILURE_CLEARED', sessionId, op });
  return ok;
}
