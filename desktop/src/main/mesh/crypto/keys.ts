// Keys derived from the set secret, per generation and per purpose (T5 C3).
//
// K = HKDF-SHA256(ikm = S_G, salt = setId, info = LABEL || purpose || 0x00 || u32(G) || context, 32)
//
// S_G (32 random bytes) is never used to encrypt anything directly. A NEW generation's secret is
// fresh random bytes, NEVER derived from the old one: otherwise a removed device, which holds the
// old secret, could compute the new one (tested in keys.test.ts).
//
// `context` parts are concatenated WITHOUT length prefixes (that is the wire format T5 fixed), so
// every purpose must use fixed-length context parts. `frame` uses sender id (16) + session (16).
import { LABEL, concat, hkdfSha256, random, requireLen, u32, utf8, type Bytes } from './bytes';
import { MeshCryptoError } from './errors';

export type KeyPurpose = 'frame' | 'register' | 'roster-name';

export const SET_SECRET_LENGTH = 32;
export const newSetSecret = (): Buffer => random(SET_SECRET_LENGTH);

export function purposeKey(secret: Bytes, setId: Bytes, gen: number, purpose: KeyPurpose, ...context: Bytes[]): Buffer {
  requireLen(secret, SET_SECRET_LENGTH, 'set secret');
  return hkdfSha256(secret, requireLen(setId, 32, 'set id'), concat(utf8(LABEL + purpose + '\0'), u32(gen), ...context));
}

/** The AEAD key for ONE sender's ONE session under ONE generation. Unique, so counter-only nonces are safe. */
export function frameKey(secret: Bytes, setId: Bytes, gen: number, from: Bytes, session: Bytes): Buffer {
  if (from.length !== 16 || session.length !== 16) throw new MeshCryptoError('invalid-argument', 'frame key context');
  return purposeKey(secret, setId, gen, 'frame', from, session);
}
