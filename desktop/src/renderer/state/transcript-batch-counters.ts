// Perf-lab counters for the transcript batcher (state/transcript-batch.ts). PERF/DEV ONLY.
//
// WHY (perf-lab workstream E, owner decision Q-4 2026-10-21): the lab could see words leave the
// producer and reach the bridge, but not what happened to them between the bridge and the chat
// reducer. These counters make "sent = received = enqueued = applied + dropped" checkable
// over CDP, plus how deep and how old the waiting queue ever got.
//
// WHY a build-time flag: the lab builds its own isolated candidate with VITE_PERF_COUNTERS=1.
// In every normal build `import.meta.env.VITE_PERF_COUNTERS` is statically replaced by Vite
// (undefined), `perfCountersEnabled()` is a constant false, no counters object is ever created
// and no window hook is installed. Same convention as VITE_WORKBENCH / VITE_SHOOT.

export interface BatcherCountersSnapshot {
  /** Every push() call, including ones after dispose (these are `droppedAfterDispose`). */
  pushed: number;
  /** push() calls accepted into the pending queue. */
  enqueued: number;
  /** Actions handed to the store's dispatch without it throwing. */
  applied: number;
  /** Actions still waiting when the batcher was disposed (the effect went away). */
  droppedOnDispose: number;
  /** push() calls that arrived after dispose and were refused. */
  droppedAfterDispose: number;
  /** Actions lost because dispatch threw (the batch had already left the queue). */
  droppedOnDispatchError: number;
  /** Actions in the queue right now. */
  pendingDepth: number;
  maxPendingDepth: number;
  /** Age (ms) of the oldest queued action right now; 0 when the queue is empty. */
  oldestPendingAgeMs: number;
  /** Largest age any action reached before it was applied or dropped. */
  maxOldestPendingAgeMs: number;
  /** flush() calls that applied at least one action. */
  flushes: number;
  /** Batchers installed since reset (StrictMode installs twice). */
  installs: number;
  /** Per action type, so the lab can match one kind (assistant text) against what the bridge delivered. */
  byType: Record<string, { enqueued: number; applied: number; dropped: number }>;
  /** enqueued - applied - dropped*: must be pendingDepth at any instant. */
  unaccounted: number;
}

export function perfCountersEnabled(): boolean {
  // @ts-ignore TS1343 — import.meta is intercepted by Vite at build time (same pattern as workbench-mode.ts)
  return import.meta.env.VITE_PERF_COUNTERS === '1';
}

export class BatcherCounters {
  private pushed = 0; private enqueued = 0; private applied = 0;
  private droppedOnDispose = 0; private droppedAfterDispose = 0; private droppedOnDispatchError = 0;
  private maxPendingDepth = 0; private maxAge = 0; private flushes = 0; private installs = 0;
  private depth = 0;
  // WHY per type: the queue also carries user messages, turn-complete and live-state actions, so total
  // `enqueued` cannot equal the bridge's text-event count; the per-type row can.
  private byType: Record<string, { enqueued: number; applied: number; dropped: number }> = {};
  private row(a: { type: string }) { return (this.byType[a.type] ??= { enqueued: 0, applied: 0, dropped: 0 }); }
  /** Enqueue time of the oldest queued action; null when the queue is empty. */
  private oldestAt: number | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  onInstall() { this.installs += 1; }
  onPush(action: { type: string }, accepted: boolean) {
    this.pushed += 1;
    if (!accepted) { this.droppedAfterDispose += 1; this.row(action).dropped += 1; return; }
    this.enqueued += 1;
    this.row(action).enqueued += 1;
    this.depth += 1;
    if (this.oldestAt === null) this.oldestAt = this.now();
    if (this.depth > this.maxPendingDepth) this.maxPendingDepth = this.depth;
  }
  /** These queued actions left the queue; `how` says where they went. */
  onLeave(actions: readonly { type: string }[], how: 'applied' | 'dispose' | 'error') {
    const n = actions.length;
    if (n <= 0) return;
    for (const a of actions) { const r = this.row(a); if (how === 'applied') r.applied += 1; else r.dropped += 1; }
    // The whole queue always leaves together (splice(0)), so the oldest one's age is the batch's worst.
    if (this.oldestAt !== null) this.maxAge = Math.max(this.maxAge, this.now() - this.oldestAt);
    this.depth -= n;
    if (this.depth <= 0) { this.depth = 0; this.oldestAt = null; }
    if (how === 'applied') { this.applied += n; this.flushes += 1; }
    else if (how === 'dispose') this.droppedOnDispose += n;
    else this.droppedOnDispatchError += n;
  }
  reset() {
    // Keeps the live queue's depth/age (those actions still exist); zeroes the history.
    this.pushed = this.enqueued = this.applied = 0;
    this.droppedOnDispose = this.droppedAfterDispose = this.droppedOnDispatchError = 0;
    this.maxPendingDepth = this.depth; this.maxAge = 0; this.flushes = 0; this.installs = 0;
    // Actions already queued at reset count as enqueued so the identity still balances.
    this.enqueued = this.depth; this.pushed = this.depth;
    this.byType = {};
  }
  snapshot(): BatcherCountersSnapshot {
    const age = this.oldestAt === null ? 0 : this.now() - this.oldestAt;
    const dropped = this.droppedOnDispose + this.droppedOnDispatchError;
    return {
      pushed: this.pushed, enqueued: this.enqueued, applied: this.applied,
      droppedOnDispose: this.droppedOnDispose, droppedAfterDispose: this.droppedAfterDispose,
      droppedOnDispatchError: this.droppedOnDispatchError,
      pendingDepth: this.depth, maxPendingDepth: this.maxPendingDepth,
      oldestPendingAgeMs: age, maxOldestPendingAgeMs: Math.max(this.maxAge, age),
      flushes: this.flushes, installs: this.installs,
      byType: JSON.parse(JSON.stringify(this.byType)),
      unaccounted: this.enqueued - this.applied - dropped - this.depth,
    };
  }
}

declare global { interface Window { __transcriptBatcherCounters?: { snapshot(): BatcherCountersSnapshot; reset(): void } } }

let shared: BatcherCounters | null = null;
/** The window's one counters object, or null when the perf flag is off (the normal case). */
export function sharedBatcherCounters(): BatcherCounters | null {
  if (!perfCountersEnabled()) return null;
  if (!shared) {
    shared = new BatcherCounters();
    const c = shared;
    // WHY a plain object of functions: the lab reads window.__transcriptBatcherCounters.snapshot() over CDP.
    if (typeof window !== 'undefined') window.__transcriptBatcherCounters = { snapshot: () => c.snapshot(), reset: () => c.reset() };
  }
  return shared;
}
/** Test-only: forget the shared object and its window hook. */
export function _resetSharedBatcherCountersForTest() {
  shared = null;
  if (typeof window !== 'undefined') delete window.__transcriptBatcherCounters;
}
