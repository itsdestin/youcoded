// stall-profiler.ts — a cheap, always-on CPU profile of the main thread, kept only when a stall happens.
//
// WHY (2026-10-22 freeze hunt): the owner's app froze for 3-50 s with the CPU idle-looking, and nobody can
// attach a profiler to his live app after the fact. So the app profiles ITSELF: node:inspector's Profiler
// runs in long rolling windows (a profile is only readable once it is stopped, so it is stopped and
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
/** WHY short-stall samples (hitch audit 2026-11-27): the owner's log showed engine stalls of 140-350 ms locked to a 5 s or
 *  10 s timer, hundreds an hour, and no profile ever named them — only 2 s+ stalls were saved. One stall of this size per
 *  SHORT_EVERY_MS is noted and saved at the NEXT scheduled rotation (no extra Profiler restart, so no extra stall),
 *  sliced to the half-minute before it — a repeating timer shows several times inside that slice. */
export const SHORT_STALL_PROFILE_MS = 300;
const SHORT_EVERY_MS = 10 * 60_000;
/** Short-stall files have their own cap, so they can never push a long freeze's profile out. */
const SHORT_MAX_FILES = 3;
const SHORT_PREFIX = 'short-stall-';
// WHY 10 minutes, not 25 s (hitch audit 2026-11-27): restarting V8's profiler is itself a main-thread block —
// Profiler.start re-logs every compiled function; measured 50-170 ms in a small Node script, and the saved stall
// profiles show ~100 ms inside inspector.post per rotation in the app. At one restart per 25 s the recorder caused up
// to ~144 stalls of 100 ms+ an hour on every user's machine. A long window costs one restart per 10 minutes; the
// saved file is cut down to the half-minute before the stall (SAVE_SPAN_MS), so what is written stays small.
const WINDOW_MS = 10 * 60_000;
/** How much profile before the first stall a saved file keeps. */
const SAVE_SPAN_MS = 30_000;
const SAMPLE_INTERVAL_US = 20_000;
const MAX_FILES = 10;
const MAX_BYTES = 50 * 1024 * 1024;
/** Stalls closer together than this share one saved profile instead of one file each. */
const MIN_SAVE_GAP_MS = 20_000;

export function stallProfilerDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YOUCODED_STALL_PROFILER === '0';
}

interface Window { startedAt: number; endedAt: number; profile: object; saved?: boolean }

/** The V8 .cpuprofile shape this file reads (times in microseconds on V8's own clock). */
export interface CpuProfile {
  nodes: Array<{ id: number; hitCount?: number; [k: string]: unknown }>;
  startTime: number; endTime: number; samples: number[]; timeDeltas: number[];
}

/** Keep only the samples between wall-clock fromMs and toMs. The profile's clock is mapped to wall time through its
 *  end (the window closed at endedAtMs, which is the profile's endTime). Nodes are kept whole (hit counts recounted),
 *  so DevTools and summarise-profile.mjs load the result like any other profile. */
export function sliceProfile(profile: CpuProfile, endedAtMs: number, fromMs: number, toMs: number): CpuProfile {
  const toProfile = (ms: number) => profile.endTime - (endedAtMs - ms) * 1000;
  const from = toProfile(fromMs);
  const to = toProfile(toMs);
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  const hits = new Map<number, number>();
  let t = profile.startTime;
  let last = -1;
  let first = -1;
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i] ?? 0;
    if (t < from || t > to) continue;
    if (first < 0) first = t;
    timeDeltas.push(last < 0 ? 0 : t - last);
    samples.push(profile.samples[i]);
    hits.set(profile.samples[i], (hits.get(profile.samples[i]) ?? 0) + 1);
    last = t;
  }
  if (samples.length === 0) return profile; // nothing matched (clock mapping off): keep the whole window, never lose it
  // Keep only the call-tree nodes the kept samples use, plus their ancestors, so a file holds the slice's tree and not
  // the whole window's (a 10-minute tree is several times larger than the 30 s that matter).
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of (n.children as number[] | undefined) ?? []) parent.set(c, n.id);
  const keep = new Set<number>();
  for (const id of hits.keys()) for (let at: number | undefined = id; at !== undefined && !keep.has(at); at = parent.get(at)) keep.add(at);
  return {
    ...profile,
    nodes: profile.nodes.filter((n) => keep.has(n.id)).map((n) => ({
      ...n, hitCount: hits.get(n.id) ?? 0,
      ...(Array.isArray(n.children) ? { children: (n.children as number[]).filter((c) => keep.has(c)) } : {}),
    })),
    startTime: first, endTime: last, samples, timeDeltas,
  };
}

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
  private shortStall: { endedAt: number; ms: number } | null = null;
  private lastShortAt = -Infinity;
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
      this.saveNotedShortStall(w);
      // WHY three (2026-11-27, with the 10-minute window): the window a stall is in, the one before it (a timer rotation
      // may land while the stall waits out the save gap) and the flush's own tiny one. Four 10-minute windows would hold
      // ~40 minutes of raw profile in the main process for nothing.
      if (this.done.length > 3) this.done.shift();
      return w;
    } catch { this.teardown(); return null; }
  }

  /** A stall too short for onStall: note at most one per SHORT_EVERY_MS, saved when the running window next closes. */
  onShortStall(endedAtMs: number, ms: number): void {
    if (!this.session || ms < SHORT_STALL_PROFILE_MS || ms >= STALL_PROFILE_MIN_MS || this.shortStall) return;
    if (this.now() - this.lastShortAt < SHORT_EVERY_MS) return;
    this.lastShortAt = this.now();
    this.shortStall = { endedAt: endedAtMs, ms };
  }

  private saveNotedShortStall(w: Window): void {
    const s = this.shortStall;
    if (!s || w.endedAt < s.endedAt) return;
    this.shortStall = null;
    const name = `${SHORT_PREFIX}${new Date(s.endedAt).toISOString().replace(/[:.]/g, '-')}-${Math.round(s.ms)}ms.cpuprofile`;
    const sliced = sliceProfile(w.profile as CpuProfile, w.endedAt, s.endedAt - s.ms - SAVE_SPAN_MS, s.endedAt + 1000);
    const stalls = [{ ts: new Date(s.endedAt).toISOString(), ms: Math.round(s.ms) }];
    this.writing = this.writing.then(() => this.save(name, sliced, stalls)).catch(() => {});
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
      const sliced = sliceProfile(w.profile as CpuProfile, w.endedAt, p.startedAt - SAVE_SPAN_MS, p.stalls[p.stalls.length - 1].endedAt + 1000);
      this.writing = this.writing.then(() => this.save(name, sliced, stalls)).catch(() => {});
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
    const remove = async (n: string) => {
      await fsp.rm(join(this.o.dir, n), { force: true });
      await fsp.rm(join(this.o.dir, `${n}.stalls.json`), { force: true });
    };
    // Each kind keeps its own count; the byte cap covers both.
    const short = live.filter((f) => f.n.startsWith(SHORT_PREFIX));
    const long = live.filter((f) => !f.n.startsWith(SHORT_PREFIX));
    while (short.length > SHORT_MAX_FILES) await remove(short.shift()!.n);
    while (long.length > this.o.maxFiles) await remove(long.shift()!.n);
    const rest = [...short, ...long].sort((a, b) => a.t - b.t || (a.n < b.n ? -1 : 1));
    let total = rest.reduce((s, f) => s + f.size, 0);
    while (rest.length > 0 && total > this.o.maxBytes) {
      const old = rest.shift()!;
      total -= old.size;
      await remove(old.n);
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
