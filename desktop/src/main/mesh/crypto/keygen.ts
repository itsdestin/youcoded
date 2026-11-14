// Sealing one generation's set secret to ONE device (T5 C6), via HPKE.
//   info = LABEL+"keygen\0" || setId || u32(G)      aad = sender id || recipient id
// WHY the aad: a sealed blob is bound to who sent it and who it is for, so it cannot be swapped
// onto another device or passed off as another sender's. HPKE base mode does not authenticate
// the sender, so callers always carry the blob inside a signed frame (or the pairing session).
import { LABEL, concat, requireLen, u32, utf8, type Bytes } from './bytes';
import { hpkeOpenSealed, hpkeSeal } from './hpke';
import { SET_SECRET_LENGTH } from './keys';
import { MeshCryptoError } from './errors';

const info = (setId: Bytes, gen: number): Buffer => concat(utf8(LABEL + 'keygen\0'), requireLen(setId, 32, 'set id'), u32(gen));
const aad = (from: Bytes, to: Bytes): Buffer => concat(requireLen(from, 16, 'from id'), requireLen(to, 16, 'to id'));

export const sealSecretTo = (recipientAgreeKey: Bytes, setId: Bytes, gen: number, secret: Bytes, fromDeviceId: Bytes, toDeviceId: Bytes): Buffer =>
  hpkeSeal(recipientAgreeKey, info(setId, gen), aad(fromDeviceId, toDeviceId), requireLen(secret, SET_SECRET_LENGTH, 'set secret'));

export function openSecret(agreeSecret: Bytes, sealed: Bytes, setId: Bytes, gen: number, fromDeviceId: Bytes, toDeviceId: Bytes): Buffer {
  const s = hpkeOpenSealed(agreeSecret, sealed, info(setId, gen), aad(fromDeviceId, toDeviceId));
  if (s.length !== SET_SECRET_LENGTH) throw new MeshCryptoError('malformed', 'set secret length');
  return s;
}
