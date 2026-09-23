#!/usr/bin/env node
// capture-plan-menu.mjs — record Claude Code's REAL plan-approval menu.
//
// WHY this exists: the app's plan card builds its buttons from whatever menu
// Claude Code is actually showing (plan-menu-parser.ts). That menu changes with
// settings, flags and versions (a "clear context" row, an Ultraplan row, a text
// input for feedback), so the only trustworthy test input is the real bytes.
// This probe drives the installed `claude` through a PTY, waits for the plan
// menu, and saves every byte it printed as a fixture the unit tests replay
// through a headless xterm — the same screen the renderer's parser reads.
// Re-run it on every Claude Code bump that touches plan mode.
//
// ISOLATION (never Destin's real ~/.claude): each run gets a temp HOME and a
// temp CLAUDE_CONFIG_DIR. Auth is a copy of the access token ONLY — the refresh
// token is deliberately left out so a probe can never rotate it and log the
// real install out. A probe refuses to start when the copied token has under
// 20 minutes left. Every CLAUDE_* / CLAUDECODE variable is stripped so a probe
// launched from inside a session can never reach that session's hook pipe.
//
// COST: one short Haiku plan per run. Keep runs few.
//
// Usage (from youcoded/desktop):
//   node test-conpty/capture-plan-menu.mjs --variant default --cols 120 --rows 40 \
//     --answer none|digit:N|feedback:N:text|esc|shift-tab|raw:"<JSON string>" \
//     [--clear-context]            settings.showClearContextOnPlanAccept = true
//     [--bypass]                   --allow-dangerously-skip-permissions
//     [--resize-to 60x30]          resize the PTY once the menu is up
//     [--focus-input]              arrow down 6 times, then type (records cursor moves)
//     [--watch-ms N]               with --answer none: keep recording N ms
//     [--hook-deny-after N | --hook-release-after N | --hook-allow-after N]
//                                  make the held hook answer deny / no decision / allow
//     [--out tests/fixtures/plan-menu]
// Every fixture in tests/fixtures/plan-menu was made with this script; its file
// name carries the variant, and its `flags` field the exact options.
// NOTE (zsh): pass each flag as its own word — an unquoted "$a" holding
// "--answer esc" is ONE argument in zsh and is silently ignored.
//
// Output: <out>/cc-<version>-<variant>-<cols>x<rows>.json
//   { ccVersion, variant, cols, rows, flags, settings, chunks: [{t, b64}],
//     marks: [{t, label, chunkIndex}], outcome }
// `chunks` are the raw PTY bytes in arrival order; `marks` note where the menu
// first became complete, where input was sent, etc.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const pty = require('node-pty');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const variant = String(arg('variant', 'default'));
const cols = Number(arg('cols', 120));
const rows = Number(arg('rows', 40));
const answer = String(arg('answer', 'none'));
const clearContext = !!arg('clear-context', false);
const bypass = !!arg('bypass', false);
const resizeTo = arg('resize-to', null); // e.g. "60x30" — resize after the menu is up
const outDir = path.resolve(String(arg('out', 'tests/fixtures/plan-menu')));
const model = String(arg('model', 'haiku'));
// Make the held hook answer DENY after this many ms — measures whether a late
// hook answer (the app closing its socket after a terminal answer) can undo it.
const hookDenyAfter = arg('hook-deny-after', null);
// Make the held hook answer with NO decision after this many ms — measures the
// app's "release the socket without deciding" path (the menu must stay live).
const hookReleaseAfter = arg('hook-release-after', null);
// Make the held hook answer ALLOW after this many ms — what the buddy floater's
// old "Allow" button sent for a plan.
const hookAllowAfter = arg('hook-allow-after', null);

function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '');
}

function resolveClaude() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const full = path.join(dir, 'claude');
    if (fs.existsSync(full)) return full;
  }
  throw new Error('claude not found on PATH');
}

const claudeBin = resolveClaude();
const ccVersion = execFileSync(claudeBin, ['--version'], {
  encoding: 'utf8',
  env: cleanEnv(process.env),
}).trim().split(/\s+/)[0];

function cleanEnv(src) {
  const env = {};
  for (const [k, v] of Object.entries(src)) {
    if (/^CLAUDE/.test(k) || k === 'ANTHROPIC_API_KEY') continue;
    env[k] = v;
  }
  return env;
}

// ---- isolated home -------------------------------------------------------
const stamp = `${Date.now()}-${process.pid}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), `plan-menu-${variant}-`));
const home = path.join(root, 'home');
const configDir = path.join(home, '.claude');
const project = path.join(root, 'project');
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(project, { recursive: true });

const realCreds = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
const oauth = realCreds.claudeAiOauth || {};
const minutesLeft = (oauth.expiresAt - Date.now()) / 60000;
if (!oauth.accessToken || !(minutesLeft > 20)) {
  console.error(`refusing: copied access token has ${minutesLeft.toFixed(0)} min left (need > 20)`);
  process.exit(3);
}
// Access token only — no refreshToken, so this copy can never rotate it.
fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify({
  claudeAiOauth: {
    accessToken: oauth.accessToken,
    expiresAt: oauth.expiresAt,
    scopes: oauth.scopes,
    subscriptionType: oauth.subscriptionType,
    rateLimitTier: oauth.rateLimitTier,
  },
}), { mode: 0o600 });

// A PermissionRequest hook that NEVER answers, mirroring the app: while the
// app's relay holds its socket, Claude Code's own menu stays live in the PTY.
// The hook logs when it starts and when it is torn down, which answers "does
// Claude Code kill the hook when the menu is answered in the terminal?".
const hookLog = path.join(root, 'hook.log');
const hookScript = path.join(root, 'hold-hook.js');
fs.writeFileSync(hookScript, `
const fs = require('fs');
const log = (m) => fs.appendFileSync(${JSON.stringify(hookLog)}, Date.now() + ' ' + m + '\\n');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let tool = '?';
  try { tool = JSON.parse(input).tool_name; } catch {}
  log('start ' + tool);
});
const denyAfter = ${hookDenyAfter === null ? 'null' : Number(hookDenyAfter)};
if (denyAfter !== null) setTimeout(() => {
  log('deny-sent');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'late deny from probe' } } }));
  process.exit(0);
}, denyAfter);
const allowAfter = ${hookAllowAfter === null ? 'null' : Number(hookAllowAfter)};
if (allowAfter !== null) setTimeout(() => {
  log('allow-sent');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }) + '\\n');
  process.exit(0);
}, allowAfter);
const releaseAfter = ${hookReleaseAfter === null ? 'null' : Number(hookReleaseAfter)};
if (releaseAfter !== null) setTimeout(() => {
  log('release-sent');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest' } }) + '\\n');
  process.exit(0);
}, releaseAfter);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { log('signal ' + sig); process.exit(0); });
setInterval(() => {}, 1 << 30);
`);

const settings = {
  hooks: {
    PermissionRequest: [{ matcher: '', hooks: [{ type: 'command', command: `node ${hookScript}`, timeout: 600 }] }],
  },
};
if (clearContext) settings.showClearContextOnPlanAccept = true;
fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings, null, 2));

// Skip onboarding + trust so the first screen is the prompt.
const fwd = project.replace(/\\/g, '/');
fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true,
  theme: 'dark',
  bypassPermissionsModeAccepted: true,
  projects: { [fwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
}, null, 2));

// ---- run ---------------------------------------------------------------
const prompt = 'Plan mode test. Do not read, search or explore anything. '
  + 'Write a one-sentence plan to create hello.txt containing the word hi, then call ExitPlanMode immediately.';

const claudeArgs = ['--model', model, '--permission-mode', 'plan'];
if (bypass) claudeArgs.push('--allow-dangerously-skip-permissions');
claudeArgs.push(prompt);

const env = { ...cleanEnv(process.env), HOME: home, CLAUDE_CONFIG_DIR: configDir, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
const t0 = Date.now();
const chunks = [];
const marks = [];
let text = '';
const mark = (label) => { marks.push({ t: Date.now() - t0, label, chunkIndex: chunks.length }); console.log(`[${Date.now() - t0}ms] ${label}`); };

const child = pty.spawn(claudeBin, claudeArgs, { name: 'xterm-256color', cols, rows, cwd: project, env });
child.onData((d) => {
  chunks.push({ t: Date.now() - t0, b64: Buffer.from(d, 'utf8').toString('base64') });
  text += stripAnsi(d);
  if (text.length > 400000) text = text.slice(-200000);
});
let exited = false;
child.onExit(() => { exited = true; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(re, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (re.test(text)) return true;
    if (exited) return false;
    await sleep(100);
  }
  return false;
}

function transcriptTail() {
  const projects = path.join(configDir, 'projects');
  if (!fs.existsSync(projects)) return [];
  const out = [];
  for (const d of fs.readdirSync(projects)) {
    for (const f of fs.readdirSync(path.join(projects, d))) {
      if (!f.endsWith('.jsonl')) continue;
      const lines = fs.readFileSync(path.join(projects, d, f), 'utf8').trim().split('\n');
      for (const l of lines) { try { out.push({ file: f, ...JSON.parse(l) }); } catch {} }
    }
  }
  return out;
}

const outcome = {};
try {
  // Plan menu is up when its closing question has rendered AND an option row exists.
  const up = await waitFor(/Would\s*you\s*like\s*to\s*proceed[\s\S]*1\./, 180000);
  if (!up) throw new Error('plan menu never appeared');
  mark('menu-visible');
  await sleep(1500); // let the frame settle
  mark('menu-settled');

  if (typeof resizeTo === 'string') {
    const [c, r] = resizeTo.split('x').map(Number);
    child.resize(c, r);
    mark(`resize ${c}x${r}`);
    await sleep(1500);
    mark('resize-settled');
  }

  // Probe: focus the text-input row with arrows so its rendered form is on record.
  if (arg('focus-input', false)) {
    for (let i = 0; i < 6; i++) { child.write('\x1b[B'); await sleep(250); }
    mark('arrowed-down-6');
    await sleep(800);
    child.write('fix it');
    await sleep(800);
    mark('typed-into-input');
  }

  if (answer.startsWith('digit:')) {
    const n = answer.split(':')[1];
    child.write(n);
    mark(`sent digit ${n}`);
  } else if (answer.startsWith('feedback:')) {
    const [, n, ...rest] = answer.split(':');
    const fb = rest.join(':');
    child.write(n);
    mark(`sent digit ${n}`);
    await sleep(700);
    mark('after-digit');
    child.write(fb);
    mark(`typed feedback`);
    await sleep(700);
    mark('after-typing');
    child.write('\r');
    mark('sent enter');
  } else if (answer.startsWith('raw:')) {
    // Replay an exact byte string in ONE write, e.g. the old card's
    // "down-arrow × index + Enter" — raw:"\u001b[B\u001b[B\r" (JSON string).
    child.write(JSON.parse(answer.slice(4)));
    mark('sent raw');
  } else if (answer === 'esc') {
    child.write('\x1b');
    mark('sent esc');
  } else if (answer === 'shift-tab') {
    child.write('\x1b[Z');
    mark('sent shift-tab');
  }

  if (answer === 'none' && arg('watch-ms', null)) {
    await sleep(Number(arg('watch-ms', 0)));
    mark('watched');
    const tail = stripAnsi(Buffer.concat(chunks.map((c) => Buffer.from(c.b64, 'base64'))).toString('utf8'));
    outcome.menuStillShown = /Would\s*you\s*like\s*to\s*proceed/.test(tail.slice(-3000));
  }
  if (answer !== 'none') {
    // Watch what Claude Code does next: menu gone? new turn? mode line?
    await sleep(6000);
    mark('after-answer-6s');
    const tail = stripAnsi(Buffer.concat(chunks.slice(marks.find((m) => m.label.startsWith('sent'))?.chunkIndex ?? 0)
      .map((c) => Buffer.from(c.b64, 'base64'))).toString('utf8'));
    outcome.menuStillShown = /Would\s*you\s*like\s*to\s*proceed/.test(tail.slice(-3000));
    outcome.modeLine = (tail.match(/(accept edits on|bypass permissions on|plan mode on|auto mode on)/gi) || []).slice(-1)[0] || null;
    outcome.tailText = tail.slice(-2500);
  }
} catch (err) {
  outcome.error = String(err && err.message || err);
  console.error(outcome.error);
} finally {
  try { child.kill(); } catch {}
  await sleep(1500);
}

const tr = transcriptTail();
const exitPlan = tr.filter((e) => e.type === 'assistant')
  .flatMap((e) => (e.message?.content || []).filter((c) => c.type === 'tool_use' && c.name === 'ExitPlanMode'));
const results = tr.filter((e) => e.type === 'user')
  .flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []).filter((c) => c.type === 'tool_result'));
const ids = new Set(exitPlan.map((t) => t.id));
outcome.exitPlanToolResults = results.filter((r) => ids.has(r.tool_use_id)).map((r) => ({
  is_error: !!r.is_error,
  content: typeof r.content === 'string' ? r.content.slice(0, 600) : JSON.stringify(r.content).slice(0, 600),
}));
outcome.transcriptFiles = [...new Set(tr.map((e) => e.file))];
outcome.hookLog = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8') : '';

fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `cc-${ccVersion}-${variant}-${cols}x${rows}.json`);
fs.writeFileSync(file, JSON.stringify({
  ccVersion, variant, cols, rows, capturedAt: new Date().toISOString(),
  flags: { clearContext, bypass, answer, resizeTo, model, hookDenyAfter, hookReleaseAfter, hookAllowAfter }, settings: { showClearContextOnPlanAccept: clearContext },
  chunks, marks, outcome,
}, null, 1));
console.log(`wrote ${file}`);
console.log(JSON.stringify({ ...outcome, tailText: undefined }, null, 2));
fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
process.exit(0);
