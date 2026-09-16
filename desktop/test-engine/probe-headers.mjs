#!/usr/bin/env node
// Probe: the GGUF header reader really does answer "how big is this model's KV
// cache?" from ONE 1 MB HTTP range request, against the live curated repos.
//
// WHY this cannot be a unit test: the whole design of gguf-header.ts rests on a
// fact about real files that we do not control — that a converted GGUF writes
// its architecture keys BEFORE its tokenizer arrays, and that all of them fit
// inside the first megabyte. The tokenizer arrays run to tens of megabytes, so
// if that ordering ever changed upstream, the model cards would quietly start
// pulling the whole vocabulary of every model in the list just to draw a
// "will it fit?" line. Unit tests use fixtures we wrote, and would keep passing.
//
// It also prints each repo's real numbers, which is how the layer rules in
// gguf-header.ts were checked against llama.cpp in the first place.
//
// Usage:
//   node test-engine/probe-headers.mjs                  # every curated repo
//   node test-engine/probe-headers.mjs --repo unsloth/gemma-4-E2B-it-GGUF
//   node test-engine/probe-headers.mjs --local ~/.cache/llama.cpp/x.gguf
// Needs network for the repo mode. Re-run on every engine bump, alongside
// probe-{health,models,chat,tools,download,speed,presets,vision}.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src', 'main', 'models', 'gguf-header.ts');

// Load the REAL module — the point of the probe is that the shipping parser
// handles these files, not that some copy of it does. Node's built-in type
// stripping refuses a .ts file inside a "type": "commonjs" package, so the file
// is transpiled (types removed only, no type checking) into a temp .mjs and
// imported from there.
async function loadReader() {
  const out = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-headers-'));
  try {
    const file = path.join(dir, 'gguf-header.mjs');
    fs.writeFileSync(file, out);
    return await import(pathToFileURL(file).href);
  } finally {
    // Node has the module loaded by now; the file on disk is no longer needed.
    // Without this every run left a directory behind (15 of them after a day).
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

// Mirrors curated-models.ts. Kept as a literal list on purpose: this probe runs
// from a plain Node CLI and a drifted list is a visible diff, not a silent skip.
const CURATED = [
  'unsloth/Qwen3.5-2B-GGUF',
  'unsloth/Qwen3.5-4B-GGUF',
  'unsloth/gemma-4-E4B-it-GGUF',
  'unsloth/Qwen3.5-9B-GGUF',
  'unsloth/gemma-4-12b-it-GGUF',
  'unsloth/gpt-oss-20b-GGUF',
  'unsloth/gemma-4-26B-A4B-it-GGUF',
  'unsloth/Qwen3.6-27B-GGUF',
  'unsloth/Qwen3.5-35B-A3B-GGUF',
  'unsloth/gpt-oss-120b-GGUF',
  'unsloth/Qwen3.5-122B-A10B-GGUF',
];
const QUANT_DEFAULT = 'UD-Q4_K_XL';

function describe(h) {
  const layers = h.slidingLayers;
  const sliding = layers ? layers.filter(Boolean).length : 0;
  return [
    `arch=${h.architecture}`,
    `layers=${h.blockCount}`,
    h.headCountKvLayers
      ? `kv_heads=[${[...new Set(h.headCountKvLayers)].join('|')}] per layer`
      : `kv_heads=${h.headCountKv}`,
    `dK/dV=${h.keyLength}/${h.valueLength}`,
    h.keyLengthSwa != null ? `swa dK/dV=${h.keyLengthSwa}/${h.valueLengthSwa}` : null,
    `ctx=${h.contextLength}`,
    h.slidingWindow != null ? `window=${h.slidingWindow}` : null,
    h.slidingWindowPattern != null ? `pattern=${h.slidingWindowPattern} (scalar)` : null,
    h.slidingWindowPatternLayers != null ? `pattern=[${h.slidingWindowPatternLayers.length} bools]` : null,
    h.fullAttentionInterval != null ? `full_attn_interval=${h.fullAttentionInterval}` : null,
    h.nextnPredictLayers ? `nextn=${h.nextnPredictLayers}` : null,
    h.sharedKvLayers != null ? `shared_kv_layers=${h.sharedKvLayers}` : null,
    // Which SOURCE the recurrent map came from matters: llama.cpp prefers the
    // per-layer `recurrent_layers` array over `full_attention_interval`, so a
    // repo switching to the array form is a thing to notice here first.
    h.recurrentLayers
      ? `recurrent ${h.recurrentLayers.filter(Boolean).length}/${h.recurrentLayers.length} layers`
      : null,
    layers ? `sliding ${sliding}/${layers.length} layers` : 'no sliding layers',
    `archBytes=${h.archBytes}`,
    h.contextBytesIsUpperBound ? 'UPPER BOUND' : 'exact',
  ].filter(Boolean).join('  ');
}

/** The default quant's FIRST file — the one file per repo the app reads. */
async function firstFileOf(repo) {
  const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`);
  if (!res.ok) throw new Error(`HF tree for ${repo}: HTTP ${res.status}`);
  const rows = await res.json();
  const ggufs = rows
    .filter((r) => r?.type === 'file' && typeof r.path === 'string' && /\.gguf$/i.test(r.path))
    .filter((r) => !/(^|\/)mmproj/i.test(r.path))
    .map((r) => r.path)
    .sort();
  const preferred = ggufs.filter((p) => p.includes(QUANT_DEFAULT));
  const pool = preferred.length ? preferred : ggufs;
  // A split set's first part carries the metadata; parts 2..N have no header.
  const first = pool.find((p) => /-00001-of-\d{5}\.gguf$/i.test(p)) ?? pool.find((p) => !/-\d{5}-of-\d{5}\.gguf$/i.test(p)) ?? pool[0];
  if (!first) throw new Error(`${repo}: no .gguf files listed`);
  return first;
}

const mod = await loadReader();
const { fetchRemoteGgufHeader, readLocalGgufHeader, CHUNK_BYTES } = mod;

const localPath = arg('--local');
if (localPath) {
  const h = await readLocalGgufHeader(localPath);
  console.log(`${path.basename(localPath)}\n  ${describe(h)}`);
  if (h.archBytes >= CHUNK_BYTES) {
    console.error(`FAIL: architecture keys reach ${h.archBytes} bytes — past the ${CHUNK_BYTES}-byte first step.`);
    process.exit(1);
  }
  console.log(`PASS: every architecture key is inside the first ${CHUNK_BYTES} bytes.`);
  process.exit(0);
}

const repos = arg('--repo') ? [arg('--repo')] : CURATED;
let failures = 0;
for (const repo of repos) {
  let requests = 0;
  const counting = (url, init) => { requests++; return fetch(url, init); };
  try {
    const file = await firstFileOf(repo);
    const encoded = file.split('/').map(encodeURIComponent).join('/');
    const url = `https://huggingface.co/${repo}/resolve/main/${encoded}`;
    const h = await fetchRemoteGgufHeader(url, counting);
    console.log(`${repo}  (${file})\n  ${describe(h)}  requests=${requests}`);

    // The claim under test, in two halves: one range request was enough, and
    // the keys we need are nowhere near the end of that request.
    if (requests !== 1) {
      console.error(`FAIL: ${repo} needed ${requests} range requests — the header no longer fits in one ${CHUNK_BYTES}-byte step.`);
      failures++;
    } else if (h.archBytes >= CHUNK_BYTES) {
      console.error(`FAIL: ${repo}'s architecture keys reach ${h.archBytes} bytes.`);
      failures++;
    } else if (h.blockCount === null || h.headCountKv === null) {
      console.error(`FAIL: ${repo} produced no layer/head counts — fit-estimator.ts would have nothing to size a KV cache from.`);
      failures++;
    } else if (h.contextBytesIsUpperBound) {
      // Not a failure: a genuinely new architecture SHOULD land here rather
      // than be guessed at. It does mean this model's card will say "up to".
      console.log(`  NOTE: ${repo} reports an upper bound — add its layer rule to gguf-header.ts if llama.cpp has one.`);
    }
  } catch (e) {
    console.error(`FAIL: ${repo}: ${e.message}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} of ${repos.length} repos failed.`);
  process.exit(1);
}
console.log(`\nPASS: ${repos.length} curated repos, one ${CHUNK_BYTES}-byte range request each.`);
