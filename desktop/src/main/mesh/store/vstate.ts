// The in-memory state of one loaded version (split out of store.ts to keep it inside its line budget). Types only; never persisted: memory is dropped after any failed operation and re-read from disk.
import type { ChainSeeds, RuntimeKind } from './chain';
import type { ReplyState } from './classify';
import type { Boundary, CheckpointState } from './checkpoint';
import type { Marks } from './marks';
import type { SlotState } from './slotfile';
import type { HighWater } from './highwater';

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
  /** The chain state after the last evicted line (null when nothing is evicted); kept in every checkpoint statement (review 5, F4). */
  evB: Boundary | null;
  /** The first `lostRecs` index slots hold no real record (see checkpoint.ts); 0 normally. */
  lostRecs: number;
  /** The line that stops the conversation chain from being recomputed, or null (lives in the checkpoint; replaces stale-conv.json). */
  staleBad: number | null;
  chunks: number[];             // start offsets of body chunk files, ascending
  /** The last chunk file ends before the body end the index describes (a fault cut its tail): the next append checks the file's size once and starts a new chunk instead of writing past its end. */
  tailShort: boolean;
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
  /** The conversation chain of the evicted prefix was written by another classifier (N4); the bit lives in the checkpoint stamp. */
  staleConv: boolean;
  /** marks.bin as read (partial / damaged markers). */
  marks: SlotState<Marks>;
  /** The high-water record kept outside the chat folders (highwater.ts), the head count it last stated, and a head count it reported as rolled back from (null: none). */
  hw: HighWater;
  /** The head was found behind the high-water record (a whole folder put back): reported through damagedFromLine and head.rolledBack until the head passes `had`. Never persisted: it is re-derived at each open. */
  rolledBack: { from: number; had: number } | null;
  /** Parked append files: name -> size, kept in memory so a park never rescans the folder (M4). */
  /** The history identity (tails.ts readEpoch), read from disk at load and after a takeover begins: parks are sealed with it and applied only while it is unchanged. */
  epoch: string;
  /**
   * The history COUNT every checkpoint statement written from this state carries (round 7, F1). It is the count of the checkpoint that was LOADED, and moves to the folder's count only where the store has just
   * made the content current: after a takeover's cut, at a rebuild that passed its checks, and at registration. WHY not simply the folder's count: a load that catches an older checkpoint up to an older
   * index would otherwise restate OLD content under the CURRENT count, and that lie could never be told from a true statement again.
   */
  hist: number;
  /** How many takeovers tails/ shows evidence of (tails.ts takeoverIds); compared with the high-water record's count to see a lost tails/ (round 7, F3). */
  tailsShown: number;
  /** How many files rejected/ holds (round 7, F5): a cheap signal for head(), kept in memory so a caller need not poll a folder. */
  rejected: number;
  parked: Map<string, number>;
  parkedBytes: number;
}
