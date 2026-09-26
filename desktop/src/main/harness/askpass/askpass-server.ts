// askpass-server.ts — the unix-socket server `youcoded-askpass`/askpass.cjs
// connects to (design §2.2). Owns the socket's lifecycle (create, verify it
// actually works, tear down) and the connection protocol (read the
// handshake, resolve the kernel peer pid, run verify.ts's chain, hand a
// verified ask up as an event). Task 3's scope: this module and its
// interface only — NOT wired into bash.ts/PermissionBroker/IPC yet (tasks
// 4–5), so `deliver`/`refuse` are plain method calls a caller drives, and
// 'ask'/'withdrawn' are plain EventEmitter events a caller subscribes to.
//
// Every fs/socket operation here is async — this sits on a path a real
// connection (i.e. an IPC-adjacent event) reaches, which
// .claude/rules/performance.md rule 1 requires.
'use strict';

import { EventEmitter } from 'events';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { log } from '../../logger';
import { peerCredPid, selfTest as peerCredSelfTest, type PeerCred } from './peer-cred';
import { verifyAskpassPeer, type VerifyResult } from './verify';
import { createProcReader, type ProcReader, type PidHandle } from './proc-info';
import type { RunningCalls } from './running-calls';

const MAX_LINE_BYTES = 256;

// WHY a 5-round-trip protocol, not "verify once": the helper's own hardening
// step (prctl(PR_SET_DUMPABLE,0) / ptrace(PT_DENY_ATTACH), askpass.cjs) gates
// /proc/<pid>/exe and /proc/<pid>/environ behind the SAME
// ptrace_may_access() check that blocks same-uid ptrace — so once the helper
// hardens itself, THIS SERVER (same uid, not an ancestor) can no longer read
// those two files either. verify.ts's item 1 (exe/argv/environ) MUST
// therefore run BEFORE hardening, while the helper is still fully readable;
// only after that succeeds do we ask it to harden, and only after IT
// confirms hardening do we prove the harden actually took effect (design
// change 2026-09-26, superseding the single-handshake v1 protocol §2.1/§2.2
// describe): connect (v:2, unhardened) → verify → {"harden":true} →
// {"hardened":true} → re-check (TracerPid, starttime, environ now EACCES) →
// only then is an ask ever raised to the UI.
//
// RESIDUAL RISK, stated rather than silently accepted: a tracer that
// attaches AND detaches in the narrow window between the pre-harden
// TracerPid read (inside verify.ts, step 2) and the post-harden TracerPid
// re-read (step 5) is not caught by either read — both see TracerPid 0.
// Yama's default ptrace scope (1, "restricted") limits `PTRACE_ATTACH` to a
// real ancestor of the target, so this window is ancestor-only and
// milliseconds wide; it is not closed by this protocol and is not claimed
// to be.
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_HARDEN_TIMEOUT_MS = 5_000;
const DEFAULT_VERIFY_TIMEOUT_MS = 5_000;

/** T3-1: best-effort close, mirrors verify.ts's own `closeAll` — a pin is a
 *  cheap kernel handle whose only job is preventing pid reuse; a failure
 *  releasing it is never a reason to fail whatever else is happening. */
function closePin(pin: PidHandle | null): void {
  try {
    pin?.close();
  } catch {
    // best-effort — nothing more to do
  }
}

export interface AskpassAskEvent {
  askId: string;
  sudoPid: number;
  sudoArgv: string[];
  callRoot: number;
  via?: string;
  toolCallId: string;
  sessionId: string;
  specialist?: string;
  /** Count of previous asks from this same sudo pid — the caller computes
   *  `triesLeft = 3 - attempt` (design §6). 0 on the first ask. */
  attempt: number;
}

interface PendingAsk {
  socket: net.Socket;
  sudoPid: number;
  callRoot: number;
  /** T3-1: the helper's own pidfd pin, opened right after its kernel peer
   *  pid is resolved and held OPEN through the entire pending-ask window —
   *  not just through verify()'s own chain — so the strongest anti-
   *  recycling primitive actually covers the window it matters most for:
   *  the harden round-trip, the step-5 re-check, and however long the ask
   *  sits waiting for the user. Closed by `deliver`/`refuse`/the withdrawal
   *  path below — never by `runProtocol` itself once ownership reaches
   *  here. Null when `pidfdOpen` is unavailable (falls back to the
   *  starttime-only re-check verify.ts and step 5 already do). */
  helperPin: PidHandle | null;
}

export interface AskpassServerConfig {
  /** `process.execPath` — verify.ts's item 1 anchor. */
  execPath: string;
  /** Real path of the shipped `askpass.cjs`. */
  helperScriptRealpath: string;
  runningCalls: RunningCalls;
  /** Overridable for tests; defaults to a real platform ProcReader. */
  reader?: ProcReader;
  /** Overridable for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Overrides the socket directory (tests only — production always uses
   *  the XDG_RUNTIME_DIR/tmpdir scheme, design §2.2). */
  socketDirOverride?: string;
  /** Injectable verifier — defaults to `verifyAskpassPeer` wired against the
   *  fields above. `askpass-server.test.ts` (design §9) drives THIS
   *  server's own protocol logic (handshake, byte cap, attempt counting,
   *  deliver/refuse/withdraw) with a stub here, independent of real /proc
   *  state or a real sudo. Takes an `AbortSignal` (T3-4) — `verifyAskpassPeer`
   *  checks it between awaits so a caller that stopped waiting can make an
   *  in-flight chain stop too. */
  verify?: (pid: number, signal?: AbortSignal) => Promise<VerifyResult>;
  /** Injectable kernel peer-pid resolver — defaults to `peerCredPid`. */
  resolvePeerPid?: (socket: net.Socket) => PeerCred | null;
  /** Test-only overrides for the three protocol timeouts (ms). Production
   *  always uses the 5s defaults; tests use small values so
   *  T3-4's timeout tests don't cost real wall-clock seconds. */
  handshakeTimeoutMs?: number;
  hardenTimeoutMs?: number;
  verifyTimeoutMs?: number;
}

function defaultSocketDir(platform: NodeJS.Platform): string {
  if (platform === 'linux' && process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, 'youcoded');
  }
  // Fallback (any platform without XDG_RUNTIME_DIR, and macOS always):
  // os.tmpdir()/youcoded-<uid>/ (design §2.2). getuid() is POSIX-only, which
  // is fine — this feature never runs on win32 (R19; sudo/askpass don't
  // exist there).
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `youcoded-${uid}`);
}

export class AskpassServer extends EventEmitter {
  private readonly config: AskpassServerConfig;
  private readonly reader: ProcReader;
  private readonly platform: NodeJS.Platform;
  private readonly verify: (pid: number, signal?: AbortSignal) => Promise<VerifyResult>;
  private readonly resolvePeerPid: (socket: net.Socket) => PeerCred | null;
  private readonly handshakeTimeoutMs: number;
  private readonly hardenTimeoutMs: number;
  private readonly verifyTimeoutMs: number;

  private server: net.Server | null = null;
  private socketPathValue: string | null = null;
  private _available = false;
  private readonly pending = new Map<string, PendingAsk>();
  // T3-2: keyed by sudoPid AND its startTime (not the bare pid — sudoPid is
  // reusable exactly like every other pid this feature tracks) so a
  // sudo-pid number that gets reused for a DIFFERENT, unrelated, still-alive
  // call is recognized as a brand-new attempt rather than a continuation of
  // a stale count. Sweeps out entries whose callRoot exited (design §11
  // task 3 decision: attempt counting has no explicit lifecycle in the
  // design, so this ties it to RunningCalls' own bookkeeping rather than
  // inventing a separate teardown hook).
  private readonly attemptsBySudoPid = new Map<number, { count: number; callRoot: number; startTime: number | null }>();

  constructor(config: AskpassServerConfig) {
    super();
    this.config = config;
    this.reader = config.reader ?? createProcReader(config.platform);
    this.platform = config.platform ?? process.platform;
    this.resolvePeerPid = config.resolvePeerPid ?? peerCredPid;
    this.handshakeTimeoutMs = config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.hardenTimeoutMs = config.hardenTimeoutMs ?? DEFAULT_HARDEN_TIMEOUT_MS;
    this.verifyTimeoutMs = config.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
    this.verify =
      config.verify ??
      ((pid: number, signal?: AbortSignal) =>
        verifyAskpassPeer(pid, {
          reader: this.reader,
          execPath: config.execPath,
          helperScriptRealpath: config.helperScriptRealpath,
          runningCalls: config.runningCalls,
          platform: this.platform,
          signal,
        }));
  }

  /** True once `start()` has produced a real, self-tested, listening
   *  socket. Never true after a failed self-test — design §2.2: "There is
   *  no fallback to a self-reported pid." A caller checks this before
   *  handing `SUDO_ASKPASS`/`YOUCODED_ASKPASS_SOCKET` to any Bash spawn. */
  get available(): boolean {
    return this._available;
  }

  get socketPath(): string | null {
    return this.socketPathValue;
  }

  /** Creates the socket dir (0700) and socket (0600), then runs the
   *  loopback self-test (design §2.2, review 2 E6). Never throws — a
   *  failure leaves `available` false and logs a plain reason; the caller's
   *  only correct response is "sudo fails as it does today", not a retry
   *  loop or a fallback identity check. */
  async start(): Promise<void> {
    const dir = this.config.socketDirOverride ?? defaultSocketDir(this.platform);
    try {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      // mkdir's mode is filtered by umask — force the exact bits regardless
      // of what the process's umask happened to be.
      await fs.promises.chmod(dir, 0o700);
    } catch (err) {
      log('WARN', 'AskpassServer', 'could not create socket directory', { error: String(err) });
      return;
    }

    // The socket path includes the app's own pid so a dev instance and a
    // live instance (or two dev instances) never collide (design §2.2).
    const socketPath = path.join(dir, `askpass-${process.pid}.sock`);
    this.socketPathValue = socketPath;

    try {
      await fs.promises.unlink(socketPath);
    } catch {
      // ENOENT is the expected case (no stale socket from a previous run);
      // anything else surfaces below when listen() itself fails.
    }

    const server = net.createServer((socket) => this.handleConnection(socket));
    this.server = server;

    const listenResult = await new Promise<boolean>((resolve) => {
      server.once('error', (err) => {
        log('WARN', 'AskpassServer', 'listen failed', { error: String(err) });
        resolve(false);
      });
      server.listen(socketPath, () => resolve(true));
    });
    if (!listenResult) {
      this.server = null;
      return;
    }

    try {
      await fs.promises.chmod(socketPath, 0o600);
    } catch (err) {
      log('WARN', 'AskpassServer', 'could not chmod socket to 0600', { error: String(err) });
      await this.teardown();
      return;
    }

    const selfTestOk = await peerCredSelfTest(socketPath);
    if (!selfTestOk) {
      // Design §2.2: "If it fails, the server does not start, the Bash env
      // gets no SUDO_ASKPASS, the failure is logged, and sudo fails as it
      // does today." No fallback identity check exists — ever.
      log('WARN', 'AskpassServer', 'startup self-test failed: kernel peer-pid resolution is not trustworthy on this build; askpass will not be offered');
      await this.teardown();
      return;
    }

    this._available = true;
  }

  private async teardown(): Promise<void> {
    const server = this.server;
    this.server = null;
    this._available = false;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.socketPathValue) {
      try {
        await fs.promises.unlink(this.socketPathValue);
      } catch {
        // already gone
      }
    }
  }

  /** Refuses every pending ask, closes the server and removes the socket
   *  file. Safe to call even if `start()` never succeeded. */
  async stop(): Promise<void> {
    for (const askId of Array.from(this.pending.keys())) {
      this.refuse(askId);
    }
    this.attemptsBySudoPid.clear();
    await this.teardown();
  }

  /** Writes `{"ok":true,"password":…}\n`, zeroes every buffer that touched
   *  the password (including the caller's), ends the socket. Returns false
   *  if `askId` is unknown (design §2.2: "the card says it expired"). */
  deliver(askId: string, password: Buffer): boolean {
    const ask = this.pending.get(askId);
    if (!ask) return false;
    this.pending.delete(askId);
    closePin(ask.helperPin); // T3-1: the ask is settling — release the pin now.
    const reply = buildOkReplyBuffer(password);
    try {
      ask.socket.write(reply);
      ask.socket.end();
    } catch {
      // The socket may already be half-closed; every buffer below is
      // zeroed regardless of whether the write landed.
    } finally {
      reply.fill(0);
      password.fill(0);
    }
    return true;
  }

  /** Answers `{"ok":false}\n` and closes the socket. Returns false if
   *  `askId` is unknown. */
  refuse(askId: string): boolean {
    const ask = this.pending.get(askId);
    if (!ask) return false;
    this.pending.delete(askId);
    closePin(ask.helperPin); // T3-1
    this.writeRefusal(ask.socket);
    return true;
  }

  private writeRefusal(socket: net.Socket): void {
    try {
      socket.write('{"ok":false}\n');
      socket.end();
    } catch {
      // socket already gone — nothing to do
    }
  }

  private handleConnection(socket: net.Socket): void {
    const state: LineReadState = { buffer: Buffer.alloc(0) };

    const onClose = () => {
      // Looks up `pending` directly rather than tracking a "settled" flag:
      // an ask only ever reaches `pending` after the FULL protocol below
      // (handshake, verify, harden, re-check) succeeds, so a connection that
      // dies at any earlier stage was never added and this is a safe no-op
      // for it.
      for (const [askId, ask] of this.pending) {
        if (ask.socket === socket) {
          this.pending.delete(askId);
          closePin(ask.helperPin); // T3-1: withdrawn — nothing left to protect
          this.emit('withdrawn', askId);
          break;
        }
      }
    };
    socket.on('close', onClose);
    socket.on('error', () => {
      // A transport error mid-protocol is not this server's problem to
      // diagnose further; 'close' still fires after and does the
      // withdrawal bookkeeping above if an ask already existed, or is a
      // no-op if the protocol hadn't gotten that far.
    });

    void this.runProtocol(socket, state);
  }

  /**
   * Reads one `\n`-terminated line from `socket`, honoring bytes already
   * buffered in `state` from a previous call (the peer is never expected to
   * send more than one line ahead of our replies, but this handles it
   * correctly either way rather than assuming). Rejects on the byte cap,
   * socket close/error, or `timeoutMs` elapsing.
   */
  private readLine(socket: net.Socket, state: LineReadState, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const tryExtract = (): string | null => {
        const newline = state.buffer.indexOf(0x0a);
        if (newline === -1) return null;
        const line = state.buffer.subarray(0, newline).toString('utf8');
        state.buffer = state.buffer.subarray(newline + 1);
        return line;
      };

      const already = tryExtract();
      if (already !== null) {
        resolve(already);
        return;
      }

      let timer: NodeJS.Timeout;
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('close', onDone);
        socket.off('error', onDone);
      };
      const onData = (chunk: Buffer) => {
        state.buffer = Buffer.concat([state.buffer, chunk]);
        if (state.buffer.length > MAX_LINE_BYTES) {
          cleanup();
          reject(new Error('line exceeded byte cap'));
          return;
        }
        const line = tryExtract();
        if (line !== null) {
          cleanup();
          resolve(line);
        }
      };
      const onDone = () => {
        cleanup();
        reject(new Error('socket closed before a line arrived'));
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('timed out waiting for a line'));
      }, timeoutMs);
      socket.on('data', onData);
      socket.once('close', onDone);
      socket.once('error', onDone);
    });
  }

  /** The full per-connection protocol (see the constants above for why it
   *  has this shape). Every early return either destroys the socket
   *  outright (garbage/timeout — nothing legible to refuse) or writes
   *  `{"ok":false}` first (we understood the peer well enough to say no).
   *  T3-1: `helperPin`, opened right after the kernel peer pid is resolved,
   *  is closed by every early-return path below UNLESS ownership is handed
   *  to `pending` (tracked by `pinOwnedByPending`) — from that point on
   *  `deliver`/`refuse`/the withdrawal path own closing it. */
  private async runProtocol(socket: net.Socket, state: LineReadState): Promise<void> {
    let helperPin: PidHandle | null = null;
    let pinOwnedByPending = false;
    try {
      // --- Step 1: handshake. The helper is NOT hardened yet — connects,
      // sends {"v":2}, nothing else. "Any pid it claims is ignored" (design
      // §2.2) — this line carries no identity; the kernel is the only
      // source of that (step 2).
      let handshakeLine: string;
      try {
        handshakeLine = await this.readLine(socket, state, this.handshakeTimeoutMs);
      } catch {
        this.destroy(socket);
        return;
      }
      let handshake: unknown;
      try {
        handshake = JSON.parse(handshakeLine);
      } catch {
        this.destroy(socket);
        return;
      }
      if (!handshake || typeof handshake !== 'object' || (handshake as { v?: unknown }).v !== 2) {
        this.destroy(socket);
        return;
      }

      // --- Step 2: kernel peer pid, then verify.ts's FULL chain — exe,
      // argv, environ, TracerPid, sudo parent, ancestors, starttimes. This
      // is the last point at which /proc/<pid>/exe and /proc/<pid>/environ
      // are readable, so it must all happen now, before any harden request.
      const cred = this.resolvePeerPid(socket);
      if (!cred) {
        log('WARN', 'AskpassServer', 'refused: could not resolve kernel peer pid for a connection');
        this.writeRefusal(socket);
        return;
      }

      // T3-1: pin the helper NOW, before anything else about it is read —
      // this is the strong anti-recycling primitive `proc-info.ts` documents
      // ("prevent the KERNEL from recycling the pid... for as long as it
      // stays open"), and it must cover the harden round-trip and step 5's
      // re-check, not just verify()'s own internal chain (which pins/closes
      // this same pid on its OWN, narrower schedule — a SEPARATE pin, not
      // reused, because verify.ts has no way to hand its pin back out and
      // doing so would couple two modules that should stay independent).
      // Best-effort: null when pidfd_open is unavailable, same fallback
      // verify.ts's own chain already relies on.
      helperPin = await this.reader.pidfdOpen(cred.pid).catch(() => null);

      // Recorded now (pre-harden) so the post-harden re-check (step 5) has a
      // baseline — verify.ts pins/re-checks its OWN internal reads, but its
      // result doesn't carry the helper's starttime out to this caller.
      const helperStartTimeBeforeHarden = await this.reader.startTime(cred.pid);

      // T3-4: an AbortController lets a timed-out verify() actually stop
      // (checked between its own awaits) instead of merely being ignored —
      // `withTimeout` below aborts it the instant the timer fires.
      const verifyController = new AbortController();
      let result: VerifyResult;
      try {
        result = await withTimeout(
          this.verify(cred.pid, verifyController.signal),
          this.verifyTimeoutMs,
          'verify',
          () => verifyController.abort(),
        );
      } catch {
        this.writeRefusal(socket);
        return;
      }
      if (!result.ok) {
        log('WARN', 'AskpassServer', 'refused askpass connection', { reason: result.reason });
        this.writeRefusal(socket);
        return;
      }
      if (helperStartTimeBeforeHarden === null) {
        // Could not establish a pre-harden baseline at all — nothing to
        // prove "unchanged" against later, so this cannot pass the step-5
        // re-check honestly. Refuse now rather than let step 5 pass
        // vacuously.
        this.writeRefusal(socket);
        return;
      }

      // The call may have exited in the window between verify.ts's
      // ancestor-walk lookup and here — re-check rather than hand out an ask
      // for a call this server no longer believes is running.
      const callEntry = this.config.runningCalls.lookup(result.callRoot);
      if (!callEntry) {
        log('WARN', 'AskpassServer', 'refused: call root exited before the ask could be raised');
        this.writeRefusal(socket);
        return;
      }

      // --- Step 3: tell the helper it's safe to harden now — everything
      // this server will ever need to read about it has already been read.
      try {
        socket.write('{"harden":true}\n');
      } catch {
        this.destroy(socket);
        return;
      }

      // --- Step 4: wait for its confirmation.
      let hardenedLine: string;
      try {
        hardenedLine = await this.readLine(socket, state, this.hardenTimeoutMs);
      } catch {
        this.destroy(socket);
        return;
      }
      let hardened: unknown;
      try {
        hardened = JSON.parse(hardenedLine);
      } catch {
        this.destroy(socket);
        return;
      }
      if (!hardened || typeof hardened !== 'object' || (hardened as { hardened?: unknown }).hardened !== true) {
        this.writeRefusal(socket);
        return;
      }

      // --- Step 5: re-check. TracerPid must still read 0 (status stays
      // readable throughout hardening); starttime must be unchanged (same
      // process incarnation, not a recycled pid the helper's own reply
      // raced with); and — the actual PROOF hardening took effect, not just
      // the helper's self-report — /proc/<pid>/environ must now be
      // UNREADABLE to us. `environ()` returns null on ANY read failure, so
      // this check is only trustworthy in this order: confirm the pid is
      // still the SAME live incarnation first (TracerPid + starttime), so a
      // null environ read at that point is credibly "hardening closed it",
      // not "the process is simply gone".
      const tracerPidAfter = await this.reader.tracerPid(cred.pid);
      if (tracerPidAfter !== 0) {
        this.writeRefusal(socket);
        return;
      }
      const startTimeAfter = await this.reader.startTime(cred.pid);
      if (startTimeAfter === null || startTimeAfter !== helperStartTimeBeforeHarden) {
        this.writeRefusal(socket);
        return;
      }
      // The environ-EACCES proof is Linux-specific (macOS's own hardening
      // call — ptrace(PT_DENY_ATTACH) — has a different, unverified
      // readability story, and verify.ts already refuses every macOS
      // connection outright while MAC_ENABLED is false, so this branch is
      // unreachable for darwin today; it is written defensively rather than
      // assumed impossible).
      if (this.platform === 'linux') {
        const environAfterHarden = await this.reader.environ(cred.pid);
        if (environAfterHarden !== null) {
          log('WARN', 'AskpassServer', 'refused: helper did not actually become non-dumpable');
          this.writeRefusal(socket);
          return;
        }
      }

      // --- Only now: raise the ask. Everything above is done; nothing else
      // times out — the UI wait for the user to type (or Skip/Stop) it is
      // unbounded by design (§6, sudo itself never times out an askpass
      // read).
      for (const [sp, info] of this.attemptsBySudoPid) {
        if (!this.config.runningCalls.lookup(info.callRoot)) this.attemptsBySudoPid.delete(sp);
      }
      // T3-2: a bare sudoPid is exactly as reusable as every other pid this
      // feature tracks — a stored entry only counts as "the same sudo,
      // retried" when its recorded startTime still matches a FRESH read.
      // Any mismatch (or an unreadable read) means either a genuinely new
      // sudo landed on a recycled pid number, or we can no longer prove it
      // didn't — both get attempt: 0, never a stale continuation.
      const sudoStartTimeNow = await this.reader.startTime(result.sudoPid);
      const prior = this.attemptsBySudoPid.get(result.sudoPid);
      const isContinuation = prior !== undefined && sudoStartTimeNow !== null && prior.startTime === sudoStartTimeNow;
      const attempt = isContinuation ? prior.count : 0;
      this.attemptsBySudoPid.set(result.sudoPid, {
        count: attempt + 1,
        callRoot: result.callRoot,
        startTime: sudoStartTimeNow,
      });

      const askId = randomUUID();
      pinOwnedByPending = true; // T3-1: from here, deliver/refuse/withdraw own closing helperPin
      this.pending.set(askId, { socket, sudoPid: result.sudoPid, callRoot: result.callRoot, helperPin });

      const event: AskpassAskEvent = {
        askId,
        sudoPid: result.sudoPid,
        sudoArgv: result.sudoArgv,
        callRoot: result.callRoot,
        via: result.via,
        toolCallId: callEntry.toolCallId,
        sessionId: callEntry.sessionId,
        specialist: callEntry.specialist,
        attempt,
      };
      this.emit('ask', event);
    } finally {
      if (!pinOwnedByPending) closePin(helperPin);
    }
  }

  private destroy(socket: net.Socket): void {
    try {
      socket.destroy();
    } catch {
      // already gone
    }
  }
}

interface LineReadState {
  buffer: Buffer;
}

/** T3-4: races `promise` against a timer; on timeout, calls `onTimeout` (so
 *  the caller can actually cancel the abandoned work, e.g. abort a
 *  verify() still mid-flight) THEN rejects. Without `onTimeout`, the
 *  original promise would keep running unobserved after this function
 *  stops waiting on it — harmless here only because verify.ts's own
 *  `finally` blocks eventually clean up on their own schedule, but that
 *  schedule is invisible to (and slower than) this caller's stated timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** T3-5: JSON-escapes `input`'s bytes IN PLACE conceptually — only `"`
 *  (0x22), `\` (0x5c) and control bytes (< 0x20) ever need escaping in a
 *  JSON string, and none of those byte values can appear as part of a
 *  multi-byte UTF-8 sequence (continuation bytes are 0x80-0xBF, lead bytes
 *  0xC2-0xF4), so scanning byte-by-byte is safe for arbitrary UTF-8 text —
 *  it never splits or misreads a multi-byte character. Returns a NEW
 *  Buffer; the caller is responsible for zeroing both it and `input`. */
function jsonEscapeBytes(input: Buffer): Buffer {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const b = input[i];
    if (b !== 0x22 && b !== 0x5c && b >= 0x20) continue;
    if (i > start) parts.push(input.subarray(start, i));
    if (b === 0x22) parts.push(Buffer.from('\\"', 'ascii'));
    else if (b === 0x5c) parts.push(Buffer.from('\\\\', 'ascii'));
    else parts.push(Buffer.from('\\u' + b.toString(16).padStart(4, '0'), 'ascii'));
    start = i + 1;
  }
  if (start < input.length) parts.push(input.subarray(start));
  return parts.length > 0 ? Buffer.concat(parts) : Buffer.alloc(0);
}

/** T3-5: builds `{"ok":true,"password":"…"}\n` as ONE Buffer, byte by byte
 *  — the password never becomes a JS string on this side of the wire
 *  (`password.toString('utf8')` + `JSON.stringify(...)` each allocate an
 *  immutable V8 string that can never be zeroed; a Buffer can). The caller
 *  (`deliver`) zeroes both this function's return value and the
 *  intermediate escaped buffer built here. */
function buildOkReplyBuffer(password: Buffer): Buffer {
  const prefix = Buffer.from('{"ok":true,"password":"', 'utf8');
  const suffix = Buffer.from('"}\n', 'utf8');
  const escaped = jsonEscapeBytes(password);
  const result = Buffer.concat([prefix, escaped, suffix]);
  escaped.fill(0); // this function's own intermediate copy of the password bytes
  return result;
}
