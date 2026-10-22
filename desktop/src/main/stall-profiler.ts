// stall-profiler.ts — a cheap, always-on CPU profile of the main thread, kept only when a stall happens.
//
// WHY (2026-10-22 freeze hunt): the owner's app froze for 3-50 s with the CPU idle-looking, and nobody can
// attach a profiler to his live app after the fact. So the app profiles ITSELF: node:inspector's Profiler
// runs in short rolling windows (a profile is only readable once it is stopped, so it is stopped and
// restarted every WINDOW_MS), the last two windows are kept in memory, and when the main-stall detector
// (hitch-recorder.ts) reports a stall of 2 s or more, the window(s) that cover it are written as
// .cpuprofile files — loadable in Chrome DevTools or VS Code — named with the stall's timestamp so they line
// up with the `main-stall` line in hitches.jsonl. Nothing is written when nothing stalls.
//
// Cost control: sampling every 20 ms (not V8's default 1 ms), at most 10 files / 50 MB on disk, writes are async,
// and YOUCODED_STALL_PROFILER=0 turns the whole thing off. A profile written while the thread was blocked
// still shows the blocking function, because V8's sampler runs on its own thread.
import inspector from 'node:inspector';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

export const STALL_PROFILE_MIN_MS = 2000;
const WINDOW_MS = 25_000;
const SAMPLE_INTERVAL_US = 20_000;
const MAX_FILES = 10;
const MAX_BYTES = 50 * 1024 * 1024;
/** Stalls closer together than this share one saved profile instead of one file each. */
const MIN_SAVE_GAP_MS = 20_000;

export function stallProfilerDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YOUCODED_STALL_PROFILER === '0';
}

interface Window { startedAt: number; endedAt: number; profile: object; saved?: boolean }

export interface StallProfilerOptions {
  dir: string;
  now?: () => number;
  windowMs?: number;
  sampleIntervalUs?: number;
  maxFiles?: number;
  maxBytes?: number;
}

export class StallProfiler {
  private session: inspector.Session | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private windowStart = 0;
  private done: Window[] = [];           // newest last, at most 2
  private writing: Promise<void> = Promise.resolve();
  private lastSaveAt = 0;
  private pending: { startedAt: number; stalls: Array<{ endedAt: number; ms: number }> } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  private readonly o: Required<Omit<StallProfilerOptions, 'now'>>;

  constructor(opts: StallProfilerOptions) {
    this.now = opts.now ?? Date.now;
    this.o = { windowMs: WINDOW_MS, sampleIntervalUs: SAMPLE_INTERVAL_US, maxFiles: MAX_FILES, maxBytes: MAX_BYTES, ...opts };
  }

  /** Begin profiling. Never throws: no inspector (or a debugger already attached) just means no profiles. */
  start(): boolean {
    try {
      const s = new inspector.Session();
      s.connect();
      this.session = s;
      this.post('Profiler.enable');
      this.post('Profiler.setSamplingInterval', { interval: this.o.sampleIntervalUs });
      this.post('Profiler.start');
      this.windowStart = this.now();
      this.timer = setInterval(() => this.rotate(), this.o.windowMs);
      this.timer.unref();
      return true;
    } catch { this.teardown(); return false; }
  }

  /** The main-process Session calls back synchronously; throws surface as errors, results as the value. */
  private post(method: string, params?: object): any {
    let out: any; let error: unknown;
    this.session!.post(method, params as any, (err: Error | null, res?: any) => { error = err; out = res; });
    if (error) throw error;
    return out;
  }

  /** Stop the running window, keep it (newest two only), start the next. */
  private rotate(): Window | null {
    if (!this.session) return null;
    try {
      const { profile } = this.post('Profiler.stop');
      const w: Window = { startedAt: this.windowStart, endedAt: this.now(), profile };
      this.windowStart = w.endedAt;
      this.post('Profiler.start');
      this.done.push(w);
      // Four, not two: a stall waiting out the burst gap must still find its window after a timer rotation and the
      // flush's own rotation.
      if (this.done.length > 4) this.done.shift();
      return w;
    } catch { this.teardown(); return null; }
  }

  /** A main-thread stall of `ms` ended at `endedAtMs`. Saves the profile window(s) that cover it. */
  onStall(endedAtMs: number, ms: number): Promise<void> {
    if (!this.session || ms < STALL_PROFILE_MIN_MS) return Promise.resolve();
    // WHY merged (review 2026-10-22): a burst of stalls used to close a window per stall and write a file per window,
    // which both duplicated the same samples and pushed older, distinct profiles out of the 10-file cap. Stalls within
    // MIN_SAVE_GAP_MS of the last save are folded into ONE later save that covers all of them.
    const first = this.pending;
    this.pending = { startedAt: Math.min(first?.startedAt ?? Infinity, endedAtMs - ms), stalls: [...(first?.stalls ?? []), { endedAt: endedAtMs, ms }] };
    const wait = this.lastSaveAt + MIN_SAVE_GAP_MS - this.now();
    if (wait > 0) {
      if (!this.pendingTimer) {
        this.pendingTimer = setTimeout(() => { this.pendingTimer = undefined; void this.flushPending(); }, wait);
        this.pendingTimer.unref();
      }
      return Promise.resolve();
    }
    return this.flushPending();
  }

  private flushPending(): Promise<void> {
    const p = this.pending;
    this.pending = null;
    if (!p || !this.session) return this.writing;
    this.rotate(); // closes the window the stall(s) are in (still running right now)
    // Each window is written at most once, however many stalls it covers.
    const covering = this.done.filter((w) => w.endedAt >= p.startedAt && !w.saved);
    if (covering.length === 0) return this.writing;
    this.lastSaveAt = this.now();
    // Named by the FIRST stall it covers (it matches that main-stall line in hitches.jsonl); the sidecar .stalls.json
    // beside it lists EVERY stall the file covers, so each one in a burst can be matched to this profile.
    const first = p.stalls[0];
    const stamp = new Date(first.endedAt).toISOString().replace(/[:.]/g, '-');
    const stalls = p.stalls.map((x) => ({ ts: new Date(x.endedAt).toISOString(), ms: Math.round(x.ms) }));
    covering.forEach((w, i) => {
      w.saved = true;
      const name = `stall-${stamp}-${Math.round(first.ms)}ms${covering.length > 1 ? `-part${i + 1}` : ''}.cpuprofile`;
      this.writing = this.writing.then(() => this.save(name, w.profile, stalls)).catch(() => {});
    });
    return this.writing;
  }

  private async save(name: string, profile: object, stalls: Array<{ ts: string; ms: number }>): Promise<void> {
    await fsp.mkdir(this.o.dir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(join(this.o.dir, name), JSON.stringify(profile), { mode: 0o600 });
    await fsp.writeFile(join(this.o.dir, `${name}.stalls.json`), JSON.stringify({ stalls }), { mode: 0o600 });
    await this.prune();
  }

  /** Keep at most maxFiles files and maxBytes bytes, deleting the oldest first. */
  private async prune(): Promise<void> {
    const names = (await fsp.readdir(this.o.dir)).filter((n) => n.endsWith('.cpuprofile'));
    const files = await Promise.all(names.map(async (n) => {
      const st = await fsp.stat(join(this.o.dir, n)).catch(() => null);
      return st ? { n, size: st.size, t: st.mtimeMs } : null;
    }));
    const live = files.filter((f): f is { n: string; size: number; t: number } => f !== null).sort((a, b) => a.t - b.t || (a.n < b.n ? -1 : 1));
    let total = live.reduce((s, f) => s + f.size, 0);
    while (live.length > 0 && (live.length > this.o.maxFiles || total > this.o.maxBytes)) {
      const old = live.shift()!;
      total -= old.size;
      await fsp.rm(join(this.o.dir, old.n), { force: true });
      await fsp.rm(join(this.o.dir, `${old.n}.stalls.json`), { force: true });
    }
  }

  private teardown(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    try { this.session?.disconnect(); } catch { /* ignore */ }
    this.session = null;
  }

  /** Quit: stop profiling and wait for any file being written. */
  async stop(): Promise<void> {
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = undefined; }
    if (this.pending) await this.flushPending().catch(() => {}); // a stall waiting for its save is not lost at quit
    this.teardown();
    this.done = [];
    await this.writing.catch(() => {});
  }
}

export function startStallProfiler(opts: StallProfilerOptions, env: NodeJS.ProcessEnv = process.env): StallProfiler | null {
  if (stallProfilerDisabled(env)) return null;
  const p = new StallProfiler(opts);
  return p.start() ? p : null;
}
