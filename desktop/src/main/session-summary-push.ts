// session-summary-push.ts — the small per-session facts a session strip and its dots need, pushed to everyone.
//
// WHY (2026-10-01 one-core R5-1): today a phone draws a session's dot from that session's OWN events, so it can
// only be right about sessions whose events it receives. Per-session delivery (R5-3) stops sending an unwatched
// session's events, so something small about EVERY session has to keep flowing. This is that push. It is sent
// alongside `attentionMap` (status:data, unchanged). R5-3: a phone draws its strip dots and plays its attention sound from it
// (renderer/hooks/useSessionSummaries.ts); the computer's own windows keep deriving theirs from the events they receive.
//
// Its own message type (`session:summary`) rather than a field on status:data: status:data is deduplicated as one
// blob, so a working/idle flip inside it would make every status push differ and the existing payload would
// change shape. A phone from before this run ignores an unknown push type (remote-shim's switch has no default).
import { IPC } from '../shared/backend-contract';
import type { SessionRecords } from './session-record';
import type { SessionSummaryPayload } from '../shared/session-summary-types';

export const SESSION_SUMMARY_CHANNEL = IPC.SESSION_SUMMARY;

export interface SessionSummaryPushOptions {
  records: Pick<SessionRecords, 'summaries'>;
  /** Deliver to every window and every phone. */
  deliver(payload: SessionSummaryPayload): void;
  /** Can anyone see a status bar right now? (status-push-gate's question; nothing is built for nobody.) */
  hasAudience(): boolean;
  /** Called with a function that runs when a phone connects, so it gets the current summaries at once. */
  onPhoneConnected?(listener: () => void): () => void;
  intervalMs?: number;
  /** Is a phone connected? An event-driven push is only worth building for someone who reads it (windows still get the timer's). */
  hasPhone?(): boolean;
  /** Quiet time before a change is pushed, so a burst of them (a turn ending, its asks closing) leaves as ONE message. */
  debounceMs?: number;
}

export interface SessionSummaryPush {
  /** Build now and deliver unless identical to the last delivery. */
  push(): void;
  /**
   * A session's summary changed (SessionRecords.onSummaryChange): push it within a few milliseconds.
   * WHY (one-core R5-3): a phone draws its dots and plays its attention sound from this push alone, so waiting for the 10 s timer
   * would show a session that just needs an answer as idle for ten seconds. The timer stays as the safety net (and carries what
   * no event announces, like the queue length).
   */
  notify(): void;
  stop(): void;
}

export function startSessionSummaryPush(opts: SessionSummaryPushOptions): SessionSummaryPush {
  const empty = JSON.stringify({ summaries: {} });
  let lastSent = empty;
  let stopped = false;

  const push = (force = false): void => {
    if (stopped) return;
    const payload: SessionSummaryPayload = { summaries: opts.records.summaries() };
    const serialized = JSON.stringify(payload);
    // Nothing to say and nothing said before: stay quiet. A drop from "some" to "none" still sends once.
    if (serialized === empty && lastSent === empty) return;
    if (serialized === lastSent && !force) return;
    lastSent = serialized;
    opts.deliver(payload);
  };

  const timer = setInterval(() => { if (opts.hasAudience()) push(); }, opts.intervalMs ?? 10_000);
  let pending: ReturnType<typeof setTimeout> | null = null;
  const notify = (): void => {
    if (stopped || pending) return;
    pending = setTimeout(() => {
      pending = null;
      if (!stopped && (opts.hasPhone ? opts.hasPhone() : opts.hasAudience())) push();
    }, opts.debounceMs ?? 50);
    pending.unref?.();
  };
  // A phone that connects later than the last change would otherwise wait for the next change, which may be never.
  const off = opts.onPhoneConnected?.(() => push(true));

  return {
    push: () => push(),
    notify,
    stop() { stopped = true; clearInterval(timer); if (pending) clearTimeout(pending); off?.(); },
  };
}
