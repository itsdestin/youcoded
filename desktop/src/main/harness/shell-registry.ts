// ShellRegistry (G-1 background Bash, spec §5.1–5.3): the ONE owner of every
// native Bash command that outlives its call — started with
// run_in_background, or handed off when a foreground call reached its time
// limit. One per session; NativeSessionHost owns its lifetime (see the
// shellRegistries map there) and HarnessSession hands it to tools as
// ctx.shells. Everything a run produces goes to an on-disk log from the
// first byte; a 200-line ring stays in memory for the finished notice and
// BashOutput; the card gets the last 40 lines over the wire.
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions, type SpawnOptionsWithoutStdio } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { ShellRunView, ShellStopReason } from '../../shared/types';
import { spillDirFor, sweepOldSpillFilesOnce } from './tools/spill-paths';
import { ENV_SENTINEL, normalizeNewlines, stripAnsi, stripSentinelLines } from './tools/shell-text';

/** Explicit background starts allowed at once (spec §3.6). Hand-offs never count (D5). */
export const MAX_EXPLICIT_RUNNING = 5;
/** Lines kept main-side per run — enough for the 50-line finished notice with margin. */
export const RING_LINES = 200;
/** After a child's `exit`, how long to wait for its stdio `close` before settling
 *  the run anyway. WHY: `exit` fires before the last stdout chunk is delivered, so
 *  settling on it lost the final line of output (macOS CI, 2026-09-16). Settling on
 *  `close` alone would hang on `sleep 100 &` — a grandchild keeps the pipe open. */
export const EXIT_DRAIN_GRACE_MS = 200;
/** Lines sent to the card per 'change' event (review G: the wire is a phone on cellular). */
export const WIRE_TAIL_LINES = 40;
/** Lines quoted in the finished notice (spec §4.4). */
export const NOTICE_TAIL_LINES = 50;
/** SIGTERM first, SIGKILL this long after (spec §5.2). */
export const TERM_GRACE_MS = 2_000;
/** How long KillShell waits for the exit before reporting (spec §4.3). */
export const KILL_WAIT_MS = 5_000;
/** ≤4 'change' events per second per run (spec §5.1). */
export const CHANGE_DEBOUNCE_MS = 250;
/** How long a run may go before the model is told it is STILL running — once
 *  at each mark, as a plain notice at the next idle boundary (the same lane a
 *  finished notice rides). WHY (Destin, 2026-09-07, hit live): a model that
 *  started a build in the background and heard nothing polled BashOutput 150
 *  times on a hung command. The finished notice cannot help while nothing
 *  finishes; this is the proactive half. Two marks, not a repeating timer:
 *  a genuinely long job (a 40-minute test suite) must not nag every five
 *  minutes, and a hung one is obvious by the second mark. */
export const LONG_RUN_NOTICE_MS: readonly number[] = [5 * 60_000, 15 * 60_000];
/** Most bytes one read() returns. A 20-minute build's log runs to hundreds of
 *  MB; reading all of it into the main process to slice off the tail is how you
 *  wedge the app (2026-08-28 review). 1 MB is far more than the 200 lines
 *  BashOutput shows, so nothing the model can see is lost by this bound. */
export const READ_MAX_BYTES = 1_000_000;
/** Hard ceiling on the unfinished last line, after \r normalization — a single
 *  genuinely enormous line (minified JSON, a base64 blob) is flushed as a line
 *  rather than held in memory forever. */
const MAX_PARTIAL_CHARS = 64_000;

export interface ShellRun {
  shellId: string;
  toolUseId: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  logPath: string;
  logStream: fs.WriteStream;
  /** Last RING_LINES complete lines (ANSI-stripped, sentinels included — filtered on read). */
  tail: string[];
  /** The unterminated final line, if any. */
  partial: string;
  /** Where the previous BashOutput read ended (byte offset into the log). */
  lastReadBytes: number;
  /** persistent_env was requested on the call that got handed off: unlink the
   *  env temp file the probe names when the command exits (D6). */
  captureEnv: boolean;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'exited' | 'stopped';
  exitCode?: number;
  /** Set when the process died from a signal we did not send (exitCode stays unset). */
  signal?: string;
  stopReason?: ShellStopReason;
  /** Handed off at its time limit rather than started in the background. */
  detached: boolean;
  /** Counts toward the cap (D5). */
  explicit: boolean;
  /** The host queued the finished notice (set by the host, never here). */
  reported: boolean;
  /** Resolves when the process has exited. */
  exited: Promise<void>;
  // internals
  resolveExited: () => void;
  logPending: number;
  logWaiters: Array<() => void>;
  logDone: Promise<void> | null;
  changeTimer: NodeJS.Timeout | null;
  /** The LONG_RUN_NOTICE_MS timers still pending; cleared on exit. */
  longRunTimers: NodeJS.Timeout[];
}

export interface ShellStartSpec {
  toolUseId: string;
  command: string;
  cwd: string;
  shellCmd: string;
  shellArgs: string[];
  env: NodeJS.ProcessEnv;
}

export interface ShellAdoptSpec {
  toolUseId: string;
  command: string;
  cwd: string;
  /** The SAME process bash.ts spawned — never restarted. */
  child: ChildProcess;
  startedAt: number;
  /** Everything captured so far when no spill stream exists yet (bash.ts's headBuf). */
  seedLog: string | null;
  /** The most recent output (bash.ts's tailBuf) — seeds the tail ring. */
  recent: string;
  /** bash.ts's open spill stream + path, when the output already overflowed. */
  logPath: string | null;
  logStream: fs.WriteStream | null;
  captureEnv: boolean;
}

export type ShellStartResult =
  | { ok: true; run: ShellRun; runningExplicit: number }
  | { ok: false; reason: 'cap'; running: string[] }
  | { ok: false; reason: 'spawn-failed'; detail: string };

export type KillResult = { ok: true; run: ShellRun } | { ok: false; run?: ShellRun };

/** spawn() in its own process group on POSIX. Why: a plain spawn puts the
 *  shell in OUR group, so a kill reaches only the outer bash and a `node` it
 *  started lives on (spec §1 — today's Escape orphans grandchildren). Windows
 *  has no groups worth using here; killTree walks the tree with taskkill.
 *
 *  Two signatures for one implementation so callers keep the stream types they
 *  had: a caller that does not name `stdio` gets Node's default all-pipes shape
 *  (non-null stdout/stderr), which is what bash.ts relies on. Without the
 *  overload, swapping spawn() for spawnDetached() silently widened every
 *  `child.stdout` to `Readable | null`. */
export function spawnDetached(cmd: string, args: string[], opts: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams;
export function spawnDetached(cmd: string, args: string[], opts: SpawnOptions): ChildProcess;
export function spawnDetached(cmd: string, args: string[], opts: SpawnOptions): ChildProcess {
  return spawn(cmd, args, { ...opts, windowsHide: true, detached: process.platform !== 'win32' });
}

/** Kill the whole process family. POSIX: SIGTERM to the group, SIGKILL after
 *  `graceMs` (0 = SIGKILL at once). Windows: `taskkill /PID <pid> /T /F`,
 *  falling back to child.kill() if taskkill itself cannot start. Returns
 *  immediately — callers that need the exit await `run.exited`. */
export function killTree(child: ChildProcess, opts: { graceMs?: number } = {}): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      tk.on('error', () => { try { child.kill(); } catch { /* already gone */ } });
    } catch {
      try { child.kill(); } catch { /* already gone */ }
    }
    return;
  }
  const signal = (sig: NodeJS.Signals) => {
    // -pid = the whole group. ESRCH/EPERM (group already gone, or a child that
    // was not spawned detached) falls back to the single process.
    try { process.kill(-pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } }
  };
  const grace = opts.graceMs ?? TERM_GRACE_MS;
  if (grace <= 0) { signal('SIGKILL'); return; }
  signal('SIGTERM');
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signal('SIGKILL');
  }, grace);
  t.unref();
}

/** "3m 02s" / "11m 42s" / "40m" / "1h 5m" / "12s" — the card's own format. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return sec ? `${m}m ${String(sec).padStart(2, '0')}s` : `${m}m`;
  return `${sec}s`;
}

const STOP_WORDS: Record<ShellStopReason, string> = {
  user: 'by you',
  assistant: 'by KillShell',
  'conversation-closed': 'when the conversation closed',
  'app-quit': 'when the app quit',
};

function elapsedOf(run: Pick<ShellRun, 'startedAt' | 'endedAt'>, now = Date.now()): string {
  return formatElapsed((run.endedAt ?? now) - run.startedAt);
}

/** `running · 3m 02s` / `exited 0 · 3m 02s` / `stopped (by you) · 3m 02s` — the
 *  model-facing state phrase BashOutput and KillShell both use. */
export function stateText(run: Pick<ShellRun, 'status' | 'exitCode' | 'signal' | 'stopReason' | 'startedAt' | 'endedAt'>, now = Date.now()): string {
  const elapsed = elapsedOf(run, now);
  if (run.status === 'running') return `running · ${elapsed}`;
  if (run.status === 'stopped') return `stopped (${STOP_WORDS[run.stopReason ?? 'user']}) · ${elapsed}`;
  const code = run.exitCode ?? (run.signal ? `? (killed by ${run.signal})` : '?');
  return `exited ${code} · ${elapsed}`;
}

/** The §4.4 finished notice. A user Stop is reported too (the model must know
 *  its server is gone); KillShell's own result is its notice, so the host never
 *  asks for one in that case. */
export function formatFinishedNotice(
  run: Pick<ShellRun, 'shellId' | 'command' | 'status' | 'exitCode' | 'signal' | 'stopReason' | 'startedAt' | 'endedAt' | 'logPath'>,
  tail: string,
): string {
  const elapsed = elapsedOf(run);
  const head = run.status === 'stopped'
    ? `[Background command ${run.shellId} stopped ${STOP_WORDS[run.stopReason ?? 'user']} · after ${elapsed}]`
    : `[Background command ${run.shellId} finished · exit ${run.exitCode ?? (run.signal ? `? (killed by ${run.signal})` : '?')} · ${elapsed}]`;
  return `${head}\n$ ${run.command}\n${tail.trim() || '(no output)'}\nFull log: ${run.logPath}`;
}

/** The still-running notice: same header shape as the finished one so the
 *  model recognises the family, then what to do — and what NOT to do. */
export function formatLongRunningNotice(run: Pick<ShellRun, 'shellId' | 'command'>, elapsedMs: number): string {
  return `[Background command ${run.shellId} has been running for ${formatElapsed(elapsedMs)}]\n$ ${run.command}\n`
    + 'If that is within expectations, ignore this message. If it may be stuck, read its latest output with BashOutput '
    + 'or stop it with KillShell. You will still be told when it finishes; do not poll for it.';
}

export class ShellRegistry extends EventEmitter {
  private runs = new Map<string, ShellRun>();
  private readonly longRunNoticeMs: readonly number[];

  /** `longRunNoticeMs` is a test seam — production callers pass nothing and
   *  get LONG_RUN_NOTICE_MS. */
  constructor(private readonly sessionId: string, opts: { longRunNoticeMs?: readonly number[] } = {}) {
    super();
    this.longRunNoticeMs = opts.longRunNoticeMs ?? LONG_RUN_NOTICE_MS;
  }

  get(shellId: string): ShellRun | undefined { return this.runs.get(shellId); }

  /** Every run this session has had, oldest first — finished ones INCLUDED and
   *  never evicted. Why no cap: a finished run holds at most 200 short lines
   *  (tens of KB), while evicting one would make BashOutput answer "No
   *  background command sh-abcd" about a command that plainly existed — a
   *  false statement, which docs/error-message-standards.md forbids. The
   *  registry dies with the conversation, so nothing accumulates across them. */
  list(): ShellRun[] { return [...this.runs.values()]; }

  runningExplicitIds(): string[] {
    return this.list().filter((r) => r.explicit && r.status === 'running').map((r) => r.shellId);
  }

  /** Explicit background start (run_in_background). stdin is 'ignore' so a
   *  command that waits for input fails fast with its own error instead of
   *  hanging forever with no way to answer it (D4). */
  start(spec: ShellStartSpec): ShellStartResult {
    const running = this.runningExplicitIds();
    if (running.length >= MAX_EXPLICIT_RUNNING) return { ok: false, reason: 'cap', running };
    let child: ChildProcess;
    try {
      child = spawnDetached(spec.shellCmd, [...spec.shellArgs, spec.command], {
        cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      return { ok: false, reason: 'spawn-failed', detail: e?.message ?? String(e) };
    }
    const run = this.register({
      toolUseId: spec.toolUseId, command: spec.command, cwd: spec.cwd, child,
      startedAt: Date.now(), seedLog: null, recent: '', logPath: null, logStream: null, captureEnv: false,
    }, { detached: false, explicit: true });
    return { ok: true, run, runningExplicit: running.length + 1 };
  }

  /** Hand-off (spec §5.5): the same process bash.ts already spawned, adopted
   *  in place. Never refused — a working build is not killed over a
   *  bookkeeping number (D5). */
  adopt(spec: ShellAdoptSpec): ShellRun {
    return this.register(spec, { detached: true, explicit: false });
  }

  private register(spec: ShellAdoptSpec, flags: { detached: boolean; explicit: boolean }): ShellRun {
    const shellId = this.mintId();
    let { logPath, logStream } = spec;
    if (!logStream || !logPath) {
      // Open at spawn, not lazily at the 4,000-char mark like a foreground
      // call's spill (review I1): a background command's full output must
      // exist on disk from its first byte — the card's log path is promised
      // the moment the run starts.
      const dir = spillDirFor(this.sessionId);
      fs.mkdirSync(dir, { recursive: true });
      logPath = path.join(dir, `bash-${Date.now()}-${shellId}.txt`);
      logStream = fs.createWriteStream(logPath);
      // The 7-day sweep used to fire only from bash.ts's foreground spill; a
      // user whose long commands all run in the background would never have
      // triggered it, and these logs would pile up forever (2026-08-28 review).
      sweepOldSpillFilesOnce();
    }
    // A write error must never crash the main process — the run keeps going
    // and BashOutput/the notice fall back to the in-memory tail.
    logStream.on('error', () => { /* the in-memory ring is the fallback — see read() */ });
    let resolveExited: () => void = () => {};
    const exited = new Promise<void>((res) => { resolveExited = res; });
    const run: ShellRun = {
      shellId, toolUseId: spec.toolUseId, command: spec.command, cwd: spec.cwd, child: spec.child,
      logPath, logStream, tail: [], partial: '', lastReadBytes: 0, captureEnv: spec.captureEnv,
      startedAt: spec.startedAt, status: 'running', detached: flags.detached, explicit: flags.explicit,
      reported: false, exited, resolveExited, logPending: 0, logWaiters: [], logDone: null, changeTimer: null,
      longRunTimers: [],
    };
    // Still-running marks (LONG_RUN_NOTICE_MS): measured from the run's own
    // startedAt, so an adopted hand-off that already ran two minutes in the
    // foreground reaches its first mark three minutes from now, not five.
    // unref'd — a pending mark must never hold the process open at quit.
    for (const ms of this.longRunNoticeMs) {
      const delay = Math.max(0, ms - (Date.now() - spec.startedAt));
      const t = setTimeout(() => {
        if (run.status !== 'running') return;
        this.emit('long-running', run, Date.now() - run.startedAt);
      }, delay);
      t.unref();
      run.longRunTimers.push(t);
    }
    // stripAnsi, because bash.ts keeps headBuf RAW and strips only at write
    // time (its own spill does `stripAnsi(headBuf)`). Without this the seeded
    // half of a handed-off log carries colour codes while everything after it
    // is clean, and the model's first BashOutput reads `\x1b[1m\x1b[30m RUN`.
    if (spec.seedLog && !spec.logStream) this.writeLog(run, stripAnsi(normalizeNewlines(spec.seedLog)));
    if (spec.recent) this.ingest(run, spec.recent, false);
    this.runs.set(shellId, run);
    spec.child.stdout?.on('data', (d) => this.ingest(run, String(d), true));
    spec.child.stderr?.on('data', (d) => this.ingest(run, String(d), true));
    spec.child.on('error', (err) => {
      this.ingest(run, `Failed to start shell: ${err.message}\n`, true);
      this.onExit(run, null, null);
    });
    spec.child.on('exit', (code, signal) => {
      // WHY not onExit here directly: see EXIT_DRAIN_GRACE_MS. `close` arrives after
      // the pipes drain; the timer covers a grandchild that never lets them close.
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.onExit(run, code, signal);
      };
      if (!spec.child.stdout && !spec.child.stderr) { settle(); return; } // nothing to drain
      spec.child.once('close', settle);
      timer = setTimeout(settle, EXIT_DRAIN_GRACE_MS);
      timer.unref();
    });
    // Adopted after it already died (a race with the time limit) — settle now.
    if (spec.child.exitCode !== null || spec.child.signalCode !== null) this.onExit(run, spec.child.exitCode, spec.child.signalCode);
    else this.emitChangeNow(run);
    return run;
  }

  private mintId(): string {
    let id: string;
    do { id = `sh-${randomBytes(2).toString('hex')}`; } while (this.runs.has(id));
    return id;
  }

  private writeLog(run: ShellRun, text: string): void {
    if (run.logDone || run.logStream.destroyed) return;
    run.logPending += 1;
    run.logStream.write(text, () => {
      run.logPending -= 1;
      if (run.logPending === 0) { const w = run.logWaiters.splice(0); for (const fn of w) fn(); }
    });
  }

  /** Resolves once every write issued so far is on disk — what makes a
   *  byte-offset read of the log honest while the stream is still open. */
  private flushLog(run: ShellRun): Promise<void> {
    if (run.logDone) return run.logDone;
    if (run.logPending === 0) return Promise.resolve();
    return new Promise((res) => run.logWaiters.push(res));
  }

  private ingest(run: ShellRun, raw: string, live: boolean): void {
    const text = stripAnsi(normalizeNewlines(raw));
    if (live) this.writeLog(run, text);
    const lines = (run.partial + text).split('\n');
    run.partial = lines.pop() ?? '';
    // A single line with no newline in sight (minified JSON, a base64 blob)
    // would otherwise sit in memory unbounded — flush it as a line instead.
    if (run.partial.length > MAX_PARTIAL_CHARS) { lines.push(run.partial); run.partial = ''; }
    for (const line of lines) run.tail.push(line);
    if (run.tail.length > RING_LINES) run.tail.splice(0, run.tail.length - RING_LINES);
    if (live) this.scheduleChange(run);
  }

  private onExit(run: ShellRun, code: number | null, signal: NodeJS.Signals | null): void {
    if (run.status !== 'running') return;
    run.endedAt = Date.now();
    for (const t of run.longRunTimers.splice(0)) clearTimeout(t);
    if (run.stopReason) {
      run.status = 'stopped';
    } else {
      run.status = 'exited';
      if (code !== null) run.exitCode = code;
      else if (signal) run.signal = signal;
    }
    if (run.partial) { run.tail.push(run.partial); run.partial = ''; if (run.tail.length > RING_LINES) run.tail.shift(); }
    run.logDone = new Promise<void>((res) => {
      if (run.logStream.destroyed) return res();
      run.logStream.end(() => res());
    });
    if (run.captureEnv) this.unlinkEnvFile(run);
    this.emitChangeNow(run);
    run.resolveExited();
    this.emit('exit', run);
  }

  /** D6: the persistent_env temp file the probe wrote when the handed-off
   *  command finally exited — bash.ts's finish() never ran for this call, so
   *  nobody else will delete it. */
  private unlinkEnvFile(run: ShellRun): void {
    for (let i = run.tail.length - 1; i >= 0; i--) {
      const line = run.tail[i];
      if (!line.startsWith(ENV_SENTINEL)) continue;
      const file = line.slice(ENV_SENTINEL.length).trim();
      if (file) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
      return;
    }
  }

  private scheduleChange(run: ShellRun): void {
    if (run.changeTimer) return;
    run.changeTimer = setTimeout(() => { run.changeTimer = null; this.emit('change', this.toView(run)); }, CHANGE_DEBOUNCE_MS);
  }

  private emitChangeNow(run: ShellRun): void {
    if (run.changeTimer) { clearTimeout(run.changeTimer); run.changeTimer = null; }
    this.emit('change', this.toView(run));
  }

  /** The last `lines` lines, sentinel lines removed. */
  tailText(run: ShellRun, lines: number): string {
    const all = run.partial ? [...run.tail, run.partial] : run.tail;
    return stripSentinelLines(all.slice(-lines).join('\n'));
  }

  toView(run: ShellRun): ShellRunView {
    return {
      toolUseId: run.toolUseId, shellId: run.shellId, status: run.status,
      exitCode: run.exitCode, stopReason: run.stopReason, detached: run.detached,
      startedAt: run.startedAt, endedAt: run.endedAt,
      tail: this.tailText(run, WIRE_TAIL_LINES), logPath: run.logPath,
    };
  }

  /** New output since the last read (first read: everything so far). The log's
   *  byte length at the last read IS the cursor (review §5.2).
   *
   *  Reads POSITIONALLY and bounded: never load the whole log. A long build's
   *  log runs to hundreds of MB, and eight polls a turn would each have loaded
   *  all of it just to slice off the tail (2026-08-28 review). When more than
   *  READ_MAX_BYTES is new, the LAST READ_MAX_BYTES are returned, `truncated`
   *  says so, and the cursor still advances to the end of the file — so the
   *  next read is genuinely "since your last look" rather than a replay. */
  async read(shellId: string): Promise<{ run: ShellRun; text: string; truncated: boolean } | undefined> {
    const run = this.runs.get(shellId);
    if (!run) return undefined;
    await this.flushLog(run);
    let fd: number | undefined;
    let text = '';
    let truncated = false;
    let size = run.lastReadBytes;
    try {
      fd = fs.openSync(run.logPath, 'r');
      size = fs.fstatSync(fd).size;
      const pending = Math.max(0, size - run.lastReadBytes);
      const want = Math.min(pending, READ_MAX_BYTES);
      truncated = pending > want;
      if (want > 0) {
        const buf = Buffer.alloc(want);
        fs.readSync(fd, buf, 0, want, size - want);
        text = buf.toString('utf8');
        // A bounded read can start mid-line; drop the first partial line rather
        // than hand the model half a word it cannot place.
        if (truncated) text = text.slice(text.indexOf('\n') + 1);
      }
    } catch {
      // The log is best-effort (a write error, a swept file). Fall back to the
      // in-memory ring so a read still answers with the truth we do hold.
      text = run.lastReadBytes === 0 ? this.tailText(run, RING_LINES) : '';
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    }
    run.lastReadBytes = size;
    return { run, text: stripSentinelLines(text), truncated };
  }

  /** Kill the family and wait up to KILL_WAIT_MS for the exit. The reason is
   *  recorded BEFORE the signal so the exit handler labels it 'stopped'. */
  async kill(shellId: string, reason: ShellStopReason, opts: { graceMs?: number } = {}): Promise<KillResult> {
    const run = this.runs.get(shellId);
    if (!run) return { ok: false };
    if (run.status !== 'running') return { ok: false, run };
    run.stopReason = reason;
    killTree(run.child, opts);
    await Promise.race([run.exited, new Promise<void>((res) => { setTimeout(res, KILL_WAIT_MS).unref(); })]);
    return { ok: true, run };
  }

  async killAll(reason: ShellStopReason, opts: { graceMs?: number } = {}): Promise<void> {
    await Promise.all(this.list().filter((r) => r.status === 'running').map((r) => this.kill(r.shellId, reason, opts)));
  }
}
