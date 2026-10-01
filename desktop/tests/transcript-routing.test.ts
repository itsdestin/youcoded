// @vitest-environment jsdom
//
// R4-3: every transcript action reaches the chat in the order it arrived.
//
// Before, four action types (skill card, /clear, history rewrite, compaction
// marker) skipped the main window's frame batch, so a message and a /clear that
// arrived in the same frame were applied clear-first. These tests drive the REAL
// batcher and the REAL reducer through `routeTranscriptEvent`, the function App's
// listener calls, and read the resulting timeline. A test that listed action types
// would pass while the order was wrong, so they look at what the user would see.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { ChatAction, ChatState } from '../src/renderer/state/chat-types';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import { installTranscriptBatcher, routeTranscriptEvent, routeTranscriptShrink, type TranscriptBatcher } from '../src/renderer/state/transcript-batch';
import type { TranscriptEvent } from '../src/shared/types';

const SID = 's1';
const ev = (type: string, uuid: string, data: Record<string, unknown> = {}, timestamp = 1000): TranscriptEvent =>
  ({ type, sessionId: SID, uuid, timestamp, data }) as unknown as TranscriptEvent;

let frames: FrameRequestCallback[] = [];
const realRaf = window.requestAnimationFrame;
const realCaf = window.cancelAnimationFrame;
let batcher: TranscriptBatcher;
let state: ChatState;
let applied: ChatAction[];

// Everything that reaches the store, in the order it gets there, reduced exactly
// as the real store would.
function apply(a: ChatAction) { applied.push(a); state = chatReducer(state, a); }

beforeEach(() => {
  frames = [];
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => { frames.push(cb); return frames.length; }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame;
  applied = [];
  state = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: SID });
  batcher = installTranscriptBatcher((batch) => { for (const a of batch) apply(a); });
});
afterEach(() => {
  batcher.dispose();
  window.requestAnimationFrame = realRaf;
  window.cancelAnimationFrame = realCaf;
});

const runFrame = () => { const due = frames.splice(0); for (const cb of due) cb(performance.now()); };
const route = (event: TranscriptEvent) => {
  const deps = {
    batcher,
    compactionPending: () => false,
    fallbackContextTokens: () => null,
  };
  routeTranscriptEvent(event, deps);
};
// What the timeline shows, top to bottom: user text or a marker's label.
const shown = () => state.get(SID)!.timeline.map((t) =>
  t.kind === 'user' ? `user:${t.message.content}` : t.kind === 'system-marker' ? `marker:${t.marker.id}` : t.kind);

describe('transcript actions keep arrival order', () => {
  it('a message followed by /clear in one frame draws the message ABOVE the clear line', () => {
    route(ev('user-message', 'u1', { text: 'hello' }));
    route(ev('context-clear', 'c1', { contextUsedAfter: 0 }));
    runFrame();
    expect(shown()).toEqual(['user:hello', 'marker:clear-c1']);
  });

  it('a message followed by a compaction in one frame draws the message ABOVE the marker', () => {
    route(ev('user-message', 'u1', { text: 'hello' }));
    route(ev('compact-summary', 'k1', { autoCompaction: true, contextUsedAfter: 10, contextUsedBefore: 90, summary: 's' }));
    runFrame();
    expect(shown()).toEqual(['user:hello', 'marker:compact-done-k1']);
  });

  it('a message followed by /clear then another message keeps all three in order', () => {
    route(ev('user-message', 'u1', { text: 'before' }));
    route(ev('context-clear', 'c1'));
    route(ev('user-message', 'u2', { text: 'after' }));
    runFrame();
    expect(shown()).toEqual(['user:before', 'marker:clear-c1', 'user:after']);
  });

  it('the actions reach the store in exactly the order eventToAction produced them, for a mixed frame', () => {
    const events = [
      ev('user-message', 'u1', { text: 'a' }),
      ev('skill-invoked', 'k1', { skillId: 'x' }),
      ev('assistant-text', 'a1', { text: 'reply' }),
      ev('context-clear', 'c1', { contextUsedAfter: 0 }),
      ev('compact-summary', 'k2', { autoCompaction: true, contextUsedAfter: 5 }),
      ev('user-message', 'u2', { text: 'b' }),
    ];
    for (const e of events) route(e);
    runFrame();
    const expected = events.flatMap((e) => eventToAction(e, { live: true, compactionPending: false, fallbackContextTokens: null }));
    expect(applied.map((a) => [a.type, (a as any).uuid])).toEqual(expected.map((a) => [a.type, (a as any).uuid]));
  });

  it('nothing is applied before the frame fires (every action waits in the batch)', () => {
    route(ev('context-clear', 'c1', { contextUsedAfter: 0 }));
    route(ev('compact-summary', 'k1', { autoCompaction: true }));
    expect(applied).toEqual([]);
    runFrame();
    expect(applied.length).toBeGreaterThan(0);
  });
});

describe('a file shrink and a compaction event in the same frame', () => {
  const pending = () => apply({ type: 'COMPACTION_PENDING', sessionId: SID, cardId: 'card', beforeContextTokens: 90000 });
  const deps = () => ({ batcher, compactionPending: () => !!state.get(SID)!.compactionPending, fallbackContextTokens: () => 5000 });
  const marker = () => state.get(SID)!.timeline.find((t) => t.kind === 'system-marker' && t.marker.id.startsWith('compact-done')) as any;

  it('keeps the compaction event\'s summary and freed-token figure (the shrink must not overtake it)', () => {
    pending();
    // The event is queued; the shrink arrives before the frame fires.
    routeTranscriptEvent(ev('compact-summary', 'k1', { summary: 'The real summary', contextUsedBefore: 90000, contextUsedAfter: 12000 }), deps());
    routeTranscriptShrink({ sessionId: SID }, deps());
    runFrame();
    expect(marker().marker.id).toBe('compact-done-k1');
    expect(marker().marker.summary).toBe('The real summary');
    expect(marker().marker.label).toBe('Compacted · freed 78,000 tokens');
  });

  it('still completes a compaction on its own when only the shrink arrives', () => {
    pending();
    routeTranscriptShrink({ sessionId: SID }, deps());
    runFrame();
    expect(marker()).toBeTruthy();
  });

  it('ignores a shrink when this window is not waiting on /compact', () => {
    routeTranscriptShrink({ sessionId: SID }, deps());
    runFrame();
    expect(applied).toEqual([]);
  });
});

// Whether App's two listeners route through these helpers (and never dispatch themselves)
// is pinned by the ast-grep rule scripts/ast-grep/rules/app-transcript-listeners-batched.yml.
