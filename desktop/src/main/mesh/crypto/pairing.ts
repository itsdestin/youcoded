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
//                           else happens -> E->N cE {mac}
//   N->E hello  (sealed under the session key: name, keys, proof of possession)
//                           E raises "Add this device?" -- ONLY now, so the name on screen belongs
//                           to someone who proved they hold the code (threat model P-8)
//   E->N welcome (sealed under the session key: signed roster + every set-secret generation, each
//                 HPKE-sealed to N's agreement key)
//
// Failure budget: MAX_FAILURES evaluated confirmations per code, counted on E, then the code is
// burned. The budget is checked BEFORE a confirmation is evaluated, so a 4th guess is never even
// tested, however many connections are open at once. A success also spends the code.
// Why a failed or dropped attempt gives an attacker only the one guess it was built from: E sends
// nothing that depends on the code until N's confirmation checked out, so there is nothing to test
// offline.
//
// onMessage never throws for hostile input: garbage, out-of-order and oversized messages are
// ignored and cost the sender its connection (and, at confirmation, one try).
import { LABEL, concat, ctEqual, hkdfSha256, hmacSha256, random, sha256, toBuf, utf8, type Bytes } from './bytes';
import { aeadOpen, aeadSeal } from './aead';
import { CborValue, asArray, asBytes, asMap, asText, asUint, decode, encode, onlyKeys } from './cbor';
import { CPace } from './cpace';
import { MeshCryptoError } from './errors';
import { fingerprintFor, deviceIdFor, signWith, verifySig, type DeviceIdentity } from './identity';
import { openSecret, sealSecretTo } from './keygen';
import { SET_SECRET_LENGTH } from './keys';
import { entryToValue, makeAddEntry, parseEntryValue, sanitizeDeviceName, verifyRosterLog, type RosterDevice, type SignedEntry } from './roster';

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
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
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

/** A matching number both screens show (T5 G15, threat model P-4). Derived from the session key only. */
export function shortAuthString(isk: Bytes, digits = 4): string {
  const h = sha256(utf8(LABEL + 'pair/sas\0'), isk);
  return String(h.readUInt32BE(0) % 10 ** digits).padStart(digits, '0');
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

// One message per key per direction, so the all-zero nonce is safe: each key is used once, and the
// state machines below only ever call seal() once per direction.
function seal(key: Bytes, sid: Bytes, dir: string, obj: CborValue): Buffer {
  return aeadSeal(key, Buffer.alloc(12), concat(sid, utf8(dir)), encode(obj));
}
function open(key: Bytes, sid: Bytes, dir: string, ct: Buffer): CborValue {
  if (ct.length < 16) throw new MeshCryptoError('malformed', 'sealed');
  let plain: Buffer;
  try {
    plain = aeadOpen(key, Buffer.alloc(12), concat(sid, utf8(dir)), ct);
  } catch {
    throw new MeshCryptoError('auth-failed', 'sealed');
  }
  return decode(plain);
}
// Proofs of possession are bound to THIS session through a hash of the PAKE output, so a signed blob cannot be reused elsewhere.
// N signs only its own keys (it does not know E's yet); E signs both, so E's proof also pins which new device it admitted.
const popN = (isk: Bytes, signKey: Bytes, agreeKey: Bytes): Buffer => concat(utf8(LABEL + 'pair-pop-N\0'), sha256(isk), signKey, agreeKey);
const popE = (isk: Bytes, n: { signKey: Bytes; agreeKey: Bytes }, e: { signKey: Bytes; agreeKey: Bytes }): Buffer =>
  concat(utf8(LABEL + 'pair-pop-E\0'), sha256(isk), n.signKey, n.agreeKey, e.signKey, e.agreeKey);

const msg = (t: string, extra: { [k: string]: CborValue } = {}): Buffer => encode({ t, ...extra });

export interface Invite {
  mode: PairMode;
  /** Meeting point. Random, NEVER derived from the secret (a relay could otherwise test guesses against it). */
  room: Buffer;
  /** The password fed to CPace: the typed code's characters, or 16 random bytes for a QR. */
  secret: Buffer;
  /** For a typed code, the characters to show (the room part is displayed separately by the caller). */
  code?: string;
  /** Existing device's key fingerprint, carried by the QR. */
  fingerprint: Buffer;
  expiresAt: number;
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
}

interface Conn {
  stage: 'await-confirm' | 'await-hello' | 'await-decision';
  sid: Buffer;
  k: ReturnType<typeof pairKeys>;
  isk: Buffer;
  born: number;
  pending?: { name: string; platform: string; signKey: Buffer; agreeKey: Buffer; deadline: number };
}

/** The existing device. */
export class Existing {
  readonly events: string[] = [];
  private readonly conns = new Map<string, Conn>();
  private readonly now: () => number;
  private invite?: Invite;
  private cpaceSecret?: Buffer;
  private failures = 0;
  private evaluated = 0;
  private burned = false;
  private used = false;

  constructor(
    private readonly id: DeviceIdentity,
    private readonly state: ExistingState,
    private readonly o: ExistingOptions,
  ) {
    this.now = o.now ?? Date.now;
  }

  /** Make a one-time invite. `room` comes from the relay's meeting-point allocator (>= 8 random bytes); random if omitted. */
  openInvite(mode: PairMode, room: Bytes = random(MIN_ROOM_BYTES)): Invite {
    if (room.length < MIN_ROOM_BYTES) throw new MeshCryptoError('invalid-argument', 'meeting point too short');
    this.conns.clear();
    this.failures = this.evaluated = 0;
    this.burned = this.used = false;
    const code = mode === 'code' ? generateCode() : undefined;
    const secret = code ? utf8(code) : random(16);
    this.cpaceSecret = secret;
    this.invite = { mode, room: Buffer.from(room), secret, code, fingerprint: fingerprintFor(this.id.signKey, this.id.agreeKey), expiresAt: this.now() + INVITE_LIFETIME_MS };
    return this.invite;
  }
  get failureCount(): number {
    return this.failures;
  }
  get evaluatedCount(): number {
    return this.evaluated;
  }
  get isBurned(): boolean {
    return this.burned;
  }
  get isSpent(): boolean {
    return this.used;
  }
  private budgetLeft(): boolean {
    return !!this.invite && !this.burned && !this.used && this.failures < MAX_FAILURES && this.now() < this.invite.expiresAt;
  }
  private fail(why: string): void {
    this.failures++;
    this.events.push('fail:' + why);
    if (this.failures >= MAX_FAILURES) {
      this.burned = true;
      this.events.push('burned');
    }
  }
  /** The transport reports a closed connection. */
  dropConnection(conn: string): void {
    this.conns.delete(conn);
  }

  /** Feed one message from one connection (any connection: the pipe is hostile). Returns messages for THAT connection. */
  onMessage(conn: string, bytes: Uint8Array): Buffer[] {
    try {
      return this.handle(conn, bytes);
    } catch (e) {
      if (e instanceof MeshCryptoError) {
        this.conns.delete(conn);
        return [];
      }
      throw e; // a bug in this file, not hostile input
    }
  }

  private handle(conn: string, bytes: Uint8Array): Buffer[] {
    if (bytes.length > MAX_MESSAGE_BYTES || !this.invite || !this.cpaceSecret) return [];
    const m = asMap(decode(bytes), 'pairing message');
    const t = asText(m.t, 't', 16);
    const c = this.conns.get(conn);

    if (t === 'pake1') {
      onlyKeys(m, ['t', 'Y'], 'pake1');
      if (!this.budgetLeft()) return [msg('closed')];
      if (this.conns.size >= MAX_CONNECTIONS) {
        // Bound memory: first drop half-open connections that have sat idle, then refuse.
        for (const [k, v] of this.conns) if (v.stage === 'await-confirm' && this.now() - v.born > HALF_OPEN_TTL_MS) this.conns.delete(k);
        if (this.conns.size >= MAX_CONNECTIONS) return [msg('busy')];
      }
      const Y = asBytes(m.Y, 'Y', 32);
      const sid = sidFor(this.invite.room);
      const cp = new CPace({ prs: this.cpaceSecret, ci: ciFor(this.invite.mode), sid, role: 'responder' });
      const isk = cp.finish({ Y, AD: Buffer.alloc(0) });
      if (!isk) {
        this.fail('low-order point');
        return [msg('rejected')];
      }
      this.conns.set(conn, { stage: 'await-confirm', sid, k: pairKeys(isk, sid), isk, born: this.now() });
      this.events.push('pake1');
      return [msg('pake2', { Y: cp.Y })];
    }
    if (!c) return []; // out of order or injected: ignored, not counted

    if (t === 'cN' && c.stage === 'await-confirm') {
      onlyKeys(m, ['t', 'mac'], 'cN');
      const mac = asBytes(m.mac, 'mac', 32);
      if (!this.budgetLeft()) {
        this.conns.delete(conn);
        return [msg('closed')]; // checked BEFORE evaluating: no 4th guess
      }
      this.evaluated++;
      if (!ctEqual(mac, confirmMac(c.k.kcN, 'N'))) {
        this.conns.delete(conn);
        this.fail('bad confirmation');
        return [msg('rejected')];
      }
      this.used = true; // one successful pairing per code
      c.stage = 'await-hello';
      this.events.push('confirm-ok');
      return [msg('cE', { mac: confirmMac(c.k.kcE, 'E') })];
    }

    if (t === 'hello' && c.stage === 'await-hello') {
      onlyKeys(m, ['t', 'ct'], 'hello');
      const hi = asMap(open(c.k.kNE, c.sid, 'N2E', asBytes(m.ct, 'ct')), 'hello body');
      onlyKeys(hi, ['name', 'platform', 'signKey', 'agreeKey', 'pop'], 'hello body');
      const n = { name: sanitizeDeviceName(asText(hi.name, 'name', 200)), platform: asText(hi.platform, 'platform', 32), signKey: asBytes(hi.signKey, 'signKey', 32), agreeKey: asBytes(hi.agreeKey, 'agreeKey', 32) };
      if (!verifySig(n.signKey, popN(c.isk, n.signKey, n.agreeKey), asBytes(hi.pop, 'pop', 64))) throw new MeshCryptoError('bad-signature', 'pop');
      c.stage = 'await-decision';
      c.pending = { ...n, deadline: this.now() + PROMPT_LIFETIME_MS };
      this.events.push('prompt'); // the only place "Add this device?" can be raised
      const answer = this.o.onAddPrompt({ name: n.name, platform: n.platform, fingerprint: toBuf(fingerprintFor(n.signKey, n.agreeKey)).toString('hex').slice(0, 8), sas: shortAuthString(c.isk) }, conn);
      return answer === undefined ? [] : this.decide(conn, answer);
    }
    return [];
  }

  /** The human's answer to "Add this device?" for the connection that raised the prompt. */
  decide(conn: string, approved: boolean): Buffer[] {
    const c = this.conns.get(conn);
    if (!c || c.stage !== 'await-decision' || !c.pending) return [];
    this.conns.delete(conn);
    const p = c.pending;
    if (!approved || this.now() > p.deadline) return [msg(approved ? 'closed' : 'declined')];
    // Only now does anything sealed under the set secret leave this device (threat model P-8).
    const devId = deviceIdFor(p.signKey);
    const add = makeAddEntry(this.id, { name: p.name, platform: p.platform, signKey: p.signKey, agreeKey: p.agreeKey }, this.state.roster.map((e) => e.id), this.now());
    const secrets: { [gen: string]: CborValue } = {};
    for (const [g, S] of this.state.secrets) secrets[String(g)] = sealSecretTo(p.agreeKey, this.state.setId, g, S, this.id.deviceId, devId);
    const welcome = {
      setId: this.state.setId,
      roster: [...this.state.roster, add].map(entryToValue),
      secrets,
      signKey: this.id.signKey,
      agreeKey: this.id.agreeKey,
      pop: signWith(this.id, popE(c.isk, p, this.id)),
    };
    this.events.push('welcome-sent');
    this.o.onAdded?.(add);
    return [msg('welcome', { ct: seal(c.k.kEN, c.sid, 'E2N', welcome as CborValue) })];
  }
}

export interface PairingSuccess {
  ok: true;
  setId: Buffer;
  /** generation -> set secret */
  secrets: Map<number, Buffer>;
  roster: SignedEntry[];
  devices: Map<string, RosterDevice>;
  existing: { signKey: Buffer; agreeKey: Buffer; deviceId: Buffer };
  /** Matching number to show; compare with the existing device's screen. */
  sas: string;
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
  private stage: 'start' | 'await-pake2' | 'await-cE' | 'await-welcome' | 'failed' | 'done' = 'start';
  private readonly cp: CPace;
  private readonly sid: Buffer;
  private isk?: Buffer;
  private k?: ReturnType<typeof pairKeys>;
  constructor(
    private readonly id: DeviceIdentity,
    private readonly invite: NewDeviceInvite,
    mode: PairMode,
    private readonly me: { name: string; platform: string },
  ) {
    this.sid = sidFor(invite.room);
    this.cp = new CPace({ prs: invite.secret, ci: ciFor(mode), sid: this.sid, role: 'initiator' });
  }
  get stageName(): string {
    return this.stage;
  }
  start(): Buffer {
    this.stage = 'await-pake2';
    return msg('pake1', { Y: this.cp.Y });
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
      this.isk = this.cp.finish({ Y: asBytes(m.Y, 'Y', 32), AD: Buffer.alloc(0) }) ?? undefined;
      if (!this.isk) return this.failWith('low-order');
      this.k = pairKeys(this.isk, this.sid);
      this.stage = 'await-cE';
      return [msg('cN', { mac: confirmMac(this.k.kcN, 'N') })];
    }
    if (t === 'cE' && this.stage === 'await-cE' && this.k && this.isk) {
      if (!ctEqual(asBytes(m.mac, 'mac', 32), confirmMac(this.k.kcE, 'E'))) return this.failWith('E failed confirmation');
      this.stage = 'await-welcome';
      // Only now, with the other side proven to hold the code, does this device reveal its name and keys.
      const hello = { name: this.me.name, platform: this.me.platform, signKey: this.id.signKey, agreeKey: this.id.agreeKey, pop: signWith(this.id, popN(this.isk, this.id.signKey, this.id.agreeKey)) };
      return [msg('hello', { ct: seal(this.k.kNE, this.sid, 'N2E', hello) })];
    }
    if (t === 'declined' && this.stage === 'await-welcome') return this.failWith('declined');
    if (t === 'welcome' && this.stage === 'await-welcome' && this.k && this.isk) {
      const w = asMap(open(this.k.kEN, this.sid, 'E2N', asBytes(m.ct, 'ct')), 'welcome');
      onlyKeys(w, ['setId', 'roster', 'secrets', 'signKey', 'agreeKey', 'pop'], 'welcome');
      return this.finishWelcome(w);
    }
    return [];
  }
  private finishWelcome(w: { [k: string]: CborValue }): Buffer[] {
    const e = { signKey: asBytes(w.signKey, 'signKey', 32), agreeKey: asBytes(w.agreeKey, 'agreeKey', 32) };
    const isk = this.isk as Buffer;
    if (this.invite.fingerprint && !ctEqual(this.invite.fingerprint, fingerprintFor(e.signKey, e.agreeKey))) return this.failWith('fingerprint mismatch'); // QR pin
    if (!verifySig(e.signKey, popE(isk, this.id, e), asBytes(w.pop, 'pop', 64))) return this.failWith('E proof of possession');
    const entries = asArray(w.roster, 'roster', 4096).map((v) => parseEntryValue(v));
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
    const eDev = verified.devices.get(eId.toString('hex'));
    if (!eDev || !ctEqual(eDev.agreeKey, e.agreeKey)) return this.failWith('existing device not in roster');
    const me = verified.devices.get(this.id.deviceId.toString('hex'));
    if (!me || !ctEqual(me.signKey, this.id.signKey) || !ctEqual(me.agreeKey, this.id.agreeKey)) return this.failWith('roster does not contain me');
    const sealed = asMap(w.secrets, 'secrets');
    const gens = Object.keys(sealed);
    if (gens.length === 0 || gens.length > MAX_GENERATIONS) return this.failWith('secrets');
    const secrets = new Map<number, Buffer>();
    for (const g of gens) {
      const gen = asUint(Number(g), 'gen', 0xffffffff);
      if (String(gen) !== g) return this.failWith('secrets');
      const S = openSecret(this.id.agreeSecret, asBytes(sealed[g], 'sealed secret'), setId, gen, eId, this.id.deviceId);
      if (S.length !== SET_SECRET_LENGTH) return this.failWith('secrets');
      secrets.set(gen, S);
    }
    this.stage = 'done';
    this.result = { ok: true, setId, secrets, roster: entries, devices: verified.devices, existing: { ...e, deviceId: eId }, sas: shortAuthString(isk) };
    return [];
  }
  /** The matching number, available once the other side has proven it holds the code. */
  get sas(): string | undefined {
    return this.isk && (this.stage === 'await-welcome' || this.stage === 'done') ? shortAuthString(this.isk) : undefined;
  }
}
