// CPACE-X25519-SHA512, initiator/responder setting, exactly per draft-irtf-cfrg-cpace-21.
// https://datatracker.ietf.org/doc/draft-irtf-cfrg-cpace/   (T5 part A)
//
// WHAT it is: a password-authenticated key exchange. Two devices that share a short typed code
// end up with the same 64-byte session key; a listener (the relay is assumed hostile) learns
// nothing it can test the code against offline, and each connection tests exactly one guess.
//
// WHY our own ~90 lines over audited primitives: no maintained, audited CPace exists for
// JavaScript (T5 finding 1). X25519 and the Elligator2 map come from @noble/curves (audited:
// Trail of Bits 2.3.0, Cure53, Kudelski); SHA-512 from node:crypto. What is OURS is string
// framing and one hash call. It is proved against the draft's own Appendix B.1 vectors
// (generator, Ya, Yb, K, ISK) and all 12 low-order-point vectors in cpace.test.ts. It has had NO
// outside review: it is in scope for the pre-Phase-7 review (design section 8).
//
// ESM NOTE: @noble/curves is ESM-only; this main-process code compiles to CommonJS, so tsc emits
// require('@noble/curves/ed25519.js'). Node >= 22.12 (and the Android backend's Node 24) allow
// require() of an ES module that has no top-level await; esm-load.test.ts proves it on the real
// tsc output.
//
// T5 gap G21 (corrected after independent review): noble's Elligator2 uses BigInt maths that is not
// constant time, and its input is derived from the code. That is only harmless if an attacker cannot
// make this device repeat the computation and average its response time. So the generator is derived
// ONCE per party (callers pass it in as `generator`; pairing's Existing derives it once when the
// invite opens, never per incoming message), which removes the remote trigger. What remains is a
// LOCAL timing observer during that single derivation, and the 3-guess limit bounds the rest.
import { randomBytes } from 'node:crypto';
import { x25519, _map_to_curve_elligator2_curve25519 } from '@noble/curves/ed25519.js';
import { concat, sha512, utf8, toBuf, type Bytes } from './bytes';

const P = (1n << 255n) - 19n;
const DSI = utf8('CPace255');
const DSI_ISK = utf8('CPace255_ISK');
const S_IN_BYTES = 128; // SHA-512 input block size
const ZERO32 = Buffer.alloc(32);

// ---- string helpers (draft appendix A.1-A.3) ----
export function prependLen(data: Bytes): Buffer {
  let len = data.length;
  const out: number[] = [];
  for (;;) {
    out.push(len < 128 ? len : (len & 0x7f) + 0x80);
    len >>= 7;
    if (len === 0) break;
  }
  return concat(Buffer.from(out), data);
}
export const lvCat = (...args: Bytes[]): Buffer => concat(...args.map((a) => prependLen(a)));
export const transcriptIR = (Ya: Bytes, ADa: Bytes, Yb: Bytes, ADb: Bytes): Buffer => concat(lvCat(Ya, ADa), lvCat(Yb, ADb));
export function generatorString(prs: Bytes, ci: Bytes, sid: Bytes): Buffer {
  const lenZpad = Math.max(0, S_IN_BYTES - 1 - prependLen(prs).length - prependLen(DSI).length);
  return lvCat(DSI, prs, Buffer.alloc(lenZpad), ci, sid);
}

// ---- field maths (BigInt; only on the PUBLIC generator derivation from the password hash) ----
const mod = (a: bigint): bigint => ((a % P) + P) % P;
function pow(b: bigint, e: bigint): bigint {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = mod(r * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return r;
}
const inv = (a: bigint): bigint => pow(a, P - 2n);
const leToBig = (b: Bytes): bigint => Array.from(b).reduce((acc, v, i) => acc | (BigInt(v) << (8n * BigInt(i))), 0n);
function bigToLe(n: bigint): Buffer {
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) out[i] = Number((n >> (8n * BigInt(i))) & 0xffn);
  return out;
}

/** Reference Elligator2 straight from the draft's appendix A.5 (z = 2). Kept as the fallback if noble renames its map. */
export function elligator2Reference(r: bigint): Buffer {
  const A = 486662n;
  const z = 2n;
  const v = mod(-A * inv(1n + z * mod(r * r)));
  let eps = pow(mod(v * v * v + A * v * v + v), (P - 1n) / 2n);
  if (eps === P - 1n) eps = -1n;
  return bigToLe(mod(eps * v - (1n - eps) * A * inv(2n)));
}
/**
 * The same map through noble's RFC 9380 function. Its name is marked "experimental: may be renamed"
 * in ed25519.d.ts, hence the exact version pin and the test that compares it with the reference on
 * 2,000 random inputs. If a bump renames it, switch `map` below to elligator2Reference.
 */
export function elligator2Noble(r: bigint): Buffer {
  const { xMn, xMd } = _map_to_curve_elligator2_curve25519(r);
  return bigToLe(mod(xMn * inv(xMd)));
}

export function calculateGenerator(prs: Bytes, ci: Bytes, sid: Bytes, map: (r: bigint) => Buffer = elligator2Noble): Buffer {
  const genHash = Buffer.from(sha512(generatorString(prs, ci, sid)).subarray(0, 32));
  genHash[31] &= 0x7f; // decodeUCoordinate: clear bit 255
  return map(leToBig(genHash));
}

/** scalar_mult_vfy: X25519 that returns null for the neutral element (the draft says MUST abort). */
export function scalarMultVfy(y: Bytes, g: Bytes): Buffer | null {
  let k: Buffer;
  try {
    k = Buffer.from(x25519.scalarMult(toBuf(y), toBuf(g)));
  } catch {
    return null; // noble throws on an all-zero output
  }
  return k.equals(ZERO32) ? null : k;
}

export interface CPaceMessage {
  Y: Buffer;
  AD: Buffer;
}

/** One party. `scalar` is for the RFC vector test only; production always samples it. */
// WHY #private fields: the scalar and the password must not show in JSON.stringify or util.inspect.
export class CPace {
  readonly Y: Buffer;
  readonly #y: Buffer;
  readonly #ad: Buffer;
  readonly #o: { sid: Bytes; role: 'initiator' | 'responder' };
  constructor(o: {
    prs: Bytes;
    ci: Bytes;
    sid: Bytes;
    role: 'initiator' | 'responder';
    ad?: Bytes;
    scalar?: Bytes;
    /** calculateGenerator(prs, ci, sid) computed once by the caller; omitted = derived here. */
    generator?: Bytes;
  }) {
    this.#ad = Buffer.from(o.ad ?? Buffer.alloc(0));
    this.#o = { sid: Buffer.from(o.sid), role: o.role };
    const g = o.generator ?? calculateGenerator(o.prs, o.ci, o.sid);
    this.#y = Buffer.from(o.scalar ?? randomBytes(32));
    this.Y = Buffer.from(x25519.scalarMult(this.#y, g));
  }
  toString(): string {
    return '[CPace]';
  }
  toJSON(): string {
    return '[CPace]';
  }
  message(): CPaceMessage {
    return { Y: this.Y, AD: this.#ad };
  }
  /** Feed the peer's message; returns the 64-byte ISK, or null when the peer sent a low-order point (abort). */
  finish(peer: { Y: Bytes; AD: Bytes }): Buffer | null {
    if (peer.Y.length !== 32) return null;
    const K = scalarMultVfy(this.#y, peer.Y);
    if (!K) return null;
    const mine = { Y: this.Y, AD: this.#ad };
    const [a, b] = this.#o.role === 'initiator' ? [mine, peer] : [peer, mine];
    return sha512(lvCat(DSI_ISK, this.#o.sid, K), transcriptIR(a.Y, a.AD, b.Y, b.AD));
  }
}
