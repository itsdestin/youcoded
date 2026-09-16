#!/usr/bin/env node
// Probe: the router's per-model settings file (`--models-preset`, design §C2)
// behaves the way model-presets.ts assumes it does. Re-run on EVERY engine bump —
// this file is the only thing standing between a typo in Advanced settings and an
// engine that will not start.
//
// It proves five things against the pinned binary:
//   1. the `[*]` global section reaches a model (its `sleep-idle-seconds` lands on
//      the model's child command line);
//   2. a per-model section OVERRIDES the global for one key and INHERITS the rest;
//   3. a model that has a section reports `source: "preset"` in GET /models;
//   4. an unrecognised key ANYWHERE in the file is fatal — exit 1, no server, with
//      the message model-presets.ts shows the user verbatim;
//   5. every key on the reserved denylist is a REAL llama-server option, so the
//      denylist is refusing things that exist rather than phantoms.
//
// Cheap on purpose: GET /models renders each model's full child argument list
// WITHOUT loading it, so nothing here reads a gigabyte of weights.
//
// Usage: node test-engine/probe-presets.mjs --binary <llama-server>
//        (put a small .gguf — or a symlink to one — in test-engine/cache/ first)
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import net from 'net';
import { fileURLToPath } from 'url';

const argv = process.argv.slice(2);
const binary = argv[argv.indexOf('--binary') + 1];
if (!binary || binary.startsWith('--')) {
  console.error('usage: probe-presets.mjs --binary <llama-server>');
  process.exit(1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, 'cache');
const gguf = fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).find((f) => f.endsWith('.gguf'));
if (!gguf) { console.error('FAIL: put a small .gguf in test-engine/cache/ first'); process.exit(1); }
const modelId = gguf.replace(/\.gguf$/i, '');

// Mirrors model-presets.ts's RESERVED list. Kept as a LITERAL, not an import, so
// a key that is renamed or mistyped there fails here rather than agreeing with
// itself — and so this probe proves every one of them is a real option on the
// pinned build. A phantom entry would refuse the user a flag that never existed
// and, worse, would mean the real option's name moved and is no longer covered.
const RESERVED_KEYS = [
  'ctx-size', 'n-gpu-layers', 'sleep-idle-seconds', 'host', 'port', 'model', 'models-dir',
  'models-preset', 'models-max', 'mmproj', 'alias', 'cache-type-k', 'cache-type-v',
  'hf-repo', 'hf-file', 'hf-token',
  'hf-repo-draft', 'model-url', 'docker-repo', 'mmproj-url', 'embd-gemma-default',
  'fim-qwen-1.5b-default', 'fim-qwen-3b-default', 'fim-qwen-7b-default', 'fim-qwen-7b-spec',
  'fim-qwen-14b-spec', 'fim-qwen-30b-default', 'gpt-oss-20b-default', 'gpt-oss-120b-default',
  'vision-gemma-4b-default', 'vision-gemma-12b-default', 'rpc', 'log-file', 'log-prompts-dir',
  'slot-save-path', 'lookup-cache-dynamic', 'tools', 'tools-runtime', 'agent',
  'mcp-servers-config', 'mcp-servers-json', 'video-ffmpeg-dir', 'media-path', 'path',
  'ui-mcp-proxy', 'api-key-file', 'api-prefix',
];

let ok = true;
const fail = (msg) => { console.error(`FAIL: ${msg}`); ok = false; };
const pass = (msg) => console.log(`ok: ${msg}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-presets-'));
const emptyDir = path.join(tmp, 'empty');
fs.mkdirSync(emptyDir);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Run the engine against one preset file. Resolves once it is either listening
 *  (then it is killed) or dead. Never waits on a fixed sleep. */
function runEngine(iniPath, modelsDir) {
  return new Promise(async (resolve) => {
    const port = await freePort();
    const child = spawn(binary, [
      '--host', '127.0.0.1', '--port', String(port), '--no-webui',
      '--models-dir', modelsDir, '--models-preset', iniPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve({ ...result, stderr, port, child }); } };
    const timer = setTimeout(() => { child.kill(); finish({ listening: false, code: null }); }, 30_000);
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.includes('listening on')) { clearTimeout(timer); finish({ listening: true, code: null }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); finish({ listening: false, code }); });
  });
}

// --- 1-3: the global block, the per-model override, and `source: preset` ------
{
  const ini = path.join(tmp, 'models.ini');
  fs.writeFileSync(ini, [
    '[*]', 'ctx-size = 4096', 'sleep-idle-seconds = 77', '',
    `[${modelId}]`, 'ctx-size = 2048', '',
  ].join('\n'));

  const run = await runEngine(ini, cacheDir);
  if (!run.listening) {
    fail(`the engine did not start with a valid preset (exit ${run.code})\n${run.stderr.split('\n').slice(-3).join('\n')}`);
  } else {
    const rows = (await (await fetch(`http://127.0.0.1:${run.port}/models`)).json()).data ?? [];
    run.child.kill();
    const row = rows.find((r) => r.id === modelId);
    if (!row) {
      fail(`GET /models did not list ${modelId}`);
    } else {
      const args = row.status?.args ?? [];
      const argOf = (name) => args[args.indexOf(name) + 1];
      // The child's rendered command line IS the merged preset — the global
      // reached it, and the model's own value beat the global's.
      if (argOf('--sleep-idle-seconds') !== '77') fail(`[*] sleep-idle-seconds did not reach the model child (args: ${args.join(' ')})`);
      else pass('[*] is honoured — its sleep-idle-seconds reached the model child');
      if (argOf('--ctx-size') !== '2048') fail(`a per-model ctx-size did not beat the global (got ${argOf('--ctx-size')})`);
      else pass('a per-model section overrides [*] for one key and inherits the rest');
      if (row.source !== 'preset') fail(`a sectioned model reported source '${row.source}', expected 'preset'`);
      else pass("a sectioned model reports source: 'preset'");
    }
  }
}

// --- 4: an unrecognised key is FATAL, wherever it sits -----------------------
for (const [where, body] of [
  ['a per-model section', [`[${modelId}]`, 'not-a-real-flag = 7', '']],
  ['the [*] section', ['[*]', 'not-a-real-flag = 7', '']],
]) {
  const ini = path.join(tmp, 'bad.ini');
  fs.writeFileSync(ini, body.join('\n'));
  const run = await runEngine(ini, cacheDir);
  if (run.listening) {
    run.child.kill();
    fail(`an unrecognised key in ${where} did NOT stop the engine — the save-time check in model-presets.ts is now the only thing between a typo and a broken engine, and this probe can no longer prove it is needed`);
  } else if (run.code === 0) {
    fail(`an unrecognised key in ${where} exited 0`);
  } else if (!/not recognized in preset/.test(run.stderr)) {
    fail(`an unrecognised key in ${where} exited ${run.code}, but not with the message model-presets.ts quotes:\n${run.stderr.split('\n').slice(-3).join('\n')}`);
  } else {
    pass(`an unrecognised key in ${where} is fatal (exit ${run.code}) — "${/(option '.*?' not recognized in preset '.*?')/.exec(run.stderr)?.[1]}"`);
  }
}

// --- 5: every reserved key is a real option ---------------------------------
{
  // A denylist entry that is NOT a real llama-server option would refuse the user
  // a flag that never existed, and — worse — would mean the real option's name
  // has changed under us and is no longer protected at all.
  const ini = path.join(tmp, 'reserved.ini');
  fs.writeFileSync(ini, ['[probe]', ...RESERVED_KEYS.map((k) => `${k} = 1`), ''].join('\n'));
  const run = await runEngine(ini, emptyDir);
  if (!run.listening && /not recognized in preset/.test(run.stderr)) {
    fail(`a reserved key is not a real option on this build: ${/option '(.*?)' not recognized/.exec(run.stderr)?.[1]}`);
  } else {
    if (run.child) run.child.kill();
    pass(`all ${RESERVED_KEYS.length} reserved keys are real options on this build`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
if (!ok) process.exit(1);
console.log('PASS: probe-presets');
