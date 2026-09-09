// AcceptedHistoryCapture — the harness's in-memory bookkeeping for WHICH
// transcript events the CURRENT model history was accepted from (Stage 4 of the
// ChatGPT cache-efficiency work, architecture doc
// docs/active/plans/2026-09-09-cache-stage4-architecture.md → "Capture").
//
// Two intents this file exists to pin:
//  1. ATTEMPT SCOPING. A stream attempt that gets abandoned (a stall auto-retry,
//     a manual Retry, an interrupt before any text) emitted real transcript
//     events the user saw — but its text never entered history, so its uuids
//     must never be published as the provenance of a message.
//  2. REVISION HONESTY. Every mutation of history bumps the revision (the fence
//     the durable store checks); request-only work (fitToContext) never reaches
//     this class at all, so it cannot bump it.
import { describe, expect, it } from 'vitest';
import { AcceptedHistoryCapture } from '../src/main/harness/accepted-history-capture';

describe('AcceptedHistoryCapture', () => {
  it('accepts an attempt in emit order and excludes an abandoned retry entirely', () => {
    const capture = new AcceptedHistoryCapture();
    capture.recordEvent('u1');

    const abandoned = capture.beginAttempt();
    capture.recordAttemptEvent(abandoned, 'bad-text', 'text');
    capture.recordAttemptEvent(abandoned, 'bad-reasoning', 'reasoning');
    capture.abandonAttempt(abandoned);

    const accepted = capture.beginAttempt();
    capture.recordAttemptEvent(accepted, 'r1', 'reasoning');
    capture.recordAttemptEvent(accepted, 'a1', 'text');
    capture.acceptAttempt(accepted);
    capture.recordEvent('c1');
    capture.recordEvent('o1');

    expect(capture.snapshot().eventUuids).toEqual(['u1', 'r1', 'a1', 'c1', 'o1']);
  });

  it('an interrupted attempt contributes its text uuids only — reasoning is never partial-accepted', () => {
    const capture = new AcceptedHistoryCapture();
    const attempt = capture.beginAttempt();
    capture.recordAttemptEvent(attempt, 'r1', 'reasoning');
    capture.recordAttemptEvent(attempt, 'a1', 'text');
    capture.recordAttemptEvent(attempt, 'a2', 'text');
    capture.acceptAttemptText(attempt);

    expect(capture.snapshot().eventUuids).toEqual(['a1', 'a2']);
  });

  it('an attempt can only be consumed once, and an unknown attempt is inert', () => {
    const capture = new AcceptedHistoryCapture();
    const attempt = capture.beginAttempt();
    capture.recordAttemptEvent(attempt, 'a1', 'text');
    capture.acceptAttempt(attempt);
    const afterAccept = capture.snapshot().revision;

    capture.acceptAttempt(attempt);          // double-accept (a caller bug) adds nothing
    capture.acceptAttempt(-1 as any);        // never begun
    capture.abandonAttempt(-1 as any);

    expect(capture.snapshot().eventUuids).toEqual(['a1']);
    expect(capture.snapshot().revision).toBe(afterAccept);
  });

  it('a new attempt discards a still-pending one — a stream that threw is never accepted', () => {
    const capture = new AcceptedHistoryCapture();
    const threw = capture.beginAttempt();
    capture.recordAttemptEvent(threw, 'thrown-text', 'text');

    const rerun = capture.beginAttempt();
    capture.recordAttemptEvent(rerun, 'rerun-text', 'text');
    capture.acceptAttempt(rerun);
    capture.acceptAttempt(threw);            // too late — the entry is gone

    expect(capture.snapshot().eventUuids).toEqual(['rerun-text']);
  });

  it('every history mutation bumps the revision; only accepted attempts and events add uuids', () => {
    const capture = new AcceptedHistoryCapture();
    const start = capture.revision;

    capture.mutated();                       // steer / status snapshot / rule injection / strip
    expect(capture.revision).toBe(start + 1);
    expect(capture.snapshot().eventUuids).toEqual([]);

    capture.recordEvent('u1');
    expect(capture.revision).toBe(start + 2);

    const attempt = capture.beginAttempt();  // beginning/abandoning changes no history
    capture.recordAttemptEvent(attempt, 'a1', 'text');
    expect(capture.revision).toBe(start + 2);
    capture.abandonAttempt(attempt);
    expect(capture.revision).toBe(start + 2);

    const kept = capture.beginAttempt();
    capture.acceptAttempt(kept);             // an empty step still pushed a message
    expect(capture.revision).toBe(start + 3);
  });

  it('records prune and summary transformations, each a durable change', () => {
    const capture = new AcceptedHistoryCapture();
    capture.recordEvent('u1');
    const beforePrune = capture.revision;

    capture.markPruned();
    expect(capture.snapshot().transformation).toEqual({ kind: 'pruned' });
    expect(capture.revision).toBe(beforePrune + 1);

    capture.markSummary('summary-1');
    expect(capture.snapshot().transformation).toEqual({ kind: 'summary', summaryEventUuid: 'summary-1' });
    expect(capture.revision).toBe(beforePrune + 2);
  });

  it('reset clears or seeds, and every snapshot hands back a fresh array', () => {
    const capture = new AcceptedHistoryCapture();
    capture.recordEvent('u1');
    capture.markPruned();
    const beforeClear = capture.revision;

    capture.reset();                         // /clear — a durable change with no seed
    expect(capture.snapshot()).toEqual({ revision: beforeClear + 1, eventUuids: [], transformation: undefined });

    capture.reset({ eventUuids: ['a', 'b'], revision: 42, transformation: { kind: 'summary', summaryEventUuid: 's' } });
    expect(capture.snapshot()).toEqual({
      revision: 42, eventUuids: ['a', 'b'], transformation: { kind: 'summary', summaryEventUuid: 's' },
    });

    const first = capture.snapshot().eventUuids;
    first.push('mutating the caller\'s copy');
    expect(capture.snapshot().eventUuids).toEqual(['a', 'b']);
  });
});
