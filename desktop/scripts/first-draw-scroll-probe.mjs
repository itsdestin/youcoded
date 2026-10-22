#!/usr/bin/env node
// first-draw-scroll-probe — prints the numbers behind the "first-draw-stability" journey
// (desktop/tests/journeys/first-draw-stability.json, which runs in scripts/verify.sh and FAILS on a jump).
// Use this when you want the figures, against a running UI Workbench, with a longer conversation:
//
//   bash scripts/run-workbench.sh <worktree>          # note the port it prints
//   node desktop/scripts/first-draw-scroll-probe.mjs http://127.0.0.1:<port> [--turns 60]
//
// It evaluates the SAME in-page script as the journey (tests/journeys/first-draw-stability.check.js) through
// scripts/ui-probe.mjs. Exit 1 when a bound fails.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const base = args.find((a) => /^https?:/.test(a));
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
if (!base) { console.error('usage: first-draw-scroll-probe.mjs http://127.0.0.1:<workbench port> [--turns 60]'); process.exit(2); }
const turns = Number(flag('--turns', 60));
const probe = flag('--probe', resolve(here, '../../../scripts/ui-probe.mjs'));
const script = readFileSync(resolve(here, '../tests/journeys/first-draw-stability.check.js'), 'utf8');

// The dev workbench frames the app in an <iframe>, so the journey's script (written for the app itself) is given the
// frame's document in place of `document`.
const framed = `(() => { const document = window.document.querySelector('iframe').contentDocument; return ${script}; })()`;
const run = spawnSync('node', [probe, `${base}/?mode=workbench&seed=long-${turns}&latency=0&scenario=default`, '--size', '1440x900',
  '--wait', "!!document.querySelector('iframe')?.contentDocument?.querySelector('[data-session-strip] [data-session-id=\"wb-2\"]')",
  '--eval', framed, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (run.status !== 0) { console.error(run.stdout, run.stderr); process.exit(1); }
const ev = JSON.parse(run.stdout).results?.[0]?.evals?.[0];
if (!ev || ev.error) { console.error(ev?.error ?? 'no answer'); process.exit(1); }
const { ok, why, report } = ev.value;
console.log(Object.entries(report ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'));
console.log(ok ? 'OK: no jump, no blank spacer in view' : `FAILED: ${why}`);
process.exit(ok ? 0 : 1);
