// Always-on, low-overhead "hitch recorder" (perf gap review M1-M3, 2026-10-05).
//
// WHAT IT IS: one private local file, `<userData>/perf/hitches.jsonl` (+ `hitches.1.jsonl`
// after rotation, ~10 MiB max in total), one JSON object per line. It records each time a
// window froze for 100 ms or more, each slow keypress/click, each time the main process
// stopped answering, once a minute the memory/CPU of every app process, and once per launch
// the startup timings. Read it with `scripts/perf-lab/hitch-report.mjs`.
//
// RECORDED, per line (always): ts (ISO), v (app version), launch (random id of this launch),
// win (window id w1, w2 ... of this launch), kind.
//  - frame:  duration, blocking time, style+layout time, render time, whether a keypress/click
//            was waiting, and the 3 slowest scripts: invoker TYPE, invoker name with '#id'
//            parts removed, function name, the bundle file BASENAME (index-abc.js; query and
//            path stripped), character position, ms, forced-layout ms.
//  - event:  type (keydown/pointerdown/pointerup/click/input), duration, input delay, handler
//            time, wait-to-draw time, a COARSE target kind (terminal/text-input/chat/other).
//  - task:   duration only (fallback when the browser has no long-animation-frame).
//  - context, only when a hitch is recorded: page visible/hidden, focused, view mode
//            (chat/terminal), whether a dialog or full screen is open (yes/no), pixel ratio,
//            DOM element count (at most every 10 s), session COUNT, window COUNT.
//  - main-stall: how many ms the main process did not respond, and the NAME of the last IPC
//            channel it started plus how long ago (a hint, not proof).
//  - minute: event-loop delay p50/p99/max, memory + CPU % per process type (browser, each
//            renderer, GPU, utility), main-process heap, window count, session count, and
//            the renderers' tallies of 50-100 ms frames.
//  - startup: millisecond gaps between the boot marks, first window loaded, the renderer's
//            yc:* marks and first-contentful-paint.
// NEVER recorded: message text, prompts, file names or paths of the user's files, keys typed,
// element text or content, DOM ids/classes of page elements, session names, URLs, tokens.
// Function names and bundle file basenames are the app's own code, not user content. Inline
// (data:/blob:) script sources are recorded as "inline". Session names are never read — only
// the number of sessions.
//
// COST RULES: nothing here blocks (all writes async, batched, <= one flush / 2 s); the only
// recurring timer is ONE unref'd 1 s interval (reads event-loop delay; every 60th tick also
// writes the minute line) — justified because stall detection and the memory-over-hours record
// need a clock. Renderer data is re-validated field by field (hitch-validate.ts) and
// rate-limited again here, so a compromised renderer cannot flood or poison the file.
// OFF SWITCH: env YOUCODED_HITCH_LOG=0 turns everything off (no file, no timers, no hooks).
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { monitorEventLoopDelay, createHistogram, type Histogram, type RecordableHistogram } from 'node:perf_hooks';
import { RotatingJsonlWriter } from './hitch-log-writer';
import { validateBatch, cleanString, type CleanBatch } from './hitch-validate';

export const HITCH_CHANNEL = 'perf:hitch-batch';
/** A main-process stall is written at or above this many ms. */
export const STALL_MS = 100;
/** Event-loop sampling interval. WHY tunable: each sample is a timer wake-up of the main process, and in Electron a
 *  wake-up is far dearer than in plain Node (measured 2026-10-05: 50/s cost ~1.2% of a core idle). */
export const DEFAULT_RESOLUTION_MS = 20;
export function loopResolution(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.YOUCODED_HITCH_LOOP_MS);
  return Number.isFinite(n) && n >= 10 && n <= 1000 ? Math.round(n) : DEFAULT_RESOLUTION_MS;
}
const PER_WINDOW_PER_MIN = 30;
const BATCHES_PER_WINDOW_PER_MIN = 40;

export function hitchLogDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YOUCODED_HITCH_LOG === '0';
}

// --- "what was main last doing" hook -------------------------------------------------------
export interface IpcTrace { last(): { channel: string; agoMs: number } | null }

/** Wrap ipcMain.handle / ipcMain.on ONCE, before the handlers register, so the recorder can say
 *  which channel main started last. A wrapper only stores a name and a timestamp (nanoseconds).
 *  `wrapper.listener` keeps ipcMain.off(channel, original) working (EventEmitter looks for it). */
export function traceIpc(ipcMain: { handle: (...a: any[]) => any; on: (...a: any[]) => any }, now: () => number = Date.now): IpcTrace {
  let channel = '';
  let at = 0;
  const wrap = (ch: unknown, fn: (...a: any[]) => any) => {
    // Channel names are app constants, but a dynamic one could carry an id: mask long id-like runs.
    const name = cleanString(ch, 60).replace(/[0-9a-f]{8}[0-9a-f-]{4,}/gi, '*');
    // The recorder's own batches are not 'work main was doing' — leave them out or every stall names us.
    if (ch === HITCH_CHANNEL) return fn;
    const w = function (this: unknown, ...args: any[]) { channel = name; at = now(); return fn.apply(this, args); };
    (w as any).listener = fn;
    return w;
  };
  const origHandle = ipcMain.handle.bind(ipcMain);
  const origOn = ipcMain.on.bind(ipcMain);
  ipcMain.handle = (ch: unknown, fn: (...a: any[]) => any) => origHandle(ch, wrap(ch, fn));
  ipcMain.on = (ch: unknown, fn: (...a: any[]) => any) => origOn(ch, wrap(ch, fn));
  return { last: () => (channel ? { channel, agoMs: now() - at } : null) };
}

// --- the recorder --------------------------------------------------------------------------
export interface ProcessMetric { type: string; memory?: { workingSetSize?: number }; cpu?: { percentCPUUsage?: number } }
export interface RecorderDeps {
  userDataDir: string;
  appVersion: string;
  ipcMain: { on: (ch: string, fn: (e: any, raw: unknown) => void) => unknown };
  getWindowCount: () => number;
  getSessionCount: () => number;
  getAppMetrics: () => ProcessMetric[];
  getMarks: () => Array<{ name: string; t: number }>;
  processStartMs: () => number;
  trace?: IpcTrace;
  now?: () => number;
  writer?: Pick<RotatingJsonlWriter, 'append' | 'flush'>;
  /** Test seams: the per-second event-loop monitor and the per-minute accumulator. */
  histogram?: () => Histogram & { enable?: () => boolean; disable?: () => boolean };
  minuteHistogram?: () => RecordableHistogram;
  /** Tests drive ticks by hand; production passes true to start the 1 s timer. */
  startTimer?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface WindowState { id: string; minStart: number; minCount: number; batchStart: number; batchCount: number }
const mb = (bytes: number) => Math.round(bytes / 1048576 * 10) / 10;
const r1 = (ms: number) => Math.round(ms * 10) / 10;

export class HitchRecorder {
  readonly launch = randomUUID().slice(0, 8);
  private readonly res: number;
  private readonly now: () => number;
  private readonly writer: Pick<RotatingJsonlWriter, 'append' | 'flush'>;
  private readonly hist: Histogram & { enable?: () => boolean; disable?: () => boolean };
  private readonly minuteHist: RecordableHistogram;
  private readonly windows = new Map<number, WindowState>();
  private nextWindow = 1;
  private tick = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private minuteTally = { frames: 0, framesMs: 0, over: 0, overMs: 0, dropped: 0, rejected: 0, entries: 0 };
  private stalls = 0;
  private startupWritten = false;
  private mainLoadedAt = 0;
  private startupFallback: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly d: RecorderDeps) {
    this.now = d.now ?? Date.now;
    this.res = loopResolution(d.env);
    this.writer = d.writer ?? new RotatingJsonlWriter({ dir: join(d.userDataDir, 'perf') });
    const mk = d.histogram ?? (() => monitorEventLoopDelay({ resolution: this.res }));
    this.hist = mk();
    this.hist.enable?.();
    // The per-minute record merges each second's histogram into this one (percentiles survive the 1 s reset).
    this.minuteHist = (d.minuteHistogram ?? (() => createHistogram()))();
    d.ipcMain.on(HITCH_CHANNEL, (e, raw) => this.onBatch(e?.sender?.id ?? -1, raw));
    if (d.startTimer) { this.timer = setInterval(() => this.onSecond(), 1000); this.timer.unref(); }
  }

  private line(kind: string, extra: Record<string, unknown>, win?: string, ts = this.now()): void {
    this.writer.append({ ts: new Date(ts).toISOString(), v: this.d.appVersion, launch: this.launch, ...(win ? { win } : {}), kind, ...extra });
  }

  // ---- renderer batches ----
  private windowFor(id: number): WindowState {
    let w = this.windows.get(id);
    if (!w) { w = { id: `w${this.nextWindow++}`, minStart: 0, minCount: 0, batchStart: 0, batchCount: 0 }; this.windows.set(id, w); }
    return w;
  }

  onBatch(senderId: number, raw: unknown): void {
    try {
      const t = this.now();
      const w = this.windowFor(senderId);
      if (this.windows.size > 64) return; // a renderer cannot mint windows; ids come from webContents
      if (t - w.batchStart >= 60_000) { w.batchStart = t; w.batchCount = 0; }
      if (++w.batchCount > BATCHES_PER_WINDOW_PER_MIN) { this.minuteTally.rejected++; return; }
      const b = validateBatch(raw, t);
      if (!b) { this.minuteTally.rejected++; return; }
      this.minuteTally.frames += b.tally.f; this.minuteTally.framesMs += b.tally.fms;
      this.minuteTally.over += b.tally.over; this.minuteTally.overMs += b.tally.oms; this.minuteTally.dropped += b.dropped; this.minuteTally.rejected += b.rejected;
      if (t - w.minStart >= 60_000) { w.minStart = t; w.minCount = 0; }
      const sessions = this.d.getSessionCount();
      const windows = this.d.getWindowCount();
      for (const e of b.entries) {
        // Second, independent cap: 30 detailed entries per window per minute no matter what the renderer says.
        if (w.minCount >= PER_WINDOW_PER_MIN) { this.minuteTally.over++; this.minuteTally.overMs += e.d; continue; }
        w.minCount++;
        this.minuteTally.entries++;
        const { k, t: et, ...rest } = e;
        this.line(k, { ...rest, sessions, windows, ...(b.kind !== 'main' ? { window: b.kind } : {}), src: b.mode }, w.id, et);
      }
      if (b.startup) this.onRendererStartup(b, w.id);
    } catch { /* instrumentation never throws into main */ }
  }

  // ---- startup ----
  /** Called when the main window's page has loaded (perfMark main:main-window:did-finish-load). */
  noteMainWindowLoaded(): void {
    this.mainLoadedAt = this.now();
    // If the renderer never reports (broken page, off-switch in preload), still write the main-side half after 30 s.
    this.startupFallback = setTimeout(() => this.writeStartup(null), 30_000);
    this.startupFallback.unref();
  }

  private onRendererStartup(b: CleanBatch, win: string): void {
    if (b.kind !== 'main' || !b.startup) return;
    this.writeStartup({ marks: b.startup.marks, fcp: b.startup.fcp }, win);
  }

  private writeStartup(renderer: { marks: Record<string, number>; fcp: number | null } | null, win?: string): void {
    if (this.startupWritten) return;
    this.startupWritten = true;
    if (this.startupFallback) { clearTimeout(this.startupFallback); this.startupFallback = undefined; }
    const start = this.d.processStartMs();
    const marks: Record<string, number> = {};
    let n = 0;
    for (const m of this.d.getMarks()) if (n++ < 60) marks[m.name] = Math.max(0, Math.round(m.t - start));
    this.line('startup', {
      main: marks,
      loadedMs: this.mainLoadedAt ? Math.max(0, Math.round(this.mainLoadedAt - start)) : null,
      renderer: renderer ?? null,
    }, win);
  }

  /** Fold this second's distribution into the minute histogram, then the caller resets the second's.
   *  WHY not histogram.add(): Node only merges RecordableHistograms, not the event-loop monitor's.
   *  The monitor's percentile table (a handful of rows) is replayed as samples — at most ~50 per
   *  second — so the minute's p50/p99 are real percentiles of the whole minute, not of one second. */
  private fold(h: Histogram): void {
    let prev = 0;
    for (const [p, v] of h.percentiles) {
      const n = Math.min(60, Math.round(((p - prev) / 100) * h.count));
      for (let i = 0; i < n; i++) this.minuteHist.record(Math.max(1, Math.round(v)));
      prev = p;
    }
    // A 100th-percentile row can round to zero samples; the max must still land in the minute's max.
    this.minuteHist.record(Math.max(1, Math.round(h.max)));
  }

  // ---- once a second ----
  onSecond(): void {
    try {
      const h = this.hist;
      let maxMs = 0;
      if (h.count > 0) maxMs = Math.max(0, h.max / 1e6 - this.res); // the histogram's floor is its own tick
      if (h.count > 0) this.fold(h);
      h.reset();
      if (maxMs >= STALL_MS) {
        const last = this.d.trace?.last();
        this.stalls++;
        this.line('main-stall', {
          ms: Math.round(maxMs), sessions: this.d.getSessionCount(), windows: this.d.getWindowCount(),
          ...(last ? { lastIpc: last.channel, lastIpcAgoMs: Math.round(last.agoMs) } : {}),
        });
      }
      if (++this.tick % 60 === 0) this.onMinute();
    } catch { /* ignore */ }
  }

  // ---- once a minute ----
  onMinute(): void {
    const windows = this.d.getWindowCount();
    const mh = this.minuteHist;
    const loop = mh.count > 0
      ? { p50: r1(Math.max(0, mh.percentile(50) / 1e6 - this.res)), p99: r1(Math.max(0, mh.percentile(99) / 1e6 - this.res)), max: r1(Math.max(0, mh.max / 1e6 - this.res)) }
      : { p50: 0, p99: 0, max: 0 };
    mh.reset();
    const tally = this.minuteTally;
    this.minuteTally = { frames: 0, framesMs: 0, over: 0, overMs: 0, dropped: 0, rejected: 0, entries: 0 };
    const stalls = this.stalls;
    this.stalls = 0;
    if (windows < 1) return; // one line per minute only while a window exists
    const procs: Record<string, unknown> = {};
    const renderers: Array<{ ws: number; cpu: number }> = [];
    const agg: Record<string, { n: number; ws: number; cpu: number }> = {};
    try {
      for (const p of this.d.getAppMetrics()) {
        const ws = mb((p.memory?.workingSetSize ?? 0) * 1024); // Electron reports KB
        const cpu = r1(p.cpu?.percentCPUUsage ?? 0);
        if (p.type === 'Tab') { renderers.push({ ws, cpu }); continue; }
        const key = p.type === 'Browser' ? 'browser' : p.type === 'GPU' ? 'gpu' : p.type === 'Utility' ? 'utility' : 'other';
        const a = (agg[key] ??= { n: 0, ws: 0, cpu: 0 });
        a.n++; a.ws = r1(a.ws + ws); a.cpu = r1(a.cpu + cpu);
      }
    } catch { /* getAppMetrics can throw during shutdown */ }
    Object.assign(procs, agg);
    procs.renderer = renderers.sort((a, b) => b.ws - a.ws).slice(0, 12);
    const mem = process.memoryUsage();
    this.line('minute', {
      loop, procs, windows, sessions: this.d.getSessionCount(),
      main: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed), heapTotal: mb(mem.heapTotal), external: mb(mem.external), arrayBuffers: mb(mem.arrayBuffers) },
      rend: tally, stalls,
      lost: (this.writer as RotatingJsonlWriter).lost ?? 0,
    });
  }

  /** Flush at quit. Bounded by the caller. */
  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.startupFallback) { clearTimeout(this.startupFallback); this.startupFallback = undefined; }
    this.hist.disable?.();
    await this.writer.flush();
  }
}

export function startHitchRecorder(deps: RecorderDeps): HitchRecorder | null {
  if (hitchLogDisabled(deps.env)) return null;
  try { return new HitchRecorder({ startTimer: true, ...deps }); } catch { return null; }
}
