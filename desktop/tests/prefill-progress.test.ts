// Live prefill progress from llama.cpp (Destin, 2026-07-26).
//
// The payloads below are REAL — captured from llama.cpp b9992 on
// /v1/chat/completions with `return_progress: true`, a 5,519-token prompt on a
// 2B model. Six updates, roughly one per 2,048-token batch. Using the genuine
// shape (rather than one invented to match the parser) is the point: this is the
// contract with an external server, and a fixture that only agrees with our own
// assumptions would prove nothing.
import { describe, it, expect } from 'vitest';
import {
  parseProgressChunk,
  parseTimingsChunk,
  scanPrefillProgress,
  withPrefillProgress,
  toReport,
} from '../src/main/providers/prefill-progress';

/** Verbatim chunk from the capture (truncated to the fields that matter). */
const REAL_CHUNK = {
  choices: [{ finish_reason: null, index: 0, delta: { role: 'assistant', content: null } }],
  created: 1785106386,
  model: '/home/destin/.cache/llama.cpp/Qwen3.5-2B-Q8_0.gguf',
  system_fingerprint: 'b9992-6eddde06a',
  object: 'chat.completion.chunk',
  prompt_progress: { total: 5519, cache: 0, processed: 2048, time_ms: 5838 },
};

const REAL_SEQUENCE = [
  { total: 5519, cache: 0, processed: 0, time_ms: 0 },
  { total: 5519, cache: 0, processed: 2048, time_ms: 5838 },
  { total: 5519, cache: 0, processed: 4096, time_ms: 11373 },
  { total: 5519, cache: 0, processed: 5003, time_ms: 14691 },
  { total: 5519, cache: 0, processed: 5515, time_ms: 16270 },
  { total: 5519, cache: 0, processed: 5519, time_ms: 16440 },
];

function sseBody(chunks: object[], trailing = true): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
      if (trailing) c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}

describe('parseProgressChunk', () => {
  it('reads progress off a real llama.cpp chunk', () => {
    expect(parseProgressChunk(REAL_CHUNK)).toEqual({ total: 5519, cache: 0, processed: 2048, timeMs: 5838 });
  });

  it('ignores ordinary content chunks', () => {
    expect(parseProgressChunk({ choices: [{ delta: { content: 'hi' } }] })).toBeNull();
  });

  it('rejects a reading with no usable total rather than dividing by zero later', () => {
    expect(parseProgressChunk({ prompt_progress: { total: 0, processed: 0 } })).toBeNull();
    expect(parseProgressChunk({ prompt_progress: { processed: 5 } })).toBeNull();
  });

  it('survives junk without throwing — this runs on a copy of a live response', () => {
    for (const junk of [null, undefined, 'nope', 42, {}, { prompt_progress: 'no' }]) {
      expect(parseProgressChunk(junk)).toBeNull();
    }
  });
});

describe('scanPrefillProgress', () => {
  it('reports every reading in the captured sequence, in order', async () => {
    const seen: number[] = [];
    await scanPrefillProgress(sseBody(REAL_SEQUENCE.map((p) => ({ prompt_progress: p }))), (p) => seen.push(p.processed));
    expect(seen).toEqual([0, 2048, 4096, 5003, 5515, 5519]);
  });

  it('handles a reading split across chunk boundaries', async () => {
    // TCP does not respect JSON. A naive per-read parse loses this one.
    const enc = new TextEncoder();
    const full = `data: ${JSON.stringify({ prompt_progress: REAL_SEQUENCE[1] })}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(full.slice(0, 30)));
        c.enqueue(enc.encode(full.slice(30)));
        c.close();
      },
    });
    const seen: number[] = [];
    await scanPrefillProgress(body, (p) => seen.push(p.processed));
    expect(seen).toEqual([2048]);
  });

  it('reports nothing for a server that never sends progress — the degrade path', async () => {
    // LM Studio, a remote endpoint, anything that ignores return_progress.
    const seen: unknown[] = [];
    await scanPrefillProgress(sseBody([{ choices: [{ delta: { content: 'hello' } }] }]), (p) => seen.push(p));
    expect(seen).toEqual([]);
  });

  it('never throws on a body that is not SSE at all', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('<html>nope</html>')); c.close(); } });
    await expect(scanPrefillProgress(body, () => {})).resolves.toBeUndefined();
  });
});

describe('withPrefillProgress — the tee must not disturb the SDK', () => {
  it('delivers the response body to the caller byte-for-byte', async () => {
    const chunks = REAL_SEQUENCE.map((p) => ({ prompt_progress: p }));
    const expected = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    const base = async () => new Response(sseBody(chunks), { status: 200 });

    const wrapped = withPrefillProgress(base as any, () => {});
    const res = await wrapped('http://x/v1/chat/completions' as any);

    // The SDK's branch must see EXACTLY what the server sent.
    expect(await res.text()).toBe(expected);
  });

  it('reports progress while the caller consumes its own branch', async () => {
    const chunks = REAL_SEQUENCE.map((p) => ({ prompt_progress: p }));
    const base = async () => new Response(sseBody(chunks), { status: 200 });
    const seen: number[] = [];

    const wrapped = withPrefillProgress(base as any, (p) => seen.push(p.processed));
    const res = await wrapped('http://x' as any);
    await res.text();                       // drain the SDK branch
    await new Promise((r) => setTimeout(r, 20));   // let the scan branch finish

    expect(seen).toEqual([0, 2048, 4096, 5003, 5515, 5519]);
  });

  it('passes error responses straight through untouched', async () => {
    // A 500 has no stream to watch and must not be wrapped or delayed.
    const base = async () => new Response('boom', { status: 500 });
    const wrapped = withPrefillProgress(base as any, () => { throw new Error('must not run'); });
    const res = await wrapped('http://x' as any);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('boom');
  });
});

describe('toReport — the projection', () => {
  it('projects remaining time from the measured rate', () => {
    const r = toReport({ total: 5519, cache: 0, processed: 2048, timeMs: 5838 });
    expect(r.fraction).toBeCloseTo(0.371, 2);
    // Real finish was 16,440ms, so ~10,602ms actually remained. Optimistic by ~7%,
    // which is why the UI rounds this into coarse buckets rather than showing it raw.
    expect(r.etaMs).toBeGreaterThan(8_000);
    expect(r.etaMs).toBeLessThan(11_000);
  });

  it('has no ETA before anything has been processed', () => {
    expect(toReport({ total: 5519, cache: 0, processed: 0, timeMs: 0 }).etaMs).toBeNull();
  });

  it('clamps the fraction at 1 and never projects negative time', () => {
    const r = toReport({ total: 100, cache: 0, processed: 120, timeMs: 500 });
    expect(r.fraction).toBe(1);
    expect(r.etaMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Request-body contract. The hook must appear ONLY when something needs it —
// provider-registry.test.ts pins that an unconstrained local model keeps the
// SDK's default body byte-for-byte, and adding progress must not break that.
// ---------------------------------------------------------------------------
describe('return_progress request flag', () => {
  /** Mirrors the spread logic in provider-registry.ts's local-engine branch. */
  const buildHook = (opts: { serialToolCalls?: boolean; onPrefillProgress?: unknown }) =>
    (opts.serialToolCalls || opts.onPrefillProgress
      ? (b: Record<string, any>) => ({
        ...b,
        ...(opts.serialToolCalls ? { parallel_tool_calls: false } : {}),
        ...(opts.onPrefillProgress ? { return_progress: true } : {}),
      })
      : undefined);

  it('attaches NO hook when neither feature is requested', () => {
    expect(buildHook({})).toBeUndefined();
  });

  it('asks for progress only when a listener exists', () => {
    const hook = buildHook({ onPrefillProgress: () => {} })!;
    expect(hook({ model: 'm' })).toEqual({ model: 'm', return_progress: true });
  });

  it('carries BOTH flags through one hook — a second spread would clobber the first', () => {
    const hook = buildHook({ serialToolCalls: true, onPrefillProgress: () => {} })!;
    expect(hook({ model: 'm' })).toEqual({ model: 'm', parallel_tool_calls: false, return_progress: true });
  });

  it('leaves serial-only behaviour unchanged when no listener exists', () => {
    const hook = buildHook({ serialToolCalls: true })!;
    expect(hook({ model: 'm' })).toEqual({ model: 'm', parallel_tool_calls: false });
  });
});

// ---------------------------------------------------------------------------
// Progress is PROOF OF LIFE. Before this, a slow-but-healthy prefill outran the
// stall watchdog, got killed and retried from scratch — which is what made the
// percentage appear to reset itself mid-read (Destin, 2026-07-26).
// ---------------------------------------------------------------------------
import { HarnessSession } from '../src/main/harness/harness-session';
import { ASSISTANT_PRESET } from '../src/shared/harness-manifest';
import { MockLanguageModelV4 } from 'ai/test';
import type { TranscriptEvent } from '../src/shared/types';
import { resolveProfile } from '../src/main/harness/capability-profile';

describe('prefill progress re-arms the stall watchdog', () => {
  it('a stream that reports progress does NOT trip a short stall budget', async () => {
    // First token arrives well past prefillWarningMs, but progress lands
    // steadily throughout. Without the re-arm this turn dies and retries.
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          async start(c) {
            // First token far past the stall budget — only steady progress saves it.
            await new Promise((r) => setTimeout(r, 1_800));
            c.enqueue({ type: 'stream-start', warnings: [] });
            c.enqueue({ type: 'text-start', id: 'p1' });
            c.enqueue({ type: 'text-delta', id: 'p1', delta: 'ok' });
            c.enqueue({ type: 'text-end', id: 'p1' });
            c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } });
            c.close();
          },
        }) as any,
      }),
    });

    const session = new HarnessSession(
      { skillCatalog: EMPTY_SKILL_CATALOG,
        sessionId: 's-1', cwd: '/tmp/x', harness: ASSISTANT_PRESET,
        binding: { providerId: 'local', modelId: 'Qwen3.5-122B' },
        // Deliberately shorter than the total first-token wait above (1,800ms),
        // so the watchdog WOULD fire without progress — that is what the test
        // asserts. But the ratio that decides whether this test is stable is the
        // OTHER one: budget vs. the progress cadence below. It was 120ms against
        // a 60ms tick — a 2x margin, so one scheduler hiccup past 120ms tripped
        // the watchdog and the test failed as though progress did not re-arm it
        // (six concurrent full suites, 2026-08-28). 600ms against a 40ms tick is
        // a 15x margin, while 1,800ms vs 600ms keeps "would have expired without
        // progress" true three times over.
        prefillWarningMs: 600, stallCountdownMs: 600, retryDelays: [],
      } as any,
      async (_b, opts: any) => {
        // Drive progress on the same cadence the stream is waiting.
        let processed = 0;
        const timer = setInterval(() => {
          processed += 200;
          opts?.onPrefillProgress?.({ total: 6000, cache: 0, processed, timeMs: processed });
        }, 40);
        setTimeout(() => clearInterval(timer), 2_000);
        return model as any;
      },
    );
    const events: TranscriptEvent[] = [];
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));

    await session.send('hi');

    expect(events.some((e) => e.type === 'session-error')).toBe(false);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
  });

  // The re-arm above must keep working with NO profile (the CLOUD default),
  // because proof-of-life is not a UI concern — see harness-session.ts's
  // emitPrefillProgress, where the announcePrefill gate sits deliberately BELOW
  // the re-arm. This case pins the other half: a LOCAL session still puts the
  // reading on screen. Nothing else covers the live-progress emit end to end, so
  // without it the local-only gate could silently kill the feature it protects.
  it('a LOCAL session forwards the live reading to the UI', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          async start(c) {
            await new Promise((r) => setTimeout(r, 300));
            c.enqueue({ type: 'stream-start', warnings: [] });
            c.enqueue({ type: 'text-start', id: 'p1' });
            c.enqueue({ type: 'text-delta', id: 'p1', delta: 'ok' });
            c.enqueue({ type: 'text-end', id: 'p1' });
            c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } });
            c.close();
          },
        }) as any,
      }),
    });

    const session = new HarnessSession(
      { skillCatalog: EMPTY_SKILL_CATALOG,
        sessionId: 's-1', cwd: '/tmp/x', harness: ASSISTANT_PRESET,
        binding: { providerId: 'local', modelId: 'Qwen3.5-122B' },
        profile: resolveProfile({ providerType: 'local-engine', modelId: 'Qwen3.5-122B', contextLength: 131_072 }),
        prefillWarningMs: 5_000, stallCountdownMs: 5_000, retryDelays: [],
      } as any,
      async (_b, opts: any) => {
        // One FINAL reading: the throttle always lets that one through, so the
        // test doesn't race the 400ms window.
        opts?.onPrefillProgress?.({ total: 6000, cache: 0, processed: 6000, timeMs: 3000 });
        return model as any;
      },
    );
    const events: TranscriptEvent[] = [];
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));

    await session.send('hi');

    const reading = events.find((e) => (e.data as any)?.promptProcessing?.processed != null);
    expect(reading).toBeTruthy();
    expect((reading!.data as any).promptProcessing.processed).toBe(6000);
  });
});

// ---------------------------------------------------------------------------
// Progress is about THIS STEP'S work, not the whole prompt.
//
// Destin, 2026-07-28: "it seems to use the cumulative total for the entire
// session, where it should only show the percent processed of the total count
// being additionally processed in that turn."
//
// llama.cpp's `total` is the WHOLE prompt and `cache` is the prefix it reused
// for free. On turn 2+ the cache is most of the prompt, so a percentage against
// `total` reads as "almost done" before any real work has happened — and the
// denominator also jumps the moment the first live report replaces our own
// new-tokens estimate, which is what made the number fall.
// ---------------------------------------------------------------------------
describe('toReport — measures the work actually being done', () => {
  it('a cold prompt is unchanged: no cache, so new work IS the whole prompt', () => {
    const r = toReport({ total: 5519, cache: 0, processed: 2048, timeMs: 5838 });
    expect(r.newTotal).toBe(5519);
    expect(r.newProcessed).toBe(2048);
    expect(r.fraction).toBeCloseTo(2048 / 5519, 5);
  });

  it('a warm prompt measures against the UNCACHED remainder', () => {
    // 9,000 of a 10,000-token prompt reused → only 1,000 tokens of real work.
    const r = toReport({ total: 10_000, cache: 9_000, processed: 9_500, timeMs: 1_000 });
    expect(r.newTotal).toBe(1_000);
    expect(r.newProcessed).toBe(500);
    expect(r.fraction).toBeCloseTo(0.5, 5);
  });

  it('handles `processed` counting from ZERO rather than from the cache', () => {
    // We have never captured a WARM reading, so which origin llama.cpp counts
    // from is unverified. Under this reading, processed(500) < cache(9000) means
    // it is already relative to the new work.
    const r = toReport({ total: 10_000, cache: 9_000, processed: 500, timeMs: 1_000 });
    expect(r.newTotal).toBe(1_000);
    expect(r.newProcessed).toBe(500);
  });

  it('never exceeds 100% of the new work', () => {
    const r = toReport({ total: 10_000, cache: 9_000, processed: 10_000, timeMs: 1_000 });
    expect(r.newProcessed).toBe(1_000);
    expect(r.fraction).toBe(1);
  });

  it('a fully cached prompt is complete, not a divide-by-zero', () => {
    const r = toReport({ total: 10_000, cache: 10_000, processed: 10_000, timeMs: 0 });
    expect(r.fraction).toBe(1);
    expect(Number.isFinite(r.newTotal)).toBe(true);
  });

  it('the ETA projects the remaining NEW work at the rate that work was done', () => {
    // Rating cached tokens as "processed" would inflate the rate and promise an
    // impossible finish: 9,000 free tokens in 1s is not 9,000 tokens/sec of work.
    const r = toReport({ total: 10_000, cache: 9_000, processed: 9_500, timeMs: 1_000 });
    // 500 new tokens in 1000ms = 0.5/ms; 500 remaining → ~1000ms.
    expect(r.etaMs).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// 100% means DONE. Found by the 2026-07-28 audit using this file's own captured
// llama.cpp trace: REAL_SEQUENCE contains a NON-final reading of 5,515/5,519 —
// 99.93%, which Math.round turns into 100%. The label therefore read "100% of
// 5,519 tokens" while prefill was still running, and the monotonic clamp in the
// indicator then pinned it there until the real final reading arrived.
// ---------------------------------------------------------------------------
import { prefillLabel } from '../src/renderer/components/ThinkingIndicator';
import { EMPTY_SKILL_CATALOG } from './helpers/harness-fakes';

describe('prefillLabel — 100% is reserved for actually finished', () => {
  it('the real captured 5515/5519 reading does NOT read as 100%', () => {
    const label = prefillLabel({ promptTokens: 5519, processed: 5515, source: 'prompt' });
    expect(label).toContain('99% of 5,519 tokens');
    expect(label).not.toContain('100%');
  });

  it('the genuinely final reading DOES read as 100%', () => {
    expect(prefillLabel({ promptTokens: 5519, processed: 5519, source: 'prompt' }))
      .toContain('100% of 5,519 tokens');
  });

  it('floors rather than rounds, so it never overstates progress', () => {
    // 1999/2000 = 99.95% — one token short is not "done".
    expect(prefillLabel({ promptTokens: 2000, processed: 1999, source: 'prompt' })).toContain('99%');
    // 1/2000 = 0.05% — half a percent of work is not 1% done either.
    expect(prefillLabel({ promptTokens: 2000, processed: 1, source: 'prompt' })).toContain('0%');
  });

  it('over-reporting still clamps to 100, not 103', () => {
    expect(prefillLabel({ promptTokens: 100, processed: 130, source: 'prompt' })).toContain('100% of 100 tokens');
  });
});

// ---------------------------------------------------------------------------
// T19 — the reply-speed reading behind the engine card's fact line.
//
// The two payloads below are REAL, captured 2026-09-05 from the PINNED b10665
// build (`llama-server --models-dir … -c 4096 -ngl 0`, Qwen3.5-2B-Q8_0, one
// streamed /v1/chat/completions). They are pasted verbatim, not reconstructed:
// the `timings` block is a contract with an external server, and a fixture
// invented to agree with the parser would prove nothing about b10665.
//
// Both request shapes were captured because the block MOVES between them:
//   - with `stream_options: {include_usage: true}` (what provider-registry
//     always sends) it rides a separate `"choices":[]` usage frame;
//   - without it, it rides the last content frame, the one with finish_reason.
// ---------------------------------------------------------------------------

/** Verbatim final frame, b10665, WITH include_usage (our production shape). */
const REAL_FINAL_FRAME_WITH_USAGE = {
  choices: [],
  created: 1788649092,
  id: 'chatcmpl-J3Ct4l2uk0HGAbkBS3dffqtfbBgngzdI',
  model: 'Qwen3.5-2B-Q8_0',
  system_fingerprint: 'b10665-ca3d5a3e1',
  object: 'chat.completion.chunk',
  usage: { completion_tokens: 24, prompt_tokens: 15, total_tokens: 39, prompt_tokens_details: { cached_tokens: 0 } },
  timings: {
    cache_n: 0,
    prompt_n: 15,
    prompt_ms: 178.45,
    prompt_per_token_ms: 11.896666666666667,
    prompt_per_second: 84.05715886803026,
    predicted_n: 24,
    predicted_ms: 608.126,
    predicted_per_token_ms: 26.440260869565215,
    predicted_per_second: 37.821109441135555,
  },
};

/** Verbatim final frame, b10665, WITHOUT include_usage (warm prefix cache). */
const REAL_FINAL_FRAME_NO_USAGE = {
  choices: [{ finish_reason: 'length', index: 0, delta: {} }],
  created: 1788649100,
  id: 'chatcmpl-FYnVqUd943P9V4R0wH0FCS069Mlff2DW',
  model: 'Qwen3.5-2B-Q8_0',
  system_fingerprint: 'b10665-ca3d5a3e1',
  object: 'chat.completion.chunk',
  timings: {
    cache_n: 11,
    prompt_n: 4,
    prompt_ms: 81.064,
    prompt_per_token_ms: 20.266,
    prompt_per_second: 49.34372841211882,
    predicted_n: 24,
    predicted_ms: 623.098,
    predicted_per_token_ms: 27.091217391304347,
    predicted_per_second: 36.91233160754809,
  },
};

/** A mid-stream content frame from the same capture — carries no timings. */
const REAL_CONTENT_FRAME = {
  choices: [{ finish_reason: null, index: 0, delta: { content: 'pong' } }],
  created: 1788649092,
  model: 'Qwen3.5-2B-Q8_0',
  object: 'chat.completion.chunk',
};

describe('parseTimingsChunk — reads b10665\'s real final frame', () => {
  it('reads the exact rates off the include_usage frame', () => {
    // EXACT values, not a range and not a substring: the two fields sit next to
    // three other per-second-ish numbers (prompt_per_token_ms, predicted_ms,
    // predicted_per_token_ms), and reading the wrong one is the mistake this
    // pins. 84.057… is prompt_per_second; 37.821… is predicted_per_second.
    expect(parseTimingsChunk(REAL_FINAL_FRAME_WITH_USAGE)).toEqual({
      promptPerSecond: 84.05715886803026,
      generatePerSecond: 37.821109441135555,
    });
  });

  it('reads the same block off the finish_reason frame when usage was not asked for', () => {
    expect(parseTimingsChunk(REAL_FINAL_FRAME_NO_USAGE)).toEqual({
      promptPerSecond: 49.34372841211882,
      generatePerSecond: 36.91233160754809,
    });
  });

  it('reports nothing for a frame with no timings block', () => {
    expect(parseTimingsChunk(REAL_CONTENT_FRAME)).toBeNull();
    expect(parseTimingsChunk({ prompt_progress: REAL_SEQUENCE[0] })).toBeNull();
  });

  it('KEEPS the rate it has when the other one is missing or degenerate', () => {
    // A prompt served entirely from the prefix cache has no reading work to
    // time, so the engine can report a zero prompt rate for a reply whose write
    // rate is perfectly good. Dropping the pair would blank the card's speed
    // line for a reply that really did run — keep the half we measured.
    const { prompt_per_second, ...noPrompt } = REAL_FINAL_FRAME_WITH_USAGE.timings;
    expect(parseTimingsChunk({ timings: noPrompt })).toEqual({ generatePerSecond: 37.821109441135555 });
    const { predicted_per_second, ...noPredicted } = REAL_FINAL_FRAME_WITH_USAGE.timings;
    expect(parseTimingsChunk({ timings: noPredicted })).toEqual({ promptPerSecond: 84.05715886803026 });
    // Zero is the value b10665's own arithmetic (prompt_n/prompt_ms*1000) yields
    // for a fully-cached prompt — the realistic case for this rule.
    expect(parseTimingsChunk({ timings: { ...REAL_FINAL_FRAME_WITH_USAGE.timings, prompt_per_second: 0 } }))
      .toEqual({ generatePerSecond: 37.821109441135555 });
  });

  it('never reports a zero or a divide-by-zero AS a speed', () => {
    // "0 read per second" is a false claim about the machine; Infinity (which
    // needs prompt_ms === 0) renders as the word "Infinity". Each bad value must
    // drop its OWN number and leave the other standing.
    for (const bad of [0, -1, Infinity, NaN, null, 'fast']) {
      expect(parseTimingsChunk({ timings: { ...REAL_FINAL_FRAME_WITH_USAGE.timings, prompt_per_second: bad } }))
        .toEqual({ generatePerSecond: 37.821109441135555 });
      expect(parseTimingsChunk({ timings: { ...REAL_FINAL_FRAME_WITH_USAGE.timings, predicted_per_second: bad } }))
        .toEqual({ promptPerSecond: 84.05715886803026 });
      // Both bad is no reading at all — there is nothing left to show.
      expect(parseTimingsChunk({ timings: { prompt_per_second: bad, predicted_per_second: bad } })).toBeNull();
    }
  });

  it('never throws on junk', () => {
    for (const junk of [null, undefined, 42, 'x', [], { timings: 'soon' }, { timings: null }]) {
      expect(parseTimingsChunk(junk)).toBeNull();
    }
  });
});

describe('scanPrefillProgress — the reply reading, once per completion', () => {
  it('reports the reading from a real captured stream exactly once', async () => {
    const seen: unknown[] = [];
    await scanPrefillProgress(
      sseBody([REAL_CONTENT_FRAME, REAL_CONTENT_FRAME, REAL_FINAL_FRAME_WITH_USAGE]),
      undefined,
      (t) => seen.push(t),
    );
    expect(seen).toEqual([{ promptPerSecond: 84.05715886803026, generatePerSecond: 37.821109441135555 }]);
  });

  it('reports null for a completion whose final frame carried no timings — clearing a stale number', async () => {
    const seen: unknown[] = [];
    await scanPrefillProgress(sseBody([REAL_CONTENT_FRAME, REAL_CONTENT_FRAME]), undefined, (t) => seen.push(t));
    expect(seen).toEqual([null]);
  });

  it('says NOTHING about a body that was never a completion stream', async () => {
    // A /models GET (or any non-completion response) goes through the same
    // fetch. Reporting null for it would blank a perfectly good reading.
    const seen: unknown[] = [];
    await scanPrefillProgress(sseBody([{ data: [{ id: 'a', status: { value: 'loaded' } }] }]), undefined, (t) => seen.push(t));
    expect(seen).toEqual([]);
  });

  it('says nothing when the stream ABORTS mid-reply', async () => {
    // The user pressed stop. An interrupted reply has no honest speed, and the
    // last one we did measure beats blanking the line.
    //
    // THE FIXTURE HAS TO LET THE FRAME THROUGH FIRST. The obvious version of
    // this test — enqueue then `c.error()` synchronously inside start() — is
    // VACUOUS: per the streams spec `error()` RESETS the queue, so the frame is
    // thrown away, the first read() rejects, and the scan never even learns
    // this was a completion stream. It then passes whether or not the code
    // under test reports on the abort path, which is the one thing it exists to
    // check. Yielding a real tick between the enqueue and the error is what
    // makes the assertion reach the branch it is about. ("The assertion is
    // right" and "the assertion runs" are different claims — this was the ninth
    // hollow guard found in this feature.)
    const enc = new TextEncoder();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        c.enqueue(enc.encode(`data: ${JSON.stringify(REAL_CONTENT_FRAME)}\n\n`));
      },
    });
    const seen: unknown[] = [];
    const scan = scanPrefillProgress(body, undefined, (t) => seen.push(t));
    await new Promise((r) => setTimeout(r, 5));   // the frame is consumed here
    ctrl.error(new Error('aborted'));
    await scan;
    expect(seen).toEqual([]);
  });

  it('takes the LAST reading when a stream somehow carries two', async () => {
    const seen: unknown[] = [];
    await scanPrefillProgress(
      sseBody([REAL_FINAL_FRAME_NO_USAGE, REAL_FINAL_FRAME_WITH_USAGE]),
      undefined,
      (t) => seen.push(t),
    );
    expect(seen).toEqual([{ promptPerSecond: 84.05715886803026, generatePerSecond: 37.821109441135555 }]);
  });
});

describe('withPrefillProgress — the reply tap rides the same tee', () => {
  it('delivers the reading while the caller drains its own branch', async () => {
    const frames = [REAL_CONTENT_FRAME, REAL_FINAL_FRAME_WITH_USAGE];
    const base = async () => new Response(sseBody(frames), { status: 200 });
    const seen: unknown[] = [];
    const wrapped = withPrefillProgress(base as any, undefined, (t) => seen.push(t));
    const res = await wrapped('http://x/v1/chat/completions' as any);
    expect(await res.text()).toBe(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n');
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([{ promptPerSecond: 84.05715886803026, generatePerSecond: 37.821109441135555 }]);
  });

  it('does not tee at all when nobody is listening', async () => {
    // Both taps absent → the wrapper must hand back the original fetch, not a
    // wrapper that copies every byte of every response for an audience of none.
    const base = (async () => new Response('x', { status: 200 })) as any;
    expect(withPrefillProgress(base)).toBe(base);
  });
});
