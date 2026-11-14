// Device identity: one Ed25519 signing pair + one X25519 key-agreement pair (T5 C2).
//
// Pure functions over bytes. STORAGE IS NOT HERE: a later part seals `serializeIdentity()`
// output with the OS secret store (safeStorage / Android Keystore shim). Nothing in this file
// writes a file, reads the environment or logs.
//
// deviceId = first 16 bytes of SHA-256(label || signKey). WHY key-derived and not a hash of the
// machine id: the machine id is sent in clear to the existing sync hub, so a plain hash of it is
// computable by whoever holds that data (T5 gap G9). A key-derived id is self-certifying and
// unlinkable to analytics; reinstalling with the key file intact keeps the id.
import { randomBytes } from 'node:crypto';
import { LABEL, sha256, utf8, requireLen, type Bytes } from './bytes';
import { asBytes, asMap, asUint, decode, encode, onlyKeys } from './cbor';
import { MeshCryptoError, guard } from './errors';
import { ed25519PublicFromSeed, ed25519Sign, ed25519Verify, x25519PublicFromSecret } from './curves';

export interface DeviceIdentity {
  /** Ed25519 private seed (32 bytes). SECRET. */
  readonly signSeed: Buffer;
  readonly signKey: Buffer;
  /** X25519 private key (32 bytes). SECRET. */
  readonly agreeSecret: Buffer;
  readonly agreeKey: Buffer;
  /** 16 bytes, derived from signKey. */
  readonly deviceId: Buffer;
}

export const DEVICE_ID_LENGTH = 16;

export const deviceIdFor = (signKey: Bytes): Buffer => sha256(utf8(LABEL + 'device-id\0'), requireLen(signKey, 32, 'sign key')).subarray(0, DEVICE_ID_LENGTH);
/** setId is also the relay room name. Derived from a PUBLIC key, never from the set secret. */
export const setIdFor = (firstDeviceSignKey: Bytes): Buffer => sha256(utf8(LABEL + 'room\0'), requireLen(firstDeviceSignKey, 32, 'sign key'));
/** QR fingerprint: pins the existing device's identity into pairing. */
export const fingerprintFor = (signKey: Bytes, agreeKey: Bytes): Buffer =>
  sha256(utf8(LABEL + 'fingerprint\0'), requireLen(signKey, 32, 'sign key'), requireLen(agreeKey, 32, 'agree key'));

/** Build an identity from its two private values (used by generate, parse and known-answer tests). */
export function identityFromSecrets(signSeed: Bytes, agreeSecret: Bytes): DeviceIdentity {
  const seed = Buffer.from(requireLen(signSeed, 32, 'sign seed'));
  const agree = Buffer.from(requireLen(agreeSecret, 32, 'agree secret'));
  const signKey = ed25519PublicFromSeed(seed);
  return Object.freeze({
    signSeed: seed,
    signKey,
    agreeSecret: agree,
    agreeKey: x25519PublicFromSecret(agree),
    deviceId: deviceIdFor(signKey),
  });
}

/** Fresh identity from the OS random source. Held in memory only. */
export const generateIdentity = (): DeviceIdentity => identityFromSecrets(randomBytes(32), randomBytes(32));

const SERIAL_VERSION = 1;
/** Bytes for the (later) OS-secret-store layer to seal. Public keys are not stored: they are re-derived on parse. */
export function serializeIdentity(id: DeviceIdentity): Buffer {
  return encode({ v: SERIAL_VERSION, sign: id.signSeed, agree: id.agreeSecret });
}
export function parseIdentity(bytes: Uint8Array): DeviceIdentity {
  return guard(() => {
    const m = asMap(decode(bytes), 'identity');
    onlyKeys(m, ['v', 'sign', 'agree'], 'identity');
    if (asUint(m.v, 'identity version') !== SERIAL_VERSION) throw new MeshCryptoError('unsupported-version', 'identity');
    return identityFromSecrets(asBytes(m.sign, 'identity sign', 32), asBytes(m.agree, 'identity agree', 32));
  });
}

export const signWith = (id: DeviceIdentity, msg: Bytes): Buffer => ed25519Sign(id.signSeed, msg);
export const verifySig = (signKey: Bytes, msg: Bytes, sig: Bytes): boolean => ed25519Verify(signKey, msg, sig);
