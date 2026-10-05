// phone-actions.ts — the instant buttons of a phone (one-core R6-2): Stop and a permission answer. Close and the permission-mode chip live in App (they change
// App's own lists) and Send in submit-outgoing.ts; all five go through the one helper in pending-action.ts.
//
// Each function does exactly what the button did before whenever this screen is the computer's own window (local IPC, the round trip is invisible) and
// does the instant version only on a phone, or on the Android app paired to a computer.
import type { ChatAction, SessionChatState } from './chat-types';
import { announce } from '../utils/announce';
import { runPending, optimisticScreen, connected } from './pending-action';

/** A reply-less Stop waits this long for the record to show the turn ended before it asks the computer. */
export const STOP_SETTLE_MS = 8000;

/** What Stop needs to read from the record: is the turn still running, and tell me when the screen's copy changes. */
export interface TurnWatch { running(): boolean; subscribe(notify: () => void): () => void }

/**
 * Stop the turn. On a phone the button changes at once (the helper's `stop:<session>` mark, which the button draws as "stopping") and the stop is sent; the
 * record's own end of the turn drops the mark and nothing is drawn twice, because the mark is not a timeline entry: the "Interrupted" line still comes only
 * from the transcript's interrupt event. If the turn is still running after STOP_SETTLE_MS (and a look at the record), the mark goes and the person is told.
 */
export function stopTurn(o: { sessionId: string; provider: 'claude' | 'native' | undefined; turn?: TurnWatch | null }): void {
  const write = () => {
    // Native sessions have no PTY: interrupt the in-process stream. Claude Code gets the single ESC byte the physical key sends.
    if (o.provider === 'native') window.claude.native.interrupt(o.sessionId);
    else window.claude.session.sendInput(o.sessionId, '\x1b');
  };
  const turn = o.turn;
  if (!optimisticScreen() || !turn) { write(); return; }
  // A person's action is never held for later (contract row R2): say it was not sent, and let them press it again.
  if (!connected()) { announce("Not connected — Stop wasn't sent. Press it again once you're back online."); return; }
  void runPending({
    key: `stop:${o.sessionId}`,
    sessionId: o.sessionId,
    // The change IS the helper's mark (usePendingKeys('stop:')): the button reads it and shows "stopping".
    apply() {},
    send() { write(); return 'sent'; },
    observe: { done: () => !turn.running(), subscribe: turn.subscribe },
    check: () => (turn.running() ? 'absent' : 'present'),
    undo(reason) {
      announce(reason.kind === 'refused'
        ? "Stop didn't go through. Press it again."
        : "Your computer hasn't confirmed the stop. If the assistant is still working, press Stop again.");
    },
    settleAfterMs: STOP_SETTLE_MS,
  });
}

/**
 * Answer a permission card (Yes / No / Always allow). On a phone the card is drawn as answered at once; the computer's reply, or the record, then decides:
 * `true` keeps it, `false` ("that request is already closed") puts the card back and expires it the way the computer's own card does, a rejection puts it back
 * with "couldn't confirm", and a reply that never came leaves it waiting until the record is asked. A re-announce of the same ask while the answer is on its way
 * is ignored (state/permission-answer.ts), so the card is never drawn twice. Returns false when this screen is not a phone: the card then answers the old way.
 */
export function answerPermission(o: {
  sessionId: string; requestId: string; decision: object;
  dispatch: (a: ChatAction) => void;
  /** The screen's tool map as the record last filled it. */
  tools: () => SessionChatState['toolCalls'];
  /** Tell the other screens (the same `remote.broadcastAction` the card's own answer path uses). */
  broadcast?: (a: ChatAction) => void;
}): boolean {
  if (!optimisticScreen() || !connected()) return false;
  const { sessionId, requestId } = o;
  const step = (s: 'pending' | 'waiting' | 'settled' | 'undone', unconfirmed?: boolean) => o.dispatch({ type: 'PERMISSION_ANSWER', sessionId, requestId, step: s, ...(unconfirmed ? { unconfirmed } : {}) });
  let closed = false;
  void runPending({
    key: `perm:${requestId}`,
    sessionId,
    apply: () => step('pending'),
    async send() {
      try {
        const delivered = await window.claude.session.respondToPermission(requestId, o.decision);
        // The computer says the request is already closed: that one IS expired (the same as the card's own path).
        if (delivered === false) { closed = true; return { undo: { kind: 'refused' as const } }; }
        return 'answered';
      } catch (err) {
        // The reply was lost (a drop, a timeout): the computer MAY have it. From now on a re-announce of this ask is evidence it is still open.
        if ((err as { outcomeUnknown?: boolean } | null)?.outcomeUnknown) step('waiting');
        throw err;
      }
    },
    confirm() {
      step('settled');
      o.broadcast?.({ type: 'PERMISSION_RESPONDED', sessionId, requestId });
    },
    undo() {
      step('undone', !closed);
      if (closed) {
        const expired: ChatAction = { type: 'PERMISSION_EXPIRED', sessionId, requestId, reason: 'delivery-failed' };
        o.dispatch(expired);
        o.broadcast?.(expired);
      }
    },
    // The record's list of open asks (the end of a fill, `reconcileAnswers`) has already put the card back or dropped the mark. A mark that is STILL here means no
    // list arrived (the fill did not carry one): that is not confirmation, so it throws (retry, then the card goes back, answerable).
    needsResume: true,
    check() {
      const tools = [...o.tools().values()];
      if (tools.some((t) => t.answerPending?.requestId === requestId)) throw new Error('the computer has not said whether it still has the question');
      return tools.some((t) => t.status === 'awaiting-approval' && t.requestId === requestId) ? 'absent' : 'present';
    },
    settleAfterMs: 7000,
  });
  return true;
}
