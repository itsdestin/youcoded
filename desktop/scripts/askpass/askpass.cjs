'use strict';
// askpass.cjs — the process youcoded-askpass execs into, running as plain
// Node (ELECTRON_RUN_AS_NODE=1) under the environment the wrapper scrubbed.
// This is the process AskpassServer's verification chain (design §3) checks
// the real exe/argv/env of, and the process that actually holds the user's
// sudo password for a few milliseconds. CommonJS, no build step: it has to
// run byte-for-byte as shipped, from a real file outside app.asar (review 3,
// F1), under a Node runtime with no bundler in front of it.
//
// PROTOCOL v2 — verify, THEN harden, THEN release the password. Connects
// and sends `{"v":2}\n` as an ORDINARY (still dumpable) process, because
// the app's own verification needs to read this process's real
// `/proc/<pid>/exe`/argv/environ from the OUTSIDE while it can still do
// so — reading `/proc/<pid>/environ` of another same-uid process turns out
// to be gated by the exact same ptrace_may_access() check that
// PR_SET_DUMPABLE=0 exists to enforce (verified empirically: once
// hardenSelf() succeeds, this process's own /proc/<pid>/environ becomes
// EACCES to everything but itself). Only after the app replies
// `{"harden":true}` — meaning it already finished reading what it needed
// to — does this process call hardenSelf() (E1's fix, still required: the
// password must never exist in a dumpable process) and reply
// `{"hardened":true}`; only THEN does the app send the password. See the
// longer WHY on `main()` below for the full ordering argument.
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
 * Make this process unreadable to other same-uid processes. Called from
 * main() only after the app has replied `{"harden":true}` over the socket
 * (protocol v2 — see the file-level comment for why verification has to
 * happen BEFORE this, not after) and strictly before the password can
 * arrive (design §3, review 2 E1). `env -i` and `ulimit -c 0` in the
 * wrapper only cover environment variables and core dumps; sudo's own fork
 * chain (setuid(0) -> setuid(uid) -> exec) leaves this process with real
 * uid == effective uid, i.e. an ORDINARY same-uid process, subject to
 * same-uid ptrace and signal delivery like anything else the model's
 * command runs. PR_SET_DUMPABLE=0 (Linux) / PT_DENY_ATTACH (macOS) closes
 * that regardless of what happened upstream.
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

// WHY the handshake is verify-THEN-harden, not harden-then-connect
// (protocol v2, superseding the harden-first v1 shape): the app's own
// verification (design §3 item 1) has to read THIS process's real
// `/proc/<pid>/exe`, argv and — critically — `/proc/<pid>/environ` from
// OUTSIDE it, while it is still an ordinary process. Verified empirically:
// once `hardenSelf()` has run, `/proc/<pid>/environ` (and `/proc/<pid>/mem`)
// become EACCES to everything but this process itself — the exact same
// ptrace_may_access() check that PR_SET_DUMPABLE=0 exists to enforce. A
// helper that hardened itself before ever touching the socket would be
// UNVERIFIABLE the instant it connected: the app could never confirm its
// environment was the exact two-variable allowlist, because it could no
// longer read that environment at all. So the protocol now has the app
// verify this process first (while it is still plain and readable), THEN
// explicitly tell it to harden, and only THEN release the password — the
// harden step is exactly what E1 needs (non-dumpable BEFORE the password
// exists in this process), it just has to happen strictly after
// verification succeeds rather than strictly before the socket connects.
function main() {
  const socketPath = process.env.YOUCODED_ASKPASS_SOCKET;
  if (!socketPath) {
    // No socket to connect to means there is nothing this helper can do —
    // sudo will report "no password was provided", same as any other
    // failure path here.
    process.exit(1);
    return;
  }

  // WHY one fixed-size buffer, filled in place, rather than
  // `received = Buffer.concat([received, chunk])` per `data` event
  // (task-2 review, T2-7): `Buffer.concat` allocates a NEW buffer and
  // copies into it every time, silently abandoning the previous
  // `received` value (which may hold a prefix of the password) without
  // ever zeroing it. A single pre-allocated buffer, copied into with
  // `chunk.copy(...)`, means there is at most one buffer holding wire
  // bytes at any time, so `finish`'s `.fill(0)` actually covers everything
  // this variable ever held. It is reused across BOTH lines this protocol
  // now reads (the harden instruction, then the password), shifting any
  // leftover bytes after a consumed line to the front rather than
  // allocating a second buffer.
  const received = Buffer.alloc(MAX_LINE_BYTES);
  let receivedLen = 0;
  let finished = false;
  let socket = null;
  // WHY a stage flag: the same socket now carries two sequential
  // server->client lines with different meanings (`{"harden":true}` then
  // `{"ok":true,"password":...}`) — this says which one the next complete
  // line read off the wire should be interpreted as.
  let stage = 'awaiting-harden';

  // WHY a single `finish`: every exit path (ok, refused, garbage, socket
  // error, socket close, oversize line) goes through here so the received
  // buffer is scrubbed and the socket is torn down exactly once, regardless
  // of which event fired first.
  const finish = (code) => {
    if (finished) return;
    finished = true;
    // Best-effort scrub, NOT a complete one (task-2 review, T2-7): zeroing
    // `received` covers the one buffer this code keeps around across
    // `data` events. It does NOT cover every place a password byte briefly
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
    // WHY exactly this line, nothing else, and WHY it is sent before any
    // hardening: AskpassServer takes the peer pid from the KERNEL
    // (SO_PEERCRED/LOCAL_PEERPID), not from anything the helper claims
    // (design §2.2, review 1 D3) — so this helper sends no pid, no argv,
    // nothing that could be spoofed by a different process dialing the
    // same socket. `v:2` marks the verify-then-harden protocol (see the
    // function-level comment above for why the order flipped from v1).
    socket.write('{"v":2}\n');
  });

  // Handle every complete line currently sitting in `received`, in order,
  // shifting any leftover bytes (an extra line front-loaded into the same
  // TCP/unix-socket read) to the front so the next `data` event — or this
  // same call, via its own loop — can find it. Returns once no complete
  // line remains.
  const drainLines = () => {
    for (;;) {
      if (finished) return;
      const newline = received.subarray(0, receivedLen).indexOf(0x0a); // '\n'
      if (newline === -1) return; // no complete line yet — wait for more data

      const lineBuf = received.subarray(0, newline);
      let reply;
      try {
        reply = JSON.parse(lineBuf.toString('utf8'));
      } catch {
        finish(1);
        return;
      }

      if (stage === 'awaiting-harden') {
        if (!reply || reply.harden !== true) {
          // Anything other than exactly {"harden":true} refuses silently —
          // this line arrives BEFORE the password exists anywhere, so
          // there is nothing sensitive to protect yet, just a protocol
          // mismatch to refuse.
          finish(1);
          return;
        }
        // WHY hardenSelf() + isTraced() run HERE, not at process start: the
        // app's verification (design §3) needs this process to still be
        // plain/readable (see the function-level comment) until it has
        // finished checking it — this instruction is the app's signal
        // that verification succeeded and it is now safe (and necessary,
        // per E1) to become non-dumpable before the password arrives.
        if (!hardenSelf() || isTraced()) {
          finish(1);
          return;
        }
        // Shift any leftover bytes (the password line, if it somehow
        // arrived already) to the front before writing our reply, so
        // drainLines()'s next loop iteration sees them.
        received.copy(received, 0, newline + 1, receivedLen);
        receivedLen -= newline + 1;
        stage = 'awaiting-password';
        socket.write('{"hardened":true}\n');
        continue;
      }

      // stage === 'awaiting-password'
      if (reply && reply.ok === true && typeof reply.password === 'string') {
        // WHY fs.writeSync(1, ...) and not console.log: this is stdout as
        // sudo's own pipe (never the model), and writeSync avoids Node's
        // stream buffering putting any of the password where an async
        // flush could still be pending when we exit.
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
      return;
    }
  };

  socket.on('data', (chunk) => {
    if (finished) return;
    if (receivedLen + chunk.length > MAX_LINE_BYTES) {
      finish(1);
      return;
    }
    chunk.copy(received, receivedLen);
    receivedLen += chunk.length;
    drainLines();
  });

  // A transport error (ECONNREFUSED, EPIPE, ...) is the same as any other
  // "no password available" outcome from sudo's point of view.
  socket.on('error', () => finish(1));
  // The socket closing before we ever saw {"ok":true,...} — withdrawn ask,
  // command killed, app quit — is the "waits indefinitely, no timeout"
  // behaviour (design §6): we simply exit once there is nothing left to
  // wait for, never inventing a timeout of our own. This also covers a
  // server that never sends {"harden":true} at all: no more data ever
  // arrives, the socket eventually closes (or the ask is withdrawn), and
  // we exit 1 having never held anything sensitive.
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
