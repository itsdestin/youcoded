// Small pure helpers of the chat store (split out of store.ts to keep it inside its line budget): line and proof validation,
// the disk-full test.
import { StoreError } from './errors';
import { isHash64 } from './chain';
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
