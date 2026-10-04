#!/usr/bin/env node
// check-popup-drift.mjs — does the app still tell, on a new Claude Code
// release, when a pop-up holds the keyboard and when the message box is live?
//
// WHY: the app refuses a chat send (and holds back its lost-message Enter)
// whenever something other than Claude Code's message box has the keyboard —
// read from the SHAPE of the screen (src/renderer/parser/cc-input-focus.ts),
// so new pop-ups need no code change. What CAN break it is Claude Code
// redrawing that shape: a restyled message box would make every screen look
// like a pop-up (every send refused), a new mode that keeps a box but steals
// the keyboard (like the agents view) would slip through. This names either
// the day the release ships instead of when a user gets stuck.
//
// It re-records every free scenario in popup-scenarios.mjs (classic and
// fullscreen renderer, YouCoded's status line; busy states from the local
// stand-in API — no account, no cost) against the chosen Claude Code, then:
//   1. a scenario that no longer reaches its expected screen is reported —
//      Claude Code changed how it behaves there;
//   2. the fresh captures are scored by the app's own detector
//      (tests/popup-detector-bench.test.ts) — any miss or false alarm fails;
//   3. they are replayed through the app's prompt detector with simulated
//      hook timing (tests/popup-corpus-replay.test.tsx) — cards must not
//      duplicate hook cards or appear with no pop-up;
//   4. the release's dialog titles are listed against the saved inventory —
//      NEW titles are reported (not a failure: the detector does not need
//      names), so a person can look at what Claude Code started asking.
//
// Usage (from youcoded/desktop):
//   node test-conpty/check-popup-drift.mjs                  # the `claude` on PATH
//   node test-conpty/check-popup-drift.mjs --latest         # npm's latest @anthropic-ai/claude-code
//     [--claude /path/to/claude] [--only a,b] [--jobs 4]
//     [--save]   after a reviewed update: replace the saved captures (free
//                scenarios only — real-model ones keep their old capture) and
//                the saved title inventory with the fresh ones
// Exit 1 = something the app depends on changed (or a capture failed).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveClaude, ccVersionOf, removeTempTree, installLatest } from './cc-capture-lib.mjs';
import { runScenario } from './capture-popup-corpus.mjs';
import { SCENARIOS } from './popup-scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const SAVED_DIR = path.join(desktop, 'tests', 'fixtures', 'popup-corpus');
const TITLES_FILE = path.join(here, 'snapshots', 'cc-dialog-titles.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const get = (f) => { const i = argv.indexOf(`--${f}`); return i < 0 ? undefined : argv[i + 1]; };

/**
 * The file that holds Claude Code's program text: the native binary `claude`
 * resolves to, or (for an npm install whose `claude` is a small launcher) the
 * largest file in its package.
 */
function programFile(claudeBin) {
  const real = fs.realpathSync(claudeBin);
  if (fs.statSync(real).size > 5_000_000) return real;
  let best = null;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) { const sz = fs.statSync(p).size; if (sz > 5_000_000 && (!best || sz > best.sz)) best = { p, sz }; }
    }
  };
  let root = path.dirname(real);
  while (root !== path.dirname(root) && !fs.existsSync(path.join(root, 'package.json'))) root = path.dirname(root);
  walk(root, 0);
  return best?.p ?? null;
}

/**
 * Dialog titles in Claude Code's program text — every `title:"…"` a
 * component is given. Heuristic (it reads minified code), so it only feeds a
 * "new titles" NOTE, never the verdict.
 */
export function dialogTitles(file) {
  if (!file) return [];
  const text = fs.readFileSync(file).toString('latin1');
  const out = new Set();
  for (const m of text.matchAll(/title:"((?:[^"\\\n]|\\.){4,100})"/g)) {
    const t = m[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, '$1');
    if (/[A-Za-z]{3,}/.test(t) && /\s|\?/.test(t)) out.add(t);
  }
  return [...out].sort();
}

async function capture(scenarios, { claudeBin, ccVersion, outDir, jobs }) {
  const results = [];
  const queue = [...scenarios];
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const fx = await runScenario(s, { claudeBin, ccVersion });
      fs.writeFileSync(path.join(outDir, `${s.name}.json`), JSON.stringify(fx));
      results.push({ name: s.name, description: s.description, error: fx.outcome.error ?? null });
    }
  }));
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

function runVitest(files, env) {
  const r = spawnSync('npx', ['vitest', 'run', ...files], {
    cwd: desktop, encoding: 'utf8', env: { ...process.env, ...env }, shell: process.platform === 'win32',
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

async function main() {
  let claudeBin;
  let tempInstall = null;
  if (has('latest')) { tempInstall = installLatest(); claudeBin = tempInstall.bin; } else claudeBin = resolveClaude(get('claude'));
  const ccVersion = ccVersionOf(claudeBin);
  const only = get('only')?.split(',').map((x) => x.trim());
  // Free scenarios only: the real-model ones need a signed-in account.
  const scenarios = SCENARIOS.filter((s) => s.auth !== 'real' && (!only || only.includes(s.name)));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-drift-'));

  const lines = [];
  const say = (s = '') => { lines.push(s); console.log(s); };
  say(`Claude Code pop-up drift check: ${ccVersion}, ${scenarios.length} scenarios`);
  say('');

  // 1. Capture.
  const results = await capture(scenarios, { claudeBin, ccVersion, outDir, jobs: Number(get('jobs') ?? 4) });
  const failed = results.filter((r) => r.error);
  for (const r of failed) {
    say(`CHANGED   ${r.name} — ${r.description}`);
    say(`    ! Claude Code no longer reached the expected screen: ${r.error}`);
  }
  say(failed.length ? '' : `All ${results.length} scenarios reached their expected screens.`);

  // 2 + 3. Score the fresh captures with the app's own code. Only the ones
  // that captured cleanly (a failed one is already reported above).
  const scoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-drift-ok-'));
  for (const r of results) if (!r.error) fs.copyFileSync(path.join(outDir, `${r.name}.json`), path.join(scoreDir, `${r.name}.json`));
  const benchReport = path.join(outDir, 'bench-report.txt');
  // Nothing captured cleanly → nothing to score; that is the capture finding
  // above, not proof the app is wrong.
  const nothingToScore = fs.readdirSync(scoreDir).length === 0;
  const bench = nothingToScore ? { ok: true, out: '' }
    : runVitest(['tests/popup-detector-bench.test.ts'], { POPUP_CORPUS_DIR: scoreDir, POPUP_BENCH_REPORT: benchReport });
  say('');
  say(bench.ok ? 'The app\'s pop-up detector calls every moment of every fresh capture correctly.'
    : 'The app\'s pop-up detector gets fresh captures WRONG:');
  if (!bench.ok) {
    const report = fs.existsSync(benchReport) ? fs.readFileSync(benchReport, 'utf8') : bench.out;
    const shipped = report.split('\n').filter((l) => /^candidate|^shipped/.test(l) || /^ {3}(MISSED|GAP|FALSE)/.test(l));
    // The per-candidate detail block for `shipped` only.
    const block = report.split('\n— ').find((b) => b.startsWith('shipped'));
    for (const l of (block ? block.split('\n') : shipped).slice(0, 40)) say(`    ${l}`);
    say('    (a MISSED pop-up swallows chat sends; a FALSE alarm refuses sends for nothing)');
  }
  const replay = nothingToScore ? { ok: true, out: '' } : runVitest(['tests/popup-corpus-replay.test.tsx'], { POPUP_CORPUS_DIR: scoreDir });
  if (nothingToScore) say('(No capture succeeded, so nothing was scored.)');
  say(replay.ok ? 'Cards: none beside a permission card, none without a pop-up, every card dismissed.'
    : 'Cards misbehave on the fresh captures:');
  if (!replay.ok) for (const l of replay.out.split('\n').filter((x) => /^\s+\+\s+"|×/.test(x)).slice(0, 30)) say(`    ${l.trim()}`);

  // 4. Title inventory (a note, not a verdict).
  const titles = dialogTitles(programFile(claudeBin));
  const saved = fs.existsSync(TITLES_FILE) ? JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8')) : { ccVersion: null, titles: [] };
  const known = new Set(saved.titles);
  const added = titles.filter((t) => !known.has(t));
  const removed = saved.titles.filter((t) => !titles.includes(t));
  say('');
  if (!titles.length) say('- Could not read dialog titles from this Claude Code build (inventory skipped).');
  else if (!added.length && !removed.length) say(`- Dialog titles unchanged since ${saved.ccVersion} (${titles.length}).`);
  else {
    say(`- Dialog titles since ${saved.ccVersion}: ${added.length} new, ${removed.length} gone. New ones are handled by shape, but worth a look:`);
    for (const t of added.slice(0, 40)) say(`    + ${t}`);
    for (const t of removed.slice(0, 20)) say(`    - ${t}`);
  }

  if (has('save')) {
    for (const r of results) if (!r.error) fs.copyFileSync(path.join(outDir, `${r.name}.json`), path.join(SAVED_DIR, `${r.name}.json`));
    if (titles.length) fs.writeFileSync(TITLES_FILE, JSON.stringify({ ccVersion, titles }, null, 1) + '\n');
    say('');
    say(`Saved ${results.length - failed.length} fresh captures to tests/fixtures/popup-corpus/ and the title inventory.`);
  }

  // Two different findings, worded apart so the report never overstates:
  // the app's detector or cards got a fresh screen WRONG (users affected), or a
  // scenario no longer reached its screen (Claude Code reworded/reshaped it —
  // that situation went untested until the scenario is updated).
  const appWrong = !bench.ok || !replay.ok;
  const bad = failed.length || appWrong;
  say('');
  if (appWrong) {
    say(`ATTENTION: on Claude Code ${ccVersion} the app's pop-up handling gets fresh screens wrong — see above. Until fixed, users may have sends refused for nothing, or swallowed by a pop-up.`);
  }
  if (failed.length) {
    say(`ATTENTION: ${failed.length} scenario(s) no longer reach their expected screen on Claude Code ${ccVersion} — it changed those screens. ${appWrong ? '' : 'The app handled every screen it was shown, but '}those situations went untested: update the scenario's waitFor in test-conpty/popup-scenarios.mjs, then re-run.`);
  }
  if (!bad) say(`No change the app's pop-up handling depends on (Claude Code ${ccVersion}).`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + lines.join('\n') + '\n```\n');

  await removeTempTree(outDir);
  await removeTempTree(scoreDir);
  if (tempInstall) await removeTempTree(tempInstall.dir);
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
