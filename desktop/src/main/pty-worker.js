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

// ── Output batching + flow control (2026-10-04, terminal flow control) ─────────────────────────
// Before this, every read from the PTY became its own process.send(), and nothing ever slowed the
// producer: a 200 MB `cat` was forwarded whole at 10-20k messages a second, the window's terminal
// (xterm) silently THREW AWAY everything past ~50 M pending characters (the last lines and the
// prompt never appeared), the main process stalled 150-580 ms, and this worker grew ~80 MB per flood.
//
// Two mechanisms, both here because this is the only place that can slow the program that is writing:
//
//  1. BATCHING. The first chunk after a quiet moment goes out IMMEDIATELY (a typed character's echo
//     and a Claude Code redraw pay nothing); chunks that follow within COALESCE_MS are merged and sent
//     together, or sooner once COALESCE_MAX characters pile up. A flood is therefore at most ~250
//     messages/s instead of ~10-20k. Chunks are only ever concatenated, never cut, so a multi-byte
//     character or escape sequence is never split by us.
//  2. CREDIT. `unacked` counts characters handed to main that the terminal has not yet finished
//     parsing (main relays the renderer's acknowledgements as {type:'ack'}). Above FLOW_HIGH we
//     pause() the PTY's read side, so the kernel's pty buffer fills and the PRODUCER blocks in
//     write() exactly as it would on a slow real terminal; at or below FLOW_LOW we resume().
//     Input (keystrokes, Ctrl+C) travels the other way, on the write side, and is never queued
//     behind output.
// Units are JS string length (UTF-16 units) end to end: the renderer acks `data.length` of what it
// wrote, so the two sides agree without counting bytes.
const COALESCE_MS = 4;
const COALESCE_MAX = 256 * 1024;
// Env overrides exist ONLY so tests can shrink the numbers (tests/pty-worker-flow.test.ts); the app never sets them.
const envNum = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const FLOW_HIGH = envNum('YOUCODED_PTY_FLOW_HIGH', 1024 * 1024);
const FLOW_LOW = envNum('YOUCODED_PTY_FLOW_LOW', 256 * 1024);
// A paused PTY with NO acknowledgement for this long means the other end is gone or wedged (renderer
// reloading, window closed mid-flood, a lost message), not slow: let one more FLOW_HIGH through and
// re-arm, so a lost ack degrades to a slow trickle instead of freezing the session for good.
const FLOW_STALL_MS = envNum('YOUCODED_PTY_FLOW_STALL_MS', 15000);
const FLOW_POLL_MS = 25;

let outBuf = '';
let outTimer = null;
let lastSendAt = 0;
let unacked = 0;
let flowPaused = false;
let flowDisabled = false;   // set once the PTY is exiting/killed: never pause again
let lastAckAt = 0;
let flowPoll = null;

// Date.now(), not hrtime: millisecond resolution is all the 4 ms window and the stall rule need, and it keeps
// the logic drivable with fake timers in tests/pty-worker-flow.test.ts.
function nowMs() { return Date.now(); }

function sendBatch(data) {
  unacked += data.length;
  lastSendAt = nowMs();
  process.send({ type: 'data', data });
  if (!flowPaused && !flowDisabled && unacked >= FLOW_HIGH) pauseFlow();
}

function flushOut() {
  if (outTimer !== null) { clearTimeout(outTimer); outTimer = null; }
  if (outBuf === '') return;
  const data = outBuf;
  outBuf = '';
  sendBatch(data);
}

function onPtyData(data) {
  if (typeof data !== 'string') data = String(data);
  if (outBuf === '' && outTimer === null) {
    const since = nowMs() - lastSendAt;
    if (since >= COALESCE_MS) { sendBatch(data); return; }   // idle: no added latency
    outBuf = data;
    outTimer = setTimeout(flushOut, COALESCE_MS - since);
    return;
  }
  outBuf += data;
  if (outBuf.length >= COALESCE_MAX) flushOut();
}

// WHY the poll: on Unix node-pty only reports a child's exit after the output socket has been read
// to its end — and gives up and DESTROYS the socket (dropping unread bytes, i.e. the final lines)
// 200 ms after the child exits. A paused socket never reads, so a pause that was still in force when
// the child exited would lose the tail. We therefore watch for the exit and resume at once. The
// fields are node-pty internals (Unix `_boundClose`/`_emittedClose`; Windows ConPTY
// `_agent._exitCode`); every read is guarded, and if they ever vanish the FLOW_STALL_MS rule below
// still releases a stuck pause.
function ptyHasExited() {
  try {
    if (!ptyProcess) return false;
    if (ptyProcess._boundClose || ptyProcess._emittedClose) return true;
    if (ptyProcess._agent && ptyProcess._agent._exitCode !== undefined) return true;
  } catch { /* internals changed — rely on the stall rule */ }
  return false;
}

function pauseFlow() {
  if (!ptyProcess || flowPaused) return;
  flowPaused = true;
  lastAckAt = nowMs();
  try { ptyProcess.pause(); } catch { flowPaused = false; return; }
  trace('FLOW_PAUSE', `unacked=${unacked}`);
  flowPoll = setInterval(() => {
    if (ptyHasExited()) { disableFlow('exited'); return; }
    if (nowMs() - lastAckAt >= FLOW_STALL_MS) {
      trace('FLOW_STALL', `unacked=${unacked}`);
      unacked = 0;   // forget what was lost; the next FLOW_HIGH re-arms the brake
      resumeFlow();
    }
  }, FLOW_POLL_MS);
}

function resumeFlow() {
  if (!flowPaused) return;
  flowPaused = false;
  if (flowPoll !== null) { clearInterval(flowPoll); flowPoll = null; }
  try { if (ptyProcess) ptyProcess.resume(); } catch { /* socket already gone */ }
  trace('FLOW_RESUME', `unacked=${unacked}`);
}

// Permanently stop applying backpressure (child exiting, kill, handoff, parent gone).
function disableFlow(why) {
  flowDisabled = true;
  trace('FLOW_OFF', why);
  resumeFlow();
}

function onAck(msg) {
  lastAckAt = nowMs();
  const n = Number(msg.n);
  if (Number.isFinite(n) && n > 0) unacked = Math.max(0, unacked - n);
  if (flowPaused && unacked <= FLOW_LOW) resumeFlow();
}

let ptyProcess = null;
let bounceState = null;   // repaint nudge in progress: { c, r, superseded }
let bounceTimer = null;
// node-pty's resize throws once the PTY fd is closed (child exited, kill, hand-off) and nothing here catches it.
const ptyUsable = () => !!ptyProcess && !exitReported && !handoffStopping;
function safeResize(cols, rows) {
  try { ptyProcess.resize(cols, rows); return true; }
  catch (e) { trace('RESIZE_ERROR', e && e.message ? e.message : String(e)); return false; }
}
// WHY report every size change to main IN STREAM ORDER (merge with one-core, 2026-10-05): main keeps a headless copy of each terminal
// (session-screens.ts) that reads the screen for the send gate and the prompt cards, and it lays text out at the size it is TOLD. The repaint
// nudge changes the PTY size here without main's resize path ever running, so the program's redraw at the narrower width was parsed at the old
// width (a wrapped or shortened row an input box could be misread from). Flushing the held batch first puts everything produced at the OLD
// size ahead of the size message; the program's redraw at the NEW size follows it.
function resizeAndReport(cols, rows) {
  flushOut();
  if (!safeResize(cols, rows)) return false;
  try { process.send({ type: 'size', cols, rows }); } catch { /* parent gone */ }
  return true;
}
function cancelBounce() { if (bounceTimer !== null) { clearTimeout(bounceTimer); bounceTimer = null; } bounceState = null; }
let handoffStopping = false;
let exitReported = false;
let handoffExitTimer = null;
let handoffExitAcknowledged = false;
const HANDOFF_ACK_TIMEOUT_MS = 20000; // Parent's stop wait is 15s; still bounded if main disappears.

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
    if (!ptyProcess || handoffStopping) return;
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
    if (!ptyProcess || handoffStopping) return;
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
  if (!ptyProcess || handoffStopping) return;
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
  if (!ptyProcess || handoffStopping) return;
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
        onPtyData(data);
      });

      ptyProcess.onExit(({ exitCode }) => {
        if (exitReported) return;
        exitReported = true;
        cancelBounce();
        trace('EXIT', `code=${exitCode}`);
        // WHY: the batch still waiting for its timer must reach main BEFORE the exit message,
        // or the last bytes of output (the final lines) would arrive after the session is gone.
        disableFlow('exit');
        flushOut();
        // WHY: send's callback means the frame was flushed, not that main
        // handled it. On handoff, wait for main's explicit receipt before exit
        // so a worker 'exit' event cannot overtake the PTY exit message there.
        // Bound the wait if main disappears without disconnect notification.
        if (handoffStopping) {
          handoffExitTimer = setTimeout(() => process.exit(1), HANDOFF_ACK_TIMEOUT_MS);
        }
        try {
          process.send({ type: 'exit', exitCode }, (error) => {
            if (handoffExitAcknowledged) return;
            if (error) { clearTimeout(handoffExitTimer); process.exit(1); }
            else if (!handoffStopping) process.exit(0);
          });
        } catch { clearTimeout(handoffExitTimer); process.exit(1); }
      });

      trace('SPAWN', `cmd=${shell} session=${msg.sessionId || ''} cols=${msg.cols || 120} rows=${msg.rows || 30}`);
      process.send({ type: 'spawned', pid: ptyProcess.pid });
      break;
    }
    case 'input': {
      if (handoffStopping) break;
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
      inputQueue = inputQueue.then(() => { if (!handoffStopping) return handleInput(msg.data); }).catch((e) => {
        trace('INPUT_ERROR', e && e.message ? e.message : String(e));
      });
      break;
    }
    case 'input-chunked': {
      if (handoffStopping) break;
      // The ONE write that needs chunking without a trailing \r: a shell
      // session's initial "Run in terminal" command, which is deliberately left
      // unsubmitted for the user to press Enter on. Windows ConPTY silently
      // truncates a single write over ~600 chars, and a truncated command would
      // sit HALF-TYPED on the prompt for the user to run. Queued behind the same
      // inputQueue as 'input' so ordering with real keystrokes is preserved.
      if (!ptyProcess) break;
      inputQueue = inputQueue.then(() => { if (!handoffStopping) return writeChunked(msg.data); }).catch((e) => {
        trace('INPUT_ERROR', e && e.message ? e.message : String(e));
      });
      break;
    }
    case 'ack': {
      // The terminal finished parsing `n` characters (relayed by main). See the flow-control block.
      onAck(msg);
      break;
    }
    case 'bounce': {
      // Repaint request after output was cut from the front of a backlog (the cursor position is unknown, and
      // programs like Claude Code's Ink UI redraw with relative cursor moves): one column narrower, then back.
      // ONE owner: a request during the 120 ms window is ignored (never narrows twice), and the restore returns to
      // the ORIGINAL size unless a real resize (desktop fit or a phone's) arrived meanwhile — then that size stands.
      // Never on Windows (ConPTY re-emits its whole buffer on every resize) and never once the PTY is going away:
      // node-pty's resize THROWS on a closed fd and this worker has no uncaught-exception handler, so a throw here
      // would kill the worker (the session would read as crashed; a hand-off would race its receipt handshake).
      if (!ptyUsable() || flowDisabled || process.platform === 'win32' || bounceState) break;
      const c = ptyProcess.cols, r = ptyProcess.rows;
      if (!(c > 2)) break;
      if (!resizeAndReport(c - 1, r)) break;          // bounceState is set only once the first half succeeded
      const st = { c, r, superseded: false };
      bounceState = st;
      bounceTimer = setTimeout(() => {
        bounceState = null; bounceTimer = null;
        if (ptyUsable() && !st.superseded) resizeAndReport(st.c, st.r);
      }, 120);
      break;
    }
    case 'resize': {
      if (bounceState) bounceState.superseded = true;   // a real resize wins over a repaint nudge in flight
      if (ptyUsable()) resizeAndReport(msg.cols, msg.rows);
      break;
    }
    case 'stop-for-handoff': {
      // WHY: unlike ordinary kill, no immediate disconnect or synthetic exit;
      // only node-pty's onExit callback may acknowledge this shutdown.
      if (handoffStopping) break;
      handoffStopping = true;
      cancelBounce();
      disableFlow('handoff');
      if (ptyProcess) ptyProcess.kill();
      break;
    }
    case 'handoff-exit-received': {
      if (handoffStopping && exitReported && !handoffExitAcknowledged) {
        handoffExitAcknowledged = true;
        clearTimeout(handoffExitTimer);
        process.exit(0);
      }
      break;
    }
    case 'kill': {
      disableFlow('kill');   // a paused read side would hold the exit open
      if (ptyProcess) ptyProcess.kill();
      break;
    }
  }
});

process.on('disconnect', () => {
  clearTimeout(handoffExitTimer);
  cancelBounce();
  flowDisabled = true;
  if (ptyProcess) ptyProcess.kill();
  process.exit(0);
});
