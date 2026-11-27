#!/usr/bin/env node
// conformance-run.mjs <builtBackendDir> — runs conformance.json against a BUILT iPhone backend, on the build machine.
//   Each case runs the way the app runs a command: its own worker thread, built-in shell, a fresh environment.
//   Run it with Node 18 and `--jitless` (the phone's engine minus its missing ICU) to see what the phone will see:
//     NODE18_BIN=/path/to/node18 node ios/runtime/shell/conformance-run.mjs <dir>    (it re-runs itself that way)
// Prints `SHELL_CONFORMANCE PASS n/n`, or `FAIL <command>: <reason>` lines and exit 1. Home is a symlinked folder,
// the way an iPhone reaches Documents (/var -> /private/var).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { seedFixture, judge } from './conformance-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const built = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !fs.existsSync(path.join(built, 'dist/ios-shell/worker.js'))) {
  console.error('usage: conformance-run.mjs <built backend dir>   (from ios/runtime/build-backend.mjs)');
  process.exit(2);
}
if (process.env.NODE18_BIN && !process.env.YC_CONF_CHILD) {
  const r = spawnSync(process.env.NODE18_BIN, ['--jitless', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, YC_CONF_CHILD: '1' } });
  process.exit(r.status ?? 1);
}

const list = JSON.parse(fs.readFileSync(path.join(HERE, 'conformance.json'), 'utf8'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-conf-'));
fs.mkdirSync(path.join(root, 'private/var/mobile/Documents'), { recursive: true });
fs.mkdirSync(path.join(root, 'private/var/mobile/tmp'), { recursive: true });
fs.symlinkSync('private/var', path.join(root, 'var'));
const home = path.join(root, 'var/mobile/Documents');
const tmp = path.join(root, 'var/mobile/tmp');
const work = path.join(home, 'work');
seedFixture(work);

/** One command in its own worker, as the app does it. */
function run(script, cwd = work, tokens = {}) {
  return new Promise((resolve) => {
    const w = new Worker(path.join(built, 'dist/ios-shell/worker.js'), { workerData: { script, cwd, home, tmp, tokens } });
    const done = (r) => { void w.terminate(); resolve(r); };
    w.once('message', done);
    w.once('error', (e) => done({ stdout: '', stderr: String(e), exitCode: 99 }));
  });
}

let passed = 0;
const failures = [];
for (const c of list) {
  const r = await run(c.cmd);
  const why = judge(c, r);
  if (why) failures.push(`FAIL ${c.cmd}: ${why}`); else passed++;
}
fs.rmSync(root, { recursive: true, force: true });
for (const f of failures) console.log(f);
console.log(`SHELL_CONFORMANCE ${failures.length ? 'FAIL' : 'PASS'} ${passed}/${list.length}`);
process.exit(failures.length ? 1 : 0);
