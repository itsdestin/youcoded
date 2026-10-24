import type { TimelineEntry } from './chat-types';

/**
 * Bring this screen's instant queue bubbles in line with the host's queue (WHY: 2026-10-22, the bubble is drawn at Send).
 * - The strip now lists the send (it waited, was paused, or is unconfirmed): the strip row takes the bubble's place.
 * - The host says which transcript line the send became: the bubble is confirmed by that identity, or, when that line
 *   already arrived as its own entry (the words differed), the now-duplicate bubble goes.
 * Returns the same array when nothing changes.
 */
export function reconcileQueueBubbles(timeline: TimelineEntry[], queue: readonly { sendId?: string }[], bound: readonly { sendId: string; uuid: string }[] | undefined): { timeline: TimelineEntry[]; movedToStrip: boolean } {
  if (!timeline.some((e) => e.kind === 'user' && e.pending === true && e.sendTransport === 'queue')) return { timeline, movedToStrip: false };
  let movedToStrip = false;
  const listed = new Set(queue.map((q) => q.sendId).filter((id): id is string => !!id));
  const uuidOf = new Map((bound ?? []).map((b) => [b.sendId, b.uuid]));
  let out: TimelineEntry[] | null = null;
  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i];
    if (e.kind !== 'user' || e.pending !== true || e.sendTransport !== 'queue' || !e.sendId) { out?.push(e); continue; }
    const uuid = uuidOf.get(e.sendId);
    const toStrip = listed.has(e.sendId);
    if (toStrip || (!!uuid && timeline.some((x) => x.kind === 'user' && x.uuid === uuid))) { movedToStrip ||= toStrip; out ??= timeline.slice(0, i); continue; }
    if (uuid && e.boundUuid !== uuid) { out ??= timeline.slice(0, i); out.push({ ...e, boundUuid: uuid }); continue; }
    out?.push(e);
  }
  return { timeline: out ?? timeline, movedToStrip };
}

/** The pending queue bubble the host bound to this transcript line, or -1. */
export function boundPendingIndex(timeline: TimelineEntry[], uuid: string | undefined): number {
  return uuid ? timeline.findIndex((e) => e.kind === 'user' && e.pending === true && e.boundUuid === uuid) : -1;
}

/** A recorded user message as a timeline message. Files from a queue send's "Attached:" lines draw as chips, the same
 *  shape the sender's own bubble has (content = the paths space-joined, then the words; see UserMessage). */
export function recordedUserMessage(id: string, action: { text: string; timestamp: number; attachedFiles?: string[] }) {
  const files = action.attachedFiles?.length ? action.attachedFiles : undefined;
  return { id, role: 'user' as const, content: files ? [...files, action.text].filter(Boolean).join(' ') : action.text, timestamp: action.timestamp, ...(files ? { attachments: files } : {}) };
}
