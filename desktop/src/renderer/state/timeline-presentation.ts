import { abnormalStopReason, type AssistantTurn, type AssistantTurnSegment, type SystemMarker, type TimelineEntry } from './chat-types';

type Boundary = { type: 'system-marker'; marker: SystemMarker };
export interface TimelinePresentation {
  timeline: readonly TimelineEntry[];
  assistantTurns: ReadonlyMap<string, AssistantTurn>;
  /** Logical turn -> its final visible chunk. Streaming belongs only there. */
  tailTurnIds: ReadonlyMap<string, string>;
}
type Chunk = { entry: TimelineEntry; turn: AssistantTurn };
type SplitTurn = { timeline: TimelineEntry[]; turns: Map<string, AssistantTurn>; tail: string | undefined };
const splitCache = new WeakMap<AssistantTurn, SplitTurn | null>();
const boundaryRows = new WeakMap<Boundary, TimelineEntry>();
const prefixes = new WeakMap<Boundary, Chunk>();
const projectionCache = new WeakMap<readonly TimelineEntry[], WeakMap<ReadonlyMap<string, AssistantTurn>, TimelinePresentation>>();

function sameChunk(a: AssistantTurn, b: AssistantTurn): boolean {
  return a.id === b.id && a.timestamp === b.timestamp && a.model === b.model && a.usage === b.usage
    && a.stopReason === b.stopReason && a.anthropicRequestId === b.anthropicRequestId
    && a.segments.length === b.segments.length && a.segments.every((segment, i) => segment === b.segments[i]);
}

function splitTurn(source: AssistantTurn): SplitTurn | null {
  if (splitCache.has(source)) return splitCache.get(source)!;
  const segments = source.segments as Array<AssistantTurnSegment | Boundary>;
  if (!segments.some(segment => segment.type === 'system-marker')) {
    splitCache.set(source, null);
    return null;
  }
  const pieces: Array<{ id: string; segments: AssistantTurnSegment[]; end?: Boundary } | Boundary> = [];
  let id = source.id;
  let current: AssistantTurnSegment[] = [];
  for (const segment of segments) {
    if (segment.type !== 'system-marker') { current.push(segment); continue; }
    if (current.length) pieces.push({ id, segments: current, end: segment });
    pieces.push(segment);
    id = `${source.id}:after:${segment.marker.id}`;
    current = [];
  }
  if (current.length) pieces.push({ id, segments: current });
  // WHY: a boundary must not swallow an abnormal completion, nor manufacture
  // an empty chat bubble merely because compaction was the last event.
  if (!pieces.some(piece => !('type' in piece)) && abnormalStopReason(source.stopReason)) {
    pieces.push({ id, segments: [] });
  }
  const lastChunk = pieces.reduce((last, piece, index) => 'type' in piece ? last : index, -1);
  const timeline: TimelineEntry[] = [];
  const turns = new Map<string, AssistantTurn>();
  let tail: string | undefined;
  pieces.forEach((piece, index) => {
    if ('type' in piece) {
      let row = boundaryRows.get(piece);
      if (!row) { row = { kind: 'system-marker', marker: piece.marker }; boundaryRows.set(piece, row); }
      timeline.push(row);
      return;
    }
    // WHY: one logical reply still owns one metadata/stop footer. Earlier
    // chunks keep their content and tool groups, not duplicate token bills.
    const derived: AssistantTurn = { ...source, id: piece.id, segments: piece.segments,
      ...(index === lastChunk ? {} : { timestamp: undefined, model: null, usage: null, stopReason: null, anthropicRequestId: null }) };
    let chunk = piece.end ? prefixes.get(piece.end) : undefined;
    if (!chunk || !sameChunk(chunk.turn, derived)) {
      chunk = { entry: { kind: 'assistant-turn', turnId: piece.id }, turn: derived };
      if (piece.end) prefixes.set(piece.end, chunk);
    }
    timeline.push(chunk.entry);
    turns.set(piece.id, chunk.turn);
    tail = piece.id;
  });
  const result = { timeline, turns, tail };
  splitCache.set(source, result);
  return result;
}

/** Presentation only: never split a reducer turn, rewrite disk events, or move
 * tools. All timeline surfaces and message Find consume these same stable rows. */
export function projectTimeline(timeline: readonly TimelineEntry[], assistantTurns: ReadonlyMap<string, AssistantTurn>): TimelinePresentation {
  let byTurns = projectionCache.get(timeline);
  const cached = byTurns?.get(assistantTurns);
  if (cached) return cached;
  let rows: TimelineEntry[] | undefined;
  let turns: Map<string, AssistantTurn> | undefined;
  const tailTurnIds = new Map<string, string>();
  const footerAfter = new Map<string, TimelineEntry>();
  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    const source = entry.kind === 'assistant-turn' ? assistantTurns.get(entry.turnId) : undefined;
    const split = source ? splitTurn(source) : null;
    if (!split) {
      if (source?.presentationReferences && entry.kind === 'assistant-turn' && entry.afterMarkerId) {
        rows ??= timeline.slice(0, i);
      } else rows?.push(entry);
      if (entry.kind === 'system-marker') {
        const footer = footerAfter.get(entry.marker.id);
        if (footer) rows?.push(footer);
      }
      continue;
    }
    rows ??= timeline.slice(0, i);
    turns ??= new Map(assistantTurns);
    if (source!.presentationReferences) {
      // WHY: source timeline references, not expansion at the root row, retain
      // intervening usage/prompt/copy cards. Legacy synthetic turns still expand.
      const id = entry.kind === 'assistant-turn' && entry.afterMarkerId
        ? `${source!.id}:after:${entry.afterMarkerId}` : source!.id;
      const row = split.timeline.find(row => row.kind === 'assistant-turn' && row.turnId === id);
      if (row) rows.push(row);
      else if (abnormalStopReason(source!.stopReason) && source!.segments.every(segment => segment.type === 'system-marker')) {
        // WHY: reference-mode has no continuation row until content arrives.
        // A marker-only turn still needs its real completion footer after it.
        const last = source!.segments.at(-1);
        const footer = split.timeline.find(candidate => candidate.kind === 'assistant-turn' && candidate.turnId === split.tail);
        if (last?.type === 'system-marker' && footer) footerAfter.set(last.marker.id, footer);
      }
    } else {
      rows.push(...split.timeline);
    }
    for (const [key, value] of split.turns) turns.set(key, value);
    if (split.tail) tailTurnIds.set(source!.id, split.tail);
  }
  const result = { timeline: rows ?? timeline, assistantTurns: turns ?? assistantTurns, tailTurnIds };
  if (!byTurns) { byTurns = new WeakMap(); projectionCache.set(timeline, byTurns); }
  byTurns.set(assistantTurns, result);
  return result;
}
