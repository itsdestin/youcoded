import type { TranscriptEvent } from '../../shared/types';
import type { AssistantTurnSegment, SessionChatState } from './chat-types';

type TextEvent = Extract<TranscriptEvent, { type: 'assistant-text' | 'assistant-thinking' }> & { data: { text: string } };
const isSourceText = (event: TranscriptEvent): event is TextEvent =>
  (event.type === 'assistant-text' || event.type === 'assistant-thinking') && typeof event.data.text === 'string' && !event.data.parentAgentToolUseId;
type Reference = { eventUuid: string; start: number; end: number };

function references(event: TextEvent): Reference[] {
  const refs = event.data.deltaReferences;
  if (refs === undefined) return [{ eventUuid: event.uuid, start: 0, end: event.data.text.length }];
  if (!Array.isArray(refs)) return [];
  let end = 0;
  const seen = new Set<string>();
  // WHY: disk witnesses are untrusted. Only a complete, contiguous UUID/offset
  // proof can reconcile coalesced text with live deltas; partId alone repeats.
  for (const ref of refs) {
    if (!ref || typeof ref.eventUuid !== 'string' || !ref.eventUuid || seen.has(ref.eventUuid) || ref.start !== end
      || !Number.isSafeInteger(ref.end) || ref.end < end || ref.end > event.data.text.length) return [];
    seen.add(ref.eventUuid);
    end = ref.end;
  }
  return refs[0]?.eventUuid === event.uuid && end === event.data.text.length ? refs : [];
}

/** Page-only work: recover exact source parts without copying growing per-word maps. */
export function reconcilePageSources(session: SessionChatState, events: TranscriptEvent[]): {
  session: SessionChatState; events: TranscriptEvent[];
} {
  const texts = events.filter(isSourceText);
  const witnesses = texts.map(references);
  const endpoints = new Map<string, { index: number; ref: Reference }>();
  witnesses.forEach((refs, index) => refs.forEach(ref => endpoints.set(ref.eventUuid, { index, ref })));
  let turns = session.assistantTurns;
  for (const [id, turn] of session.assistantTurns) {
    let changed = false;
    const segments: AssistantTurnSegment[] = turn.segments.flatMap(segment => {
      if ((segment.type !== 'text' && segment.type !== 'reasoning') || !segment.sourceUuid || !segment.lastSourceUuid) return [segment];
      const first = endpoints.get(segment.sourceUuid);
      const last = endpoints.get(segment.lastSourceUuid);
      if (!first || !last || first.index > last.index) return [segment];
      const sources = texts.slice(first.index, last.index + 1);
      // WHY: reasoning and answer parts can reuse IDs, but are not one stream.
      if (sources.some(source => source.type !== (segment.type === 'text' ? 'assistant-text' : 'assistant-thinking'))) return [segment];
      if (sources.length === 1 && first.ref.start === 0 && sources[0].data.text === segment.content) {
        // WHY: the host's fill tail coalesces words under the FIRST UUID too.
        // Exact whole-part content plus its persisted witness proves the other
        // delta UUIDs are already displayed, even if the tail never sent them.
        const refs = witnesses[first.index];
        refs.forEach(ref => session.seenUuids.add(ref.eventUuid));
        const lastUuid = refs.at(-1)!.eventUuid;
        if (segment.lastSourceUuid === lastUuid) return [segment];
        changed = true;
        return [{ ...segment, lastSourceUuid: lastUuid }];
      }
      const expected = sources.map((source, i) => witnesses[first.index + i]
        .filter(ref => session.seenUuids.has(ref.eventUuid)
          && (i !== 0 || ref.start >= first.ref.start)
          && (i !== sources.length - 1 || ref.end <= last.ref.end))
        .map(ref => source.data.text.slice(ref.start, ref.end)).join('')).join('');
      if (expected !== segment.content) return [segment];
      changed = true;
      return sources.map((source, i) => {
        const refs = witnesses[first.index + i];
        refs.forEach(ref => session.seenUuids.add(ref.eventUuid));
        return { ...segment, content: source.data.text,
          messageId: i === 0 ? segment.messageId : `${segment.messageId}:source:${source.uuid}`,
          partId: source.data.partId, sourceUuid: source.uuid, sourceTimestamp: source.timestamp,
          lastSourceUuid: refs.at(-1)!.eventUuid, lastSourceTimestamp: source.timestamp };
      });
    });
    if (changed) {
      if (turns === session.assistantTurns) turns = new Map(turns);
      turns.set(id, { ...turn, segments });
    }
  }
  // Page-first replay records every witnessed delta UUID too, so later live
  // fragments do not append a second copy of an already persisted whole part.
  const expanded = events.flatMap<TranscriptEvent>((event): TranscriptEvent[] => {
    if (!isSourceText(event)) return [event];
    const refs = references(event);
    return refs.length ? refs.map(ref => ({ ...event, uuid: ref.eventUuid,
      data: { ...event.data, text: event.data.text.slice(ref.start, ref.end), deltaReferences: undefined } })) : [event];
  });
  return { session: turns === session.assistantTurns ? session : { ...session, assistantTurns: turns }, events: expanded };
}
