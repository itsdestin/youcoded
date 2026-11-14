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
/** A device's first entry of its own: "I finished joining". Until a device has signed something it is only "pending" (review N8). */
export const makeHelloEntry = (signer: DeviceIdentity, seen: Bytes[], at: number): SignedEntry => signEntry(signer, { kind: 'hello', body: {}, seen, at });
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

/** What the verifier can prove about one entry. */
export interface EntryFacts {
  /** Position in the canonical order (depth, then id): the same on every device that holds the same set. */
  index: number;
  /** Signer's device id, hex. */
  signer: string;
  kind: string;
  /** The entry's `seen` closure contains an effective removal of its own signer: the signer knew it was removed. */
  signerKnewOwnRemoval: boolean;
  /** Some effective removal of the signer is concurrent with this entry (neither cites the other). */
  signerRemovedEarlierInLog: boolean;
  /** True when the entry has no effect (see "VOID" in the header). It still counts as an ancestor. */
  void: boolean;
}

export interface VerifiedRoster {
  setId: Buffer;
  /** Every device that was effectively introduced, by hex device id. Includes removed devices (see file header). */
  devices: Map<string, RosterDevice>;
  /** Per entry id (hex). */
  facts: Map<string, EntryFacts>;
  /** True iff entry `a` is in the `seen` closure of entry `b` (so `a` provably came first). False for unknown ids or a === b. */
  happenedBefore(a: Bytes, b: Bytes): boolean;
}

// WHY QUOTAS (review finding 4): any member can write valid entries as fast as it can sign them (renames change nothing and are
// nearly free), so the log needs a per-device ceiling that every device computes the same way from the log alone. 512 is far above
// what a person produces (a handful of renames over years) and 16 devices x 512 stays under the 8192 hard cap.
export const MAX_ENTRIES_PER_DEVICE = 512;
// WHY RESERVE (finding 4, "8192-entry dead end"): when the log is nearly full, adds and renames are refused but a REMOVE is still
// accepted, so a device that somehow fills the log can still be removed.
export const ROSTER_REMOVE_RESERVE = 64;

/** What happens when two devices remove each other at the same time, neither knowing of the other's removal (the OPEN product
 *  decision, review N3 / gap G6). One swappable rule: 'both' (default, the security review's choice: both removals stand, both devices
 *  are out) or 'first-admitted' (the device admitted earlier survives; the later one is removed). Both variants are tested. */
export type MutualRule = 'both' | 'first-admitted';
export const DEFAULT_MUTUAL_RULE: MutualRule = 'both';

const MAX_RESTARTS = 24;
const GATED = new Set(['add', 'remove', 'rename']);

interface Computed {
  setId: Buffer;
  devices: Map<string, RosterDevice>;
  removed: Set<string>;
  confirmed: Set<string>;
  voided: Set<string>;
  facts: Map<string, EntryFacts>;
  pos: Map<string, number>;
  rows: Uint32Array[];
  admitted: Map<string, number>;
  /** removal entry ids (hex) that are effective, by target */
  removalsOf: Map<string, string[]>;
}

/**
 * Roster state: a pure function of the SET of signed entries held (order of arrival, duplicates and timing play no part).
 * `prepare(entry)` checks what can be checked for ONE entry on arrival and returns a `commit()` that adds it to the set; the state is then
 * recomputed from the whole set (cached signature checks; near-linear), so there is no order in which two devices holding the same set
 * can disagree. See the header "CONVERGENCE BY CONSTRUCTION".
 */
export class RosterVerifier implements VerifiedRoster {
  readonly #raw = new Map<string, SignedEntry>();
  readonly #order: SignedEntry[] = [];
  readonly #depth = new Map<string, number>();
  readonly #keyOf = new Map<string, Buffer>();
  readonly #perDevice = new Map<string, number>();
  #calc: Computed | null = null;
  #setId: Buffer | undefined;
  constructor(readonly mutual: MutualRule = DEFAULT_MUTUAL_RULE) {}

  get size(): number {
    return this.#order.length;
  }
  get headroom(): number {
    return MAX_ROSTER_ENTRIES - this.#order.length;
  }
  countOf(deviceHex: string): number {
    return this.#perDevice.get(deviceHex) ?? 0;
  }
  get setId(): Buffer {
    return this.#setId as Buffer;
  }
  private get c(): Computed {
    if (!this.#calc) this.#calc = this.compute();
    return this.#calc;
  }
  get devices(): Map<string, RosterDevice> {
    return this.c.devices;
  }
  get facts(): Map<string, EntryFacts> {
    return this.c.facts;
  }
  /** Devices removed by an effective removal. */
  get removed(): Set<string> {
    return this.c.removed;
  }
  /** Devices that have signed an effective entry of their own (or created the set): pairing completed. Others are "pending". */
  get confirmed(): Set<string> {
    return this.c.confirmed;
  }
  /** Ids (hex) of entries with no effect. */
  get voided(): Set<string> {
    return this.c.voided;
  }
  /** Introduced, not removed. */
  active(): RosterDevice[] {
    const c = this.c;
    return [...c.devices.entries()].filter(([id]) => !c.removed.has(id)).map(([, d]) => d);
  }
  /** Effective removal entries (hex ids) of a device. */
  removalsOf(deviceHex: string): string[] {
    return this.c.removalsOf.get(deviceHex) ?? [];
  }
  happenedBefore(a: Bytes, b: Bytes): boolean {
    const c = this.c;
    const ia = c.pos.get(toHex(a));
    const ib = c.pos.get(toHex(b));
    if (ia === undefined || ib === undefined || ia === ib) return false;
    const row = c.rows[ib];
    const w = ia >>> 5;
    return w < row.length && (row[w] & (1 << (ia & 31))) !== 0;
  }

  prepare(e: SignedEntry): () => void {
    const i = this.#order.length;
    if (i >= MAX_ROSTER_ENTRIES) throw new MeshCryptoError('bad-roster', 'size');
    if (i >= MAX_ROSTER_ENTRIES - ROSTER_REMOVE_RESERVE && e.kind !== 'remove') throw new MeshCryptoError('bad-roster', 'log nearly full: only removals');
    const idHex = toHex(e.id);
    if (this.#raw.has(idHex)) throw new MeshCryptoError('bad-roster', 'duplicate entry');
    let signKey: Buffer | undefined;
    let genesisSetId: Buffer | undefined;
    if (i === 0) {
      if (e.kind !== 'add') throw new MeshCryptoError('bad-roster', 'genesis must be an add');
      const self = readAdd(e.body);
      signKey = self.signKey;
      if (!ctEqual(deviceIdFor(self.signKey), e.device)) throw new MeshCryptoError('bad-roster', 'genesis must be self-signed');
      genesisSetId = setIdFor(self.signKey);
      if (e.seen.length !== 0) throw new MeshCryptoError('bad-roster', 'genesis cannot cite earlier entries');
    } else {
      signKey = this.#keyOf.get(toHex(e.device));
      // WHY: the signer's key comes from an `add` we hold; without one the entry cannot be judged yet (the caller parks it, bounded).
      if (!signKey) throw new MeshCryptoError('bad-roster', 'signer not yet in roster');
      if (e.seen.length === 0) throw new MeshCryptoError('bad-roster', 'entry names no earlier state');
    }
    if (!verifyEntry(e, signKey)) throw new MeshCryptoError('bad-entry', e.kind);
    const signerHex = toHex(e.device);
    if ((this.#perDevice.get(signerHex) ?? 0) >= MAX_ENTRIES_PER_DEVICE) throw new MeshCryptoError('bad-roster', 'device quota');
    let depth = 1;
    const cited = new Set<string>();
    for (const s of e.seen) {
      const k = toHex(s);
      const d = this.#depth.get(k);
      if (d === undefined) throw new MeshCryptoError('bad-roster', 'seen names an unknown or later entry');
      if (cited.has(k)) throw new MeshCryptoError('bad-roster', 'seen repeats an entry');
      cited.add(k);
      if (d + 1 > depth) depth = d + 1;
    }
    // Shapes only (the rules that need the whole set run in compute()).
    let newKey: Buffer | undefined;
    if (e.kind === 'add') {
      const info = readAdd(e.body);
      newKey = info.signKey;
    } else if (e.kind === 'rename') {
      sanitizeDeviceName(asText(asMap(e.body, 'rename body').name, 'name', 200));
    } else if (e.kind === 'remove') {
      asBytes(asMap(e.body, 'remove body').target, 'target', 16);
    }
    return () => {
      if (i === 0) this.#setId = genesisSetId;
      this.#raw.set(idHex, e);
      this.#order.push(e);
      this.#depth.set(idHex, depth);
      this.#perDevice.set(signerHex, (this.#perDevice.get(signerHex) ?? 0) + 1);
      if (newKey) {
        const id = toHex(deviceIdFor(newKey));
        if (!this.#keyOf.has(id)) this.#keyOf.set(id, newKey);
      }
      this.#calc = null;
    };
  }
  /** prepare + commit in one step (no disk in between). */
  add(e: SignedEntry): void {
    this.prepare(e)();
  }

  private compute(): Computed {
    const order = [...this.#order].sort((x, y) => (this.#depth.get(toHex(x.id)) as number) - (this.#depth.get(toHex(y.id)) as number) || Buffer.compare(x.id, y.id));
    const n = order.length;
    const pos = new Map<string, number>();
    order.forEach((e, p) => pos.set(toHex(e.id), p));
    const rows: Uint32Array[] = [];
    for (let p = 0; p < n; p++) {
      const row = new Uint32Array((p + 32) >>> 5);
      for (const s of order[p].seen) {
        const j = pos.get(toHex(s)) as number;
        row[j >>> 5] |= 1 << (j & 31);
        const pr = rows[j];
        for (let w = 0; w < pr.length; w++) row[w] |= pr[w];
      }
      rows.push(row);
    }
    const inClosure = (of: number, x: number): boolean => (rows[of][x >>> 5] & (1 << (x & 31))) !== 0;
    const seed = new Set<string>();
    let result: Computed | null = null;
    for (let round = 0; round <= MAX_RESTARTS; round++) {
      const { res, proposed } = this.fold(order, rows, pos, inClosure, seed);
      result = { ...res, pos, rows };
      let grew = false;
      if (round < MAX_RESTARTS) for (const id of proposed) if (!seed.has(id)) { seed.add(id); grew = true; }
      if (!grew) break;
    }
    return result as Computed;
  }

  private fold(order: SignedEntry[], rows: Uint32Array[], pos: Map<string, number>, inClosure: (of: number, x: number) => boolean, seed: Set<string>): { res: Omit<Computed, 'pos' | 'rows'>; proposed: Set<string> } {
    const n = order.length;
    const devices = new Map<string, RosterDevice>();
    const admitted = new Map<string, number>(); // device -> canonical position of its effective introducing add
    const removed = new Set<string>();
    const confirmed = new Set<string>();
    const voided = new Set<string>();
    const facts = new Map<string, EntryFacts>();
    const removalsOf = new Map<string, number[]>(); // target -> effective removal positions
    const byDevice = new Map<string, number[]>(); // signer -> positions of its EFFECTIVE entries
    const known: Array<Set<string>> = [];
    const proposed = new Set<string>();
    const removerOf = (p: number): string => toHex(order[p].device);
    let setId: Buffer = this.#setId as Buffer;
    for (let p = 0; p < n; p++) {
      const e = order[p];
      const idHex = toHex(e.id);
      const signer = toHex(e.device);
      let k: Set<string> = new Set();
      for (const s of e.seen) { const kk = known[pos.get(toHex(s)) as number]; for (const x of kk) k.add(x); }
      let isVoid = seed.has(idHex);
      let knew = false;
      // A revoked entry was found concurrent with a removal of its own signer (the removal sorts after it in this order).
      let concurrentRemoval = isVoid && GATED.has(e.kind);
      if (!isVoid) {
        if (p === 0) {
          // genesis: self-add, accepted at ingest
        } else {
          const introPos = admitted.get(signer);
          if (introPos === undefined || !inClosure(p, introPos)) isVoid = true; // no effective introduction among its ancestors
          else {
            knew = k.has(signer);
            if (knew && GATED.has(e.kind)) isVoid = true; // it knew it was removed
            const rs = removalsOf.get(signer);
            if (!isVoid && rs && rs.length > 0 && GATED.has(e.kind)) {
              concurrentRemoval = true;
              // Entries of a removed device that its remover did not see are void, except one half of a mutual removal.
              let allowed = false;
              if (e.kind === 'remove') {
                const target = toHex(asBytes(asMap(e.body, 'remove body').target, 'target', 16));
                const mutual = rs.filter((r) => removerOf(r) === target && !inClosure(p, r));
                if (mutual.length > 0) {
                  if (this.mutual === 'both') allowed = true;
                  else {
                    const mine = admitted.get(signer) as number;
                    const theirs = admitted.get(target);
                    if (theirs !== undefined && mine < theirs) {
                      allowed = true;
                      for (const r of mutual) proposed.add(toHex(order[r].id)); // the later-admitted device's removal does not stand
                    }
                  }
                }
              }
              if (!allowed) isVoid = true;
            }
          }
        }
      }
      if (!isVoid) {
        if (e.kind === 'add') {
          const info = readAdd(e.body);
          const id = toHex(deviceIdFor(info.signKey));
          if (p > 0 && admitted.has(id)) isVoid = true; // a key can never be overwritten
          else {
            admitted.set(id, p);
            devices.set(id, { ...info, deviceId: deviceIdFor(info.signKey) });
            if (p === 0) { setId = setIdFor(info.signKey); confirmed.add(id); }
          }
        } else if (e.kind === 'rename') {
          const cur = devices.get(signer);
          if (cur) devices.set(signer, { ...cur, name: sanitizeDeviceName(asText(asMap(e.body, 'rename body').name, 'name', 200)) });
        } else if (e.kind === 'remove') {
          const target = toHex(asBytes(asMap(e.body, 'remove body').target, 'target', 16));
          if (!devices.has(target)) isVoid = true; // names a device nobody introduced
          else {
            removed.add(target);
            const list = removalsOf.get(target) ?? [];
            list.push(p);
            removalsOf.set(target, list);
            k.add(target);
            // Retroactive: what the target signed that this removal did not see has no effect (ghost devices, late removals).
            for (const xp of byDevice.get(target) ?? []) {
              const x = order[xp];
              if (!GATED.has(x.kind) || inClosure(p, xp)) continue;
              if (x.kind === 'remove' && toHex(asBytes(asMap(x.body, 'remove body').target, 'target', 16)) === signer && !inClosure(xp, p)) {
                if (this.mutual === 'both') continue; // mutual removal: both stand
              }
              proposed.add(toHex(x.id));
            }
          }
        }
      }
      known.push(k);
      if (isVoid) voided.add(idHex);
      else {
        const l = byDevice.get(signer) ?? [];
        l.push(p);
        byDevice.set(signer, l);
        if (p > 0 || e.kind === 'add') confirmed.add(signer);
      }
      facts.set(idHex, { index: p, signer, kind: e.kind, signerKnewOwnRemoval: knew, signerRemovedEarlierInLog: concurrentRemoval, void: isVoid });
    }
    const removalsHex = new Map<string, string[]>();
    for (const [t, ps] of removalsOf) removalsHex.set(t, ps.map((q) => toHex(order[q].id)));
    return { res: { setId, devices, removed, confirmed, voided, facts, admitted, removalsOf: removalsHex }, proposed };
  }
}

/**
 * Verify a roster log given in any causal order (each entry after the entries it cites). Throws MeshCryptoError('bad-roster'|'bad-entry'|
 * 'malformed'|'low-order-point').
 */
export function verifyRosterLog(entries: readonly SignedEntry[], mutual: MutualRule = DEFAULT_MUTUAL_RULE): RosterVerifier {
  if (entries.length === 0 || entries.length > MAX_ROSTER_ENTRIES) throw new MeshCryptoError('bad-roster', 'size');
  const v = new RosterVerifier(mutual);
  for (const e of entries) v.add(e);
  return v;
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
