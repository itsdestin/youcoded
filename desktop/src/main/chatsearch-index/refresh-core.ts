/** Complete index IO cycle. Production calls this only inside index-worker. */
import fs from 'node:fs';
import type { ConversationRecord } from '../conversations/store-core';
import { containedTranscriptPath } from '../conversations/transcript-path';
import { laneMatches } from '../conversations/lane-guards';
import { buildMetaFile } from './meta-builder';
import { acquireBuildLock, atomicWriteFileSync, chatsearchDir, metaPath, refreshTurns } from './index-store';

interface LaneInput {
  provider: string;
  lane: 'claude' | 'native';
  records: ConversationRecord[];
  resolveTranscriptPath: (rec: ConversationRecord) => string;
}
interface RefreshInput {
  homeRoot: string;
  lanes: LaneInput[];
  tagLabels: Map<string, string>;
  storeRoot: string;
}

// WHY lstat, never stat: agree with index-store's never-follow-symlinks gate.
function fileExistsOnDisk(p: string): boolean {
  try { return fs.lstatSync(p).size >= 0; } catch { return false; }
}

export function resolveTranscriptPathTwoStep(rec: ConversationRecord, localPath: string, storeRoot: string): string {
  // WHY local first: the active file grows before the synced mirror catches up.
  // Empty originalPath is not evidence that an accidental local collision is live.
  if (rec.originalPath && fileExistsOnDisk(localPath)) return localPath;
  const spacePath = containedTranscriptPath(storeRoot, rec.transcriptRef);
  if (spacePath && fileExistsOnDisk(spacePath)) return spacePath;
  return spacePath ?? localPath;
}

function hasNonEmptyMeta(metaFile: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { conversations?: Record<string, unknown> };
    return !!parsed?.conversations && Object.keys(parsed.conversations).length > 0;
  } catch { return false; }
}

export async function refreshChatsearchIndex(input: RefreshInput): Promise<boolean> {
  const dir = chatsearchDir(input.homeRoot);
  const release = await acquireBuildLock(dir);
  if (!release) return false;
  // WHY one lock around BOTH lanes: the lock is directory-wide, not reentrant.
  // A failed lane still releases; a terminated worker leaves stale-lock recovery
  // to the existing cross-process protocol, never to a main-thread cleanup race.
  try {
    for (const lane of input.lanes) {
      // WHY filter both passes identically: no orphan turns for mismatched refs.
      const conversations = lane.records
        .filter((r) => !!r.transcriptRef && laneMatches(lane.provider, r.transcriptRef))
        .map((r) => ({ id: r.id, transcriptPath: lane.resolveTranscriptPath(r) }));
      const stats = await refreshTurns({ dir, provider: lane.provider, lane: lane.lane, conversations });
      const meta = buildMetaFile({
        provider: lane.provider, records: lane.records, refreshedAt: new Date().toISOString(),
        tagLabels: input.tagLabels, stats, resolveTranscriptPath: lane.resolveTranscriptPath,
        transcriptExists: fileExistsOnDisk, storeRoot: input.storeRoot,
      });
      // WHY preserve nonempty metadata: fail-soft store.list() cannot distinguish
      // an empty store from an unreadable/unmounted sync space. Stale is repairable.
      const target = metaPath(dir, lane.provider);
      if (Object.keys(meta.conversations).length === 0 && hasNonEmptyMeta(target)) continue;
      atomicWriteFileSync(target, JSON.stringify(meta, null, 2));
    }
    return true;
  } finally { release(); }
}
