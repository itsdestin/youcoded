// The writer's memory of the highest head it has signed, kept in TWO places that partial rollbacks do not take together:
//   * `<replicator>/own/<wire>`   inside the replicator's own folder;
//   * `<witness>/<wire>`          a sibling folder, outside both the replicator folder and the store folder.
// Each record is 44 bytes: line count (8, big endian), the 32-byte chain value there, then a CRC-32 of those 40 bytes. A record that is the wrong size or fails its checksum is BAD, never "no record" and
// never trusted (review 3, finding 5: one flipped bit must not stop a chat for good, nor be signed as `cover`).
// WHAT THIS IS FOR: a cheap detector for partial rollbacks (store alone, replicator folder alone, both). A whole-profile restore puts all three back together; no local record can see that, and the writer's
// gate (replicator.ts `gateOpen`) plus the self-fork backstop (selffork.ts) handle it instead.
// SELF-HEALING: one bad and one good record -> the good one is used and the bad one rewritten (counted). Both bad, or both good but disagreeing at the same count -> `effective` is null and the writer falls back
// to the store's head plus the peer gate (counted, named in status); it is never a permanent refusal.
import * as nodePath from 'node:path';
import { reportFailure } from '../../report-failure';
import { mkdirDurable, writeFileAtomic, type Fs } from '../store/fsio';

export interface OwnRecord { lines: number; hash: string }
type RecordRead = { kind: 'ok'; rec: OwnRecord } | { kind: 'absent' } | { kind: 'bad' };
const RECORD_BYTES = 44;

const crc32 = (b: Buffer): number => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const encode = (rec: OwnRecord): Buffer => { const b = Buffer.alloc(RECORD_BYTES); b.writeBigUInt64BE(BigInt(rec.lines), 0); Buffer.from(rec.hash, 'hex').copy(b, 8); b.writeUInt32BE(crc32(b.subarray(0, 40)), 40); return b; };

async function readOne(fs: Fs, path: string): Promise<RecordRead> {
  let raw: Buffer | null;
  try { raw = await fs.readFile(path); } catch (cause) { reportFailure({ what: 'read the writer\'s own record of its highest head (treated as bad, not as missing)', cause, where: 'mesh.replicator' }); return { kind: 'bad' }; }
  if (raw === null) return { kind: 'absent' };
  if (raw.length !== RECORD_BYTES || raw.readUInt32BE(40) !== crc32(raw.subarray(0, 40))) return { kind: 'bad' };
  const lines = Number(raw.readBigUInt64BE(0));
  if (!Number.isSafeInteger(lines)) return { kind: 'bad' };
  return { kind: 'ok', rec: { lines, hash: raw.subarray(8, 40).toString('hex') } };
}

export interface OwnEvidence {
  own: RecordRead;
  witness: RecordRead;
  /** The record to trust: the checksum-valid one with the most lines; null when none is usable or the two disagree at one count. */
  effective: OwnRecord | null;
  /** The valid record with FEWER lines, when both are valid and differ (its chain value must also lie on the store's chain). */
  lower: OwnRecord | null;
  /** Both records are valid and agree (or only one exists and is valid): safe to sign as `cover`. */
  trusted: boolean;
  /** Why `effective` is null although a record file exists: the writer then uses the store head plus the peer gate. */
  fallback: 'own-records-unusable' | 'own-records-disagree' | null;
  /** One record was bad and the other good: the bad one was rewritten (counted by the caller). */
  healed: boolean;
}

export class OwnRecords {
  constructor(private readonly fs: Fs, private readonly ownDir: string, private readonly witnessDir: string) {}
  private path(dir: string, wire: Buffer): string { return nodePath.join(dir, wire.toString('hex')); }
  async read(wire: Buffer, heal = true): Promise<OwnEvidence> {
    const own = await readOne(this.fs, this.path(this.ownDir, wire));
    const witness = await readOne(this.fs, this.path(this.witnessDir, wire));
    const valid = [own, witness].flatMap((r) => (r.kind === 'ok' ? [r.rec] : []));
    valid.sort((a, b) => b.lines - a.lines);
    let fallback: OwnEvidence['fallback'] = null; let healed = false;
    if (own.kind === 'ok' && witness.kind === 'ok' && own.rec.lines === witness.rec.lines && own.rec.hash !== witness.rec.hash) fallback = 'own-records-disagree';
    else if (valid.length === 0 && (own.kind === 'bad' || witness.kind === 'bad')) fallback = 'own-records-unusable';
    if (heal && !fallback && valid.length === 1 && (own.kind === 'bad' || witness.kind === 'bad')) {
      // one good record: rewrite the bad one from it
      const r = await this.save(wire, valid[0]); healed = r.ok === 2;
    }
    const effective = fallback ? null : (valid[0] ?? null);
    return { own, witness, effective, lower: !fallback && valid.length === 2 && valid[1].lines < valid[0].lines ? valid[1] : null, trusted: (own.kind === 'ok' && witness.kind === 'ok' && own.rec.lines === witness.rec.lines && !fallback) || healed, fallback, healed };
  }
  /** Forget both records of a version (its history moved to a second version, so they describe lines it no longer holds). */
  async clear(wire: Buffer): Promise<void> {
    for (const dir of [this.ownDir, this.witnessDir]) { try { await this.fs.unlink(this.path(dir, wire)); } catch (cause) { reportFailure({ what: 'forget a writer record that no longer applies', cause, where: 'mesh.replicator' }); } }
  }
  /** Write both. Each place that failed is reported; the caller says "durable but not recorded" when either did not take it. */
  async save(wire: Buffer, rec: OwnRecord): Promise<{ ok: number; failed: Array<{ where: string; cause: unknown }> }> {
    const b = encode(rec);
    const failed: Array<{ where: string; cause: unknown }> = []; let ok = 0;
    for (const [where, dir] of [['replicator', this.ownDir], ['witness', this.witnessDir]] as const) {
      try { await mkdirDurable(this.fs, dir); await writeFileAtomic(this.fs, this.path(dir, wire), b); ok++; } catch (cause) { failed.push({ where, cause }); }
    }
    return { ok, failed };
  }
}
