// desktop/src/main/sync-spaces/space-manager.ts
// Sync enable/disable state + per-space GitHub remote provisioning.
// State lives at ~/.claude/toolkit-state/sync-spaces.json.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { getGithubClient, GITHUB_AUTH_ERROR_CODE, type GithubClient } from '../github-client';
import type { SyncSpace } from './types';

/** The one client method provisioning needs — injectable for tests. */
type RepoCreator = Pick<GithubClient, 'createPrivateRepo'>;

export function repoNameForSpace(space: SyncSpace): string {
  if (space.kind === 'personal') return 'youcoded-sync-personal';
  const raw = space.id.replace(/^project:/, '');
  const name = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  // Why the hash suffix: the repo name IS the sync identity. The slug alone is
  // neither unique ('My App' and 'My-App' both slug to 'my-app' — two different
  // projects would silently cross-sync into one repo) nor total (an all-symbol
  // or non-Latin name slugs to ''). Hashing the LOWERCASED id keeps the name
  // stable across devices (same folder name → same repo) while distinct
  // folder names always get distinct repos. Do not "simplify" this away.
  const short = createHash('sha1').update(raw.toLowerCase()).digest('hex').slice(0, 8);
  return `youcoded-sync-project-${name || 'x'}-${short}`;
}

/** Creates a private repo and returns its clone URL. Phase 2 (2026-07-22
 *  sync-setup overhaul): goes through the shared github-client REST path —
 *  no `gh` CLI required — using the app's stored token, or gh's own token on
 *  machines that have one (the client's acquisition order handles both).
 *  An ALREADY-EXISTING repo is success, not failure — the state file
 *  recording provisioned URLs is per-device, so the user's second device
 *  re-runs this for repos the first device already created; that recovery
 *  lives inside createPrivateRepo (422 → adopt). Errors are already
 *  plain-language + typed (syncErrorCode) — syncSpace surfaces them verbatim
 *  as the space's error event every cycle. */
export async function provisionGithubRemote(repoName: string, client: RepoCreator | null = getGithubClient()): Promise<string> {
  if (!client) {
    // main.ts registers the client before startSyncSpaces; reaching this means
    // a wiring regression, but the user still needs an actionable message.
    const e: any = new Error('Not connected to GitHub — connect your GitHub account in the Sync settings');
    e.syncErrorCode = GITHUB_AUTH_ERROR_CODE;
    throw e;
  }
  return client.createPrivateRepo(repoName);
}

interface SpaceManagerOpts {
  stateFile?: string; // injectable for tests
  provisionRemote?: (repoName: string) => Promise<string>;
}

interface SpacesState {
  enabled: boolean;
  remotes: Record<string, string>; // spaceId -> clone URL
  // spaceId -> ms epoch of the last COMPLETED pull+push against a real remote.
  // This is the "has this device ever actually synced?" evidence the panel's
  // green state is gated on — recentEvents is per-boot, so without a persisted
  // marker a restart would forget that a first sync ever happened. Absent key
  // = never synced. Written by service.broadcast on every real 'synced' event.
  lastSync?: Record<string, number>;
}

/** How long a cached copy of the state file may serve reads before a read
 *  also kicks a background re-read (see SpaceManager.maybeRefresh). */
const REFRESH_AFTER_MS = 5_000;

/** Changes not yet on disk, as "set these fields". A patch rather than a list
 *  of edits so it stays as small as the state itself however many syncs pile
 *  up behind a slow or failing write (a newer value for the same field simply
 *  replaces the older one), and so re-applying it on a retry is harmless. */
interface Patch {
  enabled?: boolean;
  remotes: Record<string, string>;
  lastSync: Record<string, number>;
}

function emptyPatch(): Patch { return { remotes: {}, lastSync: {} }; }

function isEmptyPatch(p: Patch): boolean {
  return p.enabled === undefined && !Object.keys(p.remotes).length && !Object.keys(p.lastSync).length;
}

/** `later` wins field by field. */
function mergePatch(earlier: Patch, later: Patch): Patch {
  return {
    enabled: later.enabled ?? earlier.enabled,
    remotes: { ...earlier.remotes, ...later.remotes },
    lastSync: { ...earlier.lastSync, ...later.lastSync },
  };
}

function applyPatch(s: SpacesState, p: Patch): SpacesState {
  const out: SpacesState = { ...s, remotes: { ...s.remotes, ...p.remotes } };
  if (p.enabled !== undefined) out.enabled = p.enabled;
  if (Object.keys(p.lastSync).length) out.lastSync = { ...s.lastSync, ...p.lastSync };
  return out;
}

function defaults(): SpacesState { return { enabled: false, remotes: {} }; }

// A corrupt state file deliberately degrades to defaults and self-heals:
// ensureRemote re-provisions, and the already-exists recovery in
// provisionGithubRemote finds the repos the lost state pointed at.
function parseState(raw: string): SpacesState {
  try { return { ...defaults(), ...JSON.parse(raw) }; } catch { return defaults(); }
}

// WHY (2026-09-24, main-blocking-calls B6): this file used to be read with
// readFileSync on EVERY isEnabled/lastSyncFor/remoteFor call, and rewritten
// (mkdirSync + writeFileSync + renameSync) on EVERY successful sync of EVERY
// space — Personal plus each project, every 15 s–2 min — all on the Electron
// main thread, which every window shares. Now:
//   - reads come from an in-memory copy (loaded once, synchronously, the first
//     time — at sync startup — and then refreshed in the background);
//   - writes are queued and written by ONE async writer per manager, which
//     re-reads the file, applies every queued change in order, and writes the
//     result with temp-file + rename. Changes that arrive while a write is in
//     flight go into the next write, so two syncs finishing close together
//     cost one or two writes, never overlap, and never drop either change.
// The public methods stay synchronous on purpose — their callers (service.ts)
// read and write without awaiting, and a read right after a write must see it.
export class SpaceManager {
  private stateFile: string;
  private provisionRemote: (repoName: string) => Promise<string>;
  /** The in-memory copy every read is served from; null until first use. */
  private cache: SpacesState | null = null;
  private loadedAt = 0;
  /** Changes applied to `cache` but not yet on disk. */
  private pending: Patch = emptyPatch();
  /** The running writer, if any — at most one per manager. */
  private flushing: Promise<void> | null = null;
  /** Why the last write failed; cleared by the next successful write. */
  private lastWriteError: unknown = null;
  /** Bumped on every change, so a background re-read that raced a change is
   *  dropped instead of overwriting it. */
  private generation = 0;
  private refreshing = false;

  constructor(opts: SpaceManagerOpts = {}) {
    this.stateFile = opts.stateFile ?? path.join(os.homedir(), '.claude', 'toolkit-state', 'sync-spaces.json');
    this.provisionRemote = opts.provisionRemote ?? provisionGithubRemote;
  }

  /** The very first read. Synchronous because service.ts asks isEnabled()
   *  straight after constructing the manager at sync startup, and must get the
   *  real answer; every later read is served from memory. */
  private loadInitial(): SpacesState {
    let raw: string;
    try { raw = fs.readFileSync(this.stateFile, 'utf8'); } catch { return defaults(); }
    return parseState(raw);
  }

  private state(): SpacesState {
    if (!this.cache) { this.cache = this.loadInitial(); this.loadedAt = Date.now(); }
    else this.maybeRefresh();
    return this.cache;
  }

  /** The dev instance and the built app share ~/.claude, so another process can
   *  change this file. Reads used to hit the disk every time and so saw that
   *  within a call; now a read older than REFRESH_AFTER_MS re-reads in the
   *  background, so the other process's change shows up within seconds. Every
   *  write also re-reads first, so no other process's change is overwritten. */
  private maybeRefresh(): void {
    if (this.refreshing || this.flushing || !isEmptyPatch(this.pending)) return;
    if (Date.now() - this.loadedAt < REFRESH_AFTER_MS) return;
    this.refreshing = true;
    const gen = this.generation;
    void this.readDisk().then((disk) => {
      // A change made meanwhile is newer than what we read — keep it.
      if (gen === this.generation && !this.flushing && isEmptyPatch(this.pending)) {
        this.cache = disk;
        this.loadedAt = Date.now();
      }
    }).finally(() => { this.refreshing = false; });
  }

  private async readDisk(): Promise<SpacesState> {
    let raw: string;
    try { raw = await fs.promises.readFile(this.stateFile, 'utf8'); } catch { return defaults(); }
    return parseState(raw);
  }

  private async writeDisk(s: SpacesState): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.stateFile), { recursive: true });
    // Temp-file + rename: the dev instance and the built app share ~/.claude,
    // and rename is atomic — a concurrent reader never sees a half-written file.
    // pid-suffixed temp name: two processes must not race the same .tmp. One
    // temp name per process is safe ONLY because runFlush never lets two writes
    // overlap — two at once would interleave into the same temp file.
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(s, null, 2));
    await fs.promises.rename(tmp, this.stateFile);
  }

  /** Apply a change now (reads see it at once) and queue it for disk. */
  private mutate(change: Partial<Patch>): void {
    const p: Patch = { ...emptyPatch(), ...change };
    this.cache = applyPatch(this.state(), p);
    this.generation++;
    this.pending = mergePatch(this.pending, p);
    if (!this.flushing) this.flushing = this.runFlush();
  }

  /** The single writer. Takes every queued change and applies it on top of a
   *  FRESH read of the file (so a field another process wrote survives — the
   *  same read-modify-write the sync version did), writes once, then loops for
   *  anything queued meanwhile. A failed write puts its changes back under any
   *  newer ones, still applied in memory, so the next change (or flush())
   *  retries them instead of losing them. */
  private async runFlush(): Promise<void> {
    try {
      while (!isEmptyPatch(this.pending)) {
        const batch = this.pending;
        this.pending = emptyPatch();
        try {
          const written = applyPatch(await this.readDisk(), batch);
          await this.writeDisk(written);
          this.lastWriteError = null;
          // The new in-memory copy = what is now on disk + anything queued
          // while we wrote (already in the old copy, re-applied here).
          this.cache = applyPatch(written, this.pending);
          this.loadedAt = Date.now();
        } catch (e) {
          this.pending = mergePatch(batch, this.pending);
          this.lastWriteError = e;
          return;
        }
      }
    } finally {
      this.flushing = null;
    }
  }

  /** Resolves once every change made so far is on disk; rejects with the write
   *  error if it could not be written. For shutdown, tests, and ensureRemote. */
  async flush(): Promise<void> {
    while (this.flushing || !isEmptyPatch(this.pending)) {
      if (!this.flushing) this.flushing = this.runFlush(); // retry after an earlier failure
      await this.flushing;
      if (!isEmptyPatch(this.pending) && this.lastWriteError) throw this.lastWriteError;
    }
  }

  isEnabled(): boolean { return this.state().enabled; }
  /** ms epoch of this space's last completed real sync on THIS device, or null
   *  if it has never synced. Survives restarts (unlike recentEvents). */
  lastSyncFor(spaceId: string): number | null { return this.state().lastSync?.[spaceId] ?? null; }
  recordSyncSuccess(spaceId: string, at: number): void {
    this.mutate({ lastSync: { [spaceId]: at } });
  }
  setEnabled(v: boolean): void { this.mutate({ enabled: v }); }
  remoteFor(spaceId: string): string | null { return this.state().remotes[spaceId] ?? null; }
  recordRemote(spaceId: string, url: string): void {
    this.mutate({ remotes: { [spaceId]: url } });
  }

  /** Idempotent: returns the recorded remote or provisions + records one. */
  async ensureRemote(space: SyncSpace): Promise<string> {
    const existing = this.remoteFor(space.id);
    if (existing) return existing;
    const url = await this.provisionRemote(repoNameForSpace(space));
    this.recordRemote(space.id, url);
    // WHY await: the old synchronous write threw straight out of here when the
    // file could not be written; waiting keeps that failure visible to the
    // caller (the sync cycle reports it) instead of it passing silently.
    await this.flush();
    return url;
  }
}
