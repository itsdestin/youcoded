// The session record (src/main/session-record.ts): the numbered ring, the epoch, the open asks, the resume rule.
import { describe, it, expect } from 'vitest';
import { SessionRecords, RING_MAX_EVENTS, RING_MAX_BYTES, SESSION_SCOPED_PUSHES } from '../src/main/session-record';

const S = 's1';
const text = (n: number, size = 20) => ({ sessionId: S, type: 'assistant-text', uuid: `u${n}`, timestamp: n, data: { text: 'x'.repeat(size) } });
const ask = (id: string) => ({ type: 'PermissionRequest', sessionId: S, payload: { _requestId: id, tool_name: 'Bash' }, timestamp: 1 });
const hook = (type: string, id: string, extra: Record<string, unknown> = {}) => ({ type, sessionId: S, payload: { _requestId: id, ...extra }, timestamp: 1 });

function fill(r: SessionRecords, n: number, size = 20) {
  for (let i = 1; i <= n; i++) r.note(S, 'transcript:event', text(i, size));
}

describe('the ring', () => {
  it('numbers events from 1 without gaps', () => {
    const r = new SessionRecords();
    fill(r, 5);
    expect(r.events(S).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(r.headSeq(S)).toBe(5);
  });

  it('never holds more than 2,000 events, and keeps the newest', () => {
    const r = new SessionRecords();
    fill(r, RING_MAX_EVENTS + 750);
    const ev = r.events(S);
    expect(ev).toHaveLength(RING_MAX_EVENTS);
    expect(ev[0].seq).toBe(751);
    expect(ev.at(-1)!.seq).toBe(RING_MAX_EVENTS + 750);
    expect(r.oldestSeq(S)).toBe(751);
  });

  it('never holds more than 2 MB, and keeps the newest', () => {
    const r = new SessionRecords();
    fill(r, 100, 100_000); // ~100 KB each: about 10 MB offered
    const ev = r.events(S);
    const bytes = ev.reduce((s, e) => s + e.bytes, 0);
    expect(bytes).toBeLessThanOrEqual(RING_MAX_BYTES);
    expect(ev.length).toBeLessThan(25);
    expect(ev.at(-1)!.seq).toBe(100);
    expect(r.stats().ringBytes).toBe(bytes); // the running total matches what is held
  });

  it('holds whichever bound is reached first (many tiny events: the count; a few huge ones: the bytes)', () => {
    const tiny = new SessionRecords();
    fill(tiny, 5000, 1);
    expect(tiny.events(S)).toHaveLength(RING_MAX_EVENTS);
    const huge = new SessionRecords();
    fill(huge, 10, 500_000);
    expect(huge.events(S).length).toBeLessThanOrEqual(4);
  });

  it('keeps a small custom bound too (the bounds are parameters, not literals in the loop)', () => {
    const r = new SessionRecords({ maxEvents: 3, maxBytes: 10_000 });
    fill(r, 10);
    expect(r.events(S).map((e) => e.seq)).toEqual([8, 9, 10]);
  });

  it('numbers an event too large to hold but does not hold it, so a client sees a gap and takes a fresh page', () => {
    const r = new SessionRecords();
    fill(r, 3);
    r.note(S, 'transcript:event', text(4, RING_MAX_BYTES + 10));
    r.note(S, 'transcript:event', text(5));
    expect(r.headSeq(S)).toBe(5);
    expect(r.events(S).map((e) => e.seq)).toEqual([1, 2, 3, 5]);
    // A client that had event 3 cannot be handed 4: it is not held.
    expect(r.resume(S, { epoch: r.epochOf(S)!, seq: 3 })).toMatchObject({ resume: 'page' });
    expect(r.resume(S, { epoch: r.epochOf(S)!, seq: 4 })).toMatchObject({ resume: 'events' });
  });
});

describe('the epoch', () => {
  it('is new for each record, and random', () => {
    const r = new SessionRecords();
    r.begin('a'); r.begin('b');
    expect(r.epochOf('a')).toMatch(/^[0-9a-f]{16}$/);
    expect(r.epochOf('a')).not.toBe(r.epochOf('b'));
  });

  it('does not change when events arrive, including a /clear or /compact', () => {
    const r = new SessionRecords();
    r.begin(S);
    const epoch = r.epochOf(S);
    fill(r, 10);
    r.note(S, 'transcript:shrink', { sessionId: S, oldSize: 100, newSize: 5 }); // /compact and /clear truncate the file
    r.note(S, 'transcript:event', { sessionId: S, type: 'context-clear', uuid: 'c', timestamp: 1, data: {} });
    r.note(S, 'transcript:event', { sessionId: S, type: 'compact-summary', uuid: 'cs', timestamp: 2, data: { summary: 's' } });
    expect(r.epochOf(S)).toBe(epoch);
    // The shrink is itself a numbered event, so a client inside the range replays it.
    expect(r.events(S).some((e) => e.type === 'transcript:shrink')).toBe(true);
  });

  it('a session created again (resumed, or the app restarted) is a new record with a new epoch, and a number restarted at 1', () => {
    const r = new SessionRecords();
    r.begin(S);
    const first = r.epochOf(S);
    fill(r, 3);
    r.drop(S);
    r.begin(S);
    expect(r.epochOf(S)).not.toBe(first);
    expect(r.headSeq(S)).toBe(0);
  });

  it('is never reused after the session ends: a late event does not bring the record back', () => {
    const r = new SessionRecords();
    fill(r, 2);
    r.drop(S);
    expect(r.note(S, 'transcript:event', text(3))).toBeNull();
    expect(r.has(S)).toBe(false);
    expect(r.facts(S)).toBeNull();
  });
});

describe('resume: events after N, or a fresh page', () => {
  const make = () => { const r = new SessionRecords({ maxEvents: 5 }); fill(r, 12); return r; }; // holds 8..12

  it('same epoch, next event still held: send what was missed', () => {
    const r = make();
    const d = r.resume(S, { epoch: r.epochOf(S)!, seq: 9 });
    expect(d).toMatchObject({ resume: 'events', headSeq: 12 });
    expect((d as any).events.map((e: any) => e.seq)).toEqual([10, 11, 12]);
  });

  it('exactly at the oldest edge is still a replay (the next event is the first one held)', () => {
    const r = make();
    expect((r.resume(S, { epoch: r.epochOf(S)!, seq: 7 }) as any).events.map((e: any) => e.seq)).toEqual([8, 9, 10, 11, 12]);
  });

  it('older than the ring reaches: a fresh page', () => {
    const r = make();
    expect(r.resume(S, { epoch: r.epochOf(S)!, seq: 6 })).toMatchObject({ resume: 'page' });
  });

  it('a different epoch, nothing, or a number from the future: a fresh page', () => {
    const r = make();
    expect(r.resume(S, { epoch: 'other', seq: 10 })).toMatchObject({ resume: 'page' });
    expect(r.resume(S, null)).toMatchObject({ resume: 'page' });
    expect(r.resume(S, { epoch: r.epochOf(S)!, seq: 99 })).toMatchObject({ resume: 'page' });
  });

  it('already at the head: nothing to send, still a replay', () => {
    const r = make();
    expect(r.resume(S, { epoch: r.epochOf(S)!, seq: 12 })).toMatchObject({ resume: 'events', events: [] });
  });

  it('a session that does not exist answers null', () => {
    expect(new SessionRecords().resume('nope', null)).toBeNull();
  });
});

describe('open asks live outside the ring', () => {
  it('survive the ring trimming away the request that raised them', () => {
    const r = new SessionRecords();
    r.note(S, 'hook:event', ask('r1'));
    fill(r, RING_MAX_EVENTS * 3);
    expect(r.events(S).some((e) => (e.payload as any)?.type === 'PermissionRequest')).toBe(false); // trimmed out of the ring
    expect(r.openAsks(S)).toHaveLength(1); // still waiting
    expect(r.facts(S)!.awaitingCount).toBe(1);
  });

  it('leave when resolved, and when they expire (except a Claude Code ask whose hook closed: its own menu may still wait)', () => {
    const r = new SessionRecords();
    r.note(S, 'hook:event', ask('a'));
    r.note(S, 'hook:event', ask('b'));
    r.note(S, 'hook:event', ask('c'));
    r.note(S, 'hook:event', ask('d'));
    r.note(S, 'hook:event', hook('PermissionResolved', 'a'));
    r.note(S, 'hook:event', hook('PermissionExpired', 'b', { _reason: 'app-timeout' }));
    r.note(S, 'hook:event', hook('PermissionExpired', 'c', { _reason: 'hook-closed' }));
    expect(r.openAsks(S).map((e: any) => e.payload._requestId).sort()).toEqual(['c', 'd']);
    r.note(S, 'hook:event', hook('PermissionExpired', 'd')); // no reason: resolved
    expect(r.openAsks(S).map((e: any) => e.payload._requestId)).toEqual(['c']);
  });

  it('hold the whole event so a card can be drawn from it', () => {
    const r = new SessionRecords();
    r.note(S, 'hook:event', ask('r1'));
    expect(r.openAsks(S)[0]).toMatchObject({ type: 'PermissionRequest', payload: { tool_name: 'Bash' } });
  });

  it('are capped per session, so a runaway producer cannot grow the set without bound', () => {
    const r = new SessionRecords();
    for (let i = 0; i < 500; i++) r.note(S, 'hook:event', ask(`r${i}`));
    expect(r.openAsks(S).length).toBeLessThanOrEqual(200);
  });

  it('never keep a password ask (only that one is waiting), in the ring or among the asks', () => {
    const r = new SessionRecords();
    r.note(S, 'hook:event', { type: 'PasswordRequest', sessionId: S, payload: { _requestId: 'pw', command: 'sudo secret-thing', toolUseId: 't' }, timestamp: 1 });
    expect(r.facts(S)!.awaitingCount).toBe(1);
    expect(r.openAsks(S)).toEqual([]);
    expect(JSON.stringify(r.events(S))).not.toContain('secret-thing');
    r.note(S, 'hook:event', hook('PasswordResolved', 'pw'));
    expect(r.facts(S)!.awaitingCount).toBe(0);
  });
});

describe('live facts and the summary', () => {
  it('read a native session\'s queue and mode from the host, never a copy of them', () => {
    const r = new SessionRecords();
    let queue = ['q1', 'q2'];
    r.setLiveSource((id) => (id === S ? { queued: queue, permissionMode: 'auto-edit' } : null));
    r.begin(S);
    expect(r.summary(S)).toMatchObject({ queuedCount: 2, permissionMode: 'auto-edit' });
    queue = [];
    expect(r.summary(S)!.queuedCount).toBe(0);
  });

  it('take the mode and the model state from their pushes when no host answers', () => {
    const r = new SessionRecords();
    r.note(S, 'native:permission-mode', { sessionId: S, mode: 'full-auto' });
    r.note(S, 'native:model-state', { sessionId: S, modelId: 'm1', state: 'loading' });
    r.note(S, 'transcript:event', { sessionId: S, type: 'assistant-text', uuid: 'a', timestamp: 1, data: { text: 'x', model: 'claude-opus' } });
    expect(r.facts(S)).toMatchObject({ permissionMode: 'full-auto', modelState: { state: 'loading', modelId: 'm1' }, model: 'claude-opus' });
  });

  it('prefer a relayed attention that says something is wrong, else what the events say', () => {
    const r = new SessionRecords();
    r.begin(S);
    r.noteReportedAttention(S, 'stuck');
    expect(r.summary(S)!.attention).toBe('stuck');
    r.noteReportedAttention(S, 'ok');
    expect(r.summary(S)!.attention).toBe('ok');
  });

  it('cover every live session and only those', () => {
    const r = new SessionRecords();
    r.begin('a'); r.begin('b'); r.drop('a');
    expect(Object.keys(r.summaries())).toEqual(['b']);
  });

  it('survive a host that throws (a bad read costs the host\'s facts, not the summary)', () => {
    const r = new SessionRecords();
    r.setLiveSource(() => { throw new Error('boom'); });
    r.begin(S);
    expect(r.summary(S)).toMatchObject({ queuedCount: 0 });
  });
});

describe('what is carried', () => {
  it('lists the nine session-scoped pushes', () => {
    expect([...SESSION_SCOPED_PUSHES].sort()).toEqual([
      'hook:event', 'native:model-state', 'native:permission-mode', 'native:session-context', 'native:shell-event',
      'session:meta-changed', 'specialists:event', 'transcript:event', 'transcript:shrink',
    ]);
  });
});
