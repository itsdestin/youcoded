#!/usr/bin/env node
// Probe: our downloader's cache naming is served by the router, for single-file,
// MULTI-PART (Amendment 2026-07-14 H) and FOLDERED models (design §E2). Downloads
// a REAL tiny unsloth GGUF (~0.4GB) once, ALSO splits it with llama-gguf-split,
// and asserts llama-server lists + serves both under the filename-derived ids
// cache-scan.ts computes. The large-tier defaults (gpt-oss-120b, Qwen3.5-122B)
// are multi-part and can't be validated on a 32GB machine — this deterministic
// split is the ONLY cheap verification of that path. Re-run on engine pin bumps.
//
// The FOLDER cases exist because a model with a vision projector is downloaded
// into a subdirectory of its own, and llama-server names such a model by the
// FOLDER rather than by the file inside it — which is what cache-scan.ts
// derives its ids from. probe-vision.mjs covers the projector pairing itself;
// this one covers the naming, for a single file and for a split set.
// usage: node probe-download.mjs --binary <llama-server>
import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const argv = process.argv.slice(2);
const binary = argv[argv.indexOf('--binary') + 1];
if (!binary) { console.error('usage: probe-download.mjs --binary <llama-server>'); process.exit(1); }
const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, 'cache');
fs.mkdirSync(cacheDir, { recursive: true });

const REPO = 'unsloth/Qwen3-0.6B-GGUF';
const FILE = 'Qwen3-0.6B-Q4_K_M.gguf';
const dest = path.join(cacheDir, FILE);
if (!fs.existsSync(dest)) {
  console.log(`downloading ${REPO}/${FILE} (~0.4GB, one-time)…`);
  const res = await fetch(`https://huggingface.co/${REPO}/resolve/main/${FILE}`);
  if (!res.ok) { console.error(`FAIL: HF download HTTP ${res.status}`); process.exit(1); }
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// Split the single gguf into a flat multi-part set with the SIBLING
// llama-gguf-split binary (same archive as llama-server). of-count can vary by
// build/size, so we discover the actual 00001 part rather than hardcoding it.
const splitBin = binary.replace(/llama-server(\.exe)?$/i, (_m, ext) => `llama-gguf-split${ext ?? ''}`);
if (!fs.readdirSync(cacheDir).some((f) => /SPLIT-00001-of-\d{5}\.gguf$/.test(f))) {
  for (const f of fs.readdirSync(cacheDir)) if (/SPLIT-\d{5}-of-\d{5}\.gguf$/.test(f)) fs.rmSync(path.join(cacheDir, f));
  console.log('splitting into parts with llama-gguf-split…');
  const sp = spawnSync(splitBin, ['--split', '--split-max-size', '250M', dest, path.join(cacheDir, 'Qwen3-0.6B-SPLIT')], { stdio: 'inherit' });
  if (sp.status !== 0) { console.error('FAIL: llama-gguf-split exited nonzero'); process.exit(1); }
}
const firstPart = fs.readdirSync(cacheDir).find((f) => /SPLIT-00001-of-\d{5}\.gguf$/.test(f));
if (!firstPart) { console.error('FAIL: split produced no 00001 part'); process.exit(1); }
const expectedSingleId = FILE.replace(/\.gguf$/i, '');
const expectedSplitId = firstPart.replace(/\.gguf$/i, '');  // == cache-scan's id for a split model

// ── The folder layout (design §E2) ──────────────────────────────────────────
// Hardlinked, not re-downloaded: same bytes, no second 0.4GB fetch. The folder
// names deliberately DIFFER from the flat ids above, because a flat file and a
// folder of the same name are ONE id to the router: it serves one of the two and
// drops the other, and which one is NOT predictable (asserted at the end of this
// probe). ModelDownloader.start refuses to create that pair from either end, so
// the working layouts here must not create it either.
const FOLDER_ID = 'Qwen3-0.6B-DIR-Q4_K_M';
const folderDir = path.join(cacheDir, FOLDER_ID);
if (!fs.existsSync(path.join(folderDir, `${FOLDER_ID}.gguf`))) {
  fs.mkdirSync(folderDir, { recursive: true });
  fs.linkSync(dest, path.join(folderDir, `${FOLDER_ID}.gguf`));
}
// A SPLIT set inside a folder: the folder is named after part 1, exactly as the
// downloader names it, and the parts keep their own -00001-of-000NN names.
const splitParts = fs.readdirSync(cacheDir).filter((f) => /SPLIT-\d{5}-of-\d{5}\.gguf$/.test(f)).sort();
const dirSplitId = firstPart.replace('SPLIT', 'DIRSPLIT').replace(/\.gguf$/i, '');
const dirSplitDir = path.join(cacheDir, dirSplitId);
if (!fs.existsSync(path.join(dirSplitDir, `${dirSplitId}.gguf`))) {
  fs.mkdirSync(dirSplitDir, { recursive: true });
  for (const f of splitParts) fs.linkSync(path.join(cacheDir, f), path.join(dirSplitDir, f.replace('SPLIT', 'DIRSPLIT')));
}

const PORT = 9974;
// The spawn MUST mirror engine-supervisor.ts — crucially `--models-dir <cacheDir>`.
// Plan B verified (b9992) that the router discovers flat GGUFs from --models-dir,
// NOT from LLAMA_CACHE (which only tracks -hf auto-downloads). WITHOUT it, /models
// returns [] and this probe would FALSELY fail — do not "fix" the downloader in
// response; the missing flag is the bug. See docs/engine-dependencies.md.
const child = spawn(binary, ['--host', '127.0.0.1', '--port', String(PORT), '--no-webui', '--jinja', '--models-dir', cacheDir, '--models-max', '4', '-c', '4096'],
  { env: { ...process.env, LLAMA_CACHE: cacheDir }, stdio: ['ignore', 'inherit', 'inherit'] });
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
const models = await (await fetch(`http://127.0.0.1:${PORT}/models`)).json();
const ids = (models.data ?? models.models ?? models ?? []).map((m) => m.id ?? m.name);
console.log('router ids:', ids);
for (const [label, id] of [
  ['single-file', expectedSingleId],
  ['multi-part', expectedSplitId],
  // The folder cases: the id is the FOLDER's name. If either of these stops
  // being served, cache-scan.ts's folder id is wrong and every vision model in
  // the app becomes a row the engine will not answer to.
  ['foldered single-file', FOLDER_ID],
  ['foldered multi-part', dirSplitId],
]) {
  if (!ids.includes(id)) {
    child.kill();
    console.error(`FAIL: router does not serve the ${label} id '${id}' — flat-basename naming drifted; fix model-downloader/cache-scan + engine-dependencies.md`);
    process.exit(1);
  }
}
// Chat round-trip against the MULTI-PART model — proves a split model actually
// LOADS + serves under its part-1 id, not merely lists.
const chat = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: expectedSplitId, messages: [{ role: 'user', content: 'Say: pong' }] }),
});
const out = await chat.json();
child.kill();
console.log('multi-part reply:', JSON.stringify(out.choices?.[0]?.message?.content ?? null));
if (chat.status !== 200) { console.error('FAIL: multi-part chat round-trip'); process.exit(1); }
// ── The collision, asserted as UNRESOLVABLE rather than as a winner ─────────
// A flat file and a folder of the same name are one id. The app's rule is
// "never create the pair", and the reason has to stay accurate: an earlier
// version of this probe recorded "the flat file wins", which is FALSE and would
// have invited §E4's move-into-a-folder to assume the half-built folder is
// harmless while the flat file is still there. What is actually true is that
// exactly ONE of the two is served and we cannot say which — so assert the
// count, not the winner, and DELETE the pair before leaving.
const collDir = path.join(cacheDir, '_collision');
fs.rmSync(collDir, { recursive: true, force: true });
fs.mkdirSync(path.join(collDir, 'COLL-Q4_K_M'), { recursive: true });
fs.linkSync(dest, path.join(collDir, 'COLL-Q4_K_M', 'COLL-Q4_K_M.gguf'));
fs.linkSync(dest, path.join(collDir, 'COLL-Q4_K_M.gguf'));
const collPort = PORT + 1;
const collChild = spawn(binary, ['--host', '127.0.0.1', '--port', String(collPort), '--no-webui', '--jinja',
  '--models-dir', collDir, '--models-max', '4', '-c', '4096'],
  { env: { ...process.env, LLAMA_CACHE: collDir }, stdio: ['ignore', 'inherit', 'inherit'] });
const collDeadline = Date.now() + 30_000;
while (Date.now() < collDeadline) {
  try { if ((await fetch(`http://127.0.0.1:${collPort}/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
const collModels = await (await fetch(`http://127.0.0.1:${collPort}/models`)).json();
const collRows = (collModels.data ?? []).filter((m) => (m.id ?? m.name) === 'COLL-Q4_K_M');
const servedFrom = collRows.map((m) => {
  const a = m.status?.args ?? [];
  return a[a.indexOf('--model') + 1].includes(`${path.sep}COLL-Q4_K_M${path.sep}`) ? 'folder' : 'flat';
});
collChild.kill();
fs.rmSync(collDir, { recursive: true, force: true });
console.log(`collision: ${collRows.length} row(s) for 'COLL-Q4_K_M', served from ${JSON.stringify(servedFrom)}`);
if (collRows.length !== 1) {
  console.error(`FAIL: a flat file and a folder of the same name produced ${collRows.length} rows, not 1 — the id collision this build resolves silently now behaves differently; re-read the collision note in engine-dependencies.md before changing ModelDownloader.start`);
  process.exit(1);
}
console.log(`  (which of the two is served is NOT predictable — do not write down a winner)`);

console.log(`PASS: single-file ('${expectedSingleId}') and multi-part ('${expectedSplitId}') GGUFs are served under their FILENAME ids, foldered ones ('${FOLDER_ID}', '${dirSplitId}') under their FOLDER ids, and a flat/folder name collision collapses to exactly one unpredictable row`);
