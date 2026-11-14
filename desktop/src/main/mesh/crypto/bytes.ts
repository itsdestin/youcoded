// Small byte helpers shared by the mesh crypto modules. Pure functions, no I/O, no logging.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { MeshCryptoError } from './errors';

export type Bytes = Uint8Array;

/** Every hash, signature and key-derivation label starts with this; it is part of the wire format. */
export const LABEL = 'youcoded-mesh/v1/';

export const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');
export const toBuf = (b: Bytes): Buffer => Buffer.from(b.buffer, b.byteOffset, b.byteLength);
export const concat = (...parts: Bytes[]): Buffer => Buffer.concat(parts.map(toBuf));
export const toHex = (b: Bytes): string => toBuf(b).toString('hex');
export const fromHex = (h: string): Buffer => Buffer.from(h.replace(/\s+/g, ''), 'hex');

export function u32(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new MeshCryptoError('invalid-argument', 'u32');
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}
export function u64(n: number): Buffer {
  if (!Number.isSafeInteger(n) || n < 0) throw new MeshCryptoError('invalid-argument', 'u64');
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

/** Constant-time equality (false, never a throw, for different lengths). */
export function ctEqual(a: Bytes, b: Bytes): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export const sha256 = (...parts: Bytes[]): Buffer => createHash('sha256').update(concat(...parts)).digest();
export const sha512 = (...parts: Bytes[]): Buffer => createHash('sha512').update(concat(...parts)).digest();
export const hmacSha256 = (key: Bytes, data: Bytes): Buffer => createHmac('sha256', key).update(data).digest();
export const hkdfSha256 = (ikm: Bytes, salt: Bytes, info: Bytes, len = 32): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, len));
export const random = (n: number): Buffer => randomBytes(n);

export function requireLen(b: unknown, n: number, what: string): Buffer {
  if (!(b instanceof Uint8Array) || b.length !== n) throw new MeshCryptoError('malformed', what);
  return toBuf(b);
}
