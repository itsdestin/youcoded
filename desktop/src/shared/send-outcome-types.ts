// send-outcome-types.ts — "did the computer get my message?" (one-core R5-4b, Destin approved 2026-10-01: the lost-send note).
//
// WHY: a message sent from a phone goes out as a fire-and-forget write (a Claude Code session) or a request whose answer can be lost
// (a native session). If the connection dies at that moment the phone does not know whether the computer ever got it. Each send now carries an id the
// phone makes up; the computer's record notes the ids it received; on reconnect the phone asks the record about its sends it has no echo for, and says
// what it learned on the message itself instead of guessing. Never resent automatically: a resend is the person's decision (a duplicate is worse).
//
// Types and the id rule only: nothing here runs. In shared/ because the renderer, the preload and main all read them.

/**
 * What the computer's record can say about one send id:
 *  - `received`: the computer got it (a native session's host accepted it; a Claude Code session's terminal write was accepted);
 *  - `not-received`: the record covers the time and has no such id, so the computer never got it;
 *  - `unknown`: the record cannot say (the computer restarted, the record is another one, or older ids were let go).
 */
export type SendOutcome = 'received' | 'not-received' | 'unknown';

/** What a phone may put in an id: short, plain, no surprises when it is stored or echoed. */
const SEND_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
export const isSendId = (v: unknown): v is string => typeof v === 'string' && SEND_ID_RE.test(v);

/** Most ids asked about in one request. */
export const SEND_OUTCOMES_MAX_IDS = 50;

export interface SendOutcomesReply {
  /** The record's epoch now (null when the session has no record), so the caller can tell a restarted computer from a quiet one. */
  epoch: string | null;
  outcomes: Record<string, SendOutcome>;
}
