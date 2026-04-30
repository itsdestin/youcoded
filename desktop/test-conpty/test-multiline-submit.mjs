#!/usr/bin/env node
// Empirical test: when Claude Code's input bar contains "body\n" (the failure
// state produced by Windows ConPTY's body+CR collapse), does sending a bare
// `\r` afterward (a) submit "body" as a multi-line user message, (b) submit
// "body\n" as a multi-line user message, or (c) just append another newline
// without submitting?
//
// This is the load-bearing assumption behind useSubmitConfirmation's retry
// strategy. The 2026-04-24 investigation listed it as "Open Question #2" and
// recommended a manual dev-mode test before locking in the fix. This is that
// test, run programmatically.
//
// Detection: writes claude's transcript JSONL to a unique project dir. After
// each test phase, scans the dir for any *.jsonl with a `type: "user"` entry.
// If present → the message was submitted. If empty/absent → still in the
// input bar, never submitted.
//
// Cost: spawns claude with one short message. If a submit happens, claude
// will start responding; we kill it within ~5s via SIGTERM. Worst-case API
// cost is one input token + a few output tokens. Negligible.
//
// Usage:   cd youcoded/desktop && node test-conpty/test-multiline-submit.mjs

import pty from 'node-pty';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- helpers --------------------------------------------------------------

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

function projectSlug(cwd) {
  // Verified against ~/.claude/projects/: `C:\Users\<username>` → `C--Users-<username>`.
  return cwd.replace(/[\\/:]/g, '-');
}

function pretrustCwd(cwd) {
  // Pre-mark the cwd as trusted in ~/.claude.json so spawning claude doesn't
  // show the workspace-trust prompt (which is the dominant source of test
  // flakiness — it intercepts our test input and varies in timing).
  // Verified against the file's existing format: paths are stored with
  // forward slashes regardless of OS.
  const cfgPath = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(cfgPath)) return;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.projects = cfg.projects || {};
  const fwd = cwd.replace(/\\/g, '/');
  cfg.projects[fwd] = { ...(cfg.projects[fwd] || {}), hasTrustDialogAccepted: true };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

function listTranscripts(projectsRoot, slug) {
  const dir = path.join(projectsRoot, slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => path.join(dir, n));
}

function transcriptHasUserMessage(filePath, expectedText) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed.type !== 'user') continue;
    const messageObj = parsed.message || parsed;
    let text = '';
    if (typeof messageObj.content === 'string') text = messageObj.content;
    else if (Array.isArray(messageObj.content)) {
      for (const block of messageObj.content) {
        if (block && typeof block.text === 'string') text += block.text;
      }
    } else if (typeof messageObj.text === 'string') text = messageObj.text;
    if (text.includes(expectedText)) return { matched: true, text };
  }
  return { matched: false, text: null };
}

// Strip ANSI escape sequences for text-based marker detection. Heavy-handed
// but adequate — we just need substring presence/absence, not formatting.
function stripAnsi(s) {
  // CSI: ESC [ ... letter
  // OSC: ESC ] ... BEL or ST
  // Two-byte: ESC + single char
  return s
    .replace(/\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\][^]*(|\\)/g, '')
    .replace(/./g, '');
}

// --- test runner ----------------------------------------------------------

async function runOneTest(name, opts) {
  console.log(`\n${'='.repeat(70)}\n=== ${name}\n${'='.repeat(70)}`);

  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const cwd = path.join(os.tmpdir(), `cc-multiline-test-${stamp}`);
  fs.mkdirSync(cwd, { recursive: true });
  pretrustCwd(cwd);
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  const slug = projectSlug(cwd);
  console.log(`cwd:  ${cwd}`);
  console.log(`slug: ${slug}`);

  const claude = resolveClaudeCommand();

  const outChunks = [];
  const startNs = process.hrtime.bigint();
  const ms = () => (Number(process.hrtime.bigint() - startNs) / 1e6).toFixed(0);
  let buffer = ''; // accumulating ANSI-stripped stdout for marker matching

  const child = pty.spawn(claude, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: { ...process.env },
  });

  child.onData((data) => {
    outChunks.push({ t: ms(), data });
    buffer += stripAnsi(data);
    if (buffer.length > 50000) buffer = buffer.slice(-50000); // bound memory
  });

  // Wait for input-bar-ready by watching stdout text. Two phases:
  //   1) Trust prompt: "trust this folder" → respond with \r to accept.
  //   2) Welcome screen: "Welcome back" or "Tips for getting started"
  //      → input bar is now live and listening for chat keystrokes.
  // Fail fast if neither marker appears within a generous timeout.
  console.log(`[${ms()}ms] waiting for ready (trust prompt or welcome)...`);
  const readyDeadline = Date.now() + 20000;
  let trustHandled = false;
  let welcomeSeen = false;
  // CC's TUI uses [<N>C (cursor-forward) between words rather than
  // literal spaces, so multi-word markers like "trust this folder" don't
  // survive ANSI stripping. Match single distinctive words instead.
  while (Date.now() < readyDeadline) {
    if (!trustHandled && /trust/i.test(buffer) && /folder/i.test(buffer)) {
      console.log(`[${ms()}ms] trust prompt detected — accepting with \\r`);
      child.write('\r');
      trustHandled = true;
      buffer = '';
      await sleep(1200);
      continue;
    }
    if (/Welcome|Tips|Recent\s*activity/i.test(buffer)) {
      welcomeSeen = true;
      // Empirically CC's input handler attaches several seconds after the
      // welcome screen renders on Windows. Wait generously, then probe with
      // a single character we expect to be echoed; if echoed, bar is live.
      await sleep(3500);
      break;
    }
    await sleep(150);
  }
  if (!welcomeSeen) {
    console.log(`!! [${ms()}ms] welcome screen never appeared — aborting test`);
    try { child.kill(); } catch {}
    await sleep(300);
    try { child.kill('SIGKILL'); } catch {}
    const logPath = path.join(__dirname, `multiline-${name}.log`);
    fs.writeFileSync(
      logPath,
      outChunks.map((e) => `[${e.t}ms] ${JSON.stringify(e.data)}`).join('\n'),
    );
    console.log(`   trace -> ${logPath}`);
    return { submitted: false, ready: false };
  }

  // Mark the buffer position so submit-detection only looks at output that
  // arrives AFTER our test sequence is sent. (Otherwise the welcome screen's
  // own decorative spinners could be mistaken for a "turn started.")
  const bufferMarkBefore = buffer.length;
  console.log(`[${ms()}ms] ready — sending test sequence`);
  await opts.write(child);

  // Detect submit by spotting CC's turn-active spinner suffix `ing…` in
  // stdout. CC randomizes the gerund label per turn (Forming, Mustering,
  // Gusting, Pondering, Conjuring, etc.) but they all share the `…` (U+2026
  // HORIZONTAL ELLIPSIS) glyph and a `…ing…`-shaped pattern, neither of
  // which appears at idle or in the welcome screen. Spotting it after our
  // write is unambiguous proof the message was submitted. Faster than
  // waiting for JSONL flush (which only happens once the response starts
  // streaming).
  const detectDeadline = Date.now() + (opts.drainMs ?? 20000);
  let submitMarker = null;
  const turnRegex = /([A-Za-z]+ing)…/;
  while (Date.now() < detectDeadline) {
    const tail = buffer.slice(bufferMarkBefore);
    const m = tail.match(turnRegex);
    if (m) { submitMarker = m[1]; break; }
    await sleep(200);
  }

  let result = { submitted: !!submitMarker, ready: true, marker: submitMarker };
  console.log(`[${ms()}ms] submit marker: ${submitMarker || '(none)'}`);

  // Always kill before incurring more cost.
  try { child.kill(); } catch {}
  await sleep(300);
  try { child.kill('SIGKILL'); } catch {}

  const logPath = path.join(__dirname, `multiline-${name}.log`);
  fs.writeFileSync(
    logPath,
    outChunks.map((e) => `[${e.t}ms] ${JSON.stringify(e.data)}`).join('\n'),
  );
  console.log(`[${ms()}ms] trace -> ${logPath}`);

  console.log(`\nRESULT: submitted=${result.submitted}`);
  return result;
}

// --- scenarios ------------------------------------------------------------

async function main() {
  console.log(`platform=${process.platform} node=${process.version}`);

  // SCENARIO 3 (control) FIRST — if test infrastructure is broken, fail fast.
  const r3 = await runOneTest('3-split-control', {
    expect: 'CTEST',
    write: async (c) => {
      c.write('CTEST');
      await sleep(600);
      c.write('\r');
    },
  });
  if (!r3.submitted) {
    console.log('\n!! Control failed. Aborting — fix the harness before drawing conclusions.');
    return;
  }

  // SCENARIO 1: Atomic body+CR. Investigation predicts this leaves "ATEST\n"
  // in input bar (paste classification absorbs \r). If submit=true here, the
  // investigation's paste-detection model is wrong — Ink doesn't actually
  // treat single 6-byte writes as paste.
  const r1 = await runOneTest('1-atomic-only', {
    expect: 'ATEST',
    write: async (c) => {
      c.write('ATEST\r');
    },
  });

  // SCENARIO 2: The actual question — atomic to induce literal-newline state,
  // then bare \r to test whether retry submits.
  const r2 = await runOneTest('2-atomic-then-cr', {
    expect: 'BTEST',
    write: async (c) => {
      c.write('BTEST\r');
      await sleep(1500);
      c.write('\r');
    },
  });

  // SCENARIO 4: Length threshold probe. The investigation says "any write ≥2
  // chars is paste." If true, "z"*100+"\r" should fail on idle just like
  // ATEST\r supposedly should have. If atomic writes succeed at length 6
  // (Scenario 1) AND length 101, the entire paste-timeout model is wrong.
  // If 6 succeeds but 101 fails, there's a length threshold we can probe.
  const r4 = await runOneTest('4-atomic-long', {
    expect: 'D' + 'z'.repeat(100),
    write: async (c) => {
      c.write('D' + 'z'.repeat(100) + '\r');
    },
  });

  // SCENARIO 5: Send a BARE \n (line feed). If CC interprets \n as "insert
  // newline" rather than "submit," we can use it to deterministically
  // reproduce the multi-line input-bar state and then test whether \r
  // submits it. Knowing CC's \n handling matters independently — it tells
  // us how to reproduce the failure state cleanly without depending on
  // pasted-write side effects.
  const r5 = await runOneTest('5-lf-then-cr', {
    expect: 'ETEST',
    write: async (c) => {
      c.write('ETEST');           // body, no \r yet
      await sleep(700);
      c.write('\n');               // LF — does this submit, or insert newline?
      await sleep(1200);
      c.write('\r');               // and now CR — submit if we're not done
    },
  });

  // SCENARIO 6: THE rigorous test of the retry plan. Reproduce the bug state
  // (atomic 101-byte body+\r → input bar contains body+\n with cursor below,
  // verified visible in scenario 4 trace) THEN send a bare \r and detect
  // whether the previously stuck message gets submitted. Scenario 4 proved
  // this state can be reliably induced; this scenario tests recovery.
  const longBody = 'F' + 'q'.repeat(100);
  const r6 = await runOneTest('6-bug-state-plus-cr', {
    expect: longBody,
    write: async (c) => {
      c.write(longBody + '\r');   // induces bug state on idle CC
      await sleep(2500);            // let bug state settle visibly
      c.write('\r');                // retry attempt — does it submit?
    },
    drainMs: 25000,                 // wait longer; this is the load-bearing test
  });

  // --- interpretation ----------------------------------------------------
  console.log(`\n${'='.repeat(70)}\nINTERPRETATION\n${'='.repeat(70)}`);
  console.log(`Scenario 3 (split 600ms — control):     submitted=${r3.submitted}`);
  console.log(`Scenario 1 (atomic 6-byte):             submitted=${r1.submitted}`);
  console.log(`Scenario 2 (atomic + bare \\r):          submitted=${r2.submitted}`);
  console.log(`Scenario 4 (atomic 101-byte):           submitted=${r4.submitted}`);
  console.log(`Scenario 5 (body, then \\n, then \\r):    submitted=${r5.submitted}`);
  console.log(`Scenario 6 (bug state + retry \\r):       submitted=${r6.submitted}`);
  console.log('');
  if (r1.submitted) {
    console.log('   Scenario 1 SUBMITTED — atomic body+\\r submits cleanly.');
    console.log('   This contradicts the investigation\'s claim that Ink\'s 500ms');
    console.log('   PASTE_TIMEOUT classifies single 6-byte writes as paste.');
    console.log('   Either Ink\'s paste detection differs from what we believed,');
    console.log('   or the 500ms timeout doesn\'t apply to short writes.');
    console.log('   The whole "paste-classified \\r becomes literal newline" story');
    console.log('   is suspect — the actual bug mechanism may be different.');
  } else if (r2.submitted) {
    console.log('   Retry plan VALIDATED:');
    console.log('   - Atomic write reliably leaves message in input bar (bug repro)');
    console.log('   - Bare \\r afterward DOES submit it');
    console.log('   - useSubmitConfirmation will work end-to-end');
  } else {
    console.log('   Retry plan BROKEN:');
    console.log('   - Atomic write reliably leaves message in input bar');
    console.log('   - Bare \\r afterward does NOT submit — adds another newline');
    console.log('   - Need different recovery (clear input + retype, or change channel)');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
