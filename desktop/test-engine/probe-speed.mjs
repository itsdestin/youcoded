#!/usr/bin/env node
// Probe: the two SPEED flags in engine-supervisor's spawn shape actually reach a
// router-spawned model child and actually fire (2026-09-04).
//
//   --spec-default      draft-free (n-gram) speculative decoding
//   --cache-type-k q8_0 8-bit KEY cache (V stays f16 on purpose — a quantized V
//                       cache is a fatal load error when flash attention is off)
//
// The router forwards its own CLI args to each per-model child it spawns; nothing
// in our unit tests can see that (they mock spawn), and a build that silently
// stopped forwarding either flag would look exactly like "local models are slow"
// — which is how the flags were found missing in the first place. So this probe:
//   1. spawns the router with the EXACT supervisor arg list;
//   2. sends the rewrite-style task the speedup was measured on (the reply echoes
//      the prompt, which is what n-gram drafting predicts);
//   3. asserts the final `timings` frame reports drafted tokens with a >50%
//      acceptance rate — the drafter fired and mostly guessed right;
//   4. on Linux, asserts the model child's cmdline carries both flags.
// Usage: node test-engine/probe-speed.mjs --binary <llama-server>
// Re-run on EVERY engine bump (with probe-{health,models,chat,tools,download}).
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const argv = process.argv.slice(2);
const binary = argv[argv.indexOf('--binary') + 1];
if (!binary || binary.startsWith('--')) { console.error('usage: probe-speed.mjs --binary <llama-server>'); process.exit(1); }
const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, 'cache');
const PORT = 9976;

const gguf = fs.readdirSync(cacheDir).find((f) => f.endsWith('.gguf'));
if (!gguf) { console.error('FAIL: put a small .gguf in test-engine/cache/ first'); process.exit(1); }
const modelId = gguf.replace(/\.gguf$/i, '');

// MUST mirror engine-supervisor.ts's spawn list (only host/port/dir differ).
const ARGS = [
  '--host', '127.0.0.1', '--port', String(PORT), '--no-webui', '--jinja',
  '--models-dir', cacheDir, '--models-max', '2', '--sleep-idle-seconds', '900', '-c', '8192',
  '--spec-default', '--cache-type-k', 'q8_0',
];
const child = spawn(binary, ARGS, { env: { ...process.env, LLAMA_CACHE: cacheDir }, stdio: ['ignore', 'ignore', 'inherit'] });
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

// The task: reproduce a text with one change. ~60 lines of this very file is a
// convenient, licence-free, deterministic source.
const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 40).join('\n');
const prompt = `Here is a file:\n\n\`\`\`js\n${source}\n\`\`\`\n\nRewrite the ENTIRE file verbatim, changing only the number 9976 to 9977. Output only the code, no commentary.`;

const post = (body) => fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
// Warm-up: loads the model (auto-load) so the timed request measures generation, not the load.
await post({ model: modelId, messages: [{ role: 'user', content: 'Say hi.' }], max_tokens: 4, chat_template_kwargs: { enable_thinking: false } });

const res = await post({
  model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: 700, temperature: 0,
  chat_template_kwargs: { enable_thinking: false }, // a thinking preamble is novel prose; we want the echo
});
const obj = await res.json();
const t = obj.timings ?? {};
console.log('HTTP', res.status, 'timings:', JSON.stringify(t));

let ok = res.status === 200;
if (typeof t.draft_n !== 'number' || t.draft_n <= 0) { console.error('FAIL: no drafted tokens — --spec-default did not reach the model child (or the build dropped n-gram drafting)'); ok = false; }
else if ((t.draft_n_accepted ?? 0) / t.draft_n < 0.5) { console.error(`FAIL: drafter fired but acceptance ${(t.draft_n_accepted / t.draft_n).toFixed(2)} < 0.5 on an echo task`); ok = false; }
else console.log(`OK: drafted ${t.draft_n}, accepted ${t.draft_n_accepted} (${(100 * t.draft_n_accepted / t.draft_n).toFixed(0)}%), ${t.predicted_per_second?.toFixed(1)} tok/s`);

// Linux only: prove the flags are on the CHILD's command line, not just the router's.
if (process.platform === 'linux') {
  const needle = `${path.sep}${gguf}`;
  let found = null;
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (cmd.includes('--model') && cmd.some((a) => a.endsWith(needle))) { found = cmd; break; }
    } catch { /* raced with exit */ }
  }
  if (!found) { console.error('FAIL: could not find the model child process'); ok = false; }
  else {
    const hasSpec = found.includes('--spec-default');
    const kIdx = found.indexOf('--cache-type-k');
    const hasK = kIdx >= 0 && found[kIdx + 1] === 'q8_0';
    console.log(`child cmdline: spec-default=${hasSpec} cache-type-k=q8_0:${hasK}`);
    if (!hasSpec || !hasK) { console.error('FAIL: the router did not forward a speed flag to the model child'); ok = false; }
  }
}

child.kill();
if (!ok) process.exit(1);
console.log('PASS: probe-speed');
