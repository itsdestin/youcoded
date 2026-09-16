// desktop/src/main/sync-spaces/types.ts
// The sync-space model from spec §4/§5. The SyncTransport seam is the
// compatibility boundary for the future YouCoded Cloud transport (spec §16).

export type SpaceKind = 'project' | 'personal';

export interface SyncSpace {
  id: string;        // 'personal' | 'project:<name>'
  kind: SpaceKind;
  root: string;      // absolute path to the space's folder on this device
}

export interface PushResult {
  pushed: boolean;          // false when nothing changed or no remote configured
  // Did this push (or its recovery pull) actually reach the remote — a git
  // exit 0 against origin, not merely "the call returned"? Offline is silent
  // by design (spec §13), so without this a failed push and a successful
  // no-op push look identical to the engine, and "Last synced just now" kept
  // ticking on a device that had been offline for days (2026-07-30 review).
  // Optional: a transport that does not track it is read as contact (the
  // pre-2026-09-16 behaviour); the git transport always reports it.
  contacted?: boolean;
  commit?: string;          // HEAD sha after commit, when one was made
  oversize: string[];       // rel paths excluded for exceeding MAX_SYNC_FILE_BYTES
  // Present when a rejected push ran a RECOVERY pull (a peer pushed first).
  // That pull applies the peer's changes, so its outcome must ride the push
  // result — swallowing it left changes on disk with no synced/updated event,
  // so the conversation materialize sweep, project discovery, and conflict
  // notices never fired for them (2026-07-15 review finding).
  updated?: boolean;        // the recovery pull applied remote changes
  conflictCopies?: string[];// conflict copies the recovery pull wrote
}

export interface PullResult {
  updated: boolean;         // true when remote changes were applied
  conflictCopies: string[]; // rel paths of conflict copies written this pull
  // The fetch reached origin (exit 0). See PushResult.contacted for why.
  contacted?: boolean;
}

export interface SpaceVersion { commit: string; date: string; message: string; }

/** What one repair() run actually did — the post-hoc debugging trace for the
 *  two-tier corruption repair (PR #276 review: repair() used to discard the
 *  deleteZeroByteObjects count and leave no record of which tier ran, so a
 *  later "why did this space re-init?" had no evidence to read). Returned by
 *  repair() AND logged by the transport; callers may ignore it (the engine
 *  does — the interface stays Promise-compatible with a void-returning fake). */
export interface RepairOutcome {
  /** Which tier actually healed the repo: 1 = surgical in-place reset,
   *  2 = repo moved aside as a .broken-* backup and re-inited. */
  tier: 1 | 2;
  /** Zero-byte poison objects deleted by Tier 1's sweep (0 when Tier 1 was
   *  skipped entirely because the repo had no HEAD). */
  zeroByteObjectsDeleted: number;
  /** Tier 2 only: why Tier 1 couldn't heal (which check failed / was skipped). */
  tier1Failure?: string;
  /** Tier 2 only: absolute path the broken repo was preserved at, or absent
   *  when there was no repo dir to back up. */
  backupPath?: string;
}

/** Spec §5: push/pull/subscribe/history. subscribe() is Plan 1b (SyncHub) —
 *  1a polls instead, so the interface ships without it and 1b adds it. */
export interface SyncTransport {
  init(space: SyncSpace): Promise<void>;
  hasRemote(space: SyncSpace): Promise<boolean>;
  setRemote(space: SyncSpace, url: string): Promise<void>;
  push(space: SyncSpace, message: string): Promise<PushResult>;
  pull(space: SyncSpace): Promise<PullResult>;
  history(space: SyncSpace, limit?: number): Promise<SpaceVersion[]>;
  // Maintenance hooks (spec §7 "known limit"). OPTIONAL so a future non-git
  // transport (YouCoded Cloud) needn't implement local repack/sizing — the
  // engine calls them with `?.` and treats absence as a no-op.
  /** After every Nth successful sync, run a LOCAL `git gc` to repack the hidden
   *  history. Best-effort; never throws. Never rewrites history (no force-push /
   *  filter-branch), so it cannot desync peers — it only shrinks local disk. */
  maybeGc?(space: SyncSpace): Promise<void>;
  /** Recursive byte size of the hidden sync repo, for the large-history warning.
   *  Bounded + best-effort; returns 0 on error / missing repo. */
  gitDirSizeBytes?(space: SyncSpace): Promise<number>;
  /** Repair a corrupt hidden repo (crash-truncated objects, bad refs, corrupt
   *  index). Tier 1 deletes zero-byte loose objects and resets main to the
   *  local origin/main; Tier 2 moves the whole repo aside as a .broken-<date>
   *  backup and re-inits (the engine's normal provisioning + pull re-adopt the
   *  remote). NEVER touches the user's files — only <root>/.youcoded/.
   *  Optional like maybeGc — a non-git transport omits it. Resolves with a
   *  RepairOutcome trace (tier + counts); `| void` keeps existing fakes and
   *  future transports free to not bother. */
  repair?(space: SyncSpace): Promise<RepairOutcome | void>;
}

// `at` is stamped by service.broadcast() at emit time (ms epoch). Optional so
// replayed or older payloads without it still typecheck. The renderer derives
// "Last synced N minutes ago" (Project View hero) from it.
export type SpaceSyncEvent = (
  // `contacted`: the cycle reached GitHub (a fetch or push exited 0). false
  // is an offline cycle that completed silently — the engine still emits it,
  // but service.broadcast() does NOT stamp "last synced" from it. Optional so
  // replayed/older payloads and pure-function fixtures still typecheck; the
  // engine always sets it.
  | { type: 'synced'; spaceId: string; pushed: boolean; updated: boolean; contacted?: boolean }
  | { type: 'conflict'; spaceId: string; copies: string[] }
  | { type: 'oversize'; spaceId: string; files: string[] }
  // errorCode is a stable machine-readable marker (e.g. 'github-auth') copied
  // from the thrown error's `syncErrorCode` so the renderer can attach the
  // right CTA (Reconnect GitHub) without string-matching prose, which would
  // silently break on any copy edit. Optional + additive: older payloads and
  // uncoded errors simply omit it.
  | { type: 'error'; spaceId: string; message: string; errorCode?: string }
  // Informational notice — NOT an error. Used for the large-history warning
  // (spec §7). Carries a REAL space id (unlike the 'hub'/'projects' sentinels),
  // but MUST NOT drive the red "sync isn't working" dot: sync still works
  // normally. sync-dot-state.ts's latestEventFor skips it for that reason;
  // SyncPanel renders it in non-alarming (muted, not red) styling.
  | { type: 'notice'; spaceId: string; message: string }
  // SyncHub (Plan 1b) connection status. spaceId is the literal 'hub' (never a
  // real space id) so every consumer's per-space event scan / sync-dot
  // derivation ignores it naturally while keeping the field shape uniform.
  | { type: 'hub-status'; spaceId: 'hub'; status: 'connected' | 'disconnected' }
  // Cross-device discovery (2026-07-13): the set of managed projects on THIS
  // device changed — a project was materialized from another device or a stop
  // tombstone detached one. The renderer refetches its folder/project lists on
  // this so a newly-synced project appears in the picker + Project View WITHOUT
  // a manual reopen. spaceId is the SENTINEL 'projects' (NOT a real project id)
  // — exactly like 'hub-status' uses 'hub' — so `latestEventFor()` in
  // sync-dot-state never surfaces it for a real space and can't mask that
  // space's error/synced event. Consumers match on `type`, never spaceId.
  | { type: 'projects-changed'; spaceId: 'projects' }
) & { at?: number };
