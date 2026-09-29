// desktop/src/main/sync-spaces/engine.ts
// Watch → debounce → sync (pull-then-push) per space, plus a poll loop that
// stands in for SyncHub signals until Plan 1b. Single-flight per space: a
// change arriving mid-sync queues exactly one follow-up sync.
import chokidar, { FSWatcher } from 'chokidar';
import type { Stats } from 'fs';
import path from 'path';
import type { SpaceSyncEvent, SyncSpace, SyncTransport } from './types';
import { DEFAULT_IGNORED_DIR_NAMES } from './guards';
import { REPO_CORRUPT_ERROR_CODE, REPO_REPAIR_FAILED_ERROR_CODE } from '../sync-error-classifier';

interface EngineOpts {
  debounceMs?: number;  // default 15s (spec §8)
  pollMs?: number;      // default 120s (spec §6 degradation path); 0 disables
  sizeWarnBytes?: number; // default 500MB; injectable so tests can use a low threshold
  watchBudget?: number; // default WATCH_BUDGET; injectable so tests can use a low one
  onEvent: (e: SpaceSyncEvent) => void;
  // Provision the space's remote (repo create/view + setRemote) when a sync
  // cycle finds none. Injected by service.ts so the engine stays free of a
  // SpaceManager/gh dependency. MUST throw a plain-language error on failure —
  // syncSpace surfaces it verbatim as the space's error event every cycle.
  ensureProvisioned?: (space: SyncSpace) => Promise<void>;
}

// Warn once per launch when a space's hidden sync history exceeds this. Remote
// history compaction stays a MANUAL, deferred procedure (spec §7) — we never
// automate a force-push or peer re-clone. TODO: point the notice at the exact
// manual-compaction doc once that procedure is written up (a later task).
const SIZE_WARN_BYTES = 500 * 1024 * 1024;

// Most files and folders one space may live-watch (spec §18's engine-level
// guardrail). chokidar holds one OS watch per file AND folder, and on Linux
// those come out of a per-user pool other apps (editors, dev servers) share —
// one oversized project could exhaust it for all of them. Past this the space
// drops to the poll alone: every change still syncs, within pollMs instead of
// debounceMs. Set well above MAX_IMPORT_FILE_COUNT (20k) so an ordinary project
// never trips it; the one that did (2026-09-29) had ~2k entries once its own
// .gitignore was honoured, against ~249k watched before.
const WATCH_BUDGET = 50_000;

interface SpaceState {
  space: SyncSpace;
  // null = poll-only: over WATCH_BUDGET, or the watcher failed to start.
  watcher: FSWatcher | null;
  // Folders the transport says never sync (relative, '/'-separated). Replaced
  // wholesale on refresh, never mutated, so the live `ignored` closure only
  // ever reads a complete set.
  ignoredDirs: Set<string>;
  // A folder or .gitignore appeared since the last refresh: re-ask the
  // transport after the next sync (see refreshIgnoredDirs).
  ignoredDirty: boolean;
  // Approximate live watch count (initial scan + adds − removals) for the budget.
  watchCount: number;
  debounce: ReturnType<typeof setTimeout> | null;
  syncing: boolean;
  rerun: boolean;
  // The in-flight sync's promise, so stop() can await it. Without this, quit
  // teardown (and tests' temp-dir cleanup) races the git subprocesses a sync
  // spawns — on Windows their cwd/file handles block directory removal.
  current: Promise<void> | null;
}

// Always-skipped paths, checked before the transport's ignored-folder list (see
// isOutOfWatchScope). Each regex means: "this directory name appears anywhere
// in the path, with either slash style" (Windows \ or POSIX /).
// Lock dirs (`<file>.json.lock`) are the mkdir-based lock cas-write.ts takes
// around every conversation/registry write — created and removed within
// milliseconds. Watching them is pointless (always empty; git can't track an
// empty dir) and actively harmful: on Windows chokidar racing the lock's own
// rmdir throws `EPERM: operation not permitted, watch '…json.lock'`, which
// surfaced to the user as a red "Couldn't sync" on a sync that was working
// fine. Scoped to `.json.lock` — NOT bare `.lock` — so real lockfiles a user
// syncs (Cargo.lock, Gemfile.lock, poetry.lock) still trigger an instant sync.
const WATCH_IGNORED = [/(^|[\\/])\.youcoded([\\/]|$)/, /(^|[\\/])node_modules([\\/]|$)/, /(^|[\\/])\.git([\\/]|$)/, /\.json\.lock([\\/]|$)/];

/** Should the watcher skip `absPath`? True for WATCH_IGNORED, anything at or
 *  under a folder in `ignoredDirs`, and folders named in DEFAULT_IGNORES.
 *  WHY this is not just WATCH_IGNORED any more (2026-09-29): the watcher used
 *  to skip only those four, so it held one OS watch per file inside .venv,
 *  build, and every folder a project's own .gitignore excludes — ~249k watches
 *  on a project where ~2k entries actually sync. The watcher is only an
 *  accelerant (the poll catches anything it misses), so skipping a folder can
 *  at worst delay a change to the next poll, never lose it.
 *  The DEFAULT_IGNORES name check applies to a path's LAST segment only when
 *  it is known to be a folder: a file literally named `build` (a script) still
 *  syncs, and must still be watched. Accepted trade-off: a project whose
 *  .gitignore re-includes one of those folders (`!build/`) syncs it on the
 *  poll rather than within seconds. Pure — exported for its unit test. */
export function isOutOfWatchScope(root: string, ignoredDirs: ReadonlySet<string>, absPath: string, stats?: Stats): boolean {
  if (WATCH_IGNORED.some(re => re.test(absPath))) return true;
  const rel = path.relative(root, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false; // the root itself, or outside it
  const segments = rel.split(/[\\/]/);
  let prefix = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    prefix = prefix ? `${prefix}/${seg}` : seg;
    if (ignoredDirs.has(prefix)) return true;
    const isFolder = i < segments.length - 1 || !!stats?.isDirectory();
    if (isFolder && DEFAULT_IGNORED_DIR_NAMES.has(seg)) return true;
  }
  return false;
}

export class SpaceSyncEngine {
  private states = new Map<string, SpaceState>();
  // Set once in stop(): a latch so an addSpace() suspended on its `await ready`
  // while the engine is torn down closes its watcher instead of inserting it
  // into the now-cleared states map — a watcher nothing would ever close, which
  // keeps syncing after the user turned sync off (until restart). Engines are
  // single-use, so the latch never needs resetting. (Review #3.)
  private stopped = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceMs: number;
  private pollMs: number;
  private sizeWarnBytes: number;
  private ensureProvisioned?: (space: SyncSpace) => Promise<void>;
  // One-per-LAUNCH dedup for the large-history warning: this Set lives as long
  // as the engine instance, so a space that's already over the threshold emits
  // the warning exactly once instead of on every sync.
  private warnedLargeSpaces = new Set<string>();
  // One heal attempt per space per LAUNCH (spec §2 guardrail): a second
  // corruption in the same run means something deeper than crash damage —
  // surface it instead of thrashing repair/fail loops at poll cadence.
  private healedSpaces = new Set<string>();
  // Over-cap files already reported this launch, per space. A tracked file
  // that grew past the cap is re-detected on EVERY sync (every ~2 min), and
  // re-emitting it each time pushed useful events out of the service's
  // last-50 buffer. The service keeps the full list for display.
  private reportedOversize = new Map<string, Set<string>>();
  private watchBudget: number;
  // One "too big to watch" notice per space per LAUNCH, like warnedLargeSpaces.
  private warnedUnwatched = new Set<string>();
  private onEvent: (e: SpaceSyncEvent) => void;

  constructor(private transport: SyncTransport, opts: EngineOpts) {
    this.debounceMs = opts.debounceMs ?? 15_000;
    this.pollMs = opts.pollMs ?? 120_000;
    this.sizeWarnBytes = opts.sizeWarnBytes ?? SIZE_WARN_BYTES;
    this.watchBudget = opts.watchBudget ?? WATCH_BUDGET;
    this.ensureProvisioned = opts.ensureProvisioned;
    this.onEvent = opts.onEvent;
    if (this.pollMs > 0) {
      this.pollTimer = setInterval(() => {
        for (const st of this.states.values()) void this.syncSpace(st.space);
      }, this.pollMs);
      // Don't keep the process alive for polling alone.
      (this.pollTimer as any).unref?.();
    }
  }

  async addSpace(space: SyncSpace): Promise<void> {
    if (this.states.has(space.id)) return;
    await this.transport.init(space);
    const st: SpaceState = {
      space, watcher: null, debounce: null, syncing: false, rerun: false, current: null,
      ignoredDirs: new Set((await this.readIgnoredDirs(space)) ?? []), ignoredDirty: false, watchCount: 0,
    };
    await this.startWatcher(st);
    // Torn down while we awaited 'ready' (disable landed mid-add): close this
    // watcher and DON'T register it — stop() already snapshotted the states map,
    // so a set() here would strand a live watcher forever (review #3).
    if (this.stopped) { await st.watcher?.close(); st.watcher = null; return; }
    this.states.set(space.id, st);
    // Close the macOS arming window with one scheduled sync. On macOS fs.watch
    // returns BEFORE the OS watch is armed (libuv hands it to a CoreFoundation
    // run loop on another thread), so a file written in that window is never
    // reported — not late, never — and would sit unsynced until the next
    // unrelated change. Measured with scripts/diag/fswatch-probe.mjs on a
    // 3-core macOS CI runner under load: 4 of 200 immediate writes lost, 0 of
    // 200 on Linux. There is no "armed" event to wait for, so instead of trying
    // to observe arming we sync once regardless; a real change during the
    // debounce coalesces into the same run rather than adding one.
    this.schedule(st);
  }

  /** The transport's never-synced folders, or null when it can't say (no
   *  method, or it failed) — callers keep what they had rather than widen. */
  private async readIgnoredDirs(space: SyncSpace): Promise<string[] | null> {
    try { return (await this.transport.ignoredDirs?.(space)) ?? null; } catch { return null; }
  }

  /** Start watching st's space under its current ignoredDirs and set
   *  st.watcher — or leave it null (poll-only, with a one-per-launch notice)
   *  when the space holds more than watchBudget watchable entries. */
  private async startWatcher(st: SpaceState): Promise<void> {
    const { space } = st;
    // Budget check DURING the initial scan, not after it: once chokidar has
    // walked a huge tree the OS watches are already spent, which is the very
    // cost the budget exists to prevent. chokidar asks `ignored` about every
    // entry (with stats) before watching it, so counting there lets us stop
    // registering at the budget instead of after the whole tree.
    let scanning = true;
    let over = false;
    const seen = new Set<string>();
    const watcher = chokidar.watch(space.root, {
      ignored: (p: string, stats?: Stats) => {
        if (isOutOfWatchScope(space.root, st.ignoredDirs, p, stats)) return true;
        if (scanning && stats && !seen.has(p)) {
          if (seen.size >= this.watchBudget) { over = true; return true; }
          seen.add(p);
        }
        return false;
      },
      ignoreInitial: true,
      followSymlinks: false,       // spec §8: symlinks are not synced
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    // Wait for chokidar's initial scan to complete before returning. With
    // ignoreInitial:true, any file written *before* 'ready' is treated as a
    // pre-existing file and silently NOT emitted — so callers that write right
    // after addSpace() (and the engine tests) would never trigger a sync. The
    // 'error' path resolves too so a watch failure can't hang startup.
    //
    // NOTE: 'ready' is NOT sufficient on macOS, which is why addSpace's
    // reconcile sync exists. chokidar bottoms out in fs.watch, and fs.watch
    // returns before the OS-level watch is armed there — 'ready' can fire while
    // changes are still being dropped. See the reconcile comment in addSpace.
    await new Promise<void>(resolve => {
      watcher.once('ready', () => resolve());
      watcher.once('error', () => resolve());
    });
    scanning = false;
    if (over) {
      await watcher.close();
      this.noteUnwatched(space);
      return;
    }
    st.watchCount = seen.size;
    seen.clear();
    st.watcher = watcher;
    watcher.on('all', (event: string, p: string) => this.onWatchEvent(st, watcher, event, p));
    // A watcher that dies after startup (inotify exhaustion, permissions) must
    // surface as a sync error, not crash the app — an unhandled 'error' on a
    // Node EventEmitter throws. 'all' does NOT receive error events.
    watcher.on('error', (e: any) => this.onEvent({ type: 'error', spaceId: space.id, message: String(e?.message ?? e) }));
  }

  private onWatchEvent(st: SpaceState, watcher: FSWatcher, event: string, p: string): void {
    if (event === 'add' || event === 'addDir') st.watchCount++;
    else if (event === 'unlink' || event === 'unlinkDir') st.watchCount = Math.max(0, st.watchCount - 1);
    // A new folder may be one the project's .gitignore skips under a name
    // DEFAULT_IGNORED_DIR_NAMES doesn't know (a `.venv-rocm`), and a .gitignore
    // edit can change what's skipped: re-ask the transport after the next sync.
    if (event === 'addDir' || path.basename(p) === '.gitignore') st.ignoredDirty = true;
    this.schedule(st);
    // Grew past the budget after startup (a big generated folder the ignore
    // rules don't cover): same outcome as starting over it — poll-only.
    if (st.watchCount > this.watchBudget && st.watcher === watcher) {
      st.watcher = null;
      this.noteUnwatched(st.space);
      void watcher.close().catch(() => {});
    }
  }

  private noteUnwatched(space: SyncSpace): void {
    if (this.warnedUnwatched.has(space.id)) return;
    this.warnedUnwatched.add(space.id);
    // 'notice', not 'error': sync still works, only its speed changed — it must
    // never turn the dot red (sync-dot-state skips notices).
    this.onEvent({ type: 'notice', spaceId: space.id, message: `${path.basename(space.root)} is very large, so its changes sync every couple of minutes instead of right away.` });
  }

  /** Re-ask the transport which folders never sync; if the answer changed,
   *  rebuild the watcher under it. Runs after a sync, and only when a new
   *  folder or .gitignore change was seen, so an idle space never pays for it. */
  private async refreshIgnoredDirs(st: SpaceState): Promise<void> {
    st.ignoredDirty = false;
    const next = await this.readIgnoredDirs(st.space);
    if (!next) return; // can't tell — keep the current scope rather than widen it
    const nextSet = new Set(next);
    if (nextSet.size === st.ignoredDirs.size && next.every(d => st.ignoredDirs.has(d))) return;
    st.ignoredDirs = nextSet;
    const old = st.watcher;
    if (this.stopped || this.states.get(st.space.id) !== st) return; // detached: nothing to rebuild
    // Rebuild rather than patch the live watcher: chokidar's unwatch(dir)
    // closes only that folder's own handle and leaves every handle beneath it
    // open, and a path it unwatched stays ignored even after a later add(). A
    // fresh scan of the (now smaller) tree is exact.
    // A poll-only space (old === null) is re-armed too: a big folder only the
    // project's .gitignore knows (a `.venv-rocm`) can flood past the budget
    // before this refresh learns to skip it — without this the space stayed on
    // the poll until restart (review, 2026-09-29). startWatcher re-checks the
    // budget, so a space that is genuinely too big just stays poll-only.
    st.watcher = null;
    if (old) await old.close();
    await this.startWatcher(st);
    // startWatcher set it; TS still holds the `= null` narrowing from above.
    const rebuilt = st.watcher as FSWatcher | null;
    // Torn down mid-rebuild (stop()/removeSpace() already ran their close pass).
    if (this.stopped || this.states.get(st.space.id) !== st) { await rebuilt?.close(); st.watcher = null; return; }
    // A change made between the old watcher closing and the new one's 'ready'
    // was swallowed as initial scan: one sync picks it up.
    this.schedule(st);
  }

  private schedule(st: SpaceState): void {
    if (st.debounce) clearTimeout(st.debounce);
    st.debounce = setTimeout(() => { st.debounce = null; void this.syncSpace(st.space); }, this.debounceMs);
  }

  /** Pull first (reduces non-fast-forward pushes), then push. Never throws. */
  async syncSpace(space: SyncSpace): Promise<void> {
    const st = this.states.get(space.id);
    if (!st) return;
    // Single-flight: if a sync is already running, flag exactly ONE follow-up
    // rerun (the finally block below fires it) — extra requests coalesce.
    // The caller still waits for THAT follow-up, not just the run in flight:
    // "Try again" / "Sync now" await this promise to show "Syncing…", and
    // returning early made the button look like it did nothing (2026-09-16).
    if (st.syncing) {
      st.rerun = true;
      await st.current;
      // The finished run's finally block has started the follow-up by now.
      const followUp = this.states.get(space.id)?.current;
      if (followUp) await followUp;
      return;
    }
    st.syncing = true;
    // Keep the whole pull+push chain as a promise on the state so stop() can
    // await an in-flight sync instead of resolving with git still running.
    st.current = (async () => {
      try {
        // A space with NO remote must never emit 'synced': pull/push silently
        // no-op without one, and that phantom success superseded the real
        // provisioning error in the UI — a fresh device showed green
        // "All synced" while it had never contacted GitHub (2026-07-20 VM bug).
        // Instead, (re)provision on EVERY cycle — poll, debounce, and manual
        // "Sync now" all pass through here — so the space heals itself the
        // moment gh/auth is fixed, and the real failure (e.g. "GitHub CLI (gh)
        // is not installed…") re-surfaces each cycle until then, which is what
        // keeps it alive past latestUnresolvedError's supersession rule.
        if (!(await this.transport.hasRemote(space))) {
          if (!this.ensureProvisioned) {
            throw new Error(`${space.id} is not connected to a sync repository yet`);
          }
          await this.ensureProvisioned(space);
        }
        const pull = await this.transport.pull(space);
        if (pull.conflictCopies.length) this.onEvent({ type: 'conflict', spaceId: space.id, copies: pull.conflictCopies });
        const push = await this.transport.push(space, `sync from ${space.id}`);
        // A rejected push recovers by pulling + retrying (a peer pushed first).
        // Fold that recovery pull's outcome into THIS cycle's events — without
        // it, the peer's changes land on disk with updated:false and nothing
        // downstream (conversation materialize sweep, project discovery,
        // conflict notice) ever reacts to them.
        if (push.conflictCopies?.length) this.onEvent({ type: 'conflict', spaceId: space.id, copies: push.conflictCopies });
        const reported = this.reportedOversize.get(space.id) ?? new Set<string>();
        const fresh = push.oversize.filter(f => !reported.has(f));
        if (fresh.length) {
          for (const f of fresh) reported.add(f);
          this.reportedOversize.set(space.id, reported);
          this.onEvent({ type: 'oversize', spaceId: space.id, files: fresh });
        }
        // `contacted`: did THIS cycle reach GitHub at all? An offline cycle
        // completes silently (spec §13) and still emits 'synced' so the panel's
        // state machine sees the cycle end — but the service must not stamp
        // "last synced" from it, or a device offline for days reads "Synced
        // just now" every 120 s poll. A transport that does not report contact
        // is read as contact (the pre-2026-09-16 behaviour).
        const contacted = (pull.contacted ?? true) || (push.contacted ?? true);
        this.onEvent({ type: 'synced', spaceId: space.id, pushed: push.pushed, updated: pull.updated || !!push.updated, contacted });
        // Post-sync maintenance (spec §7). Wrapped so a repack/probe failure can
        // NEVER break a sync — the sync already succeeded above.
        try {
          // LOCAL git gc every Nth sync: repacks THIS device's history only,
          // never rewrites it, so it can't desync peers. No-op on transports
          // (future YouCoded Cloud) that don't implement it. Note: the counter
          // increments on EVERY successful sync, including idle no-op polls, so
          // gc effectively fires on a time cadence too — harmless, because
          // `git gc --auto` itself no-ops when the repo doesn't need repacking.
          await this.transport.maybeGc?.(space);
          // One-per-launch large-history NOTICE (not an error — sync still works).
          // Emitted as the 'notice' kind so it never turns the project's sync dot
          // red. Remote/history compaction stays a MANUAL deferred procedure — we
          // never automate a force-push. Unit is binary MiB to match sizeWarnBytes.
          // The size probe (gitDirSizeBytes) is a recursive stat-walk, so once we've
          // already warned about a space we SKIP the probe entirely — otherwise the
          // 120s poll would re-walk the whole git dir on every idle sync forever.
          if (!this.warnedLargeSpaces.has(space.id)) {
            const size = (await this.transport.gitDirSizeBytes?.(space)) ?? 0;
            if (size > this.sizeWarnBytes) {
              this.warnedLargeSpaces.add(space.id);
              const mib = Math.round(size / (1024 * 1024));
              this.onEvent({ type: 'notice', spaceId: space.id, message: `Sync history for ${space.id} is large (${mib} MiB). Sync still works normally.` });
            }
          }
          // After the sync, not before: a new folder is picked up by this
          // sync regardless, and refreshing here keeps git's ignore walk off
          // the path between a change and its upload.
          if (st.ignoredDirty) await this.refreshIgnoredDirs(st);
        } catch { /* maintenance is best-effort; the sync itself already succeeded */ }
      } catch (e: any) {
        const errorCode = typeof e?.syncErrorCode === 'string' ? e.syncErrorCode : undefined;
        // Crash-corrupted repo: repair automatically (approved policy — the
        // heal never touches user files and, if it has to start the repo
        // fresh, keeps the broken one aside as a backup), notify after, and
        // rerun THIS space's sync so the panel goes green on real evidence.
        // Guarded to once per space per launch: healedSpaces is marked BEFORE
        // the repair call (not just on success), so a repair that throws or
        // hangs still consumes the launch's one attempt — a second corruption
        // in the same run means something deeper than crash damage, and
        // re-attempting at poll cadence would thrash a repair/fail loop
        // instead of surfacing it.
        if (errorCode === REPO_CORRUPT_ERROR_CODE && this.transport.repair && !this.healedSpaces.has(space.id)) {
          this.healedSpaces.add(space.id);
          try {
            await this.transport.repair(space);
            this.onEvent({ type: 'notice', spaceId: space.id, message: 'Sync repaired itself after a crash. Your files were untouched.' });
            st.rerun = true; // the finally block fires the healed sync
          } catch (re: any) {
            // Repair itself failed (e.g. Tier 2 with no network/auth). Cause
            // genuinely unknown → surface the real detail, no guessed cause.
            this.onEvent({ type: 'error', spaceId: space.id, message: `Sync self-repair failed: ${String(re?.message ?? re)}`, errorCode: REPO_REPAIR_FAILED_ERROR_CODE });
          }
        } else {
          // Forward the typed marker (e.g. 'github-auth' from the transport /
          // provisioning) so the panel can offer the matching CTA — the message
          // alone is prose and must never be string-matched.
          this.onEvent({ type: 'error', spaceId: space.id, message: String(e?.message ?? e), errorCode });
        }
      } finally {
        st.syncing = false;
        st.current = null;
        if (st.rerun) { st.rerun = false; void this.syncSpace(space); }
      }
    })();
    await st.current;
  }

  /** Ids of the spaces this engine currently watches. Used by the service's
   *  reconcile to decide which stopped projects have a live space to detach. */
  liveSpaceIds(): string[] {
    return [...this.states.keys()];
  }

  /** True while any space's sync chain is in flight — feeds the self row's
   *  live "Syncing…" band (the legacy .sync-lock stat never fires for spaces). */
  anySyncing(): boolean {
    return [...this.states.values()].some(s => s.syncing);
  }

  /** Detach ONE space (Stop-syncing) without touching the folder or the others.
   *  Delete from the map FIRST so a finishing sync's queued rerun early-returns
   *  in syncSpace (same ordering as stop()); then close the watcher and await any
   *  in-flight sync (its git subprocesses hold handles in the space root — on
   *  Windows that blocks folder use until they exit). */
  async removeSpace(id: string): Promise<void> {
    const st = this.states.get(id);
    if (!st) return;
    this.states.delete(id);
    if (st.debounce) clearTimeout(st.debounce);
    await st.watcher?.close();
    if (st.current) await st.current.catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopped = true; // latch: a concurrent addSpace bails after its ready await (review #3)
    if (this.pollTimer) clearInterval(this.pollTimer);
    // Snapshot then clear FIRST: a finishing sync's queued rerun re-enters
    // syncSpace, which early-returns once the state map is empty — otherwise
    // stop() could leave a fresh git chain running after it resolves.
    const states = [...this.states.values()];
    this.states.clear();
    for (const st of states) {
      if (st.debounce) clearTimeout(st.debounce);
      await st.watcher?.close();
      // Await the in-flight sync: its git subprocesses hold handles inside the
      // space root, which blocks folder removal on Windows (app quit, tests).
      if (st.current) await st.current.catch(() => {});
    }
  }
}
