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
import { ed25519PublicFromSeed, ed25519Sign, ed25519Verify, x25519Dh, x25519PublicFromSecret } from './curves';

/** What node's util.inspect asks an object for; looked up by name so this file needs no node:util import. */
export const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

/**
 * One device's keys. WHY a class with #private fields (was a plain object with Buffer properties):
 * a plain object printed its private seed under JSON.stringify and util.inspect, so one stray log
 * line or error report would leak it. Private fields are invisible to JSON, inspect (even with
 * showHidden), spreading, Object.keys and structured clone; the secrets are reachable only through
 * the two getters, by name, on purpose. toJSON/inspect/toString show the public device id only.
 */
export class DeviceIdentity {
  readonly #signSeed: Buffer;
  readonly #agreeSecret: Buffer;
  readonly signKey: Buffer;
  readonly agreeKey: Buffer;
  /** 16 bytes, derived from signKey. */
  readonly deviceId: Buffer;
  constructor(signSeed: Buffer, agreeSecret: Buffer) {
    this.#signSeed = signSeed;
    this.#agreeSecret = agreeSecret;
    this.signKey = ed25519PublicFromSeed(signSeed);
    this.agreeKey = x25519PublicFromSecret(agreeSecret);
    this.deviceId = deviceIdFor(this.signKey);
    Object.defineProperty(this, 'signKey', { enumerable: false });
    Object.defineProperty(this, 'agreeKey', { enumerable: false });
    Object.defineProperty(this, 'deviceId', { enumerable: false });
    Object.freeze(this);
  }
  /** Ed25519 private seed (32 bytes). SECRET. */
  get signSeed(): Buffer {
    return this.#signSeed;
  }
  /** X25519 private key (32 bytes). SECRET. */
  get agreeSecret(): Buffer {
    return this.#agreeSecret;
  }
  toString(): string {
    return `[DeviceIdentity ${this.deviceId.toString('hex')}]`;
  }
  toJSON(): string {
    return this.toString();
  }
  [INSPECT_CUSTOM](): string {
    return this.toString();
  }
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
  return new DeviceIdentity(seed, agree);
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

// A fixed throwaway scalar: any scalar sends a low-order point to the all-zero output, which
// OpenSSL refuses, so one Diffie-Hellman against this scalar tells us whether a peer key is usable.
const PROBE_SCALAR = Buffer.alloc(32, 1);
/**
 * A 32-byte X25519 public key that is safe to seal to. Throws MeshCryptoError('malformed') for the
 * wrong size and ('low-order-point') for a weak key (all-zero, the small-order points).
 */
export function requireAgreeKey(b: unknown, what: string): Buffer {
  const k = asBytes(b, what, 32);
  try {
    x25519Dh(PROBE_SCALAR, k);
  } catch {
    throw new MeshCryptoError('low-order-point', what);
  }
  return k;
}
