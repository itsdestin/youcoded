// A cleared (or compacted) native chat, reopened through the real session:open answer: every divider is drawn ONCE and in order.
// The answer carries the record's recent past (played as live events) AND the transcript page (prepended); both hold the same events.
import { describe, it, expect } from 'vitest';
import { SessionRecords } from '../src/main/session-record';
import { openSession } from '../src/main/session-open';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { applyOpenReply, type OpenOk } from '../src/renderer/state/session-fill';
import { playInto } from './helpers/fill-harness';
import { newState, screenOf, SID } from './helpers/fill-scenarios';
import { ev } from './helpers/transcript-events';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import type { TranscriptEvent } from '../src/shared/types';
import { clearDividerId } from '../src/shared/divider-ids';
import { routeSessionLive } from '../src/renderer/state/transcript-batch';

let t = 1_700_000_000_000;
const e = <T extends TranscriptEvent>(x: T): T => ({ ...x, sessionId: SID, timestamp: (t += 1000) });

async function reopen(events: TranscriptEvent[], opts: { recordHas?: TranscriptEvent[] } = {}) {
  const records = new SessionRecords(); records.begin(SID);
  for (const x of opts.recordHas ?? events) {
    records.note(SID, 'transcript:event', x);
    // The computer says "Conversation cleared" itself, right after the barrier event (main/session-live.ts nativeCleared; sync-fix6).
    if (x.type === 'context-clear') records.note(SID, 'session:live', { sessionId: SID, kind: 'clear', id: clearDividerId(x.uuid), at: x.timestamp });
  }
  const reply = await openSession({ records, knows: () => true, native: () => null, page: async () => ({ events, cursor: null, hasMore: false }) }, { sessionId: SID, fresh: true });
  const st = { value: newState() };
  applyOpenReply({ dispatch: (a) => { st.value = chatReducer(st.value, a); }, flush: () => {}, play: (p) => playInto(st, p) }, SID, reply as OpenOk, { acceptPage: true });
  return screenOf(st.value)!.timeline;
}

describe('reopening a native chat that was cleared', () => {
  it('draws each "Conversation cleared" divider once, after the messages that came before it', async () => {
    const events = [
      e(ev('user-message', { text: 'hello' }, { uuid: 'u1' })),
      e(ev('assistant-text', { text: 'hi' }, { uuid: 'a1' })),
      e(ev('turn-complete', { stopReason: 'end_turn' }, { uuid: 'tc1' })),
      e(ev('context-clear', { contextUsedAfter: 38 }, { uuid: 'c1' })),
      e(ev('user-message', { text: 'after' }, { uuid: 'u2' })),
      e(ev('context-clear', { contextUsedAfter: 38 }, { uuid: 'c2' })),
    ];
    const tl = await reopen(events);
    expect(tl.filter((l) => l === 'marker: Conversation cleared')).toHaveLength(2);
    expect(tl[0]).toBe('user: hello');
    expect(tl.indexOf('marker: Conversation cleared')).toBeGreaterThan(tl.indexOf('user: hello'));
    expect(tl.at(-1)).toBe('marker: Conversation cleared');
    expect(tl).toContain('user: after');
  });

  it('draws a clear that only the page holds (the record has rolled past it) once, where it happened', async () => {
    const events = [e(ev('user-message', { text: 'one' }, { uuid: 'u1' })), e(ev('context-clear', {}, { uuid: 'c1' })), e(ev('user-message', { text: 'two' }, { uuid: 'u2' }))];
    const tl = await reopen(events, { recordHas: [events[2]] });
    expect(tl).toEqual(['user: one', 'marker: Conversation cleared', 'user: two']);
  });

  it('draws an automatic compaction note once, and a skill card once', async () => {
    const events = [
      e(ev('user-message', { text: 'q' }, { uuid: 'u1' })),
      e(ev('skill-invoked', { skillId: 'x', displayName: 'X', body: 'b' }, { uuid: 's1' })),
      e(ev('compact-summary', { summary: 'sum', autoCompaction: true, contextUsedAfter: 10 }, { uuid: 'cs1' })),
    ];
    const tl = await reopen(events);
    expect(tl.filter((l) => l.startsWith('skill:'))).toHaveLength(1);
    expect(tl.filter((l) => l.startsWith('marker:'))).toHaveLength(1);
  });
});

describe('restoring recorded compaction boundaries', () => {
  it('keeps a newly discovered boundary after an overlapping user-only predecessor', async () => {
    const events = [e(ev('user-message', { text: 'before' }, { uuid: 'user-only' })),
      e(ev('compact-summary', { summary: 'saved', contextUsedAfter: 100 }, { uuid: 'user-only-cut' }))];
    expect(await reopen(events, { recordHas: [events[0]] })).toEqual(['user: before', 'marker: Conversation compacted']);
  });

  it('restores a genuine CC compaction proven by its command echo, not a synthetic resume summary', async () => {
    const events = [
      e(ev('user-message', { text: 'question' }, { uuid: 'cc-u' })),
      e(ev('assistant-text', { text: 'answer' }, { uuid: 'cc-a' })),
      e(ev('turn-complete', { stopReason: 'end_turn' }, { uuid: 'cc-end' })),
      e(ev('user-message', { text: '/compact' }, { uuid: 'cc-command' })),
      e(ev('compact-summary', { summary: 'CC saved summary', sourceTimestamp: 100 }, { uuid: 'cc-cut' })),
      e(ev('user-message', { text: 'next' }, { uuid: 'cc-next' })),
    ];
    expect(await reopen(events, { recordHas: [events[0], events[1], events[2], events[5]] }))
      .toEqual(['user: question', 'assistant: text(answer) [stop=end_turn]', 'marker: Conversation compacted', 'user: next']);
    const withoutCommand = events.filter(event => event.uuid !== 'cc-command');
    expect((await reopen(withoutCommand, { recordHas: [] })).filter(row => row.startsWith('marker:'))).toEqual([]);
  });
  it.each([false, true])('restores a saved summary with auto=%s when only disk history remains', async (auto) => {
    const events = [
      e(ev('user-message', { text: 'old question' }, { uuid: 'old-u' })),
      e(ev('assistant-text', { text: 'old reply' }, { uuid: 'old-a' })),
      e(ev('turn-complete', { stopReason: 'end_turn' }, { uuid: 'old-end' })),
      e(ev('compact-summary', { summary: 'Saved summary', contextUsedAfter: 100,
        ...(auto ? { autoCompaction: true } : {}) }, { uuid: 'saved-compact' })),
      e(ev('user-message', { text: 'new question' }, { uuid: 'new-u' })),
    ];
    const tl = await reopen(events, { recordHas: [events[4]] });
    expect(tl).toEqual(['user: old question', 'assistant: text(old reply) [stop=end_turn]',
      'marker: Conversation compacted', 'user: new question']);
  });

  it('restores a manual summary on a newly joined screen without a pending spinner', async () => {
    const events = [
      e(ev('user-message', { text: 'before' }, { uuid: 'manual-u' })),
      e(ev('compact-summary', { summary: 'Manual summary', contextUsedAfter: 100 }, { uuid: 'manual-summary' })),
      e(ev('user-message', { text: 'after' }, { uuid: 'manual-next' })),
    ];
    expect(await reopen(events)).toEqual(['user: before', 'marker: Conversation compacted', 'user: after']);
  });

  it.each(['page-first', 'live-first'])('deduplicates summary markers and accounting across overlap (%s)', (order) => {
    const summary = e(ev('compact-summary', { summary: 'Saved summary', contextUsedAfter: 100,
      usage: { inputTokens: 500, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 } }, { uuid: 'overlap-summary' }));
    let state = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: SID });
    const page = () => { state = chatReducer(state, { type: 'HISTORY_PAGE_LOADED', sessionId: SID,
      events: [summary], cursor: null, hasMore: false }); };
    const live = () => { for (const a of eventToAction(summary, { live: true })) state = chatReducer(state, a); };
    if (order === 'page-first') { page(); live(); } else { live(); page(); }
    const session = state.get(SID)!;
    expect(session.timeline.filter(entry => entry.kind === 'system-marker')).toEqual([
      { kind: 'system-marker', marker: { id: 'compact-done-overlap-summary', timestamp: summary.timestamp,
        label: 'Conversation compacted', variant: 'compact', summary: 'Saved summary' } },
    ]);
    expect(session.totals.inputTokens).toBe(500);
    expect(session.totals.outputTokens).toBe(20);
  });

  it('a delayed recorded manual summary does not end the current reply or fail its tool', () => {
    let state = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: SID });
    for (const event of [
      e(ev('user-message', { text: 'working' }, { uuid: 'working-user' })),
      e(ev('assistant-text', { text: 'Still working' }, { uuid: 'working-text' })),
      e(ev('tool-use', { toolUseId: 'active-tool', toolName: 'Read', toolInput: {} }, { uuid: 'working-tool' })),
    ]) for (const a of eventToAction(event, { live: true })) state = chatReducer(state, a);
    const before = state.get(SID)!;
    const summary = e(ev('compact-summary', { summary: 'Older manual summary', contextUsedAfter: 100 }, { uuid: 'delayed-summary' }));
    for (const a of eventToAction(summary, { live: true })) state = chatReducer(state, a);
    const after = state.get(SID)!;
    expect(after.currentTurnId).toBe(before.currentTurnId);
    expect(after.activeTurnToolIds).toEqual(before.activeTurnToolIds);
    expect(after.toolCalls.get('active-tool')?.status).toBe('running');
  });

  it('uses the recorded summary time instead of the time a screen replays it', () => {
    const summary = e(ev('compact-summary', { summary: 'Earlier summary', autoCompaction: true }, { uuid: 'timed-summary' }));
    let state = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: SID });
    for (const a of eventToAction(summary, { live: true })) state = chatReducer(state, a);
    const marker = state.get(SID)!.timeline.find(entry => entry.kind === 'system-marker');
    expect(marker?.kind === 'system-marker' && marker.marker.timestamp).toBe(summary.timestamp);
  });
});

describe('the buddy and the preview run the same page case', () => {
  it('both dispatch HISTORY_PAGE_LOADED into chatReducer itself (a source pin: there is no second reducer to fix)', async () => {
    const fs = await import('node:fs');
    const read = (p: string) => fs.readFileSync(new URL(`../src/renderer/${p}`, import.meta.url), 'utf8');
    // The buddy fills through the shared fill (sync-fix3), so its page lands through the same function the main window's does.
    expect(read('components/buddy/useBuddyFeed.ts')).toContain('createFirstPageLoader');
    expect(read('state/first-page-loader.ts')).toContain("applyOpenReply");
    expect(read('state/session-fill.ts')).toContain("type: 'HISTORY_PAGE_LOADED'");
    expect(read('state/chat-context.ts')).toContain('chatReducer');
    expect(read('components/SessionPreviewPane.tsx')).toContain("type: 'HISTORY_PAGE_LOADED'");
    expect(read('components/SessionPreviewPane.tsx')).toContain('chatReducer(state, action as ChatAction)');
  });

  it('a page loaded into the buddy\'s state shape (SESSION_INIT, live clear, then the page) shows the divider once', () => {
    const clear = e(ev('context-clear', {}, { uuid: 'bc1' }));
    const hello = e(ev('user-message', { text: 'hi' }, { uuid: 'bu1' }));
    let st = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: SID });
    for (const x of [hello, clear]) for (const a of eventToAction(x, { live: true })) st = chatReducer(st, a);
    // The record's own line for that clear (a live clear event only resets the turn).
    routeSessionLive({ sessionId: SID, kind: 'clear', id: clearDividerId('bc1'), at: clear.timestamp }, { batcher: { push: (a) => { st = chatReducer(st, a); } }, contextTokens: () => null });
    st = chatReducer(st, { type: 'HISTORY_PAGE_LOADED', sessionId: SID, events: [hello, clear], cursor: null, hasMore: false });
    expect(screenOf(st)!.timeline).toEqual(['user: hi', 'marker: Conversation cleared']);
  });
});
