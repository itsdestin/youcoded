// @vitest-environment jsdom
//
// Perf-lab counters on the transcript batcher: off by default (no window hook, no cost), and when the
// build flag is on they must conserve every action: pushed = enqueued + droppedAfterDispose, and
// enqueued = applied + dropped + still-queued. Guards the lab's "sent = received = enqueued = applied + dropped" check.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installTranscriptBatcher } from '../src/renderer/state/transcript-batch';
import { BatcherCounters, _resetSharedBatcherCountersForTest } from '../src/renderer/state/transcript-batch-counters';
import type { ChatAction } from '../src/renderer/state/chat-types';

const act = (n: number): ChatAction => ({ type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: 's1', uuid: `u${n}`, text: `w${n} `, timestamp: n, partId: 'p1' } as ChatAction);

beforeEach(() => { _resetSharedBatcherCountersForTest(); });
afterEach(() => { vi.unstubAllEnvs(); _resetSharedBatcherCountersForTest(); });

describe('flag off (every normal build)', () => {
  it('installs no window hook and the batcher still works', () => {
    const got: ChatAction[] = [];
    const b = installTranscriptBatcher((batch) => { got.push(...batch); });
    b.push(act(1)); b.flush();
    expect(got).toHaveLength(1);
    expect(window.__transcriptBatcherCounters).toBeUndefined();
    b.dispose();
  });
});

describe('flag on', () => {
  beforeEach(() => { vi.stubEnv('VITE_PERF_COUNTERS', '1'); });

  it('counts enqueue, depth, apply and flushes', () => {
    const b = installTranscriptBatcher(() => {});
    for (let i = 0; i < 5; i++) b.push(act(i));
    let s = window.__transcriptBatcherCounters!.snapshot();
    expect(s).toMatchObject({ pushed: 5, enqueued: 5, applied: 0, pendingDepth: 5, maxPendingDepth: 5, flushes: 0, unaccounted: 0 });
    b.flush();
    s = window.__transcriptBatcherCounters!.snapshot();
    expect(s).toMatchObject({ enqueued: 5, applied: 5, pendingDepth: 0, maxPendingDepth: 5, flushes: 1, unaccounted: 0, oldestPendingAgeMs: 0 });
    expect(s.byType.TRANSCRIPT_ASSISTANT_TEXT).toEqual({ enqueued: 5, applied: 5, dropped: 0 });
    b.dispose();
  });

  it('counts what dispose throws away and pushes that arrive after it', () => {
    const b = installTranscriptBatcher(() => {});
    b.push(act(1)); b.push(act(2));
    b.dispose(); b.dispose(); // second dispose must not double count
    b.push(act(3));
    const s = window.__transcriptBatcherCounters!.snapshot();
    expect(s).toMatchObject({ pushed: 3, enqueued: 2, applied: 0, droppedOnDispose: 2, droppedAfterDispose: 1, pendingDepth: 0, unaccounted: 0 });
    expect(s.byType.TRANSCRIPT_ASSISTANT_TEXT).toEqual({ enqueued: 2, applied: 0, dropped: 3 });
  });

  it('counts a batch lost to a throwing dispatch and rethrows', () => {
    const b = installTranscriptBatcher(() => { throw new Error('boom'); });
    b.push(act(1)); b.push(act(2));
    expect(() => b.flush()).toThrow('boom');
    expect(window.__transcriptBatcherCounters!.snapshot()).toMatchObject({ enqueued: 2, applied: 0, droppedOnDispatchError: 2, unaccounted: 0 });
    b.dispose();
  });

  it('survives a StrictMode install/dispose/install and reset keeps the identity balanced', () => {
    const a = installTranscriptBatcher(() => {}); a.dispose();
    const b = installTranscriptBatcher(() => {});
    b.push(act(1));
    window.__transcriptBatcherCounters!.reset();
    b.push(act(2)); b.flush();
    const s = window.__transcriptBatcherCounters!.snapshot();
    expect(s).toMatchObject({ enqueued: 2, applied: 2, unaccounted: 0, installs: 0 });
    b.dispose();
  });
});

describe('BatcherCounters age tracking (fake clock)', () => {
  it('reports the oldest queued age now and the worst age ever seen', () => {
    let t = 100;
    const c = new BatcherCounters(() => t);
    const a = { type: 'X' };
    c.onPush(a, true); t = 130; c.onPush(a, true);
    expect(c.snapshot()).toMatchObject({ pendingDepth: 2, oldestPendingAgeMs: 30, maxOldestPendingAgeMs: 30 });
    t = 160; c.onLeave([a, a], 'applied');
    expect(c.snapshot()).toMatchObject({ pendingDepth: 0, oldestPendingAgeMs: 0, maxOldestPendingAgeMs: 60 });
    t = 200; c.onPush(a, true); t = 210;
    expect(c.snapshot()).toMatchObject({ oldestPendingAgeMs: 10, maxOldestPendingAgeMs: 60 });
  });
});
