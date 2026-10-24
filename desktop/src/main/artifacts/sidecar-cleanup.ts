// sidecar-cleanup.ts — keeps <project>/.youcoded/artifacts.json from growing forever by ARCHIVING records of
// files that are provably gone. Nothing is deleted: removed records go to .youcoded/artifacts-archive/<YYYY-MM>.jsonl.gz
// first, and restoreArchive() brings them back. Design, brakes and numbers:
// docs/active/plans/2026-10-22-artifact-sidecar-cleanup.md (approved by the owner 2026-10-22).
//
// Order of operations (so a crash can never leave a record in NEITHER place):
//   survey (async stats) -> strike ledger -> pick candidates (shared/artifacts/dead-records.ts) -> first-ever
//   backup -> [on the project's append queue] re-read, drop any candidate that changed, write the archive
//   chunk (fsync, rename), then rewrite the sidecar through writeSidecar's CAS. A crash between the last two
//   steps leaves records in both places; restore dedupes by id.
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { randomBytes } from 'crypto';
import { promisify } from 'util';
import type { ArtifactRecord, ProjectSidecar } from '../../shared/artifacts/types';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import {
  selectArchivable, type AncestorInfo, type Ledger, type Probe, type SelectOptions,
} from '../../shared/artifacts/dead-records';
import { enqueueMaintenance, isAppendQueueIdle, readSidecarShared, writeSidecar } from './artifact-store';
import { mutateFileUnderLock } from './cas-write';
import { isAbsoluteRecorded } from './write-authorization';
import { mapLimit } from '../map-limit';
import { log } from '../logger';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const DAY_MS = 24 * 60 * 60 * 1000;
/** A record the owner restores is left alone this long (it is also left alone once it is touched again). */
const RESTORE_GRACE_DAYS = 90;
/** At most one run per project per this long. */
const CLEANUP_INTERVAL_MS = DAY_MS;
/** Wait this long after the project is first used before surveying (idle time). */
const CLEANUP_START_DELAY_MS = 10 * 60 * 1000;
/** Only projects whose sidecar is at least this big are worth a pass. */
const CLEANUP_MIN_SIDECAR_BYTES = 5 * 1024 * 1024;
const SURVEY_CHUNK = 200;
const SURVEY_CONCURRENCY = 16;

const youcodedDir = (root: string) => path.join(root, '.youcoded');
export const sidecarFile = (root: string) => path.join(youcodedDir(root), 'artifacts.json');
export const ledgerFile = (root: string) => path.join(youcodedDir(root), 'artifacts-sweep.json');
export const archiveDir = (root: string) => path.join(youcodedDir(root), 'artifacts-archive');
export const preCleanupBackup = (root: string) => path.join(youcodedDir(root), 'artifacts.json.pre-cleanup.bak');

// ---------------------------------------------------------------------------
// Ledger: first-seen-missing dates + when the last run happened
// ---------------------------------------------------------------------------
interface LedgerFile { strikes: Ledger; lastRunAt?: string; /** restored ids -> ISO date they are protected until */ keepUntil?: Record<string, string> }

async function readLedgerFile(root: string): Promise<LedgerFile> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(ledgerFile(root), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.strikes && typeof parsed.strikes === 'object') return parsed;
  } catch { /* none yet, or unreadable: start fresh (strikes only delay archiving) */ }
  return { strikes: {} };
}

/** Read-modify-write the ledger under its lock, from the file as it is NOW. WHY (review 2026-10-22): runCleanup and
 *  restoreArchive both write this file, minutes apart; writing back a copy read earlier would erase a restore pin made
 *  in between. Expired keepUntil entries are dropped on every write. */
async function updateLedger(root: string, nowMs: number, mutate: (l: LedgerFile) => LedgerFile): Promise<LedgerFile> {
  let result: LedgerFile = { strikes: {} };
  await mutateFileUnderLock(ledgerFile(root), (onDisk) => {
    let cur: LedgerFile = { strikes: {} };
    try { const p = JSON.parse(onDisk ?? ''); if (p && typeof p === 'object' && p.strikes && typeof p.strikes === 'object') cur = p; } catch { /* fresh */ }
    const next = mutate(cur);
    if (next.keepUntil) {
      next.keepUntil = Object.fromEntries(Object.entries(next.keepUntil).filter(([, until]) => Date.parse(until) > nowMs));
      if (Object.keys(next.keepUntil).length === 0) delete next.keepUntil;
    }
    result = next;
    return JSON.stringify(next);
  });
  return result;
}

// ---------------------------------------------------------------------------
// Survey: ask the disk about each record's file, off the main thread, a chunk at a time
// ---------------------------------------------------------------------------
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));
const errCode = (e: unknown): string => String((e as NodeJS.ErrnoException)?.code ?? 'UNKNOWN');

function targetOf(root: string, rec: ArtifactRecord): string | null {
  if (rec.kind === 'internal') return typeof rec.path === 'string' && rec.path ? path.join(root, rec.path) : null;
  // A relative or empty external path resolves against nothing trustworthy: unknown, keep.
  return typeof rec.absolutePath === 'string' && rec.absolutePath && isAbsoluteRecorded(rec.absolutePath) ? rec.absolutePath : null;
}

/** Stat every record's target. For a missing one also find the nearest existing ancestor folder. Aborts
 *  (returns what it has) when `signal` fires. Always terminates: the ancestor walk ends at the filesystem root. */
export async function surveyProject(
  root: string, records: readonly ArtifactRecord[], signal?: AbortSignal,
): Promise<Map<string, Probe>> {
  const rootStat = await fs.promises.stat(root);
  const rootDev = rootStat.dev;
  const rootReal = await fs.promises.realpath(root).catch(() => root);
  // Temp folders are usually their own filesystem (tmpfs): a file missing under /tmp is judged against /tmp's device,
  // not the project's. The temp folder itself is an expected mount point, not an offline-drive stub.
  const tmpRoots = await Promise.all([os.tmpdir(), '/tmp', '/var/tmp'].map(async (d) => {
    const st = await fs.promises.stat(d).catch(() => null);
    return st ? { dir: path.resolve(d), dev: st.dev } : null;
  }));
  const tmpOf = (dir: string) => tmpRoots.find((t) => t && (path.resolve(dir) === t.dir || path.resolve(dir).startsWith(t.dir + path.sep))) ?? null;
  const ancestors = new Map<string, Promise<AncestorInfo | null>>();
  const ancestorOf = (dir: string): Promise<AncestorInfo | null> => {
    const hit = ancestors.get(dir);
    if (hit) return hit;
    const p = (async (): Promise<AncestorInfo | null> => {
      try {
        const st = await fs.promises.stat(dir);
        if (!st.isDirectory()) return await nextUp(dir);   // a FILE where a folder should be: keep looking upward
        const readable = await fs.promises.access(dir, fs.constants.R_OK).then(() => true, () => false);
        // WHY these extra facts (review 2026-10-22): an unmounted drive leaves an empty stub folder (or a symlink to
        // nothing) that is readable and on the root's device, so "ancestor exists" alone would call everything on the
        // drive gone for good. Each fact below is one way to tell a real folder from such a stub.
        const real = await fs.promises.realpath(dir).catch(() => dir);
        const rel = path.relative(root, dir);
        const expected = rel.startsWith('..') ? path.resolve(dir) : path.join(rootReal, rel); // inside the project: judged against its real path
        const viaSymlink = path.resolve(real) !== path.resolve(expected);
        const parentStat = await fs.promises.stat(path.dirname(dir)).catch(() => null);
        const tmp = tmpOf(dir);
        const mountPoint = !!parentStat && parentStat.dev !== st.dev && !(tmp && tmp.dir === path.resolve(dir));
        const isProjectRoot = path.resolve(dir) === path.resolve(root);
        const empty = readable && !isProjectRoot ? (await fs.promises.readdir(dir).catch(() => ['?'])).length === 0 : false;
        return { path: dir, sameDevice: st.dev === rootDev || (!!tmp && st.dev === tmp.dev), readable, viaSymlink, mountPoint, empty, isProjectRoot };
      } catch { return await nextUp(dir); }
    })();
    ancestors.set(dir, p);
    return p;
  };
  const nextUp = (dir: string): Promise<AncestorInfo | null> => {
    const parent = path.dirname(dir);
    return parent === dir ? Promise.resolve(null) : ancestorOf(parent);
  };

  const probes = new Map<string, Probe>();
  for (let i = 0; i < records.length; i += SURVEY_CHUNK) {
    if (signal?.aborted) break;
    await mapLimit(records.slice(i, i + SURVEY_CHUNK), SURVEY_CONCURRENCY, async (rec) => {
      const target = targetOf(root, rec);
      if (!target) { probes.set(rec.id, { target: null, exists: false, errorCode: 'UNRESOLVABLE', ancestor: null }); return; }
      try {
        await fs.promises.stat(target);
        probes.set(rec.id, { target, exists: true });
      } catch (e) {
        const code = errCode(e);
        const missing = code === 'ENOENT' || code === 'ENOTDIR';
        probes.set(rec.id, { target, exists: false, errorCode: code, ancestor: missing ? await nextUp(target) : null });
      }
    });
    await yieldToLoop(); // let clicks and IPC through between chunks
  }
  return probes;
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------
export interface CleanupHooks {
  /** Test seams: simulate a crash at an exact step, or fail the sidecar write. */
  beforeArchiveRename?: () => void | Promise<void>;
  afterArchive?: () => void | Promise<void>;
  /** Runs after the survey and before the commit is queued (tests change the project in that gap). */
  beforeCommit?: () => void | Promise<void>;
  writeSidecar?: typeof writeSidecar;
}

/** fsync a folder so a rename inside it survives a power cut. Not every platform allows it; that is fine. */
async function fsyncDir(dir: string): Promise<void> {
  try { const fh = await fs.promises.open(dir, 'r'); try { await fh.sync(); } finally { await fh.close(); } } catch { /* best effort */ }
}

/** Orphaned temp files from an archive write that was interrupted (older than an hour, so never one in flight). */
async function sweepArchiveTmp(dir: string, nowMs: number): Promise<void> {
  let names: string[] = [];
  try { names = await fs.promises.readdir(dir); } catch { return; }
  for (const n of names) {
    if (!/\.tmp\./.test(n)) continue;
    const st = await fs.promises.stat(path.join(dir, n)).catch(() => null);
    if (st && nowMs - st.mtimeMs > 60 * 60 * 1000) await fs.promises.rm(path.join(dir, n), { force: true }).catch(() => {});
  }
}

/** Write `records` as a NEW archive file (<month>-<time>-<random>.jsonl.gz): temp file, fsync, rename, fsync folder.
 *  An existing archive file is never rewritten, so two app instances (dev + built) can never overwrite each other's. */
async function archiveRecords(root: string, records: readonly ArtifactRecord[], nowMs: number, hooks?: CleanupHooks): Promise<string> {
  const dir = archiveDir(root);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await sweepArchiveTmp(dir, nowMs);
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp.slice(0, 7)}-${stamp}-${randomBytes(4).toString('hex')}.jsonl.gz`);
  const member = await gzip(Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8'));
  const tmp = `${file}.tmp.${process.pid}`;
  const fh = await fs.promises.open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(member);
    await fh.sync();
  } finally { await fh.close(); }
  await hooks?.beforeArchiveRename?.();
  await fs.promises.rename(tmp, file);
  await fsyncDir(dir);
  return file;
}

async function readArchivedRecords(root: string): Promise<ArtifactRecord[]> {
  let names: string[] = [];
  try { names = (await fs.promises.readdir(archiveDir(root))).filter((n) => n.endsWith('.jsonl.gz')).sort(); }
  catch { return []; }
  const byId = new Map<string, ArtifactRecord>();
  for (const n of names) {
    // WHY (2026-10-22 review): one truncated or corrupt archive used to make the whole restore throw, so every
    // good archive beside it was unreachable too. Skip the unreadable file, name it, restore from the rest.
    let text: string;
    try { text = (await gunzip(await fs.promises.readFile(path.join(archiveDir(root), n)))).toString('utf8'); }
    catch (e) {
      log('WARN', 'ArtifactCleanup', 'skipping an unreadable archive file during restore', { root, file: n, error: String((e as Error)?.message ?? e) });
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const rec = JSON.parse(line) as ArtifactRecord; if (rec && typeof rec.id === 'string') byId.set(rec.id, rec); } catch { /* skip a damaged line */ }
    }
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
type CleanupStatus =
  | 'archived' | 'skipped-recent' | 'skipped-busy' | 'no-sidecar' | 'root-unhealthy'
  | 'outage-suspected' | 'below-floor' | 'nothing-changed' | 'conflict' | 'aborted';

export interface CleanupResult {
  status: CleanupStatus;
  archivedRecords?: number;
  archivedVersions?: number;
  archivePath?: string;
  braked?: boolean;
  archivedIds?: string[];
}

export interface CleanupOptions {
  nowMs?: number;
  signal?: AbortSignal;
  /** Skip the once-a-day and queue-idle gates (tests, the restore script). */
  force?: boolean;
  limits?: Partial<Pick<SelectOptions, 'minCandidates' | 'minFraction' | 'maxPerRun' | 'maxFractionPerRun'>>;
  hooks?: CleanupHooks;
}

export async function runCleanup(root: string, opts: CleanupOptions = {}): Promise<CleanupResult> {
  const nowMs = opts.nowMs ?? Date.now();
  if (!opts.force && !isAppendQueueIdle(root)) return { status: 'skipped-busy' };

  const ledgerData = await readLedgerFile(root);
  if (!opts.force && ledgerData.lastRunAt && nowMs - Date.parse(ledgerData.lastRunAt) < CLEANUP_INTERVAL_MS) return { status: 'skipped-recent' };

  const sidecar = await readSidecarShared(root);
  if (!sidecar) return { status: 'no-sidecar' };
  if ('corrupted' in sidecar) return { status: 'no-sidecar' };

  // The root itself must be present, readable and not empty of files; otherwise "everything is missing" means nothing.
  try {
    const entries = await fs.promises.readdir(root);
    if (entries.filter((n) => n !== '.youcoded').length === 0) return { status: 'root-unhealthy' };
  } catch { return { status: 'root-unhealthy' }; }

  const records = sidecar.artifacts;
  const probes = await surveyProject(root, records, opts.signal);
  if (opts.signal?.aborted) return { status: 'aborted' };

  const pinned = new Set([...(sidecar.manualIncludes ?? []).map((m) => m.path), ...(sidecar.manualExcludes ?? [])].map((p) => canonicalize(p, null)));
  const sel = selectArchivable(records, probes, ledgerData.strikes, nowMs, {
    pinned, projectRoot: root, tmpDirs: [os.tmpdir(), '/tmp', '/var/tmp'], keepUntil: ledgerData.keepUntil, ...opts.limits,
  });
  // Strikes and the run date are recorded even when nothing is archived: that is how the 7-day gap elapses.
  const fresh = await updateLedger(root, nowMs, (l) => ({ ...l, strikes: sel.ledger, lastRunAt: new Date(nowMs).toISOString() }));
  if (sel.blocked === 'outage-suspected') return { status: 'outage-suspected' };
  if (sel.ids.length === 0) return { status: sel.blocked === 'below-floor' ? 'below-floor' : 'nothing-changed' };

  // One backup, ever, of the file as it was before the first cleanup (never overwritten).
  try { await fs.promises.copyFile(sidecarFile(root), preCleanupBackup(root), fs.constants.COPYFILE_EXCL); }
  catch (e) { if (errCode(e) !== 'EEXIST') throw e; }

  // Remember what each candidate looked like at survey time; the commit drops any that changed since.
  // A restore pin made while the survey ran protects its ids from this run too.
  const chosen = new Set(sel.ids.filter((id) => !(fresh.keepUntil?.[id] && Date.parse(fresh.keepUntil[id]) > nowMs)));
  const surveyed = new Map(records.filter((r) => chosen.has(r.id)).map((r) => [r.id, { n: r.versions.length, lm: r.lastModified }]));
  await opts.hooks?.beforeCommit?.();
  const result = await enqueueMaintenance(root, () => commit(root, surveyed, nowMs, opts.hooks));
  if (result.status === 'archived' && result.archivedIds) {
    // Only now, with the sidecar write committed, do the archived records leave the strike ledger.
    const done = new Set(result.archivedIds);
    await updateLedger(root, nowMs, (l) => ({ ...l, strikes: Object.fromEntries(Object.entries(l.strikes).filter(([id]) => !done.has(id))) }));
  }
  return { ...result, braked: sel.blocked === 'braked' };
}

async function commit(
  root: string, surveyed: Map<string, { n: number; lm: string }>, nowMs: number, hooks?: CleanupHooks,
): Promise<CleanupResult> {
  const current = await readSidecarShared(root);
  if (!current || 'corrupted' in current) return { status: 'no-sidecar' };
  let doomed = current.artifacts.filter((r) => {
    const s = surveyed.get(r.id);
    return !!s && s.n === r.versions.length && s.lm === r.lastModified; // changed since the survey: keep
  });
  // WHY a second look at the disk (review 2026-10-22): the survey is minutes old and the 7-day strike is days old.
  // A file that came back since (or whose state is now unclear) is kept.
  const stillGone = await mapLimit(doomed, SURVEY_CONCURRENCY, async (r) => {
    const target = targetOf(root, r);
    if (!target) return false;
    try { await fs.promises.stat(target); return false; }
    catch (e) { const c = errCode(e); return c === 'ENOENT' || c === 'ENOTDIR'; }
  });
  const doomedNow = doomed.filter((_, i) => stillGone[i]);
  if (doomedNow.length === 0) return { status: 'nothing-changed' };
  doomed = doomedNow;
  const archivePath = await archiveRecords(root, doomed, nowMs, hooks); // archive FIRST
  await hooks?.afterArchive?.();
  const gone = new Set(doomed.map((r) => r.id));
  const next: ProjectSidecar = { ...current, artifacts: current.artifacts.filter((r) => !gone.has(r.id)) };
  const write = hooks?.writeSidecar ?? writeSidecar;
  const w = await write(root, current.updatedAt, next);
  await fsyncDir(youcodedDir(root));
  if (!w.committed) { // lost the CAS race to another writer: no retry loop; tomorrow's run starts over
    // The archive file this run wrote would only be a duplicate of what tomorrow's run writes, so remove it.
    await fs.promises.rm(archivePath, { force: true }).catch(() => {});
    log('INFO', 'ArtifactCleanup', 'sidecar changed during cleanup; will retry on a later run', { root });
    return { status: 'conflict' };
  }
  const versions = doomed.reduce((n, r) => n + r.versions.length, 0);
  log('INFO', 'ArtifactCleanup', `archived ${doomed.length} records (${versions} versions) in ${root}; archive at ${archivePath}; restore with scripts/restore-artifact-archive.mjs`);
  return { status: 'archived', archivedRecords: doomed.length, archivedVersions: versions, archivePath, archivedIds: [...gone] };
}

// ---------------------------------------------------------------------------
// Restore (the undo path)
// ---------------------------------------------------------------------------
export interface RestoreFilter { ids?: string[]; sinceISO?: string }
export interface RestoreResult { status: 'restored' | 'no-sidecar' | 'conflict'; restored: number; skipped: number }

/** Put archived records back into the sidecar. Records whose id (or kind+path) is already present are skipped,
 *  so running it twice never duplicates. `sinceISO` keeps records with activity at or after that date. */
export async function restoreArchive(root: string, filter: RestoreFilter = {}, hooks?: CleanupHooks): Promise<RestoreResult> {
  const archived = await readArchivedRecords(root);
  const since = filter.sinceISO ? Date.parse(filter.sinceISO) : null;
  const wanted = archived.filter((r) => {
    if (filter.ids && !filter.ids.includes(r.id)) return false;
    if (since !== null) {
      const t = Math.max(...r.versions.map((v) => Date.parse(v.ts)).filter((n) => !Number.isNaN(n)), -Infinity);
      if (!(t >= since)) return false;
    }
    return true;
  });
  return enqueueMaintenance(root, async (): Promise<RestoreResult> => {
    const current = await readSidecarShared(root);
    if (!current || 'corrupted' in current) return { status: 'no-sidecar', restored: 0, skipped: wanted.length };
    const haveId = new Set(current.artifacts.map((r) => r.id));
    const havePath = new Set(current.artifacts.map((r) => `${r.kind}\0${r.path}`));
    const add = wanted.filter((r) => !haveId.has(r.id) && !havePath.has(`${r.kind}\0${r.path}`));
    if (add.length === 0) return { status: 'restored', restored: 0, skipped: wanted.length };
    const next: ProjectSidecar = { ...current, artifacts: [...current.artifacts, ...add] };
    const w = await (hooks?.writeSidecar ?? writeSidecar)(root, current.updatedAt, next);
    if (!w.committed) return { status: 'conflict', restored: 0, skipped: wanted.length };
    // A durable undo: the restored records are protected for RESTORE_GRACE_DAYS (and once touched again they are no
    // longer idle), so a restored record whose file is still missing is not archived again a week later.
    const until = new Date(Date.now() + RESTORE_GRACE_DAYS * DAY_MS).toISOString();
    const restoredIds = new Set(add.map((r) => r.id));
    await updateLedger(root, Date.now(), (l) => ({
      ...l,
      strikes: Object.fromEntries(Object.entries(l.strikes).filter(([id]) => !restoredIds.has(id))),
      keepUntil: { ...(l.keepUntil ?? {}), ...Object.fromEntries(add.map((r) => [r.id, until])) },
    }));
    return { status: 'restored', restored: add.length, skipped: wanted.length - add.length };
  });
}

// ---------------------------------------------------------------------------
// Scheduling: a project that is being used gets one idle-time pass per day
// ---------------------------------------------------------------------------
const scheduled = new Map<string, ReturnType<typeof setTimeout>>();
const afterRunListeners = new Map<string, (r: CleanupResult) => void>();

/** Call whenever a project's sidecar is written to. Arms ONE timer per project per process; the pass runs
 *  CLEANUP_START_DELAY_MS later, only if the sidecar is big enough and the append queue is idle, and then again
 *  daily while the app stays open. Never throws. */
export function noteProjectActive(root: string, onRun?: (r: CleanupResult) => void, delayMs = CLEANUP_START_DELAY_MS): void {
  if (onRun) afterRunListeners.set(root, onRun);
  if (scheduled.has(root)) return;
  const tick = () => {
    void (async () => {
      try {
        const size = (await fs.promises.stat(sidecarFile(root)).catch(() => null))?.size ?? 0;
        if (size >= CLEANUP_MIN_SIDECAR_BYTES) {
          const r = await runCleanup(root);
          if (r.status === 'archived') afterRunListeners.get(root)?.(r);
        }
      } catch (e) {
        log('WARN', 'ArtifactCleanup', 'cleanup pass failed', { root, error: String((e as Error)?.message ?? e) });
      }
    })();
  };
  const t = setTimeout(function again() {
    tick();
    const next = setTimeout(again, CLEANUP_INTERVAL_MS);
    next.unref?.();
    scheduled.set(root, next);
  }, delayMs);
  t.unref?.();
  scheduled.set(root, t);
}

/** Tests only. */
export function _resetCleanupSchedulingForTests(): void {
  for (const t of scheduled.values()) clearTimeout(t);
  scheduled.clear();
  afterRunListeners.clear();
}
