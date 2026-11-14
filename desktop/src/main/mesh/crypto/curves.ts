// Raw-byte wrappers over Node's built-in Ed25519 and X25519.
//
// WHY Node `crypto` and not a library: the design says "no home-made cipher"; Node's OpenSSL
// already provides audited Ed25519 (RFC 8032) and X25519 (RFC 7748). These wrappers only move
// 32 raw bytes in and out of the DER envelopes Node wants. Pure functions: keys are passed in
// and out as bytes, nothing is stored or logged here.
import { createPrivateKey, createPublicKey, diffieHellman, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { guard } from './errors';
import { requireLen, concat, toBuf, type Bytes } from './bytes';

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

const edPriv = (seed: Bytes): KeyObject => createPrivateKey({ key: concat(ED_PKCS8, requireLen(seed, 32, 'ed25519 seed')), format: 'der', type: 'pkcs8' });
const edPub = (pub: Bytes): KeyObject => createPublicKey({ key: concat(ED_SPKI, requireLen(pub, 32, 'ed25519 public key')), format: 'der', type: 'spki' });
const xPriv = (sk: Bytes): KeyObject => createPrivateKey({ key: concat(X_PKCS8, requireLen(sk, 32, 'x25519 secret')), format: 'der', type: 'pkcs8' });
const xPub = (pk: Bytes): KeyObject => createPublicKey({ key: concat(X_SPKI, requireLen(pk, 32, 'x25519 public key')), format: 'der', type: 'spki' });

const rawPub = (k: KeyObject): Buffer => Buffer.from((createPublicKey(k).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32));

export const ed25519PublicFromSeed = (seed: Bytes): Buffer => rawPub(edPriv(seed));
export const x25519PublicFromSecret = (sk: Bytes): Buffer => rawPub(xPriv(sk));

export function ed25519Sign(seed: Bytes, msg: Bytes): Buffer {
  return Buffer.from(edSign(null, toBuf(msg), edPriv(seed)));
}
/** Never throws: a malformed key or signature is simply "not valid". */
export function ed25519Verify(pub: Bytes, msg: Bytes, sig: Bytes): boolean {
  try {
    if (sig.length !== 64) return false;
    return edVerify(null, toBuf(msg), edPub(pub), toBuf(sig));
  } catch {
    return false;
  }
}

/** X25519 shared secret. Throws MeshCryptoError('low-order-point') when OpenSSL refuses the all-zero result. */
export function x25519Dh(sk: Bytes, pk: Bytes): Buffer {
  const priv = xPriv(sk);
  const pub = xPub(pk);
  return guard(() => Buffer.from(diffieHellman({ privateKey: priv, publicKey: pub })), 'low-order-point');
}
