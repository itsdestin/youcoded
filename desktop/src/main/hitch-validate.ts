// Validation of what a renderer sends the hitch recorder (see hitch-recorder.ts header).
// WHY a strict re-build instead of a filter: the batch crosses a trust boundary. A compromised
// renderer must not be able to write arbitrary data, long text or a flood into the file, so
// nothing from the wire is copied through — every output field is rebuilt from a known list,
// numbers are range-checked, strings are cut to 120 printable-ASCII characters and anything
// unexpected is dropped on the floor.

const MAX_STR = 120;
export const MAX_ENTRIES_PER_BATCH = 100;
/** Every kind the recorder knows how to write; anything else in a batch is rejected. */
const EVENT_TYPES = new Set(['keydown', 'pointerdown', 'pointerup', 'click', 'input']);
const TARGETS = new Set(['composer', 'terminal', 'chat', 'text-input', 'other']);
const WINDOW_KINDS = new Set(['buddy-mascot', 'buddy-chat', 'buddy-bar']);

interface CleanScript { it: string; iv: string; fn: string; src: string; pos: number; d: number; fl: number }
interface CleanCtx { vis?: string; foc?: boolean; vm?: string; dlg?: boolean; scr?: boolean; dpr?: number; els?: number }
type CleanEntry =
  | { k: 'frame'; t: number; d: number; b: number; sl: number; rd: number; inp: boolean; sc: CleanScript[]; ctx: CleanCtx }
  | { k: 'task'; t: number; d: number; ctx: CleanCtx }
  | { k: 'event'; t: number; type: string; d: number; delay: number; proc: number; pres: number; tgt: string; ctx: CleanCtx };
export interface CleanBatch {
  mode: 'loaf' | 'longtask' | 'none';
  /** 'main' for ordinary windows, else one of the three buddy window kinds. */
  kind: string;
  entries: CleanEntry[];
  tally: { f: number; fms: number; over: number; oms: number };
  dropped: number;
  rejected: number;
  startup?: { marks: Record<string, number>; fcp: number | null };
}

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
/** A whole number within [lo, hi], else undefined. Floats are rounded; NaN/Infinity rejected. */
function int(x: unknown, lo: number, hi: number): number | undefined {
  if (typeof x !== 'number' || !Number.isFinite(x)) return undefined;
  const n = Math.round(x);
  return n >= lo && n <= hi ? n : undefined;
}
/** Printable ASCII only, at most MAX_STR characters: no control characters, no newlines, no
 *  non-ASCII text. App function names and bundle file names are ASCII; anything else is noise. */
export function cleanString(x: unknown, max = MAX_STR): string {
  if (typeof x !== 'string') return '';
  return x.slice(0, max).replace(/[^\x20-\x7e]/g, '?');
}

function cleanCtx(x: unknown): CleanCtx {
  if (!isObj(x)) return {};
  const out: CleanCtx = {};
  if (x.vis === 'visible' || x.vis === 'hidden' || x.vis === 'prerender') out.vis = x.vis;
  if (typeof x.foc === 'boolean') out.foc = x.foc;
  if (typeof x.vm === 'string' && /^[a-z][a-z0-9-]{0,19}$/.test(x.vm)) out.vm = x.vm;
  if (typeof x.dlg === 'boolean') out.dlg = x.dlg;
  if (typeof x.scr === 'boolean') out.scr = x.scr;
  if (typeof x.dpr === 'number' && Number.isFinite(x.dpr) && x.dpr > 0.1 && x.dpr <= 16) out.dpr = Math.round(x.dpr * 100) / 100;
  const els = int(x.els, 0, 5_000_000);
  if (els !== undefined) out.els = els;
  return out;
}

function cleanScript(x: unknown): CleanScript | null {
  if (!isObj(x)) return null;
  const d = int(x.d, 0, 600_000);
  if (d === undefined) return null;
  return {
    it: cleanString(x.it, 40), iv: cleanString(x.iv), fn: cleanString(x.fn), src: cleanString(x.src, 80),
    pos: int(x.pos, 0, 1e9) ?? 0, d, fl: int(x.fl, 0, 600_000) ?? 0,
  };
}

/** One entry, or null when it is malformed. `now` clamps a lying timestamp. */
function cleanEntry(x: unknown, now: number): CleanEntry | null {
  if (!isObj(x)) return null;
  const d = int(x.d, 0, 600_000);
  if (d === undefined) return null;
  // A timestamp outside [-15 min, +1 min] of receipt is replaced, not trusted.
  let t = int(x.t, 0, 8.64e15) ?? now;
  if (t < now - 15 * 60_000 || t > now + 60_000) t = now;
  const ctx = cleanCtx(x.ctx);
  if (x.k === 'frame') {
    const sc: CleanScript[] = [];
    if (Array.isArray(x.sc)) for (const s of x.sc.slice(0, 3)) { const c = cleanScript(s); if (c) sc.push(c); }
    return { k: 'frame', t, d, b: int(x.b, 0, 600_000) ?? 0, sl: int(x.sl, 0, 600_000) ?? 0, rd: int(x.rd, 0, 600_000) ?? 0, inp: x.inp === true, sc, ctx };
  }
  if (x.k === 'task') return { k: 'task', t, d, ctx };
  if (x.k === 'event') {
    if (typeof x.type !== 'string' || !EVENT_TYPES.has(x.type)) return null;
    const tgt = typeof x.tgt === 'string' && TARGETS.has(x.tgt) ? x.tgt : 'other';
    return { k: 'event', t, type: x.type, d, delay: int(x.delay, 0, 600_000) ?? 0, proc: int(x.proc, 0, 600_000) ?? 0, pres: int(x.pres, 0, 600_000) ?? 0, tgt, ctx };
  }
  return null;
}

/** The whole batch, or null when it is not a batch at all. */
export function validateBatch(raw: unknown, now: number): CleanBatch | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  const mode = raw.mode === 'loaf' || raw.mode === 'longtask' ? raw.mode : 'none';
  const kind = typeof raw.kind === 'string' && WINDOW_KINDS.has(raw.kind) ? raw.kind : 'main';
  const entries: CleanEntry[] = [];
  let rejected = 0;
  if (Array.isArray(raw.entries)) {
    // Anything past the cap is not even looked at, so an oversized array costs O(cap).
    if (raw.entries.length > MAX_ENTRIES_PER_BATCH) rejected += raw.entries.length - MAX_ENTRIES_PER_BATCH;
    for (const e of raw.entries.slice(0, MAX_ENTRIES_PER_BATCH)) {
      const c = cleanEntry(e, now);
      if (c) entries.push(c); else rejected++;
    }
  }
  const t = isObj(raw.tally) ? raw.tally : {};
  const tally = { f: int(t.f, 0, 1e7) ?? 0, fms: int(t.fms, 0, 1e10) ?? 0, over: int(t.over, 0, 1e7) ?? 0, oms: int(t.oms, 0, 1e10) ?? 0 };
  const out: CleanBatch = { mode, kind, entries, tally, dropped: int(raw.dropped, 0, 1e7) ?? 0, rejected };
  if (isObj(raw.startup) && isObj(raw.startup.marks)) {
    const marks: Record<string, number> = {};
    let n = 0;
    for (const [k, v] of Object.entries(raw.startup.marks)) {
      if (n >= 40) break;
      const ms = int(v, 0, 3_600_000);
      if (ms !== undefined && /^yc:[a-z0-9:-]{1,40}$/.test(k)) { marks[k] = ms; n++; }
    }
    out.startup = { marks, fcp: int(raw.startup.fcp, 0, 3_600_000) ?? null };
  }
  return out;
}
