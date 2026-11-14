// What goes INSIDE a sealed frame for the device layer (design 6.3 "sealed" bodies): group names, kinds and the
// strict shape of each body. Everything here is pure; link.ts seals and opens, service.ts decides what to do.
//
// Only three kinds exist at this layer:
//   roster   { entries[] }                          signed roster entries (design 6.3 "*roster")
//   removal  { entries[], gen, sealed{dev -> blob} } the removal bundle: the `remove` entry and the NEXT generation's
//                                                    secret, sealed separately to each remaining device, as ONE frame
//                                                    so a device never sees one without the other (design 5.1)
//   note     { text }                               TEST MODE ONLY stand-in for a durable payload; the service
//                                                    refuses to send or accept it outside test mode
// Every parser returns plain values or throws MeshCryptoError('malformed'): hostile input never escapes as a raw error.
import { CborValue, asArray, asBytes, asMap, asText, asUint, onlyKeys } from './crypto/cbor';
import { entryToValue, parseEntryValue, MAX_ROSTER_ENTRIES, type SignedEntry } from './crypto/roster';
import { guard } from './crypto/errors';

export const GROUP_ROSTER = 'roster';
export const GROUP_TEST_NOTE = 'note.test';
export const KIND_ROSTER = 'roster';
export const KIND_REMOVAL = 'removal';
export const KIND_NOTE = 'note';
export const KIND_HEADS = 'heads';
export const KIND_NEED = 'need';

export const rosterBody = (entries: readonly SignedEntry[]): CborValue => ({ entries: entries.map(entryToValue) });
export function parseRosterBody(body: unknown): SignedEntry[] {
  return guard(() => {
    const m = asMap(body, 'roster body');
    onlyKeys(m, ['entries'], 'roster body');
    return asArray(m.entries, 'entries', MAX_ROSTER_ENTRIES).map((v) => parseEntryValue(v));
  });
}

/** A generation bundle: a generation statement (signed by whoever made the secret) and the secret sealed, separately, to each device
 *  named in `sealed` (any subset of the members: a holder may re-seal the same secret to a member that lacks it). `entries` are the removal
 *  entries the statement rests on, so a device that has not heard of them can apply them first. Kind name kept from the first design. */
export interface RemovalBundle {
  entries: SignedEntry[];
  stmt: Buffer;
  /** hex device id -> the secret, HPKE-sealed to that device. */
  sealed: Map<string, Buffer>;
}
export const removalBody = (b: RemovalBundle): CborValue => ({
  entries: b.entries.map(entryToValue),
  stmt: b.stmt,
  sealed: Object.fromEntries([...b.sealed.entries()]),
});
export function parseRemovalBody(body: unknown): RemovalBundle {
  return guard(() => {
    const m = asMap(body, 'removal body');
    onlyKeys(m, ['entries', 'stmt', 'sealed'], 'removal body');
    const sealed = new Map<string, Buffer>();
    const sm = asMap(m.sealed, 'sealed');
    const keys = Object.keys(sm);
    if (keys.length > 64) throw new RangeError('too many');
    for (const k of keys) {
      if (!/^[0-9a-f]{32}$/.test(k)) throw new RangeError('device id');
      sealed.set(k, asBytes(sm[k], 'sealed secret'));
    }
    return { entries: asArray(m.entries, 'entries', 64).map((v) => parseEntryValue(v)), stmt: asBytes(m.stmt, 'stmt'), sealed };
  });
}

/** Anti-entropy. `heads`: "these are the newest roster entries I hold". `need`: "send me these entries (and what they rest on)" and
 *  "re-seal these generations to me" (`gens`, labels I could not open). Both carry only ids. */
export const headsBody = (heads: readonly Buffer[]): CborValue => ({ heads: [...heads] });
export function parseHeadsBody(body: unknown): Buffer[] {
  return guard(() => {
    const m = asMap(body, 'heads body');
    onlyKeys(m, ['heads'], 'heads body');
    return asArray(m.heads, 'heads', 64).map((h) => asBytes(h, 'head', 32));
  });
}
export const needBody = (want: readonly Buffer[], gens: readonly number[] = []): CborValue => ({ want: [...want], gens: [...gens] });
export function parseNeedBody(body: unknown): { want: Buffer[]; gens: number[] } {
  return guard(() => {
    const m = asMap(body, 'need body');
    onlyKeys(m, ['want', 'gens'], 'need body');
    return { want: asArray(m.want, 'want', 64).map((h) => asBytes(h, 'want', 32)), gens: asArray(m.gens, 'gens', 8).map((g) => asUint(g, 'gen', 0x7fffffff)) };
  });
}

export const noteBody = (text: string): CborValue => ({ text });
export function parseNoteBody(body: unknown): string {
  return guard(() => {
    const m = asMap(body, 'note body');
    onlyKeys(m, ['text'], 'note body');
    return asText(m.text, 'text', 4096);
  });
}
