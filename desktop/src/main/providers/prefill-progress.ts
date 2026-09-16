// Live prefill progress from llama.cpp (spec: M3 follow-up, Destin 2026-07-26).
//
// With `return_progress: true`, llama-server streams progress objects DURING
// prompt processing, before any token is generated:
//
//   {"total": 5519, "cache": 0, "processed": 2048, "time_ms": 5838}
//
// Verified empirically against llama.cpp b9992 on /v1/chat/completions: six
// updates for a 5,519-token prompt, roughly one per 2,048-token batch. `cache`
// is broken out so tokens served from the KV cache — which cost nothing — don't
// pollute the estimate.
//
// WHY A TEE, AND NOT THE SDK:
// The chunks reach @ai-sdk/openai-compatible intact — they carry a real
// `delta: {role:'assistant', content:null}` so they pass its `choice?.delta ==
// null` guard, and its `looseObject` chunk schema preserves the extra key. But
// the transform only ever reads known fields, so `prompt_progress` is discarded
// one line later. There is no hook and no providerMetadata path for it.
//
// The provider DOES accept a custom `fetch`, so we wrap that instead: tee the
// response body, parse one branch for progress, hand the untouched original to
// the SDK. No fork, no patch — a supported seam. This is the same shape the
// existing `transformRequestBody` hook uses to inject parallel_tool_calls.

import type { ReplyTimings } from '../../shared/engine-types';

/** One progress reading, exactly as llama-server reports it. */
export interface PrefillProgress {
  /** Prompt tokens that must be processed in total. */
  total: number;
  /** Of those, how many were served from the KV cache (free). */
  cache: number;
  /** How many have been processed so far. */
  processed: number;
  /** Milliseconds elapsed processing them. */
  timeMs: number;
}

/** Progress plus a projected remaining time, when one can be computed. */
export interface PrefillProgressReport extends PrefillProgress {
  /** Tokens of real work in THIS step: total minus the cached prefix. */
  newTotal: number;
  /** How many of `newTotal` are done. */
  newProcessed: number;
  /** 0..1 across the NEW work — not the whole prompt. */
  fraction: number;
  /**
   * Projected milliseconds remaining, or null when there is nothing to project
   * from (no elapsed time, or nothing processed yet).
   *
   * DELIBERATELY COARSE and known to run OPTIMISTIC: prefill slows as context
   * grows (attention cost is not linear), so a rate measured over the first half
   * under-predicts the second. Measured error against llama.cpp b9992 was ~7% at
   * a third of the way through and ~22% at two thirds. Good enough for "about 10
   * seconds left", not good enough to render a precise number — round it before
   * showing it to anyone.
   */
  etaMs: number | null;
}

export function toReport(p: PrefillProgress): PrefillProgressReport {
  // Measure THIS STEP'S work, not the whole prompt. `total` is every token in the
  // request; `cache` is the prefix llama.cpp reused for free. On turn 2+ the cache
  // is most of the prompt, so a percentage against `total` reads as "almost done"
  // before any real work has started (Destin, 2026-07-28).
  const newTotal = Math.max(0, p.total - p.cache);

  // UNVERIFIED, and written to be correct either way: every progress capture we
  // have is cache:0 (a cold prompt), so we have never observed whether `processed`
  // counts from zero or from the cached position on a WARM prompt. If it counts
  // from the cache, subtracting it gives the new work; if it already counts only
  // new work, it is below `cache` and passes through. One warm capture would
  // settle this — see tests/prefill-progress.test.ts.
  //
  // Residual ambiguity: when the new work processed so far EXCEEDS the cache size
  // under the counts-from-zero reading, this under-reports by `cache`. Bounded,
  // always in the conservative direction (progress looks behind, never ahead),
  // and the renderer's monotonic clamp keeps it from reading as a regression.
  const rawNew = p.processed >= p.cache ? p.processed - p.cache : p.processed;
  const newProcessed = Math.max(0, Math.min(newTotal, rawNew));

  // A fully cached prompt has no work to do, so it is complete — not 0/0.
  const fraction = newTotal > 0 ? Math.min(1, newProcessed / newTotal) : 1;
  // Rate over the NEW work only. Counting cached tokens as processed would
  // inflate it wildly — 9,000 free tokens in a second is not 9,000 tok/s — and
  // promise a finish that cannot happen.
  const rate = p.timeMs > 0 && newProcessed > 0 ? newProcessed / p.timeMs : null;
  const remaining = Math.max(0, newTotal - newProcessed);
  return { ...p, newTotal, newProcessed, fraction, etaMs: rate ? Math.round(remaining / rate) : null };
}

/** Pull a progress reading out of one parsed SSE payload, if it carries one. */
export function parseProgressChunk(json: unknown): PrefillProgress | null {
  const pp = (json as any)?.prompt_progress;
  if (!pp || typeof pp !== 'object') return null;
  const total = Number(pp.total);
  const processed = Number(pp.processed);
  // A reading with no total tells us nothing and would divide by zero downstream.
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(processed)) return null;
  return {
    total,
    processed,
    cache: Number.isFinite(Number(pp.cache)) ? Number(pp.cache) : 0,
    timeMs: Number.isFinite(Number(pp.time_ms)) ? Number(pp.time_ms) : 0,
  };
}

/**
 * Pull the reply-speed reading out of one parsed SSE payload, if it carries one.
 *
 * llama-server puts a `timings` block on the LAST frame of a streamed
 * completion. Captured verbatim from the pinned b10665 build on 2026-09-05
 * (test-engine/probe-chat.mjs's call shape, 2B model, CPU):
 *
 *   {"choices":[],…,"object":"chat.completion.chunk",
 *    "usage":{"completion_tokens":24,"prompt_tokens":15,…},
 *    "timings":{"cache_n":0,"prompt_n":15,"prompt_ms":178.45,
 *               "prompt_per_second":84.05715886803026,
 *               "predicted_n":24,"predicted_ms":608.126,
 *               "predicted_per_second":37.821109441135555}}
 *
 * The block rides the `usage` frame when the request asks for usage (we always
 * do — provider-registry sets includeUsage) and the `finish_reason` frame when
 * it does not; both were captured, so this reads the block wherever it lands
 * rather than keying off either neighbour.
 *
 * Each rate must be a real POSITIVE number to be reported. A zero is what a
 * fully-cached prompt would give (`prompt_per_second` is prompt_n/prompt_ms*1000,
 * so no reading work means zero), and an Infinity is what a zero `prompt_ms`
 * would give; neither is a speed anyone can stand behind, and "0 read per second"
 * on the card is a false claim about the machine.
 *
 * But a bad rate only drops ITS OWN number. The two halves are measured
 * separately, and discarding a perfectly good WRITE rate because the prompt came
 * out of the cache would blank the card's whole speed line for a reply that
 * really did run. Only a frame with neither usable rate is "no reading".
 */
export function parseTimingsChunk(json: unknown): ReplyTimings | null {
  const t = (json as any)?.timings;
  if (!t || typeof t !== 'object') return null;
  const rate = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const promptPerSecond = rate(t.prompt_per_second);
  const generatePerSecond = rate(t.predicted_per_second);
  if (promptPerSecond === undefined && generatePerSecond === undefined) return null;
  return { promptPerSecond, generatePerSecond };
}

/**
 * Scan a raw SSE byte stream for `prompt_progress` readings.
 *
 * Deliberately tolerant: this runs on a COPY of a response the SDK is also
 * consuming, so anything it fails to understand must be skipped silently. A
 * malformed line, a non-llama.cpp server that never sends progress, or a body
 * that isn't SSE at all must all end in "no progress reported" — never an error
 * that could surface as a failed turn. The user's actual request is unaffected
 * by anything that happens in here.
 */
export async function scanPrefillProgress(
  body: ReadableStream<Uint8Array>,
  onProgress?: (p: PrefillProgress) => void,
  /** Called ONCE when a completion stream ENDS CLEANLY, with the speed reading
   *  from its final frame or `null` when it carried none. Two deliberate
   *  silences: a body that was never a chat-completion stream (a /models GET
   *  going through the same fetch) reports nothing at all, so it can never
   *  blank a good reading; and neither does an ABORTED stream (the user pressed
   *  stop) — an interrupted reply has no honest speed to report, and the last
   *  reply we did measure is a truer answer than none. */
  onReply?: (t: ReplyTimings | null) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // What this stream turned out to be, and the last speed reading in it. Only a
  // stream we positively recognised as a completion is allowed to report.
  let sawCompletionFrame = false;
  let timings: ReplyTimings | null = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are newline-delimited; keep the trailing partial line.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const progress = parseProgressChunk(json);
          if (progress) onProgress?.(progress);
          // llama-server stamps every completion frame with this. It is what
          // tells a completion stream apart from any other body the SDK's fetch
          // might carry, so `onReply` never fires on something it cannot know
          // the speed of.
          if ((json as any)?.object === 'chat.completion.chunk') sawCompletionFrame = true;
          // Keep the LAST reading, not the first: the block rides the final
          // frame, and taking the first match would pin an early one if a future
          // build ever emitted more than one.
          const t = parseTimingsChunk(json);
          if (t) timings = t;
        } catch {
          // Not JSON, or not a shape we know — skip. See tolerance note above.
        }
      }
    }
    // Reached only when the stream ended on its own: report what the reply ran
    // at, or `null` for a completion whose final frame carried no timings (a
    // future build that drops the block) — which CLEARS the card's speed line
    // rather than leaving yesterday's number under today's reply.
    if (sawCompletionFrame) onReply?.(timings);
  } catch {
    // The stream aborted (user interrupt, network drop). The SDK's branch owns
    // reporting that; ours just stops — deliberately without calling onReply.
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/**
 * Wrap a fetch so llama.cpp prefill progress — and the finished reply's speed —
 * are reported as the response streams.
 *
 * Returns a fetch with identical semantics: the caller receives a response whose
 * body is untouched. We only ever read a TEE'd copy.
 */
export function withPrefillProgress(
  base: typeof fetch,
  onProgress?: (p: PrefillProgress) => void,
  onReply?: (t: ReplyTimings | null) => void,
): typeof fetch {
  // Nobody listening → no tee. Copying every byte of every response for an
  // audience of none is the cost this guard exists to avoid.
  if (!onProgress && !onReply) return base;
  return async (input: any, init?: any) => {
    const res = await base(input, init);
    // Non-streaming replies (errors, /models) have nothing to watch.
    if (!res.body || !res.ok) return res;
    const [forSdk, forUs] = res.body.tee();
    // Fire-and-forget: the SDK's branch must never wait on ours.
    void scanPrefillProgress(forUs, onProgress, onReply);
    return new Response(forSdk, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}
