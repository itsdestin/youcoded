// @vitest-environment jsdom
//
// How many times a second a streaming reply redraws the chat must not depend on the display's refresh rate.
// Perf fix 5 (2026-10-04): the batcher flushed once per animation frame, so a 180 Hz screen redrew ~150x a second
// for ~150 words a second (the perf rig with its frame limit lifted: 146 redraws/s, main thread 86% busy, against
// 60/s and ~45% at 60 Hz). The batcher now waits at least MIN_FLUSH_GAP_MS between frame-driven flushes.
// These tests drive the REAL batcher with a hand-made display: frames at k/Hz seconds, words arriving at 150/s.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installTranscriptBatcher, type TranscriptBatcher } from '../src/renderer/state/transcript-batch';
import type { ChatAction } from '../src/renderer/state/chat-types';

const realRaf = window.requestAnimationFrame;
const realCaf = window.cancelAnimationFrame;
let queue = new Map<number, FrameRequestCallback>();
let nextId = 1;

beforeEach(() => {
  queue = new Map(); nextId = 1;
  window.requestAnimationFrame = (cb) => { const id = nextId++; queue.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { queue.delete(id); };
});
afterEach(() => { window.requestAnimationFrame = realRaf; window.cancelAnimationFrame = realCaf; });

const word = (n: number): ChatAction => ({ type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: 's1', uuid: `u${n}`, text: `w${n} `, timestamp: n, partId: 'p1' } as ChatAction);

/** Run `seconds` of a screen at `hz` with `perSec` words arriving evenly; returns when each flush happened and what it held. */
function runScreen(batcher: TranscriptBatcher, flushes: { at: number; n: number; first: number }[], hz: number, perSec: number, seconds: number, stopWordsAt = Infinity) {
  let pushed = 0;
  const frameMs = 1000 / hz;
  for (let f = 1; f * frameMs <= seconds * 1000 + 100; f++) {
    const t = f * frameMs;
    while (pushed < perSec * seconds && (pushed + 1) * (1000 / perSec) <= Math.min(t, stopWordsAt)) batcher.push(word(++pushed));
    const cbs = [...queue.values()]; queue.clear();
    for (const cb of cbs) cb(t);
  }
  return pushed;
}

function install() {
  const flushes: { at: number; n: number; first: number }[] = [];
  const got: ChatAction[] = [];
  const batcher = installTranscriptBatcher((batch) => { flushes.push({ at: got.length, n: batch.length, first: (batch[0] as any).timestamp }); got.push(...batch); });
  return { batcher, flushes, got };
}

describe('the transcript batcher redraws at most once per animation frame AND at most every 12 ms', () => {
  it('a 60 Hz screen still flushes on every frame (no visible change at 60 Hz)', () => {
    const { batcher, flushes } = install();
    runScreen(batcher, flushes, 60, 150, 2);
    // 150 words/s on 60 frames/s: every frame has a word waiting, so every frame flushes.
    expect(flushes.length).toBeGreaterThanOrEqual(118);
    batcher.dispose();
  });

  for (const hz of [120, 144, 180, 240]) {
    it(`a ${hz} Hz screen redraws no more than ~83 times a second, and no coarser than a 60 Hz frame`, () => {
      const { batcher, flushes, got } = install();
      const pushed = runScreen(batcher, flushes, hz, 150, 2);
      // Without the gap this was ~150/s (one per frame with a word waiting); the bound is 1000/12 per second.
      // (a literal 12 ms here, so loosening the constant cannot loosen the test)
      expect(flushes.length).toBeLessThanOrEqual(2 * Math.ceil(1000 / 12));
      // ... and not starved: updates are never further apart than one 60 Hz frame plus one frame of this screen.
      expect(flushes.length).toBeGreaterThanOrEqual(100);
      // Nothing lost, nothing reordered.
      expect(got.map((a: any) => a.timestamp)).toEqual(Array.from({ length: got.length }, (_, i) => i + 1));
      expect(got.length).toBe(pushed);
      batcher.dispose();
    });
  }

  it('the last words of a reply appear within one 60 Hz frame of the stream stopping', () => {
    const { batcher, got } = install();
    const seconds = 1;
    const pushed = runScreen(batcher, [], 180, 150, seconds, 500); // words stop arriving at t=500 ms
    expect(pushed).toBe(75);
    expect(got.length).toBe(75); // every word that arrived was drawn by the end of the run
    batcher.dispose();
  });

  it('the first word after a quiet spell is drawn on the very next frame', () => {
    const { batcher, got } = install();
    batcher.push(word(1));
    const cb = [...queue.values()][0]; queue.clear(); cb(1000);
    expect(got.length).toBe(1);
    batcher.push(word(2));
    const cb2 = [...queue.values()][0]; queue.clear(); cb2(1000 + 5.5); // next 180 Hz frame, too soon: waits
    expect(got.length).toBe(1);
    expect(queue.size).toBe(1); // re-armed
    const cb3 = [...queue.values()][0]; queue.clear(); cb3(1000 + 11.1); // still too soon
    expect(got.length).toBe(1);
    const cb4 = [...queue.values()][0]; queue.clear(); cb4(1000 + 16.7); // gap reached
    expect(got.length).toBe(2);
    batcher.dispose();
  });

  it('flush() still applies everything at once, whatever the gap', () => {
    const { batcher, got } = install();
    batcher.push(word(1));
    const cb = [...queue.values()][0]; queue.clear(); cb(1000);
    batcher.push(word(2)); batcher.push(word(3));
    batcher.flush();
    expect(got.length).toBe(3);
    batcher.dispose();
  });

  it('a frame fired by hand with no timestamp is never throttled', () => {
    const { batcher, got } = install();
    for (let i = 1; i <= 3; i++) { batcher.push(word(i)); const cb = [...queue.values()][0]; queue.clear(); (cb as any)(); }
    expect(got.length).toBe(3);
    batcher.dispose();
  });
});
