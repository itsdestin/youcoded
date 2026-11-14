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
// Slot layout (big-endian): magic 'YCMCKPT2' (8) | seq u64 | count u64 | stamp u32 | h 32 | c 32 | crc32 u32 over all before it.
import * as nodePath from 'node:path';
import { crc32 } from './chain';
import type { Fs } from './fsio';

const MAGIC = Buffer.from('YCMCKPT2', 'ascii');
const SLOT = 8 + 8 + 8 + 4 + 32 + 32 + 4;
export const CHECKPOINT_FILE = 'checkpoint.bin';

export interface Checkpoint { count: number; stamp: number; h: Buffer; c: Buffer }
/** What a version remembers between appends: the newest statement's sequence number and the slot the NEXT write goes to. */
export interface CheckpointState { ck: Checkpoint | null; seq: number; next: 0 | 1; /** how many of the two slots hold a valid statement */ slotsOk: number }

function encodeSlot(k: Checkpoint, seq: number): Buffer {
  const b = Buffer.alloc(SLOT);
  MAGIC.copy(b, 0);
  b.writeBigUInt64BE(BigInt(seq), 8);
  b.writeBigUInt64BE(BigInt(k.count), 16);
  b.writeUInt32BE(k.stamp >>> 0, 24);
  k.h.copy(b, 28); k.c.copy(b, 60);
  b.writeUInt32BE(crc32(b, 0, SLOT - 4), SLOT - 4);
  return b;
}

function decodeSlot(b: Buffer, at: number): { seq: number; ck: Checkpoint } | null {
  if (b.length < at + SLOT) return null;
  const s = b.subarray(at, at + SLOT);
  if (!s.subarray(0, 8).equals(MAGIC) || crc32(s, 0, SLOT - 4) !== s.readUInt32BE(SLOT - 4)) return null;
  const seq = Number(s.readBigUInt64BE(8)); const count = Number(s.readBigUInt64BE(16));
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(count)) return null;
  return { seq, ck: { count, stamp: s.readUInt32BE(24), h: Buffer.from(s.subarray(28, 60)), c: Buffer.from(s.subarray(60, 92)) } };
}

/** Read both slots: the newest valid statement (or null: absent or damaged is simply no evidence), and where the next write goes. */
export async function readCheckpointState(fs: Fs, dir: string): Promise<CheckpointState> {
  const b = await fs.readFile(nodePath.join(dir, CHECKPOINT_FILE));
  if (!b) return { ck: null, seq: 0, next: 0, slotsOk: 0 };
  const slots = [decodeSlot(b, 0), decodeSlot(b, SLOT)];
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
    const slotBytes = encodeSlot(k, seq);
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
