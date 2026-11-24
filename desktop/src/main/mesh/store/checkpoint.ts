// The checkpoint: a tiny, separately stored statement "the first `count` lines of this version have raw
// chain value `h` and conversation chain value `c`" (review N1).
//
// WHY a file of its own: an index rebuild re-derives every chain value from the body bytes. If the only
// thing it can compare against is the index that was just damaged, a rotted body byte is silently accepted
// and the head hash changes (N1). The checkpoint lives in a DIFFERENT file from the index and has its own CRC.
//
// WHY two slots written in place, and before EVERY acknowledgement (review 3, F3/F9): the old design rewrote the whole file
// atomically (two fsyncs and a rename) so it was done only every 32 lines, which left up to 31 acknowledged lines that
// nothing independent vouched for. Now each append, after its index records are durable and before it returns, overwrites
// the OLDER of two slots with a higher sequence number and fsyncs (one small in-place write, no new file, so it cannot
// run out of disk space). A torn write can only damage the slot being written; the other slot still holds the previous
// statement. So at any instant: every acknowledged line is at or below `count` of the newest valid slot, or (one slot
// damaged by a fault) at most one append behind it, which the index covers. Lowering (a cut or a split) writes BOTH slots.
//
// Slot layout (big-endian): magic 'YCMCKPT4' (8) | seq u64 | count u64 | stamp u32 | evLines u64 | evBytes u64 | lostRecs u64 | staleBad u64 | version tag 16 | h 32 | c 32 |
//   boundary: bh 32 | bc 32 | bConv u64 | bCandN u64 | bCandId 8 | bFlags u32 | crc32 u32 over all before it.
// This is the envelope (envelope.ts) in fixed-width binary form: the magic is the ROLE, the version tag is the VERSION, `seq` is the FRESHNESS counter, `count` is the POSITION it
// stands for. A slot that is not this version's checkpoint decodes as no evidence.
//
// Review 4 added two things, both for "a file that is valid but the WRONG one":
//  - the version tag: a checkpoint copied in from another version (or chat) decodes as NO evidence instead of being believed;
//  - the EVICTION STATE (evLines, evBytes), kept here and nowhere else as the authority. WHY: evicted.json was a separate file with no freshness, so an older
//    copy of it made the store delete bodies that had been restored, and a deleted body chunk looked like an eviction. The checkpoint is rewritten in place at
//    every acknowledgement and is the one record the store already trusts as current, so "which lines have no body on purpose" lives in it.
// Review 5 added (F4): the chain state AT THE EVICTION BOUNDARY (`boundary`: the raw and conversation chain values, the conversation count and the reply-end tracker after the
// last evicted line). WHY: after an eviction the chain values of the evicted lines lived only in index.bin, so one deleted index.bin made the kept lines unrecoverable. With the
// boundary here, the index of the KEPT lines can be re-derived from the bodies alone and confirmed against this statement's head. evicted.json is gone (nothing was ever
// decided from it). `lostRecs`: the first `lostRecs` index slots hold no real record (their chain values were lost with the index; slot lostRecs-1 is a stand-in that carries the
// boundary); 0 normally. `staleBad`: the line that stops the conversation chain from being recomputed (replaces stale-conv.json), or NONE.
import * as nodePath from 'node:path';
import { crc32, versionTag } from './chain';
import type { Fs } from './fsio';

const MAGIC = Buffer.from('YCMCKPT4', 'ascii');
export const CHECKPOINT_SLOT = 8 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 16 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 4 + 4;
const SLOT = CHECKPOINT_SLOT;
export const CHECKPOINT_FILE = 'checkpoint.bin';
const NONE64 = 0xffffffffffffffffn;

/** The chain state after the last evicted line (see above). `candN` -1 and `candId` null: no reply-end candidate. */
export interface Boundary { h: Buffer; c: Buffer; convCount: number; candN: number; candId: string | null }
/** `evLines`/`evBytes`: the evicted prefix (lines whose bodies were dropped on a proven eviction); 0/0 and `boundary` null when nothing is evicted. */
export interface Checkpoint {
  count: number; stamp: number; h: Buffer; c: Buffer; evLines: number; evBytes: number; boundary: Boundary | null; lostRecs: number; staleBad: number | null;
  /**
   * HISTORY COUNT (round 7, F1): how many history changes (takeovers begun + quarantines / set-asides, tails.ts histCount) the version had when this statement was written. It lives in the upper 24 bits of the
   * flags word (bits 8..31), which older slots wrote as zero, so no slot layout changed and an old slot simply reads as "written before any history change". WHY: the checkpoint and the index carry no
   * identity of the history they describe, so after a takeover an OLDER checkpoint and a newer one looked alike. A statement whose count is below the version's current count was written before a later
   * takeover (or quarantine); one equal to it was written in the current history; one above it means takeover evidence has been lost.
   */
  hist: number;
}
/** The identity every file of the version folder `dir` carries (the folder name is the version key). */
const tagOf = (dir: string): Buffer => versionTag(nodePath.basename(dir));
/** What a version remembers between appends: the newest statement's sequence number and the slot the NEXT write goes to. */
export interface CheckpointState { ck: Checkpoint | null; seq: number; next: 0 | 1; /** how many of the two slots hold a valid statement */ slotsOk: number }

function encodeSlot(k: Checkpoint, seq: number, tag: Buffer): Buffer {
  const b = Buffer.alloc(SLOT);
  MAGIC.copy(b, 0);
  b.writeBigUInt64BE(BigInt(seq), 8);
  b.writeBigUInt64BE(BigInt(k.count), 16);
  b.writeUInt32BE(k.stamp >>> 0, 24);
  b.writeBigUInt64BE(BigInt(k.evLines), 28); b.writeBigUInt64BE(BigInt(k.evBytes), 36);
  b.writeBigUInt64BE(BigInt(k.lostRecs), 44); b.writeBigUInt64BE(k.staleBad === null ? NONE64 : BigInt(k.staleBad), 52);
  tag.copy(b, 60, 0, 16);
  k.h.copy(b, 76); k.c.copy(b, 108);
  if (k.boundary) {
    const x = k.boundary;
    x.h.copy(b, 140); x.c.copy(b, 172); b.writeBigUInt64BE(BigInt(x.convCount), 204);
    b.writeBigUInt64BE(x.candN < 0 ? NONE64 : BigInt(x.candN), 212);
    if (x.candId) Buffer.from(x.candId, 'hex').copy(b, 220, 0, 8);
    b.writeUInt32BE((x.candN >= 0 && x.candId === null ? 2 : 0) | 1, 228);   // bit 0: a boundary is present; bit 1: a candidate with a null id
  }
  b.writeUInt32BE((b.readUInt32BE(228) | (Math.min(k.hist, 0xffffff) << 8)) >>> 0, 228);   // bits 8..31: the history count (see Checkpoint.hist)
  b.writeUInt32BE(crc32(b, 0, SLOT - 4), SLOT - 4);
  return b;
}

function decodeSlot(b: Buffer, at: number, tag: Buffer): { seq: number; ck: Checkpoint } | null {
  if (b.length < at + SLOT) return null;
  const s = b.subarray(at, at + SLOT);
  if (!s.subarray(0, 8).equals(MAGIC) || crc32(s, 0, SLOT - 4) !== s.readUInt32BE(SLOT - 4)) return null;
  // a slot that belongs to another version is not evidence about this one (valid checksum, wrong identity)
  if (!s.subarray(60, 76).equals(tag)) return null;
  const seq = Number(s.readBigUInt64BE(8)); const count = Number(s.readBigUInt64BE(16));
  const evLines = Number(s.readBigUInt64BE(28)); const evBytes = Number(s.readBigUInt64BE(36));
  const lostRecs = Number(s.readBigUInt64BE(44)); const sb = s.readBigUInt64BE(52);
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(count) || !Number.isSafeInteger(evLines) || !Number.isSafeInteger(evBytes) || !Number.isSafeInteger(lostRecs) || evLines > count || (evLines === 0) !== (evBytes === 0) || lostRecs > evLines) return null;
  const flags = s.readUInt32BE(228);
  const hist = flags >>> 8;
  // the boundary is present exactly when something is evicted: anything else is a slot that contradicts itself
  if (((flags & 1) !== 0) !== (evLines > 0)) return null;
  let boundary: Boundary | null = null;
  if (flags & 1) {
    const cn = s.readBigUInt64BE(212);
    boundary = { h: Buffer.from(s.subarray(140, 172)), c: Buffer.from(s.subarray(172, 204)), convCount: Number(s.readBigUInt64BE(204)), candN: cn === NONE64 ? -1 : Number(cn), candId: cn === NONE64 || (flags & 2) ? null : s.subarray(220, 228).toString('hex') };
  }
  return { seq, ck: { count, stamp: s.readUInt32BE(24), evLines, evBytes, boundary, lostRecs, staleBad: sb === NONE64 ? null : Number(sb), hist, h: Buffer.from(s.subarray(76, 108)), c: Buffer.from(s.subarray(108, 140)) } };
}

/** Read both slots: the newest valid statement (or null: absent or damaged is simply no evidence), and where the next write goes. */
export async function readCheckpointState(fs: Fs, dir: string): Promise<CheckpointState> {
  const b = await fs.readFile(nodePath.join(dir, CHECKPOINT_FILE));
  if (!b) return { ck: null, seq: 0, next: 0, slotsOk: 0 };
  const tag = tagOf(dir);
  const slots = [decodeSlot(b, 0, tag), decodeSlot(b, SLOT, tag)];
  let best = -1;
  for (let i = 0; i < 2; i++) if (slots[i] && (best < 0 || slots[i]!.seq > slots[best]!.seq)) best = i;
  // a damaged or unwritten slot is the next one to be overwritten; if both are fine, the older one
  const slotsOk = slots.filter((x) => x !== null).length;
  if (best < 0) return { ck: null, seq: 0, next: 0, slotsOk };
  return { ck: slots[best]!.ck, seq: slots[best]!.seq, next: (1 - best) as 0 | 1, slotsOk };
}

/** The checkpoint, or null when absent OR damaged (a damaged one is simply not evidence: the index and body are still checked against each other). */
export async function readCheckpoint(fs: Fs, dir: string): Promise<Checkpoint | null> { return (await readCheckpointState(fs, dir)).ck; }

async function putSlot(fs: Fs, dir: string, slot: 0 | 1, k: Checkpoint, seq: number): Promise<void> {
  const path = nodePath.join(dir, CHECKPOINT_FILE);
  const created = !(await fs.exists(path));
  const f = await fs.open(path, { create: true });
  try {
    const slotBytes = encodeSlot(k, seq, tagOf(dir));
    // DESTRUCTIVE-OK(verified-record): overwrites only the OLDER slot; the newest valid slot is untouched, so a torn write leaves the previous statement intact
    await f.write(slotBytes, slot * SLOT); await f.sync();
  } finally { await f.close(); }
  if (created) await fs.fsyncDir(dir);
}

/** The per-append statement: overwrite the older slot. Call after the index records are durable and before acknowledging. */
export async function appendCheckpoint(fs: Fs, dir: string, st: CheckpointState, k: Checkpoint): Promise<void> {
  await putSlot(fs, dir, st.next, k, st.seq + 1);
  st.ck = k; st.seq += 1; st.next = (1 - st.next) as 0 | 1; st.slotsOk = Math.min(2, st.slotsOk + 1);
}

/**
 * Replace the statement with a LOWER (or any) one: both slots are written, so no stale higher slot can come back after a fault in the
 * newest one. Used at registration, before a cut, and by a rebuild.
 */
export async function writeCheckpoint(fs: Fs, dir: string, k: Checkpoint, st?: CheckpointState): Promise<CheckpointState> {
  const cur = st ?? await readCheckpointState(fs, dir);
  const first = cur.next;
  await putSlot(fs, dir, first, k, cur.seq + 1);
  await putSlot(fs, dir, (1 - first) as 0 | 1, k, cur.seq + 2);
  const out: CheckpointState = { ck: k, seq: cur.seq + 2, next: first, slotsOk: 2 };
  if (st) Object.assign(st, out);
  return out;
}
