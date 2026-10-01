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
import type { TranscriptEvent } from '../src/shared/types';

let t = 1_700_000_000_000;
const e = <T extends TranscriptEvent>(x: T): T => ({ ...x, sessionId: SID, timestamp: (t += 1000) });

async function reopen(events: TranscriptEvent[], opts: { recordHas?: TranscriptEvent[] } = {}) {
  const records = new SessionRecords(); records.begin(SID);
  for (const x of opts.recordHas ?? events) records.note(SID, 'transcript:event', x);
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
