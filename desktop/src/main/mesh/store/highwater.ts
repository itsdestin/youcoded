// The high-water record (review 5, F3): the one defence against a WHOLE chat folder being put back as it was an hour ago.
//
// WHY it lives OUTSIDE the chat folders: a restored folder is old but consistent, so nothing inside it can know it is old (a checksum cannot know a file is stale). A small record in
// <root>/highwater/<version>.hw says "this version once had at least M lines, and its chain value at a few earlier counts was these". On open, a head BEHIND M whose chain still
// matches the record's nearest earlier point is REPORTED ("rolled back from M to N") through the same channel as damaged lines (head.damagedFromLine / head.rolledBack), so a future
// replicator knows to refetch. The store never deletes or truncates anything because of it, and the record can only ever UNDER-report:
//   - it only ever rises: a version never shortens (inventory.ts: a version folder is append-only in history), so there is no deliberate lowering any more;
//   - it is written AFTER the lines it states are durable (checkpoint first), so a power cut cannot leave it ahead of the disk;
//   - a stale, missing, damaged or foreign record is simply no evidence (two slots, enveloped like everything else, so another version's record is `foreign`, never believed).
// WHAT REMAINS UNDETECTABLE (inventory.ts says it too): the whole store root restored as one (this record goes back with it), and a rollback to a head the record never saw (it is written
// at the end of every acknowledged append call, at close, and at every eviction and restore, so only the call that was in flight can be rolled back without a report).
//
// COST of HW_EVERY = 1: one in-place 1 KiB write plus one fsync per append call, on top of the three an append already makes (body, index, checkpoint): about +0.6 ms per call measured (see HW_EVERY).
import * as nodePath from 'node:path';
import type { Fs } from './fsio';
import { mkdirDurable } from './fsio';
import { readSlots, writeSlot, type SlotState } from './slotfile';
import { isDiskFull } from './storeutil';
import { StoreError } from './errors';
import { hex } from './chain';
import type { VState } from './vstate';
import { Damaged } from './recovery';

/** WHY 1 (review 9, item 4): the record is raised at the END of every acknowledged append call, once the lines are durable. Measured on this machine's btrfs/NVMe (300 calls, 1 and 10 lines per call): about 1.7 ms per call with the record raised every 256 lines, about 2.5 ms raised every call, i.e. about +0.6 ms (+30%) for one more small fsync. So the window of a rollback nothing reports is now only the call that was in flight when the folder was put back. */
export const HW_EVERY = 1;
const LADDER_MAX = 12;
const ROLE = 'highwater';

/** `ladder`: [line count, first 16 hex digits of the raw chain value there], ascending; the first entry is always count 0 (the seed). */
interface HwValue { count: number; ladder: [number, string][]; evLines: number; evBytes: number }
export interface HighWater { st: SlotState<HwValue>; /** the head count this process last wrote or read */ noted: number }

export const hwPath = (root: string, key: string): string => nodePath.join(root, 'highwater', `${key}.hw`);

export async function readHw(fs: Fs, root: string, key: string): Promise<HighWater> {
  const st = await readSlots<HwValue>(fs, hwPath(root, key), ROLE, key);
  const v = st.value;
  // a statement that contradicts itself is no evidence at all
  const ok = v && Number.isSafeInteger(v.count) && v.count >= 0 && Array.isArray(v.ladder) && v.ladder.every((p) => Array.isArray(p) && Number.isSafeInteger(p[0]) && /^[0-9a-f]{16}$/.test(p[1]) && p[0] <= v.count) && Number.isSafeInteger(v.evLines) && Number.isSafeInteger(v.evBytes);
  if (!ok) { st.value = null; if (st.kind === 'ok') st.kind = 'bad'; }
  return { st, noted: st.value ? st.value.count : 0 };
}

/** Raise the record to `count` (never lower it). `h16` is the first 16 hex digits of the chain value at `count`. */
async function raiseHw(fs: Fs, root: string, key: string, hw: HighWater, count: number, h16: string, seed16: string, ev: { lines: number; bytes: number }): Promise<void> {
  const cur = hw.st.value;
  const base: HwValue = cur ?? { count: 0, ladder: [[0, seed16]], evLines: 0, evBytes: 0 };
  const next: HwValue = { count: Math.max(base.count, count), ladder: base.ladder.slice(), evLines: ev.lines, evBytes: ev.bytes };
  if (count > (next.ladder[next.ladder.length - 1]?.[0] ?? -1)) next.ladder.push([count, h16]);
  // WHY not "drop the oldest" any more (the record is now raised at every call): that would keep only the last 12 points, and a head far behind the record would be compared with the seed alone. The point whose
  // neighbours are closest together is dropped instead, so the kept points stay spread over the whole history; the seed and the newest point are always kept.
  while (next.ladder.length > LADDER_MAX) {
    let best = 1;
    for (let i = 2; i < next.ladder.length - 1; i++) if (next.ladder[i + 1][0] - next.ladder[i - 1][0] < next.ladder[best + 1][0] - next.ladder[best - 1][0]) best = i;
    next.ladder.splice(best, 1);
  }
  await mkdirDurable(fs, nodePath.dirname(hwPath(root, key)));
  // DESTRUCTIVE-OK(verified-record): a high-water statement; slotfile.ts overwrites only the safe slot, and a lower or missing record can only under-report
  await writeSlot(fs, hwPath(root, key), ROLE, key, hw.st, next);
  hw.noted = count;
}

/**
 * Was this version rolled back? `chainAt(n)` gives the chain value the folder holds at n lines (n <= head). Reported only when the head is behind the record AND the record's nearest point at
 * or below the head matches the folder's own chain (the same history, just shorter): a head that merely differs is not called a rollback.
 */
async function rolledBack(hw: HighWater, headCount: number, chainAt: (n: number) => Promise<string | null>): Promise<{ from: number; had: number } | 'contradiction' | null> {
  const v = hw.st.value;
  if (!v || v.count <= headCount) return null;
  let pick: [number, string] | null = null;
  for (const p of v.ladder) if (p[0] <= headCount) pick = p;
  if (!pick) return null;
  const mine = await chainAt(pick[0]);
  if (mine === null) return null;
  // WHY a contradiction is its own answer (restructure, review 9): a version never changes history, so the folder holding another chain value than the record at the same line count is not "an older copy of this
  // version": it is lines that differ from acknowledged ones. It used to be "no claim" (a takeover could replace a history in place); now it is loud: the version is retired.
  return mine.slice(0, 16) === pick[1] ? { from: headCount, had: v.count } : 'contradiction';
}

// ---- what the store does with the record (ChatStore forwards to these) -------------------------------

/**
 * WHY (review 5): the high-water record is advisory, so a full disk or an unreadable file only means less evidence. Anything else (an injected crash in the tests, a real I/O failure) still
 * surfaces: a failing disk must not be swallowed, and the crash sweeps need every operation to be able to kill the run.
 */
function advisoryFailed(e: unknown): void {
  if (isDiskFull(e) || e instanceof StoreError || (e as { code?: string } | null)?.code === 'ENOENT') return;
  throw e;
}
export interface HwEnv { fs: Fs; root: string; /** the chain value (hex) after n lines of st's index, or null when the record is unreadable */ readRecordHash: (st: VState, n: number) => Promise<string | null> }

const chainAt = async (e: HwEnv, st: VState, n: number): Promise<string | null> => {
  if (n === 0) return hex(st.seeds.raw);
  if (n > st.count || (st.evictedLines > 0 && n < st.lostRecs)) return null;
  return e.readRecordHash(st, n);
};
/** Compare the head with the record; a head behind it with the same history is REPORTED, never repaired or cut (F3). */
export async function checkRollback(e: HwEnv, st: VState): Promise<void> {
  let r: Awaited<ReturnType<typeof rolledBack>> = null;
  try { r = await rolledBack(st.hw, st.count, (n) => chainAt(e, st, n)); } catch (err) { advisoryFailed(err); }   // the record can only under-report
  if (r === 'contradiction') throw new Damaged(`the lines this version holds at line ${st.count} are not the lines it acknowledged (the high-water record's chain value differs): refusing to serve them`);
  st.rolledBack = r;
}
/** Raise the record to the head (advisory). Never lowers it. */
export async function noteHw(e: HwEnv, st: VState, force = false): Promise<void> {
  if (!force && st.count - st.hw.noted < HW_EVERY) return;
  if (st.rolledBack && st.count < st.rolledBack.had) return;   // a rolled-back head must not lower the mark it was compared with
  try { const h = await chainAt(e, st, st.count); if (h) await raiseHw(e.fs, e.root, st.key, st.hw, st.count, h.slice(0, 16), hex(st.seeds.raw).slice(0, 16), { lines: st.evictedLines, bytes: st.evictedBytes }); } catch (err) { advisoryFailed(err); }
}
