// The high-water record (review 5, F3): the one defence against a WHOLE chat folder being put back as it was an hour ago.
//
// WHY it lives OUTSIDE the chat folders: a restored folder is old but consistent, so nothing inside it can know it is old (a checksum cannot know a file is stale). A small record in
// <root>/highwater/<version>.hw says "this version once had at least M lines, and its chain value at a few earlier counts was these". On open, a head BEHIND M whose chain still
// matches the record's nearest earlier point is REPORTED ("rolled back from M to N") through the same channel as damaged lines (head.damagedFromLine / head.rolledBack), so a future
// replicator knows to refetch. The store never deletes or truncates anything because of it, and the record can only ever UNDER-report:
//   - it only rises (a lower head never lowers it), except where the store itself shortens a version on purpose (a tail set aside, a quarantine), which write the lower value;
//   - it is written AFTER the lines it states are durable (checkpoint first), so a power cut cannot leave it ahead of the disk;
//   - a stale, missing, damaged or foreign record is simply no evidence (two slots, enveloped like everything else, so another version's record is `foreign`, never believed).
// WHAT REMAINS UNDETECTABLE (inventory.ts says it too): the whole store root restored as one (this record goes back with it), and a rollback to a head the record never saw (it is written
// every HW_EVERY lines, at close, and at every eviction and restore, so up to HW_EVERY-1 lines of the newest growth can be rolled back without a report).
//
// COST of HW_EVERY = 256: one in-place 1 KiB write plus one fsync per 256 lines, i.e. about 0.004 fsync per appended line against the three an append already makes (body, index, checkpoint).
import * as nodePath from 'node:path';
import type { Fs } from './fsio';
import { mkdirDurable } from './fsio';
import { readSlots, writeSlot, type SlotState } from './slotfile';

export const HW_EVERY = 256;
const LADDER_MAX = 12;
const ROLE = 'highwater';

/** `ladder`: [line count, first 16 hex digits of the raw chain value there], ascending; the first entry is always count 0 (the seed). */
export interface HwValue { count: number; ladder: [number, string][]; evLines: number; evBytes: number }
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
export async function raiseHw(fs: Fs, root: string, key: string, hw: HighWater, count: number, h16: string, seed16: string, ev: { lines: number; bytes: number }): Promise<void> {
  const cur = hw.st.value;
  const base: HwValue = cur ?? { count: 0, ladder: [[0, seed16]], evLines: 0, evBytes: 0 };
  const next: HwValue = { count: Math.max(base.count, count), ladder: base.ladder.slice(), evLines: ev.lines, evBytes: ev.bytes };
  if (count > (next.ladder[next.ladder.length - 1]?.[0] ?? -1)) next.ladder.push([count, h16]);
  while (next.ladder.length > LADDER_MAX) next.ladder.splice(1, 1);   // keep the seed point and the newest
  await mkdirDurable(fs, nodePath.dirname(hwPath(root, key)));
  // DESTRUCTIVE-OK(verified-record): a high-water statement; slotfile.ts overwrites only the safe slot, and a lower or missing record can only under-report
  await writeSlot(fs, hwPath(root, key), ROLE, key, hw.st, next);
  hw.noted = count;
}

/** The store itself shortened this version on purpose (a set-aside tail, a quarantine): write the LOWER truth so it is not reported as a rollback. */
export async function lowerHw(fs: Fs, root: string, key: string, hw: HighWater, count: number, seed16: string, ladderAt: (n: number) => Promise<string | null>): Promise<void> {
  const cur = hw.st.value;
  const ladder: [number, string][] = [[0, seed16]];
  for (const [n, h] of cur?.ladder ?? []) if (n > 0 && n < count) ladder.push([n, h]);
  if (count > 0) { const h = await ladderAt(count); if (h) ladder.push([count, h]); }
  await mkdirDurable(fs, nodePath.dirname(hwPath(root, key)));
  // DESTRUCTIVE-OK(verified-record): the store shortened the version itself, so the old, higher statement is no longer true; slotfile.ts overwrites only the safe slot
  await writeSlot(fs, hwPath(root, key), ROLE, key, hw.st, { count, ladder, evLines: Math.min(cur?.evLines ?? 0, count), evBytes: cur && cur.evLines <= count ? cur.evBytes : 0 });
  hw.noted = count;
}

/**
 * Was this version rolled back? `chainAt(n)` gives the chain value the folder holds at n lines (n <= head). Reported only when the head is behind the record AND the record's nearest point at
 * or below the head matches the folder's own chain (the same history, just shorter): a head that merely differs is not called a rollback.
 */
export async function rolledBack(hw: HighWater, headCount: number, chainAt: (n: number) => Promise<string | null>): Promise<{ from: number; had: number } | null> {
  const v = hw.st.value;
  if (!v || v.count <= headCount) return null;
  let pick: [number, string] | null = null;
  for (const p of v.ladder) if (p[0] <= headCount) pick = p;
  if (!pick) return null;
  const mine = await chainAt(pick[0]);
  return mine !== null && mine.slice(0, 16) === pick[1] ? { from: headCount, had: v.count } : null;
}
