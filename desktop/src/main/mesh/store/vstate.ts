// The in-memory state of one loaded version (split out of store.ts to keep it inside its line budget). Types only; never persisted: memory is dropped after any failed operation and re-read from disk.
import type { ChainSeeds, RuntimeKind } from './chain';
import type { ReplyState } from './classify';
import type { CheckpointState } from './checkpoint';

export interface VState {
  key: string;
  dir: string;
  meta: { chatId: string; runtime: RuntimeKind; parent: string | null; createdMs: number };
  seeds: ChainSeeds;
  count: number;
  h: Buffer;
  c: Buffer;
  convCount: number;
  bodyEnd: number;
  rs: ReplyState;
  evictedLines: number;
  evictedBytes: number;
  chunks: number[];             // start offsets of body chunk files, ascending
  replyEndsCache: number[] | null;
  /** Line count when summary.json was last written; bounds how much open() has to catch up. */
  summarySavedAt: number;
  summary: { title: string | null; model: string | null; cwd: string | null; lastAppendMs: number | null; lines: number };
  /** First line whose body failed its chain check (not persisted: the scrub rediscovers it). */
  badLine: number | null;
  /** Rolling scrub high-water mark: lines [0, mark) were verified in this pass. */
  scrubMark: number;
  /** Head count when the current scrub pass began: the pass ends at this line however much the chat grew meanwhile (N3). */
  passEnd: number;
  /** The checkpoint file's newest statement and which slot the next write goes to (checkpoint.ts). */
  ck: CheckpointState;
  /** A copy-then-cut that could not be done yet (disk full, or torn/ at its cap): reads are served as if it were done, the next write retries it first and is refused if it still cannot (N5, review 3 F7). */
  deferred: { trimTo: number | null; indexTail: boolean; partial: { fromLine: number; lost: number } | null } | null;
  /** summary.json is older than the in-memory summary (arrival time): saved at close. */
  summaryDirty: boolean;
  /** The empty version's index file could not be created (disk full): the first append creates it (N5). */
  indexNeedsInit: boolean;
  /** A rebuild set lines [fromLine, fromLine+lost) aside because their bodies did not match the chain (N7). */
  partial: { fromLine: number; lost: number } | null;
  /** stale-conv.json exists (N4). */
  staleConv: boolean;
  /** Parked append files: name -> size, kept in memory so a park never rescans the folder (M4). */
  parked: Map<string, number>;
  parkedBytes: number;
}
