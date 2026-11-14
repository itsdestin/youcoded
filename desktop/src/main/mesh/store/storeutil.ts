// Small pure helpers of the chat store (split out of store.ts to keep it inside its line budget): line and proof validation,
// the disk-full test, and the on-disk codec of a set-aside tail file.
import { StoreError } from './errors';
import { crc32, isHash64 } from './chain';
import { frameLines, unframeLines } from './records';
import type { EvictionProof } from './types';

/** A line must be exactly one line: ends in 0x0a and has no other 0x0a. */
export function asLine(l: Uint8Array): Buffer {
  const b = Buffer.from(l.buffer, l.byteOffset, l.byteLength);
  if (b.length === 0 || b[b.length - 1] !== 0x0a || b.indexOf(0x0a) !== b.length - 1) throw new StoreError('bad-line');
  return b;
}

export function validateProofShape(p: EvictionProof): void {
  const bad = (m: string): never => { throw new StoreError('bad-proof', m); };
  if (!p || typeof p !== 'object' || p.kind !== 'holders-confirmed') bad('kind');
  if (typeof p.version !== 'string') bad('version');
  if (!Number.isSafeInteger(p.through) || p.through < 1) bad('through');
  if (!isHash64(p.hash)) bad('hash');
  if (!Array.isArray(p.acks) || p.acks.length < 1 || p.acks.length > 64) bad('acknowledgements');
  const holders = new Set<string>();
  for (const a of p.acks) {
    if (!a || typeof a !== 'object' || typeof a.holder !== 'string' || a.holder.length < 1 || a.holder.length > 256) bad('holder id');
    if (typeof a.version !== 'string' || !Number.isSafeInteger(a.lines) || !isHash64(a.hash) || typeof a.signature !== 'string') bad('acknowledgement fields');
    if (holders.has(a.holder)) bad('the same holder twice');
    holders.add(a.holder);
  }
}

/** ENOSPC (disk full) or EDQUOT (quota): the one failure the store turns into the typed `disk-full` refusal (N5). */
export function isDiskFull(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === 'ENOSPC' || code === 'EDQUOT';
}

export interface TailFile { version: string; fromLine: number; fromHash: string; fromConv: string; headHash: string; headConv: string; lines: Buffer[]; replyEnds: number[]; pending: number | null }

/** `YCMTAIL2 | header length u32 | JSON header | header crc u32 | framed lines` (the framed lines carry their own checksum). */
export function encodeTailFile(header: unknown, lines: Buffer[]): Buffer {
  const hb = Buffer.from(JSON.stringify(header));
  const hl = Buffer.alloc(4); hl.writeUInt32BE(hb.length);
  const hc = Buffer.alloc(4); hc.writeUInt32BE(crc32(hb));
  return Buffer.concat([Buffer.from('YCMTAIL2'), hl, hb, hc, frameLines(lines)]);
}

export function decodeTailFile(b: Buffer): TailFile {
  if (b.length < 16 || b.subarray(0, 8).toString() !== 'YCMTAIL2') throw new StoreError('corrupt', 'tail file');
  const hl = b.readUInt32BE(8);
  // WHY a checksum on the header (L6): the framed lines carry their own, the JSON header did not
  if (12 + hl + 4 > b.length || crc32(b.subarray(12, 12 + hl)) !== b.readUInt32BE(12 + hl)) throw new StoreError('corrupt', 'tail file header');
  let header: any;
  try { header = JSON.parse(b.subarray(12, 12 + hl).toString()); } catch { throw new StoreError('corrupt', 'tail file header'); }
  const lines = unframeLines(b.subarray(12 + hl + 4));
  if (!lines) throw new StoreError('corrupt', 'tail file body');
  return { version: header.version, fromLine: header.fromLine, fromHash: header.fromHash, fromConv: header.fromConv, headHash: header.headHash, headConv: header.headConv, lines, replyEnds: header.replyEnds, pending: header.pending };
}
