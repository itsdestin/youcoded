#!/usr/bin/env node
// check-send-drift.mjs — can the app still SEND a chat message to this Claude Code?
//
// WHY (2026-11-18): Claude Code 2.1.326 (out 2026-11-16) started capping its message box at a few lines and labelling
// the edges "↑ N more". The app's "is it safe to press Enter?" reader took the long draft for a pop-up, so every long
// message in a new chat sat "Paused" — sending, the core of the app, broke for every user overnight and nothing noticed
// (the daily pop-up and startup checks never send a message; test-claude-queue-transport.mjs sends one but answers
// "safe" itself, at 120×40). This check sends real messages exactly the way the app does — the production queue
// runtime (main/claude-queue-runtime.ts, entered through the same `action` the chat box's send calls), the Claude Code
// plugin, the real worker and the REAL screen reader (main/session-screens.ts) watching the real terminal — into a fresh
// chat for each case, and passes only when Claude Code records the EXACT message text in its conversation, once.
//
// Cases: a terminal size (the computer's hidden 80×24, a normal window, a phone-width one) × a message length (short to
// over Claude Code's 10,000-character shortening) × both renderers (classic, and fullscreen with YouCoded's status line —
// Destin's own setup). Plus: a message sent while a permission menu is open must WAIT and go through once it closes; a
// message sent while Claude Code is still writing a reply must go through, once.
//
// COST: free. Claude Code talks to a local stand-in API (fake-anthropic.mjs); no account, no network.
//
// Usage (from youcoded/desktop, after `npm run build:main`):
//   node test-conpty/check-send-drift.mjs                 # the `claude` on PATH
//   node test-conpty/check-send-drift.mjs --latest        # npm's latest @anthropic-ai/claude-code (the daily CI run)
//   node test-conpty/check-send-drift.mjs --claude <bin>  # a specific binary (e.g. an older version, to bisect)
//   --only <substring>   run matching cases only        --jobs <n>   cases at once (default 3)
// Exit 0 = every case sent; 1 = at least one did not (each failure prints the screen Claude Code was showing).
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveClaude, ccVersionOf, removeTempTree, installLatest, makeIsolatedRoot, isolatedEnv } from './cc-capture-lib.mjs';
import { startFakeApi } from './fake-anthropic.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const get = (f) => { const i = argv.indexOf(`--${f}`); return i < 0 ? undefined : argv[i + 1]; };

const dist = (f) => {
  const file = path.join(desktop, 'dist', 'main', f);
  if (!fs.existsSync(file)) { console.error(`missing ${file} — run \`npm run build:main\` first`); process.exit(2); }
  return require(file);
};
const { ClaudeControlBridge } = dist('claude-control-bridge.js');
const { ClaudeQueueRuntime } = dist('claude-queue-runtime.js');
const { SessionScreens } = dist('session-screens.js');
const { prepareClaudeQueueInput } = dist('claude-queue-input.js');
const { Terminal } = require('@xterm/headless');

const YOUCODED_STATUSLINE = fs.readFileSync(path.join(desktop, 'hook-scripts', 'statusline.sh'), 'utf8');
const SIZES = [{ cols: 80, rows: 24 }, { cols: 120, rows: 40 }, { cols: 45, rows: 30 }];
// 600: with the old reader, 300 still fit the stand-in status line's box at 80×24 and 600 did not (seen red 2026-11-18).
const LENGTHS = [20, 300, 600, 1500, 12000];
const CASES = [
  ...['classic', 'fullscreen'].flatMap((renderer) => SIZES.flatMap((size) => LENGTHS.map((length) => ({
    name: `${renderer}-${size.cols}x${size.rows}-${length}`, renderer, ...size, length,
  })))),
  { name: 'fullscreen-80x24-300-waits-for-permission-menu', renderer: 'fullscreen', cols: 80, rows: 24, length: 300, first: 'permission-menu' },
  { name: 'fullscreen-80x24-600-during-a-reply', renderer: 'fullscreen', cols: 80, rows: 24, length: 600, first: 'streaming-reply' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, test, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (test()) return; await sleep(50); }
  throw new Error(`timed out (${Math.round(ms / 1000)} s) waiting for: ${label}`);
}
const quietly = async (fn) => { try { await fn(); } catch { /* cleanup is best effort; it must never sink the report */ } };

/** A message `length` characters long, starting with a marker unique to the case. */
function messageFor(c) {
  const marker = `SENDCHECK_${c.name.replace(/-/g, '_')}`;
  let text = `${marker} `;
  while (text.length < c.length) text += 'please read this sentence as part of a long message. ';
  return { marker, text: text.slice(0, Math.max(c.length, marker.length)).trimEnd() };
}

/** The text of every user row Claude Code wrote to its conversation file that carries `marker`. */
function recorded(configDir, marker) {
  const files = [];
  const walk = (p) => { if (!fs.existsSync(p)) return; for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith('.jsonl')) files.push(f); } };
  walk(path.join(configDir, 'projects'));
  return files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }))
    .filter((r) => r.type === 'user' && JSON.stringify(r.message?.content ?? '').includes(marker))
    .map((r) => { const c = r.message.content; return typeof c === 'string' ? c : c.filter((p) => p.type === 'text').map((p) => p.text).join(''); });
}

async function runCase(c, cli) {
  const started = Date.now();
  const { root, home, configDir, project } = makeIsolatedRoot('send-drift');
  const settings = { promptSuggestionEnabled: false };
  if (c.renderer === 'fullscreen') {
    fs.writeFileSync(path.join(configDir, 'youcoded-statusline.sh'), YOUCODED_STATUSLINE);
    Object.assign(settings, { tui: 'fullscreen', statusLine: { type: 'command', command: 'bash $HOME/.claude/youcoded-statusline.sh' } });
  }
  fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 3, theme: 'dark', projects: { [project]: { hasTrustDialogAccepted: true } } }));
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings));

  const SID = 'app';
  const { marker, text } = messageFor(c);
  const mirror = new Terminal({ cols: c.cols, rows: c.rows, scrollback: 0, allowProposedApi: true });
  const screenText = () => { const b = mirror.buffer.active; return Array.from({ length: mirror.rows }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) ?? '').join('\n'); };
  let worker, api, bridge, runtime, screens, exit = null, turnId = null, lastQueue = null, enters = 0;
  try {
    const done = { text: 'DONE', wordMs: 0 };
    api = await startFakeApi([
      // permission-menu: the first turn writes a file, which Claude Code (default permission mode) asks about first.
      // streaming-reply: the first turn writes ~150 words slowly, so the message is sent while Claude Code is busy.
      ...(c.first === 'permission-menu' ? [{ tools: [{ name: 'Write', input: { file_path: path.join(project, 'sendcheck.txt'), content: 'x' } }] }] : []),
      ...(c.first === 'streaming-reply' ? [{ text: 'working on it '.repeat(50), wordMs: 40 }] : []),
      ...Array(6).fill(done),
    ]);
    // The production screen reader, with a stand-in only for the session record (asks and cards the hooks report;
    // with them the real app holds the queue MORE, never less).
    screens = new SessionScreens({
      records: { screenNeed: () => ({ working: turnId !== null, toolRunning: false, asking: false, started: true, cards: 0, permissionCard: false }) },
      live: { attention() {}, showPrompt() {}, dismissPrompt() {}, inputBlock() {} },
      isClaude: () => true,
      size: () => ({ cols: c.cols, rows: c.rows }),
      onQueueInputReady: (id) => runtime?.wake(id), // as ipc-handlers.ts wires it
    });
    bridge = new ClaudeControlBridge(path.join(root, 'deployment'), { pollMs: 5000 });
    bridge.on('state', (_id, state) => { if (state && 'turnId' in state) turnId = state.turnId ?? null; });
    // The production queue runtime, wired as claude-queue-wiring.ts does; the session manager's part is the worker
    // round trip below (session-manager.ts queueWorkerCommand: match the request AND the attempt, refuse odd replies).
    runtime = new ClaudeQueueRuntime({
      userDataRoot: () => path.join(root, 'userdata'),
      bridge,
      manager: {
        getSession: (id) => (id === SID && exit === null ? { cwd: project, provider: 'claude' } : undefined),
        sendInput: (id, data) => { if (id === SID) worker.send({ type: 'input', data }); },
        queueWorkerCommand: (id, command) => new Promise((resolve) => {
          if (id !== SID || !worker?.connected) { resolve({ status: 'blocked' }); return; }
          if (command.type === 'queue-enter') enters++;
          const requestId = `w${Math.random()}`;
          const finish = (status) => { clearTimeout(timer); worker.off('message', receive); resolve({ status }); };
          const receive = (m) => { if (m.type === 'queue-worker-result' && m.requestId === requestId && m.attemptId === command.attemptId && ['owned', 'entered', 'released', 'revoked', 'blocked', 'stale', 'unknown'].includes(m.status)) finish(m.status); };
          const timer = setTimeout(() => finish('unknown'), 12000);
          worker.on('message', receive);
          worker.send({ ...command, requestId });
        }),
      },
      inputSafe: (id) => screens.queueInputSafe(id),
      waitInputSafe: (id, deadline) => screens.waitForQueueInputSafe(id, deadline),
      working: () => turnId !== null,
      publish: (_id, body) => { if (body.kind === 'queue') lastQueue = body; },
      noteSend: () => {},
    });
    const prepared = await bridge.prepare(SID);
    const env = { ...isolatedEnv({ home, configDir }), ANTHROPIC_BASE_URL: api.url, ANTHROPIC_AUTH_TOKEN: 'local-stand-in', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    worker = fork(path.join(desktop, 'src', 'main', 'pty-worker.js'), [], { cwd: project, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    // WHY the connected check and the error listener (PR #770 run 44420491517): output still arriving as the
    // worker exits made this ack write to a closed channel; the unhandled EPIPE crashed the whole check instead of
    // letting the `exit` path below report what happened.
    worker.on('message', (m) => { if (m.type === 'data') { screens.noteOutput(SID, m.data); mirror.write(m.data); if (worker.connected) worker.send({ type: 'ack', n: m.data.length }); } });
    worker.on('error', () => { /* a write after exit; the exit handler below records the outcome */ });
    worker.on('exit', (code, signal) => { exit = { code, signal }; });
    worker.stderr.on('data', () => {});
    worker.send({ type: 'spawn', sessionId: 'send-drift', command: cli, args: ['--model', 'haiku', '--permission-mode', 'default', '--setting-sources', 'user', ...prepared.args], controlEnv: prepared.env, cwd: project, cols: c.cols, rows: c.rows });

    // The chat box asks for the queue's identity first; "still starting" means try again, as the app does.
    let identity = null;
    await until('the chat to link to its queue', () => { if (exit) return true; if (!identity) void runtime.action(SID, { kind: 'identity' }).then((r) => { if (r.status === 'identity') identity = r.identity; }); return !!identity; }, 45000);
    if (exit) throw new Error(`Claude Code exited before the chat was ready (${JSON.stringify(exit)})`);
    await until('Claude Code\'s message box to be on screen', () => screens.queueInputSafe(SID), 30000);

    if (c.first === 'permission-menu') {
      worker.send({ type: 'input', data: 'write the file\r' });
      await until('the permission menu to open', () => !screens.queueInputSafe(SID) && /Do you want/.test(screenText()), 30000);
    }
    if (c.first === 'streaming-reply') {
      worker.send({ type: 'input', data: 'start a long reply\r' });
      await until('Claude Code to start replying', () => /working on it/.test(screenText()), 30000);
    }

    // Exactly what the chat box's send does on the host (ipc conversation-queue action → ClaudeQueueRuntime.action).
    const reply = await runtime.action(SID, { kind: 'enqueue', queueId: identity.queueId, payload: { sendEpoch: identity.sendEpoch, sendId: `send-${c.name}`, originalText: text, attachments: [], displayContent: text.slice(0, 80) } });
    if (reply.status !== 'queued') throw new Error(`the send was refused: ${JSON.stringify(reply)}`);

    if (c.first === 'permission-menu') {
      await sleep(6000); // settle: give the queue every chance to (wrongly) press Enter into the menu
      if (enters || recorded(configDir, marker).length) throw new Error('the message was sent while a permission menu was open');
      worker.send({ type: 'input', data: '\x1b' }); // close the menu (decline), as a person would
    }

    await until('Claude Code to record the message in its conversation', () => recorded(configDir, marker).length > 0, 45000);
    await sleep(500); // settle: a duplicate would land right behind the first
    const rows = recorded(configDir, marker);
    if (rows.length !== 1) throw new Error(`the message was recorded ${rows.length} times`);
    const expected = (await prepareClaudeQueueInput({ text, attachments: [], cwd: project })).wireText;
    if (rows[0] !== expected) throw new Error(`Claude Code received different text: ${rows[0].length} characters, expected ${expected.length}${rows[0].length === expected.length ? ' (same length, different characters)' : ''}`);
    await until('the queue strip to empty', () => lastQueue && lastQueue.queue.length === 0, 15000);
    return { name: c.name, ok: true, seconds: Math.round((Date.now() - started) / 100) / 10 };
  } catch (error) {
    const strip = lastQueue ? `strip shows: ${JSON.stringify(lastQueue.queue.map((q) => (q.paused ? 'Paused' : q.status)))}${lastQueue.paused ? ' (queue paused)' : ''}; Enter pressed ${enters}×` : 'queue never linked';
    return { name: c.name, ok: false, seconds: Math.round((Date.now() - started) / 100) / 10, error: error.message, state: strip, screen: screenText() };
  } finally {
    await quietly(() => runtime?.close());
    await quietly(() => bridge?.close());
    if (worker?.connected) worker.send({ type: 'kill' });
    await quietly(() => until('worker exit', () => exit !== null, 5000));
    if (exit === null) worker?.kill('SIGKILL');
    await quietly(() => api?.close());
    mirror.dispose();
    await quietly(() => removeTempTree(root));
  }
}

async function main() {
  let latest = null;
  if (argv.includes('--latest')) latest = installLatest();
  const cli = resolveClaude(latest?.bin ?? get('claude'));
  const version = ccVersionOf(cli);
  const only = get('only');
  const cases = CASES.filter((c) => !only || c.name.includes(only));
  const jobs = Math.max(1, Number(get('jobs') ?? 3));
  console.log(`Sending ${cases.length} message(s) through the app's queue to Claude Code ${version} (${jobs} at a time)\n`);

  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, cases.length) }, async () => {
    while (next < cases.length) {
      const c = cases[next++];
      const r = await runCase(c, cli);
      results.push(r);
      console.log(`${r.ok ? 'SENT ' : 'FAIL '} ${r.name} (${r.seconds} s)${r.ok ? '' : ` — ${r.error}`}`);
    }
  }));
  if (latest) await quietly(() => removeTempTree(latest.dir));

  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.log(`\n── ${r.name}: ${r.error}\n   ${r.state}\n   screen:\n${r.screen.split('\n').map((l) => `   │${l}`).join('\n')}`);
  const verdict = failed.length ? `${failed.length} of ${results.length} messages did NOT send on Claude Code ${version}` : `All ${results.length} messages sent on Claude Code ${version}`;
  console.log(`\n${verdict}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const cell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|'); // backslashes first, then the column separator
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Message sending — Claude Code ${version}\n\n${verdict}\n\n| Case | Result |\n|---|---|\n${results.sort((a, b) => a.name.localeCompare(b.name)).map((r) => `| ${r.name} | ${r.ok ? 'sent' : `**did not send** — ${cell(r.error)}`} |`).join('\n')}\n`);
  }
  // WHY exit explicitly: a leaked child or IPC handle must not hold the CI step open until its time limit.
  process.exit(failed.length ? 1 : 0);
}

await main();
