/**
 * chatsearch — module singleton + lifecycle, matching tag-registry-service.ts's
 * shape (module-level state, start/stop free functions, no class).
 *
 * Refresh triggers: app start, session quiesce, and any in-app metadata change.
 * The last one is load-bearing — without it a tag applied in the app UI would be
 * invisible to the CLI until the next launch.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConversationRecord } from '../conversations/store-core';
import {
  containedTranscriptPath,
  getConversationStore,
  onConversationMetaChanged,
} from '../conversations/service';
import { getTagRegistry } from '../conversations/tag-registry-service';
import { NativeHome } from '../native-home';
import { nativeStoreSlug, ccProjectSlug } from '../slug-encoding';
import { laneMatches } from '../conversations/lane-guards';
import { buildMetaFile } from './meta-builder';
import { perfMark } from '../perf-marks';
import {
  acquireBuildLock, atomicWriteFileSync, chatsearchDir, metaPath, refreshTurns,
} from './index-store';

/** Coalesce bursts of metadata changes into one refresh. */
const META_DEBOUNCE_MS = 3_000;

let started = false;
let debounceTimer: NodeJS.Timeout | null = null;
let unsubscribeMeta: (() => void) | null = null;
let inFlight = false;
// Set when a trigger arrives while a cycle is already running — see the WHY
// comment at its check in refreshFromLiveState below.
let pendingRerun = false;

export interface LaneInput {
  provider: string;
  lane: 'claude' | 'native';
  records: ConversationRecord[];
  resolveTranscriptPath: (rec: ConversationRecord) => string;
}

export interface RefreshInput {
  homeRoot: string;
  lanes: LaneInput[];
  tagLabels: Map<string, string>;
  storeRoot: string;
}

// lstatSync, never existsSync/statSync: matches the rest of this subsystem's
// never-follow-a-symlink posture (see index-store.ts's acquireBuildLock and
// transcriptSkipReason, and the identical check buildMetaFile is handed
// below). Shared here so the resolver below and the tombstone check downstream
// agree on what "exists" means.
function fileExistsOnDisk(p: string): boolean {
  try { return fs.lstatSync(p).size >= 0; } catch { return false; }
}

/**
 * Two-step transcript path resolution (2026-08 fix — see the chatsearch-paths
 * investigation). Both lanes used to resolve ONLY a device-local path derived
 * from the record's originalPath. That fails for (a) records with an empty
 * originalPath and (b) records synced from another device, whose originalPath
 * is that machine's path and whose slug directory never exists here — on real
 * data this mis-tombstoned 91% of the claude lane, reporting conversations as
 * deleted when 400/400 sampled ones were actually present in the synced space.
 *
 * WHY local wins when both exist: the local file is the live, still-growing
 * copy of an in-progress session; the space mirror only catches up on the
 * next sync. Preferring it keeps freshly-typed messages searchable without
 * waiting on a sync cycle.
 *
 * WHY containedTranscriptPath and not a hand-rolled join: transcriptRef is
 * record data — reachable from synced peers and, for records touched over
 * remote access, the WS surface too. containedTranscriptPath refuses absolute
 * paths and anything resolving outside the store root, so a crafted or
 * malformed ref (e.g. one containing `../`) can never escape it.
 *
 * WHY the originalPath check (not just localPath existence): an empty
 * originalPath still joins into SOME path (e.g. via an empty-input slug); an
 * accidental disk collision there should never be treated as "the live
 * local copy" the way a real originalPath match would be.
 *
 * If neither candidate exists, this returns whichever one is real (the space
 * path when the ref resolved inside the root, else the local guess) — never
 * a path chosen just to make the record look present. The caller's own
 * transcriptExists check re-verifies whatever path comes back, so a
 * genuinely-deleted transcript still tombstones correctly.
 */
export function resolveTranscriptPathTwoStep(
  rec: ConversationRecord,
  localPath: string,
  storeRoot: string,
): string {
  if (rec.originalPath && fileExistsOnDisk(localPath)) return localPath;
  const spacePath = containedTranscriptPath(storeRoot, rec.transcriptRef);
  if (spacePath && fileExistsOnDisk(spacePath)) return spacePath;
  return spacePath ?? localPath;
}

/** True when `metaFile` exists, parses, and already has at least one conversation. */
function hasNonEmptyMeta(metaFile: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { conversations?: Record<string, unknown> };
    return !!parsed?.conversations && Object.keys(parsed.conversations).length > 0;
  } catch {
    return false; // no file yet, or unreadable — nothing to protect
  }
}

/**
 * One full refresh cycle. Returns false when another instance holds the build
 * lock (this cycle is skipped; the next tick catches up).
 *
 * WHY one lock for the whole cycle: acquireBuildLock is keyed on the
 * chatsearch DIRECTORY, not per-provider — a second acquire inside this same
 * call would either deadlock against itself (mkdir-based lock, not
 * reentrant) or, if implemented reentrant, defeat the point of serializing
 * concurrent builders. So the lock wraps BOTH lanes in the loop below.
 */
export async function refreshChatsearchIndex(input: RefreshInput): Promise<boolean> {
  const dir = chatsearchDir(input.homeRoot);
  const release = await acquireBuildLock(dir);
  if (!release) return false;

  // WHY try/finally: a throw partway through one lane (e.g. a bad transcript
  // path) must still release the lock, or every future refresh — including
  // ones triggered from a different process — is skipped forever.
  try {
    for (const lane of input.lanes) {
      // WHY laneMatches here too: meta-builder.ts applies the SAME filter when
      // building the metadata rows. A record whose transcriptRef belongs to a
      // different lane must be excluded from BOTH passes — otherwise the turns
      // pass would write lines for a conversation that never gets a metadata
      // row to join against (an orphaned entry the CLI can find turns for but
      // never list, tag, or resolve a title for).
      const conversations = lane.records
        .filter((r) => !!r.transcriptRef && laneMatches(lane.provider, r.transcriptRef))
        .map((r) => ({ id: r.id, transcriptPath: lane.resolveTranscriptPath(r) }));

      const stats = await refreshTurns({
        dir, provider: lane.provider, lane: lane.lane, conversations,
      });

      const meta = buildMetaFile({
        provider: lane.provider,
        records: lane.records,
        refreshedAt: new Date().toISOString(),
        tagLabels: input.tagLabels,
        stats,
        resolveTranscriptPath: lane.resolveTranscriptPath,
        transcriptExists: fileExistsOnDisk,
        storeRoot: input.storeRoot,
      });

      // WHY guard a zero-conversation result: store.list() is fail-soft all the
      // way down (conversation-store.ts returns [] on any read failure, with no
      // error signal) — so a transiently unreadable sync space (unmounted
      // drive, mid-restore, EACCES) looks IDENTICAL to "the user really has zero
      // conversations." Writing that result unconditionally would overwrite a
      // good metadata file with an empty one and stamp a fresh refreshedAt, so
      // the CLI's staleness banner would not fire and it would report "nothing
      // is indexed yet" — indistinguishable from an actually-empty index. A
      // stale index is recoverable (the next successful refresh repairs it); a
      // wiped one looks like data loss. So: only skip the write when there IS a
      // pre-existing non-empty file to protect — a first-ever build (no file
      // yet) still writes its empty result normally.
      const target = metaPath(dir, lane.provider);
      if (Object.keys(meta.conversations).length === 0 && hasNonEmptyMeta(target)) {
        continue;
      }
      atomicWriteFileSync(target, JSON.stringify(meta, null, 2));
    }
    return true;
  } finally {
    release();
  }
}

/** Gather live inputs from the store + tag registry and run one cycle. */
async function refreshFromLiveState(): Promise<void> {
  if (inFlight) {
    // WHY remember instead of dropping: the 3s debounce only coalesces BURSTS
    // of triggers before it fires. Once fired, a cycle can legitimately run
    // longer than 3s (a large history, a slow disk) — a trigger that lands
    // during that window used to just no-op here, so a tag/note applied mid-
    // cycle stayed invisible to the CLI until the next session-end or
    // app-launch refresh, all while refreshedAt kept reporting the index as
    // current. Recording it and running one more cycle once this one finishes
    // (see the finally block below) closes that gap without a second
    // concurrent cycle racing the same build lock.
    pendingRerun = true;
    return;
  }
  const store = getConversationStore();
  if (!store) return; // store unavailable this launch — nothing to index

  inFlight = true;
  // WHY: the index build walks every conversation; the startup perf marks
  // need to see whether it overlaps the Resume scan and the slug repair.
  perfMark('bg:chatsearch-refresh:start');
  try {
    const tagLabels = new Map<string, string>();
    try {
      const reg = getTagRegistry();
      // Null registry (managed roots unavailable) degrades to unlabeled tags,
      // never to a crash — same posture as the tags:list IPC handler.
      for (const t of (await reg?.list()) ?? []) tagLabels.set(t.id, t.label);
    } catch { /* unlabeled is acceptable; an empty index is not */ }

    const home = new NativeHome();
    const homeRoot = os.homedir();
    // WHY read here: the synced-space backstop (resolveTranscriptPathTwoStep)
    // needs the store root to resolve transcriptRef against — the SAME root
    // every record's transcriptRef is relative to, regardless of which device
    // wrote the record.
    const storeRoot = store.root();

    const [claudeRecords, nativeRecords] = await Promise.all([
      store.list('claude').catch(() => [] as ConversationRecord[]),
      store.list('native').catch(() => [] as ConversationRecord[]),
    ]);

    await refreshChatsearchIndex({
      homeRoot,
      tagLabels,
      storeRoot,
      lanes: [
        {
          provider: 'claude',
          lane: 'claude',
          records: claudeRecords,
          resolveTranscriptPath: (r) => resolveTranscriptPathTwoStep(
            r,
            path.join(homeRoot, '.claude', 'projects', ccProjectSlug(r.originalPath), `${r.id}.jsonl`),
            storeRoot,
          ),
        },
        {
          provider: 'native',
          lane: 'native',
          records: nativeRecords,
          // RAW frozen app-private slug, not ccProjectSlug — the two encodings
          // diverge deliberately (ccProjectSlug uppercases a lowercase Windows
          // drive letter).
          resolveTranscriptPath: (r) => resolveTranscriptPathTwoStep(
            r,
            path.join(home.root, 'sessions', nativeStoreSlug(r.originalPath), `${r.id}.jsonl`),
            storeRoot,
          ),
        },
      ],
    });
  } catch {
    // A failed refresh leaves the previous index in place. The next trigger
    // retries; a stale index is surfaced by the CLI's own age banner.
  } finally {
    perfMark('bg:chatsearch-refresh:done');
    inFlight = false;
    if (pendingRerun) {
      pendingRerun = false;
      void refreshFromLiveState();
    }
  }
}

/** Public trigger — safe to call from anywhere in main. Never throws. */
export function requestChatsearchRefresh(): void {
  if (!started) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { void refreshFromLiveState(); }, META_DEBOUNCE_MS);
  debounceTimer.unref?.();
}

export function startChatsearchIndex(): void {
  stopChatsearchIndex();
  started = true;
  unsubscribeMeta = onConversationMetaChanged(() => { requestChatsearchRefresh(); });
  // Startup scan is the load-bearing one: Claude Code sessions happen whether or
  // not the app is running, so the index is usually behind at launch.
  void refreshFromLiveState();
}

export function stopChatsearchIndex(): void {
  started = false;
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  unsubscribeMeta?.();
  unsubscribeMeta = null;
}
