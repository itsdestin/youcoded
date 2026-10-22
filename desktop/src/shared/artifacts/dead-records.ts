// Which artifact records are provably dead, so they can be ARCHIVED (never deleted) out of the sidecar.
//
// Pure: no file access, no clock (callers pass `nowMs`) — the survey that asks the disk lives in
// main/artifacts/sidecar-cleanup.ts. Design and numbers: docs/active/plans/2026-10-22-artifact-sidecar-cleanup.md.
//
// A record is archived only when ALL hold: its file is missing for a reason we can name (ENOENT/ENOTDIR with
// an existing, readable, same-device ancestor — anything else is "unknown, keep"); it has had no activity for
// 30+ days; it has been seen missing at two sweeps at least 7 days apart and is still missing now; it is not
// pinned in manualIncludes/manualExcludes. Brakes: a size floor (never rewrite the file for a handful of
// records), a per-run cap, and a refusal when the recent records are mostly missing (an outage, not cleanup).
import type { ArtifactRecord } from './types';
import { canonicalize } from './canonicalize';

const DEAD_IDLE_DAYS = 30;
const STRIKE_GAP_DAYS = 7;
const MIN_CANDIDATES = 500;
const MIN_FRACTION = 0.05;
const MAX_PER_RUN = 6000;
const MAX_FRACTION_PER_RUN = 0.7;
/** More than this share of the RECENTLY ACTIVE records missing at once means an outage (unmounted drive, wrong root). */
const OUTAGE_MISSING_FRACTION = 0.5;
/** Too few recent records to call it an outage either way. */
const OUTAGE_MIN_RECENT = 20;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Nearest existing ancestor folder of a missing target, as the survey found it. */
export interface AncestorInfo { path: string; sameDevice: boolean; readable: boolean }

export interface Probe {
  /** Absolute path that was checked, or null when the record cannot be resolved (relative external). */
  target: string | null;
  exists: boolean;
  /** Filesystem error code when !exists (ENOENT, ENOTDIR, EIO, EACCES, ENOTCONN, ETIMEDOUT …). */
  errorCode?: string;
  /** null = no ancestor exists at all (the volume itself is absent). */
  ancestor?: AncestorInfo | null;
}

export type MissingClass = 'tmp' | 'worktree-gone' | 'file-gone' | 'unknown';

/** First time each record id was seen missing (ISO). Cleared when the file reappears. */
export type Ledger = Record<string, string>;

export interface SelectOptions {
  /** Canonical absolute paths in manualIncludes + manualExcludes: pinned wins. */
  pinned: Set<string>;
  projectRoot: string;
  tmpDirs: string[];
  minCandidates?: number;
  minFraction?: number;
  maxPerRun?: number;
  maxFractionPerRun?: number;
}

type Blocked = 'outage-suspected' | 'below-floor' | 'braked';

export interface Selection {
  ids: string[];
  ledger: Ledger;
  /** Why fewer than all candidates (or none) were archived. 'braked' still archives the capped batch. */
  blocked: Blocked | null;
  candidates: number;
}

const fwd = (p: string) => p.replace(/\\/g, '/');

export function classifyMissing(probe: Probe, tmpDirs: string[]): MissingClass {
  if (probe.exists) return 'unknown';
  // Only a definite "no such file" is proof. EIO, EACCES, ENOTCONN, ETIMEDOUT … mean "could not tell".
  if (probe.errorCode !== 'ENOENT' && probe.errorCode !== 'ENOTDIR') return 'unknown';
  if (!probe.target || !probe.ancestor) return 'unknown';           // unresolvable, or no existing ancestor
  if (!probe.ancestor.sameDevice || !probe.ancestor.readable) return 'unknown'; // other/unmounted volume, unreadable folder
  const t = fwd(probe.target);
  if (tmpDirs.some((d) => { const dd = fwd(d).replace(/\/+$/, ''); return t === dd || t.startsWith(dd + '/'); })) return 'tmp';
  if (/\/worktrees\/sessions\/[^/]+\//.test(t)) return 'worktree-gone';
  return 'file-gone';
}

/** Newest activity of a record in ms, or null when any timestamp cannot be read (treated as recent). */
function newestActivityMs(rec: ArtifactRecord): number | null {
  let newest = -Infinity;
  for (const v of rec.versions) {
    const t = Date.parse(v.ts);
    if (Number.isNaN(t)) return null;
    if (t > newest) newest = t;
  }
  if (newest === -Infinity) {
    const t = Date.parse(rec.lastModified);
    return Number.isNaN(t) ? null : t;
  }
  return newest;
}

export function selectArchivable(
  records: readonly ArtifactRecord[],
  probes: ReadonlyMap<string, Probe>,
  ledgerIn: Ledger,
  nowMs: number,
  opts: SelectOptions,
): Selection {
  const idleCutoff = nowMs - DEAD_IDLE_DAYS * MS_PER_DAY;
  const strikeCutoff = nowMs - STRIKE_GAP_DAYS * MS_PER_DAY;
  const nowIso = new Date(nowMs).toISOString();
  const ledger: Ledger = {};
  const live = new Set(records.map((r) => r.id));
  for (const [id, first] of Object.entries(ledgerIn)) if (live.has(id)) ledger[id] = first; // forget gone records

  let recent = 0; let recentMissing = 0;
  const dead: Array<{ rec: ArtifactRecord; activity: number | null }> = [];
  for (const rec of records) {
    const probe = probes.get(rec.id);
    const activity = newestActivityMs(rec);
    const isRecent = activity === null || activity >= idleCutoff;
    if (probe && isRecent) { recent++; if (!probe.exists) recentMissing++; }
    if (!probe) continue;
    if (probe.exists) { delete ledger[rec.id]; continue; }       // reappeared: strike cleared
    if (classifyMissing(probe, opts.tmpDirs) === 'unknown') continue; // could not tell: neither strike nor clear
    if (!ledger[rec.id]) ledger[rec.id] = nowIso;                 // first strike
    dead.push({ rec, activity });
  }

  // An outage looks like "everything is missing". Refuse, keep the strikes (they are only dates).
  if (recent >= OUTAGE_MIN_RECENT && recentMissing / recent > OUTAGE_MISSING_FRACTION) {
    return { ids: [], ledger, blocked: 'outage-suspected', candidates: 0 };
  }

  const eligible = dead.filter(({ rec, activity }) => {
    if (activity === null || activity >= idleCutoff) return false;       // not yet older than 30 days / unreadable time
    const first = Date.parse(ledger[rec.id] ?? '');
    if (Number.isNaN(first) || first > strikeCutoff) return false;       // needs two strikes 7+ days apart
    const probe = probes.get(rec.id)!;
    const abs = probe.target ? canonicalize(probe.target, null) : null;
    if (abs && opts.pinned.has(abs)) return false;                       // pinned wins
    return true;
  });

  const floor = Math.max(opts.minCandidates ?? MIN_CANDIDATES, Math.ceil(records.length * (opts.minFraction ?? MIN_FRACTION)));
  if (eligible.length < floor) return { ids: [], ledger, blocked: 'below-floor', candidates: eligible.length };

  const cap = Math.min(opts.maxPerRun ?? MAX_PER_RUN, Math.floor(records.length * (opts.maxFractionPerRun ?? MAX_FRACTION_PER_RUN)));
  let chosen = eligible;
  let blocked: Blocked | null = null;
  if (eligible.length > cap) {
    // The oldest-idle go first; the rest wait for the next daily run.
    chosen = [...eligible].sort((a, b) => (a.activity as number) - (b.activity as number)).slice(0, cap);
    blocked = 'braked';
  }
  const ids = chosen.map((c) => c.rec.id);
  // The strikes of the chosen ids stay in the ledger: the caller drops them only once the sidecar write
  // has committed, so a failed run does not make the records start their 7 days over.
  return { ids, ledger, blocked, candidates: eligible.length };
}
