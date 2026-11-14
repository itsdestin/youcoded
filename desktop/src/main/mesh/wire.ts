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

export const rosterBody = (entries: readonly SignedEntry[]): CborValue => ({ entries: entries.map(entryToValue) });
export function parseRosterBody(body: unknown): SignedEntry[] {
  return guard(() => {
    const m = asMap(body, 'roster body');
    onlyKeys(m, ['entries'], 'roster body');
    return asArray(m.entries, 'entries', MAX_ROSTER_ENTRIES).map((v) => parseEntryValue(v));
  });
}

export interface RemovalBundle {
  entries: SignedEntry[];
  gen: number;
  /** hex device id -> the new generation's secret, HPKE-sealed to that device. */
  sealed: Map<string, Buffer>;
}
export const removalBody = (b: RemovalBundle): CborValue => ({
  entries: b.entries.map(entryToValue),
  gen: b.gen,
  sealed: Object.fromEntries([...b.sealed.entries()]),
});
export function parseRemovalBody(body: unknown): RemovalBundle {
  return guard(() => {
    const m = asMap(body, 'removal body');
    onlyKeys(m, ['entries', 'gen', 'sealed'], 'removal body');
    const sealed = new Map<string, Buffer>();
    const sm = asMap(m.sealed, 'sealed');
    const keys = Object.keys(sm);
    if (keys.length > 64) throw new RangeError('too many');
    for (const k of keys) {
      if (!/^[0-9a-f]{32}$/.test(k)) throw new RangeError('device id');
      sealed.set(k, asBytes(sm[k], 'sealed secret'));
    }
    return { entries: asArray(m.entries, 'entries', 64).map((v) => parseEntryValue(v)), gen: asUint(m.gen, 'gen', 0xffffffff), sealed };
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
