// Which messages keep their time on a phone (card #213, density-review D-5).
//
// WHY (Destin, 2026-11-02: "there's a smarter/smoother way to hide times on old messages while allowing users to see
// them when needed"): on a phone every bubble's time line costs about a line of text. A time is worth its line only where
// it tells you something new — the newest message ("how long ago was this?"), and the first message after a break
// ("this part was later / another day"). Every other time is hidden on a phone, and a tap on the message shows it
// (ChatTimelineRow). The computer is unchanged: phone-density.css hides nothing above the phone breakpoint.
import type { AssistantTurn, TimelineEntry } from './chat-types';
import { timelineEntryKey } from './first-draw-plan';

/** A pause this long starts a new part of the conversation, so its first message keeps its time. */
export const TIME_BREAK_MS = 30 * 60 * 1000;

function timeOf(entry: TimelineEntry, turns: ReadonlyMap<string, AssistantTurn>): number | undefined {
  if (entry.kind === 'user') return entry.message.timestamp;
  if (entry.kind === 'assistant-turn') return turns.get(entry.turnId)?.timestamp;
  return undefined;
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** The keys (timelineEntryKey) of the messages whose time stays visible on a phone. */
export function messageTimeMarks(timeline: readonly TimelineEntry[], turns: ReadonlyMap<string, AssistantTurn>): Set<string> {
  const keep = new Set<string>();
  let prev: number | undefined;
  let lastKey: string | null = null;
  for (const entry of timeline) {
    const t = timeOf(entry, turns);
    if (t === undefined) continue;
    const key = timelineEntryKey(entry);
    if (key === null) continue;
    if (prev === undefined || t - prev >= TIME_BREAK_MS || !sameDay(prev, t)) keep.add(key);
    prev = t;
    lastKey = key;
  }
  if (lastKey !== null) keep.add(lastKey);
  return keep;
}
