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

/**
 * Run `seconds` of a screen at `hz` with `perSec` words arriving evenly. `jitter` shifts every frame timestamp by up to
 * +-jitter ms (a fixed pseudo-random sequence). `switchAt` (seconds) changes the refresh rate to `hz2` from then on.
 * Returns the frame time of every flush (ms) and the number of words pushed.
 */
function runScreen(batcher: TranscriptBatcher, flushAt: number[], hz: number, perSec: number, seconds: number, opts: { jitter?: number; stopWordsAt?: number; switchAt?: number; hz2?: number } = {}) {
  let pushed = 0, seed = 12345, t = 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 * 2 - 1; };
  const stop = opts.stopWordsAt ?? Infinity;
  for (let f = 1; t <= seconds * 1000 + 100; f++) {
    t += 1000 / (opts.switchAt !== undefined && t >= opts.switchAt * 1000 ? opts.hz2! : hz);
    const stamp = t + (opts.jitter ? rnd() * opts.jitter : 0);
    while (pushed < perSec * seconds && (pushed + 1) * (1000 / perSec) <= Math.min(t, stop)) batcher.push(word(++pushed));
    const cbs = [...queue.values()]; queue.clear();
    const before = got.length;
    for (const cb of cbs) cb(stamp);
    if (got.length > before) flushAt.push(stamp);
  }
  return pushed;
}

let got: ChatAction[] = [];
function install() {
  got = [];
  const batcher = installTranscriptBatcher((batch) => { got.push(...batch); });
  return { batcher, flushAt: [] as number[] };
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
const gaps = (a: number[]) => a.slice(1).map((v, i) => v - a[i]);

describe('streamed text redraws about STREAM_REDRAW_TARGET_HZ (60) times a second on any display, never coarser than a 60 Hz frame', () => {
  // [refresh rate, the step between redraws the rule must produce, ms]
  const table: [number, number][] = [[50, 20], [59.94, 16.68], [60, 16.67], [72, 13.89], [75, 13.33], [90, 11.11], [100, 10], [120, 16.67], [144, 13.89], [165, 12.12], [180, 16.67], [240, 16.67], [360, 16.67]];
  for (const jitter of [0, 1.5]) {
    for (const [hz, step] of table) {
      it(`${hz} Hz${jitter ? ' with +-1.5 ms timestamp jitter' : ''}: redraws every ~${step} ms`, () => {
        const { batcher, flushAt } = install();
        const pushed = runScreen(batcher, flushAt, hz, 150, 3, { jitter });
        const g = gaps(flushAt.slice(15)); // after the display's rate has been learned
        expect(Math.abs(median(g) - step)).toBeLessThan(jitter ? 3.2 : 1.2);
        // Never coarser than one 60 Hz frame (or one frame of a slower screen) plus the jitter.
        expect(Math.max(...g)).toBeLessThanOrEqual(Math.max(16.67, 1000 / hz) + jitter * 2 + (jitter ? 1000 / hz : 0) + 0.5);
        // Nothing lost, nothing reordered.
        expect(got.map((a: any) => a.timestamp)).toEqual(Array.from({ length: pushed }, (_, i) => i + 1));
        batcher.dispose();
      });
    }
  }

  it('a screen that changes rate mid-stream (60 -> 180 -> 60) settles on each rate', () => {
    const { batcher, flushAt } = install();
    runScreen(batcher, flushAt, 60, 150, 6, { switchAt: 2, hz2: 180 });
    const at = (from: number, to: number) => gaps(flushAt.filter((t) => t >= from * 1000 && t < to * 1000));
    expect(median(at(0.5, 2))).toBeCloseTo(16.67, 0);
    expect(median(at(2.5, 6.1))).toBeCloseTo(16.67, 0); // 180 Hz: every 3rd frame
    batcher.dispose();
    const second = install();
    runScreen(second.batcher, second.flushAt, 180, 150, 6, { switchAt: 2, hz2: 60 });
    expect(median(gaps(second.flushAt.filter((t) => t >= 2500)))).toBeCloseTo(16.67, 0);
    expect(Math.max(...gaps(second.flushAt.filter((t) => t >= 2500)))).toBeLessThan(20);
    second.batcher.dispose();
  });

  it('with words arriving slowly (30/s) every frame that has a word flushes: nothing is held back', () => {
    const { batcher, flushAt } = install();
    const pushed = runScreen(batcher, flushAt, 180, 30, 3);
    expect(got.length).toBe(pushed);
    expect(flushAt.length).toBeGreaterThanOrEqual(pushed * 0.9);
    batcher.dispose();
  });

  it('the last words of a reply appear within one 60 Hz frame of the stream stopping', () => {
    const { batcher } = install();
    const seconds = 1;
    const pushed = runScreen(batcher, [], 180, 150, seconds, { stopWordsAt: 500 }); // words stop arriving at t=500 ms
    expect(pushed).toBe(75);
    expect(got.length).toBe(75); // every word that arrived was drawn by the end of the run
    batcher.dispose();
  });

  it('the first word after a quiet spell is drawn on the very next frame, even on a fast screen', () => {
    const { batcher, flushAt } = install();
    runScreen(batcher, flushAt, 180, 150, 1, { stopWordsAt: 600 }); // the screen's rate is learned; then it goes quiet
    const before = got.length;
    batcher.push(word(10_000));
    const cb = [...queue.values()][0]; queue.clear(); cb(5000.0); // the first frame after the pause
    expect(got.length).toBe(before + 1);
    batcher.dispose();
  });

  it('flush() still applies everything at once, whatever the gap', () => {
    const { batcher } = install();
    batcher.push(word(1));
    const cb = [...queue.values()][0]; queue.clear(); cb(1000);
    batcher.push(word(2)); batcher.push(word(3)); // pushed right after a flush
    batcher.flush();
    expect(got.length).toBe(3);
    batcher.dispose();
  });

  it('a frame fired by hand with no timestamp is never throttled', () => {
    const { batcher } = install();
    for (let i = 1; i <= 3; i++) { batcher.push(word(i)); const cb = [...queue.values()][0]; queue.clear(); (cb as any)(); }
    expect(got.length).toBe(3);
    batcher.dispose();
  });
});
