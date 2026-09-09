// Accepted-history capture (cache Stage 4, architecture doc
// docs/active/plans/2026-09-09-cache-stage4-architecture.md → "Capture").
//
// Answers ONE question at any moment: which transcript event uuids is the
// harness's CURRENT `history` accepted from? The durable store turns that list
// into content references, so the answer must be exact — a uuid listed here is
// a promise that the message bytes came from that event.
//
// Pure in-memory bookkeeping: it never touches disk, never sees message content,
// and holds nothing but uuids and counters. Owned by HarnessSession, which calls
// it at EVERY site that mutates `this.history` (and nowhere else — a request-only
// projection like fitToContext must not reach it).

/** Identifies one stream attempt. Opaque to callers; only this module mints them. */
export type AttemptId = number;

/** What the last history-wide rewrite did, when there was one. Latest wins:
 *  the store needs to know how to reconstruct the CURRENT history, not its
 *  whole editing history. */
export type AcceptedHistoryTransformation =
  | { kind: 'pruned' }
  | { kind: 'summary'; summaryEventUuid: string };

/** Restore-time starting point (host resume). Without one, the capture starts
 *  empty at the next revision. */
export interface AcceptedHistorySeed {
  eventUuids: string[];
  revision?: number;
  transformation?: AcceptedHistoryTransformation;
}

export interface AcceptedHistoryCaptureSnapshot {
  revision: number;
  eventUuids: string[];
  transformation: AcceptedHistoryTransformation | undefined;
}

type AttemptEvent = { uuid: string; kind: 'text' | 'reasoning' };

export class AcceptedHistoryCapture {
  private _revision = 0;
  private accepted: string[] = [];
  private transformation: AcceptedHistoryTransformation | undefined;
  private pending = new Map<AttemptId, AttemptEvent[]>();
  private nextAttemptId = 1;

  /** Monotonic within a session, and the fence the durable store checks: a
   *  published checkpoint is only valid while history has not moved past the
   *  revision it was taken at. */
  get revision(): number { return this._revision; }

  /** A whole event's worth of history: the user message, a skill invocation, a
   *  tool call, a tool result, a compaction summary. Attempt-scoped assistant
   *  deltas go through recordAttemptEvent instead — they are only provisional
   *  until the step is accepted. */
  recordEvent(uuid: string): void {
    this.accepted.push(uuid);
    this._revision++;
  }

  /** Open a stream attempt. Its events stay provisional until accept/abandon.
   *
   *  WHY this also discards a still-pending attempt: attempts are strictly
   *  serial (send() is non-re-entrant, one stream at a time), so a pending
   *  entry here belongs to a stream that threw and was never resolved — and
   *  "never resolved" means "never accepted". Dropping it keeps the map bounded
   *  over a long session AND fails in the safe direction: uuids that never
   *  enter the accepted list can only understate provenance, never overstate it. */
  beginAttempt(): AttemptId {
    this.pending.clear();
    const id = this.nextAttemptId++;
    this.pending.set(id, []);
    return id;
  }

  recordAttemptEvent(attempt: AttemptId, uuid: string, kind: 'text' | 'reasoning'): void {
    this.pending.get(attempt)?.push({ uuid, kind });
  }

  /** The attempt's output never entered history (stall auto-retry, manual Retry,
   *  an interrupt with nothing pushed, an empty step). Changes no history, so it
   *  does NOT bump the revision. */
  abandonAttempt(attempt: AttemptId): void {
    this.pending.delete(attempt);
  }

  /** The step's assistant message was pushed whole: every uuid enters, in emit
   *  order. Bumps the revision even for an attempt that streamed nothing — the
   *  push itself is the history change (e.g. a step that only called a tool). */
  acceptAttempt(attempt: AttemptId): void {
    this.commit(attempt, () => true);
  }

  /** An interrupted step whose PARTIAL text was pushed as a plain string.
   *  Reasoning is never accepted here: an incomplete reasoning block is exactly
   *  what Stage 3 refuses to commit, so no message content descends from it. */
  acceptAttemptText(attempt: AttemptId): void {
    this.commit(attempt, (e) => e.kind === 'text');
  }

  private commit(attempt: AttemptId, keep: (event: AttemptEvent) => boolean): void {
    const events = this.pending.get(attempt);
    if (!events) return;                     // already consumed, or never begun
    this.pending.delete(attempt);
    for (const event of events) if (keep(event)) this.accepted.push(event.uuid);
    this._revision++;
  }

  /** History changed without gaining an event-backed message: a steer, a
   *  specialist-status snapshot, a path-triggered rule injection, or a
   *  continuation strip. The store reconstructs these some other way; all this
   *  class owes them is an honest revision. */
  mutated(): void {
    this._revision++;
  }

  markSummary(summaryUuid: string): void {
    this.transformation = { kind: 'summary', summaryEventUuid: summaryUuid };
    this._revision++;
  }

  markPruned(): void {
    this.transformation = { kind: 'pruned' };
    this._revision++;
  }

  /** Resume (with a seed) or /clear (without one). A clear takes the NEXT
   *  revision rather than resetting to zero: it is a real, durable change that
   *  must invalidate any checkpoint published before it. */
  reset(seed?: AcceptedHistorySeed): void {
    this.pending.clear();
    this.accepted = seed ? [...seed.eventUuids] : [];
    this.transformation = seed?.transformation;
    this._revision = seed?.revision ?? this._revision + 1;
  }

  /** A copy, always — the caller (the host's publish path) hands this list
   *  across an async boundary while turns keep running underneath it. */
  snapshot(): AcceptedHistoryCaptureSnapshot {
    return { revision: this._revision, eventUuids: [...this.accepted], transformation: this.transformation };
  }
}
