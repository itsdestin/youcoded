// test-engine/probe-prefix-cache.mjs — measures whether llama-server reuses
// a shared KV cache when consecutive requests share an identical long system
// prefix (spec §4 KV-cache discipline; plan 1a "specialists" fan-out). NOT a
// unit test: run against a live llama-server.
//
// Two runs, both against one already-loaded model:
//   (a) two requests sharing an IDENTICAL ~2,000-token system prefix, with
//       different user turns, sent sequentially
//   (b) two requests with FULLY DISTINCT ~2,000-token system prefixes (no
//       shared prefix at all), sent sequentially
// For each request this reads prefill time from the llama-server completion
// payload (`timings.prompt_ms`); if a build ever omits that field, it falls
// back to wall-clocking the full non-streaming round-trip — an UPPER BOUND on
// prefill (includes the small generation), good enough for the <50% comparison.
//
// Verdict: prefix reuse is proven if run (a)'s SECOND request prefills
// materially faster than run (b)'s SECOND request — "materially faster"
// meaning (a)'s second prefill is under 50% of (b)'s second prefill. Both
// runs' second request is the one that matters: it's the one that could
// have reused a cached prefix from the request immediately before it.
//
// Follows the probe-tools.mjs / probe-parallel.mjs convention: this script
// does NOT spawn a server. Launch one yourself first, matching
// engine-supervisor.ts's real router-mode spawn (engine-supervisor.ts, the spawn()):
//
//   llama-server --host 127.0.0.1 --port 8199 --no-webui --jinja \
//     --models-dir <cacheDir> --models-max 2 --spec-default --cache-type-k q8_0 \
//     --models-preset <models.ini>
//
// Usage: node test-engine/probe-prefix-cache.mjs <baseURL> <modelId>
const [base, model] = process.argv.slice(2);
if (!base || !model) { console.error('usage: probe-prefix-cache.mjs <baseURL> <modelId>'); process.exit(2); }

// ~2,000-token filler prefix built from a fixed sentence repeated enough times
// to clear the target under a rough ~33-tokens-per-sentence estimate for this
// wording; the script prints the server-reported actual `prompt_n` for the
// ground truth rather than trusting the estimate.
function buildPrefix(seed, approxTokens = 2000) {
  const sentence = `Seed ${seed}: the quarterly engineering review covers parallel workstream coordination, specialist dispatch discipline, and prefix-sharing across sequential child-style requests handled by the router. `;
  const tokensPerSentence = 33;
  const repeats = Math.ceil(approxTokens / tokensPerSentence);
  return Array.from({ length: repeats }, (_, i) => `[${seed}-${i}] ${sentence}`).join('');
}

const PREFIX_A = buildPrefix('A');
const PREFIX_B = buildPrefix('B');

async function chatTimed(systemPrefix, userContent) {
  const start = performance.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrefix },
        { role: 'user', content: userContent },
      ],
      max_tokens: 8,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const wallMs = performance.now() - start;
  if (json.timings?.prompt_ms != null) {
    return { promptMs: json.timings.prompt_ms, promptN: json.timings.prompt_n ?? null, source: 'timings.prompt_ms', wallMs };
  }
  // Fallback: this build's payload has no timings block — wall-clock stands
  // in for time-to-first-token since we only issued a non-streaming request.
  return { promptMs: wallMs, promptN: null, source: 'wall-clock fallback upper-bound (no timings field)', wallMs };
}

(async () => {
  console.log(`probe-prefix-cache: warming up ${model} @ ${base} ...`);
  await chatTimed(buildPrefix('WARMUP', 50), 'warmup');

  console.log('\nRun (a): identical ~2000-token system prefix, sequential, different user turns');
  const a1 = await chatTimed(PREFIX_A, 'Summarize the review in five words.');
  const a2 = await chatTimed(PREFIX_A, 'What is the third topic mentioned?');
  console.log(`  a1 prompt_ms=${a1.promptMs.toFixed(1)} prompt_n=${a1.promptN} (${a1.source})`);
  console.log(`  a2 prompt_ms=${a2.promptMs.toFixed(1)} prompt_n=${a2.promptN} (${a2.source})`);

  console.log('\nRun (b): fully distinct ~2000-token system prefixes, sequential');
  const b1 = await chatTimed(PREFIX_A, 'Summarize the review in five words.');
  const b2 = await chatTimed(PREFIX_B, 'What is the third topic mentioned?');
  console.log(`  b1 prompt_ms=${b1.promptMs.toFixed(1)} prompt_n=${b1.promptN} (${b1.source})`);
  console.log(`  b2 prompt_ms=${b2.promptMs.toFixed(1)} prompt_n=${b2.promptN} (${b2.source})`);

  const ratio = a2.promptMs / b2.promptMs;
  const reused = ratio < 0.5;
  console.log(`\na2/b2 prefill ratio = ${(ratio * 100).toFixed(1)}% (reuse threshold: < 50%)`);
  console.log(reused
    ? 'VERDICT: prefix reuse SURVIVES sequential child-style requests on this build.'
    : 'VERDICT: prefix reuse DOES NOT SURVIVE sequential child-style requests on this build.');
})().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
