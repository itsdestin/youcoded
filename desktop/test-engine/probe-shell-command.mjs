#!/usr/bin/env node
// Probe: a "Run in terminal" command survives being typed into a REAL shell
// (2026-09-05, local-engine upgrades §F).
//
// What is under test is a TIMING rule no unit test can see, because a unit test
// mocks the PTY. SessionManager holds the command until the PTY's FIRST OUTPUT
// and writes it then, with NO trailing carriage return, so it sits on the
// prompt for the user to press Enter themselves.
//
// MEASURED, 2026-09-05, on this machine (fish 4, zsh 5, bash 5 — see the run
// below): writing on spawn ALSO survived on all three, because the kernel's tty
// line discipline buffers the bytes until the shell starts reading. That is
// luck, not a guarantee — it depends on no startup path calling tcflush, and it
// is exactly the kind of thing a shell's rc file or a future release changes.
// Waiting for the first output costs nothing and does not rely on it, which is
// why it is the rule that ships. If a shell is ever added here that FAILS the
// on-spawn row, that row is the evidence, not a regression.
//
// FAITHFULNESS MATTERS HERE. A bare node-pty is not a terminal: it answers none
// of the capability queries a shell asks at startup. fish blocks for TEN SECONDS
// waiting for a Primary Device Attribute reply before it will even print a
// prompt (measured on this machine, 2026-09-05), which makes every timing
// measurement against a bare PTY meaningless. In the real app the other end is
// xterm.js, which answers. So this probe answers them too — see reply() below.
//
// Three rules are measured per shell, so the numbers show what each one costs:
//   on-spawn            written immediately. Relies on the tty buffering it.
//   first-output        written on the first output frame. WHAT SHIPS, and the
//                       only row this probe passes or fails on.
//   first-output+quiet  written once output has been quiet for QUIET_MS. Kept as
//                       the fallback to reach for if a shell ever fails the row
//                       above — it waits for the prompt itself rather than for
//                       the first capability query.
// A fourth row, embedded-CR, is the THREAT rather than a rule: it types the
// same command with a carriage return inside it and shows that it RUNS ITSELF,
// with nobody touching the keyboard. That is why prepareRunInTerminal refuses a
// command containing one; this row is the measurement behind that refusal, and
// it is expected to report "ran on its own = true".
//
// HOW ARRIVAL IS MEASURED — by an EFFECT ON DISK, not by reading the output.
// Reading the output does not work: fish repaints its prompt line with bare
// carriage returns for autosuggestion and syntax colour, so the typed command is
// never a contiguous string in the output even when it arrived perfectly, and
// the repaint fragments happen to spell out any marker you search for (measured
// — two earlier versions of this probe scored fish wrong in both directions).
// So the command the probe types WRITES A FILE. The probe types it, waits, and
// checks the file does NOT exist — proving the app did not press Enter for the
// user — then presses Enter ITSELF, standing in for the user, and requires the
// file to appear. The file can only appear if the whole command reached the
// prompt, in order, uncorrupted.
//
// KNOWN LIMIT: this probe RE-IMPLEMENTS the write rule against a bare node-pty
// rather than driving SessionManager, so it proves the rule works on real
// shells, NOT that the app still follows it. tests/shell-session.test.ts is what
// pins the app to the rule; if that test is ever weakened, this probe would
// still pass. Both are needed.
//
// Usage: node test-engine/probe-shell-command.mjs [--shell /usr/bin/fish]...
// With no --shell it probes fish, zsh, bash and PowerShell, and SAYS which of
// them are not installed here rather than quietly passing.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
// node-pty is the native module pty-worker.js itself loads, built for this Node.
const pty = require(path.join(here, '..', 'node_modules', 'node-pty'));

// Harmless, and its only effect is a file in the temp dir — see the note above
// on why an on-disk effect is the only reliable evidence here. `echo x > path`
// is written the same way in fish, zsh, bash and PowerShell.
import os from 'os';
const RUN_FLAG = path.join(os.tmpdir(), `youcoded-shell-probe-${process.pid}-${Date.now()}`);
/** Output must be silent this long, after the first frame, before we type. */
const QUIET_MS = 400;
/** When the probe stands in for the user and presses Enter. */
const ENTER_AT_MS = 2500;
/** How long to watch each run before deciding. Generous: a shell with a heavy
 *  rc file (fish here paints a full-colour greeting) needs a second or two. */
const WATCH_MS = 5000;

function which(cmd) {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const full = path.join(dir, cmd);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
    .replace(/\x1b./g, '');
}

/** Answer the startup queries a real terminal answers, as xterm.js does in the
 *  app. Without this fish never prompts and every timing here is fiction. */
function reply(child, chunk) {
  // Primary Device Attributes — the one fish blocks ten seconds on.
  if (/\x1b\[0?c/.test(chunk)) child.write('\x1b[?1;2c');
  // Cursor position report.
  if (/\x1b\[6n/.test(chunk)) child.write('\x1b[1;1R');
  // Kitty keyboard protocol query.
  if (/\x1b\[\?u/.test(chunk)) child.write('\x1b[?0u');
  // XTVERSION.
  if (/\x1b\[>0?q/.test(chunk)) child.write('\x1bP>|xterm(370)\x1b\\');
  // OSC 11 — background colour.
  if (/\x1b\]11;\?/.test(chunk)) child.write('\x1b]11;rgb:0000/0000/0000\x1b\\');
  // XTGETTCAP is deliberately NOT answered. fish does not parse a DCS reply it
  // did not expect and passes the bytes straight through to its line editor —
  // an earlier version of this probe answered it and watched its own hex payload
  // get typed onto the prompt in front of the command, which fish then reported
  // as `Unknown command: 696e646e…`. Leaving it unanswered costs nothing: fish
  // blocks on the Primary DA above, not on this.
}

let flagSeq = 0;

/** One shell, one rule. rule: 'on-spawn' | 'first-output' | 'first-output+quiet' */
function run(shell, rule) {
  return new Promise((resolve) => {
    // A fresh flag path per run, so one run can never be credited to another.
    const flag = `${RUN_FLAG}-${flagSeq++}`;
    // The embedded-CR row types the SAME command with a carriage return in the
    // middle of it — the app appends none, and this shows why that is not
    // enough on its own.
    const COMMAND = rule === 'embedded-CR' ? `echo ran > ${flag}\r:` : `echo ran > ${flag}`;
    try { fs.rmSync(flag, { force: true }); } catch { /* nothing there */ }
    let raw = '';
    let wrote = false;
    let writtenAtMs = null;
    let quietTimer = null;
    const started = Date.now();
    const child = pty.spawn(shell, [], {
      name: 'xterm-256color', cols: 120, rows: 30, cwd: process.cwd(), env: { ...process.env },
    });
    const typeIt = () => {
      if (wrote) return;
      wrote = true;
      writtenAtMs = Date.now() - started;
      child.write(COMMAND);   // NO '\r' — the app never presses Enter.
    };
    if (rule === 'on-spawn') typeIt();
    child.onData((d) => {
      const chunk = typeof d === 'string' ? d : String(d);
      raw += chunk;
      reply(child, chunk);
      if (rule === 'first-output' || rule === 'embedded-CR') typeIt();
      if (rule === 'first-output+quiet' && !wrote) {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(typeIt, QUIET_MS);
      }
    });
    const didRun = () => fs.existsSync(flag);
    let ranBeforeEnter = false;
    setTimeout(() => {
      ranBeforeEnter = didRun();
      child.write('\r');   // the USER pressing Enter, which is the only way it runs
    }, ENTER_AT_MS);
    setTimeout(() => {
      clearTimeout(quietTimer);
      const ranAfterEnter = didRun();
      try { child.kill(); } catch { /* already gone */ }
      try { fs.rmSync(flag, { force: true }); } catch { /* best effort */ }
      resolve({
        ranBeforeEnter, ranAfterEnter, writtenAtMs,
        tail: stripAnsi(raw).trim().slice(-120),
      });
    }, WATCH_MS);
  });
}

const argv = process.argv.slice(2);
const explicit = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '--shell') explicit.push(argv[++i]);
const candidates = explicit.length ? explicit : ['fish', 'zsh', 'bash', 'pwsh', 'powershell.exe'];
const RULES = ['on-spawn', 'first-output', 'first-output+quiet', 'embedded-CR'];

let failures = 0;
let probed = 0;
const skipped = [];
for (const candidate of candidates) {
  const shell = which(candidate);
  if (!shell) { skipped.push(candidate); continue; }
  probed++;
  console.log(`\n${candidate}  (${shell})`);
  for (const rule of RULES) {
    const r = await run(shell, rule);
    // For the three rules, healthy = it waited for the user. For the threat row,
    // healthy = it did NOT wait, which is the whole point of showing it.
    const ok = rule === 'embedded-CR'
      ? r.ranBeforeEnter
      : !r.ranBeforeEnter && r.ranAfterEnter;
    const tag = rule === 'embedded-CR' ? (ok ? 'THREAT CONFIRMED' : 'not reproduced ') : (ok ? 'ok  ' : 'BAD ');
    console.log(
      `  ${tag} ${rule.padEnd(19)} typed at ${String(r.writtenAtMs).padStart(5)}ms · ` +
      `ran on its own=${r.ranBeforeEnter} · ran when the user pressed Enter=${r.ranAfterEnter}` +
      (ok ? '' : `\n         tail: ${JSON.stringify(r.tail)}`)
    );
    // Only the shipped rule is a pass/fail; the other rows are evidence.
    if (rule === 'first-output' && !ok) failures++;
  }
}

for (const s of skipped) console.log(`\nSKIP  ${s} — not installed on this machine, NOT probed.`);
if (!probed) { console.error('No shell was available to probe.'); process.exit(2); }
console.log(failures
  ? `\n${failures} of ${probed} shell(s) FAILED the shipped rule.`
  : `\nShipped rule passed on all ${probed} probed shell(s).`);
process.exit(failures ? 1 : 0);
