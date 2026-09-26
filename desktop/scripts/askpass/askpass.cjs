'use strict';
// askpass.cjs — the process youcoded-askpass execs into, running as plain
// Node (ELECTRON_RUN_AS_NODE=1) under the environment the wrapper scrubbed.
// This is the process AskpassServer's verification chain (design §3) checks
// the real exe/argv/env of, and the process that actually holds the user's
// sudo password for a few milliseconds. CommonJS, no build step: it has to
// run byte-for-byte as shipped, from a real file outside app.asar (review 3,
// F1), under a Node runtime with no bundler in front of it.
//
// Deliberately requires NOTHING beyond core Node modules and koffi. Every
// other app module (logger.ts, etc.) runs inside the main process's own
// event loop and its own module graph; pulling any of that in here would
// mean trusting `require()` resolution paths this script has no business
// depending on, and would make "what does the verified helper actually do"
// harder to audit by reading this one file top to bottom.
const fs = require('fs');
const net = require('net');
const path = require('path');

// WHY a byte cap on the one line we read: sudo (and, before verification
// ever runs, anything posing as sudo) is untrusted input. Without a cap a
// malicious or buggy peer could stream data forever and grow this
// process's heap; 4 KB is far more than {"ok":true,"password":"..."} ever
// needs for a real password.
const MAX_LINE_BYTES = 4096;

/**
 * Resolve koffi from the app's own tree, never a bare `require('koffi')`.
 * WHY: electron-builder's asarUnpack keeps this file's own directory
 * (scripts/askpass/) and node_modules/koffi as SIBLINGS of the same app
 * root in both layouts — dev's desktop/ and the packaged
 * app.asar.unpacked/ (review 3, F1) — so `../../node_modules/koffi`
 * relative to this file resolves to the right copy in both. Naming the
 * exact directory (rather than letting `require('koffi')` fall through
 * Node's ordinary resolution, which also consults NODE_PATH and other
 * hooks) means this always loads THIS app's own koffi or fails outright —
 * never something else that happens to resolve first on some future
 * caller's environment.
 */
function requireKoffi() {
  const candidate = path.join(__dirname, '..', '..', 'node_modules', 'koffi');
  if (!fs.existsSync(candidate)) {
    throw new Error('koffi not found next to app root: ' + candidate);
  }
  return require(candidate);
}

/**
 * Make this process unreadable to other same-uid processes BEFORE it ever
 * touches the socket (design §3, review 2 E1). `env -i` and `ulimit -c 0`
 * in the wrapper only cover environment variables and core dumps; sudo's
 * own fork chain (setuid(0) -> setuid(uid) -> exec) leaves this process
 * with real uid == effective uid, i.e. an ORDINARY same-uid process,
 * subject to same-uid ptrace and signal delivery like anything else the
 * model's command runs. PR_SET_DUMPABLE=0 (Linux) / PT_DENY_ATTACH (macOS)
 * closes that regardless of what happened upstream.
 *
 * Returns false (never throws) on any failure, so the caller can fail
 * closed uniformly.
 */
function hardenSelf() {
  let koffi;
  try {
    koffi = requireKoffi();
  } catch {
    return false;
  }
  try {
    if (process.platform === 'linux') {
      // WHY libc.so.6, prctl(PR_SET_DUMPABLE=4, 0, ...): the same raw-FFI
      // technique window-exclude-capture.ts already uses for user32.dll,
      // pointed at glibc instead. PR_SET_DUMPABLE's value is documented in
      // linux/prctl.h; passing 0 as the second argument means "not
      // dumpable" (SUID_DUMP_DISABLE) — no core dumps, and same-uid
      // ptrace_may_access() then requires CAP_SYS_PTRACE, which the model's
      // command does not have.
      const libc = koffi.load('libc.so.6');
      const prctl = libc.func(
        'int prctl(int option, unsigned long arg2, unsigned long arg3, unsigned long arg4, unsigned long arg5)',
      );
      const PR_SET_DUMPABLE = 4;
      return prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) === 0;
    }
    if (process.platform === 'darwin') {
      // WHY libSystem.B.dylib, ptrace(PT_DENY_ATTACH=31, ...): the OpenSSH
      // agent's own technique for exactly this threat on macOS — there is
      // no PR_SET_DUMPABLE equivalent; PT_DENY_ATTACH is the platform's
      // answer, callable with the target pid/addr/data left at 0 because
      // PT_DENY_ATTACH ignores them (it acts on the calling process).
      // UNVERIFIED ON A REAL MAC as of this change (design §3.1 ships the
      // macOS peer-environment check switched off for the same reason);
      // this call is implemented from the documented syscall signature.
      const libSystem = koffi.load('libSystem.B.dylib');
      const ptrace = libSystem.func(
        'int ptrace(int request, int pid, void *addr, int data)',
      );
      const PT_DENY_ATTACH = 31;
      return ptrace(PT_DENY_ATTACH, 0, 0, 0) === 0;
    }
    // Windows/other: sudo has no askpass mechanism there and the wrapper is
    // a POSIX sh script that never runs on Windows (R19). Fail closed
    // rather than silently skip hardening on a platform this was never
    // written for.
    return false;
  } catch {
    return false;
  }
}

/**
 * Linux-only second check, run only after hardenSelf() has already
 * succeeded (design §3, review 2 E1): refuse to continue if something is
 * ALREADY tracing us. PR_SET_DUMPABLE stops a FUTURE ptrace attach; it does
 * nothing about a tracer that attached before this process ever ran (e.g.
 * one that raced us between fork and this line). Reads /proc/self/status
 * directly — a *Sync fs call is fine here: this is a one-shot standalone
 * script with no event loop to block, not code in src/main reached by a
 * click/IPC/timer (the main-process blocking-call ratchet does not apply).
 *
 * WHY `readStatus` is an injectable parameter, defaulted to the real read
 * (task-2 review, T2-6): lets a test drive the TracerPid parsing/decision
 * logic directly with fake status text, the same dependency-injection
 * shape admin-command.ts uses for its own `platform` override — a plain
 * default parameter, no behavior change for the one real caller (main()),
 * which calls this with no argument. `vi.spyOn` on the shared `fs` module
 * doesn't work here anyway: vitest's ESM handling makes `fs`'s own
 * exports non-configurable ("Cannot redefine property: readFileSync").
 */
function isTraced(readStatus = () => fs.readFileSync('/proc/self/status', 'utf8')) {
  if (process.platform !== 'linux') return false;
  try {
    const status = readStatus();
    const match = status.match(/^TracerPid:\s*(\d+)/m);
    // No match at all means we couldn't confirm we're untraced — fail
    // closed rather than assume the best.
    if (!match) return true;
    return match[1] !== '0';
  } catch {
    // Unreadable /proc/self/status is itself a reason not to trust this
    // process's isolation — fail closed.
    return true;
  }
}

function main() {
  if (!hardenSelf()) {
    // WHY exit here, before requiring net at all: nothing about the socket
    // handshake is trustworthy to run from a process that failed to make
    // itself non-dumpable — better to never hold the password than to hold
    // it in a dumpable process.
    process.exit(1);
    return;
  }
  if (isTraced()) {
    process.exit(1);
    return;
  }

  const socketPath = process.env.YOUCODED_ASKPASS_SOCKET;
  if (!socketPath) {
    // No socket to connect to means there is nothing this helper can do —
    // sudo will report "no password was provided", same as any other
    // failure path here.
    process.exit(1);
    return;
  }

  // WHY one fixed-size buffer, filled in place, rather than the previous
  // `received = Buffer.concat([received, chunk])` per `data` event
  // (task-2 review, T2-7): `Buffer.concat` allocates a NEW buffer and
  // copies into it every time, silently abandoning the previous
  // `received` value (which may hold a prefix of the password) without
  // ever zeroing it — only the FINAL buffer got `.fill(0)`'d. A single
  // pre-allocated buffer, copied into with `chunk.copy(...)`, means there
  // is at most one buffer holding wire bytes at any time, so `finish`'s
  // `.fill(0)` actually covers everything this variable ever held.
  const received = Buffer.alloc(MAX_LINE_BYTES);
  let receivedLen = 0;
  let finished = false;
  let socket = null;

  // WHY a single `finish`: every exit path (ok, refused, garbage, socket
  // error, socket close, oversize line) goes through here so the received
  // buffer is scrubbed and the socket is torn down exactly once, regardless
  // of which event fired first.
  const finish = (code) => {
    if (finished) return;
    finished = true;
    // Best-effort scrub, NOT a complete one (task-2 review, T2-7 — this
    // comment previously overstated coverage): `received` is the one
    // buffer THIS code keeps around across `data` events, and zeroing it
    // covers that. It does NOT cover every place a password byte briefly
    // existed — each incoming `chunk` is a Buffer Node allocates per
    // `data` event and we only copy out of it, never zero it once copied;
    // and, once parsed, `reply.password` and everything derived from it
    // (`.toString('utf8')`, `JSON.parse`) are ordinary immutable V8
    // strings that plain JS has no API to zero at all (see the comment
    // where the password is actually read out, below, which already
    // states that limitation correctly). In practice the process exits
    // via `process.exit()` a few lines after any of this runs, so V8's GC
    // very likely never gets a chance to run first — but that is a
    // favorable timing accident, not a guarantee this code makes.
    received.fill(0);
    receivedLen = 0;
    if (socket) {
      try {
        socket.destroy();
      } catch {
        // already gone — nothing to do
      }
    }
    process.exit(code);
  };

  socket = net.createConnection({ path: socketPath }, () => {
    // WHY exactly this line, nothing else: AskpassServer takes the peer pid
    // from the KERNEL (SO_PEERCRED/LOCAL_PEERPID), not from anything the
    // helper claims (design §2.2, review 1 D3) — so this helper sends no
    // pid, no argv, nothing that could be spoofed by a different process
    // dialing the same socket.
    socket.write('{"v":1}\n');
  });

  socket.on('data', (chunk) => {
    if (finished) return;
    if (receivedLen + chunk.length > MAX_LINE_BYTES) {
      finish(1);
      return;
    }
    chunk.copy(received, receivedLen);
    receivedLen += chunk.length;
    // Search only the bytes actually received so far — `subarray` is a
    // VIEW over `received`, not a copy, so this adds no extra buffer to
    // scrub later.
    const newline = received.subarray(0, receivedLen).indexOf(0x0a); // '\n'
    if (newline === -1) return; // still short of one full line — keep waiting, still under the cap

    const lineBuf = received.subarray(0, newline);
    let reply;
    try {
      reply = JSON.parse(lineBuf.toString('utf8'));
    } catch {
      finish(1);
      return;
    }

    if (reply && reply.ok === true && typeof reply.password === 'string') {
      // WHY fs.writeSync(1, ...) and not console.log: this is stdout as
      // sudo's own pipe (never the model), and writeSync avoids Node's
      // stream buffering putting any of the password where an async flush
      // could still be pending when we exit.
      const passwordBuf = Buffer.from(reply.password, 'utf8');
      const out = Buffer.concat([passwordBuf, Buffer.from('\n', 'utf8')]);
      try {
        fs.writeSync(1, out);
      } finally {
        // Overwrite every buffer/string reference we control. JS strings
        // are immutable — `reply.password` itself cannot be zeroed in
        // memory — but every Buffer we allocated for this can be, and we
        // drop our only reference to the string immediately after.
        out.fill(0);
        passwordBuf.fill(0);
        reply.password = '';
        reply = null;
      }
      finish(0);
      return;
    }

    // {"ok":false,...} or any other shape: refuse silently.
    finish(1);
  });

  // A transport error (ECONNREFUSED, EPIPE, ...) is the same as any other
  // "no password available" outcome from sudo's point of view.
  socket.on('error', () => finish(1));
  // The socket closing before we ever saw {"ok":true,...} — withdrawn ask,
  // command killed, app quit — is the "waits indefinitely, no timeout"
  // behaviour (design §6): we simply exit once there is nothing left to
  // wait for, never inventing a timeout of our own.
  socket.on('close', () => finish(1));
}

// WHY require.main === module: lets tests `require()` this file to reach
// the pure functions below (isTraced, hardenSelf, requireKoffi — task-2
// review T2-6) WITHOUT it immediately connecting to a socket or calling
// process.exit() as a side effect of being loaded. Every real invocation
// (the wrapper's `exec ... askpass.cjs`) runs this file as the process's
// own entry point, where require.main === module is true, so production
// behavior is unchanged — this only adds a way to import without running.
if (require.main === module) {
  main();
}

module.exports = { hardenSelf, isTraced, requireKoffi, main };
