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
/** More than this share of the RECENTLY ACTIVE records (leaving out temp-folder and deleted-worktree paths, which are
 *  gone by design) missing at once means an outage (unmounted drive, wrong root). */
const OUTAGE_MISSING_FRACTION = 0.5;
/** Too few recent records to call it an outage either way. */
const OUTAGE_MIN_RECENT = 20;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Nearest existing ancestor folder of a missing target, as the survey found it. */
export interface AncestorInfo {
  path: string;
  sameDevice: boolean;
  readable: boolean;
  /** The path to it passes through a symlink (a link to a gone volume looks like a real folder). */
  viaSymlink?: boolean;
  /** Its device differs from its parent's: it IS a mount point (a mounted volume's root). */
  mountPoint?: boolean;
  /** An empty folder that is not the project root: what an unmounted drive's stub looks like. */
  empty?: boolean;
  isProjectRoot?: boolean;
}

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
  /** Restored records: id -> ISO date before which they must not be archived again. */
  keepUntil?: Record<string, string>;
}

type Blocked = 'outage-suspected' | 'below-floor' | 'braked';

function groupKey(target: string | null, projectRoot: string): string {
  if (!target) return '(unresolved)';
  const t = fwd(target); const root = fwd(projectRoot).replace(/\/+$/, '');
  if (t.startsWith(root + '/')) return 'in:' + t.slice(root.length + 1).split('/')[0];
  return 'out:' + t.split('/').filter(Boolean).slice(0, 3).join('/');
}

export interface Selection {
  ids: string[];
  ledger: Ledger;
  /** Why fewer than all candidates (or none) were archived. 'braked' still archives the capped batch. */
  blocked: Blocked | null;
  candidates: number;
  /** Top-level folders whose records are ALL missing: held back as a possible offline volume. */
  vanishedGroups: string[];
}

const fwd = (p: string) => p.replace(/\\/g, '/');
const MOUNT_ROOTS = ['/mnt', '/media', '/run/media', '/Volumes', '/net', '/misc', '/srv'];
/** A group of records (one top-level folder) with at least this many members and NONE present has vanished as a unit. */
const GROUP_MIN = 20;
const GROUP_MISSING_FRACTION = 0.5;

export function classifyMissing(probe: Probe, tmpDirs: string[]): MissingClass {
  if (probe.exists) return 'unknown';
  // Only a definite "no such file" is proof. EIO, EACCES, ENOTCONN, ETIMEDOUT … mean "could not tell".
  if (probe.errorCode !== 'ENOENT' && probe.errorCode !== 'ENOTDIR') return 'unknown';
  if (!probe.target || !probe.ancestor) return 'unknown';           // unresolvable, or no existing ancestor
  const a = probe.ancestor;
  if (!a.sameDevice || !a.readable) return 'unknown';               // other/unmounted volume, unreadable folder
  // A stub left behind by an unmounted or unplugged drive passes the checks above (same device as the root, readable),
  // so it is recognised by what it is: a symlink, a mount point, or an empty folder that is not the project itself.
  if (a.viaSymlink || a.mountPoint || (a.empty && !a.isProjectRoot)) return 'unknown';
  // Places drives get mounted: whatever is missing under them might simply be offline.
  if (MOUNT_ROOTS.some((m) => (fwd(probe.target as string) + '/').startsWith(m + '/'))) return 'unknown';
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
    if (probe && isRecent) {
      // Files that are gone BY DESIGN (temp folders, deleted worktrees) say nothing about an outage, so they stay out
      // of this measure. A drive that vanished leaves recent files missing under "unknown" or plain "file-gone".
      const by = probe.exists ? null : classifyMissing(probe, opts.tmpDirs);
      if (by !== 'tmp' && by !== 'worktree-gone') { recent++; if (!probe.exists) recentMissing++; }
    }
    if (!probe) continue;
    if (probe.exists) { delete ledger[rec.id]; continue; }       // reappeared: strike cleared
    if (classifyMissing(probe, opts.tmpDirs) === 'unknown') continue; // could not tell: neither strike nor clear
    if (!ledger[rec.id]) ledger[rec.id] = nowIso;                 // first strike
    dead.push({ rec, activity });
  }

  // An outage looks like "everything is missing". Refuse, keep the strikes (they are only dates).
  if (recent >= OUTAGE_MIN_RECENT && recentMissing / recent > OUTAGE_MISSING_FRACTION) {
    return { ids: [], ledger, blocked: 'outage-suspected', candidates: 0, vanishedGroups: [] };
  }

  // Per top-level folder: if most of its records are missing and not ONE is present, the folder (or the volume it
  // lives on) has probably gone away as a unit. Those records are held back; the rest of the run is unaffected.
  // Paths under the temp folders are exempt (gone by design). A folder with any living record is a normal clean-up.
  const groups = new Map<string, { total: number; missing: number; present: number }>();
  for (const rec of records) {
    const p = probes.get(rec.id);
    if (!p) continue;
    if (!p.exists && classifyMissing(p, opts.tmpDirs) === 'tmp') continue;
    const g = groups.get(groupKey(p.target, opts.projectRoot)) ?? { total: 0, missing: 0, present: 0 };
    g.total++; if (p.exists) g.present++; else g.missing++;
    groups.set(groupKey(p.target, opts.projectRoot), g);
  }
  const vanishedGroups = [...groups.entries()]
    .filter(([, g]) => g.total >= GROUP_MIN && g.present === 0 && g.missing / g.total > GROUP_MISSING_FRACTION).map(([k]) => k);
  const vanished = new Set(vanishedGroups);

  const eligible = dead.filter(({ rec, activity }) => {
    if (activity === null || activity >= idleCutoff) return false;       // not yet older than 30 days / unreadable time
    const first = Date.parse(ledger[rec.id] ?? '');
    if (Number.isNaN(first) || first > strikeCutoff) return false;       // needs two strikes 7+ days apart
    const probe = probes.get(rec.id)!;
    const abs = probe.target ? canonicalize(probe.target, null) : null;
    if (abs && opts.pinned.has(abs)) return false;                       // pinned wins
    const keep = opts.keepUntil?.[rec.id];
    if (keep && Date.parse(keep) > nowMs) return false;                  // restored by the owner: left alone for a long while
    if (vanished.has(groupKey(probe.target, opts.projectRoot)) && classifyMissing(probe, opts.tmpDirs) !== 'tmp') return false;
    return true;
  });

  const floor = Math.max(opts.minCandidates ?? MIN_CANDIDATES, Math.ceil(records.length * (opts.minFraction ?? MIN_FRACTION)));
  if (eligible.length < floor) return { ids: [], ledger, blocked: 'below-floor', candidates: eligible.length, vanishedGroups };

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
  return { ids, ledger, blocked, candidates: eligible.length, vanishedGroups };
}
