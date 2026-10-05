// Validation of what a renderer sends the hitch recorder (see hitch-recorder.ts header).
// WHY a strict re-build instead of a filter: the batch crosses a trust boundary. A compromised
// renderer must not be able to write arbitrary data, long text or a flood into the file, so
// nothing from the wire is copied through — every output field is rebuilt from a known list,
// numbers are range-checked, every string is an enum or a tight pattern (free text is dropped, not trimmed)
// and anything unexpected is dropped on the floor.

/** No frame or interaction lasts longer than this: a longer one spans a suspend/resume and is rejected, not recorded. */
const MAX_MS = 120_000;
export const MAX_ENTRIES_PER_BATCH = 100;
/** Every kind the recorder knows how to write; anything else in a batch is rejected. */
const INVOKER_TYPES = new Set(['classic-script', 'module-script', 'event-listener', 'user-callback', 'resolve-promise', 'reject-promise']);
const FN_RE = /^[A-Za-z_$][\w$.]{0,59}$/;
const SRC_RE = /^[\w.-]{1,60}\.(js|mjs)$/;
// WHY a shape, not a character set (integration re-check 2026-10-05): the window already reduces an invoker to url / TAG.onevent / a short
// API name ("Window.requestAnimationFrame"); main re-enforces exactly that, so a charset-clean free string (a token, a one-word draft) is "other".
const IV_RE = /^(?:url|other|[A-Za-z][A-Za-z0-9-]{0,19}\.on[a-z]{1,20}|[A-Za-z]{1,30}(?:[.:][A-Za-z]{1,30})?)$/;
const EVENT_TYPES = new Set(['keydown', 'pointerdown', 'pointerup', 'click', 'input']);
const TARGETS = new Set(['composer', 'terminal', 'chat', 'text-input', 'other']);
const WINDOW_KINDS = new Set(['buddy-mascot', 'buddy-chat', 'buddy-bar']);

interface CleanScript { it: string; iv: string; fn: string; src: string; pos: number; d: number; fl: number }
interface CleanCtx { vis?: string; foc?: boolean; vm?: string; dlg?: boolean; scr?: boolean; dpr?: number; els?: number }
type CleanEntry =
  | { k: 'frame'; t: number; d: number; b: number; sl: number; rd: number; inp: boolean; sc: CleanScript[]; ctx: CleanCtx }
  | { k: 'task'; t: number; d: number; ctx: CleanCtx }
  | { k: 'event'; t: number; type: string; d: number; delay: number; proc: number; pres: number; tgt: string; ctx: CleanCtx };
// SWITCH MARKS (2026-10-05): one line per session switch. Kept in its OWN array (batch.sw), not in `entries`, because a switch has
// no duration of its own to rate-limit by and has its own, more generous, per-minute cap (see hitch-recorder.ts). EVERY string is an
// enum from this file; there is no free-text slot, so no session id/name/path can reach the line — the window uses the session id
// only to find the pane in memory and never sends it.
const SWITCH_CAUSES = ['pill', 'menu', 'key', 'drawer', 'auto', 'other'] as const;
const SWITCH_VIEWS = new Set(['chat', 'terminal']);
const SWITCH_KINDS = new Set(['claude', 'native', 'shell']);
const SWITCH_ENDS = new Set(['settled', 'streaming', 'cap', 'interrupted', 'hidden', 'closed']);
const MAX_SWITCHES_PER_BATCH = 100;
interface CleanSwitch {
  t: number; cause: string; vm: string; dk: string; str: boolean; cold: boolean; open: number;
  ff: number | null; st: number | null; end: string; e1: number | null; e2: number | null; mut: number;
  ls: number; lsv: number; loaf: number; loafMs: number; ind: number | null; gap: number | null; drain: number | null;
}
export interface CleanBatch {
  mode: 'loaf' | 'longtask' | 'none';
  sw: CleanSwitch[];
  /** Switch lines the window itself dropped over its own per-minute cap. */
  swOver: number;
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
/** An IPC channel or boot-mark name: app constants only. Id-like runs are masked; anything else is "?" (never copied). */
export function appName(x: unknown): string {
  if (typeof x !== 'string') return '?';
  const v = x.slice(0, 80).replace(/[0-9a-f]{8}[0-9a-f-]{4,}/gi, '*');
  return /^[A-Za-z0-9_:.*-]{1,60}$/.test(v) ? v : '?';
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

/** Every string field is an allow-list, not a length cap: free text of any length is dropped, not trimmed. */
function cleanScript(x: unknown): CleanScript | null {
  if (!isObj(x)) return null;
  const d = int(x.d, 0, MAX_MS);
  if (d === undefined) return null;
  const it = typeof x.it === 'string' && INVOKER_TYPES.has(x.it) ? x.it : 'other';
  // Script starts carry no invoker (it would be the script URL); an invoker that fails the pattern becomes "other".
  const iv = it === 'classic-script' || it === 'module-script' ? '' : typeof x.iv === 'string' && IV_RE.test(x.iv) ? x.iv : x.iv === '' ? '' : 'other';
  const src = typeof x.src === 'string' && (x.src === 'inline' || x.src === 'other' || SRC_RE.test(x.src)) ? x.src : 'other';
  const fn = src !== 'other' && typeof x.fn === 'string' && FN_RE.test(x.fn) ? x.fn : '';
  return { it, iv, fn, src, pos: int(x.pos, 0, 1e9) ?? 0, d, fl: int(x.fl, 0, MAX_MS) ?? 0 };
}

/** One entry, or null when it is malformed. `now` clamps a lying timestamp. */
function cleanEntry(x: unknown, now: number): CleanEntry | null {
  if (!isObj(x)) return null;
  const d = int(x.d, 0, MAX_MS);
  if (d === undefined) return null;
  // A timestamp outside [-15 min, +1 min] of receipt is replaced, not trusted.
  let t = int(x.t, 0, 8.64e15) ?? now;
  if (t < now - 15 * 60_000 || t > now + 60_000) t = now;
  const ctx = cleanCtx(x.ctx);
  if (x.k === 'frame') {
    const sc: CleanScript[] = [];
    if (Array.isArray(x.sc)) for (const s of x.sc.slice(0, 3)) { const c = cleanScript(s); if (c) sc.push(c); }
    return { k: 'frame', t, d, b: int(x.b, 0, MAX_MS) ?? 0, sl: int(x.sl, 0, MAX_MS) ?? 0, rd: int(x.rd, 0, MAX_MS) ?? 0, inp: x.inp === true, sc, ctx };
  }
  if (x.k === 'task') return { k: 'task', t, d, ctx };
  if (x.k === 'event') {
    if (typeof x.type !== 'string' || !EVENT_TYPES.has(x.type)) return null;
    const tgt = typeof x.tgt === 'string' && TARGETS.has(x.tgt) ? x.tgt : 'other';
    return { k: 'event', t, type: x.type, d, delay: int(x.delay, 0, MAX_MS) ?? 0, proc: int(x.proc, 0, MAX_MS) ?? 0, pres: int(x.pres, 0, MAX_MS) ?? 0, tgt, ctx };
  }
  return null;
}

/** An integer within range, or null (a missing measurement is null, never 0 — a zero would read as "instant"). */
const intOrNull = (x: unknown, hi: number): number | null => (x === null || x === undefined ? null : int(x, 0, hi) ?? null);

/** One switch line, or null when it is malformed. Unknown enum values reject the line (they are never copied or defaulted
 *  into something that looks valid), except `cause`, where an unknown value is honestly "other". */
function cleanSwitch(x: unknown, now: number): CleanSwitch | null {
  if (!isObj(x)) return null;
  if (typeof x.vm !== 'string' || !SWITCH_VIEWS.has(x.vm)) return null;
  if (typeof x.dk !== 'string' || !SWITCH_KINDS.has(x.dk)) return null;
  if (typeof x.end !== 'string' || !SWITCH_ENDS.has(x.end)) return null;
  const cause = typeof x.cause === 'string' && (SWITCH_CAUSES as readonly string[]).includes(x.cause) ? x.cause : 'other';
  let t = int(x.t, 0, 8.64e15) ?? now;
  if (t < now - 15 * 60_000 || t > now + 60_000) t = now;
  const lsv = typeof x.lsv === 'number' && Number.isFinite(x.lsv) && x.lsv >= 0 && x.lsv <= 1000 ? Math.round(x.lsv * 1000) / 1000 : 0;
  const ff = intOrNull(x.ff, MAX_MS);
  // `settled` only means something when the switch really settled, and cannot precede the first frame.
  const st = x.end === 'settled' ? intOrNull(x.st, MAX_MS) : null;
  return {
    t, cause, vm: x.vm, dk: x.dk, str: x.str === true, cold: x.cold === true, open: int(x.open, 0, 10_000) ?? 0,
    ff, st: st !== null && ff !== null && st < ff ? ff : st, end: x.end,
    e1: intOrNull(x.e1, 5_000_000), e2: intOrNull(x.e2, 5_000_000), mut: int(x.mut, 0, 1e7) ?? 0,
    ls: int(x.ls, 0, 1e6) ?? 0, lsv, loaf: int(x.loaf, 0, 1e5) ?? 0, loafMs: int(x.loafMs, 0, 3_600_000) ?? 0,
    ind: intOrNull(x.ind, MAX_MS), gap: intOrNull(x.gap, 3_600_000), drain: intOrNull(x.drain, 1e9),
  };
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
  const sw: CleanSwitch[] = [];
  if (Array.isArray(raw.sw)) {
    if (raw.sw.length > MAX_SWITCHES_PER_BATCH) rejected += raw.sw.length - MAX_SWITCHES_PER_BATCH;
    for (const e of raw.sw.slice(0, MAX_SWITCHES_PER_BATCH)) {
      const c = cleanSwitch(e, now);
      if (c) sw.push(c); else rejected++;
    }
  }
  const t = isObj(raw.tally) ? raw.tally : {};
  const tally = { f: int(t.f, 0, 1e7) ?? 0, fms: int(t.fms, 0, 1e10) ?? 0, over: int(t.over, 0, 1e7) ?? 0, oms: int(t.oms, 0, 1e10) ?? 0 };
  const out: CleanBatch = { mode, kind, entries, sw, swOver: int(raw.swOver, 0, 1e7) ?? 0, tally, dropped: int(raw.dropped, 0, 1e7) ?? 0, rejected };
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
