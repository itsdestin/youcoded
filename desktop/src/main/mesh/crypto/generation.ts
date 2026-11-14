// Generation statements: what a set secret is FOR (review N3, gaps G7/G8; design 5.1 "removing a device").
//
// A generation is one shared set secret. Its identity is a function of the exact state it was made for, never of a counter two devices
// can both bump at once:
//     label   = a number in [2, 2^31) taken from SHA-256( LABEL+"gen\0" || setId || sorted removed device ids || minter id )
//               (the very first secret, made with the set, is label 1: removed set empty, minter = the creator)
//     statement = { set, label, removed[], members[], minter, commit = SHA-256(secret) }  signed by the MINTER
// `removed` is every device removed when the secret was made; `members` is every device that was a member then (the devices the secret was
// sealed to). Both are sorted, so two devices that know the same removals compute the same removed set and the same label for the same
// minter. A secret made for removed set R is "current" exactly when R equals the removed set a device now holds from its roster; a
// device that learns of one more removal needs a new secret for the larger set. No removed device was ever sealed one.
//
// WHY `commit`: a secret can be handed on by ANY holder (to a member the minter missed, or that asked again); the signed commitment lets
// the receiver check it got the minter's real secret and not a holder's invention.
// WHY the minter is in the identity: two honest devices may both make a secret for the same removed set (a takeover after a slow device);
// they get different labels, every member receives both, and the lowest minter id is the one new frames are sealed under.
import { LABEL, concat, ctEqual, sha256, toHex, utf8, type Bytes } from './bytes';
import { asBytes, asArray, asMap, asUint, decode, encode, onlyKeys } from './cbor';
import { MeshCryptoError, guard } from './errors';
import { deviceIdFor, signWith, verifySig, type DeviceIdentity } from './identity';

export const GEN_LABEL_FIRST = 1;
export const MAX_GEN_DEVICES = 64;

export interface GenStatement {
  set: Buffer;
  label: number;
  /** Sorted device ids (16 bytes). */
  removed: Buffer[];
  members: Buffer[];
  minter: Buffer;
  commit: Buffer;
  signature: Buffer;
}

const sortIds = (ids: readonly Bytes[]): Buffer[] => ids.map((i) => Buffer.from(i)).sort((a, b) => Buffer.compare(a, b));
export const removedKey = (removed: readonly Bytes[]): string => sortIds(removed).map((r) => toHex(r)).join(',');

/** The label of the secret `minter` makes for removed set `removed`. */
export function genLabel(setId: Bytes, removed: readonly Bytes[], minter: Bytes): number {
  const r = sortIds(removed);
  if (r.length === 0) return GEN_LABEL_FIRST; // the secret made with the set (only its creator can make it, see verifyStatement)
  const h = sha256(utf8(LABEL + 'gen\0'), setId, ...r, minter);
  return 2 + (h.readUInt32BE(0) % 0x7ffffffd);
}

const bodyValue = (s: Omit<GenStatement, 'signature'>) => ({ v: 1, set: s.set, label: s.label, removed: s.removed, members: s.members, minter: s.minter, commit: s.commit });
const sigMessage = (s: Omit<GenStatement, 'signature'>): Buffer => concat(utf8(LABEL + 'gen-stmt\0'), encode(bodyValue(s)));

export function signStatement(minter: DeviceIdentity, f: { set: Bytes; removed: readonly Bytes[]; members: readonly Bytes[]; secret: Bytes }): GenStatement {
  const removed = sortIds(f.removed);
  const members = sortIds(f.members);
  const base = { set: Buffer.from(f.set), label: genLabel(f.set, removed, minter.deviceId), removed, members, minter: minter.deviceId, commit: sha256(f.secret) };
  return { ...base, signature: signWith(minter, sigMessage(base)) };
}
export const encodeStatement = (s: GenStatement): Buffer => encode({ ...bodyValue(s), signature: s.signature });

export function parseStatement(bytes: Uint8Array): GenStatement {
  return guard(() => {
    const m = asMap(decode(bytes), 'gen statement');
    onlyKeys(m, ['v', 'set', 'label', 'removed', 'members', 'minter', 'commit', 'signature'], 'gen statement');
    if (asUint(m.v, 'v') !== 1) throw new MeshCryptoError('unsupported-version', 'gen statement');
    const ids = (v: unknown, what: string): Buffer[] => asArray(v, what, MAX_GEN_DEVICES).map((x) => asBytes(x, what, 16));
    const removed = ids(m.removed, 'removed');
    const members = ids(m.members, 'members');
    // Canonical form only: sorted and without repeats, so one statement has one spelling.
    for (const l of [removed, members]) for (let i = 1; i < l.length; i++) if (Buffer.compare(l[i - 1], l[i]) >= 0) throw new MeshCryptoError('malformed', 'ids not sorted');
    return { set: asBytes(m.set, 'set', 32), label: asUint(m.label, 'label', 0x7fffffff), removed, members, minter: asBytes(m.minter, 'minter', 16), commit: asBytes(m.commit, 'commit', 32), signature: asBytes(m.signature, 'signature', 64) };
  });
}

/** Signature, label and shape. Never throws. `minterSignKey` is the minter's key from the roster. */
export function verifyStatement(s: GenStatement, minterSignKey: Bytes, setId: Bytes, setCreatorSignKey?: Bytes): boolean {
  try {
    if (!ctEqual(s.set, setId)) return false;
    if (!ctEqual(deviceIdFor(minterSignKey), s.minter)) return false;
    if (s.label !== genLabel(setId, s.removed, s.minter)) return false;
    if (s.removed.length === 0 && setCreatorSignKey && !ctEqual(setCreatorSignKey, minterSignKey)) return false; // label 1 is the creator's alone
    if (s.members.length === 0 || !s.members.some((m) => ctEqual(m, s.minter))) return false; // the minter is one of the members
    if (s.removed.some((r) => ctEqual(r, s.minter) || s.members.some((m) => ctEqual(m, r)))) return false; // nobody is both
    return verifySig(minterSignKey, sigMessage(s), s.signature);
  } catch {
    return false;
  }
}

/** Does `secret` match the statement's commitment? */
export const secretMatches = (s: GenStatement, secret: Bytes): boolean => ctEqual(sha256(secret), s.commit);
