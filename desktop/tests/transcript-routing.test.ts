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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { ChatAction, ChatState } from '../src/renderer/state/chat-types';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import { installTranscriptBatcher, routeTranscriptEvent, type TranscriptBatcher } from '../src/renderer/state/transcript-batch';
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
    expect(applied.map((a) => a.type)).toEqual(expected.map((a) => a.type));
  });

  it('nothing is applied before the frame fires (every action waits in the batch)', () => {
    route(ev('context-clear', 'c1', { contextUsedAfter: 0 }));
    route(ev('compact-summary', 'k1', { autoCompaction: true }));
    expect(applied).toEqual([]);
    runFrame();
    expect(applied.length).toBeGreaterThan(0);
  });
});

describe('App hands its transcript events to routeTranscriptEvent', () => {
  // App cannot be mounted in a test, so its wiring is pinned by reading its text:
  // the listener must call the helper, pass the batcher, and not dispatch itself.
  const app = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8').replace(/\r/g, '');
  const start = app.indexOf('.transcriptEvent?.(');
  const listener = app.slice(start, app.indexOf('transcriptShrink', start));

  it('finds the listener', () => { expect(start).toBeGreaterThan(0); expect(listener.length).toBeGreaterThan(50); });
  it('calls routeTranscriptEvent with the frame batcher', () => {
    expect(listener).toMatch(/routeTranscriptEvent\(\s*event\s*,/);
    expect(listener).toMatch(/batcher:\s*transcriptBatcher\b/);
  });
  it('reads the two compaction facts from this window', () => {
    expect(listener).toMatch(/compactionPending[^\n]*chatStateMapRef/);
    expect(listener).toMatch(/fallbackContextTokens[^\n]*statusData\.sessionStatsMap/);
  });
  it('does not dispatch to the store itself', () => {
    expect(listener).not.toMatch(/\bdispatch(Many)?\(/);
    expect(app).not.toMatch(/DIRECT_DISPATCH_TYPES/);
  });
});
