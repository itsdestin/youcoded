// The two hash chains and the ONE replaceable function that seeds them.
//
// Design 5.3: h[0] = SHA-256(chat id || segment as uint32be); h[n] = SHA-256(h[n-1] as 32 raw bytes ||
// raw bytes of line n). The "conversation chain" c is the same construction over user/assistant lines
// only (T21: bookkeeping lines must never make two copies "differ").
//
// WHY the seed is a single function: the version-id scheme and what seeds the first hash are being
// finalised by another workstream (decide rules). The store never builds a seed itself; it calls
// `ChainSeedFn` once per version and keeps the result. Swapping the rule means replacing this one
// function (passed to the store/adapter as an option), nothing else.
import { createHash } from 'node:crypto';

export type RuntimeKind = 'claude-code' | 'native';

interface SeedContext {
  chatId: string;
  /** Opaque version id bytes, supplied by the caller. The default rule deliberately ignores them (T12 F6). */
  version: Uint8Array;
  segment: number;
}
export interface ChainSeeds {
  raw: Buffer;          // h[0]
  conversation: Buffer; // c[0]
}
export type ChainSeedFn = (ctx: SeedContext) => ChainSeeds;

const CONVERSATION_LABEL = Buffer.from('youcoded-mesh/v1/conversation-chain\0', 'utf8');

/**
 * Design rule as written: h[0] = SHA-256(chat id || uint32be segment).
 * c[0]: the design does not give one; it is domain-separated from h[0] so the two chains never share a
 * value by accident (AMBIGUITY, resolved here; the whole function is replaceable).
 */
export const defaultChainSeeds: ChainSeedFn = ({ chatId, segment }) => {
  const seg = Buffer.alloc(4);
  seg.writeUInt32BE(segment >>> 0);
  const raw = createHash('sha256').update(Buffer.from(chatId, 'utf8')).update(seg).digest();
  const conversation = createHash('sha256').update(CONVERSATION_LABEL).update(raw).digest();
  return { raw, conversation };
};

/** One chain step: SHA-256(previous value (32 raw bytes) || raw line bytes including the newline). */
export function chainStep(prev: Uint8Array, line: Uint8Array): Buffer {
  return createHash('sha256').update(prev).update(line).digest();
}

/** Hex helpers: chain values are exchanged as 64-char lowercase hex in the public API. */
export const hex = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');
export const unhex = (h: string): Buffer => Buffer.from(h, 'hex');
export const isHash64 = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

/** CRC-32 (IEEE). Written out so the store does not depend on a newer Node's zlib.crc32. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
export function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
