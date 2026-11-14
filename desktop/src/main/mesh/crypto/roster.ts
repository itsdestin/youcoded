// Signed entries and the device roster (T5 C8; design 5.1 "Roster", 6.2).
//
// SCOPE: this file builds and VERIFIES signed entries and checks that a roster log is signed by
// devices that were in it. It deliberately does NOT decide anything: no cut-off, no witness
// rules, no "two devices removing each other" outcome, no void/valid ruling. Those merge/decide
// rules belong to another part (T5 gaps G6/G7/G8). So `verifyRosterLog` reports keys, never
// "who is currently a member"; a removed device's key stays in the map because frames it signed
// before removal must still verify, and whether a later entry counts is the decide layer's call.
//
// WHAT THE VERIFIER DOES GUARANTEE (so the decide layer has honest facts to work from):
//  * every entry's `seen` is signed and must name entries EARLIER in the log (no dangling or
//    forward references, no duplicates); genesis names nothing, every later entry names something;
//  * an entry must have seen its signer's own previous entry (or, for a signer's first entry, the
//    `add` that introduced it). So one device's entries form a chain nobody can back-date or fork,
//    and an entry is provably "made after" everything in its `seen` closure;
//  * `add` of a device id that is already present is refused: a key can never be overwritten.
//    A key change is NOT SUPPORTED yet: it would change who receives future set secrets, so it
//    needs its own typed, self-signed entry kind AND a decide-layer rule; nobody owns that yet, and
//    inventing a half-rule here would be worse than refusing.
//  * a device whose `seen` closure contains its OWN removal cannot sign add/remove/rename: it knew.
//  * facts the verifier exposes but does not rule on: whether an entry's signer was removed
//    earlier in the log without the entry citing it (`signerRemovedEarlierInLog`), and exact
//    ancestry (`happenedBefore`). An entry that never cites a removal may simply be concurrent
//    with it: the decide layer's call, not ours.
//
// Entry id and signature (gap G5, previously unspecified):
//   id        = SHA-256( LABEL+"entry\0" || canonical{chat, kind, body, seen, at, device} )
//   signature = Ed25519( LABEL+"entry-sig\0" || id )
// The id depends only on content, so two devices compute the same id; the signature covers the
// id, so any edit to any field breaks it. `witness` and `cutoff` entries use the same rule.
import { LABEL, concat, ctEqual, sha256, toHex, utf8, type Bytes } from './bytes';
import { CborValue, asArray, asBytes, asMap, asText, asUint, decode, encode, onlyKeys, type CborMap } from './cbor';
import { MeshCryptoError, guard } from './errors';
import { deviceIdFor, requireAgreeKey, setIdFor, signWith, verifySig, type DeviceIdentity } from './identity';

// WHY 8192 (was 4096): a log has to be verifiable in one welcome message even when long; ancestry
// bookkeeping is n*n/8 bytes (8 MiB at the cap), still small.
export const MAX_ROSTER_ENTRIES = 8192;
export const MAX_DEVICE_NAME = 40;
const MAX_PLATFORM = 32;
// WHY 64 (was 1024 at parse): `seen` names the CURRENT heads, never every id, so it stays small
// however long the log grows; the old cap let a pairing build an entry its own receiver refused.
export const MAX_SEEN = 64;

export interface SignedEntry {
  id: Buffer;
  kind: string;
  /** The SIGNER's device id. */
  device: Buffer;
  chat: string | null;
  body: CborValue;
  seen: Buffer[];
  at: number;
  signature: Buffer;
}
export interface EntryFields {
  kind: string;
  body: CborValue;
  /** Ids of entries this one has seen: order never depends on clocks. */
  seen?: Bytes[];
  at: number;
  chat?: string | null;
}

const entryRest = (e: { chat: string | null; kind: string; body: CborValue; seen: Bytes[]; at: number; device: Bytes }): CborValue => ({
  chat: e.chat,
  kind: e.kind,
  body: e.body,
  seen: e.seen,
  at: e.at,
  device: e.device,
});
const entryId = (rest: CborValue): Buffer => sha256(utf8(LABEL + 'entry\0'), encode(rest));
const entrySigMessage = (id: Bytes): Buffer => concat(utf8(LABEL + 'entry-sig\0'), id);

export function signEntry(signer: DeviceIdentity, f: EntryFields): SignedEntry {
  if ((f.seen?.length ?? 0) > MAX_SEEN) throw new MeshCryptoError('invalid-argument', 'too many seen ids');
  const seen = (f.seen ?? []).map((s) => Buffer.from(s));
  const base = { chat: f.chat ?? null, kind: f.kind, body: f.body, seen, at: f.at, device: signer.deviceId };
  const id = entryId(entryRest(base));
  return { ...base, id, signature: signWith(signer, entrySigMessage(id)) };
}

/** True only if the id matches the content AND the signature verifies under `signKey`. Never throws. */
export function verifyEntry(e: SignedEntry, signKey: Bytes): boolean {
  try {
    if (!ctEqual(deviceIdFor(signKey), e.device)) return false;
    const want = entryId(entryRest(e));
    return ctEqual(e.id, want) && verifySig(signKey, entrySigMessage(want), e.signature);
  } catch {
    return false;
  }
}

export const entryToValue = (e: SignedEntry): CborValue => ({ id: e.id, kind: e.kind, device: e.device, chat: e.chat, body: e.body, seen: e.seen, at: e.at, signature: e.signature });
export const encodeEntry = (e: SignedEntry): Buffer => encode(entryToValue(e));

/** Strict parse of an entry from a decoded value (the signature is NOT checked here; call verifyEntry). */
export function parseEntryValue(v: unknown): SignedEntry {
  return guard(() => {
    const m = asMap(v, 'entry');
    onlyKeys(m, ['id', 'kind', 'device', 'chat', 'body', 'seen', 'at', 'signature'], 'entry');
    return {
      id: asBytes(m.id, 'id', 32),
      kind: asText(m.kind, 'kind', 64),
      device: asBytes(m.device, 'device', 16),
      chat: m.chat === null ? null : asText(m.chat, 'chat', 256),
      // WHY: a missing body parsed as `undefined` re-encodes identically, a second spelling of one entry.
      body: m.body === undefined ? bad('body') : (m.body as CborValue),
      seen: asArray(m.seen, 'seen', MAX_SEEN).map((s) => asBytes(s, 'seen id', 32)),
      at: asUint(m.at, 'at'),
      signature: asBytes(m.signature, 'signature', 64),
    };
  });
}
const bad = (what: string): never => {
  throw new MeshCryptoError('malformed', what);
};
export const parseEntry = (bytes: Uint8Array): SignedEntry => parseEntryValue(decode(bytes));

// ---- device names shown to people (threat model P-5) ----
// ONE function for names and one for platforms, applied wherever a string from outside becomes a
// value (parse time) and wherever one is built, so no path can show or store a raw one.
// Removed: control, format (bidi marks/overrides, zero-width, soft hyphen, tag characters),
// surrogate and private-use characters, line/paragraph separators, and the blank-looking letters
// (hangul fillers U+115F/1160/3164/FFA0, braille blank U+2800, combining grapheme joiner U+034F,
// khmer vowel inherents). Runs of spaces collapse. Emptiness is checked AFTER stripping.
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\u034F\u115F\u1160\u17B4\u17B5\u2800\u3164\uFFA0]/gu;
export function sanitizeDeviceName(raw: string): string {
  const cleaned = Array.from(String(raw).replace(UNSAFE_CHARS, '').replace(/\p{Z}+/gu, ' ').trim()).slice(0, MAX_DEVICE_NAME).join('').trim();
  return cleaned || 'Unnamed device';
}
/** Platform strings ("linux", "android", "Win32 (x64)"): allow-list of ASCII letters, digits and a little punctuation. */
export function sanitizePlatform(raw: string): string {
  const cleaned = String(raw).replace(/[^A-Za-z0-9 ._+/()-]/g, '').replace(/ +/g, ' ').trim().slice(0, MAX_PLATFORM).trim();
  return cleaned || 'unknown';
}

// ---- roster entry kinds ----
export interface RosterDeviceInfo {
  name: string;
  platform: string;
  signKey: Buffer;
  agreeKey: Buffer;
}
export interface RosterDevice extends RosterDeviceInfo {
  deviceId: Buffer;
}

const addBody = (d: RosterDeviceInfo): CborValue => ({ name: sanitizeDeviceName(d.name), platform: sanitizePlatform(d.platform), signKey: d.signKey, agreeKey: d.agreeKey });

/** The first entry of a set: the first device adds itself. setId derives from this device's signing key. */
export const makeGenesisEntry = (self: DeviceIdentity, name: string, platform: string, at: number): SignedEntry =>
  signEntry(self, { kind: 'add', body: addBody({ name, platform, signKey: self.signKey, agreeKey: self.agreeKey }), seen: [], at });
/** An existing device admits a new one. */
export const makeAddEntry = (signer: DeviceIdentity, device: RosterDeviceInfo, seen: Bytes[], at: number): SignedEntry =>
  signEntry(signer, { kind: 'add', body: addBody(device), seen, at });
/** `cutoff` is carried opaquely; its meaning is the decide layer's. */
export const makeRemoveEntry = (signer: DeviceIdentity, target: Bytes, seen: Bytes[], at: number, cutoff?: CborValue): SignedEntry =>
  signEntry(signer, { kind: 'remove', body: { target, cutoff }, seen, at });
export const makeRenameEntry = (signer: DeviceIdentity, name: string, seen: Bytes[], at: number): SignedEntry =>
  signEntry(signer, { kind: 'rename', body: { name: sanitizeDeviceName(name) }, seen, at });

function readAdd(body: unknown): RosterDeviceInfo {
  const m: CborMap = asMap(body, 'add body');
  onlyKeys(m, ['name', 'platform', 'signKey', 'agreeKey'], 'add body');
  // WHY sanitise HERE: this is the one place every add (genesis, pairing welcome, keeper log) is read,
  // so a verified roster never carries a raw name; the signature still covers the raw bytes sent.
  return {
    name: sanitizeDeviceName(asText(m.name, 'name', 200)),
    platform: sanitizePlatform(asText(m.platform, 'platform', 200)),
    signKey: asBytes(m.signKey, 'signKey', 32),
    // WHY: a weak (low-order) agreement key would make every later sealing to this device throw, and
    // lets any member poison key rotation; refuse it where it is parsed, with the module's typed error.
    agreeKey: requireAgreeKey(m.agreeKey, 'agreeKey'),
  };
}

/** What the verifier can prove about one entry (it rules on none of it except where a header says so). */
interface EntryFacts {
  /** Position in the log. */
  index: number;
  /** Signer's device id, hex. */
  signer: string;
  kind: string;
  /** The entry's `seen` closure contains a removal of its own signer: the signer knew it was removed. */
  signerKnewOwnRemoval: boolean;
  /** Some removal of the signer sits earlier in the log but the entry does not cite it (omitted, or concurrent). */
  signerRemovedEarlierInLog: boolean;
}

export interface VerifiedRoster {
  setId: Buffer;
  /** Every device that was ever added, by hex device id. Includes removed devices (see file header). */
  devices: Map<string, RosterDevice>;
  /** Per entry id (hex). */
  facts: Map<string, EntryFacts>;
  /** True iff entry `a` is in the `seen` closure of entry `b` (so `a` provably came first). False for unknown ids or a === b. */
  happenedBefore(a: Bytes, b: Bytes): boolean;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Verify a roster log given in an order where each signer's `add` precedes its entries (the order
 * a pairing welcome and a keeper's log both use). Checks: genesis is a self-add naming nothing;
 * every later entry is signed by a device added earlier in the log; ids match content; `seen`
 * names earlier entries only and includes the signer's own previous entry; `add` bodies are well
 * formed and never repeat a device id; `remove` names a known device; a device that has seen its
 * own removal does not add/remove/rename; no duplicate ids.
 * Throws MeshCryptoError('bad-roster'|'bad-entry'|'malformed'|'low-order-point').
 */
export function verifyRosterLog(entries: readonly SignedEntry[]): VerifiedRoster {
  if (entries.length === 0 || entries.length > MAX_ROSTER_ENTRIES) throw new MeshCryptoError('bad-roster', 'size');
  const n = entries.length;
  const words = (n + 31) >>> 5;
  const devices = new Map<string, RosterDevice>();
  const index = new Map<string, number>(); // entry id -> position
  const anc: Uint32Array[] = []; // anc[i] has bit j set when entry j is in the seen-closure of entry i
  const removedKnown: ReadonlySet<string>[] = []; // devices whose removal is in each entry's closure
  const lastOwn = new Map<string, number>(); // signer -> position of its latest entry so far
  const introducedAt = new Map<string, number>(); // device -> position of the add that introduced it
  const removalsOf = new Map<string, number>(); // device -> how many removals of it so far
  const facts = new Map<string, EntryFacts>();
  let setId: Buffer | undefined;
  entries.forEach((e, i) => {
    const idHex = toHex(e.id);
    if (index.has(idHex)) throw new MeshCryptoError('bad-roster', 'duplicate entry');
    let signer: RosterDevice | undefined;
    if (i === 0) {
      if (e.kind !== 'add') throw new MeshCryptoError('bad-roster', 'genesis must be an add');
      const self = readAdd(e.body);
      signer = { ...self, deviceId: deviceIdFor(self.signKey) };
      if (!ctEqual(signer.deviceId, e.device)) throw new MeshCryptoError('bad-roster', 'genesis must be self-signed');
      setId = setIdFor(self.signKey);
      if (e.seen.length !== 0) throw new MeshCryptoError('bad-roster', 'genesis cannot cite earlier entries');
    } else {
      signer = devices.get(toHex(e.device));
      if (!signer) throw new MeshCryptoError('bad-roster', 'signer not yet in roster');
      if (e.seen.length === 0) throw new MeshCryptoError('bad-roster', 'entry names no earlier state');
    }
    if (!verifyEntry(e, signer.signKey)) throw new MeshCryptoError('bad-entry', e.kind);
    const signerHex = toHex(signer.deviceId);

    // ---- what this entry was made against: its seen-closure and the removals inside it ----
    const bits = new Uint32Array(words);
    let known: ReadonlySet<string> = EMPTY_SET;
    let owned = false;
    const cited = new Set<number>();
    for (const s of e.seen) {
      const j = index.get(toHex(s));
      if (j === undefined) throw new MeshCryptoError('bad-roster', 'seen names an unknown or later entry');
      if (cited.has(j)) throw new MeshCryptoError('bad-roster', 'seen repeats an entry');
      cited.add(j);
      bits[j >>> 5] |= 1 << (j & 31);
      const pa = anc[j];
      for (let w = 0; w < words; w++) bits[w] |= pa[w];
      const pk = removedKnown[j];
      if (pk.size > 0 && pk !== known) {
        if (known.size === 0) known = pk;
        else {
          if (!owned) {
            known = new Set(known);
            owned = true;
          }
          for (const x of pk) (known as Set<string>).add(x);
        }
      }
    }
    const inClosure = (j: number): boolean => (bits[j >>> 5] & (1 << (j & 31))) !== 0;
    if (i > 0) {
      // WHY: ties each device's entries into one chain and proves "made after being added".
      const ref = lastOwn.get(signerHex) ?? introducedAt.get(signerHex);
      if (ref === undefined || !inClosure(ref)) throw new MeshCryptoError('bad-roster', 'entry has not seen its signer\'s previous entry');
    }
    const knew = known.has(signerHex);
    facts.set(idHex, { index: i, signer: signerHex, kind: e.kind, signerKnewOwnRemoval: knew, signerRemovedEarlierInLog: (removalsOf.get(signerHex) ?? 0) > 0 });
    if (knew && (e.kind === 'add' || e.kind === 'remove' || e.kind === 'rename')) throw new MeshCryptoError('bad-roster', 'removed device signs roster change');

    if (e.kind === 'add') {
      const info = readAdd(e.body);
      const id = deviceIdFor(info.signKey);
      const idKey = toHex(id);
      // WHY: an add may only INTRODUCE a device. Overwriting let any member rebind another device's
      // key-agreement key (so it would receive that device's future secrets) or let a removed device re-add itself.
      if (devices.has(idKey)) throw new MeshCryptoError('bad-roster', 'duplicate device');
      devices.set(idKey, { ...info, deviceId: id });
      introducedAt.set(idKey, i);
    } else if (e.kind === 'rename') {
      const m = asMap(e.body, 'rename body');
      const cur = devices.get(signerHex);
      if (cur) devices.set(signerHex, { ...cur, name: sanitizeDeviceName(asText(m.name, 'name', 200)) });
    } else if (e.kind === 'remove') {
      const m = asMap(e.body, 'remove body');
      const target = toHex(asBytes(m.target, 'target', 16));
      if (!devices.has(target)) throw new MeshCryptoError('bad-roster', 'remove names unknown device');
      if (!owned) known = new Set(known);
      (known as Set<string>).add(target);
      removalsOf.set(target, (removalsOf.get(target) ?? 0) + 1);
    }
    // Other kinds (witness, cutoff, ...) are signature-checked above and otherwise passed through untouched.
    anc.push(bits);
    removedKnown.push(known);
    index.set(idHex, i);
    lastOwn.set(signerHex, i);
  });
  return {
    setId: setId as Buffer,
    devices,
    facts,
    happenedBefore(a, b) {
      const ia = index.get(toHex(a));
      const ib = index.get(toHex(b));
      return ia !== undefined && ib !== undefined && ia !== ib && (anc[ib][ia >>> 5] & (1 << (ia & 31))) !== 0;
    },
  };
}

/** Entries no other entry cites yet (the current heads), newest first. Does not verify anything. */
export function rosterHeads(entries: readonly SignedEntry[]): Buffer[] {
  const cited = new Set<string>();
  for (const e of entries) for (const s of e.seen) cited.add(toHex(s));
  const heads: Buffer[] = [];
  for (let i = entries.length - 1; i >= 0; i--) if (!cited.has(toHex(entries[i].id))) heads.push(entries[i].id);
  return heads;
}

/**
 * What `seen` a device should put on its NEXT entry: its own latest entry (the verifier requires it)
 * plus the current heads, capped at MAX_SEEN. Always small, however long the log is.
 */
export function seenForNextEntry(entries: readonly SignedEntry[], signer: Bytes): Buffer[] {
  const out: Buffer[] = [];
  const have = new Set<string>();
  const add = (id: Buffer): void => {
    const k = toHex(id);
    if (out.length < MAX_SEEN && !have.has(k)) {
      have.add(k);
      out.push(id);
    }
  };
  for (let i = entries.length - 1; i >= 0; i--) if (ctEqual(entries[i].device, signer)) {
    add(entries[i].id);
    break;
  }
  for (const h of rosterHeads(entries)) add(h);
  return out;
}
