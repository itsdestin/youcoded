// permission-answer.ts — the chat state's side of an instant permission answer on a phone (one-core R6-2).
//
// WHY (Destin, 2026-09-24 plan): pressing Yes / No / Always allow on a phone used to leave the card on screen, buttons greyed, until the
// computer's reply came back (a tailnet round trip). Now the card is drawn as answered at once and carries `answerPending` until the computer
// confirms. Three things must hold, and each is a rule below:
//   1. the answer is drawn once: while it is on its way, the computer's re-announce of the same ask (it repeats every open ask on a beat, and one
//      sent before our answer landed is still in the air) must NOT draw the card again;
//   2. if the computer refuses, or the answer got no reply and the record still lists the ask as open, the card goes back exactly as it was;
//   3. a record that no longer lists the ask confirms the answer (nothing to draw: the card is already answered).
// Pure functions over the tool map, called by the chat reducer; they return the same map when nothing changed.
import type { ToolCallState } from '../../shared/types';

type Tools = Map<string, ToolCallState>;
const isBudgetGate = (t: ToolCallState) => t.toolName === 'max_steps' || t.toolName === 'doom_loop';

/** The id of the card holding this pending answer, or null. */
function holder(tools: Tools, requestId: string): string | null {
  // (A request id is required: an ask announced with none must never match a card that holds no pending answer.)
  for (const [id, t] of tools) if (t.answerPending && t.answerPending.requestId === requestId) return id;
  return null;
}

/** Draw the answer: the awaiting card becomes an answered (running) one, keeping the id for an undo. */
function answerPending(tools: Tools, requestId: string): Tools | null {
  for (const [id, t] of tools) {
    if (t.status !== 'awaiting-approval' || t.requestId !== requestId) continue;
    const next = new Map(tools);
    // Same as PERMISSION_RESPONDED: a budget gate has no tool behind it, so no result will ever close it.
    next.set(id, { ...t, status: isBudgetGate(t) ? 'complete' : 'running', requestId: undefined, answerPending: { requestId, inFlight: true }, answerUnconfirmed: undefined });
    return next;
  }
  return null;
}

/** The answer's reply was lost (a drop, a timeout): it is no longer "on its way", so a re-announce of the ask is evidence the computer still has it open. */
function answerWaiting(tools: Tools, requestId: string): Tools | null {
  const id = holder(tools, requestId);
  if (!id) return null;
  const t = tools.get(id)!;
  if (!t.answerPending!.inFlight) return null;
  return new Map(tools).set(id, { ...t, answerPending: { requestId, inFlight: false } });
}

/** The computer confirmed: drop the mark; the card stays answered. */
function answerSettled(tools: Tools, requestId: string): Tools | null {
  const id = holder(tools, requestId);
  if (!id) return null;
  const { answerPending: _drop, ...rest } = tools.get(id)!;
  return new Map(tools).set(id, rest);
}

/**
 * Put the card back: the computer refused, or its record still shows the ask open. Only a card that is still just "answered, not yet run"
 * comes back: a tool whose result already arrived proves the computer got the answer, and is left alone.
 */
function answerUndone(tools: Tools, requestId: string, unconfirmed: boolean): Tools | null {
  const id = holder(tools, requestId);
  if (!id) return null;
  const t = tools.get(id)!;
  const { answerPending: _drop, ...rest } = t;
  const stillAnswered = t.status === 'running' || (t.status === 'complete' && isBudgetGate(t));
  if (!stillAnswered) return new Map(tools).set(id, rest);
  return new Map(tools).set(id, { ...rest, status: 'awaiting-approval', requestId, ...(unconfirmed ? { answerUnconfirmed: true } : {}) });
}

/**
 * The computer announced this ask (a live beat, or a fill's list of asks still open) while the screen holds an answer for it.
 *   - `ignore`: our answer is still on its way, so this announcement is older than it: change nothing (the card must not come back);
 *   - a map: the answer is no longer on its way and the computer STILL lists the ask: it never got the answer. The card comes back, and says it
 *     could not confirm the answer (the same sentence the computer's own card says);
 *   - null: this screen holds no answer for that ask (the ordinary path).
 */
export function reannounced(tools: Tools, requestId: string): 'ignore' | Tools | null {
  const id = holder(tools, requestId);
  if (!id) return null;
  if (tools.get(id)!.answerPending!.inFlight) return 'ignore';
  return answerUndone(tools, requestId, true);
}

/** One step of an answer's life (the chat reducer's PERMISSION_ANSWER): the new tool map, or null when nothing changes. */
export function answerStep(tools: Tools, a: { requestId: string; step: 'pending' | 'waiting' | 'settled' | 'undone'; unconfirmed?: boolean }): Tools | null {
  return a.step === 'pending' ? answerPending(tools, a.requestId)
    : a.step === 'waiting' ? answerWaiting(tools, a.requestId)
    : a.step === 'settled' ? answerSettled(tools, a.requestId)
    : answerUndone(tools, a.requestId, a.unconfirmed === true);
}
