// Small pure helpers of the chat store (split out of store.ts to keep it inside its line budget): line and proof validation,
// the disk-full test, and the on-disk codec of a set-aside tail file.
import { StoreError } from './errors';
import { isHash64 } from './chain';
import { openEnv, sealEnv } from './envelope';
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

/** A valid file that is not THIS version's tail for THIS id. `elsewhere`: it IS a tail for this id, sealed for another version (filed under the wrong version folder). */
export class ForeignTail extends StoreError { constructor(detail: string, readonly elsewhere: boolean) { super('corrupt', detail); } }

export interface TailFile { fromLine: number; fromHash: string; fromConv: string; headHash: string; headConv: string; lines: Buffer[]; replyEnds: number[]; pending: number | null }

/**
 * A set-aside tail inside the ONE envelope (envelope.ts): role 'tail', the version key and the TAKEOVER ID are sealed inside the checksum (review 5, F2: a tail file used to say which version it
 * belonged to but not which takeover, so a copy of another tail of the same version under this name was believed). Payload: u32 header length | JSON header | framed lines (own checksum).
 */
export function encodeTailFile(key: string, takeoverId: string, header: unknown, lines: Buffer[]): Buffer {
  const hb = Buffer.from(JSON.stringify(header));
  const hl = Buffer.alloc(4); hl.writeUInt32BE(hb.length);
  return sealEnv({ role: 'tail', version: key, id: takeoverId }, Buffer.concat([hl, hb, frameLines(lines)]));
}

/** Throws `corrupt` for a damaged file AND for a valid one that is not THIS version's tail for THIS takeover id (nothing is moved or deleted). */
export function decodeTailFile(b: Buffer, key: string, takeoverId: string): TailFile {
  const r = openEnv(b, { role: 'tail', version: key, id: takeoverId });
  if (r.kind === 'foreign') throw new ForeignTail(`tail file is not this takeover's tail (${r.why})`, r.seen.role === 'tail' && r.seen.id === takeoverId);
  if (r.kind !== 'ok') throw new StoreError('corrupt', 'tail file');
  const p = r.payload;
  if (p.length < 4) throw new StoreError('corrupt', 'tail file header');
  const hl = p.readUInt32BE(0);
  if (4 + hl > p.length) throw new StoreError('corrupt', 'tail file header');
  let header: any;
  try { header = JSON.parse(p.subarray(4, 4 + hl).toString()); } catch { throw new StoreError('corrupt', 'tail file header'); }
  const lines = unframeLines(p.subarray(4 + hl));
  if (!lines) throw new StoreError('corrupt', 'tail file body');
  return { fromLine: header.fromLine, fromHash: header.fromHash, fromConv: header.fromConv, headHash: header.headHash, headConv: header.headConv, lines, replyEnds: header.replyEnds, pending: header.pending };
}
