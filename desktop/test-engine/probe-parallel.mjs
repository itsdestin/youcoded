// test-engine/probe-parallel.mjs — measures llama-server's parallel request
// capacity (spec §4, plan 1a "specialists" fan-out). NOT a unit test: run
// against a live llama-server to find how many SIMULTANEOUS short chat
// completions the server actually services concurrently vs serializing them
// behind one another. Two classifications, per N in {1, 2, 4}:
//   - "serialized": total wall time for N requests ≈ N × single-request time
//     (the server ran them one after another — no real batching)
//   - "batched": total wall time ≈ single-request time + a small margin
//     (the server's continuous-batching scheduler ran them together)
// Follows the probe-tools.mjs convention: this script does NOT spawn a
// server. Launch one yourself first, matching engine-supervisor.ts's real
// router-mode spawn (src/main/engine/engine-supervisor.ts, the spawn(); context length and
// auto-sleep live in the preset's [*] section since 2026-09-05, NOT on the
// command line — a -c here outranks every preset):
//
//   llama-server --host 127.0.0.1 --port 8199 --no-webui --jinja \
//     --models-dir <cacheDir> --models-max 2 --spec-default --cache-type-k q8_0 \
//     --models-preset <models.ini>
//
// To test the `-np/--parallel` slot count, add it to that same command:
//
//   llama-server --host 127.0.0.1 --port 8199 --no-webui --jinja \
//     --models-dir <cacheDir> --models-max 2 --spec-default --cache-type-k q8_0 \
//     --models-preset <models.ini> --parallel 4
//
// Usage: node test-engine/probe-parallel.mjs <baseURL> <modelId> [N,N,...]
// WHY the optional third argument (2026-09-04, stage-two probe re-run): the
// original fixed {1,2,4} list stops exactly at the slot count, so it can show
// batching but never the CEILING — what happens when fan-out exceeds the slots
// (N=8 on a 4-slot server should serialize into two waves). Default unchanged.
const [base, model, nsArg] = process.argv.slice(2);
const NS = nsArg ? nsArg.split(',').map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0) : [1, 2, 4];
if (!base || !model) { console.error('usage: probe-parallel.mjs <baseURL> <modelId> [N,N,...]'); process.exit(2); }
if (nsArg && NS.length === 0) { console.error(`usage: the N list "${nsArg}" has no positive integers`); process.exit(2); }

const PROMPT = 'In one short sentence, name the capital of France.';
const MAX_TOKENS = 24;

async function chat() {
  const start = performance.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT }], max_tokens: MAX_TOKENS, temperature: 0 }),
  });
  const elapsed = performance.now() - start;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return { elapsed, promptMs: json.timings?.prompt_ms ?? null, predictedMs: json.timings?.predicted_ms ?? null };
}

async function runBatch(n) {
  const start = performance.now();
  const results = await Promise.all(Array.from({ length: n }, () => chat()));
  const total = performance.now() - start;
  const perRequest = results.map((r) => r.elapsed);
  const avg = perRequest.reduce((a, b) => a + b, 0) / n;
  return { n, total, perRequest, avg, min: Math.min(...perRequest), max: Math.max(...perRequest) };
}

(async () => {
  console.log(`probe-parallel: warming up ${model} @ ${base} (loads the model into the router before timing) ...`);
  try {
    await chat(); // first request also pays for model load — exclude it from the timed runs
  } catch (e) {
    console.error(`FAIL warmup request errored: ${String(e.message || e)}`);
    process.exit(1);
  }

  const rows = [];
  // Review F1 (2026-09-04): the baseline used to be "the N=1 row", so a list without 1
  // (e.g. 2,4,8) left it null and every percentage printed Infinity. Measure it once here.
  let singleAvg;
  try {
    singleAvg = (await runBatch(1)).avg;
  } catch (e) {
    console.error(`FAIL baseline request errored: ${String(e.message || e)}`);
    process.exit(1);
  }
  for (const n of NS) {
    let r;
    try {
      r = await runBatch(n);
    } catch (e) {
      // A `--parallel N` argument mismatch (or a slot-exhaustion error) is itself
      // the finding this probe exists to surface — print it verbatim, don't swallow it.
      console.error(`FAIL N=${n} batch errored: ${String(e.message || e)}`);
      process.exit(1);
    }
    rows.push(r);
  }

  console.log('\n N | total_ms | avg_req_ms | min_ms | max_ms | vs N×single | classification');
  console.log('---|----------|------------|--------|--------|-------------|----------------');
  for (const r of rows) {
    const expectedSerialized = singleAvg * r.n;
    const ratioOfExpected = r.total / expectedSerialized;
    // batched: total stayed near one request's time; serialized: total tracked N× single
    const cls = r.total <= singleAvg * 1.5 ? 'batched' : r.total >= expectedSerialized * 0.7 ? 'serialized' : 'partial';
    console.log(
      ` ${String(r.n).padEnd(2)}| ${r.total.toFixed(0).padStart(8)} | ${r.avg.toFixed(0).padStart(10)} | ${r.min.toFixed(0).padStart(6)} | ${r.max.toFixed(0).padStart(6)} | ${(ratioOfExpected * 100).toFixed(0).padStart(10)}% | ${cls}`
    );
  }
  console.log(`\nsingle-request avg baseline: ${singleAvg.toFixed(0)} ms`);
  console.log('LOCAL_MAX_CONCURRENT_SPECIALISTS candidate = largest N whose avg_req_ms <= 2x the single-request baseline.');
})().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
