import { createHash } from 'node:crypto';
import type { TranscriptEvent } from '../../shared/types';
import type { PersistedEventReference } from './session-store';

/** Bind a summary's claimed cut to the exact committed transcript prefix.
 * This detects damaged/shifted records and source events after restart. It is
 * not an authentication signature against a person who can rewrite the entire
 * local JSONL and recompute its hash. No private text is copied into the record. */
export function compactionSourceDigest(events: readonly TranscriptEvent[], summary: string, record: {
  generation: number; sourceRevision: number;
  resumeFrom: PersistedEventReference; coveredThrough: PersistedEventReference;
}): string {
  return createHash('sha256').update(JSON.stringify({
    protocol: 'native-compaction-v1', summary,
    generation: record.generation, sourceRevision: record.sourceRevision,
    resumeFrom: record.resumeFrom, coveredThrough: record.coveredThrough,
    events,
  })).digest('hex');
}
