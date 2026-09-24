#!/usr/bin/env node
// capture-startup-dialogs.mjs — record the REAL dialogs Claude Code shows
// before a session starts: folder trust, the bypass-permissions warning, the
// project MCP-server approval, and whatever comes next.
//
// WHY this exists: the app turns these terminal menus into buttons by reading
// the screen (src/renderer/parser/ink-select-parser.ts). Claude Code reshapes
// them between versions — 2.1.281 dropped the "1." / "2." numbers from the
// trust and bypass dialogs and put "No, exit" first — and every time it did,
// new sessions silently sat on "Initializing session…". The only trustworthy
// test input is the real bytes, so this probe drives the installed `claude`
// through a PTY for every situation in startup-scenarios.mjs and saves what it
// printed as fixtures the unit tests replay through a headless xterm (the same
// screen the app's parser reads). Same approach as capture-plan-menu.mjs, and
// the same isolation (cc-capture-lib.mjs).
//
// It also ANSWERS each dialog the way the app does — arrows one per write,
// checking the screen after each, then Enter as its own write — and records
// what Claude Code did (trusted the folder? exited?). So the fixtures double as
// proof that the app's way of answering really works on this version.
//
// COST: nothing. No scenario sends a message; signed-out scenarios make no
// network call that needs an account. The two `-signed-in` scenarios copy the
// access token only (never the refresh token) and still send no message.
//
// Usage (from youcoded/desktop):
//   node test-conpty/capture-startup-dialogs.mjs                 # every scenario
//   node test-conpty/capture-startup-dialogs.mjs --only untrusted,bypass-untrusted
//     [--claude /path/to/claude]   a specific build (default: `claude` on PATH)
//     [--no-auth]                  skip the signed-in scenarios
//     [--out tests/fixtures/startup-dialogs]
//     [--print]                    also print each dialog's screen
// Re-run after every Claude Code update, then `npx vitest run tests/startup-dialogs.test.ts`.
// check-startup-drift.mjs does both for you and names what changed.
//
// Output: <out>/cc-<version>-<scenario>-<cols>x<rows>.json
//   { ccVersion, scenario, key, folder, trusted, args, files, auth, cols, rows,
//     chunks: [{t, b64}], marks: [{t, label, chunkIndex, data?}],
//     dialogs: [<shapeSummary>], outcome }

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  resolveClaude, ccVersionOf, makeIsolatedRoot, isolatedEnv, copyAccessTokenOnly, sleep,
} from './cc-capture-lib.mjs';
import { readDialogShape, shapeSummary, normalizeVolatile } from './startup-dialog-shape.mjs';
import { SCENARIOS, DEFAULT_COLS, DEFAULT_ROWS, scenarioKey } from './startup-scenarios.mjs';

const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const DOWN = '\u001b[B';
const UP = '\u001b[A';
const T = { appear: 20000, stable: 700, react: 3000, gone: 8000, mainPrompt: 25000, exit: 8000 };

/** The terminal's visible rows (not scrollback), trailing spaces trimmed. */
function viewport(term) {
  const b = term.buffer.active;
  const out = [];
  for (let i = b.viewportY; i < b.viewportY + term.rows; i++) {
    const line = b.getLine(i);
    out.push(line ? line.translateToString(true) : '');
  }
  return out;
}

function sameDialog(a, b) {
  return a.present && b.present && a.heading === b.heading
    && JSON.stringify(a.options) === JSON.stringify(b.options);
}

/**
 * Run one scenario in a fresh isolated home and return its fixture object.
 * Never throws for a Claude Code misbehaviour — that goes in `outcome.error`,
 * because a changed Claude Code is exactly what the drift check wants to see.
 */
export async function runScenario(s, { claudeBin, ccVersion, print = false }) {
  const cols = s.cols ?? DEFAULT_COLS;
  const rows = s.rows ?? DEFAULT_ROWS;
  const iso = makeIsolatedRoot(`startup-${s.name}`);
  const cwd = s.folder === 'home' ? iso.home : iso.project;

  for (const [rel, content] of Object.entries(s.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), content);
  }
  if (s.folder === 'git') execFileSync('git', ['init', '-q'], { cwd });

  // Onboarding (theme picker, sign-in) is its own flow; these scenarios start
  // where a YouCoded user starts — past it.
  const claudeJson = { hasCompletedOnboarding: true, theme: 'dark' };
  if (s.trusted) claudeJson.projects = { [cwd.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true } };
  fs.writeFileSync(path.join(iso.configDir, '.claude.json'), JSON.stringify(claudeJson, null, 2));

  // A user-level SessionStart hook that only logs the time — answers "does the
  // app's 'first hook event = Claude Code is ready' signal arrive before or
  // after each dialog?" (the app's init gate depends on it).
  const hookLog = path.join(iso.root, 'session-start.log');
  const hookScript = path.join(iso.root, 'session-start-hook.js');
  fs.writeFileSync(hookScript, `require('fs').appendFileSync(${JSON.stringify(hookLog)}, Date.now() + '\\n');`);
  fs.writeFileSync(path.join(iso.configDir, 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node ${hookScript}` }] }] },
  }, null, 2));

  if (s.auth) copyAccessTokenOnly(iso.configDir);

  const env = { ...isolatedEnv(iso), DISABLE_AUTOUPDATER: '1' };
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  const t0 = Date.now();
  const chunks = [];
  const marks = [];
  const dialogs = [];
  const outcome = { steps: [] };
  const mark = (label, data) => {
    marks.push({ t: Date.now() - t0, label, chunkIndex: chunks.length, ...(data !== undefined ? { data } : {}) });
  };

  const child = pty.spawn(claudeBin, s.args ?? [], { name: 'xterm-256color', cols, rows, cwd, env });
  let exitCode = null;
  child.onData((d) => {
    chunks.push({ t: Date.now() - t0, b64: Buffer.from(d, 'utf8').toString('base64') });
    term.write(d);
  });
  child.onExit((e) => { exitCode = e.exitCode; });
  const send = (data) => { child.write(data); mark('send', data); };
  const shape = () => readDialogShape(viewport(term));

  async function waitUntil(ms, ok) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (ok()) return true;
      if (exitCode !== null) return ok();
      await sleep(80);
    }
    return false;
  }

  /** A dialog that has stopped redrawing (same heading, options AND cursor for T.stable). */
  async function waitStableDialog() {
    const end = Date.now() + T.appear;
    let key = null;
    let since = 0;
    while (Date.now() < end && exitCode === null) {
      const sh = shape();
      const k = sh.present ? JSON.stringify([sh.heading, sh.options, sh.cursorIndex, sh.kind]) : null;
      if (k && k === key) {
        if (Date.now() - since >= T.stable) return sh;
      } else {
        key = k;
        since = Date.now();
      }
      await sleep(80);
    }
    return null;
  }

  /** Arrows one per write, each confirmed on screen; then Enter alone. */
  async function pick(shown, label) {
    const target = shown.options.findIndex((o) => o.label === label);
    if (target < 0) return `option "${label}" not on screen (have: ${shown.options.map((o) => o.label).join(' | ')})`;
    for (let step = 0; step <= shown.options.length; step++) {
      const now = shape();
      if (!sameDialog(now, shown)) return 'dialog changed while navigating';
      if (now.cursorIndex === target) break;
      const before = now.cursorIndex;
      send(target > before ? DOWN : UP);
      const moved = await waitUntil(T.react, () => { const x = shape(); return sameDialog(x, shown) && x.cursorIndex !== before; });
      if (!moved) return 'cursor did not move';
    }
    const last = shape();
    if (!sameDialog(last, shown) || last.cursorIndex !== target) return 'cursor not on the option before Enter';
    send('\r');
    return null;
  }

  try {
    for (let n = 1; n <= s.steps.length; n++) {
      const step = s.steps[n - 1];
      const sh = await waitStableDialog();
      if (!sh) throw new Error(`dialog ${n} never appeared`);
      mark(`dialog-${n}-visible`);
      dialogs.push(shapeSummary(sh));
      if (print) console.log(`--- ${scenarioKey(s)} dialog ${n}\n${viewport(term).join('\n').replace(/\n{3,}/g, '\n\n')}`);

      if (step.pick) {
        const err = await pick(sh, step.pick);
        if (err) throw new Error(`dialog ${n}: ${err}`);
      } else if (step.keys !== undefined) {
        send(step.keys);
        if (step.expect === 'stays') {
          await sleep(1500);
          const after = shape();
          const stayed = sameDialog(after, sh) && after.cursorIndex === sh.cursorIndex;
          outcome.steps.push({ dialog: n, keys: step.keys, stayed });
          mark(`dialog-${n}-checked`);
          continue; // same dialog is still up for the next step
        }
      } else if (step.record) {
        break;
      }
      const gone = await waitUntil(T.gone, () => !sameDialog(shape(), sh));
      mark(gone ? `dialog-${n}-gone` : `dialog-${n}-stuck`);
      outcome.steps.push({ dialog: n, answered: step.pick ?? JSON.stringify(step.keys), gone });
    }

    if (s.until === 'main-prompt') {
      const up = await waitUntil(T.mainPrompt, () => {
        const text = viewport(term).join('\n');
        // The input box: "? for shortcuts" in normal mode; in bypass mode the
        // hint line says "bypass permissions on" instead, so also accept the
        // empty ❯ row itself.
        return (/for shortcuts/i.test(text) || /^❯\s*$/m.test(text)) && !shape().present;
      });
      mark(up ? 'main-prompt-visible' : 'main-prompt-missing');
      outcome.reachedMainPrompt = up;
      // A dialog nobody listed? Record it: that is new behaviour.
      if (!up) {
        outcome.finalScreen = normalizeVolatile(viewport(term).join('\n').replace(/\n{3,}/g, '\n\n'));
        const extra = shape();
        if (extra.present) dialogs.push(shapeSummary(extra));
      }
    } else if (s.until === 'exit') {
      await waitUntil(T.exit, () => exitCode !== null);
      mark('exited');
    }
  } catch (err) {
    outcome.error = String(err && err.message || err);
  } finally {
    await sleep(500);
    outcome.exitCode = exitCode;
    try { if (exitCode === null) child.kill(); } catch {}
    await sleep(300);
  }

  // What Claude Code remembered — proof each answer did what its label says.
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(iso.configDir, '.claude.json'), 'utf8'));
    const proj = saved.projects?.[cwd.replace(/\\/g, '/')] ?? saved.projects?.[cwd];
    outcome.folderTrusted = !!proj?.hasTrustDialogAccepted;
    // 2.1.281 records "Yes, I accept" in the user settings file, not ~/.claude.json.
    let userSettings = {};
    try { userSettings = JSON.parse(fs.readFileSync(path.join(iso.configDir, 'settings.json'), 'utf8')); } catch {}
    outcome.bypassAccepted = !!saved.bypassPermissionsModeAccepted || !!userSettings.skipDangerousModePermissionPrompt;
    outcome.userSettingsKeys = Object.keys(userSettings).sort();
  } catch { /* no config written */ }
  outcome.sessionStartHookAt = fs.existsSync(hookLog)
    ? fs.readFileSync(hookLog, 'utf8').trim().split('\n').filter(Boolean).map((x) => Number(x) - t0)
    : [];

  fs.rmSync(iso.root, { recursive: true, force: true, maxRetries: 3 });
  return {
    ccVersion,
    scenario: s.name,
    key: scenarioKey(s),
    folder: s.folder,
    trusted: !!s.trusted,
    args: s.args ?? [],
    files: Object.keys(s.files ?? {}),
    auth: !!s.auth,
    cols,
    rows,
    capturedAt: new Date().toISOString(),
    chunks,
    marks,
    dialogs,
    outcome,
  };
}

function parseArgs(argv) {
  const get = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
  return {
    claude: get('claude'),
    only: get('only')?.split(',').map((x) => x.trim()).filter(Boolean),
    out: get('out') ?? 'tests/fixtures/startup-dialogs',
    noAuth: argv.includes('--no-auth'),
    print: argv.includes('--print'),
  };
}

/** Pick the scenarios a run covers. */
export function selectScenarios({ only, noAuth }) {
  return SCENARIOS.filter((s) => (!only || only.includes(s.name) || only.includes(scenarioKey(s))) && !(noAuth && s.auth));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const opts = parseArgs(process.argv.slice(2));
  const claudeBin = resolveClaude(opts.claude);
  const ccVersion = ccVersionOf(claudeBin);
  const outDir = path.resolve(opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  let failed = 0;
  for (const s of selectScenarios(opts)) {
    const fx = await runScenario(s, { claudeBin, ccVersion, print: opts.print });
    const file = path.join(outDir, `cc-${ccVersion}-${fx.key}.json`);
    fs.writeFileSync(file, JSON.stringify(fx, null, 1));
    const summary = fx.dialogs.map((d) => d.present ? `"${d.heading}" [${d.options.join(' | ')}] (${d.selection})` : 'none').join(' → ') || 'no dialog';
    console.log(`${fx.outcome.error ? 'FAIL' : 'ok  '} ${fx.key}: ${summary}${fx.outcome.error ? `\n     ${fx.outcome.error}` : ''}`);
    if (fx.outcome.error) failed++;
  }
  process.exit(failed ? 1 : 0);
}
