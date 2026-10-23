// useSendReconcile — say on a message whether the computer got it, after the connection dropped (one-core R5-4b).
//
// Runs on a reconnect (the shim's REMOTE_RECONNECTED_EVENT), when the shim reports a request that never got its answer (OUTCOME_UNKNOWN_EVENT, for a
// message sent as a request) and when a send asks for a check itself (SEND_CHECK_EVENT). Each time it asks the computer's record about every message this
// screen sent that has no echo yet; the answer goes onto the message (state/send-reconcile.ts). It never sends anything: "Send again" is the person's.
import { useEffect, useRef } from 'react';
import { useChatDispatch, useChatStore } from '../state/chat-context';
import { REMOTE_RECONNECTED_EVENT, OUTCOME_UNKNOWN_EVENT } from '../remote-events';
import { reconcileSends, SEND_CHECK_EVENT } from '../state/send-reconcile';
import { settleSavedQueueSends } from '../state/submit-outgoing';

export function useSendReconcile(): void {
  const dispatch = useChatDispatch();
  const store = useChatStore();
  const busy = useRef(false);
  const again = useRef(false);

  useEffect(() => {
    const run = async () => {
      // One check at a time; a request that arrives meanwhile runs once more afterwards (it may carry a newer send).
      if (busy.current) { again.current = true; return; }
      busy.current = true;
      try {
        do {
          again.current = false;
          // A queue send's saved request is settled against the queue itself (cause 4); its instant bubble, when drawn, is
          // confirmed by the queue's sendId binding (queue-bubbles.ts), not by this check.
          await settleSavedQueueSends();
          await reconcileSends({
            unconfirmed: () => {
              const out: Array<{ sessionId: string; sendId: string }> = [];
              for (const [sessionId, session] of store.getState()) {
                for (const e of session.timeline) if (e.kind === 'user' && e.pending === true && e.sendId) out.push({ sessionId, sendId: e.sendId });
              }
              return out;
            },
            ask: (sessionId, ids) => {
              const ask = (window.claude?.session as { sendOutcomes?: (s: string, i: string[]) => Promise<any> } | undefined)?.sendOutcomes;
              return ask ? ask(sessionId, ids) : Promise.resolve(undefined);
            },
            apply: (sessionId, sendId, note) => dispatch({ type: 'SEND_NOTE', sessionId, sendId, note }),
          });
        } while (again.current);
      } finally { busy.current = false; }
    };
    const onEvent = () => { void run(); };
    // Another request type's lost answer (a permission answer, a tag) has no message to speak for: only a chat message names a `sendId`.
    const onOutcome = (e: Event) => { if ((e as CustomEvent).detail?.sendId) void run(); };
    // The answer is what counts, wherever the echo is: if it arrives in the reconnect's fill, the reducer drops the note by itself.
    // At start too: a send saved before the app was closed would otherwise wait for the first drop to be looked at.
    // Only the saved sends: at start no bubble has an answer outstanding yet.
    void settleSavedQueueSends();
    window.addEventListener(REMOTE_RECONNECTED_EVENT, onEvent);
    window.addEventListener(OUTCOME_UNKNOWN_EVENT, onOutcome);
    window.addEventListener(SEND_CHECK_EVENT, onEvent);
    return () => {
      window.removeEventListener(REMOTE_RECONNECTED_EVENT, onEvent);
      window.removeEventListener(OUTCOME_UNKNOWN_EVENT, onOutcome);
      window.removeEventListener(SEND_CHECK_EVENT, onEvent);
    };
  }, [dispatch, store]);
}
