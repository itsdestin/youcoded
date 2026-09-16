import { promises as fs, constants as fsConstants } from 'fs';
import { join, dirname, extname } from 'path';
import { ProjectSidecar } from '../../shared/artifacts/types';
import { newArtifactId, newVersionId } from '../../shared/artifacts/ulid';
import { SIDECAR_SCHEMA_VERSION } from '../../shared/artifacts/types';
import { casWrite, CAS_REPLACE_ANY, type CasExpectation } from './cas-write';
import { migrateRelativeExternals } from '../../shared/artifacts/migrate-relative-externals';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import { isAbsoluteRecorded } from './write-authorization';
import { pruneSidecarVersions } from '../../shared/artifacts/version-retention';

const SIDECAR_RELATIVE = '.youcoded/artifacts.json';

export type ReadResult = ProjectSidecar | null | { corrupted: true };

export async function readSidecar(projectRoot: string): Promise<ReadResult> {
  const path = join(projectRoot, SIDECAR_RELATIVE);
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(raw) as ProjectSidecar;
  } catch {
    // Corruption detected: back up the file and signal recovery
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.copyFile(path, `${path}.bak.${ts}`);
    return { corrupted: true };
  }
}

// ---------------------------------------------------------------------------
// Shared parsed copy — the 2026-08-27 OOM fix (read side of PR #318)
// ---------------------------------------------------------------------------
//
// PR #318 queued the sidecar WRITER and left every READER unguarded. One Edit
// costs ~11 full parses of artifacts.json (LIST_SESSION, artifacts:get per
// visible tool card, check-existence, the watcher's id map, every open tab at
// startup…), and for youcoded-dev that file is 6.4 MB / 21,311 versions. Under a
// burst those parses pile up: the 2026-08-27 core dump held 477 parsed copies
// (~3.0 GB) against V8's 2.8 GB ceiling. Evidence:
// docs/active/investigations/2026-08-27-artifacts-sidecar-oom-crash.md.
//
// `readSidecarShared` bounds that to ONE parsed copy per project:
//   - validated by the file's size + mtime (a stat, not a read) so an external
//     write — another dev instance on the same folder — is always picked up;
//   - concurrent callers share one in-flight parse;
//   - a committed `writeSidecar` SEEDS the cache with the object it just wrote,
//     so the reads that follow every edit cost zero parses;
//   - an idle copy is dropped after SIDECAR_CACHE_IDLE_MS.
//
// The shared object is READ-ONLY by contract. Callers that mutate and write
// back (appendVersionsDirect, removeArtifactRecord, renameArtifact,
// runSidecarMigration, the manual include/exclude handlers, import-project)
// keep calling `readSidecar` for a private copy — a writer mutating the shared
// object would leak a never-committed state into every reader.
//
// Blind spot, accepted: a write by ANOTHER process that leaves size and mtime
// identical (same-tick, same-length) is not detected. Appends always change
// the size; the app's own writes seed the cache and never hit this.

export const SIDECAR_CACHE_IDLE_MS = 60_000;

interface SharedSidecar {
  mtimeMs: number;
  size: number;
  value: ReadResult;
  idleTimer: NodeJS.Timeout;
}
const sharedSidecars = new Map<string, SharedSidecar>();
const sharedInFlight = new Map<string, Promise<ReadResult>>();

function sidecarPath(projectRoot: string): string {
  return join(projectRoot, SIDECAR_RELATIVE);
}

function retain(path: string, stat: { mtimeMs: number; size: number }, value: ReadResult): void {
  const prev = sharedSidecars.get(path);
  if (prev) clearTimeout(prev.idleTimer);
  const idleTimer = setTimeout(() => {
    // Only drop what this timer was armed for — a fresher entry re-armed its own.
    if (sharedSidecars.get(path)?.idleTimer === idleTimer) sharedSidecars.delete(path);
  }, SIDECAR_CACHE_IDLE_MS);
  idleTimer.unref?.();
  sharedSidecars.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value, idleTimer });
}

function touch(entry: SharedSidecar): void {
  entry.idleTimer.refresh();
}

/**
 * Read-only sidecar access that shares one parsed copy per project. See the
 * block comment above for the contract; mutate-and-write callers use
 * `readSidecar` instead.
 */
export async function readSidecarShared(projectRoot: string): Promise<ReadResult> {
  const path = sidecarPath(projectRoot);
  let stat: { mtimeMs: number; size: number };
  try {
    stat = await fs.stat(path);
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      const prev = sharedSidecars.get(path);
      if (prev) { clearTimeout(prev.idleTimer); sharedSidecars.delete(path); }
      return null;
    }
    throw e;
  }
  const cached = sharedSidecars.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    touch(cached);
    return cached.value;
  }
  const inFlight = sharedInFlight.get(path);
  if (inFlight) return inFlight;
  const p = (async () => {
    // Retain under the PRE-read stat: if the file changes between this stat
    // and the read, the next caller's stat differs and forces a re-parse.
    // Caching under a post-read stat could pin stale content under a fresh key.
    const value = await readSidecar(projectRoot);
    retain(path, stat, value);
    return value;
  })();
  sharedInFlight.set(path, p);
  try {
    return await p;
  } finally {
    sharedInFlight.delete(path);
  }
}

async function seedSharedSidecar(projectRoot: string, value: ProjectSidecar): Promise<void> {
  const path = sidecarPath(projectRoot);
  try {
    const stat = await fs.stat(path);
    retain(path, stat, value);
  } catch {
    // Not fatal — the next reader parses from disk.
  }
}

/** Tests only: drop every shared copy and timer. */
export function _resetSidecarCacheForTests(): void {
  for (const e of sharedSidecars.values()) clearTimeout(e.idleTimer);
  sharedSidecars.clear();
  sharedInFlight.clear();
}

/**
 * The CAS comparand from raw sidecar text WITHOUT parsing it. `updatedAt` is a
 * top-level-only key (shared/artifacts/types.ts — records carry `lastModified`,
 * versions carry `ts`), so the first match is the right one wherever it sits.
 * casWrite offers this the file HEAD first; undefined means "not in the head",
 * and casWrite then retries with the whole text.
 */
export function extractUpdatedAt(json: string): string | undefined {
  return /"updatedAt"\s*:\s*"([^"]*)"/.exec(json)?.[1];
}

/**
 * Advance `updatedAt` past `expected` when the two would collide.
 *
 * Fix (lost update): `updatedAt` is the CAS comparand, and it is a
 * millisecond-resolution ISO timestamp. Two writers landing inside the SAME
 * millisecond used to leave the on-disk token byte-identical to the value a
 * concurrent reader had already read — so that reader's CAS check passed on a
 * value that had in fact changed underneath it (classic ABA) and its stale copy
 * clobbered the other writer's record. Both callers got `committed: true` and
 * one artifact silently vanished; measured at ~50% of same-millisecond pairs.
 *
 * Guaranteeing the written token is strictly greater than the one the writer
 * read makes every successful write strictly increase the on-disk token (a
 * commit only happens when on-disk === expected). A stale reader can then never
 * match, so ABA is impossible. The +1ms floor also makes this robust to a
 * backwards wall-clock jump, which a plain `now` comparand is not.
 *
 * Compares PARSED times, not strings. toISOString() output is fixed-width, but
 * a sidecar synced from Android carries Java Instant.toString(), which omits
 * trailing zero sub-second digits ("…:36Z") — so lexicographic comparison would
 * be wrong on exactly the cross-device files this guard has to protect.
 * Unparseable input (hand-edited sidecar) falls through untouched rather than
 * throwing; the CAS check itself still rejects the write.
 */
function bumpPastExpected(candidate: string, expected: CasExpectation): string {
  // Nothing to out-rank: with no prior token on disk (null) or a deliberate
  // replacement of an unreadable one (CAS_REPLACE_ANY), the candidate stands.
  if (expected === null || expected === CAS_REPLACE_ANY) return candidate;
  const expMs = Date.parse(expected);
  const candMs = Date.parse(candidate);
  if (Number.isNaN(expMs) || Number.isNaN(candMs)) return candidate;
  if (candMs > expMs) return candidate;
  return new Date(expMs + 1).toISOString();
}

export async function writeSidecar(
  projectRoot: string,
  expectedUpdatedAt: CasExpectation,
  next: ProjectSidecar
): Promise<{ committed: boolean }> {
  const path = join(projectRoot, SIDECAR_RELATIVE);
  // Enforced HERE rather than in each caller so every sidecar writer inherits
  // it (appendVersion, removeArtifactRecord, renameArtifact, the ipc-handlers
  // manualIncludes/excludes paths, and sync-spaces import-project).
  //
  // This mutates `next`, so on a COMMITTED write the caller's in-memory object
  // matches disk. On a CAS conflict it does not — `next` then carries a
  // timestamp that was never written. Every caller re-reads the sidecar before
  // retrying rather than reusing the object, so nothing observes that; a future
  // caller that retries with the same object must re-read too.
  next.updatedAt = bumpPastExpected(next.updatedAt, expectedUpdatedAt);
  const json = JSON.stringify(next, null, 2);
  const result = await casWrite(
    path,
    expectedUpdatedAt,
    json,
    // 2026-08-27: was `(raw) => JSON.parse(raw).updatedAt` — a full parse of a
    // 6.4 MB file to read one timestamp, on every write. See extractUpdatedAt.
    //
    // ROADMAP L696: this used to pass `undefined` whenever expected was null,
    // which turned OFF casWrite's check entirely and is where the lost create
    // actually happened — not in cas-write.ts as the roadmap entry says. The
    // extractor now goes in unconditionally; casWrite decides what to do with
    // it, and for a null expectation it does a cheap existence check that never
    // reads the file at all.
    extractUpdatedAt
  );
  // The object we just wrote IS the on-disk state — hand it to every reader
  // that follows (LIST_SESSION fires after every tracked write) for free.
  if (result.committed) await seedSharedSidecar(projectRoot, next);
  return { committed: result.committed };
}

const MAX_RETRIES = 5;

export interface AppendVersionInput {
  path: string;            // canonical
  kind: 'internal' | 'external';
  absolutePath: string | null;
  sessionId: string;
  type: 'create' | 'edit' | 'delete' | 'read' | 'delivered';
  author: 'agent' | 'user';
  /** The transcript tool_use id behind this version, when the caller has one
   *  (the App.tsx tracker always does). It is the dedupe key: a record that
   *  already holds a version with the same (sessionId, toolUseId) is NOT
   *  appended again — see the WHY on `VersionEvent.toolUseId`. Callers with
   *  no tool call behind them (manual include, tests) leave it unset and
   *  keep today's always-append behaviour. */
  toolUseId?: string;
}

export interface AppendVersionResult {
  committed: boolean;
  artifactId: string | null;
  /** true when the version already existed and nothing was written for it. */
  deduped?: boolean;
}

/**
 * Per-project append queue.
 *
 * WHY (2026-08-15, "YouCoded dies 16–21 s after opening one big session"):
 * appendVersion used to run one full read→parse→mutate→stringify→CAS-write
 * cycle PER CALL, and every call arrived at once — opening a conversation
 * replays its whole transcript through the artifact tracker, and a long
 * session carries ~1,000 Write/Edit/Read tool calls. Each in-flight call held
 * its own parsed copy of the sidecar (4.4 MB in youcoded-dev) plus its
 * stringified twin while it waited its turn on the mkdir lock; ~1,000 × ~8 MB
 * blew past the main process's heap and Electron was killed with
 * "JavaScript heap out of memory". The heap profile named readSidecar /
 * writeSidecar as the top allocators.
 *
 * Now every call for a project root is queued and ONE drainer applies the
 * whole pending batch in a single read/apply-all/write cycle. Memory is
 * bounded to one parsed sidecar per project no matter how many calls are in
 * flight, and a 1,000-event replay costs a handful of cycles instead of a
 * thousand. Each caller still gets its own result. Cross-PROCESS writers (a
 * second YouCoded instance — dev + built app on one project) are still
 * handled by the CAS retry inside appendVersionsDirect — this queue only
 * coalesces callers inside this process.
 */
interface PendingAppend {
  input: AppendVersionInput;
  resolve: (r: AppendVersionResult) => void;
  reject: (e: unknown) => void;
}
interface ProjectQueue {
  projectId: string;
  projectName: string;
  pending: PendingAppend[];
  draining: boolean;
}
const appendQueues = new Map<string, ProjectQueue>();

export function appendVersion(
  projectRoot: string,
  projectId: string,
  projectName: string,
  input: AppendVersionInput
): Promise<AppendVersionResult> {
  return new Promise<AppendVersionResult>((resolve, reject) => {
    let q = appendQueues.get(projectRoot);
    if (!q) {
      q = { projectId, projectName, pending: [], draining: false };
      appendQueues.set(projectRoot, q);
    }
    // Same root ⇒ same project; the latest caller's identity is as good as any.
    q.projectId = projectId;
    q.projectName = projectName;
    q.pending.push({ input, resolve, reject });
    if (!q.draining) void drainAppendQueue(projectRoot, q);
  });
}

async function drainAppendQueue(projectRoot: string, q: ProjectQueue): Promise<void> {
  q.draining = true;
  try {
    // Anything pushed while a batch is being written is picked up by the next
    // iteration — appendVersion only starts a drainer when none is running.
    while (q.pending.length > 0) {
      const batch = q.pending.splice(0);
      let results: AppendVersionResult[];
      try {
        results = await appendVersionsDirect(
          projectRoot, q.projectId, q.projectName, batch.map((b) => b.input)
        );
      } catch (e) {
        for (const b of batch) b.reject(e);
        continue;
      }
      batch.forEach((b, i) => b.resolve(results[i]));
    }
  } finally {
    q.draining = false;
    // The loop only exits with an empty queue and nothing async runs between
    // that check and here, so the map entry can go; the next call makes a new one.
    if (q.pending.length === 0) appendQueues.delete(projectRoot);
  }
}

/**
 * Apply a batch of version appends in ONE read/mutate/CAS-write cycle.
 * Exported for tests and for callers that must not coalesce with the queue
 * (there are none in production today — go through appendVersion).
 * Results are positional: results[i] answers inputs[i].
 */
export async function appendVersionsDirect(
  projectRoot: string,
  projectId: string,
  projectName: string,
  inputs: AppendVersionInput[]
): Promise<AppendVersionResult[]> {
  if (inputs.length === 0) return [];
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const current = await readSidecar(projectRoot);
    let sidecar: ProjectSidecar;
    let expectedUpdatedAt: CasExpectation;
    if (current === null || 'corrupted' in current) {
      const now = new Date().toISOString();
      sidecar = {
        $schema: SIDECAR_SCHEMA_VERSION,
        projectId,
        name: projectName,
        createdAt: now,
        updatedAt: now,
        artifacts: [],
        manualExcludes: [],
        manualIncludes: [],
      };
      // ROADMAP L696: the two reasons we are here are NOT the same write.
      // `current === null` means no sidecar exists, so the write must be
      // refused if one appeared while we were building this page-one — that is
      // the lost-record race. `'corrupted' in current` means a file IS there
      // and is unreadable, and replacing it is the whole point of this branch,
      // so it says so explicitly instead of borrowing the create path's null.
      expectedUpdatedAt = current === null ? null : CAS_REPLACE_ANY;
    } else {
      sidecar = current;
      expectedUpdatedAt = sidecar.updatedAt;
    }

    const results: AppendVersionResult[] = [];
    let changed = false;
    for (const input of inputs) {
      const existing = sidecar.artifacts.find(
        (a) => a.path === input.path && a.kind === input.kind
      );
      // Replay dedupe: the same tool call recorded once already ⇒ nothing to
      // add. Same sessionId AND same toolUseId — never toolUseId alone.
      if (
        existing &&
        input.toolUseId &&
        existing.versions.some(
          (v) => v.sessionId === input.sessionId && v.toolUseId === input.toolUseId
        )
      ) {
        results.push({ committed: true, artifactId: existing.id, deduped: true });
        continue;
      }
      const now = new Date().toISOString();
      const versionEvent = {
        id: newVersionId(),
        ts: now,
        sessionId: input.sessionId,
        type: input.type,
        author: input.author,
        ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
      };
      let artifactId: string;
      if (existing) {
        existing.versions.push(versionEvent);
        // A 'read' is not a modification — bumping lastModified for a view
        // reordered "recently modified" sorting every time a pill was clicked.
        // 'delivered' is the same: handing over an old file must not jump it to
        // the top. (New records below still get lastModified = now: that's
        // record creation, and the UI labels read-only records "viewed".)
        if (input.type !== 'read' && input.type !== 'delivered') existing.lastModified = now;
        existing.status = input.type === 'delete' ? 'deleted' : 'active';
        artifactId = existing.id;
      } else {
        artifactId = newArtifactId();
        sidecar.artifacts.push({
          id: artifactId,
          path: input.path,
          kind: input.kind,
          absolutePath: input.absolutePath,
          lastModified: now,
          status: input.type === 'delete' ? 'deleted' : 'active',
          versions: [versionEvent],
          comments: [],
          tags: [],
        });
      }
      changed = true;
      results.push({ committed: true, artifactId });
    }

    // Every input was a duplicate of something already on disk: no write, no
    // updatedAt bump — a re-opened conversation must leave the sidecar
    // byte-identical (that is the whole point of the dedupe).
    // ROADMAP L696: "we did not just build this sidecar from nothing". A
    // CAS_REPLACE_ANY expectation is a REBUILD over a corrupt file, which must
    // still be written even when every input deduped — otherwise the corrupt
    // file survives.
    if (!changed && typeof expectedUpdatedAt === 'string') return results;

    // Retention. WHY HERE: pruning lives in the writer, in the same cycle that
    // appends, so artifacts.json is bounded BY CONSTRUCTION. That is why there
    // is no migration, no one-shot repair script and no startup scan — the
    // first question a reader asks. A sidecar that is already oversized heals
    // on its next write, and one that is never written again was never growing.
    //
    // It sweeps EVERY record, not just the ones this batch touched, so an
    // oversized file heals in one write instead of file-by-file as each is
    // edited. The cost is a linear pass over data we are about to
    // JSON.stringify anyway.
    //
    // It runs only when we are already committing (below the dedupe early
    // return above), so the "a re-opened conversation leaves the sidecar
    // byte-identical" invariant is untouched.
    //
    // Policy and safety floor: shared/artifacts/version-retention.ts.
    pruneSidecarVersions(sidecar);

    sidecar.updatedAt = new Date().toISOString();
    const result = await writeSidecar(projectRoot, expectedUpdatedAt, sidecar);
    if (result.committed) return results;
    await sleep(10 * (attempt + 1));
  }
  return inputs.map(() => ({ committed: false, artifactId: null }));
}

/**
 * Remove an artifact RECORD from the sidecar (the tracking entry, never the
 * file on disk). Powers the Session Drawer's per-row remove: clears accidental
 * pill-click "artifactifies" and dead orphan rows. If Claude edits the file
 * again a fresh record is created — removal is not a permanent opt-out (that's
 * what manualExcludes is for).
 */
export async function removeArtifactRecord(
  projectRoot: string,
  artifactId: string
): Promise<{ ok: boolean; error?: string }> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const current = await readSidecar(projectRoot);
    if (current === null || 'corrupted' in current) return { ok: false, error: 'sidecar-missing' };
    const idx = current.artifacts.findIndex((a) => a.id === artifactId);
    if (idx === -1) return { ok: false, error: 'artifact-not-found' };
    const expectedUpdatedAt = current.updatedAt;
    current.artifacts.splice(idx, 1);
    current.updatedAt = new Date().toISOString();
    const result = await writeSidecar(projectRoot, expectedUpdatedAt, current);
    if (result.committed) return { ok: true };
    await sleep(10 * (attempt + 1));
  }
  return { ok: false, error: 'write-conflict' };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Project roots already checked in THIS process. The migration is safe to call
// from hot handlers (LIST_SESSION fires after every tracked write), but the
// pure pass is over EVERY record — 3,917 artifacts / 21,311 versions in
// youcoded-dev on 2026-08-27, and growing ~600 versions a day — so there is no
// reason to redo it every call. (An earlier revision of this comment sized it
// at "2,800 records"; the 7.6x drift is part of why the 2026-08-27 OOM
// investigation exists — never assume this file is small.)
//
// Process-lifetime, deliberately: the sidecar (.youcoded/artifacts.json) is
// per-device and NEVER synced — DEFAULT_IGNORES (sync-spaces/guards.ts) excludes
// .youcoded/ from the sync repo, and project-manager.ts separately adds it to
// the project's own .gitignore — so there is no cross-device write to catch up
// on. What the process-lifetime memo actually buys: a repair skipped by a
// transient failure (see the catch below) is retried automatically the next
// time this app launches, rather than being permanently missed by a persistent
// "already migrated" marker. That is the trade for having no such marker on
// disk — see the plan's design decision 2.
const migrationChecked = new Set<string>();

/**
 * One-time repair of relative-external records (see
 * shared/artifacts/migrate-relative-externals.ts).
 *
 * The run-once gate is `reclassified === 0`, NOT a $schema bump. appendVersion
 * round-trips $schema from disk, so a schema marker would say "repaired"
 * permanently once written, with no way to notice if a later bug (or a
 * hand-edited sidecar) reintroduced a relative-external record. The pure
 * function already tells us whether anything changed; nothing is written when
 * it hasn't.
 *
 * WHY here and not inside readSidecar: readSidecar is a hot path (every get,
 * save, and list call). A function that writes from inside a read is both
 * surprising and a lock-contention risk.
 */
export async function runSidecarMigration(
  projectRoot: string
): Promise<{ migrated: boolean; reclassified: number; merged: number }> {
  const NOTHING = { migrated: false, reclassified: 0, merged: 0 };
  // Fix: key the memo on the CANONICAL form, not the raw string. This function
  // has exactly three callers, all in ipc-handlers.ts (verified via
  // `rg -n "runSidecarMigration" desktop/src/`): LIST_SESSION passes the
  // renderer's projectRoot straight through as typed/received, while
  // LIST_PROJECT and LIST_ALL_FILES both resolve a path off the project index
  // first — a case- or separator-differing pair for the SAME project would
  // otherwise memo separately and re-run the migration a second time (finding
  // nothing, since the first run already repaired it, but still paying the
  // sidecar read + pure-pass cost). canonicalize() is already how every other
  // cache in this layer (project-watcher.ts's sidecarIdCache,
  // project-file-discovery.ts's cache) keys on project root for this exact
  // reason.
  const key = canonicalize(projectRoot, null);
  if (migrationChecked.has(key)) return NOTHING;

  // Fix: this best-effort repair runs INSIDE three handlers that were
  // read-only before this branch (LIST_SESSION, LIST_PROJECT, LIST_ALL_FILES)
  // and must fail closed rather than break the listing it precedes. The
  // fs.copyFile backup below only swallows EEXIST and rethrows everything
  // else, and writeSidecar's CAS write (casWrite -> atomicWrite) can throw
  // ENOSPC, EROFS, EACCES, or (on Windows, when antivirus holds the file)
  // EPERM. An uncaught rejection here propagates out of those IPC handlers;
  // FilesTab.tsx's `listAllFiles(...).then(...)` has no `.catch`, so an
  // unhandled rejection would leave its loading spinner stuck forever. Report
  // "nothing happened" instead, and memoize so a PERSISTENT failure (e.g. a
  // read-only filesystem) does not retry this same expensive, doomed work on
  // every subsequent list call in this process — the next app launch gets a
  // fresh memo and another attempt.
  try {
    // The sidecar is written continuously by the running app, so a CAS conflict
    // is a real (if rare) outcome. Mirror appendVersion: re-read and retry
    // rather than deferring to "some later project open", which for the
    // busiest project is the least likely to win.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await readSidecar(projectRoot);
      if (current === null || 'corrupted' in current) {
        migrationChecked.add(key);
        return NOTHING;
      }

      const result = migrateRelativeExternals(current, projectRoot);
      if (result.reclassified === 0) {
        migrationChecked.add(key);   // nothing to do — don't re-scan this process
        return NOTHING;
      }

      // Back up before the first rewrite. This edits weeks of artifact history
      // in place; a copy is the only way back if the merge rule turns out wrong
      // for a record we did not anticipate. FIXED name, written only if
      // absent: a timestamped name would accumulate one file per retry and per
      // relapse.
      const sidecarPath = join(projectRoot, SIDECAR_RELATIVE);
      try {
        await fs.copyFile(sidecarPath, `${sidecarPath}.pre-migration.bak`, fsConstants.COPYFILE_EXCL);
      } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;   // a backup already exists — keep the oldest
      }

      // CAS on the value we read: if another window wrote in between, re-read
      // and recompute rather than clobber.
      const next: ProjectSidecar = result.sidecar;
      const { committed } = await writeSidecar(projectRoot, current.updatedAt, next);
      if (committed) {
        migrationChecked.add(key);
        // ROADMAP L598: say WHAT was rewritten, every time. Nothing else
        // detects a repair that over-reclassifies — the symptom is unfamiliar
        // entries in Project View, not an error — so the main log carries the
        // count, each from→to (capped), how many were the cross-OS-remap
        // shape (the one worth eyeballing), and the backup to restore from.
        const LIST_CAP = 20;
        const remapped = result.reclassifiedFrom.filter((r) => r.wasAbsolute).length;
        const listed = result.reclassifiedFrom.slice(0, LIST_CAP)
          .map((r) => `    ${r.from} -> ${r.to}${r.merged ? ' (merged into existing record)' : ''}${r.wasAbsolute ? ' [cross-OS remap]' : ''}`)
          .join('\n');
        const more = result.reclassifiedFrom.length > LIST_CAP ? `\n    … and ${result.reclassifiedFrom.length - LIST_CAP} more` : '';
        console.warn(
          `[artifact-store] sidecar repair in ${projectRoot}: ${result.reclassified} record(s) reclassified external -> internal`
          + ` (${result.merged} merged into an existing record, ${remapped} re-homed from an ABSOLUTE path — check those by eye).`
          + ` They now show in Project View. If any of them were never in this project, restore ${sidecarPath}.pre-migration.bak.\n`
          + listed + more,
        );
        return { migrated: true, reclassified: result.reclassified, merged: result.merged };
      }
    }
    return NOTHING;   // three conflicts — do NOT memo; the next call retries
  } catch (err) {
    // Fix: this used to fail silently — same return value as "nothing to
    // repair", plus the memo above suppresses every retry for the rest of the
    // process. That makes a failed repair indistinguishable from this fix
    // never having shipped: both look like files "no longer on disk" that
    // actually exist. Log so a developer (or Destin, via Diagnose with
    // Claude) can tell the two apart instead of re-debugging the original bug.
    console.error('[artifact-store] runSidecarMigration failed for', projectRoot, err);
    migrationChecked.add(key);   // see the WHY block above — fail closed, don't retry every call
    return NOTHING;
  }
}

export interface RenameResult {
  ok: boolean;
  error?: string;
  newPath?: string;
}

// Rename an artifact's file on disk and update its sidecar record. `newBaseName`
// is the new filename WITHOUT extension — the original extension is preserved so
// the file type can't be changed by accident. Path-traversal names and
// collisions with an existing file are rejected.
//
// The file rename happens exactly ONCE (before the CAS-retry loop). Only the
// sidecar record update is retried, so a write conflict can never double-rename
// the file on disk (which would ENOENT the second time).
export async function renameArtifact(
  projectRoot: string,
  artifactId: string,
  newBaseName: string
): Promise<RenameResult> {
  const clean = newBaseName.trim();
  if (!clean || /[\\/]/.test(clean) || clean === '.' || clean === '..') {
    return { ok: false, error: 'invalid-name' };
  }

  // Validate + compute paths from a single read.
  const first = await readSidecar(projectRoot);
  if (first === null || 'corrupted' in first) return { ok: false, error: 'sidecar-missing' };
  const a0 = first.artifacts.find((a) => a.id === artifactId);
  if (!a0) return { ok: false, error: 'artifact-not-found' };

  const oldAbs = a0.kind === 'internal' ? join(projectRoot, a0.path) : (a0.absolutePath ?? '');
  // Fix: guard against a relative `absolutePath` here too — this is the FIFTH
  // site that builds a path from a record (write-authorization.ts's two
  // functions, artifacts:check-existence, and countArtifacts are the other
  // four). Unguarded, `oldAbs` resolves against the PROCESS cwd for the
  // fs.access/fs.rename calls below, so this could rename (or silently clobber)
  // a file OUTSIDE the project — a real filesystem mutation, not just a stale
  // read. Reachable permanently, not only in the pre-repair window: records
  // whose real path escapes the project root with `..` are deliberately left
  // external with a relative absolutePath by design, and the Session Drawer's
  // click-to-rename has no filter on record kind.
  if (a0.kind === 'external' && !isAbsoluteRecorded(oldAbs)) return { ok: false, error: 'no-path' };
  if (!oldAbs) return { ok: false, error: 'no-path' };
  const dir = dirname(oldAbs);
  const ext = extname(a0.path); // keep the original extension
  const newFilename = clean + ext;
  const newAbs = join(dir, newFilename);
  if (newAbs === oldAbs) return { ok: true, newPath: a0.path }; // no-op (same name)

  // Collision guard — never clobber an existing file.
  try {
    await fs.access(newAbs);
    return { ok: false, error: 'name-taken' };
  } catch { /* ENOENT — the name is free */ }

  // Rename on disk — once.
  try {
    await fs.rename(oldAbs, newAbs);
  } catch (e: any) {
    return { ok: false, error: e?.code === 'ENOENT' ? 'file-missing' : 'rename-failed' };
  }

  // Reflect the new path in the sidecar (CAS-retry; file is already moved).
  const relDir = a0.kind === 'internal' ? dirname(a0.path) : '';
  const newRelPath = a0.kind === 'internal'
    ? (relDir === '.' || relDir === '' ? newFilename : `${relDir.replace(/\\/g, '/')}/${newFilename}`)
    : newFilename;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const cur = await readSidecar(projectRoot);
    // File already moved; if the sidecar vanished/corrupted, report success on
    // the file op — a later listSession re-reads whatever the sidecar holds.
    if (cur === null || 'corrupted' in cur) return { ok: true, newPath: newRelPath };
    const art = cur.artifacts.find((a) => a.id === artifactId);
    if (!art) return { ok: true, newPath: newRelPath };

    const expectedUpdatedAt = cur.updatedAt;
    art.path = newRelPath;
    if (art.kind === 'external') art.absolutePath = newAbs.replace(/\\/g, '/');
    const now = new Date().toISOString();
    art.lastModified = now;
    cur.updatedAt = now;

    const result = await writeSidecar(projectRoot, expectedUpdatedAt, cur);
    if (result.committed) return { ok: true, newPath: newRelPath };
    await sleep(10 * (attempt + 1));
  }
  // Sustained contention only — the file IS renamed, so report success.
  return { ok: true, newPath: newRelPath };
}
