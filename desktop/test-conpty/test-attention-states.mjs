#!/usr/bin/env node
// End-to-end audit of the attention classifier against real Claude Code.
//
// Purpose: drive real CC through several scenarios and tick the classifier
// against the live PTY buffer, recording per-tick state. Verifies whether
// the ThinkingIndicator/AttentionBanner pipeline fires at the right times.
//
// Mirrors the production logic (classifier + upstream mapping in
// useAttentionClassifier.ts) in plain JS, so we can run it in node without
// xterm/React. The buffer-tail input mimics xterm.buffer.active by
// stripping ANSI from raw PTY bytes and taking the last 40 lines — close
// enough for spinner regex matching since the most recent spinner line ends
// up at the bottom of the stripped stream.
//
// Scenarios:
//   1. idle      — spawn, wait for welcome, sit 25s without sending. Verifies
//                   no false-positive 'stuck' from idle terminal noise.
//   2. quick     — send "say hi", watch 35s. Verifies thinking-active fires
//                   while spinner is visible, then drops back to 'unknown' /
//                   'ok' after response. Logs every glyph + gerund seen.
//   3. long      — send a longer prompt, watch 60s. Verifies sustained
//                   thinking-active, no false 'stuck', spinner counter
//                   advances steadily. Captures wider glyph/gerund set.
//   4. post-idle — same as quick, but keep ticking 25s after response. The
//                   production hook would have stopped (isThinking=false), but
//                   we tick to see what classifyBuffer says. Should be
//                   'unknown' → mapped 'ok' the whole time.
//
// Cost: 3 short prompts to claude, killed within ~60s each. Tens of input
// tokens, hundreds of output tokens total. Negligible.
//
// Usage: cd youcoded/desktop && node test-conpty/test-attention-states.mjs

import pty from 'node-pty';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- helpers (shared with other test-conpty harnesses) -----------------

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

function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '');
}

// --- production-equivalent classifier (port of attention-classifier.ts) ---

// Updated 2026-04-26: glyph + gerund + ellipsis. No seconds counter required.
// Active vs. stalled is decided by glyph rotation across ticks.
const SPINNER_RE = /([✻✽✢✳✶*⏺◉·])\s+[A-Za-z]+…/;

// Wider regex used only by the harness's observed-set logging — captures the
// gerund word for cross-scenario summary, independent of the classifier path.
const SPINNER_CAPTURE_RE = /([✻✽✢✳✶*⏺◉·])\s+([A-Za-z]+)…/;

function classifyBuffer(ctx) {
  const tail = ctx.bufferTail;
  if (tail.length === 0) {
    return { class: 'unknown', spinnerGlyph: null };
  }

  let glyph = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i].match(SPINNER_RE);
    if (m) { glyph = m[1]; break; }
  }

  if (glyph === null) {
    return { class: 'unknown', spinnerGlyph: null };
  }
  const prev = ctx.previousSpinnerGlyph;
  if (prev === null) {
    return { class: 'thinking-active', spinnerGlyph: glyph };
  }
  if (glyph !== prev) {
    return { class: 'thinking-active', spinnerGlyph: glyph };
  }
  if (ctx.secondsSincePreviousGlyph >= 30) {
    return { class: 'thinking-stalled', spinnerGlyph: glyph };
  }
  return { class: 'thinking-active', spinnerGlyph: glyph };
}

function bufferClassToAttention(cls) {
  switch (cls) {
    case 'thinking-stalled': return 'stuck';
    case 'thinking-active':
    case 'unknown': return 'ok';
  }
}

// --- production-equivalent hook driver (port of useAttentionClassifier) ---

const TICK_MS = 1000;
const STABILITY_TICKS = 5;
const NO_SPINNER_STUCK_MS = 20_000;

function makeDriver() {
  // Per-run spinner tracking — mirrors useAttentionClassifier hook semantics.
  let previousSpinnerGlyph = null;
  let previousSpinnerGlyphAt = Date.now();
  let lastSpinnerSeenAt = Date.now();
  let pendingState = 'ok';
  let pendingStreak = 0;
  let dispatchedState = 'ok';

  return {
    tick(bufferTail, now = Date.now()) {
      const ctx = {
        bufferTail,
        previousSpinnerGlyph,
        secondsSincePreviousGlyph: (now - previousSpinnerGlyphAt) / 1000,
      };
      const result = classifyBuffer(ctx);

      if (result.spinnerGlyph !== null) {
        lastSpinnerSeenAt = now;
        if (result.spinnerGlyph !== previousSpinnerGlyph) {
          previousSpinnerGlyph = result.spinnerGlyph;
          previousSpinnerGlyphAt = now;
        }
      }

      let mapped = bufferClassToAttention(result.class);
      let escalation = null;

      if (
        mapped === 'ok' &&
        result.class === 'unknown' &&
        now - lastSpinnerSeenAt >= NO_SPINNER_STUCK_MS
      ) {
        mapped = 'stuck';
        escalation = 'no-spinner-20s';
      }

      if (mapped === pendingState) {
        pendingStreak += 1;
      } else {
        pendingState = mapped;
        pendingStreak = 1;
      }

      const shouldDispatch = mapped === 'ok' || pendingStreak >= STABILITY_TICKS;
      const dispatched = shouldDispatch && mapped !== dispatchedState;
      if (dispatched) dispatchedState = mapped;

      return {
        result,
        mapped,
        escalation,
        pendingStreak,
        dispatchedState,
        dispatched,
      };
    },
    snapshot() {
      return { dispatchedState, pendingState, pendingStreak };
    },
  };
}

// --- buffer mimic of xterm.buffer.active ----------------------------------

function bufferTailFromRaw(rawAccum, n = 40) {
  const stripped = stripAnsi(rawAccum);
  const lines = stripped.split('\n');
  return lines.slice(-n);
}

// --- scenario runner ------------------------------------------------------

async function runScenario({ name, prompt, sendDelayMs, totalMs, killOnComplete = false }) {
  console.log(`\n${'='.repeat(70)}\n=== ${name}\n${'='.repeat(70)}`);

  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const cwd = path.join(os.tmpdir(), `cc-attention-${stamp}`);
  fs.mkdirSync(cwd, { recursive: true });
  pretrustCwd(cwd);

  const claude = resolveClaudeCommand();
  const startNs = process.hrtime.bigint();
  const ms = () => Number(process.hrtime.bigint() - startNs) / 1e6;

  let rawAccum = '';
  const child = pty.spawn(claude, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: { ...process.env },
  });
  child.onData((data) => { rawAccum += data; });

  // Wait for welcome screen + post-welcome settle (3.5s).
  console.log(`[${ms().toFixed(0)}ms] waiting for welcome…`);
  const welcomeDeadline = Date.now() + 25_000;
  let welcomeSeen = false;
  while (Date.now() < welcomeDeadline) {
    const stripped = stripAnsi(rawAccum);
    if (/Welcome|Tips|Recent\s*activity/i.test(stripped)) {
      welcomeSeen = true; break;
    }
    await sleep(150);
  }
  if (!welcomeSeen) {
    console.log('!! welcome never appeared — aborting scenario');
    child.kill();
    return null;
  }
  console.log(`[${ms().toFixed(0)}ms] welcome seen, settling 3.5s`);
  await sleep(3500);

  if (prompt && sendDelayMs > 0) await sleep(sendDelayMs);
  if (prompt) {
    console.log(`[${ms().toFixed(0)}ms] sending: ${JSON.stringify(prompt)}`);
    child.write(prompt + '\r');
  } else {
    console.log(`[${ms().toFixed(0)}ms] no prompt — pure idle observation`);
  }

  const driver = makeDriver();
  const ticks = [];
  const observedGlyphs = new Set();
  const observedGerunds = new Set();
  const stateChanges = [];

  const tickDeadline = Date.now() + totalMs;
  let tickIndex = 0;
  while (Date.now() < tickDeadline) {
    await sleep(TICK_MS);
    tickIndex += 1;
    const tail = bufferTailFromRaw(rawAccum, 40);
    const before = driver.snapshot().dispatchedState;
    const out = driver.tick(tail);

    // Capture observed glyphs and gerunds anywhere in the tail (not just the
    // single match the classifier picks) so we get the full alphabet seen.
    for (const line of tail) {
      const cap = line.match(SPINNER_CAPTURE_RE);
      if (cap) {
        observedGlyphs.add(cap[1]);
        observedGerunds.add(cap[2]);
      }
    }

    if (out.dispatched) {
      stateChanges.push({ t: ms(), from: before, to: out.dispatchedState, escalation: out.escalation });
      console.log(`[${ms().toFixed(0)}ms] DISPATCH ${before} → ${out.dispatchedState}${out.escalation ? ' (escalation: ' + out.escalation + ')' : ''}`);
    }

    ticks.push({
      t: Math.round(ms()),
      class: out.result.class,
      spinnerGlyph: out.result.spinnerGlyph,
      mapped: out.mapped,
      escalation: out.escalation,
      streak: out.pendingStreak,
      dispatched: out.dispatchedState,
    });

    // Optional early termination if the response is clearly complete and the
    // scenario asked for it (e.g. quick scenario doesn't need to keep running
    // after spinner has been gone for 5s).
    if (killOnComplete && out.result.class === 'unknown') {
      const recentTicks = ticks.slice(-5);
      const allUnknown = recentTicks.length === 5 && recentTicks.every((t) => t.class === 'unknown');
      if (allUnknown && tickIndex > 10) {
        console.log(`[${ms().toFixed(0)}ms] response apparently complete — early termination`);
        break;
      }
    }
  }

  child.kill();
  await sleep(300);

  // Save raw + tail for inspection.
  const tracePath = path.join(__dirname, `attention-${name}.log`);
  const lastTail = bufferTailFromRaw(rawAccum, 60);
  fs.writeFileSync(
    tracePath,
    [
      `=== ${name}`,
      `glyphs: ${[...observedGlyphs].join(' ') || '(none)'}`,
      `gerunds: ${[...observedGerunds].join(', ') || '(none)'}`,
      ``,
      `=== state changes`,
      ...stateChanges.map((c) => `[${c.t.toFixed(0)}ms] ${c.from} → ${c.to}${c.escalation ? ' (' + c.escalation + ')' : ''}`),
      ``,
      `=== per-tick log`,
      ...ticks.map((t) => `t=${t.t.toString().padStart(5)}ms class=${t.class.padEnd(16)} glyph=${(t.spinnerGlyph ?? '-').padEnd(2)} mapped=${t.mapped.padEnd(7)} streak=${String(t.streak).padStart(2)} dispatched=${t.dispatched}${t.escalation ? ' esc=' + t.escalation : ''}`),
      ``,
      `=== last 60 stripped lines`,
      ...lastTail,
    ].join('\n'),
  );

  return {
    name,
    ticks,
    stateChanges,
    observedGlyphs: [...observedGlyphs],
    observedGerunds: [...observedGerunds],
    tracePath,
  };
}

// --- main -----------------------------------------------------------------

async function main() {
  console.log(`platform=${process.platform} node=${process.version}`);

  const scenarios = [];

  scenarios.push(await runScenario({
    name: 'idle',
    prompt: null,
    sendDelayMs: 0,
    totalMs: 25_000,
  }));

  scenarios.push(await runScenario({
    name: 'quick-prompt',
    prompt: 'say hi',
    sendDelayMs: 0,
    totalMs: 35_000,
    killOnComplete: true,
  }));

  scenarios.push(await runScenario({
    name: 'long-prompt',
    prompt: 'tell me a 200-word story about a robot finding a flower',
    sendDelayMs: 0,
    totalMs: 35_000,
    killOnComplete: false,  // run full 35s so we can see the 20s no-spinner-stuck escalation
  }));

  // --- summary --------------------------------------------------------
  console.log(`\n${'='.repeat(70)}\nSUMMARY\n${'='.repeat(70)}`);
  for (const s of scenarios) {
    if (!s) { console.log(`(scenario aborted)`); continue; }
    const stateSeq = s.stateChanges.map((c) => `${c.from}→${c.to}`).join(' / ') || '(no dispatch — stayed ok)';
    const classes = new Set(s.ticks.map((t) => t.class));
    console.log(`\n${s.name}:`);
    console.log(`  state changes:    ${stateSeq}`);
    console.log(`  classes observed: ${[...classes].join(', ')}`);
    console.log(`  glyphs:           ${s.observedGlyphs.join(' ') || '(none)'}`);
    console.log(`  gerunds:          ${s.observedGerunds.join(', ') || '(none)'}`);
    console.log(`  trace file:       ${s.tracePath}`);
  }

  // Cross-scenario glyph/gerund union — the most useful artifact for
  // refreshing the classifier regex's empirical-glyph comment block.
  const allGlyphs = new Set();
  const allGerunds = new Set();
  for (const s of scenarios) {
    if (!s) continue;
    s.observedGlyphs.forEach((g) => allGlyphs.add(g));
    s.observedGerunds.forEach((g) => allGerunds.add(g));
  }
  console.log(`\nCROSS-SCENARIO`);
  console.log(`  unique glyphs:  ${[...allGlyphs].sort().join(' ') || '(none)'}`);
  console.log(`  unique gerunds: ${[...allGerunds].sort().join(', ') || '(none)'}`);

  // Compare against the regex's documented set.
  const documented = new Set(['✻','✽','✢','✳','✶','*','⏺','◉','·']);
  const newGlyphs = [...allGlyphs].filter((g) => !documented.has(g));
  if (newGlyphs.length) {
    console.log(`\n!! NEW GLYPHS not in attention-classifier.ts SPINNER_RE:`);
    console.log(`   ${newGlyphs.join(' ')}`);
    console.log(`   Update the regex character class and the comment block in attention-classifier.ts.`);
  } else {
    console.log(`\nAll observed glyphs are covered by the current regex.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
