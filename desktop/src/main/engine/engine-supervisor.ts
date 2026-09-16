// EngineSupervisor — llama-server lifecycle (spec §3.2, ADR 007). Direct heir
// of the archived feat/opencode-mvp OpenCodeService supervision pattern.
//
// Router mode: spawned WITHOUT -m; the server discovers GGUFs in --models-dir,
// hot-loads on first request, LRU-evicts (--models-max), and isolates each model
// in its own child process. We only ever talk HTTP to it.
// Discovery is BOOT-TIME ONLY — the router never re-scans --models-dir on its
// own (no timer, no inotify, no rescan on a plain GET /models). A file that
// lands after boot 400s until refreshModels() asks for one. See "router rescan"
// below; the discovery dir is --models-dir, NOT LLAMA_CACHE (vestigial).
//
// Idle shutdown: the AI SDK is handed trackedFetch, so every chat request
// passes through here — each call bumps lastActivity and holds an inFlight
// count until its response BODY is fully read (streams count as active for
// their whole duration; a 10-minute generation must not be killed mid-stream).
//
// Settings: the spawn reads its configuration FRESH from readConfig() every
// time (design §B). It used to capture the values once, in the constructor,
// which meant a restart after a settings change respawned with the OLD flags —
// the switch moved, the engine did not. Everything a user can change now
// travels through that callback, and everything a MODEL can change travels
// through the preset file (--models-preset, design §C2) rather than the
// command line, because llama-server merges the router's own command line OVER
// every preset: a `-c` left on the command line silently outranks — and so
// defeats — every per-model context length.
import { spawn, ChildProcess, execFileSync } from 'child_process';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import type { EngineModel, EngineModelState, EngineRunState } from '../../shared/engine-types';
import type { ModelSettings } from '../../shared/model-manager-types';
import { scanGgufCache } from './cache-scan';
import { isFollowerPart } from '../../shared/gguf-split';
import { renderPresetFile, writePresetFile } from './model-presets';

/** Everything the spawn reads out of `~/.youcoded/config.json` — re-read at
 *  EVERY spawn (and at every idle check), never frozen into the constructor. */
export interface EngineSpawnConfig {
  cacheDir: string;          // --models-dir, and exported to the child as LLAMA_CACHE
  contextSize: number;       // the preset's `[*] ctx-size` (a model may override it)
  sleepIdleSeconds?: number; // the preset's `[*] sleep-idle-seconds`; default 900 (15 min)
  /** The two speed switches (design §B). Both default ON — that is what shipped
   *  before they were switchable, so a config file without them behaves as today. */
  speed?: { speculative?: boolean; compressCache?: boolean };
  /** `engine.models` — the per-model sections of the preset file. Keyed by model
   *  id, which is a FILENAME, so it is only ever read with an own-property check. */
  models?: Readonly<Record<string, Partial<ModelSettings>>> | null;
}

export interface EngineSupervisorOpts {
  binaryPath: string;
  port: number;
  /** Read fresh at every spawn — see the header. */
  readConfig: () => EngineSpawnConfig;
  /** Absolute path of the per-model settings file (`~/.youcoded/engine/models.ini`). */
  presetPath: string;
  env?: NodeJS.ProcessEnv;   // test override
  fetchImpl?: typeof fetch;  // test override
  readyDeadlineMs?: number;  // default 30_000 — first Vulkan init can be slow
  readyPollMs?: number;      // default 250
  idleMs?: number;           // default 25 min (spec §3.2); raised 10→25 min 2026-09-07
  idleCheckMs?: number;      // default 60s
  modelPollMs?: number;      // /models state poll cadence when idle; default 1500
  modelPollLoadingMs?: number; // faster cadence while a model is loading; default 400
  /** Test seam: resolve the PID listening on `port` (Linux). Default: ss + /proc scan. */
  pidOnPort?: (port: number) => number | null;
  /** Test seam: resolve a PID's executable path (for the stale-engine reaper).
   *  Default: readlink /proc/<pid>/exe. */
  exeForPid?: (pid: number) => string | null;
  /** Test seams for the preset file. Default: the temp-file + rename writer in
   *  model-presets.ts, and a plain read back. */
  writePresetImpl?: (filePath: string, contents: string) => void;
  readPresetImpl?: (filePath: string) => string;
}

// Keep at most 2 models resident: the router's LRU default (4) can overcommit
// RAM on consumer machines (two 8GB models already hurt); 2 still makes
// switching between a chat and a utility model free. Recorded in
// docs/engine-dependencies.md.
const MODELS_MAX = 2;
// Per-model idle sleep: the router frees an idle model's memory after this many
// seconds (status → 'sleeping'); the next request wakes it. 5 min per product
// decision 2026-07-14, raised to 15 min 2026-09-07 per Destin ("increase these to
// 15 and 25 minutes"). This is FINER-grained than the engine-wide idle stop
// (idleMs, 25 min) which tears down the whole process. Verified b9992.
// Exported because the preset file's `[*]` section now carries this value too
// (design §C2: engine-wide values a model may override move OFF the command
// line). One constant, two writers — a second copy would let the command line
// and the preset disagree about when a model sleeps.
export const SLEEP_IDLE_SECONDS = 900;
// Crash strike-out (spec §3.2): 3 crashes within 5 minutes → error state,
// stop retrying until the user acts (EngineCard's Restart button).
const STRIKE_LIMIT = 3;
const STRIKE_WINDOW_MS = 5 * 60_000;

/** Resolve the PID of the process listening on a localhost port, cross-platform:
 *  Linux `ss` (+ /proc fallback), macOS `lsof`, Windows `netstat`. Returns null
 *  when the tool is missing/unparseable or no listener is found — callers treat
 *  null as "unknown", never "safe", so a non-answer never blocks startup. */
function defaultPidOnPort(port: number): number | null {
  switch (process.platform) {
    case 'linux': {
      try {
        const out = execFileSync('ss', ['-ltnp'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
        const pid = parseSsListenerPid(out, port);
        if (pid != null) return pid;
      } catch { /* ss missing/failed — fall through to the /proc scan */ }
      return pidOnPortViaProc(port);
    }
    case 'darwin': {
      // -nP: no DNS/port-name lookups (fast); -sTCP:LISTEN: listeners only; -F p: PID-only output.
      const out = runTool('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'p']);
      return out ? parseLsofPid(out) : null;
    }
    case 'win32': {
      const out = runTool('netstat', ['-ano', '-p', 'tcp']);
      return out ? parseNetstatListenerPid(out, port) : null;
    }
    default:
      return null;
  }
}

function runTool(file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null; // tool missing, non-zero exit, or timeout — all non-fatal (unknown).
  }
}

// ---- pure parsers (unit-tested; no shell in tests) ----

/** Which model's section did the engine refuse, out of its own startup output?
 *
 *  llama-server names the section in the message — `option 'x' not recognized in
 *  preset '<model id>'` (probed, b10665) — and that is the ONLY thing that says
 *  which model is at fault, because the router refuses to initialise on a bad key
 *  in ANY section and then exits 1 before serving anything. Returns null for the
 *  global `[*]` section: there is no model to drop, so dropping one cannot help.
 *
 *  The match is GREEDY on purpose — do not "fix" it to `(.+?)`. Model ids are
 *  filenames, so `it's-a-model.gguf` is a real id; a non-greedy match would stop
 *  at the FIRST quote inside it and hand back a truncated id that matches no
 *  section. Greedy runs to the message's closing quote, which is the last one on
 *  the line, and keeps such an id intact. */
export function rejectedPresetModel(engineOutput: string): string | null {
  for (const line of engineOutput.split(/\r?\n/).reverse()) {
    const m = /not recognized in preset '(.+)'/.exec(line);
    if (!m) continue;
    const id = m[1];
    return id && id !== '*' ? id : null;
  }
  return null;
}

/** The engine's OWN sentence about the preset, with only its log prefix removed
 *  (`0.00.050.247 E srv  llama_server: `). This is what the user is eventually
 *  shown as that model's `lastLoadError`, so it is quoted, never paraphrased and
 *  never replaced with a guess at a cause. Falls back to the whole line when the
 *  prefix is not the shape we know. */
export function presetErrorLine(engineOutput: string): string {
  const line = engineOutput.split(/\r?\n/).reverse()
    .map((l) => l.trim())
    .find((l) => /not recognized in preset '/.test(l)) ?? '';
  return line.replace(/^[\d.]+\s+[A-Z]\s+\S+\s+[^:]*:\s*/, '');
}

/** The engine's own sentence for ANY of the four preset failures below, prefix
 *  stripped the same way.
 *
 *  WHY this exists beside `presetErrorLine`: that one only matches the "option
 *  'x' not recognized in preset 'y'" shape, because it answers "WHICH MODEL do
 *  we drop?". This one answers a different question — "what do we TELL the user
 *  about a run that started without their settings?" — and a file the grammar
 *  rejected outright names no model at all, so the narrow matcher returns an
 *  empty string for exactly the case the card most needs words for. Empty when
 *  the output says nothing we recognise; the card then falls back to the
 *  no-cause shape rather than inventing one. */
export function presetStartupLine(engineOutput: string): string {
  const line = engineOutput.split(/\r?\n/).reverse()
    .map((l) => l.trim())
    .find((l) => PRESET_FAILURE_PATTERNS.some((re) => re.test(l))) ?? '';
  return line.replace(/^[\d.]+\s+[A-Z]\s+\S+\s+[^:]*:\s*/, '');
}

/** The four shapes, in one place so `isPresetStartupFailure` and
 *  `presetStartupLine` can never drift apart — a sentence one recognised and the
 *  other did not would produce a fallback boot with nothing to say about it. */
const PRESET_FAILURE_PATTERNS = [
  /not recognized in preset '/,
  /failed to parse server config file/i,
  /preset file does not exist/i,
  /failed to initialize router models/i,
];

/** Did the engine die because of the PRESET FILE (as opposed to a bad driver, a
 *  busy port, a broken build)? Four sentences, all the engine's own words:
 *    - `option 'x' not recognized in preset 'y'`  — a key it does not know
 *    - `failed to parse server config file: <p>`  — the grammar rejected a line
 *    - `preset file does not exist`               — probed: a missing --models-preset
 *                                                   is itself a fatal startup error
 *    - `failed to open server preset file: <p>`   — probed with a chmod 000 file
 *
 *  The fourth is why the last clause matches the WRAPPER instead of a fifth
 *  transcribed sentence: llama-server prints `failed to initialize router
 *  models: %s` for every exception out of that one constructor, so matching the
 *  wrapper tracks the binary rather than a list copied out of it at one moment.
 *  A reworded, renamed or localised inner message then still reaches the
 *  fallback. The three specific patterns stay because they are what the unit
 *  tests name, and because the wrapper alone would not catch a message printed
 *  from anywhere else.
 *
 *  It costs one wasted second spawn when the router fails to initialise for a
 *  reason that is NOT the preset. That is the right trade: the wasted spawn
 *  costs a second, and the case it buys is an engine that never starts again. */
export function isPresetStartupFailure(engineOutput: string): boolean {
  return PRESET_FAILURE_PATTERNS.some((re) => re.test(engineOutput));
}

/** Linux `ss -ltnp` → PID of the process listening on `port`. Port match is exact
 *  (`:9920` must not match a `:992` query) and anchored to the LOCAL address column
 *  so a foreign/peer address can't false-match. */
export function parseSsListenerPid(stdout: string, port: number): number | null {
  for (const line of stdout.split('\n')) {
    if (!line.includes('LISTEN')) continue;
    const cols = line.trim().split(/\s+/);
    // ss -ltnp columns: State Recv-Q Send-Q Local:Port Peer:Port Process
    const local = cols[3] ?? '';
    const m = local.match(/:(\d+)$/);
    if (m && parseInt(m[1], 10) === port) {
      const p = /pid=(\d+)/.exec(line);
      if (p) return parseInt(p[1], 10);
    }
  }
  return null;
}

/** macOS `lsof -F p` output → PID. With `-F p`, PID lines are `p<pid>`. */
export function parseLsofPid(stdout: string): number | null {
  const line = stdout.split('\n').find((l) => /^p\d+$/.test(l.trim()));
  return line ? parseInt(line.trim().slice(1), 10) : null;
}

/** Windows `netstat -ano -p tcp` → PID of the LISTENING socket on `port`.
 *  Row shape: `  TCP    127.0.0.1:9920    0.0.0.0:0    LISTENING    12345`. */
export function parseNetstatListenerPid(stdout: string, port: number): number | null {
  for (const line of stdout.split('\n')) {
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    // cols: [TCP, local, foreign, state, pid]
    if (cols.length >= 5 && cols[1]?.endsWith(`:${port}`)) {
      const pid = parseInt(cols[cols.length - 1], 10);
      if (Number.isFinite(pid)) return pid;
    }
  }
  return null;
}

/** Linux /proc-only port→PID: find the socket inode for the LISTEN port in
 *  /proc/net/tcp(6), then the process whose fd links to that inode. */
function pidOnPortViaProc(port: number): number | null {
  const hex = ':' + port.toString(16).toUpperCase().padStart(4, '0');
  const inode = listenInodeForPort(hex);
  if (!inode) return null;
  let pids: string[];
  try { pids = fs.readdirSync('/proc'); } catch { return null; }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let fds: string[];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; } // perms / raced exit
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`) return parseInt(pid, 10);
      } catch { /* raced fd close */ }
    }
  }
  return null;
}

function listenInodeForPort(hexPort: string): string | null {
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let lines: string[];
    try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
    for (const line of lines.slice(1)) {
      const cols = line.trim().split(/\s+/);
      // cols[1]=local_address (hexIP:hexPort), cols[3]=state ('0A' = LISTEN), cols[9]=inode
      if (cols.length > 9 && cols[1]?.endsWith(hexPort) && cols[3] === '0A') return cols[9];
    }
  }
  return null;
}

/** Resolve a PID's executable path / image name, cross-platform — used by the
 *  stale-engine reaper to confirm the squatter is actually llama-server before
 *  killing it. Returns null when undeterminable — callers treat null as
 *  "unknown", never "safe", so an unconfirmable process is never killed. */
function defaultExeForPid(pid: number): string | null {
  switch (process.platform) {
    case 'linux':
      try { return fs.readlinkSync(`/proc/${pid}/exe`); } catch { return null; }
    case 'darwin': {
      const out = runTool('ps', ['-p', String(pid), '-o', 'comm=']);
      const name = out?.split('\n')[0]?.trim();
      return name || null;
    }
    case 'win32': {
      // Image name only (llama-server.exe) — enough to confirm it's our engine.
      const out = runTool('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
      const m = out && /^"([^"]+)"/.exec(out.trim());
      return m ? m[1] : null;
    }
    default:
      return null;
  }
}

export class EngineSupervisor extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: EngineRunState = 'stopped';
  private startPromise: Promise<string> | null = null; // single-flight ensureRunning
  private stopPromise: Promise<void> | null = null;    // single-flight stop (idle/restart)
  private crashTimes: number[] = [];
  private inFlight = 0;
  private lastActivity = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;
  private intentionalShutdown = false;
  private modelPollTimer: NodeJS.Timeout | null = null; // per-model /models state poll
  private lastModelSig = '';                             // last emitted (id→state) signature
  // The most recent /models reading. Two readers, one field: the SYNCHRONOUS
  // status() path answers "how much memory are the loaded models using?" without
  // a fetch, and the idle timer asks whether a keep-loaded model is resident.
  // null = never polled, which status() must report as "not asked yet" rather
  // than as zero (see loadedModelsBytes below); the idle check reads it as [].
  private lastPolledModels: EngineModel[] | null = null;
  private loadProgress = new Map<string, number>();      // modelId → max resident bytes seen while loading (monotonic)
  /** Per-model request counts (see trackedFetch). Separate from `inFlight`
   *  because "is THIS model busy?" and "is the engine busy?" are different
   *  questions and only the first can gate a per-model settings apply. */
  private inFlightByModel = new Map<string, number>();
  /** Model ids that actually got a `[section]` in the preset we last wrote. */
  private presetSections = new Set<string>();
  /** The dying child's own last output, kept for one attempt so start() can ask
   *  it which model section the router refused. */
  private lastStartupOutput = '';
  /** Are this run's per-model settings actually in force? False when the preset
   *  could not be written or the engine refused it and we booted without it —
   *  the Local Models card tells the user so rather than showing settings that
   *  are not doing anything. */
  private presetActive = false;

  /** WHY a run has no per-model settings, in the words of whatever refused them
   *  — the OS error from writing the file, or the engine's own startup sentence.
   *  Null when they ARE in force, and null when nothing legible was available
   *  (the card then says so without a cause rather than inventing one). Before
   *  this existed the reason was dropped in a bare `catch {}` and the user was
   *  told only that something had gone wrong. */
  private presetProblemText: string | null = null;

  constructor(private readonly opts: EngineSupervisorOpts) { super(); }

  /** Config as it is on disk RIGHT NOW. Never cached: the whole point of
   *  readConfig is that a settings change is picked up without rebuilding this
   *  object (design §B). */
  private config(): EngineSpawnConfig { return this.opts.readConfig(); }

  private cacheDir(): string { return this.config().cacheDir; }

  /** True when the running engine is honouring `models.ini`. */
  presetInForce(): boolean { return this.presetActive; }

  /** Why it is not, in the OS's or the engine's own words; null when it is, or
   *  when nothing legible was available. */
  presetProblem(): string | null { return this.presetProblemText; }

  /** How many requests naming `modelId` are in flight right now. This — not the
   *  engine-wide inFlight, and not the session ref-count — is what says a model
   *  is safe to re-configure: a model with an open chat tab never releases its
   *  ref, so a settings apply that waited on that would wait forever. */
  inFlightFor(modelId: string): number { return this.inFlightByModel.get(modelId) ?? 0; }

  status(): EngineRunState { return this.state; }

  /** OpenAI-compatible base URL (…/v1) while running, else null. The /v1
   *  suffix is deliberate: createOpenAICompatible appends /chat/completions,
   *  and llama-server serves both /v1/models and /v1/chat/completions there. */
  baseUrl(): string | null {
    return this.state === 'running' ? `http://127.0.0.1:${this.opts.port}/v1` : null;
  }

  /** Root URL for llama-server management endpoints (/health, /models). */
  private rootUrl(): string { return `http://127.0.0.1:${this.opts.port}`; }

  /** True while at least one tracked request is still being read — i.e. a reply
   *  is streaming through the engine RIGHT NOW.
   *
   *  WHY this is public: `stop()` has no in-flight guard of its own. The only
   *  `inFlight > 0` check in this class is inside the idle timer, so anything
   *  that restarts the engine on the user's behalf (a speed switch, design §B)
   *  has to ask first — otherwise it SIGTERMs llama-server mid-answer and the
   *  reply the user is watching dies halfway through a sentence. */
  busy(): boolean { return this.inFlight > 0; }

  resetStrikes(): void {
    this.crashTimes = [];
    if (this.state === 'error') this.state = 'stopped';
    this.emit('status-changed');
  }

  /** Start if needed; resolve with the OpenAI-compatible base URL. Single-
   *  flight: concurrent callers share one spawn. Throws plain language — the
   *  messages surface in the chat error banner via the registry. */
  ensureRunning(): Promise<string> {
    // A stop is in flight (idle shutdown or restart). The dying child still
    // holds the port for up to ~2s, and its state is briefly still 'running' —
    // so we must NOT hand back that stale baseUrl (the AI SDK would hit a
    // server being killed → ECONNREFUSED mid-turn) NOR spawn a second server
    // on the same port. Wait for the stop to finish, then (re)start cleanly.
    if (this.stopPromise) {
      return this.stopPromise.then(() => this.ensureRunning());
    }
    if (this.state === 'running') {
      this.touch();
      return Promise.resolve(this.baseUrl()!);
    }
    if (this.state === 'error') {
      return Promise.reject(new Error(
        'The local engine keeps crashing — open Settings → Providers and press "Restart engine".'
      ));
    }
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => { this.startPromise = null; });
    }
    return this.startPromise;
  }

  /** One spawn, with up to one recovery attempt.
   *
   *  WHY a retry exists at all: the preset file is shared by every model, and
   *  llama-server refuses to initialise on an unrecognised key in ANY section —
   *  so one bad setting on one model would otherwise take EVERY local model down
   *  at the next launch, with no way back from inside the app (design §C2). The
   *  engine names the offending section in its own error, so the second attempt
   *  drops exactly that model's section: that model loses its settings and gets
   *  a `lastLoadError`; every other model runs.
   *
   *  Booting WITHOUT the preset is the last resort under BOTH branches, and it
   *  is nested inside the omit-retry rather than being its alternative. The
   *  binary names only the FIRST bad section, so with two bad models the retry
   *  drops one and dies on the other — and if the omit-retry merely CONSUMED the
   *  one recovery attempt, that would be a permanently dead engine by exactly
   *  the route this code exists to prevent. That is not hypothetical: the next
   *  engine bump that renames or drops an option turns every saved copy of it
   *  into a bad section at once (b10665 already prints "deprecated --webui"),
   *  and a user who put such a flag on two models would lose every local model
   *  at the next launch with no way back from inside the app.
   *
   *  Both fallbacks lose per-model settings for that run and say so through
   *  presetInForce(); a dead engine is not an option. */
  private async start(): Promise<string> {
    try {
      return await this.attemptStart({});
    } catch (err) {
      const output = this.lastStartupOutput;
      const rejected = rejectedPresetModel(output);
      if (rejected !== null && this.presetSections.has(rejected)) {
        // The model the engine named. Whoever persists model settings turns this
        // into that model's `lastLoadError` — it never got a router row to fail
        // on, so this startup rejection is the only place its failure is visible.
        this.emit('preset-model-rejected', { modelId: rejected, message: presetErrorLine(output) });
        try {
          return await this.attemptStart({ omitModelId: rejected });
        } catch {
          // A second bad section (or anything else the preset does to this boot).
          // Drop the file entirely rather than leave the user with no engine.
          // The engine's own words survive into the card: the retry above ran
          // preparePreset successfully, which cleared them, so they are set here
          // AFTER that and immediately before the run that has no settings.
          this.presetProblemText = presetStartupLine(this.lastStartupOutput) || null;
          return this.attemptStart({ withoutPreset: true });
        }
      }
      if (isPresetStartupFailure(output)) {
        this.presetProblemText = presetStartupLine(output) || null;
        return this.attemptStart({ withoutPreset: true });
      }
      throw err;
    }
  }

  private async attemptStart(attempt: { omitModelId?: string; withoutPreset?: boolean }): Promise<string> {
    this.intentionalShutdown = false;
    this.state = 'starting';
    this.lastStartupOutput = '';
    this.emit('status-changed');
    const cfg = this.config();
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const readyDeadlineMs = this.opts.readyDeadlineMs ?? 30_000;
    const readyPollMs = this.opts.readyPollMs ?? 250;

    // Fix: llama-server's router mode treats a MISSING --models-dir as a fatal
    // error and exits during startup. The cache dir is only created lazily when
    // the first model downloads (model-downloader.ts), so a fresh install's
    // verify-boot — which runs BEFORE any model exists — always spawned the
    // engine against a nonexistent dir and it died instantly. Create it here so
    // the engine can always boot (an empty router is valid — it just serves no
    // models yet). A genuine mkdir failure (permissions, path is a file) is
    // surfaced specifically rather than misattributed to a bad build below.
    try {
      fs.mkdirSync(cfg.cacheDir, { recursive: true });
    } catch (err) {
      this.state = 'stopped';
      this.emit('status-changed');
      throw new Error(
        `The local engine's model folder could not be created at ${cfg.cacheDir}: ${(err as Error).message}`
      );
    }

    // Reap a stale orphan squatting on our fixed port BEFORE we spawn (2026-07-20).
    // Without a single-instance lock, a previous run's llama-server can outlive the app
    // (the old quit path lost the SIGTERM race) and keep the port bound. Our child then
    // can't bind, and — before the identity guard above — we'd have adopted the orphan.
    // If the listener is a llama-server that is NOT our live child, kill it so this
    // spawn gets the port. Where the port→PID tool is unavailable the reaper is a
    // no-op and the conflict simply surfaces as the child's startup exit (unchanged).
    this.reapStaleEngineOnPort();

    // The per-model settings file. Written fresh before EVERY spawn (the router
    // reads it once, at startup) and passed as --models-preset. `null` = it could
    // not be written or read back, or this attempt is the recovery boot that
    // deliberately runs without it.
    const presetPath = attempt.withoutPreset ? null : this.preparePreset(cfg, attempt.omitModelId);
    this.presetActive = presetPath !== null;

    const speed = cfg.speed ?? {};
    const child = spawn(
      this.opts.binaryPath,
      [
        '--host', '127.0.0.1', '--port', String(this.opts.port),
        '--no-webui',
        // --jinja from day one: Phase 2 tool calling requires it, and keeping
        // the spawn shape constant means Phase 2 changes no process contract.
        '--jinja',
        // --models-dir is what makes the router DISCOVER our dropped GGUFs and
        // auto-load them by filename id (verified b9992). LLAMA_CACHE alone does
        // NOT — it only tracks -hf auto-downloads (Plan C), so without this the
        // router serves ZERO models and every send 400s. Points at the same
        // cache dir so a dropped GGUF and an -hf pull live side by side.
        '--models-dir', cfg.cacheDir,
        '--models-max', String(MODELS_MAX),
        // Speed (2026-09-04, measured on b10665 — docs/engine-dependencies.md → "Speed flags"):
        // --spec-default = llama.cpp's draft-FREE speculative decoding (n-gram lookup
        // in the prompt itself, no second model). Edit/Write tool calls and rewrites
        // echo text the model has already seen, which is exactly what it predicts:
        // a 736-token file rewrite went 16 → 104 tok/s; a 700-token essay was
        // unchanged (the drafter never fires on novel prose), so there is no
        // measured penalty. Router children inherit it (probe-speed.mjs pins that).
        // Both switches default ON, so a config file that has never been touched
        // spawns exactly the command line that shipped before they existed.
        ...(speed.speculative !== false ? ['--spec-default'] : []),
        // 8-bit KEY cache: +40% generation at 16k of context and half the K-cache
        // memory, quality loss negligible. Deliberately K ONLY — a quantized V
        // cache is a FATAL load error whenever flash attention resolves to off
        // ("quantized V cache requires flash_attn", verified 2026-09-04 with -fa off),
        // and -fa is 'auto', so on a CPU fallback or an unsupported GPU every
        // local send would break. Keys never had that dependency.
        ...(speed.compressCache !== false ? ['--cache-type-k', 'q8_0'] : []),
        // The context length and the auto-sleep are NOT on the command line any
        // more: llama-server merges the router's own arguments OVER every preset,
        // so a `-c` here would outrank — and silently defeat — the per-model
        // values in models.ini. They live in the file's `[*]` section instead
        // (design §C2), and come back onto the command line in exactly one case:
        // the boot that has no usable preset file, below.
        ...(presetPath !== null
          ? ['--models-preset', presetPath]
          : ['--sleep-idle-seconds', String(cfg.sleepIdleSeconds ?? SLEEP_IDLE_SECONDS),
             '-c', String(cfg.contextSize)]),
      ],
      {
        // --models-dir above is what serves the GGUFs (both hand-placed and
        // Plan C's flat HTTP downloads). LLAMA_CACHE only matters for
        // llama-server's own -hf auto-download path, which nothing uses yet —
        // it's effectively vestigial (kept harmlessly). See engine-dependencies.md.
        env: { ...process.env, ...(this.opts.env ?? {}), LLAMA_CACHE: cfg.cacheDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    this.child = child;

    // Capture the child's output so a startup failure surfaces the REAL reason
    // (e.g. "'…/.cache/llama.cpp' does not exist or is not a directory") instead
    // of a generic guess. Kept to a bounded tail — llama-server is chatty. Also
    // DRAINS both pipes: an unread stdio: 'pipe' can back-pressure and stall the
    // child once its OS pipe buffer fills. See docs/error-message-standards.md.
    const MAX_OUTPUT_TAIL = 4000;
    let outputTail = '';
    const collect = (buf: Buffer) => {
      outputTail = (outputTail + buf.toString('utf8')).slice(-MAX_OUTPUT_TAIL);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    let exitedDuringStartup = false;
    const startupExitListener = () => { exitedDuringStartup = true; };
    child.once('exit', startupExitListener);

    const deadline = Date.now() + readyDeadlineMs;
    while (Date.now() < deadline && !exitedDuringStartup) {
      try {
        const res = await fetchImpl(`${this.rootUrl()}/health`, { method: 'GET' });
        // Identity guard (2026-07-20): /health answering "ok" is NOT proof that the
        // server we just spawned is the one listening. An orphaned llama-server from
        // a previous run keeps our fixed port bound, so our child fails to bind and
        // dies while the ORPHAN answers /health. Without this guard we would adopt
        // the orphan — and later count ITS death as OUR crash (the false "engine
        // crashed repeatedly" strike-out). Only accept when the listener is our child
        // (or identity can't be determined on this platform — fall through as before).
        if (res.ok && this.isOurChildOnPort(child)) {
          this.state = 'running';
          this.touch();
          child.off('exit', startupExitListener);
          child.on('exit', (code) => this.onExit(code));
          this.armIdleTimer();
          this.startModelPoll();
          this.emit('status-changed');
          return this.baseUrl()!;
        }
      } catch { /* not reachable yet — keep polling */ }
      await new Promise((r) => setTimeout(r, readyPollMs));
    }

    child.kill();
    this.child = null;
    this.state = 'stopped';
    this.emit('status-changed');
    // Keep the child's own words for start(), which asks them whether this was
    // the preset file's fault and, if so, which model's section to drop.
    this.lastStartupOutput = outputTail;
    if (exitedDuringStartup) {
      // Surface the child's own last output — it names the actual cause. Only
      // fall back to a general (non-committal, non-guessing) message when the
      // child died silently. See docs/error-message-standards.md.
      const detail = outputTail.trim();
      throw new Error(
        detail
          ? `The local engine exited during startup. Engine output:\n${detail}`
          : 'The local engine exited during startup without any output.'
      );
    }
    throw new Error(`The local engine did not start within ${Math.round(readyDeadlineMs / 1000)} seconds.`);
  }

  /** Write `models.ini` for this spawn and return its path, or null when it
   *  could not be written or read back.
   *
   *  WHY a null is a real, expected outcome and not an error: a missing or
   *  unreadable `--models-preset` is itself a FATAL startup error (probed —
   *  `preset file does not exist` → exit 1), so a supervisor that pointed the
   *  engine at a file it had failed to write would produce a dead engine rather
   *  than an engine without per-model settings. Null means "boot on the old
   *  command line instead"; per-model settings are lost for that run and
   *  presetInForce() says so.
   *
   *  The file is rewritten before EVERY spawn because the router reads it once,
   *  at startup, and because `~/.youcoded/` is shared between a dev instance and
   *  the built app — whatever the other one last wrote is not necessarily what
   *  this engine should run. */
  private preparePreset(cfg: EngineSpawnConfig, omitModelId?: string): string | null {
    const filePath = this.opts.presetPath;
    const write = this.opts.writePresetImpl ?? writePresetFile;
    const read = this.opts.readPresetImpl ?? ((p: string) => fs.readFileSync(p, 'utf8'));
    try {
      // Sections only for ids the cache scan actually found: a section naming a
      // model that is not on disk becomes a GHOST row in GET /models that can
      // never load and cannot be removed from inside the app (probed).
      const modelIds = scanGgufCache(cfg.cacheDir)
        .map((m) => m.id)
        .filter((id) => id !== omitModelId);
      const contents = renderPresetFile({
        contextSize: cfg.contextSize,
        sleepIdleSeconds: cfg.sleepIdleSeconds ?? SLEEP_IDLE_SECONDS,
        modelIds,
        settings: cfg.models ?? null,
      });
      write(filePath, contents);
      // Read back before betting the engine's startup on it. Deliberately NOT a
      // byte-for-byte comparison: the other instance sharing ~/.youcoded may
      // have rewritten the file between our rename and this read, and its copy
      // is just as valid as ours. What must be true is that a readable, non-empty
      // file is there for the engine to open.
      if (!read(filePath).trim()) {
        // A fact, not a guess: we wrote the file and read back nothing. (The
        // other instance sharing ~/.youcoded may have truncated it.)
        this.presetProblemText = `The settings file at ${filePath} was empty when the app read it back.`;
        return null;
      }
      // Which models really got a section — read off the file we just rendered
      // rather than recomputed, so the retry can only ever drop a section that
      // actually exists.
      this.presetSections = new Set(
        [...contents.matchAll(/^\[(.+)\]$/gm)].map((m) => m[1]).filter((id) => id !== '*')
      );
      this.presetProblemText = null;
      return filePath;
    } catch (err: any) {
      // Any I/O failure (permissions, a full disk, the path taken by a
      // directory) lands here. Not surfaced as an error: the engine still
      // starts, just without per-model settings. The OS's own message is KEPT
      // — this used to be a bare `catch {}`, which left the card able to say
      // only that something had gone wrong, and the standard in
      // docs/error-message-standards.md exists because of exactly that.
      this.presetSections = new Set();
      this.presetProblemText = err?.message ? String(err.message) : null;
      return null;
    }
  }

  /** Is the process listening on our port the child we just spawned? Returns
   *  true when identity can't be determined (the platform's port→PID tool is
   *  missing/unparseable) so we never regress a platform we can't inspect — the
   *  guard only ever REJECTS a confidently-foreign listener; it never blocks an
   *  unknown one. This is what stops us adopting an orphaned engine on our port. */
  private isOurChildOnPort(child: ChildProcess): boolean {
    if (child.pid == null) return true;            // not assigned yet — can't disprove
    const pid = (this.opts.pidOnPort ?? defaultPidOnPort)(this.opts.port);
    if (pid == null) return true;                  // unknown — don't block on a non-answer
    return pid === child.pid;
  }

  /** Kill a llama-server squatting on our port that is NOT our live child (a stale
   *  orphan from a previous run). Best-effort; never throws, and never touches our
   *  own child or a process we can't confirm is llama-server. Runs before spawn so
   *  this instance can actually bind the fixed port instead of adopting the orphan. */
  private reapStaleEngineOnPort(): void {
    const pid = (this.opts.pidOnPort ?? defaultPidOnPort)(this.opts.port);
    if (pid == null) return;                       // nothing (identifiably) on the port
    if (this.child && this.child.pid === pid) return; // our own live child — leave it
    const exe = (this.opts.exeForPid ?? defaultExeForPid)(pid);
    if (exe == null || !exe.includes('llama-server')) return; // not confirmably our engine — never kill it
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone / not ours to kill */ }
  }

  private onExit(code: number | null): void {
    const wasRunning = this.state === 'running';
    this.child = null;
    this.disarmIdleTimer();
    this.stopModelPoll();
    if (this.intentionalShutdown) { this.state = 'stopped'; this.emit('status-changed'); return; }
    if (!wasRunning) return;
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < STRIKE_WINDOW_MS);
    this.crashTimes.push(now);
    // Strike-out guards against a crash-respawn loop (bad build, broken GGUF):
    // past the limit the state is 'error' and ensureRunning refuses until the
    // user presses Restart. Below the limit, restart is LAZY — the next send's
    // ensureRunning respawns (no eager respawn: nothing may need the engine).
    this.state = this.crashTimes.length >= STRIKE_LIMIT ? 'error' : 'stopped';
    this.emit('status-changed');
    this.emit('crashed', { exitCode: code });
  }

  /** Single-flight: concurrent callers (idle timer + restart + app-quit) share
   *  ONE teardown. ensureRunning() awaits this.stopPromise so no one restarts
   *  the engine while the old child is still releasing the port. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this._stop().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  private async _stop(): Promise<void> {
    this.disarmIdleTimer();
    this.stopModelPoll();
    if (!this.child) {
      if (this.state !== 'error') this.state = 'stopped';
      return;
    }
    this.intentionalShutdown = true;
    const child = this.child;
    // Escalating kill (2026-07-20): a single SIGTERM is why engines leaked past app
    // quit — llama-server can ignore/stall on TERM (mid-write, stuck in a CUDA/Vulkan
    // call), the 2s timer fired, app.quit() won the race, and the orphaned server kept
    // our port bound for the NEXT instance to wrongly adopt. TERM → wait → KILL the
    // survivor, then wait for the exit that KILL guarantees. Still bounded so a
    // wedged child can't hang quit: total worst case ~3s.
    child.kill('SIGTERM');
    const exited = await this.waitForExit(child, 1_500);
    if (!exited) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      await this.waitForExit(child, 1_500);
    }
    this.child = null;
    this.state = 'stopped';
    this.emit('status-changed');
  }

  /** Resolve true if `child` exits within `ms`, false on timeout (timer unref'd so
   *  it can't hold the process open). */
  private waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (exited: boolean) => { if (!done) { done = true; clearTimeout(timer); resolve(exited); } };
      child.once('exit', () => finish(true));
      const timer = setTimeout(() => finish(false), ms);
      timer.unref?.();
    });
  }

  // ---- idle accounting -------------------------------------------------

  private touch(): void { this.lastActivity = Date.now(); }

  private armIdleTimer(): void {
    this.disarmIdleTimer();
    const idleMs = this.opts.idleMs ?? 25 * 60_000;
    const checkMs = this.opts.idleCheckMs ?? 60_000;
    this.idleTimer = setInterval(() => {
      if (this.state !== 'running') return;
      if (this.inFlight > 0) return; // a stream is still being read — never stop mid-turn
      // "Keep loaded" means keep loaded. The per-model auto-sleep already knows
      // to leave such a model alone (`sleep-idle-seconds = -1` in its preset
      // section), but this timer tears down the WHOLE engine, which would take
      // the kept model with it and make the setting a lie — the user's next
      // message would pay the full load again (design §C2).
      if (this.hasKeepLoadedResident()) return;
      if (Date.now() - this.lastActivity < idleMs) return;
      // Idle shutdown is transparent: the next send's ensureRunning restarts
      // the engine (first token just arrives slower) — spec §3.2.
      void this.stop();
    }, checkMs);
    this.idleTimer.unref?.();
  }

  private disarmIdleTimer(): void {
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
  }

  /** Is a model the user asked to keep loaded actually resident right now?
   *  Reads the last polled rows, so a model that has already been evicted or
   *  never loaded does not hold the engine open forever. */
  private hasKeepLoadedResident(): boolean {
    // Read inside a try: this runs in a setInterval callback, and NativeHome
    // deliberately RETHROWS a non-ENOENT I/O error on config.json (EACCES, EIO).
    // An exception thrown from a timer is uncaught — it would take the whole
    // Electron main process down, i.e. the app would vanish because a config
    // read failed. Unreadable config means "no keep-loaded model I can see",
    // which lets the engine idle out exactly as it did before this setting.
    let settings: EngineSpawnConfig['models'];
    try { settings = this.config().models; } catch { return false; }
    if (!settings) return false;
    for (const m of this.lastPolledModels ?? []) {
      if (m.state !== 'loaded' && m.state !== 'loading') continue;
      // Own-property lookup only: model ids are FILENAMES, so `constructor.gguf`
      // is a file a user can create and `settings.constructor` would answer with
      // a Function rather than undefined.
      if (!Object.prototype.hasOwnProperty.call(settings, m.id)) continue;
      if ((settings as Record<string, Partial<ModelSettings>>)[m.id]?.keepLoaded === true) return true;
    }
    return false;
  }

  /** The fetch handed to createOpenAICompatible for the local provider. Holds
   *  inFlight until the response body is FULLY read (or errored/cancelled) and
   *  touches lastActivity per chunk, so idle shutdown can never cut a stream. */
  trackedFetch: typeof fetch = async (input: any, init?: any) => {
    this.touch();
    this.inFlight++;
    // WHICH model this request is for, so a per-model settings apply can wait for
    // THAT model to go quiet. Neither of the two counts that already exist can
    // answer it: `inFlight` is engine-wide, and the session ref-count never drops
    // while a chat tab is open on the model — so an apply that waited on either
    // would wait for a moment that may never come (design §C2).
    const modelId = requestModelId(init);
    if (modelId) this.inFlightByModel.set(modelId, (this.inFlightByModel.get(modelId) ?? 0) + 1);
    const releaseModel = () => {
      if (!modelId) return;
      const next = (this.inFlightByModel.get(modelId) ?? 1) - 1;
      if (next > 0) this.inFlightByModel.set(modelId, next);
      else this.inFlightByModel.delete(modelId); // never leave a 0 row behind
    };
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(input, init);
    } catch (e) {
      this.inFlight--; releaseModel(); this.touch();
      throw e;
    }
    if (!res.body) { this.inFlight--; releaseModel(); this.touch(); return res; }
    let released = false;
    const release = () => {
      if (!released) { released = true; this.inFlight--; releaseModel(); this.touch(); }
    };
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const self = this;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { release(); controller.close(); return; }
          self.touch(); // streaming progress counts as activity
          controller.enqueue(value);
        } catch (e) {
          release();
          controller.error(e);
        }
      },
      cancel(reason) {
        release(); // interrupt/abort paths must not leak the inFlight hold
        return reader.cancel(reason);
      },
    });
    return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
  };

  // ---- model listing ----------------------------------------------------

  /** Running → GET /models (live status) UNIONED with a fresh disk scan, so a
   *  model downloaded after boot is LISTED without a restart (Amendment K2);
   *  stopped → cache scan alone (loaded:false).
   *  **Listed is not servable** — a row this union adds is a selectable model the
   *  router has never heard of, and a completion naming it 400s. Serveability is
   *  `ensureServable()`; never treat a row from here as usable on its own.
   *  Upstream /models schema is a tracked coupling — parse DEFENSIVELY, and
   *  keep the exact observed shape pinned in test-engine/probe-models.mjs +
   *  docs/engine-dependencies.md. */
  async listModels(): Promise<EngineModel[]> {
    if (this.state !== 'running') return scanGgufCache(this.cacheDir());
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(`${this.rootUrl()}/models`, { method: 'GET' });
      if (!res.ok) return scanGgufCache(this.cacheDir());
      const payload: any = await res.json();
      const rows: any[] = Array.isArray(payload?.data) ? payload.data
        : Array.isArray(payload?.models) ? payload.models
        : Array.isArray(payload) ? payload : [];
      // /models rows carry no size — the cache scan does, so index sizes by id
      // and merge them in (the UI's loading banner shows the model size).
      const scanned = scanGgufCache(this.cacheDir());
      const sizeById = new Map<string, number | null>();
      for (const m of scanned) sizeById.set(m.id, m.sizeBytes);
      const out: EngineModel[] = [];
      for (const row of rows) {
        const id = typeof row?.id === 'string' ? row.id : typeof row?.name === 'string' ? row.name : null;
        if (!id) continue; // skip malformed
        // A split GGUF is ONE model, but --models-dir lists one row per FILE.
        // Parts 2..N carry weights with no architecture header, so selecting one
        // can only ever 500 — drop them here, the single place router rows enter
        // the app (scanGgufCache already groups them on the engine-off path).
        if (isFollowerPart(id)) continue;
        // b9992's /models reports status as an OBJECT ({value:'loaded'|'unloaded'
        // |'loading'|'sleeping'}), NOT a bare string. Handle both so a schema
        // shift either way still reads.
        const statusValue = typeof row?.status === 'object' && row?.status
          ? row.status.value : row?.status;
        const state = mapModelState(statusValue);
        // Design §E5 — carry the router's own answer to "can this model look at
        // a picture?" through untouched. b10665 reports it as
        // `architecture.input_modalities`: `["text"]` for an ordinary model,
        // `["text","image"]` for one llama-server paired an mmproj beside
        // (captured live from the pinned binary, 2026-09-05). Parsed as
        // defensively as `status` above — /models is untrusted JSON and the
        // whole `architecture` object is optional — and a shape we cannot read
        // leaves the field UNSET rather than reporting "text only", because a
        // guessed `false` here silently drops a user's attached image with
        // nothing on screen to explain it.
        const architecture = typeof row?.architecture === 'object' && row?.architecture ? row.architecture : null;
        const rawModalities = architecture?.input_modalities;
        const inputModalities = Array.isArray(rawModalities) && rawModalities.every((x: unknown) => typeof x === 'string')
          ? (rawModalities as string[]) : undefined;
        out.push({
          id,
          sizeBytes: typeof row?.size === 'number' ? row.size
            : (sizeById.has(id) ? sizeById.get(id)! : null),
          loaded: state === 'loaded',
          state,
          ...(inputModalities ? { inputModalities } : {}),
        });
      }
      // Amendment K2: the router discovers GGUFs at BOOT, so union in the fresh
      // disk scan — a just-downloaded model is then LISTED (new-session picker via
      // catalogModels, memory guard via liveModels). Router rows win: they carry
      // live residency state; disk-only rows are 'unloaded' by definition.
      // LISTED IS NOT SERVABLE. A row this union added is a fully selectable model
      // the router has never heard of, and a completion naming it 400s with
      // `model 'X' not found` (measured 2026-08-16, after that reached a user).
      // Serveability is ensureServable()'s job, below — do not read this union as
      // making a post-boot download usable. It only makes it visible.
      const routerIds = new Set(out.map((m) => m.id));
      for (const m of scanned) {
        if (!routerIds.has(m.id)) out.push(m);
      }
      return out;
    } catch {
      return scanGgufCache(this.cacheDir()); // engine died mid-call — degrade to scan
    }
  }

  // ---- router rescan ----------------------------------------------------
  //
  // The router discovers GGUFs when it BOOTS and never looks again on its own:
  // upstream gates the rescan behind a `need_reload` dirty flag that is set ONLY
  // when a download the ROUTER itself started finishes. Our downloads are
  // app-side, so it is never set for us — a file we drop into --models-dir is
  // invisible to the router until we ask. There is no timer, no inotify, no
  // SIGHUP, and a plain GET /models does NOT rescan.
  //
  // Asking is `GET /models?reload=1` (any non-empty value). Verified 2026-08-16
  // two ways — disassembly of the shipped libllama-server-impl.so (b9992) and
  // upstream tools/server/server-models.cpp at the b9992 tag — after a real send
  // 400'd on a model that had been on disk for half an hour. NOTE the upstream
  // README also says "The server must be restarted after adding a new model";
  // that line is stale, contradicted by its own ?reload=1 note 150 lines later.

  /** Single-flight guard: N sessions picking the same fresh model must cause ONE
   *  rescan, not N. Cleared as soon as the in-flight scan resolves. */
  private refreshPromise: Promise<Set<string> | null> | null = null;

  /** Router-known model ids. `reload` re-scans --models-dir first. Returns null
   *  when the router can't be reached or its payload doesn't parse — a null is
   *  "don't know", NEVER "empty", because callers gate sends on this. */
  private async routerModelIds(reload: boolean): Promise<Set<string> | null> {
    if (this.state !== 'running') return null;
    try {
      const url = `${this.rootUrl()}/models${reload ? '?reload=1' : ''}`;
      const res = await (this.opts.fetchImpl ?? fetch)(url, { method: 'GET' });
      if (!res.ok) return null;
      const payload: any = await res.json();
      const rows: any[] = Array.isArray(payload?.data) ? payload.data
        : Array.isArray(payload?.models) ? payload.models
        : Array.isArray(payload) ? payload : [];
      const ids = new Set<string>();
      for (const row of rows) {
        const id = typeof row?.id === 'string' ? row.id : typeof row?.name === 'string' ? row.name : null;
        if (id) ids.add(id);
      }
      return ids;
    } catch {
      return null;
    }
  }

  /** The ROUTER's own word on one model's residency, or `null` for "could not be
   *  determined". Read WITHOUT `?reload=1` — a plain GET is a read, and this is
   *  polled (design §E4).
   *
   *  WHY it does not reuse listModels(): that one degrades to a cache scan on
   *  every failure, and a cache scan reports EVERY model as 'unloaded'. The one
   *  caller here — "Add vision", which is about to rename the model's file —
   *  needs "I could not find out" to be distinguishable from "it is unloaded",
   *  because renaming a file the model child still has open fails on Windows and
   *  moves an open file on Linux. For the same reason an unrecognised status
   *  value answers null rather than mapModelState's permissive 'unloaded'.
   *
   *  A model the router does not list at all IS unloaded: the router lists
   *  everything it knows about, so nothing it has never heard of can be
   *  resident. */
  async routerModelState(modelId: string): Promise<EngineModelState | null> {
    if (this.state !== 'running') return null;
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(`${this.rootUrl()}/models`, { method: 'GET' });
      if (!res.ok) return null;
      const payload: any = await res.json();
      const rows: any[] = Array.isArray(payload?.data) ? payload.data
        : Array.isArray(payload?.models) ? payload.models
        : Array.isArray(payload) ? payload : [];
      for (const row of rows) {
        const id = typeof row?.id === 'string' ? row.id : typeof row?.name === 'string' ? row.name : null;
        if (id !== modelId) continue;
        // b10665 reports status as an OBJECT ({value:'loaded'|…}); older shapes
        // sent a bare string. Both are read, anything else is "don't know".
        const statusValue = typeof row?.status === 'object' && row?.status ? row.status.value : row?.status;
        return statusValue === 'loaded' || statusValue === 'loading'
          || statusValue === 'sleeping' || statusValue === 'unloaded'
          ? statusValue as EngineModelState : null;
      }
      return 'unloaded';
    } catch {
      return null;
    }
  }

  /** Make the running router re-scan --models-dir. Call after a download lands or
   *  a model is deleted — NEVER from the poll: a rescan is a WRITE. Upstream's
   *  load_models() unloads a running model whose source changed or vanished, so on
   *  a 1.5s cadence this would be a reconciliation pass every tick, forever.
   *  Pinned by "the background model poll NEVER sends reload=1". */
  async refreshModels(): Promise<void> {
    if (this.state !== 'running') return; // the next boot scans the dir anyway
    await this.rescanOnce();
    void this.emitModelsIfChanged(); // let the UI see the new row promptly
  }

  private rescanOnce(): Promise<Set<string> | null> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.routerModelIds(true)
      .finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  /** True when the router can actually SERVE `modelId` right now — the gap K2's
   *  listing union leaves open, since that union makes a disk-only model a fully
   *  selectable row the router has never heard of. Rescans once if the model is
   *  missing, then re-checks.
   *
   *  FAILS OPEN (returns true) when the engine is stopped or the router can't
   *  answer: a probe that doesn't know must not be the thing that blocks a send
   *  the engine would have served fine. A false is therefore a real, positive
   *  "the router listed its models and yours was not among them". */
  async ensureServable(modelId: string): Promise<boolean> {
    if (this.state !== 'running') return true; // a fresh boot scans the dir
    const known = await this.routerModelIds(false);
    if (known === null) return true;           // unreachable → don't block
    if (known.has(modelId)) return true;
    const rescanned = await this.rescanOnce();
    if (rescanned === null) return true;
    return rescanned.has(modelId);
  }

  // ---- per-model state polling (drives the UI's load/sleep/unload signals) --

  /** Poll GET /models while running and emit 'models-changed' when the set of
   *  (id → state → loadedBytes) changes. llama-server has no push channel, so a
   *  cheap localhost poll is how the renderer learns a model slept/loaded/was
   *  evicted — and, while a model is LOADING, tracks its resident bytes for the
   *  "N GB / M GB" progress bar. Adaptive cadence: fast while anything is loading
   *  (smooth progress), slow otherwise (near-zero idle cost). Unref'd; started on
   *  ready, stopped on teardown. */
  private startModelPoll(): void {
    this.stopModelPoll();
    const schedule = () => {
      // Fast while a load is in flight (loadProgress tracks loading ids), else lazy.
      const loading = this.loadProgress.size > 0;
      const delay = loading ? (this.opts.modelPollLoadingMs ?? 400) : (this.opts.modelPollMs ?? 1500);
      this.modelPollTimer = setTimeout(() => {
        void this.emitModelsIfChanged().finally(() => {
          if (this.state === 'running') schedule();
        });
      }, delay);
      this.modelPollTimer.unref?.();
    };
    void this.emitModelsIfChanged().finally(() => { if (this.state === 'running') schedule(); });
  }

  private stopModelPoll(): void {
    if (this.modelPollTimer) { clearTimeout(this.modelPollTimer); this.modelPollTimer = null; }
    this.lastModelSig = '';

    this.loadProgress.clear();
    // Back to "not asked yet". A stopped engine holds no model in memory, but
    // the reading it left behind describes a process that no longer exists.
    this.lastPolledModels = null;
  }

  /** How much memory the engine's models are using right now, in bytes, or
   *  `undefined` when it has not been asked yet (engine not running, or the
   *  first poll has not landed).
   *
   *  **`loaded` rows ONLY — a `sleeping` row contributes nothing.** Sleeping is
   *  what `--sleep-idle-seconds` does to an idle model: it FREES the weights and
   *  reloads them on the next request. Adding those bytes in would tell the user
   *  their machine is holding gigabytes it has already handed back (R1-14).
   *
   *  A `loaded` row whose `sizeBytes` is unknown (`null` — a router row with no
   *  size and no file on disk to measure) adds nothing, so the total can only
   *  ever understate, never overstate. */
  loadedModelsBytes(): number | undefined {
    if (this.lastPolledModels === null) return undefined;
    return sumLoadedModelBytes(this.lastPolledModels);
  }

  /** Compute the live model set (with load progress) and emit if it changed. */
  private async emitModelsIfChanged(): Promise<void> {
    if (this.state !== 'running') return;
    let models: EngineModel[];
    try { models = await this.listModels(); } catch { return; }
    for (const m of models) {
      if (m.state === 'loading') {
        // Resident bytes of the model's child process, monotonic (Vulkan drops
        // RSS once weights move to VRAM, so hold the max seen this load).
        const rss = this.residentBytesForModel(m.id) ?? 0;
        const maxRss = Math.max(this.loadProgress.get(m.id) ?? 0, rss);
        this.loadProgress.set(m.id, maxRss);
        if (maxRss > 0) m.loadedBytes = m.sizeBytes ? Math.min(maxRss, m.sizeBytes) : maxRss;
      } else {
        this.loadProgress.delete(m.id); // load finished / not loading → drop tracker
      }
    }
    // Recorded on EVERY poll, not only when the signature changed. The emit
    // below is about telling the renderer something NEW; this is about the two
    // readers above having a current answer — and the idle timer must not be
    // answered with a stale set just because this poll matched the last one.
    this.lastPolledModels = models;
    const sig = models.map((m) => `${m.id}:${m.state}:${m.loadedBytes ?? ''}`).sort().join('|');
    if (sig !== this.lastModelSig) { this.lastModelSig = sig; this.emit('models-changed', models); }
  }

  /** Resident bytes of the router's child process serving `modelId` (its VmRSS,
   *  which climbs toward the file size as the GGUF is read into RAM). Linux only
   *  (reads /proc); undefined elsewhere → the UI falls back to an elapsed-only,
   *  indeterminate bar. The child's cmdline carries `--model …/<id>.gguf`, which
   *  the router process (with `--models-dir`) does not, so the needle is unique. */
  private residentBytesForModel(modelId: string): number | undefined {
    if (process.platform !== 'linux') return undefined;
    const needle = `/${modelId}.gguf`;
    let pids: string[];
    try { pids = fs.readdirSync('/proc'); } catch { return undefined; }
    for (const pid of pids) {
      if (!/^\d+$/.test(pid)) continue;
      let cmd: string;
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; } // NUL-separated
      if (!cmd.includes('--model') || !cmd.includes(needle)) continue;
      try {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const m = /VmRSS:\s+(\d+)\s+kB/.exec(status);
        if (m) return parseInt(m[1], 10) * 1024;
      } catch { /* raced exit */ }
    }
    return undefined;
  }

  /** Best-effort per-model unload (frees its memory now). Used when the last
   *  session bound to a model goes away. Silent on failure — a lingering model
   *  is harmless (the 5-min sleep reaps it), and there's no user to inform. */
  async unloadModel(modelId: string): Promise<void> {
    if (this.state !== 'running') return;
    try {
      await (this.opts.fetchImpl ?? fetch)(`${this.rootUrl()}/models/unload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
      });
    } catch { /* best-effort */ }
    void this.emitModelsIfChanged();
  }

  /** Force a model resident (the [Reload Model] button AND eager load-on-open).
   *  Fires the warm-up completion WITHOUT awaiting it so the caller returns
   *  immediately; the model poll (fast while loading) then tracks 'loading' +
   *  resident bytes → the progress bar. Routed through trackedFetch so it counts
   *  as activity (never reaped mid-load). */
  async loadModel(modelId: string): Promise<void> {
    const base = await this.ensureRunning(); // http://127.0.0.1:port/v1
    // The outcome is EMITTED rather than returned. This warm-up is deliberately
    // not awaited (the caller returns at once so the UI can show 'loading'), and
    // /models rows carry no failure text — so a push is the only way this
    // model's load failure can reach its settings dialog, where EngineManager
    // records it as `lastLoadError` (design §C2). The engine's own words are
    // carried out raw; the caller decides how to phrase them, never this class.
    void this.trackedFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
    }).then(async (res: Response) => {
      let body = '';
      // Read the body only on a failure, and never let a body that cannot be
      // read turn a real HTTP answer into a "could not be reached".
      if (!res.ok) { try { body = await res.text(); } catch { body = ''; } }
      this.emit('model-load-result', { modelId, ok: res.ok, status: res.status, body });
    }).catch((e: any) => {
      // The request could not be made at all — report what happened, not a guess.
      this.emit('model-load-result', {
        modelId, ok: false, status: null, body: (e?.message ?? String(e)).trim(),
      });
    });
    // Nudge the poll so 'loading' + the progress bar appear promptly (don't wait
    // for the next lazy tick). The adaptive poll then takes over at fast cadence.
    void this.emitModelsIfChanged();
  }

  /** Emit a fresh models-changed on demand. */
  async pollModelsNow(): Promise<void> {
    await this.emitModelsIfChanged();
  }
}

/** Σ `sizeBytes` over the rows the engine reports as `loaded`. Split out as a
 *  pure function so the rule it enforces — loaded yes, sleeping no — is testable
 *  without a running supervisor. */
export function sumLoadedModelBytes(models: EngineModel[]): number {
  let total = 0;
  for (const m of models) {
    if (m.state !== 'loaded') continue;
    if (typeof m.sizeBytes === 'number' && m.sizeBytes > 0) total += m.sizeBytes;
  }
  return total;
}

/** The model an OpenAI-compatible request names, read out of its JSON body.
 *
 *  The body is the only place it appears — the router takes one URL for every
 *  model and dispatches on this field — so there is nothing else to read.
 *
 *  A body that is not JSON, or carries no `model`, returns null and that request
 *  is not counted against ANY model. Be clear about which way that errs: this
 *  count gates a settings apply, so an uncounted request makes the apply MORE
 *  eager, not less — an unreadable body would let a reload land on a reply it
 *  could not see. It is safe today because every local chat body is a JSON
 *  string built by the AI SDK, and null then only means a management call that
 *  belongs to no model. Anything that starts sending a stream or a Buffer body
 *  here has to count it some other way. */
export function requestModelId(init: unknown): string | null {
  const body = (init as { body?: unknown } | null | undefined)?.body;
  if (typeof body !== 'string' || !body.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    return typeof parsed?.model === 'string' && parsed.model ? parsed.model : null;
  } catch {
    return null;
  }
}

/** Map llama-server's /models status.value to our EngineModelState. Unknown →
 *  'unloaded' (safe default; never claims a model is resident when unsure). */
function mapModelState(statusValue: unknown): EngineModelState {
  switch (statusValue) {
    case 'loaded': return 'loaded';
    case 'loading': return 'loading';
    case 'sleeping': return 'sleeping';
    default: return 'unloaded';
  }
}
