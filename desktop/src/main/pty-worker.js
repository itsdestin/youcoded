#!/usr/bin/env node
// PTY Worker — runs in a separate Node.js process (not Electron)
// so that node-pty uses Node's native binary, not Electron's.
// Communicates with the Electron main process via IPC (process.send).

const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Diagnostic trace — gated on YOUCODED_PTY_TRACE=1. Captures the timing of
// every input arrival, every chunk write, the trailing-CR write, and every
// output (PTY → child echo) chunk. Lets us see whether the 600ms gap between
// body and CR (set by the Ink/ConPTY paste-mode fix) is actually a 600ms gap
// from the child's perspective, or whether ConPTY backpressure collapses it
// when Claude Code is busy reading. Writes to ~/.claude/youcoded-pty-trace-<pid>.log
// (truncated on worker startup). When the flag is unset, all trace calls are
// no-ops with zero overhead.
const TRACE_ENABLED = !!process.env.YOUCODED_PTY_TRACE;
const TRACE_START_NS = process.hrtime.bigint();
let TRACE_FILE = null;
function traceMs() {
  return (Number(process.hrtime.bigint() - TRACE_START_NS) / 1e6).toFixed(3);
}
function tracePreview(s, n) {
  const max = n || 60;
  const str = typeof s === 'string' ? s : String(s);
  const trimmed = str.length > max ? str.slice(0, max) + '…' : str;
  return JSON.stringify(trimmed);
}
function trace(event, payload) {
  if (!TRACE_ENABLED) return;
  if (TRACE_FILE === null) {
    TRACE_FILE = path.join(os.homedir(), '.claude', `youcoded-pty-trace-${process.pid}.log`);
    try {
      fs.mkdirSync(path.dirname(TRACE_FILE), { recursive: true });
      fs.writeFileSync(TRACE_FILE, '');
    } catch { /* logging is best-effort */ }
  }
  const line = `[${traceMs()}ms pid=${process.pid}] ${event}${payload ? ' ' + payload : ''}\n`;
  try { fs.appendFileSync(TRACE_FILE, line); } catch { /* best-effort */ }
}

// Resolve a command to its absolute path by searching PATH (+ PATHEXT on Windows).
// Uses only Node builtins — the `which` npm package is unavailable here because it
// lives inside the asar archive, which this child process can't read.
// On macOS/Linux, pty.spawn can resolve bare command names via execvp, but Windows
// ConPTY cannot — it needs an absolute path. This function handles both platforms.
function resolveCommand(cmd) {
  // On Windows, check PATHEXT extensions (.cmd, .exe, etc.)
  // On Unix, just check the bare name (extensions array = [''])
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const full = path.join(dir, cmd + ext);
      if (fs.existsSync(full)) return full;
    }
  }
  return cmd; // fallback to bare name (works on macOS/Linux via execvp)
}

let ptyProcess = null;

// Strip ANSI control sequences for substring-matching against PTY output.
// CC's input-bar render uses CSI cursor-positioning + color escapes between
// the literal echoed characters; stripping makes a "needle in echo" search
// reliable without parsing the full VT state machine.
function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '');
}

// Serialize input handling so message A's echo wait doesn't confuse with
// message B's echo bytes. Each 'input' message is enqueued and awaited.
let inputQueue = Promise.resolve();

// Submit-protocol constants. PASTE_THRESHOLD is the empirically-bisected
// ceiling for CC v2.1.119 (see test-conpty/snapshots/cc-2.1.119.json) —
// any single read of ≥PASTE_THRESHOLD bytes ending in `\r` triggers Ink's
// paste classification and `\r` becomes literal newline. SAFE_ATOMIC_LEN
// includes 8 bytes of headroom: an atomic body+`\r` write of ≤56 bytes
// total is well below the threshold, so even worst-case kernel coalescing
// cannot push it over.
const PASTE_THRESHOLD = 64;
const SAFE_ATOMIC_LEN = 56;
// CHUNK_SIZE is the largest body slice we send in one ptyProcess.write
// call. ConPTY's input pipe silently truncates writes >~600 bytes; 56
// stays well under that ceiling AND under the paste threshold (so even
// if a chunk is read alone, it's treated as keystrokes, not paste).
const CHUNK_SIZE = 56;
// CHUNK_DELAY_MS gives ConPTY a tick to drain between chunk writes.
// Doesn't have to clear the paste-classification window because the
// final `\r` is gated on echo, not on a timing gap.
const CHUNK_DELAY_MS = 30;
// ECHO_TIMEOUT_MS bounds the wait for the body's tail to echo back from
// CC. Cold-start CC takes 6-7 s for first input render (per snapshot);
// warm session is typically <500 ms. 12 s leaves comfortable margin.
const ECHO_TIMEOUT_MS = 12000;
// ECHO_TAIL_LEN is the suffix of the body we look for in stdout.
// Long enough to be unambiguous against welcome-screen text and prior
// echo content; short enough to fit in any body that takes the
// echo-driven path.
const ECHO_TAIL_LEN = 16;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Write a body in CHUNK_SIZE pieces with small inter-chunk gaps. Returns
// once all bytes have been handed to ptyProcess.write — does NOT wait for
// CC to consume them.
// A chunk boundary must never fall BETWEEN the two halves of a surrogate pair —
// slice() cuts UTF-16 code units, so a boundary inside an emoji or a non-BMP
// path character would send two broken halves and the child would render
// garbage. Backing off by one keeps the pair whole; every chunk stays <=
// CHUNK_SIZE units, which is what the ConPTY thresholds are measured in.
// WHY bytes, not `String.length` (2026-09-16, claude-code-integration.md): every
// threshold in this file is a count of BYTES on the pipe — that is what the
// kernel and Claude Code's paste classifier see — but the comparisons used
// `.length`, which counts UTF-16 code units. A 30-character Chinese or emoji
// message is 90–120 bytes, so it sailed through the "atomic" path at 56
// characters, crossed the 64-byte paste threshold, and its `\r` arrived as a
// literal newline instead of a submit. Same fix on Android (PtyBridge.kt).
function byteLen(s) { return Buffer.byteLength(s, 'utf8'); }

async function writeChunked(body) {
  if (byteLen(body) <= CHUNK_SIZE) {
    if (!ptyProcess) return;
    ptyProcess.write(body);
    trace('CHUNK', `k=1/1 len=${body.length}`);
    return;
  }
  // Cut on CODE POINT boundaries at most CHUNK_SIZE BYTES apiece: `for..of`
  // walks code points, so a surrogate pair is never split, and the byte count
  // is what keeps each chunk under ConPTY's truncation ceiling and under the
  // paste threshold even when a chunk is read alone.
  const chunks = [];
  let cur = '';
  for (const ch of body) {
    if (cur && byteLen(cur) + byteLen(ch) > CHUNK_SIZE) { chunks.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) chunks.push(cur);
  for (let i = 0; i < chunks.length; i++) {
    if (!ptyProcess) return;
    ptyProcess.write(chunks[i]);
    trace('CHUNK', `k=${i + 1}/${chunks.length} len=${chunks[i].length}`);
    if (i < chunks.length - 1) await sleep(CHUNK_DELAY_MS);
  }
}

// Watch ptyProcess stdout for `needle` to appear in ANSI-stripped form.
// Resolves true on detection, false on timeout. Attaches a fresh listener
// for the duration of the wait — this coexists with the top-level onData
// handler that forwards data to main; both fire on each chunk.
function waitForEcho(needle, timeoutMs) {
  return new Promise((resolve) => {
    if (!ptyProcess) { resolve(false); return; }
    let buf = '';
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { disposable.dispose(); } catch { /* node-pty version w/o dispose */ }
      resolve(ok);
    };
    const disposable = ptyProcess.onData((data) => {
      // WHY the RAW bytes are kept and stripped on the whole (2026-09-16): the
      // escape sequences Claude Code paints its input bar with arrive split
      // across PTY chunks whenever the kernel read lands mid-sequence.
      // Stripping each chunk on its own left the two halves of a broken
      // sequence in the buffer as plain text — sitting between the needle's
      // characters — so a valid echo went unrecognised, the 12 s timeout ran
      // out, and the message's Enter was suppressed as if a menu had focus.
      buf += typeof data === 'string' ? data : String(data);
      // Bound buffer growth — only the recent tail can possibly contain
      // the needle, since the body is written contiguously.
      if (buf.length > 50000) buf = buf.slice(-50000);
      if (stripAnsi(buf).includes(needle)) finish(true);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function handleInput(text) {
  if (!ptyProcess) return;
  const endsCR = typeof text === 'string' && text.endsWith('\r');
  const inLen = typeof text === 'string' ? text.length : 0;
  trace('IN', `len=${inLen} endsCR=${endsCR} head=${tracePreview(text, 40)} tail=${tracePreview(typeof text === 'string' ? text.slice(-20) : '', 60)}`);

  // Path 1: Passthrough — anything not ending in \r (single bytes, raw
  // escapes, in-progress typing). Pass through unchanged, in ONE write.
  //
  // Do NOT chunk this path. A terminal paste ends in ESC[201~, not \r, so it
  // comes through here: chunking made a 10 KB paste 179 writes 30 ms apart —
  // 5.4 s with the input queue blocked behind it — which is a visible
  // regression in ordinary terminal use. The one caller that genuinely needs
  // chunking without a trailing \r is a shell session's initial command, and
  // it asks for it explicitly via the 'input-chunked' message below.
  if (!endsCR) {
    ptyProcess.write(text);
    trace('PASSTHROUGH', `len=${inLen}`);
    return;
  }

  const body = text.slice(0, -1);

  // Path 2: Atomic submit — body+\r fits below the paste threshold. Single
  // write; \r unambiguously a keystroke regardless of how the kernel reads
  // it. This is the common case for short chat messages.
  if (byteLen(text) <= SAFE_ATOMIC_LEN) {   // bytes — see byteLen's WHY
    ptyProcess.write(text);
    trace('ATOMIC', `len=${text.length} bytes=${byteLen(text)}`);
    return;
  }

  // Path 3: Echo-driven submit — body is too long to fit atomically.
  // Chunk the body, wait for its tail to echo back from CC (proving CC
  // has drained the body bytes from its pipe), then send `\r` as a single
  // byte (guaranteed below paste threshold and guaranteed to arrive in a
  // fresh kernel read).
  //
  // On echo timeout, DO NOT write a blind `\r`. No echo means CC is not
  // showing an input bar that accepted our body — most likely a live Ink
  // select menu (permission prompt / AskUserQuestion / plan approval) has
  // focus, and a bare `\r` would press Enter on the highlighted option,
  // silently auto-answering it (2026-07-09 stray-Enter fix). The
  // renderer-side useSubmitConfirmation retry recovers the genuinely-lost
  // case instead: it fires only when the session is observably idle with no
  // prompt pending (see pty-input-gate.ts), and its `\r` queues behind this
  // handler via inputQueue, so ordering is preserved.
  const tail = body.slice(Math.max(0, body.length - ECHO_TAIL_LEN));
  const echoStart = Date.now();
  trace('ECHO_WAIT', `tail=${tracePreview(tail, ECHO_TAIL_LEN)} timeout=${ECHO_TIMEOUT_MS}ms`);
  const echoPromise = waitForEcho(tail, ECHO_TIMEOUT_MS);
  await writeChunked(body);
  const echoed = await echoPromise;
  const echoMs = Date.now() - echoStart;
  if (!echoed) {
    trace('ECHO_TIMEOUT', `delayMs=${echoMs} — suppressing CR (renderer retry recovers)`);
    return;
  }
  trace('ECHO_OK', `delayMs=${echoMs}`);
  if (!ptyProcess) return;
  ptyProcess.write('\r');
  trace('CR', 'after-echo');
}

process.on('message', (msg) => {
  switch (msg.type) {
    case 'spawn': {
      // Resolve full path — node-pty on Windows needs it (no shell lookup)
      const shell = resolveCommand(msg.command || 'claude');
      const args = msg.args || [];
      // Fix: strip Claude Code's own session-identity env vars before spawning
      // the child CLI. When YouCoded itself is launched from inside a Claude Code
      // session (e.g. `bash scripts/run-dev.sh` run from the Bash tool, or any
      // terminal that is itself a CC session), the Electron process inherits
      // CLAUDECODE=1, CLAUDE_CODE_CHILD_SESSION=1, CLAUDE_CODE_SESSION_ID=<parent>,
      // etc. Passing those down makes the spawned `claude` believe it is a
      // NESTED/child session — and nested interactive CC does NOT write a
      // top-level transcript to ~/.claude/projects/<slug>/<id>.jsonl. With no
      // transcript file, the TranscriptWatcher (the sole source of chat-view
      // state) has nothing to read, so chat view stays permanently empty even
      // though the terminal/PTY shows output normally and hooks still fire.
      // Stripping these makes every session we spawn a clean top-level session
      // regardless of how YouCoded itself was launched.
      // See docs/PITFALLS.md → "Local Dev & Launch Environment".
      const childEnv = { ...process.env };
      delete childEnv.CLAUDECODE;
      delete childEnv.CLAUDE_CODE_CHILD_SESSION;
      delete childEnv.CLAUDE_CODE_SESSION_ID;
      delete childEnv.CLAUDE_CODE_ENTRYPOINT;
      delete childEnv.CLAUDE_CODE_EXECPATH;
      delete childEnv.CLAUDE_EFFORT;
      ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: msg.cols || 120,
        rows: msg.rows || 30,
        cwd: msg.cwd || require('os').homedir(),
        env: {
          ...childEnv,
          // WHY this default is injected only for Claude sessions: Claude
          // Code otherwise inherits the conversation model for subagents,
          // which can silently multiply a Fable-class bill. An explicit
          // launch-environment choice remains authoritative.
          ...(msg.sessionId ? {
            CLAUDE_CODE_SUBAGENT_MODEL: childEnv.CLAUDE_CODE_SUBAGENT_MODEL || 'sonnet',
          } : {}),
          // Pass our session ID so hook scripts can include it in payloads
          CLAUDE_DESKTOP_SESSION_ID: msg.sessionId || '',
          // Pass the unique pipe name so relay.js connects to the right instance
          CLAUDE_DESKTOP_PIPE: msg.pipeName || '',
        },
      });

      ptyProcess.onData((data) => {
        // OUT trace: the child echoing typed input back lands here. The smoking
        // gun for ConPTY backpressure is OUT events arriving AFTER the CR write
        // for the same submit (means the child wasn't draining the pipe until
        // body+CR were both queued).
        trace('OUT', `len=${typeof data === 'string' ? data.length : 0} head=${tracePreview(data, 60)}`);
        process.send({ type: 'data', data });
      });

      ptyProcess.onExit(({ exitCode }) => {
        trace('EXIT', `code=${exitCode}`);
        process.send({ type: 'exit', exitCode });
        process.exit(0);
      });

      trace('SPAWN', `cmd=${shell} session=${msg.sessionId || ''} cols=${msg.cols || 120} rows=${msg.rows || 30}`);
      process.send({ type: 'spawned', pid: ptyProcess.pid });
      break;
    }
    case 'input': {
      // Submit strategy for chat → CC, given empirically-pinned facts about
      // CC v2.1.119 (see test-conpty/snapshots/cc-2.1.119.json):
      //
      //   * Ink classifies any single read of ≥64 bytes ending in `\r` as
      //     paste — `\r` becomes a literal newline in the input bar instead
      //     of a submit keystroke. Any read <64 bytes ending in `\r` submits
      //     cleanly. Single-byte writes are always safe.
      //   * CC echoes typed bytes back through stdout (input-bar re-render).
      //     Cold-start delay can be 6+ s; warm session typically <500 ms.
      //   * Bracketed-paste markers (\x1b[200~...\x1b[201~) are mangled by
      //     Windows ConPTY (verified in test-conpty/harness.mjs Phase 8) —
      //     not a viable mechanism.
      //   * Windows ConPTY silently truncates writes >~600 chars; a 56-byte
      //     chunk cap stays well under that ceiling.
      //
      // Three paths cover every input shape without timing guesses:
      //
      //   1. Passthrough — input doesn't end in `\r` (raw escapes, single
      //      bytes, in-progress typing). Single write, no special handling.
      //   2. Atomic submit — input ends in `\r` AND total length ≤ 56. The
      //      whole write is below the paste threshold by design (8-byte
      //      margin), so `\r` is treated as a fresh keystroke regardless of
      //      coalescing. Single write, no race possible.
      //   3. Echo-driven submit — input ends in `\r` AND total length > 56.
      //      Chunk the body in 56-byte pieces, watch CC's stdout for the
      //      body's tail to echo back (proving CC has consumed the body
      //      bytes from its input pipe), then send `\r` as a separate
      //      single-byte write — guaranteed below the paste threshold and
      //      guaranteed to arrive in a fresh kernel read because the body
      //      bytes have already been drained.
      //
      // No 600 ms timing guess. No assumption about Ink's render scheduling.
      // The renderer-side useSubmitConfirmation retry stays as a third-line
      // defense if echo somehow doesn't arrive within ECHO_TIMEOUT_MS.
      if (!ptyProcess) break;
      inputQueue = inputQueue.then(() => handleInput(msg.data)).catch((e) => {
        trace('INPUT_ERROR', e && e.message ? e.message : String(e));
      });
      break;
    }
    case 'input-chunked': {
      // The ONE write that needs chunking without a trailing \r: a shell
      // session's initial "Run in terminal" command, which is deliberately left
      // unsubmitted for the user to press Enter on. Windows ConPTY silently
      // truncates a single write over ~600 chars, and a truncated command would
      // sit HALF-TYPED on the prompt for the user to run. Queued behind the same
      // inputQueue as 'input' so ordering with real keystrokes is preserved.
      if (!ptyProcess) break;
      inputQueue = inputQueue.then(() => writeChunked(msg.data)).catch((e) => {
        trace('INPUT_ERROR', e && e.message ? e.message : String(e));
      });
      break;
    }
    case 'resize': {
      if (ptyProcess) ptyProcess.resize(msg.cols, msg.rows);
      break;
    }
    case 'kill': {
      if (ptyProcess) ptyProcess.kill();
      break;
    }
  }
});

process.on('disconnect', () => {
  if (ptyProcess) ptyProcess.kill();
  process.exit(0);
});
