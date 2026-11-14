// On-disk record formats of the chat store. Pure encode/decode, no I/O.
//
// A version's lines are described by a fixed-width INDEX (one record per line, append-only) and stored
// in BODY chunk files (the raw line bytes, concatenated). The index is the source of truth: a line
// exists exactly when its index record is whole, its CRC matches and its body bytes are present.
// WHY fixed width: hashAt(n), a range read and "how many lines" are O(1) seeks, so a 300 MB chat is never
// scanned to answer them; the chain values stay in the index when a body is evicted (design 5.3).
import { crc32 } from './chain';
import type { LineKind } from './classify';

const INDEX_MAGIC = Buffer.from('YCMESHIX', 'ascii');
const INDEX_FORMAT = 1;
export const HDR = 16;   // magic(8) format u32 reserved u32
export const REC = 116;  // see layout in encodeRecord

export const NONE = -1;
const NONE64 = 0xffffffffffffffffn;

const KINDS: LineKind[] = ['user', 'assistant', 'bookkeeping', 'invalid', 'oversize'];
const F_CONVERSATION = 1;
const F_CAND_ID_NULL = 2;
/** This line changed a summary fact (title, model, folder), so a crash-time catch-up only has to re-read flagged lines. */
const F_FACT = 4;
const KIND_SHIFT = 4;

export interface Rec {
  offset: number;       // logical byte offset of the line in the version's body stream
  len: number;          // line length in bytes, newline included
  conversation: boolean;
  fact: boolean;        // this line changed a summary fact
  kind: LineKind;
  confirms: number;     // line number this line confirmed as a reply end, or NONE
  candN: number;        // tracker candidate AFTER this line, or NONE
  candId: string | null;// tracker candidate's message key after this line
  convCount: number;    // conversation lines among lines 0..this
  h: Buffer;            // raw chain value after this line
  c: Buffer;            // conversation chain value after this line
}

/**
 * `stamp` rides in the header's reserved word: it names the classifier (and reply-end options) that
 * produced every record's conversation-chain value, conversation count and reply-end fields (review M5).
 * WHY in the index itself: the stamp must travel with the chain it describes, so a changed classifier is
 * detected on open instead of two app versions silently producing different `c` values for identical bytes.
 */
export function indexHeader(stamp: number): Buffer {
  const b = Buffer.alloc(HDR);
  INDEX_MAGIC.copy(b, 0);
  b.writeUInt32BE(INDEX_FORMAT, 8);
  b.writeUInt32BE(stamp >>> 0, 12);
  return b;
}
export const headerStamp = (b: Buffer): number => b.readUInt32BE(12);
export const headerOk = (b: Buffer): boolean => b.length >= HDR && b.subarray(0, 8).equals(INDEX_MAGIC) && b.readUInt32BE(8) === INDEX_FORMAT;

/**
 * Layout (big-endian): offset u64 | len u32 | flags u32 | confirms u64 | candN u64 | candId 8 bytes |
 * convCount u64 | h 32 | c 32 | crc32 u32 over everything before it.
 * WHY the tracker state and the confirmation ride in the record: a reply-end confirmation names an
 * EARLIER line, and an in-place edit of that line's record would not be atomic. Putting "this line
 * confirmed line k" in the confirming line's own record makes the reply-end index crash-safe by
 * construction, and the tracker state after any line is recoverable without re-reading bodies.
 */
export function encodeRecord(r: Rec, out: Buffer, pos: number): void {
  out.writeBigUInt64BE(BigInt(r.offset), pos);
  out.writeUInt32BE(r.len, pos + 8);
  const flags = (r.conversation ? F_CONVERSATION : 0) | (r.fact ? F_FACT : 0) | (r.candN !== NONE && r.candId === null ? F_CAND_ID_NULL : 0) | (KINDS.indexOf(r.kind) << KIND_SHIFT);
  out.writeUInt32BE(flags >>> 0, pos + 12);
  out.writeBigUInt64BE(r.confirms === NONE ? NONE64 : BigInt(r.confirms), pos + 16);
  out.writeBigUInt64BE(r.candN === NONE ? NONE64 : BigInt(r.candN), pos + 24);
  if (r.candId) Buffer.from(r.candId, 'hex').copy(out, pos + 32, 0, 8); else out.fill(0, pos + 32, pos + 40);
  out.writeBigUInt64BE(BigInt(r.convCount), pos + 40);
  r.h.copy(out, pos + 48);
  r.c.copy(out, pos + 80);
  out.writeUInt32BE(crc32(out, pos, pos + 112), pos + 112);
}

/** Decode one record; null when its CRC does not match (a torn or damaged record). */
export function decodeRecord(buf: Buffer, pos: number): Rec | null {
  if (buf.length < pos + REC) return null;
  if (crc32(buf, pos, pos + 112) !== buf.readUInt32BE(pos + 112)) return null;
  const flags = buf.readUInt32BE(pos + 12);
  const confirms = buf.readBigUInt64BE(pos + 16);
  const candN = buf.readBigUInt64BE(pos + 24);
  const kind = KINDS[(flags >>> KIND_SHIFT) & 0xf];
  if (!kind) return null;
  return {
    offset: Number(buf.readBigUInt64BE(pos)),
    len: buf.readUInt32BE(pos + 8),
    conversation: (flags & F_CONVERSATION) !== 0,
    fact: (flags & F_FACT) !== 0,
    kind,
    confirms: confirms === NONE64 ? NONE : Number(confirms),
    candN: candN === NONE64 ? NONE : Number(candN),
    candId: candN === NONE64 || (flags & F_CAND_ID_NULL) ? null : buf.subarray(pos + 32, pos + 40).toString('hex'),
    convCount: Number(buf.readBigUInt64BE(pos + 40)),
    h: Buffer.from(buf.subarray(pos + 48, pos + 80)),
    c: Buffer.from(buf.subarray(pos + 80, pos + 112)),
  };
}

export const recPos = (n: number): number => HDR + n * REC;

/** Small framed-list format used for parked appends and set-aside tails: u32 count, then (u32 len, bytes)*, then crc32. */
export function frameLines(lines: Uint8Array[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(4); head.writeUInt32BE(lines.length); parts.push(head);
  for (const l of lines) { const h = Buffer.alloc(4); h.writeUInt32BE(l.length); parts.push(h, Buffer.from(l.buffer, l.byteOffset, l.byteLength)); }
  const body = Buffer.concat(parts);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body));
  return Buffer.concat([body, tail]);
}
export function unframeLines(buf: Buffer): Buffer[] | null {
  if (buf.length < 8) return null;
  if (crc32(buf, 0, buf.length - 4) !== buf.readUInt32BE(buf.length - 4)) return null;
  const n = buf.readUInt32BE(0); const out: Buffer[] = []; let p = 4;
  for (let i = 0; i < n; i++) {
    if (p + 4 > buf.length - 4) return null;
    const l = buf.readUInt32BE(p); p += 4;
    if (p + l > buf.length - 4) return null;
    out.push(buf.subarray(p, p + l)); p += l;
  }
  return p === buf.length - 4 ? out : null;
}
