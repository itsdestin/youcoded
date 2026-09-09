// Project-directory watcher — makes the artifact pane react to EXTERNAL changes
// (git checkout, another editor, a formatter, the agent CLI). Before this existed,
// `artifacts:changed` was only push-broadcast from the app's own write sites, so
// the pane silently showed stale content after any outside edit and the conflict
// banner in ActiveArtifactView was unreachable dead code (spec 2026-07-20 §2.1).
//
// Ownership model (spec §8.5): watchers live HERE in main, in a Map keyed by
// canonical projectRoot, REFCOUNTED by subscriber (webContents id). There is no
// per-window "active project" — N windows × M projects is the normal state — so
// per-window or leader-owned watchers would either duplicate events or tear down
// a watcher another window still needs. Refcount hits zero → the watcher is
// PARKED for WATCH_GRACE_MS and only then closed, because rebuilding one costs
// a full tree walk on the main thread (see WATCH_GRACE_MS).
//
// Provenance (spec §8.2): a filesystem watcher CANNOT know who wrote a file, so
// events carry by:'external' ("changed on disk by something other than this app").
// Never 'agent' — labeling a git checkout as "Claude edited this" would be a
// guessed cause in a user-facing string. 'agent' stays reserved for a future
// signal from the harness, which DOES know when it wrote.
import chokidar, { FSWatcher } from 'chokidar';
import fs, { Stats } from 'fs';
import path from 'path';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import { readSidecarShared } from './artifact-store';

export type ExternalChangeKind = 'edit' | 'add' | 'remove';

export interface ExternalChangeEvent {
  projectRoot: string;          // as the subscriber passed it (not canonicalized)
  artifactId: string | null;    // tracked sidecar id, or canonical relative path
  kind: ExternalChangeKind;
  by: 'external';
}

// Mirror of project-file-discovery's SKIP_DIRS + dot-directory rule, so the
// watcher and the discovery pass agree on what exists — a mismatch would emit
// events for files the UI never lists. Kept as a copy (not an import) because
// discovery treats these as walk-stops while we need per-path predicates; the
// shared source of truth is the pinning test comparing both sets.
export const WATCH_SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.cache',
  'venv', '__pycache__', 'target', 'bin', 'obj', 'vendor', 'Pods', '.terraform',
  'AppData', 'Application Data', '$Recycle.Bin', 'System Volume Information',
]);

// Matches discovery MAX_DEPTH so a broad root (the seeded Home folder) cannot
// point chokidar at an unbounded tree (plan ADDED 2026-07-22 — depth cap).
const WATCH_DEPTH = 6;

// How long a path written by the app itself stays suppressed. Must exceed
// chokidar awaitWriteFinish stabilityThreshold (500ms) with margin, or every
// in-app save would echo back as an "external" change and reset the edit draft
// mid-typing (spec §8.4 — the save→watch→reload loop).
const OWN_WRITE_TTL_MS = 2500;

/**
 * Pure ignore predicate — exported for tests. True when `absPath` under `root`
 * should produce no watch events: any skip-dir segment, any dot-directory
 * segment (which also covers .git / .youcoded / .claude, matching the discovery
 * listing filter), or a *.tmp basename (the save handler's own atomic-write
 * sibling, spec §2.5).
 */
export function isWatchIgnoredPath(root: string, absPath: string): boolean {
  const canonRoot = canonicalize(root, null);
  const canon = canonicalize(absPath, null);
  if (canon === canonRoot) return false; // the root itself is always watchable
  const rel = canon.startsWith(canonRoot + '/') ? canon.slice(canonRoot.length + 1) : canon;
  const segments = rel.split('/');
  const base = segments[segments.length - 1] ?? '';
  if (base.endsWith('.tmp')) return true;
  // All segments except the last are directories; the last is dir-or-file. A
  // dotFILE (.gitignore, .env) must stay visible — only dot-DIRECTORY segments
  // are skipped — so the basename is only checked against skip rules when it is
  // known to be a directory, which the watcher cannot know here. Checking every
  // non-final segment covers all real cases: events for files inside skipped
  // dirs are ignored, and events for the dotfiles themselves pass through.
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (seg.startsWith('.') || WATCH_SKIP_DIRS.has(seg)) return true;
  }
  return false;
}

/**
 * Is `dirPath` itself a git repository? A `.git` DIRECTORY, or a `.git` FILE
 * (git worktrees and submodules use a file). Mirrors `isGitRepo` in
 * project-file-discovery — sync here because chokidar's `ignored` matcher is
 * synchronous.
 */
function isNestedRepoDir(dirPath: string): boolean {
  try { fs.accessSync(path.join(dirPath, '.git')); return true; }
  catch { return false; }
}

interface WatchEntry {
  watcher: FSWatcher | null;
  // subscriberId (webContents id) → subscribe count. A single renderer can hold
  // two hosts on the same project (SessionDrawer + ProjectView) — both must
  // unsubscribe before the renderer stops counting.
  refs: Map<number, number>;
  stopped: boolean;
  // Set while the entry has NO subscribers but is being kept alive for reuse
  // (see WATCH_GRACE_MS). null whenever someone is subscribed.
  graceTimer: ReturnType<typeof setTimeout> | null;
  graceAt: number | null;
}

// How long a watcher outlives its last subscriber. Rebuilding one means chokidar
// re-walking the whole project tree, which blocks the main process's event loop
// — measured 310-372 ms of unresponsiveness per start on a large folder. The
// Files tab unsubscribes on every switch to Conversations and resubscribes on
// the way back, so without this, eight rapid tab clicks cost eight full walks
// (7.2-8.0 s of stall, perf-lab 2026-09-09). Keeping the watcher parked makes
// the return trip free.
const WATCH_GRACE_MS = 60_000;
let graceMs = WATCH_GRACE_MS;

// How many unsubscribed watchers may sit in the grace period at once. Each live
// watcher holds OS file-watch handles (inotify on Linux, capped per user), so
// clicking through a long project list must not accumulate them without bound;
// the oldest parked watcher closes when a newer one arrives. Four covers
// switching back and forth between a couple of projects, which is the case the
// grace exists for.
const MAX_GRACE_ENTRIES = 4;

const entries = new Map<string, WatchEntry>();          // canonical root → entry
// Count of chokidar instances actually started — the observable that proves the
// grace period is reusing watchers rather than rebuilding them (test-only read).
let watchersStarted = 0;
const ownWrites = new Map<string, number>();            // canonical abs path → expiry
const sidecarIdCache = new Map<string, { at: number; ids: Map<string, string> }>();
const SIDECAR_CACHE_TTL_MS = 5000;

let emit: ((evt: ExternalChangeEvent) => void) | null = null;

/** Wire the broadcast sink once at startup (ipc-handlers owns webContents). */
export function initProjectWatchers(onChange: (evt: ExternalChangeEvent) => void): void {
  emit = onChange;
}

/**
 * Record that the app itself just wrote `absPath`, so the watcher's echo of that
 * write is not re-broadcast as an external change (spec §8.4).
 */
export function noteOwnWrite(absPath: string): void {
  ownWrites.set(canonicalize(absPath, null), Date.now() + OWN_WRITE_TTL_MS);
}

/** Sidecar changed (appendVersion/rename/remove) — path→id map is stale. */
export function invalidateSidecarIdCache(projectRoot: string): void {
  sidecarIdCache.delete(canonicalize(projectRoot, null));
}

// Tracked artifact ids are sidecar ids, NOT paths — but the watcher only sees
// paths. Without this resolution the renderer's `evt.artifactId === artifact.id`
// filter never matches a tracked file and the conflict banner stays dead for
// exactly the files that matter (plan ADDED 2026-07-22).
async function resolveArtifactId(projectRoot: string, absPath: string): Promise<string | null> {
  const canonRoot = canonicalize(projectRoot, null);
  const canonAbs = canonicalize(absPath, null);
  let cached = sidecarIdCache.get(canonRoot);
  if (!cached || Date.now() - cached.at > SIDECAR_CACHE_TTL_MS) {
    const ids = new Map<string, string>();
    try {
      const sidecar = await readSidecarShared(projectRoot);
      if (sidecar && !('corrupted' in sidecar)) {
        for (const a of sidecar.artifacts) {
          const p = a.kind === 'internal' ? path.join(projectRoot, a.path) : a.absolutePath;
          if (p) ids.set(canonicalize(p, null), a.id);
        }
      }
    } catch {
      // Unreadable sidecar → resolve everything as a discovered relative path.
    }
    cached = { at: Date.now(), ids };
    sidecarIdCache.set(canonRoot, cached);
  }
  const tracked = cached.ids.get(canonAbs);
  if (tracked) return tracked;
  // Discovered file: its id IS the canonical relative path (GET contract).
  return canonAbs.startsWith(canonRoot + '/') ? canonAbs.slice(canonRoot.length + 1) : null;
}

/**
 * Subscribe `subscriberId` to external-change events for `projectRoot`.
 * First subscriber for a root starts the watcher; a watch failure degrades to
 * "no live refresh" rather than throwing (theme-watcher precedent).
 */
export async function watchProject(projectRoot: string, subscriberId: number): Promise<{ ok: boolean }> {
  const key = canonicalize(projectRoot, null);
  let entry = entries.get(key);
  if (entry) {
    // Reusing a parked watcher: cancel its scheduled close. This is the whole
    // point of the grace period — a tab switch must not rebuild the watcher.
    if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; entry.graceAt = null; }
    entry.refs.set(subscriberId, (entry.refs.get(subscriberId) ?? 0) + 1);
    return { ok: entry.watcher !== null };
  }
  entry = { watcher: null, refs: new Map([[subscriberId, 1]]), stopped: false, graceTimer: null, graceAt: null };
  // Register BEFORE the async watcher start so a concurrent watchProject for the
  // same root refcounts this entry instead of starting a second watcher — the
  // topicWatchers overwrite-leak class (ipc-handlers.ts:2314).
  entries.set(key, entry);
  try {
    // Nested repositories are skipped, matching project-file-discovery's walk:
    // a clone or git worktree living inside a project is its OWN project, its
    // files are never listed in this pane, and walking them is what made the
    // watcher expensive (youcoded-dev: 9,583 directories in scope, 4 s to ready
    // — 80 ms once nested repos are excluded). Answers are cached per directory
    // for the watcher's lifetime; a repo cloned in later is picked up the next
    // time the watcher starts.
    // TRADE-OFF (2026-09-09): a file inside a nested repo that IS tracked (the
    // agent edited it, so it appears in the list via the tracked union) no
    // longer live-refreshes when an OUTSIDE editor changes it. Agent edits still
    // do: APPEND_VERSION broadcasts artifacts:changed itself, and the viewer
    // refetches on any changed event for its id regardless of `by`.
    const canonRoot = canonicalize(projectRoot, null);
    const nestedRepoCache = new Map<string, boolean>();
    const watcher = chokidar.watch(projectRoot, {
      ignored: (p: string, stats?: Stats) => {
        if (isWatchIgnoredPath(projectRoot, p)) return true;
        if (stats?.isFile()) return false;       // files can't be a repo root
        const canon = canonicalize(p, null);
        if (canon === canonRoot) return false;   // the root itself is always watched
        let nested = nestedRepoCache.get(canon);
        if (nested === undefined) { nested = isNestedRepoDir(p); nestedRepoCache.set(canon, nested); }
        return nested;
      },
      ignoreInitial: true,
      followSymlinks: false,
      depth: WATCH_DEPTH,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    watchersStarted++;
    // Both 'ready' and 'error' resolve so a watch failure cannot hang the IPC
    // response (sync-spaces engine precedent).
    await new Promise<void>((resolve) => {
      watcher.once('ready', () => resolve());
      watcher.once('error', () => resolve());
    });
    // Torn down while awaiting ready (all subscribers left): close, don't strand.
    if (entry.stopped) { await watcher.close(); return { ok: false }; }
    watcher.on('all', (event: string, absPath: string) => {
      void handleFsEvent(projectRoot, event, absPath);
    });
    // An unhandled 'error' on an EventEmitter throws — degrade instead.
    watcher.on('error', () => { /* keep last-known state; no live refresh */ });
    entry.watcher = watcher;
    return { ok: true };
  } catch {
    // chokidar unavailable / root missing — subscribers stay registered so a
    // later retry could upgrade, but there is no live refresh.
    return { ok: false };
  }
}

async function handleFsEvent(projectRoot: string, event: string, absPath: string): Promise<void> {
  let kind: ExternalChangeKind;
  if (event === 'change') kind = 'edit';
  else if (event === 'add') kind = 'add';
  else if (event === 'unlink') kind = 'remove';
  else return; // addDir/unlinkDir carry no artifact identity
  const canon = canonicalize(absPath, null);
  const expiry = ownWrites.get(canon);
  if (expiry) {
    if (Date.now() < expiry) return; // the app's own write echoing back
    ownWrites.delete(canon);
  }
  const artifactId = await resolveArtifactId(projectRoot, absPath);
  emit?.({ projectRoot, artifactId, kind, by: 'external' });
}

/**
 * Drop one subscription; parks the watcher for WATCH_GRACE_MS once the last ref
 * is gone, then closes it.
 */
export function unwatchProject(projectRoot: string, subscriberId: number): void {
  const key = canonicalize(projectRoot, null);
  const entry = entries.get(key);
  if (!entry) return;
  const count = entry.refs.get(subscriberId) ?? 0;
  if (count <= 1) entry.refs.delete(subscriberId);
  else entry.refs.set(subscriberId, count - 1);
  if (entry.refs.size === 0) parkEntry(key, entry);
}

/**
 * Nobody is subscribed any more — keep the watcher alive for a while instead of
 * closing it, so the next subscriber (a tab switch, a reopened Project View)
 * gets it back for free. Enforces MAX_GRACE_ENTRIES by closing the oldest.
 */
function parkEntry(key: string, entry: WatchEntry): void {
  if (entry.graceTimer) return;    // already parked
  entry.graceAt = Date.now();
  entry.graceTimer = setTimeout(() => closeEntry(key, entry), graceMs);
  // Never hold the process open on a parked watcher — Electron quit and the
  // test runner both need to exit while one is waiting out its grace.
  entry.graceTimer.unref?.();
  const parked = [...entries].filter(([, e]) => e.graceTimer !== null);
  if (parked.length <= MAX_GRACE_ENTRIES) return;
  parked.sort((a, b) => (a[1].graceAt ?? 0) - (b[1].graceAt ?? 0));
  for (const [k, e] of parked.slice(0, parked.length - MAX_GRACE_ENTRIES)) closeEntry(k, e);
}

/**
 * A renderer died (webContents 'destroyed') — drop ALL its refs everywhere. A
 * crashed renderer never sends unwatch, and without this it would pin watchers
 * forever.
 */
export function dropSubscriber(subscriberId: number): void {
  for (const [key, entry] of entries) {
    // Same grace as an ordinary unwatch: a renderer that reloads (dev HMR, a
    // detached window reopening) comes straight back to the same projects.
    if (entry.refs.delete(subscriberId) && entry.refs.size === 0) parkEntry(key, entry);
  }
}

function closeEntry(key: string, entry: WatchEntry): void {
  entry.stopped = true;
  if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
  entry.graceAt = null;
  entries.delete(key);
  void entry.watcher?.close().catch(() => { /* already dead */ });
}

/** Test helper: tear everything down between cases. */
export function __resetProjectWatchersForTest(): void {
  for (const [key, entry] of entries) closeEntry(key, entry);
  ownWrites.clear();
  sidecarIdCache.clear();
  graceMs = WATCH_GRACE_MS;
  watchersStarted = 0;
  emit = null;
}

/** Test helper: shorten the parked-watcher grace so a close is observable. */
export function __setWatchGraceMsForTest(ms: number): void { graceMs = ms; }

/** Test helper: how many chokidar instances have been started this run. */
export function __watchersStartedForTest(): number { return watchersStarted; }
