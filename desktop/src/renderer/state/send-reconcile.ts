// send-reconcile.ts — after a connection drop, ask the computer what became of the messages this screen sent (one-core R5-4b).
//
// A message that has no echo yet and carries a send id is "unconfirmed". The computer's record notes every id it received, so for each unconfirmed
// send it answers: received (the note clears itself), provably not received ("This didn't send", Send again), or it cannot tell ("Not sure this was
// sent", Send again). Pure of React: the hook that runs it is hooks/useSendReconcile.ts.
import type { SendOutcomesReply } from '../../shared/send-outcome-types';
import { noteFor } from './send-ids';

/** Ask for a fresh check now (a send whose answer never came, on a connection that may be fine). */
export const SEND_CHECK_EVENT = 'youcoded:check-sends';

export interface ReconcileDeps {
  /** The sends with no echo yet, per conversation. */
  unconfirmed(): Array<{ sessionId: string; sendId: string }>;
  /** What the computer's record says; undefined when this screen has no host record to ask (nothing can be lost on a network there). */
  ask(sessionId: string, ids: string[]): Promise<SendOutcomesReply | undefined>;
  /** Say it on the message. */
  apply(sessionId: string, sendId: string, note: 'unsure' | 'not-sent' | null): void;
}

/** Check every unconfirmed send. Never throws and never sends anything: a failed ask leaves the notes as they are. */
export async function reconcileSends(deps: ReconcileDeps): Promise<void> {
  const bySession = new Map<string, string[]>();
  for (const u of deps.unconfirmed()) {
    const ids = bySession.get(u.sessionId) ?? [];
    ids.push(u.sendId);
    bySession.set(u.sessionId, ids);
  }
  await Promise.all([...bySession].map(async ([sessionId, ids]) => {
    let reply: SendOutcomesReply | undefined;
    try { reply = await deps.ask(sessionId, ids); } catch { return; }
    if (!reply?.outcomes) return;
    for (const id of ids) {
      const outcome = reply.outcomes[id];
      if (outcome) deps.apply(sessionId, id, noteFor(outcome));
    }
  }));
}
