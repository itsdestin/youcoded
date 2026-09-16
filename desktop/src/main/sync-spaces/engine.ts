// desktop/src/main/sync-spaces/engine.ts
// Watch → debounce → sync (pull-then-push) per space, plus a poll loop that
// stands in for SyncHub signals until Plan 1b. Single-flight per space: a
// change arriving mid-sync queues exactly one follow-up sync.
import chokidar, { FSWatcher } from 'chokidar';
import type { SpaceSyncEvent, SyncSpace, SyncTransport } from './types';
import { REPO_CORRUPT_ERROR_CODE, REPO_REPAIR_FAILED_ERROR_CODE } from '../sync-error-classifier';

interface EngineOpts {
  debounceMs?: number;  // default 15s (spec §8)
  pollMs?: number;      // default 120s (spec §6 degradation path); 0 disables
  sizeWarnBytes?: number; // default 500MB; injectable so tests can use a low threshold
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

interface SpaceState {
  space: SyncSpace;
  watcher: FSWatcher;
  debounce: ReturnType<typeof setTimeout> | null;
  syncing: boolean;
  rerun: boolean;
  // The in-flight sync's promise, so stop() can await it. Without this, quit
  // teardown (and tests' temp-dir cleanup) races the git subprocesses a sync
  // spawns — on Windows their cwd/file handles block directory removal.
  current: Promise<void> | null;
}

// Coarse watcher-level filter only — intentionally narrower than the git layer's
// DEFAULT_IGNORES, which stays authoritative about what actually syncs. Each
// regex means: "this directory name appears anywhere in the path, with either
// slash style" (Windows \ or POSIX /).
// Lock dirs (`<file>.json.lock`) are the mkdir-based lock cas-write.ts takes
// around every conversation/registry write — created and removed within
// milliseconds. Watching them is pointless (always empty; git can't track an
// empty dir) and actively harmful: on Windows chokidar racing the lock's own
// rmdir throws `EPERM: operation not permitted, watch '…json.lock'`, which
// surfaced to the user as a red "Couldn't sync" on a sync that was working
// fine. Scoped to `.json.lock` — NOT bare `.lock` — so real lockfiles a user
// syncs (Cargo.lock, Gemfile.lock, poetry.lock) still trigger an instant sync.
const WATCH_IGNORED = [/(^|[\\/])\.youcoded([\\/]|$)/, /(^|[\\/])node_modules([\\/]|$)/, /(^|[\\/])\.git([\\/]|$)/, /\.json\.lock([\\/]|$)/];

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
  private onEvent: (e: SpaceSyncEvent) => void;

  constructor(private transport: SyncTransport, opts: EngineOpts) {
    this.debounceMs = opts.debounceMs ?? 15_000;
    this.pollMs = opts.pollMs ?? 120_000;
    this.sizeWarnBytes = opts.sizeWarnBytes ?? SIZE_WARN_BYTES;
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
    const watcher = chokidar.watch(space.root, {
      ignored: WATCH_IGNORED,
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
    // NOTE: 'ready' is NOT sufficient on macOS, which is why the reconcile
    // below exists. chokidar bottoms out in fs.watch, and fs.watch returns
    // before the OS-level watch is armed there — 'ready' can fire while changes
    // are still being dropped. See the reconcile comment after registration.
    await new Promise<void>(resolve => {
      watcher.once('ready', () => resolve());
      watcher.once('error', () => resolve());
    });
    // Torn down while we awaited 'ready' (disable landed mid-add): close this
    // watcher and DON'T register it — stop() already snapshotted the states map,
    // so a set() here would strand a live watcher forever (review #3).
    if (this.stopped) { await watcher.close(); return; }
    const st: SpaceState = { space, watcher, debounce: null, syncing: false, rerun: false, current: null };
    watcher.on('all', () => this.schedule(st));
    // A watcher that dies after startup (inotify exhaustion, permissions) must
    // surface as a sync error, not crash the app — an unhandled 'error' on a
    // Node EventEmitter throws. 'all' does NOT receive error events.
    watcher.on('error', (e: any) => this.onEvent({ type: 'error', spaceId: space.id, message: String(e?.message ?? e) }));
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
        this.onEvent({ type: 'synced', spaceId: space.id, pushed: push.pushed, updated: pull.updated || !!push.updated });
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
    await st.watcher.close();
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
      await st.watcher.close();
      // Await the in-flight sync: its git subprocesses hold handles inside the
      // space root, which blocks folder removal on Windows (app quit, tests).
      if (st.current) await st.current.catch(() => {});
    }
  }
}
