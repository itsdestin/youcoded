#!/usr/bin/env node
// Regenerates the ENGINE_ASSETS table (and the ARG_ALIASES table) for
// src/main/engine/engine-pin.ts from upstream, so a pin bump is a paste rather
// than a transcription. Usage:
//   node scripts/generate-engine-pin.mjs b10665 [--binary <path/to/llama-server>]
// Paste the printed rows into engine-pin.ts, bump ENGINE_VERSION, and re-run
// the test-engine/ probes (engine-dependencies.md). binaryRelPath is computed
// per archive family below — you should NOT need to hand-edit it, but the
// test-engine probes + acquisition's post-unpack existence check will catch it
// if a family's layout ever shifts.
//
// Three tables come from three DIFFERENT upstream sources, which is why this
// script talks to more than the release API:
//   1. asset name + sha256  — the GitHub release API (assets carry a `digest`).
//   2. ROCm gfx targets     — .github/workflows/release.yml AT THE TAG, whose
//      `gpu_targets:` matrix entry is the literal list the build was compiled
//      for. Nothing in the release API reports it, and guessing it wrong means
//      the app offers a ROCm switch to a chip whose kernels are not in the
//      archive — a "failed to load kernel image" crash at first token.
//   3. CLI alias table      — the pinned binary's own `--help`, so short (`-c`),
//      long (`--ctx-size`) and env (`LLAMA_ARG_CTX_SIZE`) spellings of one
//      option can be collapsed to one canonical long name.
//
// WHY every heavy step lives behind main(): the pure parsers below are imported
// by tests/generate-engine-pin.test.ts. A top-level `await fetch(...)` (what
// this file used to have) would fire on import and make the test hit the
// network, so the fetching is all inside main() and main() only runs when the
// file is executed directly.
import { execFile } from 'child_process';
import { pathToFileURL } from 'url';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Only the variants YouCoded ships (spec §3.1): Vulkan default on win/linux,
// CPU fallback, Metal-by-default macOS builds, CUDA opt-in (Windows only —
// upstream publishes no Linux CUDA asset), ROCm opt-in on AMD (both platforms).
// `runtimeSuffix` is the SEPARATE archive that must be unpacked alongside the
// engine for that backend to boot: the Windows CUDA zips ship ggml-cuda.dll but
// not the CUDA runtime, so a machine without the toolkit on PATH cannot start
// them. The ROCm zip needs no such row — upstream bundles amdhip64_7.dll inside
// it. Note the cudart archive is NOT tagged, so its name is not templated.
const WANTED = [
  { platform: 'win32',  arch: 'x64',   backend: 'vulkan', suffix: 'bin-win-vulkan-x64.zip' },
  { platform: 'win32',  arch: 'x64',   backend: 'cpu',    suffix: 'bin-win-cpu-x64.zip' },
  { platform: 'win32',  arch: 'arm64', backend: 'cpu',    suffix: 'bin-win-cpu-arm64.zip' },
  { platform: 'win32',  arch: 'x64',   backend: 'cuda',   suffix: 'bin-win-cuda-12.4-x64.zip', runtimeSuffix: 'bin-win-cuda-12.4-x64.zip' },
  { platform: 'win32',  arch: 'x64',   backend: 'rocm',   suffix: 'bin-win-rocm-7.14-x64.zip', rocmJob: 'windows-rocm' },
  { platform: 'darwin', arch: 'arm64', backend: 'metal',  suffix: 'bin-macos-arm64.tar.gz' },
  { platform: 'darwin', arch: 'x64',   backend: 'metal',  suffix: 'bin-macos-x64.tar.gz' },
  { platform: 'linux',  arch: 'x64',   backend: 'vulkan', suffix: 'bin-ubuntu-vulkan-x64.tar.gz' },
  { platform: 'linux',  arch: 'x64',   backend: 'cpu',    suffix: 'bin-ubuntu-x64.tar.gz' },
  { platform: 'linux',  arch: 'x64',   backend: 'rocm',   suffix: 'bin-ubuntu-rocm-7.14-x64.tar.gz', rocmJob: 'ubuntu-24-rocm' },
  { platform: 'linux',  arch: 'arm64', backend: 'vulkan', suffix: 'bin-ubuntu-vulkan-arm64.tar.gz' },
  { platform: 'linux',  arch: 'arm64', backend: 'cpu',    suffix: 'bin-ubuntu-arm64.tar.gz' },
];

// Empirically (b9992, re-confirmed b10665): Windows .zip archives are flat
// (llama-server.exe at the root — upstream's release job injects the whole CPU
// toolset into every win backend zip); macOS/Linux .tar.gz archives nest under
// a single `llama-<tag>/` dir. The tar path is version-dependent, so it must be
// templated with the tag.
export function binaryRelPathFor(suffix, tag) {
  return suffix.endsWith('.zip') ? 'llama-server.exe' : `llama-${tag}/llama-server`;
}

/** The AMD compute targets each ROCm build was compiled for, read out of the
 *  release workflow at the tag: { 'windows-rocm': ['gfx1010', …], … }.
 *  Parsed by walking top-level job names (2-space indent) so a `gpu_targets:`
 *  line is attributed to the job it sits under. */
export function parseGfxTargets(workflowYaml) {
  const out = {};
  let job = null;
  for (const line of workflowYaml.split('\n')) {
    const jobLine = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (jobLine) { job = jobLine[1]; continue; }
    const targets = line.match(/^\s*gpu_targets:\s*["']([^"']+)["']\s*$/);
    if (targets && job) out[job] = targets[1].split(';').map((t) => t.trim()).filter(Boolean);
  }
  return out;
}

// One option's spellings, as `--help` prints them:
//   -ngl,  --gpu-layers, --n-gpu-layers N   max. number of layers to store …
//                                           (env: LLAMA_ARG_N_GPU_LAYERS)
// Flags are comma-separated and the LAST one carries no comma, which is the
// only reliable end marker: the value placeholder that usually follows (`N`,
// `PATH`, `{none,linear,yarn}`) is not always present, and the description can
// itself start with a dash.
function parseHelpOptions(helpText) {
  const opts = [];
  let cur = null;
  for (const line of helpText.split('\n')) {
    if (/^-{5}/.test(line)) { cur = null; continue; }   // ----- section header -----
    if (line === '' || /^\s/.test(line)) {
      const env = line.match(/\(env:\s+([A-Z0-9_]+)\)/);
      if (env && cur) cur.env = env[1];                 // env always sits on a continuation line
      continue;
    }
    if (!line.startsWith('-')) { cur = null; continue; }
    const flags = [];
    for (const token of line.trim().split(/\s+/)) {
      const more = token.endsWith(',');
      const name = more ? token.slice(0, -1) : token;
      if (!/^--?[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)) break;
      flags.push(name);
      if (!more) break;
    }
    if (!flags.length) { cur = null; continue; }
    cur = { flags, env: null };
    opts.push(cur);
  }
  return opts;
}

/** llama-server prints a boolean option's ON and OFF spellings on ONE line, in
 *  that order: `-kvo, --kv-offload, -nkvo, --no-kv-offload`. Splitting them by
 *  "starts with no-" is not enough, because the OFF SHORT does not (`-nkvo`,
 *  `-nocb`, `-ndio`, `-nr`). What IS reliable is that the OFF spellings are the
 *  trailing run: scan from the end, take everything until a long that is not a
 *  `--no-…` — the shorts swept up on the way are the negated ones.
 *  An option whose ONLY long is a `--no-…` (`--no-host`) is not a pair at all;
 *  it is returned whole, as its own positive. */
function splitNegations(flags) {
  let i = flags.length;
  while (i > 0) {
    const f = flags[i - 1];
    if (f.startsWith('--') && !f.startsWith('--no-')) break;
    i--;
  }
  const positive = flags.slice(0, i);
  return positive.some((f) => f.startsWith('--')) ? { positive, negative: flags.slice(i) } : { positive: flags, negative: [] };
}

/** Every alternate spelling of a llama-server option -> its one canonical long
 *  name, built from `--help`. Identity entries are omitted, so a consumer reads
 *  it as `ARG_ALIASES[key] ?? key`.
 *
 *  Canonical = the long form the option's env var is named after when there is
 *  one (`LLAMA_ARG_N_GPU_LAYERS` -> `n-gpu-layers`, `LLAMA_ARG_PERF` -> `perf`),
 *  else the last positive long. Picking "the last long" without splitting the
 *  negations off first would name every boolean pair after its OFF switch.
 *
 *  A negated spelling resolves to `no-<canonical>`, NOT to `<canonical>`.
 *  Collapsing the two would let a caller that normalises before writing turn a
 *  user's `--no-mmap` into `mmap = 1` — the exact opposite of what they asked
 *  for. A denylist that wants to catch both spellings strips the `no-` itself;
 *  silently inverting a flag is not recoverable. */
export function parseArgAliases(helpText) {
  const table = {};
  for (const opt of parseHelpOptions(helpText)) {
    const { positive, negative } = splitNegations(opt.flags);
    const longs = positive.filter((f) => f.startsWith('--')).map((f) => f.slice(2));
    if (!longs.length) continue;   // short-only options do not exist today; nothing to canonicalise to
    let canonical = null;
    if (opt.env) {
      const fromEnv = opt.env.replace(/^LLAMA_ARG_/, '').replace(/^LLAMA_/, '').toLowerCase().replace(/_/g, '-');
      canonical = longs.find((l) => l === fromEnv) ?? null;
    }
    canonical ??= longs[longs.length - 1];
    const bare = (f) => (f.startsWith('--') ? f.slice(2) : f.slice(1));
    // The env var names the ON spelling, so it goes with the positives.
    for (const f of [...positive.map(bare), ...(opt.env ? [opt.env] : [])]) {
      if (f !== canonical) table[f] = canonical;
    }
    for (const f of negative.map(bare)) {
      if (f !== `no-${canonical}`) table[f] = `no-${canonical}`;
    }
  }
  return table;
}

/** One ENGINE_ASSETS row per WANTED entry, or a `problem` string naming exactly
 *  what upstream did not provide (never a guess — the row is dropped and the
 *  maintainer is told which asset/job to look at). */
export function buildAssetRows(release, tag, gfxByJob = {}) {
  const assets = release?.assets ?? [];
  const rows = [];
  const problems = [];
  for (const w of WANTED) {
    const name = `llama-${tag}-${w.suffix}`;
    const asset = assets.find((a) => a.name === name);
    if (!asset) { problems.push(`missing upstream asset: ${name} — upstream naming changed? Update WANTED in generate-engine-pin.mjs.`); continue; }
    const sha256 = String(asset.digest ?? '').replace(/^sha256:/, '');
    if (!/^[0-9a-f]{64}$/.test(sha256)) { problems.push(`no sha256 digest on ${name} — compute it manually and paste.`); continue; }
    const row = {
      platform: w.platform, arch: w.arch, backend: w.backend, assetName: name, sha256,
      binaryRelPath: binaryRelPathFor(w.suffix, tag),
    };
    if (w.runtimeSuffix) {
      // The cudart archive carries no tag in its name (checked against the
      // b10665 release listing), so it is looked up by the literal name.
      const runtimeName = `cudart-llama-${w.runtimeSuffix}`;
      const runtimeAsset = assets.find((a) => a.name === runtimeName);
      const runtimeSha = String(runtimeAsset?.digest ?? '').replace(/^sha256:/, '');
      if (!/^[0-9a-f]{64}$/.test(runtimeSha)) { problems.push(`no usable ${runtimeName} for ${name} — the CUDA build cannot boot without its runtime.`); continue; }
      row.runtime = { assetName: runtimeName, sha256: runtimeSha };
    }
    if (w.rocmJob) {
      const targets = gfxByJob[w.rocmJob];
      if (!targets?.length) { problems.push(`no gpu_targets for job "${w.rocmJob}" in .github/workflows/release.yml@${tag} — re-check the ROCm target list by hand.`); continue; }
      row.gfxTargets = targets;
    }
    rows.push(row);
  }
  return { rows, problems };
}

/** A row as it is pasted into ENGINE_ASSETS — one line, keys in interface order. */
export function formatAssetRow(row) {
  const parts = [
    `platform: '${row.platform}'`, `arch: '${row.arch}'`, `backend: '${row.backend}'`,
    `assetName: '${row.assetName}'`, `sha256: '${row.sha256}'`, `binaryRelPath: '${row.binaryRelPath}'`,
  ];
  if (row.runtime) parts.push(`runtime: { assetName: '${row.runtime.assetName}', sha256: '${row.runtime.sha256}' }`);
  if (row.gfxTargets) parts.push(`gfxTargets: [${row.gfxTargets.map((t) => `'${t}'`).join(', ')}]`);
  return `  { ${parts.join(', ')} },`;
}

/** The ARG_ALIASES block, wrapped so 300-odd pairs do not become 300 lines. */
export function formatArgAliases(table) {
  const entries = Object.keys(table).sort().map((k) => `${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : `'${k}'`}: '${table[k]}',`);
  const lines = [];
  let line = ' ';
  for (const e of entries) {
    if (line.length + e.length + 1 > 96) { lines.push(line); line = ' '; }
    line += ` ${e}`;
  }
  if (line.trim()) lines.push(line);
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const binaryIdx = args.indexOf('--binary');
  const binary = binaryIdx >= 0 ? args[binaryIdx + 1] : null;
  // Drop --binary AND its value before looking for the tag, or a path argument
  // gets mistaken for the release tag and every asset lookup misses. The
  // binaryIdx >= 0 guard is load-bearing: without --binary, binaryIdx is -1 and
  // the test collapses to `i !== 0`, which throws the TAG away and makes the
  // documented tag-only invocation exit with a usage error.
  const positional = args.filter((a, i) => !a.startsWith('--') && !(binaryIdx >= 0 && i === binaryIdx + 1));
  const tag = positional[0];
  if (!tag || (binaryIdx >= 0 && !binary)) {
    console.error('usage: generate-engine-pin.mjs <release-tag> [--binary <path/to/llama-server>]');
    process.exit(1);
  }

  const res = await fetch(`https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${tag}`);
  if (!res.ok) { console.error(`GitHub API ${res.status} for release ${tag}`); process.exit(1); }
  const release = await res.json();

  const wfRes = await fetch(`https://raw.githubusercontent.com/ggml-org/llama.cpp/${tag}/.github/workflows/release.yml`);
  if (!wfRes.ok) { console.error(`release.yml@${tag} → HTTP ${wfRes.status}; the ROCm gfx target list cannot be read.`); process.exit(1); }
  const gfxByJob = parseGfxTargets(await wfRes.text());

  const { rows, problems } = buildAssetRows(release, tag, gfxByJob);
  for (const p of problems) console.error(`// PROBLEM: ${p}`);
  for (const row of rows) console.log(formatAssetRow(row));
  console.log(`\n// ENGINE_VERSION = '${tag}'`);

  if (!binary) {
    console.error('\n// ARG_ALIASES NOT regenerated — pass --binary <path/to/llama-server> for the pinned build.');
    return;
  }
  // `--help` only prints and exits; it opens no port and loads no model.
  const { stdout } = await execFileAsync(binary, ['--help'], { maxBuffer: 8 * 1024 * 1024 });
  const table = parseArgAliases(stdout);
  // Emitted WITH the Object.assign(Object.create(null), …) wrapper, so pasting
  // it keeps the table prototype-less — see the WHY on ARG_ALIASES itself.
  console.log(`\n// ARG_ALIASES (${Object.keys(table).length} aliases, from ${tag} --help)`);
  console.log(`export const ARG_ALIASES: Record<string, string> = Object.assign(Object.create(null), {\n${formatArgAliases(table)}\n});`);
}

// Run the fetching half ONLY when executed directly. Importing this file (the
// test does) must stay side-effect free — see the header note.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
