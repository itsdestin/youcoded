import { describe, expect, it } from 'vitest';
import type { AssistantTurn, TimelineEntry, ChatAction } from '../src/renderer/state/chat-types';
import { projectTimeline } from '../src/renderer/state/timeline-presentation';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { ev } from './helpers/transcript-events';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import type { TranscriptEvent } from '../src/shared/types';

const text = (content: string, messageId = content) => ({ type: 'text' as const, content, messageId });
const boundary = (id: string) => ({ type: 'system-marker', marker: {
  id, timestamp: 100, label: 'Conversation compacted', variant: 'compact',
} });
const turn = (segments: unknown[], extra: Partial<AssistantTurn> = {}): AssistantTurn => ({
  id: 'turn', segments, stopReason: null, model: 'test-model', usage: null,
  anthropicRequestId: null, timestamp: 10, ...extra,
} as AssistantTurn);
const timeline: TimelineEntry[] = [{ kind: 'assistant-turn', turnId: 'turn' }];
const view = (value: AssistantTurn) => projectTimeline(timeline, new Map([['turn', value]]));

function labels(value: ReturnType<typeof projectTimeline>) {
  return value.timeline.map(entry => entry.kind === 'system-marker' ? entry.marker.id
    : entry.kind === 'assistant-turn' ? value.assistantTurns.get(entry.turnId)!.segments
      .filter(segment => segment.type === 'text').map(segment => segment.content).join('') : entry.kind);
}

describe('source-positioned boundaries', () => {
  const sid = 'source-position';
  const initial = () => chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: sid });
  const message = (uuid: string, text: string, timestamp: number, partId?: string) => ev('assistant-text', { text, ...(partId ? { partId } : {}) }, { sessionId: sid, uuid, timestamp });
  const summary = () => ev('compact-summary', { summary: 'saved', autoCompaction: true }, { sessionId: sid, uuid: 'cut', timestamp: 20 });
  const play = (state: ReturnType<typeof initial>, event: TranscriptEvent) => {
    for (const action of eventToAction(event, { live: true })) state = chatReducer(state, action);
    return state;
  };
  const visible = (state: ReturnType<typeof initial>) => {
    const s = state.get(sid)!;
    return labels(projectTimeline(s.timeline, s.assistantTurns));
  };

  it.each(['copy-picker', 'usage-card', 'prompt'] as const)('keeps intervening %s cards on their actual side of the boundary', kind => {
    const card = (id: string): ChatAction => kind === 'copy-picker'
      ? { type: 'SHOW_COPY_PICKER', sessionId: sid, id, options: [] }
      : kind === 'prompt' ? { type: 'SHOW_PROMPT', sessionId: sid, promptId: id, title: id, buttons: [] }
      : { type: 'SHOW_USAGE_CARD', sessionId: sid, snapshot: { entryId: id, timestamp: 15 } } as ChatAction;
    let state = play(initial(), message('a', 'before', 10));
    state = chatReducer(state, card('first'));
    state = play(state, summary());
    state = chatReducer(state, card('second'));
    state = play(state, message('b', 'after', 30));
    expect(visible(state)).toEqual(['before', kind, 'compact-done-cut', kind, 'after']);
  });

  it.each(['live-first', 'page-first', 'live-prefix', 'live-suffix'])('reconciles persisted coalesced delta witnesses without losing unseen text (%s)', order => {
    const a = message('a', 'be', 10, 'part');
    const a2 = message('a2', 'fore', 11, 'part');
    const disk = { ...a, data: { ...a.data, text: 'before', deltaReferences: [
      { eventUuid: 'a', start: 0, end: 2 }, { eventUuid: 'a2', start: 2, end: 6 },
    ] } };
    const b = message('b', 'after', 30, 'part');
    let state = initial();
    const page = () => { state = chatReducer(state, { type: 'HISTORY_PAGE_LOADED', sessionId: sid, events: [disk, summary(), b], cursor: null, hasMore: false }); };
    if (order === 'page-first') { page(); state = play(play(play(state, a), a2), b); }
    else {
      if (order !== 'live-suffix') state = play(state, a);
      if (order !== 'live-prefix') state = play(state, a2);
      state = play(state, b); page();
    }
    page();
    expect(visible(state)).toEqual(['before', 'compact-done-cut', 'after']);
  });

  it('places a delayed live summary between its source text events', () => {
    let state = play(initial(), message('a', 'before', 10));
    state = play(state, message('b', 'after', 30));
    const root = state.get(sid)!.currentTurnId;
    state = play(state, summary());
    expect(visible(state)).toEqual(['before', 'compact-done-cut', 'after']);
    expect(state.get(sid)!.currentTurnId).toBe(root);
  });

  it('restores a boundary after overlapping reasoning without duplicating that reasoning', () => {
    const reasoning = ev('assistant-thinking', { text: 'earlier reasoning', partId: 'r' }, { sessionId: sid, uuid: 'reason', timestamp: 10 });
    const after = message('after', 'after', 30);
    let state = play(play(initial(), reasoning), after);
    state = chatReducer(state, { type: 'HISTORY_PAGE_LOADED', sessionId: sid, events: [reasoning, summary(), after], cursor: null, hasMore: false });
    const s = state.get(sid)!; const p = projectTimeline(s.timeline, s.assistantTurns);
    expect(labels(p)).toEqual(['', 'compact-done-cut', 'after']);
    const all = [...p.assistantTurns.values()].filter(t => p.timeline.some(e => e.kind === 'assistant-turn' && e.turnId === t.id));
    expect(all.flatMap(t => t.segments.filter(s => s.type === 'reasoning'))).toHaveLength(1);
  });

  it('restores coalesced reasoning parts with reused part IDs from exact disk witnesses', () => {
    const a = ev('assistant-thinking', { text: 'be', partId: 'r' }, { sessionId: sid, uuid: 'r1', timestamp: 10 });
    const a2 = ev('assistant-thinking', { text: 'fore', partId: 'r' }, { sessionId: sid, uuid: 'r2', timestamp: 11 });
    const b = ev('assistant-thinking', { text: 'after', partId: 'r' }, { sessionId: sid, uuid: 'r3', timestamp: 30 });
    const disk = { ...a, data: { ...a.data, text: 'before', deltaReferences: [
      { eventUuid: 'r1', start: 0, end: 2 }, { eventUuid: 'r2', start: 2, end: 6 },
    ] } };
    let state = play(play(play(initial(), a), a2), b);
    state = chatReducer(state, { type: 'HISTORY_PAGE_LOADED', sessionId: sid, events: [disk, summary(), b], cursor: null, hasMore: false });
    const s = state.get(sid)!; const p = projectTimeline(s.timeline, s.assistantTurns);
    expect(p.timeline.map(e => e.kind === 'system-marker' ? e.marker.id : e.kind === 'assistant-turn'
      ? p.assistantTurns.get(e.turnId)!.segments.filter(s => s.type === 'reasoning').map(s => s.content).join('') : e.kind))
      .toEqual(['before', 'compact-done-cut', 'after']);
  });

  it('restores a tool-only predecessor and splits a group without duplicating tool identities', () => {
    const one = ev('tool-use', { toolUseId: 'one', toolName: 'Read', toolInput: {} }, { sessionId: sid, uuid: 'tool-one', timestamp: 10 });
    const result = ev('tool-result', { toolUseId: 'one', toolResult: 'done', isError: false }, { sessionId: sid, uuid: 'result-one', timestamp: 15 });
    const two = ev('tool-use', { toolUseId: 'two', toolName: 'Read', toolInput: {} }, { sessionId: sid, uuid: 'tool-two', timestamp: 30 });
    let state = play(play(play(initial(), one), result), two);
    state = chatReducer(state, { type: 'HISTORY_PAGE_LOADED', sessionId: sid, events: [one, result, summary(), two], cursor: null, hasMore: false });
    const s = state.get(sid)!; const p = projectTimeline(s.timeline, s.assistantTurns);
    expect(p.timeline.map(e => e.kind)).toEqual(['assistant-turn', 'system-marker', 'assistant-turn']);
    const groups = p.timeline.flatMap(e => e.kind === 'assistant-turn' ? p.assistantTurns.get(e.turnId)!.segments
      .filter(s => s.type === 'tool-group').map(s => s.groupId) : []);
    expect(groups.map(id => s.toolGroups.get(id)!.toolIds)).toEqual([['one'], ['two']]);
    expect(s.toolCalls.size).toBe(2);
    expect(s.toolCalls.get('one')!.status).toBe('complete');
  });

  it('keeps a boundary discovered after a completed older turn before a newer live turn', () => {
    const before = message('a', 'before', 10);
    const end = ev('turn-complete', { stopReason: 'end_turn' }, { sessionId: sid, uuid: 'complete-before', timestamp: 15 });
    const question = ev('user-message', { text: 'next' }, { sessionId: sid, uuid: 'next-question', timestamp: 25 });
    const after = message('b', 'after', 30);
    let state = play(play(play(play(initial(), before), end), question), after);
    state = chatReducer(state, { type: 'HISTORY_PAGE_LOADED', sessionId: sid, events: [before, end, summary(), question, after], cursor: null, hasMore: false });
    expect(visible(state)).toEqual(['before', 'compact-done-cut', 'user', 'after']);
  });

  it.each(['live-first', 'page-first'])('keeps a newly discovered page boundary after its overlapping predecessor (%s)', order => {
    const a = message('a', 'before', 10);
    const b = message('b', 'after', 30);
    let state = initial();
    const page = () => { state = chatReducer(state, { type: 'HISTORY_PAGE_LOADED', sessionId: sid, events: [a, summary(), b], cursor: null, hasMore: false }); };
    if (order === 'live-first') { state = play(play(state, a), b); page(); }
    else { page(); state = play(play(state, a), b); }
    state = play(state, summary());
    page();
    expect(visible(state)).toEqual(['before', 'compact-done-cut', 'after']);
  });
});

describe('timeline presentation boundaries', () => {
  it('preserves the source references when a turn has no boundary', () => {
    const source = turn([text('ordinary reply')]);
    const turns = new Map([['turn', source]]);
    const projected = projectTimeline(timeline, turns);
    expect(projected.timeline).toBe(timeline);
    expect(projected.assistantTurns).toBe(turns);
  });

  it('places content and repeated boundaries in recorded segment order', () => {
    const projected = view(turn([text('before'), boundary('first'), text('between'), boundary('second'), text('after')]));
    expect(labels(projected)).toEqual(['before', 'first', 'between', 'second', 'after']);
    expect(new Set(projected.timeline.map(entry => entry.kind === 'assistant-turn' ? entry.turnId : entry.kind === 'system-marker' ? entry.marker.id : 'other')).size).toBe(5);
    expect(projected.tailTurnIds.get('turn')).toBe('turn:after:second');
  });

  it('keeps tools in their original chunks without copying their logical groups', () => {
    const before = { type: 'tool-group', groupId: 'before-tools' };
    const after = { type: 'tool-group', groupId: 'after-tools' };
    const projected = view(turn([before, boundary('cut'), after]));
    const rows = projected.timeline.filter(entry => entry.kind === 'assistant-turn');
    expect(projected.assistantTurns.get(rows[0].turnId)!.segments[0]).toBe(before);
    expect(projected.assistantTurns.get(rows[1].turnId)!.segments[0]).toBe(after);
  });

  it('owns metadata and abnormal completion only on the last content chunk', () => {
    const usage = { inputTokens: 20, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const projected = view(turn([text('before'), boundary('cut'), text('after')], { usage, stopReason: 'max_tokens' }));
    const before = projected.assistantTurns.get('turn')!;
    const after = projected.assistantTurns.get('turn:after:cut')!;
    expect(before.usage).toBeNull();
    expect(before.model).toBeNull();
    expect(before.stopReason).toBeNull();
    expect(before.timestamp).toBeUndefined();
    expect(after.usage).toBe(usage);
    expect(after.stopReason).toBe('max_tokens');
  });

  it('does not create an empty continuation when a marker is the final segment', () => {
    const projected = view(turn([text('last words'), boundary('cut')], { stopReason: 'interrupted' }));
    expect(labels(projected)).toEqual(['last words', 'cut']);
    expect(projected.assistantTurns.get('turn')!.stopReason).toBe('interrupted');
  });

  it('keeps an abnormal footer in actual timeline-reference mode when only a boundary remains', () => {
    const cut = boundary('cut');
    const source = turn([cut], { presentationReferences: true, stopReason: 'empty_response' });
    const projected = projectTimeline([{ kind: 'assistant-turn', turnId: 'turn' },
      { kind: 'system-marker', marker: cut.marker as import('../src/renderer/state/chat-types').SystemMarker }], new Map([['turn', source]]));
    expect(labels(projected)).toEqual(['cut', '']);
    expect(projected.assistantTurns.get('turn:after:cut')!.stopReason).toBe('empty_response');
  });

  it('keeps an abnormal footer when no content surrounds a boundary', () => {
    const projected = view(turn([boundary('cut')], { stopReason: 'empty_response' }));
    expect(labels(projected)).toEqual(['cut', '']);
    expect(projected.assistantTurns.get('turn:after:cut')!.stopReason).toBe('empty_response');
  });

  it('reuses completed prefix chunks while the post-boundary text grows', () => {
    const first = text('before');
    const cut = boundary('cut');
    const a = view(turn([first, cut, text('af')]));
    const b = view(turn([first, cut, text('after')]));
    expect(b.timeline[0]).toBe(a.timeline[0]);
    expect(b.timeline[1]).toBe(a.timeline[1]);
    expect(b.assistantTurns.get('turn')).toBe(a.assistantTurns.get('turn'));
    expect(labels(b)).toEqual(['before', 'cut', 'after']);
  });
});
