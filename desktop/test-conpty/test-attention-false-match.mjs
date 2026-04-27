#!/usr/bin/env node
// False-match probe for the attention classifier — accurate version using
// @xterm/headless to render CC's PTY output the same way production xterm
// does. The earlier naive-strip version mis-flagged real spinner lines as
// "false matches" because consecutive cursor-positioned writes got
// concatenated; @xterm/headless resolves cursor moves correctly so we see
// the same buffer.active production sees.
//
// What this proves:
// - Whether Claude's response text (markdown bullets, literal spinner
//   strings) triggers the production SPINNER_RE in xterm's resolved buffer.
// - Whether CC's UI chrome (status line, divider, footer) ever produces a
//   match outside the actual spinner row.
//
// Each scenario:
//   1. Spawn CC under node-pty
//   2. Stream every PTY chunk into a headless xterm Terminal (cols=120 rows=30)
//   3. Tick every 1s — read terminal.buffer.active, run SPINNER_RE on each
//      visible line, log all matches with positional context
//   4. After full response window, also do one final scan to capture the
//      post-response state (Claude's content scrolled into view)

import pty from 'node-pty';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import url from 'node:url';
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveClaudeCommand() {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, 'claude' + ext);
      if (fs.existsSync(full)) return full;
    }
  }
  throw new Error('claude not found on PATH');
}

function pretrustCwd(cwd) {
  const cfgPath = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(cfgPath)) return;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.projects = cfg.projects || {};
  const fwd = cwd.replace(/\\/g, '/');
  cfg.projects[fwd] = { ...(cfg.projects[fwd] || {}), hasTrustDialogAccepted: true };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

// Same xterm version + buffer extraction as production terminal-registry.ts
// getScreenText. We mirror that line-walking exactly so the probe sees
// what the production classifier sees.
function getScreenText(term) {
  const buf = term.buffer.active;
  const lines = [];
  let current = '';
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped) current += text;
    else {
      if (current) lines.push(current);
      current = text;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

// Mirror the production SPINNER_RE — anchored to start of line. /m + /g so we
// can use matchAll on the multi-line screen string and still get per-line
// start anchoring. Equivalent semantics to running line.match() per-line.
const SPINNER_RE = /^([✻✽✢✳✶*⏺◉·])\s+[A-Za-z]+…/;

async function runScenario({ name, prompt, totalMs }) {
  console.log(`\n${'='.repeat(70)}\n=== ${name}\n${'='.repeat(70)}`);
  console.log(`prompt: ${JSON.stringify(prompt)}`);

  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const cwd = path.join(os.tmpdir(), `cc-fm2-${stamp}`);
  fs.mkdirSync(cwd, { recursive: true });
  pretrustCwd(cwd);

  const claude = resolveClaudeCommand();
  const startNs = process.hrtime.bigint();
  const ms = () => Number(process.hrtime.bigint() - startNs) / 1e6;

  // Headless terminal mirrors the production geometry/encoding.
  const term = new Terminal({
    cols: 120,
    rows: 30,
    allowProposedApi: true,
  });

  const child = pty.spawn(claude, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: { ...process.env },
  });
  child.onData((data) => { term.write(data); });

  // Wait for welcome.
  console.log(`[${ms().toFixed(0)}ms] waiting for welcome…`);
  const welcomeDeadline = Date.now() + 25_000;
  while (Date.now() < welcomeDeadline) {
    const screen = getScreenText(term);
    if (/Welcome|Tips|Recent\s*activity/i.test(screen)) break;
    await sleep(150);
  }
  await sleep(3500);
  console.log(`[${ms().toFixed(0)}ms] sending prompt`);
  child.write(prompt + '\r');

  const allMatches = [];
  // Snapshot the post-response state — read on each tick AND once more after
  // the loop exits so we capture the final settled buffer.
  const tickDeadline = Date.now() + totalMs;
  let finalScreen = '';
  while (Date.now() < tickDeadline) {
    await sleep(1000);
    const screen = getScreenText(term);
    finalScreen = screen;
    const lines = screen.split('\n');
    const tail = lines.slice(-40);

    for (let i = 0; i < tail.length; i++) {
      const line = tail[i];
      const m = line.match(SPINNER_RE);
      if (!m) continue;
      const positionFromBottom = tail.length - 1 - i;
      const matchEnd = m.index + m[0].length;
      const trailing = line.slice(matchEnd);
      const leading = line.slice(0, m.index);
      const trailingHasNonWs = /\S/.test(trailing);
      const leadingHasNonWs = /\S/.test(leading);
      const ctxEnd = Math.min(line.length, matchEnd + 60);
      allMatches.push({
        t: Math.round(ms()),
        glyph: m[1],
        fullMatch: m[0],
        matchContext: line.slice(0, ctxEnd),
        line,
        lineNumber: i,
        positionFromBottom,
        leadingHasNonWs,
        trailingHasNonWs,
      });
    }
  }

  child.kill();
  await sleep(300);

  // De-dup by (matched-string, line-content) so we see one row per unique
  // false-positive candidate, even if it persisted for many ticks.
  const seen = new Map();
  for (const m of allMatches) {
    const key = `${m.matchContext}|${m.glyph}|${m.fullMatch}`;
    const existing = seen.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastT = m.t;
    } else {
      seen.set(key, { ...m, count: 1, firstT: m.t, lastT: m.t });
    }
  }
  const uniqueMatches = [...seen.values()].sort((a, b) => a.firstT - b.firstT);

  // Save trace.
  const tracePath = path.join(__dirname, `false-match-${name}.log`);
  const out = [`=== ${name}`, `prompt: ${JSON.stringify(prompt)}`, ``];
  out.push(`unique matched lines (${uniqueMatches.length}):`);
  out.push(``);
  for (const m of uniqueMatches) {
    const flags = [];
    if (m.leadingHasNonWs) flags.push('lead');
    if (m.trailingHasNonWs) flags.push('trail');
    out.push(
      `  glyph="${m.glyph}" match="${m.fullMatch}" pos=${m.positionFromBottom} flags=[${flags.join(',') || 'clean'}]`
      + ` ticks=${m.count} t=${m.firstT}→${m.lastT}ms`,
    );
    out.push(`    full line: ${JSON.stringify(m.line)}`);
  }
  out.push(``);
  out.push(`=== final screen (last 40 lines) ===`);
  out.push(finalScreen.split('\n').slice(-40).map((l, i) => `[${String(i).padStart(2)}] ${l}`).join('\n'));
  fs.writeFileSync(tracePath, out.join('\n'));

  console.log(`[${ms().toFixed(0)}ms] killed; trace -> ${tracePath}`);
  console.log(`  unique matches: ${uniqueMatches.length}`);
  for (const m of uniqueMatches) {
    const flags = [];
    if (m.leadingHasNonWs) flags.push('lead');
    if (m.trailingHasNonWs) flags.push('trail');
    console.log(`    glyph="${m.glyph}" match="${m.fullMatch}" pos=${m.positionFromBottom} flags=[${flags.join(',') || 'clean'}] ticks=${m.count}`);
    console.log(`      ctx=${JSON.stringify(m.matchContext)}`);
  }

  return { name, uniqueMatches, finalScreen };
}

async function main() {
  console.log(`platform=${process.platform} node=${process.version}`);

  const scenarios = [];

  // Scenario 1: ask Claude to emit markdown bullets with U+2026 ellipsis.
  scenarios.push(await runScenario({
    name: 'markdown-bullets',
    prompt: 'Output ONLY this exact markdown list, nothing else (no preamble, no explanation):\n* Loading…\n* Building…\n* Saving…',
    totalMs: 60_000,
  }));

  // Scenario 2: literal spinner string in the response.
  scenarios.push(await runScenario({
    name: 'literal-spinner',
    prompt: 'Output ONLY this exact line, nothing else: ✻ Pondering…',
    totalMs: 60_000,
  }));

  // Scenario 3: A tool-output style line that might naturally appear in
  // build-tool output.
  scenarios.push(await runScenario({
    name: 'tool-progress',
    prompt: 'Output ONLY these three lines, nothing else:\n* Compiling…\n* Linking…\n* Done!',
    totalMs: 60_000,
  }));

  // Scenario 4: Control — normal response with no spinner-like content.
  scenarios.push(await runScenario({
    name: 'control-normal',
    prompt: 'What is 7 times 8? Just the number.',
    totalMs: 50_000,
  }));

  console.log(`\n${'='.repeat(70)}\nSUMMARY\n${'='.repeat(70)}`);
  console.log(`(With xterm-headless rendering — accurate to production buffer.active)`);
  for (const s of scenarios) {
    console.log(`\n${s.name}:  ${s.uniqueMatches.length} unique matches`);
    for (const m of s.uniqueMatches) {
      console.log(`  glyph="${m.glyph}" match="${m.fullMatch}" pos=${m.positionFromBottom} ticks=${m.count}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
