// Deterministic CBOR, restricted subset (RFC 8949 section 4.2.1), T5 finding C5.
//
// WHY this exists: entry ids are SHA-256 of these bytes and signatures cover them, so every
// device (Windows, macOS, Linux, Android, a later Rust/Pi reader) must produce IDENTICAL bytes
// for one value, and a decoder that accepted a second spelling of the same value would give one
// value two ids. So the DECODER refuses every non-canonical form instead of normalising it.
//
// Allowed: unsigned integers below 2^53, byte strings, text strings, arrays, maps with text keys
// sorted bytewise, true/false/null. Refused: floats, tags, negatives, indefinite lengths,
// non-shortest integers/lengths, duplicate or unsorted keys, trailing bytes, nesting > 64.
import { MeshCryptoError, guard } from './errors';
import { toBuf } from './bytes';

export type CborValue = null | boolean | number | string | Uint8Array | CborValue[] | { [key: string]: CborValue | undefined };

const MAX_DEPTH = 64;
const bad = (why: string): never => {
  throw new MeshCryptoError('malformed', 'cbor ' + why);
};

function head(major: number, n: number): Buffer {
  if (!Number.isSafeInteger(n) || n < 0) throw new MeshCryptoError('invalid-argument', 'cbor integer out of range');
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  if (n < 0x100000000) {
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = (major << 5) | 27;
  b.writeBigUInt64BE(BigInt(n), 1);
  return b;
}

function enc(v: CborValue | undefined, depth: number): Buffer {
  if (depth > MAX_DEPTH) throw new MeshCryptoError('invalid-argument', 'cbor too deep');
  if (v === null) return Buffer.from([0xf6]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === false) return Buffer.from([0xf4]);
  if (typeof v === 'number') return head(0, v);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), toBuf(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map((x) => enc(x, depth + 1))]);
  if (typeof v === 'object' && v !== undefined) {
    // undefined members are dropped so optional fields can simply be left unset.
    const ents = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => [enc(k, depth + 1), enc(x, depth + 1)] as const);
    ents.sort((a, b) => Buffer.compare(a[0], b[0]));
    return Buffer.concat([head(5, ents.length), ...ents.flat()]);
  }
  throw new MeshCryptoError('invalid-argument', 'cbor unsupported value');
}

/** Canonical bytes of a value. Same value, same bytes, on every device. */
export const encode = (v: CborValue): Buffer => enc(v, 0);

/** Parse canonical bytes. Throws MeshCryptoError('malformed') for anything else. */
export function decode(input: Uint8Array): CborValue {
  return guard(() => {
    const buf = toBuf(input);
    let o = 0;
    const need = (n: number): void => {
      if (o + n > buf.length) bad('truncated');
    };
    function arg(info: number): number {
      if (info < 24) return info;
      let n: number;
      let min: number;
      if (info === 24) {
        need(1);
        n = buf[o++];
        min = 24;
      } else if (info === 25) {
        need(2);
        n = buf.readUInt16BE(o);
        o += 2;
        min = 0x100;
      } else if (info === 26) {
        need(4);
        n = buf.readUInt32BE(o);
        o += 4;
        min = 0x10000;
      } else if (info === 27) {
        need(8);
        const big = buf.readBigUInt64BE(o);
        o += 8;
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) bad('integer too large');
        n = Number(big);
        min = 0x100000000;
      } else return bad('indefinite or reserved length');
      if (n < min) bad('not shortest form');
      return n;
    }
    function item(depth: number): CborValue {
      if (depth > MAX_DEPTH) bad('too deep');
      need(1);
      const ib = buf[o++];
      const major = ib >> 5;
      const info = ib & 31;
      if (major === 7) {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        return bad('simple or float');
      }
      if (major === 6) return bad('tag');
      if (major === 1) return bad('negative integer');
      const n = arg(info);
      if (major === 0) return n;
      if (major === 2 || major === 3) {
        need(n);
        const b = buf.subarray(o, o + n);
        o += n;
        return major === 2 ? Buffer.from(b) : new TextDecoder('utf-8', { fatal: true }).decode(b);
      }
      if (major === 4) {
        if (n > buf.length - o) bad('truncated'); // each element is at least one byte
        const a: CborValue[] = [];
        for (let i = 0; i < n; i++) a.push(item(depth + 1));
        return a;
      }
      if (major === 5) {
        if (n > buf.length - o) bad('truncated');
        const m: { [k: string]: CborValue } = Object.create(null);
        let prev: Buffer | null = null;
        for (let i = 0; i < n; i++) {
          const k0 = o;
          const k = item(depth + 1);
          const kb = buf.subarray(k0, o);
          if (typeof k !== 'string') bad('map keys must be text');
          if (prev && Buffer.compare(prev, kb) >= 0) bad('map keys not strictly sorted');
          prev = Buffer.from(kb);
          m[k as string] = item(depth + 1);
        }
        return m;
      }
      return bad('item');
    }
    const v = item(0);
    if (o !== buf.length) bad('trailing bytes');
    return v;
  });
}

// ---- typed readers: pull fields out of a decoded map with a size/type check ----
// WHY: decoded values are `unknown` shapes from a hostile peer; every read goes through one of
// these so a wrong type is a MeshCryptoError('malformed'), never a TypeError three calls later.
export type CborMap = { [key: string]: CborValue };
export function asMap(v: unknown, what = 'map'): CborMap {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || v instanceof Uint8Array) throw new MeshCryptoError('malformed', what);
  return v as CborMap;
}
export function asBytes(v: unknown, what: string, len?: number): Buffer {
  if (!(v instanceof Uint8Array) || (len !== undefined && v.length !== len)) throw new MeshCryptoError('malformed', what);
  return toBuf(v);
}
export function asText(v: unknown, what: string, maxLen = 4096): string {
  if (typeof v !== 'string' || v.length > maxLen) throw new MeshCryptoError('malformed', what);
  return v;
}
export function asUint(v: unknown, what: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) throw new MeshCryptoError('malformed', what);
  return v;
}
export function asArray(v: unknown, what: string, maxLen = 4096): CborValue[] {
  if (!Array.isArray(v) || v.length > maxLen) throw new MeshCryptoError('malformed', what);
  return v;
}
/** Reject maps that carry fields we do not know: strictness keeps one value one meaning. */
export function onlyKeys(m: CborMap, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(m)) if (!allowed.includes(k)) throw new MeshCryptoError('malformed', what + ' unknown field');
}
