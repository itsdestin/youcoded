// stale-sends.ts — stop waiting forever for a sent message's echo (Destin, 2026-11-18: "the message just being pinned there forever doesn't make sense").
//
// A message the person sends is drawn at once as a "pending" bubble, held at the bottom of the chat until Claude Code's record of it (the echo)
// arrives and confirms it. If the echo never matches — a matching bug (a picture sent with no words was one, fixed in transcript-event-actions.ts)
// or a message that truly got lost — the bubble used to sit under every later reply for good. Two rules end that, each from what this screen knows:
//
//  1. SETTLE (after SETTLE_BOUND_MS): the computer's queue has already said which recorded line the message became (`boundUuid`). Claude Code HAS it;
//     only this screen failed to pair them. The bubble becomes an ordinary sent message, put back above the reply that answered it. No note: it was
//     delivered, and saying otherwise would invite a duplicate "Send again".
//  2. GIVE UP (after GIVE_UP_MS): no sign of it at all. The bubble says "Not sure this was sent." (the existing note, with Send again / Dismiss) and is
//     no longer held at the bottom, so later messages go below it. It stays pending: if the echo turns up late it still confirms the bubble and the
//     note clears, as notes always have (chat-reducer TRANSCRIPT_USER_MESSAGE).
//
// Why these times: an idle conversation records a message within a second or two (measured in the dev copy 2026-11-18), and a busy one moves the
// message into the queue strip instead of keeping a bubble (queue-bubbles.ts). Half a minute without an echo is far past any delivery seen; the note is
// worded as doubt, never as failure, because a slow delivery is still possible. The bound case can be quick: the record already exists.
import type { SessionChatState, TimelineEntry } from './chat-types';

export const SETTLE_BOUND_MS = 10_000;
// 30 s: Destin's pick (pinned-bubbles-review#Q-1, 2026-11-18) over the proposed 60 s.
export const GIVE_UP_MS = 30_000;
/** How far from the end to look. Pending bubbles live at (or, once stale, near) the end; this keeps the periodic check cheap on long chats. */
const SCAN_TAIL = 60;

type UserEntry = Extract<TimelineEntry, { kind: 'user' }>;

/** The bubbles of one conversation that are due for a rule, by message id. Empty when nothing is due (the common case). */
export function dueStaleSends(timeline: readonly TimelineEntry[], now: number): string[] {
  const out: string[] = [];
  for (let i = timeline.length - 1; i >= 0 && i >= timeline.length - SCAN_TAIL; i--) {
    const e = timeline[i];
    if (e.kind !== 'user' || e.pending !== true) continue;
    const age = now - e.message.timestamp;
    if ((e.boundUuid && age >= SETTLE_BOUND_MS) || (!e.sendStale && age >= GIVE_UP_MS)) out.push(e.message.id);
  }
  return out;
}

/**
 * The reducer's SENDS_STALE: the conversation with the rules applied, or null when nothing changed. A give-up also stops a thinking spinner that
 * only that send started, the same as a refused send (the reducer passes its `spinnerWithNoTurn`); a settle leaves turn state alone, since the
 * message was delivered and a reply may be running.
 */
export function reduceSendsStale(session: SessionChatState, messageIds: readonly string[], now: number,
  spinnerWithNoTurn: (s: SessionChatState) => Partial<SessionChatState>): SessionChatState | null {
  const result = applyStaleSends(session, messageIds, now);
  if (!result) return null;
  return { ...session, timeline: result.timeline, ...(result.settledAny ? {} : spinnerWithNoTurn(session)) };
}

/**
 * Apply the rules to the named bubbles. Returns null when nothing changed (a bubble confirmed meanwhile, or already handled).
 * `seenUuids` is updated in place, as everywhere else in the reducer (performance rule 4).
 */
function applyStaleSends(session: SessionChatState, messageIds: readonly string[], now: number): { timeline: TimelineEntry[]; settledAny: boolean } | null {
  let timeline = session.timeline as TimelineEntry[];
  let changed = false;
  let settledAny = false;
  for (const id of messageIds) {
    const idx = timeline.findIndex(e => e.kind === 'user' && e.pending === true && e.message.id === id);
    if (idx < 0) continue;
    const entry = timeline[idx] as UserEntry;
    const age = now - entry.message.timestamp;
    if (entry.boundUuid && age >= SETTLE_BOUND_MS) {
      const uuid = entry.boundUuid;
      const rest = [...timeline.slice(0, idx), ...timeline.slice(idx + 1)];
      // The recorded copy is already on screen as its own row: this bubble is a duplicate of it.
      if (rest.some(e => e.kind === 'user' && e.uuid === uuid)) { timeline = rest; changed = true; continue; }
      session.seenUuids.add(uuid); // a late echo of the same line must not draw a second copy
      const settled: TimelineEntry = { kind: 'user', message: entry.message, pending: false, uuid };
      timeline = insertSettled(rest, idx, settled, entry.sentAfterTurn);
      changed = true; settledAny = true;
      continue;
    }
    if (entry.sendStale || age < GIVE_UP_MS) continue;
    // A refused draft already says it did not send; a dismissed doubt is not raised again; a bubble with no sendId has no buttons to offer;
    // a slash command often gets no echo at all by design, and "Send again" would run it twice (code review, 2026-11-18).
    const quiet = entry.sendNote || entry.sendRefused || entry.sendNoteDismissed || !entry.sendId || entry.message.content.trimStart().startsWith('/');
    const note = quiet ? {} : { sendNote: 'unsure' as const };
    const updated: UserEntry = { ...entry, ...note, sendStale: true };
    timeline = timeline.slice(); timeline[idx] = updated;
    changed = true;
  }
  return changed ? { timeline, settledAny } : null;
}

/**
 * Where a settled bubble goes: straight after the reply it was drawn after (`sentAfterTurn`), so everything that arrived while it sat
 * pinned — its own answer, later messages — reads below it, in the order it happened. By identity, never by clock. No record (a bubble
 * from before this field existed, or its reply scrolled out of a page) leaves it where it is.
 */
function insertSettled(timeline: TimelineEntry[], at: number, entry: TimelineEntry, after: string | undefined): TimelineEntry[] {
  let place = at;
  if (after === '') {
    const first = timeline.findIndex(e => e.kind === 'assistant-turn');
    if (first >= 0 && first < at) place = first;
  } else if (after !== undefined) {
    const anchor = timeline.findIndex(e => e.kind === 'assistant-turn' && e.turnId === after);
    if (anchor >= 0 && anchor < at) place = anchor + 1;
  }
  return [...timeline.slice(0, place), entry, ...timeline.slice(place)];
}
