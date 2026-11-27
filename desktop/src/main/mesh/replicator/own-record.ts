// The writer's memory of the highest head it has signed, kept in TWO places that rollbacks do not take together (review 2, finding 1):
//   * `<replicator>/own/<wire>`   inside the replicator's own folder;
//   * `<witness>/<wire>`          a sibling folder, outside both the replicator folder and the store folder.
// Each record is 40 bytes: line count (8, big endian) then the 32-byte chain value there. A record that is present but the wrong size is MALFORMED, never "absent": a rotted or cut-short
// file must not read as "this writer has signed nothing".
// WHAT EACH ROLLBACK LEAVES BEHIND: the store put back alone leaves both records above the store (the writer refuses); the replicator folder put back alone leaves the witness (the writer uses it
// and rewrites its own); the store and the replicator folder put back together leave the witness (refused); only a restore of ALL THREE at once is invisible, and that stays the documented limit
// (store inventory limit 4), covered by "wait to hear from the peers" in replicator.ts.
import * as nodePath from 'node:path';
import { reportFailure } from '../../report-failure';
import { mkdirDurable, writeFileAtomic, type Fs } from '../store/fsio';

export interface OwnRecord { lines: number; hash: string }
export type RecordRead = { kind: 'ok'; rec: OwnRecord } | { kind: 'absent' } | { kind: 'malformed' };

async function readOne(fs: Fs, path: string): Promise<RecordRead> {
  let raw: Buffer | null;
  try { raw = await fs.readFile(path); } catch (cause) { reportFailure({ what: 'read the writer\'s own record of its highest head (it is treated as unreadable, not as missing)', cause, where: 'mesh.replicator' }); return { kind: 'malformed' }; }
  if (raw === null) return { kind: 'absent' };
  if (raw.length !== 40) return { kind: 'malformed' };
  const lines = Number(raw.readBigUInt64BE(0));
  if (!Number.isSafeInteger(lines)) return { kind: 'malformed' };
  return { kind: 'ok', rec: { lines, hash: raw.subarray(8, 40).toString('hex') } };
}

export interface OwnEvidence {
  own: RecordRead;
  witness: RecordRead;
  /** The record to trust: the valid one with the most lines (null when none is valid). */
  effective: OwnRecord | null;
  /** The valid record with FEWER lines, when both are valid and differ (its chain value must also lie on the store's chain). */
  lower: OwnRecord | null;
  /** A record exists but cannot be read, or the two disagree about the same count: named, never "no record". */
  problem: 'own-record-unreadable' | 'own-records-disagree' | null;
  /** The replicator-folder record is older than, or missing next to, the witness (that folder was put back or lost). */
  replicatorBehind: boolean;
}

export class OwnRecords {
  constructor(private readonly fs: Fs, private readonly ownDir: string, private readonly witnessDir: string) {}
  async read(wire: Buffer): Promise<OwnEvidence> {
    const name = wire.toString('hex');
    const own = await readOne(this.fs, nodePath.join(this.ownDir, name));
    const witness = await readOne(this.fs, nodePath.join(this.witnessDir, name));
    const valid = [own, witness].flatMap((r) => (r.kind === 'ok' ? [r.rec] : []));
    valid.sort((a, b) => b.lines - a.lines);
    let problem: OwnEvidence['problem'] = own.kind === 'malformed' || witness.kind === 'malformed' ? 'own-record-unreadable' : null;
    if (own.kind === 'ok' && witness.kind === 'ok' && own.rec.lines === witness.rec.lines && own.rec.hash !== witness.rec.hash) problem = 'own-records-disagree';
    const replicatorBehind = witness.kind === 'ok' && (own.kind !== 'ok' || own.rec.lines < witness.rec.lines);
    return { own, witness, effective: valid[0] ?? null, lower: valid.length === 2 && valid[1].lines < valid[0].lines ? valid[1] : null, problem, replicatorBehind };
  }
  /** Write both. Each place that failed is counted; the caller says "durable but not recorded" when neither took it. */
  async save(wire: Buffer, rec: OwnRecord): Promise<{ ok: number; failed: Array<{ where: string; cause: unknown }> }> {
    const b = Buffer.alloc(40); b.writeBigUInt64BE(BigInt(rec.lines), 0); Buffer.from(rec.hash, 'hex').copy(b, 8);
    const failed: Array<{ where: string; cause: unknown }> = []; let ok = 0;
    for (const [where, dir] of [['replicator', this.ownDir], ['witness', this.witnessDir]] as const) {
      try { await mkdirDurable(this.fs, dir); await writeFileAtomic(this.fs, nodePath.join(dir, wire.toString('hex')), b); ok++; } catch (cause) { failed.push({ where, cause }); }
    }
    return { ok, failed };
  }
}
