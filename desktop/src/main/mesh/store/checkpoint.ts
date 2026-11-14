// The checkpoint: a tiny, separately stored statement "the first `count` lines of this version have raw
// chain value `h` and conversation chain value `c`" (review N1).
//
// WHY a file of its own: an index rebuild re-derives every chain value from the body bytes. If the only
// thing it can compare against is the index that was just damaged, a rotted body byte is silently accepted
// and the head hash changes (N1). The checkpoint lives in a DIFFERENT file from the index, has its own CRC
// and is replaced atomically (temp file + fsync + rename + directory fsync), so a single fault cannot take
// out both. It is written after the index is durable, never ahead of it, and lowered BEFORE a cut.
//
// Layout (big-endian): magic 'YCMCKPT1' (8) | count u64 | stamp u32 | h 32 | c 32 | crc32 u32 over all before it.
import * as nodePath from 'node:path';
import { crc32 } from './chain';
import { writeFileAtomic, type Fs } from './fsio';

const MAGIC = Buffer.from('YCMCKPT1', 'ascii');
const LEN = 8 + 8 + 4 + 32 + 32 + 4;
export const CHECKPOINT_FILE = 'checkpoint.bin';

export interface Checkpoint { count: number; stamp: number; h: Buffer; c: Buffer }

function encodeCheckpoint(k: Checkpoint): Buffer {
  const b = Buffer.alloc(LEN);
  MAGIC.copy(b, 0);
  b.writeBigUInt64BE(BigInt(k.count), 8);
  b.writeUInt32BE(k.stamp >>> 0, 16);
  k.h.copy(b, 20); k.c.copy(b, 52);
  b.writeUInt32BE(crc32(b, 0, LEN - 4), LEN - 4);
  return b;
}

/** The checkpoint, or null when absent OR damaged (a damaged one is simply not evidence: the index and body are still checked against each other). */
export async function readCheckpoint(fs: Fs, dir: string): Promise<Checkpoint | null> {
  const b = await fs.readFile(nodePath.join(dir, CHECKPOINT_FILE));
  if (!b || b.length !== LEN || !b.subarray(0, 8).equals(MAGIC) || crc32(b, 0, LEN - 4) !== b.readUInt32BE(LEN - 4)) return null;
  const count = Number(b.readBigUInt64BE(8));
  if (!Number.isSafeInteger(count)) return null;
  return { count, stamp: b.readUInt32BE(16), h: Buffer.from(b.subarray(20, 52)), c: Buffer.from(b.subarray(52, 84)) };
}

export async function writeCheckpoint(fs: Fs, dir: string, k: Checkpoint): Promise<void> {
  await writeFileAtomic(fs, nodePath.join(dir, CHECKPOINT_FILE), encodeCheckpoint(k));
}
