// ChaCha20-Poly1305 (RFC 8439, 96-bit nonce, 128-bit tag) from Node's built-in crypto, in ONE place.
// WHY one place: every caller (frames, HPKE, pairing) must use the same tag length and the same
// "ciphertext || tag" layout, and Node's types want `plaintextLength` on setAAD.
// NONCE RULE: a (key, nonce) pair must never encrypt two messages; callers guarantee it
// (frames.ts: per-session key + counter; pairing.ts: one message per key; hpke.ts: fresh key per seal).
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { toBuf, type Bytes } from './bytes';

// WHY not exported: only this file needs it; knip counts a dormant export as dead code.
const TAG_LENGTH = 16;

export function aeadSeal(key: Bytes, nonce: Bytes, aad: Bytes, plaintext: Bytes): Buffer {
  const pt = toBuf(plaintext);
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_LENGTH });
  c.setAAD(toBuf(aad), { plaintextLength: pt.length });
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}

/** Throws a plain Error on authentication failure; callers translate it to their own typed error. */
export function aeadOpen(key: Bytes, nonce: Bytes, aad: Bytes, ciphertextAndTag: Bytes): Buffer {
  const ct = toBuf(ciphertextAndTag);
  const body = ct.subarray(0, ct.length - TAG_LENGTH);
  const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_LENGTH });
  d.setAAD(toBuf(aad), { plaintextLength: body.length });
  d.setAuthTag(ct.subarray(ct.length - TAG_LENGTH));
  return Buffer.concat([d.update(body), d.final()]);
}
