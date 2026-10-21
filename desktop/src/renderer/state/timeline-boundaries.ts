import type { SessionChatState, SystemMarker, TimelineEntry } from './chat-types';

/** WHY: the sender draws pending bubbles before the transcript confirms them.
 * Confirmed events must stay above that tail on every watching screen. */
export function appendAbovePending(timeline: TimelineEntry[], entry: TimelineEntry): TimelineEntry[] {
  let at = timeline.length;
  while (at > 0) {
    const prev = timeline[at - 1];
    if (prev.kind !== 'user' || prev.pending !== true) break;
    at--;
  }
  return [...timeline.slice(0, at), entry, ...timeline.slice(at)];
}

export function hasMarker(session: Pick<SessionChatState, 'timeline' | 'assistantTurns'>, markerId: string): boolean {
  return session.timeline.some(entry => entry.kind === 'system-marker' ? entry.marker.id === markerId
    : entry.kind === 'assistant-turn' && session.assistantTurns.get(entry.turnId)?.segments
      .some(segment => segment.type === 'system-marker' && segment.marker.id === markerId));
}

type MarkerAnchor = { turnId: string; index: number; timelineIndex?: number; toolCut?: { groupId: string; count: number } };

/** Exact page predecessor identity wins over clocks (including equal timestamps). */
export function markerAnchor(session: SessionChatState, uuid: string, toolUseId?: string): MarkerAnchor | undefined {
  const row = session.timeline.findIndex(entry => (entry.kind === 'user' && entry.uuid === uuid)
    || (entry.kind === 'skill-invocation' && entry.id === `skill-${uuid}`)
    || (entry.kind === 'system-marker' && entry.marker.id === `compact-done-${uuid}`));
  if (row >= 0) return { turnId: '', index: 0, timelineIndex: row };
  for (const [turnId, turn] of session.assistantTurns) {
    if (turn.sourceCompletionUuid === uuid) return { turnId, index: turn.segments.length };
    const index = turn.segments.findIndex(segment => (segment.type === 'text' || segment.type === 'reasoning')
      && (segment.sourceUuid === uuid || segment.lastSourceUuid === uuid));
    if (index >= 0) return { turnId, index: index + 1 };
    if (toolUseId) {
      for (let i = 0; i < turn.segments.length; i++) {
        const segment = turn.segments[i];
        if (segment.type !== 'tool-group') continue;
        const at = session.toolGroups.get(segment.groupId)?.toolIds.indexOf(toolUseId) ?? -1;
        if (at >= 0) return { turnId, index: i + 1, toolCut: { groupId: segment.groupId, count: at + 1 } };
      }
    }
  }
}

/** WHY: a divider changes presentation, never the tools/usage-owning logical turn. */
export function appendSystemMarker(session: SessionChatState, marker: SystemMarker, recorded = false, anchor?: MarkerAnchor): Pick<SessionChatState, 'timeline' | 'assistantTurns' | 'toolGroups' | 'currentGroupId'> {
  if (anchor?.timelineIndex !== undefined) {
    const at = anchor.timelineIndex + 1;
    return { timeline: [...session.timeline.slice(0, at), { kind: 'system-marker', marker }, ...session.timeline.slice(at)],
      assistantTurns: session.assistantTurns, toolGroups: session.toolGroups, currentGroupId: session.currentGroupId };
  }
  let turn = anchor ? session.assistantTurns.get(anchor.turnId)
    : session.currentTurnId ? session.assistantTurns.get(session.currentTurnId) : undefined;
  let index = anchor?.index;
  if (recorded && !anchor) {
    // WHY: late delivery is not source order; renderer wall time cannot locate a cut.
    for (const candidate of session.assistantTurns.values()) {
      const newer = candidate.segments.findIndex(segment => (segment.type === 'text' || segment.type === 'reasoning')
        && segment.sourceTimestamp !== undefined && segment.sourceTimestamp > marker.timestamp);
      const older = candidate.segments.some(segment => (segment.type === 'text' || segment.type === 'reasoning')
        && segment.sourceTimestamp !== undefined && segment.sourceTimestamp <= marker.timestamp);
      if (newer >= 0 && older) { turn = candidate; index = newer; break; }
    }
  }
  if (!turn) return { timeline: appendAbovePending(session.timeline, { kind: 'system-marker', marker }),
    assistantTurns: session.assistantTurns, toolGroups: session.toolGroups, currentGroupId: session.currentGroupId };
  index ??= turn.segments.length;
  let toolGroups = session.toolGroups;
  const following = turn.segments.slice(index);
  let continuationGroup: string | undefined;
  if (anchor?.toolCut) {
    const { groupId, count } = anchor.toolCut;
    const group = toolGroups.get(groupId);
    if (group && count < group.toolIds.length) {
      // WHY: recover a late boundary by splitting grouping, not tool/permission IDs.
      continuationGroup = `${groupId}:after:${marker.id}`;
      toolGroups = new Map(toolGroups);
      toolGroups.set(groupId, { ...group, toolIds: group.toolIds.slice(0, count) });
      toolGroups.set(continuationGroup, { id: continuationGroup, toolIds: group.toolIds.slice(count) });
      following.unshift({ type: 'tool-group', groupId: continuationGroup });
    }
  }
  const assistantTurns = new Map(session.assistantTurns);
  assistantTurns.set(turn.id, { ...turn, presentationReferences: true,
    segments: [...turn.segments.slice(0, index), { type: 'system-marker', marker }, ...following] });
  let timeline: TimelineEntry[];
  if (following.length || (anchor && turn.id !== session.currentTurnId)) {
    // WHY: a completed older turn's boundary must precede the newer live turn.
    const preceding = turn.segments.slice(0, index).reverse().find(segment => segment.type === 'system-marker');
    const row = session.timeline.reduce((found, entry, i) => entry.kind === 'assistant-turn' && entry.turnId === turn!.id
      && entry.afterMarkerId === (preceding?.type === 'system-marker' ? preceding.marker.id : undefined) ? i : found, -1);
    const inserts: TimelineEntry[] = [{ kind: 'system-marker', marker },
      ...(following.length ? [{ kind: 'assistant-turn' as const, turnId: turn.id, afterMarkerId: marker.id }] : [])];
    timeline = [...session.timeline.slice(0, row + 1), ...inserts, ...session.timeline.slice(row + 1)];
  } else {
    timeline = appendAbovePending(session.timeline, { kind: 'system-marker', marker });
  }
  const currentGroupId = continuationGroup && session.currentGroupId === anchor?.toolCut?.groupId ? continuationGroup
    : turn.id === session.currentTurnId ? null : session.currentGroupId;
  return { timeline, assistantTurns, toolGroups, currentGroupId };
}

export function matchingCompaction(session: SessionChatState, operationId: string | undefined, recorded = false): boolean {
  const pending = session.compactionPending;
  if (!pending) return false;
  if (operationId !== undefined) return operationId === pending.id;
  // WHY: restoring an old summary must not retire a newer identified operation.
  // Anonymous legacy local outcomes remain supported only outside host ownership.
  return !pending.id || (!recorded && !pending.hostOwned);
}
