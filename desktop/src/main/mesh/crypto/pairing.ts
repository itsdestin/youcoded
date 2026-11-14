// Pairing: QR and typed short code, ONE protocol for both (T5 part B, finding 7).
//
// Both run CPace (cpace.ts) with the secret as the password. The QR secret is 128 random bits and
// the QR also carries the existing device's key fingerprint; the typed code is 6 characters of a
// 32-symbol alphabet (30 bits). This file is transport-free: it takes and returns BYTES. The relay
// is only a pipe and is ASSUMED HOSTILE (design 5.1, threat model P-1).
//
// Flow (N = new device, E = existing device in the set):
//   N->E pake1 {Y}          E->N pake2 {Y}
//   N->E cN {mac}           E checks the mac: THE GUESS IS COUNTED HERE, on E, before anything
//                           else happens -> E->N cE {mac, commit}   (commit = H(E's fresh nonce nE))
//   N->E hello  (sealed under the session key: name, keys, proof of possession, commit = H(nN))
//   E->N reveal {nE}        (sealed; sent only after E holds N's commit)
//   N->E reveal {nN}        (sealed; sent only after N checked nE against E's commit)
//                           E raises "Add this device?" -- ONLY now, so the name on screen belongs
//                           to someone who proved they hold the code (threat model P-8) AND the
//                           matching number is final. Both screens show the number.
//   E->N welcome (sealed under the session key: signed roster + every set-secret generation, each
//                 HPKE-sealed to N's agreement key)
//
// The matching number (finding 2 of the independent review): number = H(transcript, nN, nE) as
// SAS_DIGITS decimal digits. Each side COMMITS to a fresh random nonce before it has seen the other's
// and only reveals after holding the other's commitment, so a middle party that knows the code (the
// shoulder-surfer case) must fix both of its nonces before it can see either honest one. The number
// on each honest screen then depends on a value the attacker could not know, and it gets exactly one
// try per code (E spends the code at the first confirmed connection): success <= 10^-SAS_DIGITS.
// The old number, a hash of the session key alone, could be ground offline against the other leg.
//
// Failure budget: MAX_FAILURES failed attempts per code, counted on E, then the code is burned. An
// attempt fails when a confirmation does not match, when a pake1 is malformed or a low-order point,
// or when a connection that has done pake1 but not yet confirmed sends anything unparseable. The
// budget is checked BEFORE a confirmation is evaluated, so a 4th guess is never even tested, however
// many connections are open at once. A success also spends the code.
// Why a failed or dropped attempt gives an attacker only the one guess it was built from: E sends
// nothing that depends on the code until N's confirmation checked out, so there is nothing to test
// offline.
//
// onMessage never throws for hostile input: garbage, out-of-order and oversized messages are
// ignored and cost the sender its connection (and, before confirmation, one try).
import { LABEL, concat, ctEqual, hkdfSha256, hmacSha256, random, requireLen, sha256, toBuf, toHex, u32, u64, utf8, type Bytes } from './bytes';
import { aeadOpen, aeadSeal } from './aead';
import { CborValue, asArray, asBytes, asMap, asText, asUint, decode, encode, onlyKeys } from './cbor';
import { CPace, calculateGenerator } from './cpace';
import { MeshCryptoError } from './errors';
import { fingerprintFor, deviceIdFor, INSPECT_CUSTOM, requireAgreeKey, signWith, verifySig, type DeviceIdentity } from './identity';
import { openSecret, sealSecretTo } from './keygen';
import { SET_SECRET_LENGTH } from './keys';
import { MAX_ROSTER_ENTRIES, entryToValue, makeAddEntry, parseEntryValue, sanitizeDeviceName, sanitizePlatform, seenForNextEntry, verifyRosterLog, type RosterDevice, type SignedEntry } from './roster';

// ---- product-format constants. The final code format is a PENDING product choice: change here only. ----
/** 32 symbols = exactly 5 bits each. Excludes 0, 1, I and O (look-alikes); L stays because 1 and I are gone. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LENGTH = 6;
export const MAX_FAILURES = 3;
export const INVITE_LIFETIME_MS = 5 * 60_000;
/** After confirmation, how long the user has to answer "Add this device?". */
export const PROMPT_LIFETIME_MS = 2 * 60_000;
export const MIN_ROOM_BYTES = 8; // 64 bits: threat model P-3
export const MAX_CONNECTIONS = 16;
// WHY 4 MiB (was 2): a welcome carries the whole signed roster, up to MAX_ROSTER_ENTRIES entries.
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** Digits of the matching number, a constant on both sides. One guess succeeds with probability 10^-SAS_DIGITS. */
export const SAS_DIGITS = 6;
const SAS_NONCE_BYTES = 16;
const MAX_GENERATIONS = 64;
const HALF_OPEN_TTL_MS = 60_000;

export type PairMode = 'qr' | 'code';

/** Uniform random code. 256 is a multiple of 32, so masking gives each symbol exactly 1/32 (no bias). */
export function generateCode(length = CODE_LENGTH): string {
  const b = random(length);
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[b[i] & 31];
  return s;
}
/** Accept what a person types: any case, spaces and dashes ignored. Throws 'invalid-code' otherwise. */
export function normalizeCode(input: string, length = CODE_LENGTH): string {
  const s = String(input).toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== length) throw new MeshCryptoError('invalid-code');
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) throw new MeshCryptoError('invalid-code');
  return s;
}

/**
 * The matching number both screens show (T5 G15, threat model P-4): SAS_DIGITS decimal digits of
 * H(transcript, nonceN, nonceE). `transcript` is the 32-byte hash both sides computed over every
 * pairing message so far; the nonces are the two revealed commit-then-reveal values.
 */
export function shortAuthString(p: { transcript: Bytes; nonceN: Bytes; nonceE: Bytes }): string {
  const h = sha256(utf8(LABEL + 'pair/sas/v2\0'), requireLen(p.transcript, 32, 'transcript'), requireLen(p.nonceN, SAS_NONCE_BYTES, 'nonce'), requireLen(p.nonceE, SAS_NONCE_BYTES, 'nonce'));
  // 64 bits mod 10^6: the modulo bias is about 10^-13, far below anything that matters.
  return String(h.readBigUInt64BE(0) % 10n ** BigInt(SAS_DIGITS)).padStart(SAS_DIGITS, '0');
}
const sasCommit = (who: 'N' | 'E', nonce: Bytes): Buffer => sha256(utf8(LABEL + 'pair/sas-commit/' + who + '\0'), requireLen(nonce, SAS_NONCE_BYTES, 'nonce'));

/** A running hash over every pairing message, in order, as raw wire bytes. Both honest sides build the same one. */
class Transcript {
  private readonly parts: Buffer[] = [];
  add(tag: string, bytes: Bytes): void {
    this.parts.push(concat(u32(tag.length), utf8(tag), u32(bytes.length), bytes));
  }
  digest(): Buffer {
    return sha256(utf8(LABEL + 'pair/transcript\0'), ...this.parts);
  }
}

const sidFor = (room: Bytes): Buffer => sha256(utf8(LABEL + 'pair/sid\0'), room).subarray(0, 16);
const ciFor = (mode: PairMode): Buffer => encode([LABEL + 'pair', mode]);
const pairKeys = (isk: Bytes, sid: Bytes) => ({
  kcN: hkdfSha256(isk, sid, utf8(LABEL + 'pair/confirm-N')),
  kcE: hkdfSha256(isk, sid, utf8(LABEL + 'pair/confirm-E')),
  kNE: hkdfSha256(isk, sid, utf8(LABEL + 'pair/enc-N2E')),
  kEN: hkdfSha256(isk, sid, utf8(LABEL + 'pair/enc-E2N')),
});
const confirmMac = (k: Bytes, who: 'N' | 'E'): Buffer => hmacSha256(k, utf8(LABEL + 'pair/confirm/' + who));

// Each key now carries two messages per direction (hello then reveal; reveal then welcome), so the nonce is
// the message's index under that key (0, 1): never repeated under one key. The first message of each
// direction keeps the all-zero nonce it always had.
const nonceAt = (n: number): Buffer => concat(Buffer.alloc(4), u64(n));
function seal(key: Bytes, sid: Bytes, dir: string, n: number, obj: CborValue): Buffer {
  return aeadSeal(key, nonceAt(n), concat(sid, utf8(dir)), encode(obj));
}
function open(key: Bytes, sid: Bytes, dir: string, n: number, ct: Buffer): CborValue {
  if (ct.length < 16) throw new MeshCryptoError('malformed', 'sealed');
  let plain: Buffer;
  try {
    plain = aeadOpen(key, nonceAt(n), concat(sid, utf8(dir)), ct);
  } catch {
    throw new MeshCryptoError('auth-failed', 'sealed');
  }
  return decode(plain);
}
const readReveal = (v: CborValue): Buffer => {
  const m = asMap(v, 'reveal');
  onlyKeys(m, ['n'], 'reveal');
  return asBytes(m.n, 'nonce', SAS_NONCE_BYTES);
};
// Proofs of possession are bound to THIS session through a hash of the PAKE output, so a signed blob cannot be reused elsewhere.
// N signs only its own keys (it does not know E's yet); E signs both, so E's proof also pins which new device it admitted.
const popN = (isk: Bytes, signKey: Bytes, agreeKey: Bytes): Buffer => concat(utf8(LABEL + 'pair-pop-N\0'), sha256(isk), signKey, agreeKey);
const popE = (isk: Bytes, n: { signKey: Bytes; agreeKey: Bytes }, e: { signKey: Bytes; agreeKey: Bytes }): Buffer =>
  concat(utf8(LABEL + 'pair-pop-E\0'), sha256(isk), n.signKey, n.agreeKey, e.signKey, e.agreeKey);

const msg = (t: string, extra: { [k: string]: CborValue } = {}): Buffer => encode({ t, ...extra });

/**
 * A pairing invite. The code and the QR secret are held in #private fields: the caller reads them by
 * name when it must show them, but JSON.stringify, util.inspect and toString never print them.
 */
export class Invite {
  readonly mode: PairMode;
  /** Meeting point. Random, NEVER derived from the secret (a relay could otherwise test guesses against it). */
  readonly room: Buffer;
  /** Existing device's key fingerprint, carried by the QR. */
  readonly fingerprint: Buffer;
  readonly expiresAt: number;
  readonly #secret: Buffer;
  readonly #code: string | undefined;
  constructor(o: { mode: PairMode; room: Buffer; secret: Buffer; code?: string; fingerprint: Buffer; expiresAt: number }) {
    this.mode = o.mode;
    this.room = o.room;
    this.fingerprint = o.fingerprint;
    this.expiresAt = o.expiresAt;
    this.#secret = o.secret;
    this.#code = o.code;
  }
  /** The password fed to CPace: the typed code's characters, or 16 random bytes for a QR. SECRET. */
  get secret(): Buffer {
    return this.#secret;
  }
  /** For a typed code, the characters to show (the room part is displayed separately by the caller). SECRET. */
  get code(): string | undefined {
    return this.#code;
  }
  toString(): string {
    return `[Invite ${this.mode}]`;
  }
  toJSON(): { mode: PairMode; room: string; expiresAt: number } {
    return { mode: this.mode, room: this.room.toString('hex'), expiresAt: this.expiresAt };
  }
  [INSPECT_CUSTOM](): string {
    return this.toString();
  }
}

export interface ExistingState {
  setId: Bytes;
  /** generation -> 32-byte set secret */
  secrets: Map<number, Bytes>;
  /** The signed roster log, genesis first. */
  roster: SignedEntry[];
}
export interface AddPromptInfo {
  /** Sanitised (control/bidi stripped, 40 chars). */
  name: string;
  platform: string;
  /** Short key fingerprint, to show on the prompt next to the name (threat model P-5). */
  fingerprint: string;
  /** Matching number to show on both screens. */
  sas: string;
}
export interface ExistingOptions {
  /**
   * Called when a device has proven it holds the code. Return true/false to answer immediately, or
   * return undefined and call `decide()` later (the normal case: a human answers).
   */
  onAddPrompt: (info: AddPromptInfo, conn: string) => boolean | undefined;
  /** Called with the new signed `add` entry when a welcome is sent; the caller persists it. */
  onAdded?: (entry: SignedEntry) => void;
  now?: () => number;
  /**
   * TEST SEAMS ONLY (like FrameSender's `session`): production never sets these.
   * `newCode` supplies the typed code instead of a random one, so an attack test can play a middle
   * party that already knows it. `testHooks.revealNonce` reveals a nonce other than the committed one.
   */
  newCode?: () => string;
  testHooks?: { revealNonce?: Buffer };
}

interface Conn {
  stage: 'await-confirm' | 'await-hello' | 'await-reveal' | 'await-decision';
  sid: Buffer;
  k: ReturnType<typeof pairKeys>;
  isk: Buffer;
  born: number;
  tr: Transcript;
  nonceE: Buffer;
  commitN?: Buffer;
  sas?: string;
  pending?: { name: string; platform: string; signKey: Buffer; agreeKey: Buffer; deadline: number };
}

/** The existing device. */
export class Existing {
  readonly events: string[] = [];
  readonly #conns = new Map<string, Conn>();
  readonly #now: () => number;
  readonly #id: DeviceIdentity;
  readonly #state: ExistingState;
  readonly #o: ExistingOptions;
  #invite?: Invite;
  /** The code-dependent CPace generator, derived ONCE per invite (see cpace.ts G21). */
  #generator?: Buffer;
  #failures = 0;
  #evaluated = 0;
  #burned = false;
  #used = false;

  constructor(id: DeviceIdentity, state: ExistingState, o: ExistingOptions) {
    this.#id = id;
    this.#state = state;
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }
  toString(): string {
    return '[Existing]';
  }
  toJSON(): { events: string[] } {
    return { events: this.events };
  }
  [INSPECT_CUSTOM](): string {
    return this.toString();
  }

  /** Make a one-time invite. `room` comes from the relay's meeting-point allocator (>= 8 random bytes); random if omitted. */
  openInvite(mode: PairMode, room: Bytes = random(MIN_ROOM_BYTES)): Invite {
    if (room.length < MIN_ROOM_BYTES) throw new MeshCryptoError('invalid-argument', 'meeting point too short');
    this.#conns.clear();
    this.#failures = this.#evaluated = 0;
    this.#burned = this.#used = false;
    const code = mode === 'code' ? (this.#o.newCode ?? generateCode)() : undefined;
    const secret = code ? utf8(code) : random(16);
    const roomCopy = Buffer.from(room);
    // WHY here, once: the generator depends only on (code, mode, room), all fixed for this invite. Deriving it
    // per incoming pake1 let the relay trigger the variable-time, code-dependent maths at will.
    this.#generator = calculateGenerator(secret, ciFor(mode), sidFor(roomCopy));
    this.#invite = new Invite({ mode, room: roomCopy, secret, code, fingerprint: fingerprintFor(this.#id.signKey, this.#id.agreeKey), expiresAt: this.#now() + INVITE_LIFETIME_MS });
    return this.#invite;
  }
  get failureCount(): number {
    return this.#failures;
  }
  get evaluatedCount(): number {
    return this.#evaluated;
  }
  get isBurned(): boolean {
    return this.#burned;
  }
  get isSpent(): boolean {
    return this.#used;
  }
  private budgetLeft(): boolean {
    return !!this.#invite && !this.#burned && !this.#used && this.#failures < MAX_FAILURES && this.#now() < this.#invite.expiresAt;
  }
  private fail(why: string): void {
    this.#failures++;
    this.events.push('fail:' + why);
    if (this.#failures >= MAX_FAILURES) {
      this.#burned = true;
      this.events.push('burned');
    }
  }
  /** The transport reports a closed connection. */
  dropConnection(conn: string): void {
    this.#conns.delete(conn);
  }

  /** Feed one message from one connection (any connection: the pipe is hostile). Returns messages for THAT connection. */
  onMessage(conn: string, bytes: Uint8Array): Buffer[] {
    try {
      return this.handle(conn, bytes);
    } catch (e) {
      if (e instanceof MeshCryptoError) {
        // WHY: a connection that did pake1 but has not confirmed is still an ATTEMPT AT THE CODE; garbage there
        // must cost a try like a wrong confirmation does, or the sender gets free work out of us.
        if (this.#conns.get(conn)?.stage === 'await-confirm') this.fail('malformed');
        this.#conns.delete(conn);
        return [];
      }
      throw e; // a bug in this file, not hostile input
    }
  }

  private handle(conn: string, bytes: Uint8Array): Buffer[] {
    if (bytes.length > MAX_MESSAGE_BYTES || !this.#invite || !this.#generator) return [];
    const m = asMap(decode(bytes), 'pairing message');
    const t = asText(m.t, 't', 16);
    const c = this.#conns.get(conn);

    if (t === 'pake1') {
      if (!this.budgetLeft()) return [msg('closed')];
      let Y: Buffer;
      try {
        onlyKeys(m, ['t', 'Y'], 'pake1');
        Y = asBytes(m.Y, 'Y', 32);
      } catch (e) {
        if (e instanceof MeshCryptoError) this.fail('bad pake1'); // a malformed attempt at the code costs a try
        throw e;
      }
      if (this.#conns.size >= MAX_CONNECTIONS) {
        // Bound memory: first drop half-open connections that have sat idle, then refuse.
        for (const [k, v] of this.#conns) if (v.stage === 'await-confirm' && this.#now() - v.born > HALF_OPEN_TTL_MS) this.#conns.delete(k);
        if (this.#conns.size >= MAX_CONNECTIONS) return [msg('busy')];
      }
      const sid = sidFor(this.#invite.room);
      const cp = new CPace({ prs: this.#invite.secret, ci: ciFor(this.#invite.mode), sid, role: 'responder', generator: this.#generator });
      const isk = cp.finish({ Y, AD: Buffer.alloc(0) });
      if (!isk) {
        this.fail('low-order point');
        return [msg('rejected')];
      }
      const pake2 = msg('pake2', { Y: cp.Y });
      const tr = new Transcript();
      tr.add('pake1', bytes);
      tr.add('pake2', pake2);
      this.#conns.set(conn, { stage: 'await-confirm', sid, k: pairKeys(isk, sid), isk, born: this.#now(), tr, nonceE: random(SAS_NONCE_BYTES) });
      this.events.push('pake1');
      return [pake2];
    }
    if (!c) return []; // out of order or injected: ignored, not counted

    if (t === 'cN' && c.stage === 'await-confirm') {
      onlyKeys(m, ['t', 'mac'], 'cN');
      const mac = asBytes(m.mac, 'mac', 32);
      if (!this.budgetLeft()) {
        this.#conns.delete(conn);
        return [msg('closed')]; // checked BEFORE evaluating: no 4th guess
      }
      this.#evaluated++;
      if (!ctEqual(mac, confirmMac(c.k.kcN, 'N'))) {
        this.#conns.delete(conn);
        this.fail('bad confirmation');
        return [msg('rejected')];
      }
      this.#used = true; // one successful pairing per code
      c.stage = 'await-hello';
      this.events.push('confirm-ok');
      // E COMMITS to its matching-number nonce here, before it has seen anything from N beyond the proof of the code.
      const cE = msg('cE', { mac: confirmMac(c.k.kcE, 'E'), commit: sasCommit('E', c.nonceE) });
      c.tr.add('cN', bytes);
      c.tr.add('cE', cE);
      return [cE];
    }

    if (t === 'hello' && c.stage === 'await-hello') {
      onlyKeys(m, ['t', 'ct'], 'hello');
      const hi = asMap(open(c.k.kNE, c.sid, 'N2E', 0, asBytes(m.ct, 'ct')), 'hello body');
      onlyKeys(hi, ['name', 'platform', 'signKey', 'agreeKey', 'pop', 'commit'], 'hello body');
      const n = {
        name: sanitizeDeviceName(asText(hi.name, 'name', 200)),
        platform: sanitizePlatform(asText(hi.platform, 'platform', 200)),
        signKey: asBytes(hi.signKey, 'signKey', 32),
        // WHY: refuse a weak key here (typed error, connection dropped) rather than throw later from decide().
        agreeKey: requireAgreeKey(hi.agreeKey, 'agreeKey'),
      };
      const commitN = asBytes(hi.commit, 'commit', 32);
      if (!verifySig(n.signKey, popN(c.isk, n.signKey, n.agreeKey), asBytes(hi.pop, 'pop', 64))) throw new MeshCryptoError('bad-signature', 'pop');
      c.tr.add('hello', bytes);
      c.commitN = commitN;
      c.pending = { ...n, deadline: this.#now() + PROMPT_LIFETIME_MS };
      c.stage = 'await-reveal';
      // E reveals only now that it holds N's commitment (so neither side can pick its nonce after seeing the other's).
      return [msg('reveal', { ct: seal(c.k.kEN, c.sid, 'E2N', 0, { n: this.#o.testHooks?.revealNonce ?? c.nonceE }) })];
    }

    if (t === 'reveal' && c.stage === 'await-reveal' && c.commitN && c.pending) {
      onlyKeys(m, ['t', 'ct'], 'reveal');
      const nonceN = readReveal(open(c.k.kNE, c.sid, 'N2E', 1, asBytes(m.ct, 'ct')));
      // WHY: a nonce that does not hash to the earlier commitment means the number could have been chosen after the fact.
      if (!ctEqual(sasCommit('N', nonceN), c.commitN)) throw new MeshCryptoError('auth-failed', 'matching number commitment');
      c.sas = shortAuthString({ transcript: c.tr.digest(), nonceN, nonceE: c.nonceE });
      c.stage = 'await-decision';
      const n = c.pending;
      this.events.push('prompt'); // the only place "Add this device?" can be raised
      const answer = this.#o.onAddPrompt({ name: n.name, platform: n.platform, fingerprint: toBuf(fingerprintFor(n.signKey, n.agreeKey)).toString('hex').slice(0, 8), sas: c.sas }, conn);
      return answer === undefined ? [] : this.decide(conn, answer);
    }
    return [];
  }

  /** The human's answer to "Add this device?" for the connection that raised the prompt. */
  decide(conn: string, approved: boolean): Buffer[] {
    const c = this.#conns.get(conn);
    if (!c || c.stage !== 'await-decision' || !c.pending) return [];
    this.#conns.delete(conn);
    const p = c.pending;
    if (!approved || this.#now() > p.deadline) return [msg(approved ? 'closed' : 'declined')];
    try {
      // Only now does anything sealed under the set secret leave this device (threat model P-8).
      const devId = deviceIdFor(p.signKey);
      // WHY heads only: `seen` cites this device's own latest entry plus the current heads, never every id,
      // so the entry stays small however long the roster is (it used to break past 1024 entries).
      const add = makeAddEntry(this.#id, { name: p.name, platform: p.platform, signKey: p.signKey, agreeKey: p.agreeKey }, seenForNextEntry(this.#state.roster, this.#id.deviceId), this.#now());
      const secrets: { [gen: string]: CborValue } = {};
      for (const [g, S] of this.#state.secrets) secrets[String(g)] = sealSecretTo(p.agreeKey, this.#state.setId, g, S, this.#id.deviceId, devId);
      const welcome = {
        setId: this.#state.setId,
        roster: [...this.#state.roster, add].map(entryToValue),
        secrets,
        signKey: this.#id.signKey,
        agreeKey: this.#id.agreeKey,
        pop: signWith(this.#id, popE(c.isk, p, this.#id)),
      };
      const sealed = seal(c.k.kEN, c.sid, 'E2N', 1, welcome as CborValue);
      this.events.push('welcome-sent');
      this.#o.onAdded?.(add);
      return [msg('welcome', { ct: sealed })];
    } catch (e) {
      // WHY: decide() is called from UI code, not through onMessage; a refusal here (for instance a key that
      // cannot be sealed to) must end this pairing, not escape into the caller's click handler.
      if (e instanceof MeshCryptoError) return [msg('closed')];
      throw e;
    }
  }
}

/** The result of a successful pairing. The set secrets are #private: readable by name, never printed. */
export class PairingSuccess {
  readonly ok = true as const;
  readonly setId: Buffer;
  readonly roster: SignedEntry[];
  readonly devices: Map<string, RosterDevice>;
  readonly existing: { signKey: Buffer; agreeKey: Buffer; deviceId: Buffer };
  /** Matching number to show; compare with the existing device's screen. */
  readonly sas: string;
  readonly #secrets: Map<number, Buffer>;
  constructor(o: { setId: Buffer; secrets: Map<number, Buffer>; roster: SignedEntry[]; devices: Map<string, RosterDevice>; existing: { signKey: Buffer; agreeKey: Buffer; deviceId: Buffer }; sas: string }) {
    this.setId = o.setId;
    this.roster = o.roster;
    this.devices = o.devices;
    this.existing = o.existing;
    this.sas = o.sas;
    this.#secrets = o.secrets;
  }
  /** generation -> set secret. SECRET. */
  get secrets(): Map<number, Buffer> {
    return this.#secrets;
  }
  toString(): string {
    return `[PairingSuccess ${this.setId.toString('hex').slice(0, 8)}]`;
  }
  toJSON(): { ok: true; setId: string; sas: string } {
    return { ok: true, setId: this.setId.toString('hex'), sas: this.sas };
  }
  [INSPECT_CUSTOM](): string {
    return this.toString();
  }
}
export type PairingResult = PairingSuccess | { ok: false; why: string };

export interface NewDeviceInvite {
  room: Bytes;
  secret: Bytes;
  /** From the QR; omitted for a typed code. */
  fingerprint?: Bytes;
}

/** The new device. */
export class NewDevice {
  result: PairingResult | null = null;
  private stage: 'start' | 'await-pake2' | 'await-cE' | 'await-reveal' | 'await-welcome' | 'failed' | 'done' = 'start';
  readonly #id: DeviceIdentity;
  readonly #invite: NewDeviceInvite;
  readonly #me: { name: string; platform: string };
  readonly #hooks?: { revealNonce?: Buffer };
  readonly #cp: CPace;
  readonly #sid: Buffer;
  readonly #tr = new Transcript();
  readonly #nonceN = random(SAS_NONCE_BYTES);
  #commitE?: Buffer;
  #isk?: Buffer;
  #k?: ReturnType<typeof pairKeys>;
  #sas?: string;
  /**
   * `testHooks` is a TEST SEAM ONLY: `revealNonce` reveals a nonce other than the committed one, to prove the
   * other side refuses it. Production never passes it.
   */
  constructor(id: DeviceIdentity, invite: NewDeviceInvite, mode: PairMode, me: { name: string; platform: string }, testHooks?: { revealNonce?: Buffer }) {
    this.#id = id;
    this.#invite = invite;
    // WHY cleaned on the way OUT too: the same functions guard every path, and a name the other side
    // would refuse for length should not abort a pairing the user started.
    this.#me = { name: sanitizeDeviceName(me.name), platform: sanitizePlatform(me.platform) };
    this.#hooks = testHooks;
    this.#sid = sidFor(invite.room);
    this.#cp = new CPace({ prs: invite.secret, ci: ciFor(mode), sid: this.#sid, role: 'initiator' });
  }
  toString(): string {
    return `[NewDevice ${this.stage}]`;
  }
  toJSON(): { stage: string; result: PairingResult | null } {
    return { stage: this.stage, result: this.result };
  }
  [INSPECT_CUSTOM](): string {
    return this.toString();
  }
  get stageName(): string {
    return this.stage;
  }
  start(): Buffer {
    this.stage = 'await-pake2';
    const pake1 = msg('pake1', { Y: this.#cp.Y });
    this.#tr.add('pake1', pake1);
    return pake1;
  }
  private failWith(why: string): Buffer[] {
    this.stage = 'failed';
    this.result = { ok: false, why };
    return [];
  }
  onMessage(bytes: Uint8Array): Buffer[] {
    try {
      return this.handle(bytes);
    } catch (e) {
      if (e instanceof MeshCryptoError) return []; // injected junk: ignored, still waiting
      throw e;
    }
  }
  private handle(bytes: Uint8Array): Buffer[] {
    if (bytes.length > MAX_MESSAGE_BYTES || this.stage === 'failed' || this.stage === 'done') return [];
    const m = asMap(decode(bytes), 'pairing message');
    const t = asText(m.t, 't', 16);
    if (t === 'rejected' || t === 'closed' || t === 'busy') return this.failWith(t);
    if (t === 'pake2' && this.stage === 'await-pake2') {
      onlyKeys(m, ['t', 'Y'], 'pake2');
      const isk = this.#cp.finish({ Y: asBytes(m.Y, 'Y', 32), AD: Buffer.alloc(0) });
      if (!isk) return this.failWith('low-order');
      this.#isk = isk;
      this.#k = pairKeys(isk, this.#sid);
      this.stage = 'await-cE';
      this.#tr.add('pake2', bytes);
      const cN = msg('cN', { mac: confirmMac(this.#k.kcN, 'N') });
      this.#tr.add('cN', cN);
      return [cN];
    }
    if (t === 'cE' && this.stage === 'await-cE' && this.#k && this.#isk) {
      onlyKeys(m, ['t', 'mac', 'commit'], 'cE');
      if (!ctEqual(asBytes(m.mac, 'mac', 32), confirmMac(this.#k.kcE, 'E'))) return this.failWith('E failed confirmation');
      this.#commitE = asBytes(m.commit, 'commit', 32);
      this.#tr.add('cE', bytes);
      this.stage = 'await-reveal';
      // Only now, with the other side proven to hold the code, does this device reveal its name and keys.
      // It also COMMITS to its matching-number nonce, before it has seen E's.
      const hello = { name: this.#me.name, platform: this.#me.platform, signKey: this.#id.signKey, agreeKey: this.#id.agreeKey, pop: signWith(this.#id, popN(this.#isk, this.#id.signKey, this.#id.agreeKey)), commit: sasCommit('N', this.#nonceN) };
      const out = msg('hello', { ct: seal(this.#k.kNE, this.#sid, 'N2E', 0, hello) });
      this.#tr.add('hello', out);
      return [out];
    }
    if (t === 'reveal' && this.stage === 'await-reveal' && this.#k && this.#commitE) {
      onlyKeys(m, ['t', 'ct'], 'reveal');
      const nonceE = readReveal(open(this.#k.kEN, this.#sid, 'E2N', 0, asBytes(m.ct, 'ct')));
      // WHY: E's nonce must hash to the commitment E sent BEFORE it saw ours; otherwise the number is not trustworthy.
      if (!ctEqual(sasCommit('E', nonceE), this.#commitE)) return this.failWith('matching number commitment broken');
      this.#sas = shortAuthString({ transcript: this.#tr.digest(), nonceN: this.#nonceN, nonceE });
      this.stage = 'await-welcome';
      return [msg('reveal', { ct: seal(this.#k.kNE, this.#sid, 'N2E', 1, { n: this.#hooks?.revealNonce ?? this.#nonceN }) })];
    }
    if (t === 'declined' && this.stage === 'await-welcome') return this.failWith('declined');
    if (t === 'welcome' && this.stage === 'await-welcome' && this.#k && this.#isk) {
      const w = asMap(open(this.#k.kEN, this.#sid, 'E2N', 1, asBytes(m.ct, 'ct')), 'welcome');
      onlyKeys(w, ['setId', 'roster', 'secrets', 'signKey', 'agreeKey', 'pop'], 'welcome');
      return this.finishWelcome(w);
    }
    return [];
  }
  private finishWelcome(w: { [k: string]: CborValue }): Buffer[] {
    const e = { signKey: asBytes(w.signKey, 'signKey', 32), agreeKey: requireAgreeKey(w.agreeKey, 'agreeKey') };
    const isk = this.#isk as Buffer;
    if (this.#invite.fingerprint && !ctEqual(this.#invite.fingerprint, fingerprintFor(e.signKey, e.agreeKey))) return this.failWith('fingerprint mismatch'); // QR pin
    if (!verifySig(e.signKey, popE(isk, this.#id, e), asBytes(w.pop, 'pop', 64))) return this.failWith('E proof of possession');
    const entries = asArray(w.roster, 'roster', MAX_ROSTER_ENTRIES).map((v) => parseEntryValue(v));
    let verified;
    try {
      verified = verifyRosterLog(entries);
    } catch {
      return this.failWith('bad roster');
    }
    const setId = asBytes(w.setId, 'setId', 32);
    // WHY: the set id (also the relay room) must be the one derived from the genesis device's key, so E cannot hand us a roster for a different room.
    if (!ctEqual(setId, verified.setId)) return this.failWith('set id does not match roster');
    const eId = deviceIdFor(e.signKey);
    const eDev = verified.devices.get(toHex(eId));
    if (!eDev || !ctEqual(eDev.agreeKey, e.agreeKey)) return this.failWith('existing device not in roster');
    const me = verified.devices.get(toHex(this.#id.deviceId));
    if (!me || !ctEqual(me.signKey, this.#id.signKey) || !ctEqual(me.agreeKey, this.#id.agreeKey)) return this.failWith('roster does not contain me');
    const sealed = asMap(w.secrets, 'secrets');
    const gens = Object.keys(sealed);
    if (gens.length === 0 || gens.length > MAX_GENERATIONS) return this.failWith('secrets');
    const secrets = new Map<number, Buffer>();
    for (const g of gens) {
      const gen = asUint(Number(g), 'gen', 0xffffffff);
      if (String(gen) !== g) return this.failWith('secrets');
      const S = openSecret(this.#id.agreeSecret, asBytes(sealed[g], 'sealed secret'), setId, gen, eId, this.#id.deviceId);
      if (S.length !== SET_SECRET_LENGTH) return this.failWith('secrets');
      secrets.set(gen, S);
    }
    this.stage = 'done';
    this.result = new PairingSuccess({ setId, secrets, roster: entries, devices: verified.devices, existing: { ...e, deviceId: eId }, sas: this.#sas as string });
    return [];
  }
  /** The matching number, available once E's nonce has been revealed and checked against its commitment. */
  get sas(): string | undefined {
    return this.#sas;
  }
}
