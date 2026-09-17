// desktop/src/renderer/components/sync-dot-state.ts
// Pure derivation of per-project sync state from syncSpaces.status() data.
// Renderer-safe (no fs/path — this file also ships to the Android WebView).
// The three dot states and their exact wording are pinned by the 2026-07-09
// project-sync-management-ux spec; the picker shows the dot, the tooltip and
// the Project View hero show these words.

export interface SyncStatusData {
  enabled: boolean;
  // `displayName`/`state` are the read-time overlay from the cross-device project
  // registry (2026-07-12): a stopped project reads as detached, not errored.
  // `kind`/`remote`/`lastSyncAt` feed deriveSyncBoxState below — remote is the
  // provisioned clone URL (null = repo never created for this device) and
  // lastSyncAt is the persisted ms epoch of the last COMPLETED real sync
  // (null = this device has never synced that space). Optional so older
  // payloads (remote shim to an older host) still typecheck.
  spaces: Array<{
    id: string; root: string; displayName?: string;
    // Read-time overlay same as displayName (2026-08-05 project-description):
    // null/absent means "no description set", not "unknown" — callers should
    // NOT treat missing description as a reason to fall back to a stale cast.
    description?: string | null; state?: 'active' | 'stopped';
    kind?: 'project' | 'personal'; remote?: string | null; lastSyncAt?: number | null;
  }>;
  // Engine events since app boot (last 50). `at` is stamped at broadcast time
  // (ms epoch); older payloads may lack it. `errorCode` is the stable
  // machine-readable marker on 'error' events ('github-auth' → the panel
  // shows a Connect/Reconnect GitHub CTA instead of only "Try again");
  // matching on it, never on the prose message, is the contract.
  // `contacted` (2026-09-16) rides 'synced' events: false is an offline cycle
  // that completed without reaching GitHub, which must not read as "synced".
  recentEvents: Array<{ type: string; spaceId: string; at?: number; message?: string; errorCode?: string; contacted?: boolean }>;
  // Files currently over the sync size limit, per space (paths relative to the
  // space root). Optional: older hosts don't send it.
  oversize?: Array<{ spaceId: string; files: string[] }>;
  /** The limit those files exceed, in MB, as the sync layer enforces it. */
  oversizeLimitMb?: number;
}

export interface SyncDot { color: 'green' | 'red' | 'gray'; label: string }

// Windows-tolerant normalize: forward slashes, no trailing slash, lowercased.
// (canonicalize() lives in shared/artifacts but drags in more than we need
// here; root-vs-root equality only needs slash/case folding.)
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function findSpaceFor(folderPath: string, status: SyncStatusData | null): SyncStatusData['spaces'][number] | null {
  if (!status) return null;
  return status.spaces.find((s) => norm(s.root) === norm(folderPath)) ?? null;
}

function latestEventFor(spaceId: string, status: SyncStatusData) {
  for (let i = status.recentEvents.length - 1; i >= 0; i--) {
    const e = status.recentEvents[i];
    // Skip 'notice' events (e.g. the large-history warning): they carry a REAL
    // space id but are informational, NOT a sync-status signal. If we returned
    // one it would mask the green 'synced' state (a notice fires right after a
    // healthy sync) and — were the dot logic to ever treat non-'synced' as
    // bad — falsely paint the dot red. Mirrors how the 'hub'/'projects'
    // sentinels are excluded, but keyed on type since a notice has a real id.
    if (e.spaceId === spaceId && e.type !== 'notice') return e;
  }
  return null;
}

export function syncDotFor(folderPath: string, status: SyncStatusData | null): SyncDot | null {
  if (!status) return null; // status() rejected (e.g. Android) — render no dot at all
  const space = findSpaceFor(folderPath, status);
  if (!space) return { color: 'gray', label: 'Only on this computer' };
  // A stopped project is detached on every device (permanent tombstone) — it
  // reads as "not syncing", never as an error, regardless of the global toggle.
  if (space.state === 'stopped') return { color: 'gray', label: 'Sync stopped' };
  if (!status.enabled) return { color: 'gray', label: 'Sync is turned off — will sync once you turn on Sync in Settings' };
  const last = latestEventFor(space.id, status);
  if (last?.type === 'error') return { color: 'red', label: "Sync isn't working — open Manage projects" };
  return { color: 'green', label: 'Syncs across your devices' };
}

/**
 * The latest 'error' event that a later successful 'synced' for the SAME space
 * hasn't already superseded — i.e. "sync is broken right now", not "sync
 * hiccuped once an hour ago". Returns null once every error has been followed
 * by a success.
 *
 * WHY: `recentEvents` is an append-only last-50 buffer that nothing ever
 * clears, so a naive "newest error wins" scan pins a one-off transient failure
 * on screen (red "Couldn't sync") for ~50 events — roughly 100 minutes on the
 * idle poll — while syncs succeed every 2 minutes behind it. A genuinely broken
 * sync re-emits an error every cycle, so it stays surfaced.
 *
 * Ordering + per-space scoping mirror `latestEventFor()` above (which the
 * project dots already use): another space's success must NEVER clear this
 * space's error. Sentinel events ('hub-status'/'projects-changed') are excluded
 * for free — they're neither 'error' nor 'synced'. A 'notice' is informational,
 * not a success, so it can't clear an error either.
 */
export function latestUnresolvedError(
  status: SyncStatusData | null,
): SyncStatusData['recentEvents'][number] | null {
  if (!status) return null;
  const events = status.recentEvents;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'error') continue;
    let superseded = false;
    for (let j = i + 1; j < events.length; j++) {
      if (events[j].type === 'synced' && events[j].spaceId === e.spaceId) { superseded = true; break; }
    }
    if (!superseded) return e;
  }
  return null;
}

/** The Sync box header states, in ladder order. 'hydrating' is the first-sync
 *  download phase; 'setup' covers both the enable() round-trip and repo
 *  provisioning (they read the same to a user: "creating your repositories"). */
export type SyncBoxState = 'setup' | 'off' | 'waiting-github' | 'error' | 'hydrating' | 'syncing' | 'synced';

/**
 * Pure derivation of the Sync box header state (2026-07-22 honest-state-machine
 * fix). The old inline ladder's bare `else → 'synced'` asserted only "enabled,
 * no error right now, nothing in flight" — a device that had NEVER pushed or
 * pulled landed on green "All synced" (the beta.8 macOS VM bug). Green is now
 * EVIDENCE-GATED on two facts the status payload already carries:
 *
 *  - every active space has a provisioned remote (`remote` non-null); else the
 *    device is still setting up (or the persistent not-provisioned error event
 *    routes to 'error' above this check), and
 *  - the Personal space has completed at least one real sync (`lastSyncAt`
 *    non-null, persisted across restarts). Scoped to Personal deliberately:
 *    it is the first-sync long pole (all conversations), while a just-created
 *    empty project deliberately doesn't sync until its first file change —
 *    gating on ALL spaces would flash 'hydrating' for up to 2 minutes after
 *    every "New project".
 */
export function deriveSyncBoxState(i: {
  /** An enable(true) call is in flight and status doesn't show enabled yet. */
  pendingEnable: boolean;
  enabled: boolean;
  /** An unresolved error exists (enable rejection or unresolved engine error). */
  hasError: boolean;
  /** GitHub reads as not-installed or not-authed (github:status). */
  githubUnauthed: boolean;
  spaces: SyncStatusData['spaces'];
  /** A user-triggered "Sync now" is in flight. */
  syncing: boolean;
}): SyncBoxState {
  if (!i.enabled) {
    if (i.pendingEnable) return 'setup';
    return i.hasError && i.githubUnauthed ? 'waiting-github' : 'off';
  }
  // A retry the user just pressed outranks the error it is retrying: the old
  // error stays unresolved until a sync succeeds, so letting it win showed
  // "Couldn't sync" throughout the retry and "Try again" looked dead
  // (2026-09-16). If the retry fails, its fresh error returns the box to red.
  if (i.hasError && !i.syncing) return 'error';
  const active = i.spaces.filter((s) => s.state !== 'stopped');
  // No spaces yet = the enable round-trip hasn't populated status — still setup.
  if (active.length === 0 || !active.every((s) => !!s.remote)) return 'setup';
  const personal = active.find((s) => s.kind === 'personal');
  if (personal && personal.lastSyncAt == null) return 'hydrating';
  if (i.syncing) return 'syncing';
  return 'synced';
}

/** "just now" / "N minutes ago" / "N hours ago" / null when unknown.
 *  `now` is injectable for tests. */
export function lastSyncedLabel(spaceId: string, status: SyncStatusData | null, now: number = Date.now()): string | null {
  if (!status) return null;
  let latest: number | null = null;
  for (const e of status.recentEvents) {
    // An offline cycle still emits 'synced' (the engine's state machine needs
    // the cycle end) but never reached GitHub; without this gate the Project
    // View hero read "just now" on a device offline for days (review, 2026-09-16).
    if (e.spaceId === spaceId && e.type === 'synced' && typeof e.at === 'number' && e.contacted !== false) {
      if (latest === null || e.at > latest) latest = e.at;
    }
  }
  if (latest === null) return null;
  const mins = Math.floor((now - latest) / 60_000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

/**
 * The Sync box's warning about files too big to sync, or null when there are
 * none: a one-line `header` (the collapsed card) and the `body` it opens to.
 * WHY it exists (2026-09-16): over-limit files used to be skipped with no word
 * anywhere, so a user's longest conversations quietly stopped reaching their
 * other devices. Transcripts live under `Conversations/`, so a list of only
 * those is worded as conversations. The limit comes from the host so the copy
 * can never disagree with the number the sync layer enforces.
 */
export function oversizeNotice(status: SyncStatusData | null): { header: string; body: string } | null {
  const files = (status?.oversize ?? []).flatMap((o) => o.files);
  const n = files.length;
  if (n === 0) return null;
  const allConversations = files.every((f) => f.replace(/\\/g, '/').startsWith('Conversations/'));
  const one = n === 1;
  const noun = allConversations ? (one ? 'conversation' : 'conversations') : (one ? 'file' : 'files');
  const limit = status?.oversizeLimitMb ? ` ${status.oversizeLimitMb} MB` : '';
  return {
    header: `${n} ${noun} too big to sync`,
    body: `${one ? 'It is' : 'They are'} over the${limit} sync size limit, so your other devices won't get new changes. `
      + `${one ? 'It stays' : 'They stay'} safe on this device.`,
  };
}
