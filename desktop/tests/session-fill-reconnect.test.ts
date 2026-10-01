// The plan's gate for the one fill path (one-core R5-2): a phone that drops mid-turn and reconnects is sent what it MISSED, not its whole
// history; and the cases that cannot be continued (a new epoch, an overflowed ring, a ring too small for the gap) fall back to a fresh page.
// Bytes are measured as the JSON the host would put on the socket, and printed.
import { describe, it, expect } from 'vitest';
import { SessionRecords } from '../src/main/session-record';
import { openSession, type OpenDeps, type OpenReply } from '../src/main/session-open';
import { AudienceFills } from '../src/main/audience-fill';
import { createPublish } from '../src/main/publish';
import type { TranscriptPageResult } from '../src/shared/types';

const S = 's1';
const bytes = (v: unknown) => JSON.stringify(v).length;
const turnText = 'x'.repeat(2000);
const user = (n: number) => ({ sessionId: S, type: 'user-message', uuid: `m${n}`, timestamp: n, data: { text: `question ${n}` } });
const tool = (n: number) => ({ sessionId: S, type: 'tool-result', uuid: `t${n}`, timestamp: n, data: { toolUseId: `k${n}`, toolResult: turnText, isError: false } });
const delta = (n: number) => ({ sessionId: S, type: 'assistant-text', uuid: `d${n}`, timestamp: n, data: { text: 'word ', partId: 'text-0' } });

/** A page as big as the real thing: 30 turns of 2 KB answers (what a first open really carries). */
const bigPage = (): TranscriptPageResult => ({
  events: Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? user(i) : { ...tool(i), type: 'assistant-text', data: { text: turnText } })) as any, cursor: null, hasMore: true,
});

const deps = (records: SessionRecords): OpenDeps => ({ records, knows: () => true, page: async () => bigPage(), native: () => null });
const ok = (r: OpenReply) => { if (!r.ok) throw new Error('not ok'); return r; };

/** A long-running session: 400 turns of history already in the ring. */
function longSession(opts: ConstructorParameters<typeof SessionRecords>[0] = {}) {
  const records = new SessionRecords(opts);
  records.begin(S);
  for (let i = 0; i < 400; i++) { records.note(S, 'transcript:event', user(i)); records.note(S, 'transcript:event', tool(i)); }
  return records;
}

describe('reconnect: bytes sent are proportional to what was missed, not to history', () => {
  it('drop mid-turn, reconnect: only the missed events travel (measured against a first open of the same session)', async () => {
    const records = longSession();
    // the phone's first open
    const first = ok(await openSession(deps(records), { sessionId: S, fresh: true }, { remote: true }));
    const A = bytes(first);
    // the phone is mid-turn: it has everything up to here
    records.note(S, 'transcript:event', user(1000));
    for (let i = 0; i < 20; i++) records.note(S, 'transcript:event', delta(i));
    const have = { epoch: records.epochOf(S)!, seq: records.headSeq(S) };
    // ...the connection drops. During the gap the turn goes on.
    const missedFew = [];
    for (let i = 20; i < 30; i++) { const e = delta(i); records.note(S, 'transcript:event', e); missedFew.push(e); }
    const B10 = bytes(ok(await openSession(deps(records), { sessionId: S, have }, { remote: true })));
    const missedMore = [];
    for (let i = 30; i < 130; i++) { const e = delta(i); records.note(S, 'transcript:event', e); missedMore.push(e); }
    const B110 = bytes(ok(await openSession(deps(records), { sessionId: S, have }, { remote: true })));
    const wire10 = bytes(missedFew), wire110 = bytes([...missedFew, ...missedMore]);
    // eslint-disable-next-line no-console
    console.log(`[reconnect gate] first open ${A} bytes (history); reconnect after 10 missed events ${B10} bytes (the events themselves: ${wire10}); after 110 missed ${B110} bytes (events: ${wire110})`);
    expect(A).toBeGreaterThan(100_000);                       // history is big
    expect(B10).toBeLessThan(A / 100);                        // a tiny fraction of history
    expect(B110).toBeLessThan(A / 10);
    expect(B10).toBeLessThan(wire10 * 3);                     // about the size of what was missed (plus the small envelope)
    expect(B110 / B10).toBeGreaterThan(6);                    // it grows with the gap...
    expect(B110 / B10).toBeLessThan(14);                      // ...and only with the gap
  });

  it('a reconnect with nothing missed sends only the envelope', async () => {
    const records = longSession();
    const have = { epoch: records.epochOf(S)!, seq: records.headSeq(S) };
    const B = bytes(ok(await openSession(deps(records), { sessionId: S, have }, { remote: true })));
    expect(B).toBeLessThan(400);
  });

  it('a changed epoch (the session was recreated, or the computer restarted) falls back to a fresh page', async () => {
    const records = longSession();
    const have = { epoch: records.epochOf(S)!, seq: records.headSeq(S) };
    const restarted = longSession();                          // a new record: a new epoch
    const reply = ok(await openSession(deps(restarted), { sessionId: S, have }));
    expect(reply.resume).toBe('page');
    expect(reply.page!.events.length).toBe(60);
  });

  it('a ring overflow (the gap is older than the ring keeps) falls back to a fresh page', async () => {
    const records = new SessionRecords({ maxEvents: 50 });
    records.begin(S);
    for (let i = 0; i < 10; i++) records.note(S, 'transcript:event', user(i));
    const have = { epoch: records.epochOf(S)!, seq: records.headSeq(S) };
    for (let i = 0; i < 200; i++) records.note(S, 'transcript:event', delta(i));
    const reply = ok(await openSession(deps(records), { sessionId: S, have }));
    expect(reply.resume).toBe('page');
  });

  it('a ring too small for the gap by ONE event still falls back (never a silent hole)', async () => {
    const records = new SessionRecords({ maxEvents: 10 });
    records.begin(S);
    const have = { epoch: records.epochOf(S)!, seq: 0 };
    for (let i = 0; i < 10; i++) records.note(S, 'transcript:event', delta(i));
    expect(ok(await openSession(deps(records), { sessionId: S, have })).resume).toBe('events');   // exactly fits
    records.note(S, 'transcript:event', delta(99));
    expect(ok(await openSession(deps(records), { sessionId: S, have })).resume).toBe('page');      // one too many
  });

  it('an event too large to hold leaves a visible gap, so a screen that missed it takes a page', async () => {
    const records = new SessionRecords();
    records.begin(S);
    const have = { epoch: records.epochOf(S)!, seq: records.headSeq(S) };
    records.note(S, 'transcript:event', delta(1));
    records.note(S, 'transcript:event', { ...tool(2), data: { toolUseId: 'k', toolResult: 'z'.repeat(3 * 1024 * 1024), isError: false } });
    records.note(S, 'transcript:event', delta(3));
    expect(ok(await openSession(deps(records), { sessionId: S, have })).resume).toBe('page');
  });
});

describe('the answer and the live stream never overlap or leave a gap', () => {
  /** A phone's socket as publish sees it: what it was sent, in order, with the reply marked. */
  function wire() {
    const sent: Array<{ kind: 'push' | 'reply'; seq?: number; type?: string }> = [];
    const fills = new AudienceFills();
    const records = longSession();
    const publish = createPublish({
      records, fills,
      toWindows: () => {},
      toSockets: (message, _ids, hold) => {
        const deliver = () => sent.push({ kind: 'push', seq: message.seq, type: message.type });
        if (hold?.(7, deliver)) return;
        deliver();
      },
    });
    return { sent, fills, records, publish };
  }

  it('pushes that happen while a fill is in flight are held, then follow the answer in order, each above the answer\'s head', async () => {
    const { sent, fills, records, publish } = wire();
    fills.begin('s7', S);
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    const pending = openSession({ ...deps(records), page: async () => { await slow; return bigPage(); } }, { sessionId: S, fresh: true });
    publish(S, 'transcript:event', delta(1)); publish(S, 'transcript:event', delta(2));       // during the page read
    expect(sent).toEqual([]);                                                                    // held
    release();
    const reply = ok(await pending);
    sent.push({ kind: 'reply' });                                                                // the door sends the answer...
    fills.release('s7', S);                                                                      // ...then lets the held pushes through
    publish(S, 'transcript:event', delta(3));                                                    // and live flow resumes
    expect(sent.map((s) => s.kind)).toEqual(['reply', 'push', 'push', 'push']);
    const seqs = sent.filter((s) => s.kind === 'push').map((s) => s.seq!);
    expect(seqs).toEqual([reply.headSeq + 1, reply.headSeq + 2, reply.headSeq + 3]);             // no gap, nothing at or below the head
  });

  it('a screen that is not being filled is delivered to at once (a window that already holds the session pays nothing)', () => {
    const { sent, publish } = wire();
    publish(S, 'transcript:event', delta(1));
    expect(sent).toHaveLength(1);
  });

  it('a screen that never gets its answer is not held forever', async () => {
    const fills = new AudienceFills();
    const delivered: number[] = [];
    fills.begin('w1', S, 20);
    fills.hold('w1', S, () => delivered.push(1));
    await new Promise((r) => setTimeout(r, 60));
    expect(delivered).toEqual([1]);
    expect(fills.filling('w1', S)).toBe(false);
  });

  it('a screen that goes away mid-fill is owed nothing', () => {
    const fills = new AudienceFills();
    const delivered: number[] = [];
    fills.begin('s7', S);
    fills.hold('s7', S, () => delivered.push(1));
    fills.forget('s7');
    fills.release('s7', S);
    expect(delivered).toEqual([]);
    expect(fills.pending()).toBe(0);
  });
});
