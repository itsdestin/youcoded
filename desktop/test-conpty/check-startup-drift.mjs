#!/usr/bin/env node
// check-startup-drift.mjs — has Claude Code changed the dialogs it shows before
// a session starts? Captures them fresh (capture-startup-dialogs.mjs, same
// isolated temp home) and compares each one, structurally, with the saved
// fixtures in tests/fixtures/startup-dialogs/: heading, option labels, how an
// option is picked (numbers / arrows / checkboxes), where the cursor starts,
// the footer — and whether answering still does what the label says.
//
// WHY: every time Claude Code reshaped one of these dialogs (the 2.1.2xx trust
// rewrite, 2.1.281 dropping the option numbers) new YouCoded sessions sat on
// "Initializing session…" until a user noticed. This names the change the day
// it ships instead.
//
// COST: free. No scenario sends a message. Signed-out scenarios only unless
// --with-auth (which copies the access token only, like the plan capture).
//
// Usage (from youcoded/desktop):
//   node test-conpty/check-startup-drift.mjs                 # the `claude` on PATH
//   node test-conpty/check-startup-drift.mjs --latest        # npm's latest @anthropic-ai/claude-code
//     [--claude /path/to/claude] [--with-auth] [--only a,b]
//     [--app]    also replay the fresh captures through the app's own parser
//                (vitest tests/startup-dialogs.test.ts) — "does the app still cope?"
//     [--save]   replace the saved fixtures with the fresh ones (after a real update)
// Exit 1 = something the app depends on changed (or a capture/replay failed);
// the report says what. A body-wording change alone is reported but exits 0.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveClaude, ccVersionOf, removeTempTree } from './cc-capture-lib.mjs';
import { runScenario, selectScenarios } from './capture-startup-dialogs.mjs';
import { diffSummaries } from './startup-dialog-shape.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const SAVED_DIR = path.join(desktop, 'tests', 'fixtures', 'startup-dialogs');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const get = (f) => { const i = argv.indexOf(`--${f}`); return i < 0 ? undefined : argv[i + 1]; };

/** npm's latest Claude Code, installed into a temp dir (postinstall run explicitly:
 *  npm 11+ blocks install scripts by default). Returns the binary path. */
function installLatest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-latest-'));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefix', dir, '@anthropic-ai/claude-code@latest'], { stdio: 'inherit' });
  const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
  const bin = path.join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'claude.cmd' : 'claude');
  try { execFileSync(bin, ['--version'], { stdio: 'ignore' }); } catch {
    execFileSync(process.execPath, [path.join(pkg, 'install.cjs')], { stdio: 'inherit' });
  }
  return { bin, dir };
}

/** The saved fixture per scenario key (newest Claude Code version if several). */
function loadSaved() {
  const byKey = new Map();
  for (const f of fs.readdirSync(SAVED_DIR).filter((x) => x.endsWith('.json')).sort()) {
    const fx = JSON.parse(fs.readFileSync(path.join(SAVED_DIR, f), 'utf8'));
    byKey.set(fx.key, { file: f, fx });
  }
  return byKey;
}

/** What answering did, in the terms the app's buttons promise. */
function effect(fx) {
  const o = fx.outcome || {};
  return {
    reachedMainPrompt: !!o.reachedMainPrompt,
    folderTrusted: !!o.folderTrusted,
    bypassAccepted: !!o.bypassAccepted,
    exited: o.exitCode !== null && o.exitCode !== undefined,
    digitIgnored: (o.steps || []).find((s) => 'stayed' in s)?.stayed ?? null,
  };
}

const EFFECT_WORDS = {
  reachedMainPrompt: 'the session reaching its input box',
  folderTrusted: 'the folder being remembered as trusted',
  bypassAccepted: 'bypass mode being remembered as accepted',
  exited: 'Claude Code exiting',
  digitIgnored: 'a typed digit being ignored',
};

async function main() {
  let claudeBin;
  let tempInstall = null;
  if (has('latest')) { tempInstall = installLatest(); claudeBin = tempInstall.bin; } else claudeBin = resolveClaude(get('claude'));
  const ccVersion = ccVersionOf(claudeBin);
  const scenarios = selectScenarios({ only: get('only')?.split(','), noAuth: !has('with-auth') });
  const saved = loadSaved();
  const savedVersions = [...new Set([...saved.values()].map((s) => s.fx.ccVersion))].join(', ');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-drift-'));

  const lines = [];
  const say = (s = '') => { lines.push(s); console.log(s); };
  say(`Claude Code startup-dialog drift check: ${ccVersion} (fresh) vs ${savedVersions} (saved)`);
  say('');

  let breaking = 0;
  let failed = 0;
  for (const s of scenarios) {
    const fx = await runScenario(s, { claudeBin, ccVersion });
    fs.writeFileSync(path.join(outDir, `cc-${ccVersion}-${fx.key}.json`), JSON.stringify(fx, null, 1));
    const base = saved.get(fx.key);
    const problems = [];
    const notes = [];
    if (fx.outcome.error) problems.push(`capture failed: ${fx.outcome.error}`);
    if (!base) {
      notes.push('no saved capture to compare with (new scenario)');
    } else {
      const n = Math.max(base.fx.dialogs.length, fx.dialogs.length);
      for (let i = 0; i < n; i++) {
        const d = diffSummaries(`dialog ${i + 1}`, base.fx.dialogs[i] ?? { present: false }, fx.dialogs[i] ?? { present: false });
        problems.push(...d.breaking);
        notes.push(...d.notes);
      }
      const was = effect(base.fx);
      const now = effect(fx);
      for (const k of Object.keys(was)) {
        if (was[k] !== now[k]) problems.push(`answering changed: ${EFFECT_WORDS[k]} was ${was[k]}, now ${now[k]}`);
      }
    }
    if (fx.outcome.error) failed++;
    else if (problems.length) breaking++;
    say(`${problems.length ? 'CHANGED  ' : 'same     '} ${fx.key}`);
    for (const p of problems) say(`    ! ${p}`);
    for (const p of notes) say(`    - ${p}`);
  }

  let appOk = true;
  if (has('app')) {
    say('');
    say('Replaying the fresh captures through the app\'s own parser (tests/startup-dialogs.test.ts)…');
    const r = spawnSync('npx', ['vitest', 'run', 'tests/startup-dialogs.test.ts'], {
      cwd: desktop, stdio: 'inherit', env: { ...process.env, STARTUP_FIXTURE_DIR: outDir }, shell: process.platform === 'win32',
    });
    appOk = r.status === 0;
    say(appOk ? 'The app reads every fresh dialog correctly.' : 'The app does NOT read the fresh dialogs correctly — see the test output above.');
  }

  if (has('save')) {
    for (const [, b] of saved) fs.rmSync(path.join(SAVED_DIR, b.file));
    for (const f of fs.readdirSync(outDir)) fs.copyFileSync(path.join(outDir, f), path.join(SAVED_DIR, f));
    say('');
    say(`Saved ${fs.readdirSync(outDir).length} fresh captures to tests/fixtures/startup-dialogs/. Next: UPDATE_ANDROID_STARTUP_SCREENS=1 npx vitest run tests/startup-dialogs.test.ts`);
  }

  say('');
  const verdict = failed || breaking || !appOk
    ? `ATTENTION: ${breaking} scenario(s) changed in a way the app depends on, ${failed} capture(s) failed${appOk ? '' : ', and the app\'s parser no longer reads them'}. See above.`
    : 'No change the app depends on.';
  say(verdict);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + lines.join('\n') + '\n```\n');
  }
  // WHY removeTempTree: a cleanup failure must not decide the verdict — see its comment.
  await removeTempTree(outDir);
  if (tempInstall) await removeTempTree(tempInstall.dir);
  process.exit(failed || breaking || !appOk ? 1 : 0);
}

await main();
