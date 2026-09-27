// Chokidar-backed relay for docComments:watch/:unwatch — T3 of the doc-comments
// build (docs/active/specs/2026-09-26-doc-comments-build-design.md §1.5
// "Watching"/"Broadcast scope", §1.6). Refcounted per (project's comments
// directory | fallback file), mirroring git-watcher.ts's simple immediate-
// close model rather than project-watcher.ts's grace-period one: unlike a
// full project-tree walk, watching `.youcoded/comments/` (or a single
// fallback sidecar file) costs nothing worth keeping warm, so a watcher
// closes the instant its last subscriber leaves.
//
// WHY the broadcast is UN-filtered here (unlike project-watcher.ts's
// per-subscriber emit list): §1.5 "Broadcast scope" is explicit that
// comments follow `pages:changed`'s simpler pattern — every window/remote
// client gets `docComments:changed`, and a window not showing that path
// ignores it cheaply (performance.md rule 4 is satisfied by the debounce
// below, not by filtering who hears it). This module only decides WHEN to
// fire, coalesced per changed source path; ipc-handlers.ts/remote-server.ts
// decide WHO hears it.
import chokidar, { FSWatcher } from 'chokidar';
import { promises as fs } from 'fs';
import path from 'path';
import type { CommentsWatchTarget } from './doc-comments-store';

// Matches pages-service.ts's own DEBOUNCE_MS (git-watcher.ts precedent, per
// design §1.5) — chokidar's own awaitWriteFinish and this debounce exist for
// two DIFFERENT reasons at two layers: one absorbs a half-written file, the
// other absorbs several fs events (a sidecar's read-modify-write touches the
// file once, but a burst of replies can still land close together) into one
// push instead of one per event (performance.md rule 4).
const DEBOUNCE_MS = 300;

interface Entry {
  watcher: FSWatcher | null;
  refs: Map<number, number>; // subscriberId -> refcount
  // F3 fix (T5 review): the target's own realpathed project root (undefined
  // for a 'fallback' entry) — carried on every `docComments:changed` push for
  // this entry so the renderer can key it the same way its own store does.
  projectRoot: string | undefined;
  // Debounced PER SOURCE PATH, not one timer for the whole entry: rapid
  // writes to the SAME file's sidecar coalesce into one push, but two
  // DIFFERENT files changing inside the same project in the same window each
  // still get their own eventual `docComments:changed` instead of one
  // clobbering the other.
  timers: Map<string, ReturnType<typeof setTimeout>>;
  // Set once this entry has been torn down while its watcher was still
  // starting (a watchComments/unwatchComments race) — mirrors
  // project-watcher.ts's `entry.stopped`, so the async 'ready' continuation
  // below can tell "torn down" apart from "replaced by a new entry for the
  // same key", which a bare `!entries.has(key)` check cannot.
  stopped: boolean;
}

// F3 fix (T5 review): `projectRoot` rides along on every push so a renderer
// watching TWO projects that happen to share a relative path (both have a
// `README.md`) can tell which project's copy actually changed, instead of
// re-listing whichever one it last registered for that bare path.
let emit: ((sourcePath: string, projectRoot: string | undefined) => void) | null = null;
const entries = new Map<string, Entry>(); // canonical watch key -> entry

/** Wire the broadcast sink once at startup (ipc-handlers.ts owns webContents
 *  + the remote broadcast, same shape as initProjectWatchers/initGitWatchers). */
export function initDocCommentsWatcher(onChange: (sourcePath: string, projectRoot: string | undefined) => void): void {
  emit = onChange;
}

function keyFor(target: CommentsWatchTarget): string {
  return target.kind === 'project' ? `project:${target.commentsDir}` : `fallback:${target.sidecarPath}`;
}

/** Inverse of doc-comments-store's own `<rel>.json` join (§1.3): converts an
 *  absolute path changed under a project's watched comments directory back
 *  into the SOURCE file's project-relative path. Null for anything the
 *  scheme cannot invert — defensive; chokidar's own watch root already
 *  scopes every event to `commentsDir`. */
function sourcePathFor(commentsDir: string, absPath: string): string | null {
  const rel = path.relative(commentsDir, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !rel.endsWith('.json')) return null;
  return rel.slice(0, -'.json'.length);
}

function scheduleChange(entry: Entry, sourcePath: string): void {
  const existing = entry.timers.get(sourcePath);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    entry.timers.delete(sourcePath);
    emit?.(sourcePath, entry.projectRoot);
  }, DEBOUNCE_MS);
  timer.unref?.();
  entry.timers.set(sourcePath, timer);
}

/**
 * Subscribe `subscriberId` to comment changes for `target`. First subscriber
 * for a key starts the watcher; a start failure degrades to "no live
 * refresh" rather than throwing (theme-watcher/project-watcher precedent) —
 * the comments pane still works via its own re-`list()` on mount and after
 * every local mutation (§1.6), a watch failure only costs the unprompted push.
 */
export async function watchComments(target: CommentsWatchTarget, subscriberId: number): Promise<{ ok: boolean }> {
  const key = keyFor(target);
  let entry = entries.get(key);
  if (entry) {
    entry.refs.set(subscriberId, (entry.refs.get(subscriberId) ?? 0) + 1);
    return { ok: entry.watcher !== null };
  }
  entry = {
    watcher: null,
    refs: new Map([[subscriberId, 1]]),
    timers: new Map(),
    stopped: false,
    projectRoot: target.kind === 'project' ? target.projectRoot : undefined,
  };
  // Register BEFORE the async watcher start so a concurrent watchComments for
  // the same key refcounts THIS entry instead of starting a second watcher
  // (project-watcher.ts's own registration-order comment applies here too).
  entries.set(key, entry);
  const watchPath = target.kind === 'project' ? target.commentsDir : target.sidecarPath;
  // Ensure the watched DIRECTORY exists before chokidar starts (project case
  // only — a fallback watch targets one file, and chokidar handles a single
  // not-yet-existing file's future creation robustly). Without this, a brand
  // new project's very FIRST comment lands via addComment's own recursive
  // mkdir (doc-comments-store.ts's F2 note) creating `.youcoded/comments/`
  // AND a nested subdirectory AND the sidecar file all in one burst — deeper
  // and faster than chokidar reliably re-arms a watch on a root that did not
  // exist yet when watching began. Pre-creating the (empty) directory here
  // means chokidar is always watching something real from the start, so this
  // whole class of "first comment on a project never pushed to another
  // window already watching it" never arises in the first place.
  if (target.kind === 'project') {
    try { await fs.mkdir(target.commentsDir, { recursive: true }); }
    catch { /* best-effort — a failed mkdir here still lets list()/add() work; only the push degrades */ }
  }
  try {
    const watcher = chokidar.watch(watchPath, {
      ignoreInitial: true,
      followSymlinks: false,
      // The MCP pending-mutation queue's own request/result files live under
      // .pending/ inside this SAME tree (§9.2, T9a) — without this, every
      // assistant mutation's create-then-delete cycle would fire a needless
      // docComments:changed for every open pane (review 2, F20). Only the
      // project case has subdirectories at all; a fallback watch is one file.
      ignored: target.kind === 'project' ? '**/.pending/**' : undefined,
      // Non-default 500ms, not chokidar's own 2000ms default (review 2, F13)
      // — the default alone would already eat most of the pending-mutation
      // queue's response-time budget before any docx/xlsx work starts (§9.2).
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    await new Promise<void>((resolve) => {
      watcher.once('ready', () => resolve());
      watcher.once('error', () => resolve());
    });
    if (entry.stopped) { await watcher.close(); return { ok: false }; }
    watcher.on('all', (_event: string, absPath: string) => {
      if (target.kind === 'project') {
        const sourcePath = sourcePathFor(target.commentsDir, absPath);
        if (sourcePath !== null) scheduleChange(entry!, sourcePath);
      } else {
        scheduleChange(entry!, target.sourcePath);
      }
    });
    // An unhandled 'error' on an EventEmitter throws — degrade instead.
    watcher.on('error', () => { /* keep last-known state; no live refresh */ });
    entry.watcher = watcher;
    return { ok: true };
  } catch {
    // The watch path doesn't exist yet (a project with zero comments so far)
    // or chokidar is otherwise unavailable — subscribers stay registered so
    // list()/add() still work, there is just no unprompted push.
    return { ok: false };
  }
}

function closeEntry(key: string, entry: Entry): void {
  entry.stopped = true;
  entries.delete(key);
  for (const t of entry.timers.values()) clearTimeout(t);
  entry.timers.clear();
  void entry.watcher?.close().catch(() => { /* already dead */ });
}

/** Drop one subscription; closes the watcher once the last one is gone. */
export function unwatchComments(target: CommentsWatchTarget, subscriberId: number): void {
  const key = keyFor(target);
  const entry = entries.get(key);
  if (!entry) return;
  const n = (entry.refs.get(subscriberId) ?? 0) - 1;
  if (n > 0) entry.refs.set(subscriberId, n);
  else entry.refs.delete(subscriberId);
  if (entry.refs.size === 0) closeEntry(key, entry);
}

/** A renderer window or remote socket died without sending unwatch — drop
 *  ALL its refs everywhere, same as project-watcher.ts's dropSubscriber /
 *  git-watcher.ts's dropGitSubscriber. */
export function dropDocCommentsSubscriber(subscriberId: number): void {
  for (const [key, entry] of entries) {
    if (entry.refs.delete(subscriberId) && entry.refs.size === 0) closeEntry(key, entry);
  }
}

/** Test helper: tear everything down between cases. */
export function __resetDocCommentsWatcherForTest(): void {
  for (const [key, entry] of entries) closeEntry(key, entry);
  emit = null;
}
