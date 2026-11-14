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
//     process. Restoring SAVED state (a backup, a disk image, a rewound file) therefore cannot cause
//     reuse: after a restart the sender has a NEW session, hence a NEW key.
//     NOT GUARANTEED, and not provable from JavaScript: a snapshot of the RUNNING process (a VM or
//     container checkpoint, a hibernation image) resumed more than once. Every copy holds the same
//     session and counter, so two copies would encrypt different frames under one (key, nonce). The
//     deployment must not resume one running sender twice; this is an accepted limit, not a property.
//  4. The counter never restarts within a session and spans all generations/groups/kinds. At
//     MAX_FRAMES_PER_SESSION (2^32) the sender refuses to seal; the caller starts a new session.
//
// ===== RECEIVER STATE CONTRACT (replay protection) =====
// The relay STORES frames and may deliver them in any order, so a frame older than the newest one
// seen is normal, not suspicious. The receiver therefore remembers EXACTLY which counters it has
// accepted for each (sender, session), as a sorted list of closed intervals, and refuses only those.
//  * What the CALLER must do: call exportState() after frames are applied and store the bytes
//    durably BEFORE it tells the relay a frame was handled or deletes it; call importState() with the
//    latest bytes at start. The state holds counters and device/session ids only, no secrets.
//  * Bounded memory, stated honestly: at most `maxRangesPerSession` intervals per session (default
//    4096) and `maxSessions` sessions (default 10,000). Over the interval limit the OLDEST gaps are
//    closed (counters below the closed point are refused as 'out-of-window', never accepted again);
//    recent gaps always stay fillable. Over the session limit the least recently active session is
//    forgotten, which means a replay of that old session's frames would be accepted once more.
//  * GUARANTEED: a counter recorded in the receiver's current state is refused; junk never enters the
//    table (it is recorded only after the signature verified).
//  * NOT GUARANTEED: protection against restoring OLDER receiver state. Frames applied after that
//    older save are forgotten and would be accepted again. The module cannot see it. What it offers:
//    every export carries a save number (`saveCounter`, increasing by one per export); the caller
//    keeps the latest number in a separate place that does not roll back with the state file (the OS
//    secret store entry that holds the device identity is the natural spot) and passes it as
//    `importState(bytes, { minSaveCounter })`, which refuses an older file with 'stale-state'. After
//    that refusal the caller must not carry on as if nothing happened: frames applied since will
//    repeat, so every handler of repeatable frames must be idempotent (log entries are, by entry
//    id) and the receiver should re-sync from the roster/log instead of trusting live frames.
import { aeadOpen, aeadSeal } from './aead';
import { LABEL, concat, ctEqual, random, toBuf, toHex, u32, u64, utf8, type Bytes } from './bytes';
import { CborValue, asArray, asBytes, asMap, asText, asUint, decode, encode, onlyKeys } from './cbor';
import { MeshCryptoError, callerCall, guard } from './errors';
import { deviceIdFor, signWith, verifySig, type DeviceIdentity } from './identity';
import { frameKey } from './keys';

export const FRAME_VERSION = 1;
export const MAX_FRAMES_PER_SESSION = 2 ** 32;
/** Cap on one wire frame. Larger input is refused before any parsing work (design L-7). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_RANGES = 4096;
export const DEFAULT_MAX_SESSIONS = 10_000;
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

// ---- exact replay tracking, per (sender, session) ----
const MAX_COUNTER = MAX_FRAMES_PER_SESSION - 1;
/**
 * The counters accepted for one session: sorted, disjoint, non-adjacent closed intervals stored flat
 * as [lo0, hi0, lo1, hi1, ...], plus `closedUpTo` (every counter at or below it is refused: the oldest
 * gaps were closed to stay inside the memory bound). -1 means nothing closed.
 */
class SeenSet {
  r: number[] = [];
  closedUpTo = -1;
  /** Index of the first interval whose hi >= c (binary search over the flat list). */
  private find(c: number): number {
    let lo = 0;
    let hi = this.r.length / 2;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.r[2 * mid + 1] < c) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  has(c: number): boolean {
    const i = this.find(c);
    return i < this.r.length / 2 && this.r[2 * i] <= c;
  }
  addRange(lo: number, hi: number): void {
    // Intervals that overlap or touch [lo, hi] are merged into it.
    let i = this.find(lo - 1);
    let j = i;
    let nlo = lo;
    let nhi = hi;
    while (j < this.r.length / 2 && this.r[2 * j] <= hi + 1) {
      nlo = Math.min(nlo, this.r[2 * j]);
      nhi = Math.max(nhi, this.r[2 * j + 1]);
      j++;
    }
    this.r.splice(2 * i, 2 * (j - i), nlo, nhi);
  }
  /** Close the oldest gaps until at most `max` intervals remain. */
  bound(max: number): void {
    while (this.r.length / 2 > max) {
      this.closedUpTo = Math.max(this.closedUpTo, this.r[3]); // everything up to the second interval's end is now "seen"
      this.r.splice(0, 4, this.r[0], this.r[3]);
    }
  }
}

export interface OpenedFrame {
  header: FrameHeader;
  body: CborValue;
  /** The sender's signing key from the roster, so callers can attribute without a second lookup. */
  signKey: Buffer;
}

const STATE_VERSION = 2;

export class FrameReceiver {
  // Insertion order = recency of activity (oldest first), which is also the order persisted.
  readonly #sessions = new Map<string, SeenSet>();
  readonly #maxRanges: number;
  readonly #maxSessions: number;
  #saves = 0;
  constructor(
    private readonly o: {
      setId: Bytes;
      /** This device's id; frames addressed to someone else are refused. Omit to accept any `to`. */
      selfDeviceId?: Bytes;
      secretFor: (gen: number) => Bytes | undefined;
      /**
       * Roster lookup. Return undefined for an unknown device: the frame is refused with 'unknown-signer'
       * (caller may PARK it). Whether a device that has been REMOVED still counts is the caller's rule:
       * this module verifies against whatever key the callback returns (roster.ts has the facts).
       */
      signKeyFor: (deviceId: Buffer) => Bytes | undefined;
      /** Intervals remembered per (sender, session) before the oldest gaps are closed. */
      maxRangesPerSession?: number;
      /** (sender, session) pairs remembered before the least recently active is forgotten. */
      maxSessions?: number;
    },
  ) {
    this.#maxRanges = o.maxRangesPerSession ?? DEFAULT_MAX_RANGES;
    this.#maxSessions = o.maxSessions ?? DEFAULT_MAX_SESSIONS;
    if (!Number.isInteger(this.#maxRanges) || this.#maxRanges < 1) throw new MeshCryptoError('invalid-argument', 'maxRangesPerSession');
    if (!Number.isInteger(this.#maxSessions) || this.#maxSessions < 1) throw new MeshCryptoError('invalid-argument', 'maxSessions');
  }

  /** How many times exportState() has produced a save (and the highest imported): the caller's rollback tripwire. */
  get saveCounter(): number {
    return this.#saves;
  }

  private check(h: FrameHeader): void {
    const s = this.#sessions.get(toHex(h.from) + '/' + toHex(h.session));
    if (!s) return;
    if (h.counter <= s.closedUpTo) throw new MeshCryptoError('out-of-window');
    if (s.has(h.counter)) throw new MeshCryptoError('replay');
  }
  private record(h: FrameHeader): void {
    const k = toHex(h.from) + '/' + toHex(h.session);
    let s = this.#sessions.get(k);
    if (s) this.#sessions.delete(k); // re-inserted below so the map stays in recency order
    else s = new SeenSet();
    s.addRange(h.counter, h.counter);
    s.bound(this.#maxRanges);
    this.#sessions.set(k, s);
    while (this.#sessions.size > this.#maxSessions) this.#sessions.delete(this.#sessions.keys().next().value as string);
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
      const secret = callerCall(() => this.o.secretFor(h.gen));
      if (!secret) throw new MeshCryptoError('unknown-generation');
      const signKey = callerCall(() => this.o.signKeyFor(h.from));
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

  /** Receiver state as bytes, for the (later) storage layer. Counters and ids only, no secrets. See the contract above. */
  exportState(): Buffer {
    this.#saves += 1;
    const e = [...this.#sessions.entries()].map(([k, s]) => {
      const [f, sess] = k.split('/');
      return { f: Buffer.from(f, 'hex'), s: Buffer.from(sess, 'hex'), k: s.closedUpTo + 1, r: s.r };
    });
    return encode({ v: STATE_VERSION, n: this.#saves, e });
  }
  /** Merge saved state in. Never forgets what is already known. `minSaveCounter` makes an older file a 'stale-state' error. */
  importState(bytes: Uint8Array, opts: { minSaveCounter?: number } = {}): void {
    guard(() => {
      const m = asMap(decode(bytes), 'receiver state');
      if (asUint(m.v, 'state version') !== STATE_VERSION) throw new MeshCryptoError('unsupported-version');
      onlyKeys(m, ['v', 'n', 'e'], 'receiver state');
      const n = asUint(m.n, 'save counter');
      if (opts.minSaveCounter !== undefined && n < opts.minSaveCounter) throw new MeshCryptoError('stale-state');
      const next: [string, SeenSet][] = [];
      for (const raw of asArray(m.e, 'entries', 1_000_000)) {
        const en = asMap(raw, 'entry');
        onlyKeys(en, ['f', 's', 'k', 'r'], 'entry');
        const flat = asArray(en.r, 'ranges', 2 * this.#maxRanges + 2).map((c) => asUint(c, 'counter', MAX_COUNTER));
        if (flat.length % 2 !== 0) throw new MeshCryptoError('malformed', 'ranges');
        // Canonical form only: lo <= hi, and each interval strictly after the previous with a real gap between.
        for (let i = 0; i < flat.length; i += 2) {
          if (flat[i] > flat[i + 1] || (i > 0 && flat[i] <= flat[i - 1] + 1)) throw new MeshCryptoError('malformed', 'ranges');
        }
        const s = new SeenSet();
        s.r = flat;
        s.closedUpTo = asUint(en.k, 'closed', MAX_COUNTER + 1) - 1;
        next.push([toHex(asBytes(en.f, 'from', 16)) + '/' + toHex(asBytes(en.s, 'session', 16)), s]);
      }
      // Merge: union of intervals, higher closed point; an existing session keeps its recency unless the file is the newer word.
      for (const [k, w] of next) {
        const cur = this.#sessions.get(k);
        if (!cur) this.#sessions.set(k, w);
        else {
          cur.closedUpTo = Math.max(cur.closedUpTo, w.closedUpTo);
          for (let i = 0; i < w.r.length; i += 2) cur.addRange(w.r[i], w.r[i + 1]);
          cur.bound(this.#maxRanges);
        }
        const s = this.#sessions.get(k) as SeenSet;
        s.bound(this.#maxRanges);
      }
      while (this.#sessions.size > this.#maxSessions) this.#sessions.delete(this.#sessions.keys().next().value as string);
      this.#saves = Math.max(this.#saves, n);
    });
  }
}
