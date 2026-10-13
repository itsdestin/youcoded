// The parts of the session record a screen is FILLED from (one-core R5-2): the merged tail, the terminal stream, and the
// asks as replayable events. The ring and the resume rule have their own file (session-record.test.ts).
import { describe, it, expect } from 'vitest';
import { SessionRecords, TAIL_MAX_ENTRIES, PTY_STREAM_UNITS } from '../src/main/session-record';

const S = 's1';
const delta = (n: number, text: string, partId = 'text-0', type = 'assistant-text') => ({ sessionId: S, type, uuid: `d${n}`, timestamp: n, data: { text, partId } });
const user = (n: number, text = 'hi') => ({ sessionId: S, type: 'user-message', uuid: `m${n}`, timestamp: n, data: { text } });
const tail = (r: SessionRecords) => r.fillTail(S).map((t) => t.payload as any);

describe('the fill tail', () => {
  it('merges a streaming part\'s deltas into one entry that keeps the FIRST delta\'s uuid', () => {
    const r = new SessionRecords();
    r.note(S, 'transcript:event', user(1));
    for (let i = 0; i < 500; i++) r.note(S, 'transcript:event', delta(i, 'ab '));
    const t = tail(r);
    expect(t).toHaveLength(2);
    expect(t[1].uuid).toBe('d0');
    expect(t[1].data.text).toBe('ab '.repeat(500));
    // the ring still holds every event, numbered, for a client that resumes
    expect(r.events(S)).toHaveLength(501);
  });

  it('never changes the event object the windows and phones were handed (it clones before it grows)', () => {
    const r = new SessionRecords();
    const first = delta(1, 'one ');
    r.note(S, 'transcript:event', first);
    r.note(S, 'transcript:event', delta(2, 'two'));
    expect(first.data.text).toBe('one ');
    expect(tail(r)[0].data.text).toBe('one two');
    expect(r.events(S)[0].payload).toBe(first);
  });

  it('does not merge across a different part, a different type, a stamped helper event, or an event in between', () => {
    const r = new SessionRecords();
    r.note(S, 'transcript:event', delta(1, 'a', 'text-0'));
    r.note(S, 'transcript:event', delta(2, 'b', 'text-1'));
    r.note(S, 'transcript:event', delta(3, 'r', 'reasoning-0', 'assistant-thinking'));
    r.note(S, 'transcript:event', { ...delta(4, 'h', 'text-1'), data: { text: 'h', partId: 'text-1', parentAgentToolUseId: 'x' } });
    r.note(S, 'transcript:event', { sessionId: S, type: 'tool-use', uuid: 't', timestamp: 5, data: { toolUseId: 'k', toolName: 'Bash' } });
    r.note(S, 'transcript:event', delta(6, 'c', 'text-1'));
    expect(tail(r).map((e) => e.uuid)).toEqual(['d1', 'd2', 'd3', 'd4', 't', 'd6']);
  });

  it('a retry (dropPart) between two deltas of one part keeps them apart, so the screen drops the half answer', () => {
    const r = new SessionRecords();
    r.note(S, 'transcript:event', delta(1, 'HALF', 'text-0'));
    r.note(S, 'transcript:event', { sessionId: S, type: 'assistant-thinking', uuid: 'dp', timestamp: 2, data: { dropPart: { partIds: ['text-0'] } } });
    r.note(S, 'transcript:event', delta(3, 'REPLACEMENT', 'text-0'));
    expect(tail(r).map((e) => e.uuid)).toEqual(['d1', 'dp', 'd3']);
  });

  it('holds only transcript pushes (a hook, a mode change or a model state are not part of the tail)', () => {
    const r = new SessionRecords();
    r.note(S, 'transcript:event', user(1));
    r.note(S, 'hook:event', { type: 'PermissionRequest', sessionId: S, payload: { _requestId: 'a' }, timestamp: 1 });
    r.note(S, 'native:permission-mode', { sessionId: S, mode: 'ask' });
    r.note(S, 'transcript:shrink', { sessionId: S });
    expect(r.fillTail(S).map((t) => t.type)).toEqual(['transcript:event', 'transcript:shrink']);
  });

  it('stays inside its bounds and, when it trims, starts again at a user message', () => {
    const r = new SessionRecords();
    for (let t = 0; t < 3000; t++) {
      r.note(S, 'transcript:event', user(t * 10));
      r.note(S, 'transcript:event', { sessionId: S, type: 'tool-use', uuid: `t${t}`, timestamp: t, data: { toolUseId: `k${t}`, toolName: 'Bash' } });
    }
    const t = tail(r);
    expect(t.length).toBeLessThanOrEqual(TAIL_MAX_ENTRIES);
    expect(t[0].type).toBe('user-message');
    expect(r.stats().tailEntries).toBe(t.length);
  });

  it('a single turn too long for the bound keeps its newest entries rather than nothing', () => {
    const r = new SessionRecords();
    r.note(S, 'transcript:event', user(1));
    for (let i = 0; i < TAIL_MAX_ENTRIES + 500; i++) r.note(S, 'transcript:event', { sessionId: S, type: 'tool-use', uuid: `t${i}`, timestamp: i, data: { toolUseId: `k${i}`, toolName: 'Bash' } });
    const t = tail(r);
    expect(t.length).toBe(TAIL_MAX_ENTRIES);
    expect(t.at(-1).uuid).toBe(`t${TAIL_MAX_ENTRIES + 499}`);
  });

  it('a long answer is one entry however many words it has (the ring would have lost its start)', () => {
    const r = new SessionRecords();
    r.note(S, 'transcript:event', user(1));
    for (let i = 0; i < 6000; i++) r.note(S, 'transcript:event', delta(i, 'w '));
    expect(r.events(S).length).toBeLessThanOrEqual(2000); // the ring is bounded
    expect(tail(r)[1].data.text.length).toBe(12000);        // the tail holds the whole answer
  });
});

describe('the terminal stream', () => {
  it('numbers each chunk by its position and keeps the stream\'s epoch', () => {
    const r = new SessionRecords();
    r.begin(S);
    const a = r.notePty(S, 'hello ')!;
    const b = r.notePty(S, 'world')!;
    expect(a.offset).toBe(0);
    expect(b.offset).toBe(6);
    expect(a.epoch).toBe(b.epoch);
    expect(a.epoch).toBe(r.epochOf(S));
  });

  it('a first connect gets the whole window with no reset', () => {
    const r = new SessionRecords();
    r.notePty(S, 'one'); r.notePty(S, 'two');
    expect(r.ptyFrom(S)).toEqual({ epoch: r.epochOf(S), offset: 0, data: 'onetwo', reset: false });
  });

  it('a phone that says where it got to gets only the bytes past that point', () => {
    const r = new SessionRecords();
    r.notePty(S, 'x'.repeat(10_000)); r.notePty(S, 'y'.repeat(10_000));
    const got = r.ptyFrom(S, { epoch: r.epochOf(S)!, units: 15_000 })!;
    expect(got.reset).toBe(false);
    expect(got.offset).toBe(15_000);
    expect(got.data.length).toBe(5_000);
    expect(got.data[0]).toBe('y');
  });

  it('a different epoch (a restart) or a position trimmed away resets the phone and sends the whole window', () => {
    const r = new SessionRecords();
    r.notePty(S, 'abc');
    expect(r.ptyFrom(S, { epoch: 'someone-elses', units: 3 })).toMatchObject({ reset: true, offset: 0, data: 'abc' });
    expect(r.ptyFrom(S, { epoch: r.epochOf(S)!, units: 999 })).toMatchObject({ reset: true, data: 'abc' });
  });

  it('holds about 4M units and moves its start forward as it trims, so an old position resets', () => {
    const r = new SessionRecords();
    const chunk = 'z'.repeat(100_000);
    for (let i = 0; i < 60; i++) r.notePty(S, chunk);   // 6M units offered
    const got = r.ptyFrom(S)!;
    expect(got.data.length).toBeLessThanOrEqual(PTY_STREAM_UNITS);
    expect(got.offset).toBeGreaterThan(0);
    expect(r.ptyFrom(S, { epoch: r.epochOf(S)!, units: 10 })!.reset).toBe(true);
    expect(r.stats().ptyUnits).toBe(got.data.length);
  });

  it('merges a stream of one-keystroke chunks instead of keeping millions of entries', () => {
    const r = new SessionRecords();
    for (let i = 0; i < 20_000; i++) r.notePty(S, 'k');
    expect(r.ptyFrom(S)!.data.length).toBe(20_000);
  });

  it('an empty chunk adds nothing but still answers its position', () => {
    const r = new SessionRecords();
    r.notePty(S, 'ab');
    expect(r.notePty(S, '')).toMatchObject({ offset: 2 });
    expect(r.ptyFrom(S)!.data).toBe('ab');
  });

  it('a session that ended has no stream and cannot be revived by a late chunk', () => {
    const r = new SessionRecords();
    r.notePty(S, 'abc');
    r.drop(S);
    expect(r.ptyFrom(S)).toBeNull();
    expect(r.notePty(S, 'late')).toBeNull();
  });
});

describe('the asks, as events to replay', () => {
  const ask = (id: string) => ({ type: 'PermissionRequest', sessionId: S, payload: { _requestId: id, tool_name: 'Bash' }, timestamp: 1 });
  it('lists every open ask and nothing closed', () => {
    const r = new SessionRecords();
    r.note(S, 'hook:event', ask('a')); r.note(S, 'hook:event', ask('b'));
    r.note(S, 'hook:event', { type: 'PermissionResolved', sessionId: S, payload: { _requestId: 'a' }, timestamp: 2 });
    expect((r.asksForFill(S) as any[]).map((e) => e.payload._requestId)).toEqual(['b']);
  });

  it('a Claude Code ask whose hook closed comes with the same expiry the screen heard, so the card is kept, not live', () => {
    const r = new SessionRecords();
    r.note(S, 'hook:event', ask('a'));
    r.note(S, 'hook:event', { type: 'PermissionExpired', sessionId: S, payload: { _requestId: 'a', _reason: 'hook-closed' }, timestamp: 2 });
    const out = r.asksForFill(S) as any[];
    expect(out.map((e) => e.type)).toEqual(['PermissionRequest', 'PermissionExpired']);
    expect(out[1].payload._reason).toBe('hook-closed');
  });
});
