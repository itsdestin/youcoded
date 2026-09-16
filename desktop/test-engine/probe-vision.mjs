#!/usr/bin/env node
// Probe: the vision folder layout (design §E2). A model that ships an
// `mmproj-*.gguf` is downloaded into a FOLDER of its own —
// `<cacheDir>/<id>/<id>.gguf` + `<cacheDir>/<id>/mmproj-*.gguf` — because that
// is the ONLY layout in which llama-server pairs the two. This asserts the two
// things the app then depends on:
//   1. GET /models lists the folder's model with input_modalities including
//      'image' (i.e. the child really is spawned with --mmproj), and
//   2. it answers an actual image round-trip.
// Downloads a REAL tiny vision model (SmolVLM-256M, ~0.4GB for both files) once
// into test-engine/cache/, then boots the pinned llama-server against it.
// Re-run on engine pin bumps: if a bump breaks the pairing, every vision model
// in the app silently becomes text-only with no error anywhere.
// usage: node probe-vision.mjs --binary <llama-server> [--port 9975]
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const argv = process.argv.slice(2);
const binary = argv[argv.indexOf('--binary') + 1];
if (!binary) { console.error('usage: probe-vision.mjs --binary <llama-server> [--port N]'); process.exit(1); }
const PORT = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : 9975;
const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, 'cache');

const REPO = 'ggml-org/SmolVLM-256M-Instruct-GGUF';
const MODEL_FILE = 'SmolVLM-256M-Instruct-Q8_0.gguf';
// The projector our own findVisionFile() would pick out of this repo: the
// preference order is mmproj-F16, then BF16, then the first mmproj file, and
// this repo publishes an f16 and a Q8_0 one.
const MMPROJ_FILE = 'mmproj-SmolVLM-256M-Instruct-f16.gguf';
// The folder IS the model id — llama-server names a model in a subdirectory
// after the folder, not after the file inside it. cache-scan.ts relies on that.
const MODEL_ID = MODEL_FILE.replace(/\.gguf$/i, '');
const folder = path.join(cacheDir, MODEL_ID);
fs.mkdirSync(folder, { recursive: true });

for (const file of [MODEL_FILE, MMPROJ_FILE]) {
  const dest = path.join(folder, file);
  if (fs.existsSync(dest)) continue;
  console.log(`downloading ${REPO}/${file} (one-time)…`);
  const res = await fetch(`https://huggingface.co/${REPO}/resolve/main/${file}`);
  if (!res.ok) { console.error(`FAIL: HF download HTTP ${res.status}`); process.exit(1); }
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// The spawn MUST mirror engine-supervisor.ts — crucially `--models-dir`, which
// is what discovers the folder. See probe-download.mjs for why LLAMA_CACHE is
// not the flag that matters.
const child = spawn(binary, ['--host', '127.0.0.1', '--port', String(PORT), '--no-webui', '--jinja',
  '--models-dir', cacheDir, '--models-max', '2', '-c', '4096'],
  { env: { ...process.env, LLAMA_CACHE: cacheDir }, stdio: ['ignore', 'inherit', 'inherit'] });
const fail = (msg) => { child.kill(); console.error(`FAIL: ${msg}`); process.exit(1); };
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const models = await (await fetch(`http://127.0.0.1:${PORT}/models`)).json();
const row = (models.data ?? []).find((m) => (m.id ?? m.name) === MODEL_ID);
console.log('router ids:', (models.data ?? []).map((m) => m.id ?? m.name));
if (!row) fail(`router does not serve '${MODEL_ID}' — the folder layout drifted; fix cache-scan/model-downloader together`);
const modalities = row.architecture?.input_modalities ?? [];
console.log('input_modalities:', modalities, '| --mmproj passed:', (row.status?.args ?? []).includes('--mmproj'));
if (!modalities.includes('image')) {
  fail(`'${MODEL_ID}' reports input_modalities ${JSON.stringify(modalities)} — the projector beside it was NOT paired, so every vision model in the app is silently text-only`);
}

// A 64x64 solid red PNG, inline so the probe needs no fixture file.
const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsEty/UMZxgi+hcEK'
  + 'LNO+FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywLPLIEA68ZURwAAAABJRU5ErkJggg==';
const chat = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: MODEL_ID, max_tokens: 24, temperature: 0,
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PNG}` } },
      { type: 'text', text: 'What color is this image? Answer with one word.' },
    ] }],
  }),
});
const out = await chat.json();
const reply = out.choices?.[0]?.message?.content ?? '';
child.kill();
console.log('image reply:', JSON.stringify(reply));
if (chat.status !== 200) fail(`image round-trip returned HTTP ${chat.status}: ${JSON.stringify(out).slice(0, 300)}`);
// The point of the round-trip is that the PIXELS reached the model — listing
// 'image' only proves the flag was passed. A model that saw nothing answers
// with something other than the colour it was shown.
if (!/red/i.test(reply)) fail(`the model was shown a solid red image and answered ${JSON.stringify(reply)} — the projector is loaded but the pixels are not reaching it`);
console.log(`PASS: '${MODEL_ID}' is served from its folder, reports image input, and answered the image`);
