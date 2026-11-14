// Frames: sign-then-encrypt, with the signature and the AEAD both bound to the outside header (T5 C4, C7).
//
//   header (outside, readable, CBOR): { v, set, to|null, group, gen, from, session, counter, kind }
//   aad        = canonical(header)
//   sig        = Ed25519( LABEL+"frame-sig\0" || u32(len aad) || aad || canonical(body) )
//   ciphertext = ChaCha20-Poly1305( key = K(frame, gen, from, session), nonce = 0^4 || u64(counter),
//                                   aad, canonical{ b: body, s: sig [, p: padding] } )
//   wire       = canonical{ h: header, c: ciphertext }
//
// WHY each choice (T5 gaps G1-G4, G18):
//  * from/gen/session/counter are OUTSIDE so a receiver can pick the key and nonce before it can
//    decrypt (G1); they are authenticated as AEAD associated data, so a keeper cannot edit them.
//  * EVERY frame is signed, including hello/beat/live (G4, G18): any holder of the generation
//    secret can encrypt, only the sender can sign, so a member cannot forge another device.
//  * `seq` is NOT here: the relay assigns it after sealing, so it is routing only (G3).
//
// ===== NONCE / PERSISTENCE CONTRACT (the part that must never be broken) =====
// ChaCha20-Poly1305 with a repeated (key, nonce) leaks the XOR of two plaintexts and the
// authentication key (RFC 8439 s2.3). So:
//  1. The AEAD key is derived per (generation, sender, SESSION); the nonce is only the counter.
//  2. `session` is 16 fresh random bytes chosen on EVERY PROCESS START (newSessionId()). A
//     FrameSender is created once per process start and its counter starts at 0.
//  3. A sender NEVER saves or restores its session or counter. This module exposes no way to set
//     the counter, and refuses to build a second FrameSender for the same (device, session) in one
//     process. A restored backup or VM snapshot that rewinds saved state therefore cannot cause
//     reuse: after a restart the sender has a NEW session, hence a NEW key.
//  4. The counter never restarts within a session and spans all generations/groups/kinds. At
//     MAX_FRAMES_PER_SESSION (2^32) the sender refuses to seal; the caller starts a new session.
//  5. Receivers DO persist: exportState()/importState() keep per-(sender, session) replay windows
//     so a restart cannot re-accept an old frame. A previously seen session never starts fresh.
import { aeadOpen, aeadSeal } from './aead';
import { LABEL, concat, ctEqual, random, toBuf, toHex, u32, u64, utf8, type Bytes } from './bytes';
import { CborValue, asArray, asBytes, asMap, asText, asUint, decode, encode, onlyKeys } from './cbor';
import { MeshCryptoError, guard } from './errors';
import { deviceIdFor, signWith, verifySig, type DeviceIdentity } from './identity';
import { frameKey } from './keys';

export const FRAME_VERSION = 1;
export const MAX_FRAMES_PER_SESSION = 2 ** 32;
/** Cap on one wire frame. Larger input is refused before any parsing work (design L-7). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_REPLAY_WINDOW = 1024;
const MIN_PAD_BUCKET = 256;

export const newSessionId = (): Buffer => random(16);

export interface FrameHeader {
  v: number;
  set: Buffer;
  to: Buffer | null;
  group: string;
  gen: number;
  from: Buffer;
  session: Buffer;
  counter: number;
  kind: string;
}

const HEADER_KEYS = ['v', 'set', 'to', 'group', 'gen', 'from', 'session', 'counter', 'kind'] as const;
const sigMessage = (aad: Bytes, bodyBytes: Bytes): Buffer => concat(utf8(LABEL + 'frame-sig\0'), u32(aad.length), aad, bodyBytes);
const nonceFor = (counter: number): Buffer => concat(Buffer.alloc(4), u64(counter));

function parseHeader(v: unknown): FrameHeader {
  const m = asMap(v, 'frame header');
  onlyKeys(m, HEADER_KEYS, 'frame header');
  const version = asUint(m.v, 'v');
  if (version !== FRAME_VERSION) throw new MeshCryptoError('unsupported-version', String(Math.min(version, 1e6)));
  const group = asText(m.group, 'group', 256);
  const kind = asText(m.kind, 'kind', 64);
  if (group.length === 0 || kind.length === 0) throw new MeshCryptoError('malformed', 'empty group or kind');
  return {
    v: version,
    set: asBytes(m.set, 'set', 32),
    to: m.to === null ? null : asBytes(m.to, 'to', 16),
    group,
    gen: asUint(m.gen, 'gen', 0xffffffff),
    from: asBytes(m.from, 'from', 16),
    session: asBytes(m.session, 'session', 16),
    counter: asUint(m.counter, 'counter', MAX_FRAMES_PER_SESSION - 1),
    kind,
  };
}
const headerValue = (h: FrameHeader): CborValue => ({ v: h.v, set: h.set, to: h.to, group: h.group, gen: h.gen, from: h.from, session: h.session, counter: h.counter, kind: h.kind });

/** Peek at the readable header only (what a keeper or a router needs). Does NOT authenticate anything. */
export function peekHeader(wire: Uint8Array): FrameHeader {
  return guard(() => {
    if (wire.length > MAX_FRAME_BYTES) throw new MeshCryptoError('too-large');
    const outer = asMap(decode(wire), 'frame');
    return parseHeader(outer.h);
  });
}

const usedSessions = new Set<string>();

export interface SealRequest {
  /** The set secret of generation `gen`. */
  secret: Bytes;
  gen: number;
  group: string;
  kind: string;
  body: CborValue;
  /** Recipient device id, or omitted/null for everyone. */
  to?: Bytes | null;
}

export class FrameSender {
  private counter = 0;
  readonly session: Buffer;
  private readonly limit: number;
  constructor(
    private readonly o: {
      identity: DeviceIdentity;
      setId: Bytes;
      /** Must come from newSessionId() at THIS process start. Explicit only for known-answer tests. */
      session?: Bytes;
      /** Pad the sealed body up to 256 then powers of two, so ciphertext length leaks less (threat model L-4). */
      padding?: 'none' | 'buckets';
      /** Lower the frame limit (tests exercise exhaustion without sending 2^32 frames). */
      maxFrames?: number;
    },
  ) {
    this.session = Buffer.from(o.session ?? newSessionId());
    if (this.session.length !== 16) throw new MeshCryptoError('invalid-argument', 'session must be 16 bytes');
    this.limit = Math.min(o.maxFrames ?? MAX_FRAMES_PER_SESSION, MAX_FRAMES_PER_SESSION);
    const key = toHex(o.identity.deviceId) + '/' + toHex(this.session);
    if (usedSessions.has(key)) throw new MeshCryptoError('session-reused');
    usedSessions.add(key);
  }
  /** How many frames this session has sealed (diagnostic; there is deliberately no setter). */
  get framesSealed(): number {
    return this.counter;
  }
  seal(req: SealRequest): Buffer {
    if (this.counter >= this.limit) throw new MeshCryptoError('counter-exhausted');
    const counter = this.counter;
    const header: FrameHeader = {
      v: FRAME_VERSION,
      set: Buffer.from(this.o.setId),
      to: req.to ? Buffer.from(req.to) : null,
      group: req.group,
      gen: req.gen,
      from: this.o.identity.deviceId,
      session: this.session,
      counter,
      kind: req.kind,
    };
    parseHeader(headerValue(header)); // same validation a receiver applies: never emit a frame we would refuse
    const aad = encode(headerValue(header));
    const bodyBytes = encode(req.body);
    const sig = signWith(this.o.identity, sigMessage(aad, bodyBytes));
    const inner: { [k: string]: CborValue } = { b: bodyBytes, s: sig };
    if (this.o.padding === 'buckets') {
      // Pad the WHOLE sealed inner map up to the bucket (256 bytes, then powers of two). The padding
      // field's own length header changes size at 24/256/65536 bytes, so search the few candidates
      // around the arithmetic answer and take the first that reaches the bucket.
      const base = encode({ ...inner, p: Buffer.alloc(0) }).length;
      let bucket = MIN_PAD_BUCKET;
      while (bucket < base) bucket *= 2;
      for (let n = Math.max(0, bucket - base - 3); ; n++) {
        const padded = { ...inner, p: Buffer.alloc(n) };
        if (encode(padded).length >= bucket) {
          inner.p = padded.p;
          break;
        }
      }
    }
    const key = frameKey(req.secret, this.o.setId, req.gen, header.from, this.session);
    const ct = aeadSeal(key, nonceFor(counter), aad, encode(inner));
    this.counter += 1; // advanced only after the frame is fully built
    return encode({ h: headerValue(header), c: ct });
  }
}

// ---- replay window, per (sender, session) ----
interface Window {
  high: number;
  seen: Set<number>;
}

export interface OpenedFrame {
  header: FrameHeader;
  body: CborValue;
  /** The sender's signing key from the roster, so callers can attribute without a second lookup. */
  signKey: Buffer;
}

export class FrameReceiver {
  private readonly windows = new Map<string, Window>();
  private readonly size: number;
  constructor(
    private readonly o: {
      setId: Bytes;
      /** This device's id; frames addressed to someone else are refused. Omit to accept any `to`. */
      selfDeviceId?: Bytes;
      secretFor: (gen: number) => Bytes | undefined;
      /** Roster lookup. Return undefined for an unknown device: the frame is refused with 'unknown-signer' (caller may PARK it). */
      signKeyFor: (deviceId: Buffer) => Bytes | undefined;
      windowSize?: number;
    },
  ) {
    this.size = o.windowSize ?? DEFAULT_REPLAY_WINDOW;
    if (!Number.isInteger(this.size) || this.size < 1) throw new MeshCryptoError('invalid-argument', 'window');
  }

  private check(h: FrameHeader): void {
    const w = this.windows.get(toHex(h.from) + '/' + toHex(h.session));
    if (!w || h.counter > w.high) return;
    if (h.counter <= w.high - this.size) throw new MeshCryptoError('out-of-window');
    if (w.seen.has(h.counter)) throw new MeshCryptoError('replay');
  }
  private record(h: FrameHeader): void {
    const k = toHex(h.from) + '/' + toHex(h.session);
    let w = this.windows.get(k);
    if (!w) this.windows.set(k, (w = { high: h.counter, seen: new Set() }));
    if (h.counter > w.high) w.high = h.counter;
    w.seen.add(h.counter);
    if (w.seen.size > 2 * this.size) for (const c of w.seen) if (c <= w.high - this.size) w.seen.delete(c);
  }

  /** Authenticate and decrypt one frame. Throws MeshCryptoError for every rejection; records the counter only AFTER everything verified. */
  open(wire: Uint8Array): OpenedFrame {
    return guard(() => {
      if (wire.length > MAX_FRAME_BYTES) throw new MeshCryptoError('too-large');
      const outer = asMap(decode(wire), 'frame');
      onlyKeys(outer, ['h', 'c'], 'frame');
      const h = parseHeader(outer.h);
      const ct = asBytes(outer.c, 'ciphertext');
      if (ct.length < 16) throw new MeshCryptoError('malformed', 'ciphertext');
      if (!ctEqual(h.set, toBuf(this.o.setId))) throw new MeshCryptoError('wrong-set');
      if (h.to && this.o.selfDeviceId && !ctEqual(h.to, toBuf(this.o.selfDeviceId))) throw new MeshCryptoError('not-addressed-to-me');
      const secret = this.o.secretFor(h.gen);
      if (!secret) throw new MeshCryptoError('unknown-generation');
      const signKey = this.o.signKeyFor(h.from);
      if (!signKey) throw new MeshCryptoError('unknown-signer');
      // WHY: the roster must agree the claimed id belongs to that key, or a lookup bug could attribute frames wrongly.
      if (!ctEqual(deviceIdFor(signKey), h.from)) throw new MeshCryptoError('unknown-signer');
      this.check(h); // cheap rejection before any decryption
      const aad = encode(headerValue(h)); // canonical, so equal to what the sender signed
      const key = frameKey(secret, this.o.setId, h.gen, h.from, h.session);
      let plain: Buffer;
      try {
        plain = aeadOpen(key, nonceFor(h.counter), aad, ct);
      } catch {
        throw new MeshCryptoError('auth-failed');
      }
      const inner = asMap(decode(plain), 'inner');
      onlyKeys(inner, ['b', 's', 'p'], 'inner');
      const bodyBytes = asBytes(inner.b, 'body');
      const sig = asBytes(inner.s, 'signature', 64);
      if (inner.p !== undefined) asBytes(inner.p, 'padding');
      if (!verifySig(signKey, sigMessage(aad, bodyBytes), sig)) throw new MeshCryptoError('bad-signature');
      const body = decode(bodyBytes);
      this.record(h); // only now, so junk can never poison the replay table
      return { header: h, body, signKey: Buffer.from(signKey) };
    });
  }

  /** Replay windows as bytes, for the (later) storage layer. Contains counters only, no secrets. */
  exportState(): Buffer {
    const e = [...this.windows.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, w]) => {
        const [f, s] = k.split('/');
        return { f: Buffer.from(f, 'hex'), s: Buffer.from(s, 'hex'), h: w.high, c: [...w.seen].sort((x, y) => x - y) };
      });
    return encode({ v: 1, w: this.size, e });
  }
  importState(bytes: Uint8Array): void {
    guard(() => {
      const m = asMap(decode(bytes), 'receiver state');
      onlyKeys(m, ['v', 'w', 'e'], 'receiver state');
      if (asUint(m.v, 'state version') !== 1) throw new MeshCryptoError('unsupported-version');
      const next = new Map<string, Window>();
      for (const raw of asArray(m.e, 'entries', 1_000_000)) {
        const en = asMap(raw, 'entry');
        onlyKeys(en, ['f', 's', 'h', 'c'], 'entry');
        const seen = new Set(asArray(en.c, 'counters', 2 * this.size + 1).map((c) => asUint(c, 'counter', MAX_FRAMES_PER_SESSION - 1)));
        next.set(toHex(asBytes(en.f, 'from', 16)) + '/' + toHex(asBytes(en.s, 'session', 16)), { high: asUint(en.h, 'high', MAX_FRAMES_PER_SESSION - 1), seen });
      }
      // Merge: keep the stronger (higher) record when both exist, never weaken what we already know.
      for (const [k, w] of next) {
        const cur = this.windows.get(k);
        if (!cur) this.windows.set(k, w);
        else {
          cur.high = Math.max(cur.high, w.high);
          for (const c of w.seen) cur.seen.add(c);
        }
      }
    });
  }
}
