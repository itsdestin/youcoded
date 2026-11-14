// HPKE (RFC 9180) base mode, one-shot Seal/Open.
// Suite: DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305. T5 finding C6.
//
// WHY our own ~70 lines: one-shot base mode is three labelled HKDF calls plus one DH, built ONLY
// from Node built-ins; an HPKE library would add ~100 KB and a one-maintainer dependency for the
// same thing. Proof it is right: hpke.test.ts reproduces the RFC 9180 Appendix A.2 vector byte
// for byte (encapsulated key and ciphertext). Used to seal a set-secret generation to ONE device.
// Base mode does not authenticate the sender, so callers always send the result inside a signed frame.
import { randomBytes } from 'node:crypto';
import { aeadOpen, aeadSeal } from './aead';
import { concat, hmacSha256, toBuf, type Bytes } from './bytes';
import { MeshCryptoError, guard } from './errors';
import { x25519Dh, x25519PublicFromSecret } from './curves';

const i2osp2 = (n: number): Buffer => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const ascii = (s: string): Buffer => Buffer.from(s, 'ascii');
const SUITE_KEM = concat(ascii('KEM'), i2osp2(0x0020));
const SUITE = concat(ascii('HPKE'), i2osp2(0x0020), i2osp2(0x0001), i2osp2(0x0003));
const V1 = ascii('HPKE-v1');
const EMPTY = Buffer.alloc(0);

const labeledExtract = (salt: Bytes, suite: Bytes, label: string, ikm: Bytes): Buffer =>
  hmacSha256(salt.length ? salt : Buffer.alloc(32), concat(V1, suite, ascii(label), ikm));
function labeledExpand(prk: Bytes, suite: Bytes, label: string, info: Bytes, len: number): Buffer {
  const full = concat(i2osp2(len), V1, suite, ascii(label), info);
  let t: Buffer = Buffer.alloc(0);
  const out: Buffer[] = [];
  for (let i = 1; Buffer.concat(out).length < len; i++) {
    t = hmacSha256(prk, concat(t, full, Buffer.from([i])));
    out.push(t);
  }
  return Buffer.concat(out).subarray(0, len);
}
function keySchedule(sharedSecret: Bytes, info: Bytes): { key: Buffer; nonce: Buffer } {
  const pskIdHash = labeledExtract(EMPTY, SUITE, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(EMPTY, SUITE, 'info_hash', info);
  const ctx = concat(Buffer.from([0]), pskIdHash, infoHash); // mode 0 = base
  const secret = labeledExtract(sharedSecret, SUITE, 'secret', EMPTY);
  return { key: labeledExpand(secret, SUITE, 'key', ctx, 32), nonce: labeledExpand(secret, SUITE, 'base_nonce', ctx, 12) };
}
const shared = (dh: Bytes, enc: Bytes, pkR: Bytes): Buffer =>
  labeledExpand(labeledExtract(EMPTY, SUITE_KEM, 'eae_prk', dh), SUITE_KEM, 'shared_secret', concat(enc, pkR), 32);

/** Deterministic form for the RFC vector test only: the ephemeral secret is supplied. */
export function hpkeSealWithEphemeral(pkR: Bytes, info: Bytes, aad: Bytes, pt: Bytes, skE: Bytes): { enc: Buffer; ct: Buffer } {
  const enc = x25519PublicFromSecret(skE);
  const { key, nonce } = keySchedule(shared(x25519Dh(skE, pkR), enc, pkR), info);
  return { enc, ct: aeadSeal(key, nonce, aad, pt) };
}
/** Seal to a recipient's X25519 public key. Output = enc(32) || ciphertext||tag. A fresh ephemeral key each call. */
export function hpkeSeal(pkR: Bytes, info: Bytes, aad: Bytes, pt: Bytes): Buffer {
  const { enc, ct } = hpkeSealWithEphemeral(pkR, info, aad, pt, randomBytes(32));
  return concat(enc, ct);
}
export function hpkeOpen(skR: Bytes, enc: Bytes, info: Bytes, aad: Bytes, ct: Bytes): Buffer {
  return guard(() => {
    if (enc.length !== 32 || ct.length < 16) throw new MeshCryptoError('malformed', 'hpke input');
    const pkR = x25519PublicFromSecret(skR);
    const { key, nonce } = keySchedule(shared(x25519Dh(skR, enc), enc, pkR), info);
    try {
      return aeadOpen(key, nonce, aad, ct);
    } catch {
      throw new MeshCryptoError('auth-failed', 'hpke');
    }
  });
}
export function hpkeOpenSealed(skR: Bytes, sealed: Bytes, info: Bytes, aad: Bytes): Buffer {
  const s = toBuf(sealed);
  return hpkeOpen(skR, s.subarray(0, 32), info, aad, s.subarray(32));
}
