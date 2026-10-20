import type { ChatAction, TimelineEntry } from './chat-types';

type PendingSendAction = Extract<ChatAction, { type: 'SEND_NOTE' | 'SEND_TRANSPORT' }>;

/** One still-pending bubble changes; confirmed history and unrelated entry identities stay intact. */
export function updatePendingSendEntry(timeline: TimelineEntry[], action: PendingSendAction): TimelineEntry[] | null {
  const index = timeline.findIndex(entry => entry.kind === 'user' && entry.pending === true && entry.sendId === action.sendId);
  if (index < 0) return null;
  const entry = timeline[index] as Extract<TimelineEntry, { kind: 'user' }>;
  let updated: typeof entry;
  if (action.type === 'SEND_TRANSPORT') {
    // WHY: only definite pre-dispatch unavailability moves a direct send onto PTY Enter recovery.
    if (entry.sendTransport === action.transport) return null;
    updated = { ...entry, sendTransport: action.transport };
  } else {
    if ((entry.sendNote ?? null) === action.note || (entry.sendNoteDismissed && action.note === 'unsure')) return null;
    const { sendNote: _old, ...rest } = entry;
    updated = action.note ? { ...rest, sendNote: action.note } : action.dismissed ? { ...rest, sendNoteDismissed: true } : rest;
  }
  const changed = timeline.slice(); changed[index] = updated;
  return changed;
}
