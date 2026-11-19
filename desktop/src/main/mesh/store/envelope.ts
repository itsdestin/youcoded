// THE ENVELOPE: the one way every small file the store writes says what it is (review 5, class fix).
//
// WHY: five review rounds found the same bug five times, "a file that does not state what it is" (round 3: bad bytes; round 4: valid but older, foreign, missing or cut;
// round 5: parked appends whose position lived only in the file NAME, set-aside tails with no takeover id). Fixing one file kind at a time never ended it. So there is ONE
// helper that writes and ONE reader that reads, and what sits INSIDE the checksum is always:
//   role     what kind of file this is ('meta', 'park', 'tail', 'marks', 'highwater', 'anchor', ...): a valid file of another kind is not believed
//   version  the version key (or, for a chat's control folder, the chat hash) the file belongs to: another chat's file is not believed
//   id       the position or identifier the file stands for (a park's line number and line hash, a tail's takeover id): what the NAME claims is checked against it
//   fresh    a freshness counter where one applies (a slot's sequence number): the slot readers (slotfile.ts) let the newer slot win, so an older copy of a slot file loses
// The reader is given what the CALLER expects and compares every field. A file that fails its checksum is `bad`; a file with a good checksum that is not the file the caller
// asked for is `foreign` (typed: callers keep it, never delete it, never adopt it, and say why). No file is ever interpreted from its name alone.
//
// Layout (big-endian): 'YCE2' | header length u32 | header JSON {r, v, i, f} | payload length u32 | payload | crc32 over everything before it.
import { crc32 } from './chain';

const MAGIC = Buffer.from('YCE2', 'ascii');

export interface EnvId { role: string; version: string; id?: string | number | null; fresh?: number }
export type EnvRead =
  | { kind: 'absent' }
  | { kind: 'bad' }
  | { kind: 'foreign'; why: string; /** what the file says it is (inside its checksum), for callers that need to tell a misplaced file from an overwritten one */ seen: { role: string; version: string; id: string | number | null } }
  | { kind: 'ok'; payload: Buffer; fresh: number; id: string | number | null };

/** Seal `payload` with the identity `id` inside the checksum. */
export function sealEnv(id: EnvId, payload: Uint8Array): Buffer {
  const header = Buffer.from(JSON.stringify({ r: id.role, v: id.version, i: id.id ?? null, f: id.fresh ?? 0 }), 'utf8');
  const hl = Buffer.alloc(4); hl.writeUInt32BE(header.length);
  const pl = Buffer.alloc(4); pl.writeUInt32BE(payload.length);
  const body = Buffer.concat([MAGIC, hl, header, pl, payload]);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body));
  return Buffer.concat([body, tail]);
}

/**
 * Open an envelope and compare it with what the caller expects. `want.id` undefined means "any id" (the caller checks it itself, e.g. the aside note's name);
 * `padded`: a fixed-size slot may carry zero padding after the checksum.
 */
export function openEnv(b: Buffer | null, want: { role: string; version: string; id?: string | number | null }, padded = false): EnvRead {
  if (b === null) return { kind: 'absent' };
  if (b.length < 16 || !b.subarray(0, 4).equals(MAGIC)) return { kind: 'bad' };
  const hl = b.readUInt32BE(4);
  if (8 + hl + 4 > b.length) return { kind: 'bad' };
  const pl = b.readUInt32BE(8 + hl);
  const end = 12 + hl + pl;
  if (end + 4 > b.length || (!padded && end + 4 !== b.length)) return { kind: 'bad' };
  if (crc32(b, 0, end) !== b.readUInt32BE(end)) return { kind: 'bad' };
  let h: { r?: unknown; v?: unknown; i?: unknown; f?: unknown };
  try { h = JSON.parse(b.subarray(8, 8 + hl).toString('utf8')); } catch { return { kind: 'bad' }; }
  if (!h || typeof h !== 'object' || typeof h.r !== 'string' || typeof h.v !== 'string' || !Number.isSafeInteger(h.f)) return { kind: 'bad' };
  const seen = { role: h.r, version: h.v, id: (h.i ?? null) as string | number | null };
  if (h.r !== want.role) return { kind: 'foreign', why: `role ${h.r}, expected ${want.role}`, seen };
  if (h.v !== want.version) return { kind: 'foreign', why: 'belongs to another version or chat', seen };
  if (want.id !== undefined && h.i !== want.id) return { kind: 'foreign', why: `stands for ${String(h.i)}, expected ${String(want.id)}`, seen };
  return { kind: 'ok', payload: Buffer.from(b.subarray(12 + hl, end)), fresh: h.f as number, id: (h.i ?? null) as string | number | null };
}
