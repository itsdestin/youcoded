// Key storage for the mesh (design 5.1 "Keys"): one sealed file per device holding the identity, every set
// secret generation, and the receiver's save counter.
//
// TWO LAYERS, so the OS part is a seam:
//  * SecretSealer: turns bytes into bytes only this user's OS login can open. Implementations:
//      - safeStorageSealer(): Electron's safeStorage (desktop) or the headless shim (Android). REFUSES when the
//        OS offers no real secret store. NEVER falls back to plaintext: that choice belongs to the product
//        owner (design 5.1, round-15 P-3) and the default answer is "refuse".
//      - insecureTestSealer(): plaintext, usable ONLY in mesh test mode, named so nobody mistakes it.
//  * MeshKeyStore: the file `<userData>/mesh/keys.bin` (written 0600 from its first byte, atomically, fsynced).
//
// ANDROID HOST CONTRACT (nothing is implemented in Kotlin here). The phone runs this same code through the headless
// boot, whose `safeStorage` stand-in (headless/electron-headless.ts) is keyed by a secret the Kotlin app keeps in
// the Android Keystore. For the mesh to start on a phone that stand-in must answer, truthfully:
//    isEncryptionAvailable() -> true only when the Keystore key really exists
//    getSelectedStorageBackend() -> 'android_keystore' ONLY when the Keystore was really used, anything else
//                                   (for example the plain-preferences fallback in PairedDeviceStore.kt:50-52) must
//                                   be reported as 'basic_text' so the mesh refuses to start.
// If the host cannot say, it must say 'unknown'; this module treats 'unknown' as refusal.
//
// NOTHING IN THIS FILE LOGS. Identity, secrets and counters are returned to the caller and never printed
// (an ast-grep/lint rule and tests/no-secret-logging pin the whole mesh folder).
import path from 'path';
import { asArray, asBytes, asMap, asText, asUint, decode, encode, onlyKeys } from './crypto/cbor';
import { LABEL } from './crypto/bytes';
import { generateIdentity, parseIdentity, serializeIdentity, type DeviceIdentity } from './crypto/identity';
import { readFileIfExists, writeFileDurable } from './fs-durable';

export type KeyStoreKind = 'os-secret-store' | 'insecure-test-file';
export interface SecretSealer {
  readonly kind: KeyStoreKind;
  seal(plain: Buffer): Buffer;
  open(sealed: Buffer): Buffer;
}

export type KeyStoreRefusal =
  | 'no-secret-store' // Linux basic_text / unknown: the OS keeps no real secret
  | 'unavailable' // safeStorage says it cannot encrypt right now
  | 'wrong-kind' // a file sealed by the other kind of sealer
  | 'corrupt' // not a mesh key file, or it failed to open
  | 'not-test-mode'; // the insecure sealer was asked for outside test mode
export class MeshKeyStoreRefused extends Error {
  constructor(readonly code: KeyStoreRefusal) {
    super(`mesh key store refused: ${code}`);
    this.name = 'MeshKeyStoreRefused';
  }
}

/** The part of Electron's safeStorage the mesh needs (the headless stand-in provides the same). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(sealed: Buffer): string;
  getSelectedStorageBackend?: () => string;
}

/** Backends that keep the secret in plain text or unknown places. Linux names; macOS/Windows do not report one. */
const REFUSED_BACKENDS = new Set(['basic_text', 'unknown']);

export function safeStorageSealer(ss: SafeStorageLike, platform: NodeJS.Platform = process.platform): SecretSealer {
  if (!ss.isEncryptionAvailable()) throw new MeshKeyStoreRefused('unavailable');
  const backend = ss.getSelectedStorageBackend?.();
  // WHY: on Linux a missing answer is treated like 'unknown'. Electron falls back to a hard-coded password
  // (basic_text) there, which is plaintext in all but name.
  if ((backend !== undefined && REFUSED_BACKENDS.has(backend)) || (backend === undefined && platform === 'linux')) {
    throw new MeshKeyStoreRefused('no-secret-store');
  }
  return {
    kind: 'os-secret-store',
    // safeStorage seals strings, so bytes travel as base64.
    seal: (plain) => ss.encryptString(plain.toString('base64')),
    open: (sealed) => Buffer.from(ss.decryptString(sealed), 'base64'),
  };
}

/** INSECURE: keeps keys in plain text. Only for a test rig whose homes are throwaway. Refuses outside test mode. */
export function insecureTestSealer(o: { testMode: boolean }): SecretSealer {
  if (!o.testMode) throw new MeshKeyStoreRefused('not-test-mode');
  return { kind: 'insecure-test-file', seal: (p) => Buffer.from(p), open: (s) => Buffer.from(s) };
}

export interface MeshKeys {
  identity: DeviceIdentity;
  /** generation -> 32-byte set secret. Empty until the device is in a set. */
  secrets: Map<number, Buffer>;
  /** The set this device belongs to (room name), or null before it is in one. */
  setId: Buffer | null;
  /** Highest receiver-state save number this device has written (rollback tripwire; see link.ts). */
  receiverSaves: number;
}

const MAGIC = Buffer.from('YCMK');
const KIND_BYTE: Record<KeyStoreKind, number> = { 'os-secret-store': 1, 'insecure-test-file': 0 };
const BLOB_LABEL = LABEL + 'keys-file';

function encodeKeys(k: MeshKeys): Buffer {
  return encode({
    v: 1,
    // WHY the label inside: a sealed blob carries its own purpose so it cannot be swapped for another sealed blob
    // the same OS key made (design 5.1, T5 finding 17).
    label: BLOB_LABEL,
    identity: serializeIdentity(k.identity),
    setId: k.setId,
    secrets: [...k.secrets.entries()].sort((a, b) => a[0] - b[0]).map(([g, s]) => ({ g, s })),
    saves: k.receiverSaves,
  });
}
function decodeKeys(plain: Buffer): MeshKeys {
  const m = asMap(decode(plain), 'keys');
  onlyKeys(m, ['v', 'label', 'identity', 'setId', 'secrets', 'saves'], 'keys');
  if (asUint(m.v, 'v') !== 1 || asText(m.label, 'label') !== BLOB_LABEL) throw new MeshKeyStoreRefused('corrupt');
  const secrets = new Map<number, Buffer>();
  for (const e of asArray(m.secrets, 'secrets', 64)) {
    const em = asMap(e, 'secret');
    secrets.set(asUint(em.g, 'g', 0xffffffff), asBytes(em.s, 's', 32));
  }
  return { identity: parseIdentity(asBytes(m.identity, 'identity')), setId: m.setId === null ? null : asBytes(m.setId, 'setId', 32), secrets, receiverSaves: asUint(m.saves, 'saves') };
}

export class MeshKeyStore {
  readonly file: string;
  #queue: Promise<unknown> = Promise.resolve();
  #cache: MeshKeys | null = null;
  constructor(meshDir: string, private readonly sealer: SecretSealer) {
    this.file = path.join(meshDir, 'keys.bin');
  }
  get kind(): KeyStoreKind {
    return this.sealer.kind;
  }

  /** The stored keys, or null when none exist yet (first enable). Never creates anything. */
  async load(): Promise<MeshKeys | null> {
    if (this.#cache) return this.#cache;
    const raw = await readFileIfExists(this.file);
    if (!raw) return null;
    if (raw.length < MAGIC.length + 1 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new MeshKeyStoreRefused('corrupt');
    if (raw[MAGIC.length] !== KIND_BYTE[this.sealer.kind]) throw new MeshKeyStoreRefused('wrong-kind');
    try {
      this.#cache = decodeKeys(this.sealer.open(raw.subarray(MAGIC.length + 1)));
    } catch (e) {
      if (e instanceof MeshKeyStoreRefused) throw e;
      throw new MeshKeyStoreRefused('corrupt'); // never include the underlying error: it could echo bytes
    }
    return this.#cache;
  }

  /** Identity is created on FIRST ENABLE and kept; later calls return what is stored. */
  async loadOrCreate(): Promise<MeshKeys> {
    const have = await this.load();
    if (have) return have;
    const fresh: MeshKeys = { identity: generateIdentity(), secrets: new Map(), setId: null, receiverSaves: 0 };
    await this.write(fresh);
    return fresh;
  }

  /** Change the stored keys. Writes are queued so two callers cannot interleave; the file is replaced durably. */
  update(mutate: (k: MeshKeys) => void): Promise<MeshKeys> {
    const run = async (): Promise<MeshKeys> => {
      const cur = await this.loadOrCreate();
      const next: MeshKeys = { ...cur, secrets: new Map(cur.secrets) };
      mutate(next);
      await this.write(next);
      return next;
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => undefined);
    return p;
  }

  private async write(k: MeshKeys): Promise<void> {
    const body = Buffer.concat([MAGIC, Buffer.from([KIND_BYTE[this.sealer.kind]]), this.sealer.seal(encodeKeys(k))]);
    await writeFileDurable(this.file, body, 0o600);
    this.#cache = k;
  }
}
