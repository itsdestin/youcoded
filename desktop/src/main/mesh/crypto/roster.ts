// Signed entries and the device roster (T5 C8; design 5.1 "Roster", 6.2).
//
// SCOPE: this file builds and VERIFIES signed entries and checks that a roster log is signed by
// devices that were in it. It deliberately does NOT decide anything: no cut-off, no witness
// rules, no "two devices removing each other" outcome, no void/valid ruling. Those merge/decide
// rules belong to another part (T5 gaps G6/G7/G8). So `verifyRosterLog` reports keys, never
// "who is currently a member"; a removed device's key stays in the map because frames it signed
// before removal must still verify, and whether a later entry counts is the decide layer's call.
//
// Entry id and signature (gap G5, previously unspecified):
//   id        = SHA-256( LABEL+"entry\0" || canonical{chat, kind, body, seen, at, device} )
//   signature = Ed25519( LABEL+"entry-sig\0" || id )
// The id depends only on content, so two devices compute the same id; the signature covers the
// id, so any edit to any field breaks it. `witness` and `cutoff` entries use the same rule.
import { LABEL, concat, ctEqual, sha256, toHex, utf8, type Bytes } from './bytes';
import { CborValue, asArray, asBytes, asMap, asText, asUint, decode, encode, onlyKeys, type CborMap } from './cbor';
import { MeshCryptoError, guard } from './errors';
import { deviceIdFor, setIdFor, signWith, verifySig, type DeviceIdentity } from './identity';

export const MAX_ROSTER_ENTRIES = 4096;
export const MAX_DEVICE_NAME = 40;

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
      body: m.body as CborValue,
      seen: asArray(m.seen, 'seen', 1024).map((s) => asBytes(s, 'seen id', 32)),
      at: asUint(m.at, 'at'),
      signature: asBytes(m.signature, 'signature', 64),
    };
  });
}
export const parseEntry = (bytes: Uint8Array): SignedEntry => parseEntryValue(decode(bytes));

// ---- device names shown to people (threat model P-5) ----
// Strip control characters, bidi overrides/isolates and zero-width characters (they can make
// "Laptop" display as something else), cap at 40 characters, never return empty.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/g;
export function sanitizeDeviceName(raw: string): string {
  const cleaned = Array.from(String(raw).replace(UNSAFE_CHARS, '')).slice(0, MAX_DEVICE_NAME).join('').trim();
  return cleaned || 'Unnamed device';
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

const addBody = (d: RosterDeviceInfo): CborValue => ({ name: sanitizeDeviceName(d.name), platform: asText(d.platform, 'platform', 32), signKey: d.signKey, agreeKey: d.agreeKey });

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
  return { name: asText(m.name, 'name', 200), platform: asText(m.platform, 'platform', 32), signKey: asBytes(m.signKey, 'signKey', 32), agreeKey: asBytes(m.agreeKey, 'agreeKey', 32) };
}

export interface VerifiedRoster {
  setId: Buffer;
  /** Every device that was ever added, by hex device id. Includes removed devices (see file header). */
  devices: Map<string, RosterDevice>;
}

/**
 * Verify a roster log given in an order where each signer's `add` precedes its entries (the order
 * a pairing welcome and a keeper's log both use). Checks: genesis is a self-add; every later entry
 * is signed by a device added earlier in the log; ids match content; `add` bodies are well formed;
 * `remove` names a known device; no duplicate ids. Throws MeshCryptoError('bad-roster'|'bad-entry').
 */
export function verifyRosterLog(entries: readonly SignedEntry[]): VerifiedRoster {
  if (entries.length === 0 || entries.length > MAX_ROSTER_ENTRIES) throw new MeshCryptoError('bad-roster', 'size');
  const devices = new Map<string, RosterDevice>();
  const ids = new Set<string>();
  let setId: Buffer | undefined;
  entries.forEach((e, i) => {
    const idHex = toHex(e.id);
    if (ids.has(idHex)) throw new MeshCryptoError('bad-roster', 'duplicate entry');
    ids.add(idHex);
    let signer: RosterDevice | undefined;
    if (i === 0) {
      if (e.kind !== 'add') throw new MeshCryptoError('bad-roster', 'genesis must be an add');
      const self = readAdd(e.body);
      signer = { ...self, deviceId: deviceIdFor(self.signKey) };
      if (!ctEqual(signer.deviceId, e.device)) throw new MeshCryptoError('bad-roster', 'genesis must be self-signed');
      setId = setIdFor(self.signKey);
    } else {
      signer = devices.get(toHex(e.device));
      if (!signer) throw new MeshCryptoError('bad-roster', 'signer not yet in roster');
    }
    if (!verifyEntry(e, signer.signKey)) throw new MeshCryptoError('bad-entry', e.kind);
    if (e.kind === 'add') {
      const info = readAdd(e.body);
      devices.set(toHex(deviceIdFor(info.signKey)), { ...info, deviceId: deviceIdFor(info.signKey) });
    } else if (e.kind === 'rename') {
      const m = asMap(e.body, 'rename body');
      const cur = devices.get(toHex(e.device));
      if (cur) devices.set(toHex(e.device), { ...cur, name: asText(m.name, 'name', 200) });
    } else if (e.kind === 'remove') {
      const m = asMap(e.body, 'remove body');
      if (!devices.has(toHex(asBytes(m.target, 'target', 16)))) throw new MeshCryptoError('bad-roster', 'remove names unknown device');
    }
    // Other kinds (witness, cutoff, ...) are signature-checked above and otherwise passed through untouched.
  });
  return { setId: setId as Buffer, devices };
}
