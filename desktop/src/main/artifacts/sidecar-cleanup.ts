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
interface LedgerFile { strikes: Ledger; lastRunAt?: string }

async function readLedgerFile(root: string): Promise<LedgerFile> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(ledgerFile(root), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.strikes && typeof parsed.strikes === 'object') return parsed;
  } catch { /* none yet, or unreadable: start fresh (strikes only delay archiving) */ }
  return { strikes: {} };
}

async function writeLedgerFile(root: string, data: LedgerFile): Promise<void> {
  await mutateFileUnderLock(ledgerFile(root), () => JSON.stringify(data));
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
  const rootDev = (await fs.promises.stat(root)).dev;
  const ancestors = new Map<string, Promise<AncestorInfo | null>>();
  const ancestorOf = (dir: string): Promise<AncestorInfo | null> => {
    const hit = ancestors.get(dir);
    if (hit) return hit;
    const p = (async (): Promise<AncestorInfo | null> => {
      try {
        const st = await fs.promises.stat(dir);
        if (!st.isDirectory()) return await nextUp(dir);   // a FILE where a folder should be: keep looking upward
        const readable = await fs.promises.access(dir, fs.constants.R_OK).then(() => true, () => false);
        return { path: dir, sameDevice: st.dev === rootDev, readable };
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

/** Append `records` to this month's archive chunk: new gzip member, fsync'd temp file, rename. */
async function archiveRecords(root: string, records: readonly ArtifactRecord[], nowMs: number, hooks?: CleanupHooks): Promise<string> {
  const dir = archiveDir(root);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const month = new Date(nowMs).toISOString().slice(0, 7);
  const file = path.join(dir, `${month}.jsonl.gz`);
  const member = await gzip(Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8'));
  let existing: Buffer = Buffer.alloc(0);
  try { existing = await fs.promises.readFile(file); } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
  const tmp = `${file}.tmp.${process.pid}`;
  const fh = await fs.promises.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(Buffer.concat([existing, member])); // concatenated gzip members decode as one stream
    await fh.sync();
  } finally { await fh.close(); }
  await hooks?.beforeArchiveRename?.();
  await fs.promises.rename(tmp, file);
  return file;
}

async function readArchivedRecords(root: string): Promise<ArtifactRecord[]> {
  let names: string[] = [];
  try { names = (await fs.promises.readdir(archiveDir(root))).filter((n) => n.endsWith('.jsonl.gz')).sort(); }
  catch { return []; }
  const byId = new Map<string, ArtifactRecord>();
  for (const n of names) {
    const text = (await gunzip(await fs.promises.readFile(path.join(archiveDir(root), n)))).toString('utf8');
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
    pinned, projectRoot: root, tmpDirs: [os.tmpdir(), '/tmp', '/var/tmp'], ...opts.limits,
  });
  // Strikes and the run date are recorded even when nothing is archived: that is how the 7-day gap elapses.
  await writeLedgerFile(root, { strikes: sel.ledger, lastRunAt: new Date(nowMs).toISOString() });
  if (sel.blocked === 'outage-suspected') return { status: 'outage-suspected' };
  if (sel.ids.length === 0) return { status: sel.blocked === 'below-floor' ? 'below-floor' : 'nothing-changed' };

  // One backup, ever, of the file as it was before the first cleanup (never overwritten).
  try { await fs.promises.copyFile(sidecarFile(root), preCleanupBackup(root), fs.constants.COPYFILE_EXCL); }
  catch (e) { if (errCode(e) !== 'EEXIST') throw e; }

  // Remember what each candidate looked like at survey time; the commit drops any that changed since.
  const surveyed = new Map(records.filter((r) => sel.ids.includes(r.id)).map((r) => [r.id, { n: r.versions.length, lm: r.lastModified }]));
  await opts.hooks?.beforeCommit?.();
  const result = await enqueueMaintenance(root, () => commit(root, surveyed, nowMs, opts.hooks));
  if (result.status === 'archived' && result.archivedIds) {
    // Only now, with the sidecar write committed, do the archived records leave the strike ledger.
    const done = new Set(result.archivedIds);
    await writeLedgerFile(root, { strikes: Object.fromEntries(Object.entries(sel.ledger).filter(([id]) => !done.has(id))), lastRunAt: new Date(nowMs).toISOString() });
  }
  return { ...result, braked: sel.blocked === 'braked' };
}

async function commit(
  root: string, surveyed: Map<string, { n: number; lm: string }>, nowMs: number, hooks?: CleanupHooks,
): Promise<CleanupResult> {
  const current = await readSidecarShared(root);
  if (!current || 'corrupted' in current) return { status: 'no-sidecar' };
  const doomed = current.artifacts.filter((r) => {
    const s = surveyed.get(r.id);
    return !!s && s.n === r.versions.length && s.lm === r.lastModified; // changed since the survey: keep
  });
  if (doomed.length === 0) return { status: 'nothing-changed' };
  const archivePath = await archiveRecords(root, doomed, nowMs, hooks); // archive FIRST
  await hooks?.afterArchive?.();
  const gone = new Set(doomed.map((r) => r.id));
  const next: ProjectSidecar = { ...current, artifacts: current.artifacts.filter((r) => !gone.has(r.id)) };
  const write = hooks?.writeSidecar ?? writeSidecar;
  const w = await write(root, current.updatedAt, next);
  if (!w.committed) { // lost the CAS race to another writer: no retry loop; tomorrow's run starts over
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
    return w.committed
      ? { status: 'restored', restored: add.length, skipped: wanted.length - add.length }
      : { status: 'conflict', restored: 0, skipped: wanted.length };
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
