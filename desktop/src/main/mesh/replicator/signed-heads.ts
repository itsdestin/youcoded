// The writer's signed heads that this device has SEEN, kept so it can serve "everything after N" to a third device and so a later
// eviction proof has something to cite (plan section 4). One append-only file per version: heads/<wire id hex>.sh.
//
// WHAT A POINT IS: the writer's signature over (version, lines, chain value). A batch of lines can only be verified when the chain value at
// its END is signed, so a device can serve a batch only if it holds a signed point where that batch ends. The WRITER does not need this file
// to serve (it can sign any count it holds, on demand); every other device does. So `nextAfter(n)` is what limits a non-writer's batches.
//
// FILE: fixed 112-byte records: lines (8, big endian) | chain value (32) | signature (64) | spanBytes (4) | CRC32 (4, over the first 108).
// WHY fixed-size records: after a torn or rotted record every later record is still found, and an append never has to know what came before.
// A record that fails its CRC is skipped (and counted in `skipped`); a short tail is a torn write: the next append starts at the last whole record.
// A signature is NOT re-checked when the file is read (the caller checks it before `add`, and again before serving, see serve.ts): the CRC only says the bytes are what was written.
//
// THINNING: every received head is appended (the newest one must always be servable), and when the file passes THIN_AT records it is rewritten
// (temp file, fsync, rename) keeping the newest point and any point that is 32 lines or 64 KiB of payload after the one kept before it. `spanBytes` is the
// payload between the previous record and this one as the receiver saw it (0xffffffff = unknown, never merged away), which is what keeps every span a
// future batch could need under the frame budget.
import * as nodePath from 'node:path';
import { crc32 } from '../store/chain';
import { mkdirDurable, writeFileAtomic, type Fs } from '../store/fsio';

export interface Point { lines: number; hash: Buffer; sig: Buffer; spanBytes: number }
export const RECORD_BYTES = 112;
export const UNKNOWN_SPAN = 0xffffffff;
export const THIN_AT = 256;
export const KEEP_EVERY_LINES = 32;
export const KEEP_EVERY_BYTES = 64 * 1024;
/** Most points kept per version after a thinning; a version this long needs a coarser rule (loud: `add` refuses with 'full' rather than grow without bound). */
export const MAX_POINTS = 1 << 16;

function encodeRecord(p: Point): Buffer {
  const b = Buffer.alloc(RECORD_BYTES);
  b.writeBigUInt64BE(BigInt(p.lines), 0);
  p.hash.copy(b, 8);
  p.sig.copy(b, 40);
  b.writeUInt32BE(p.spanBytes >>> 0, 104);
  b.writeUInt32BE(crc32(b, 0, 108) >>> 0, 108);
  return b;
}
function decodeRecord(b: Buffer): Point | null {
  if (b.length !== RECORD_BYTES || (crc32(b, 0, 108) >>> 0) !== b.readUInt32BE(108)) return null;
  const lines = Number(b.readBigUInt64BE(0));
  if (!Number.isSafeInteger(lines)) return null;
  return { lines, hash: Buffer.from(b.subarray(8, 40)), sig: Buffer.from(b.subarray(40, 104)), spanBytes: b.readUInt32BE(104) };
}

export class SignedHeads {
  readonly #cache = new Map<string, { points: Point[]; fileRecords: number }>();
  /** Records skipped because they failed their CRC, since this object was made (a number for status, never an error: the points that remain are still true). */
  skipped = 0;
  constructor(private readonly fs: Fs, private readonly dir: string) {}
  private file(wire: Buffer): string { return nodePath.join(this.dir, 'heads', `${wire.toString('hex')}.sh`); }

  async load(wire: Buffer): Promise<Point[]> {
    const key = wire.toString('hex');
    const hit = this.#cache.get(key);
    if (hit) return hit.points;
    const raw = await this.fs.readFile(this.file(wire));
    const points: Point[] = [];
    let n = 0;
    if (raw) {
      n = Math.floor(raw.length / RECORD_BYTES);
      for (let i = 0; i < n; i++) {
        const p = decodeRecord(raw.subarray(i * RECORD_BYTES, (i + 1) * RECORD_BYTES));
        if (!p) { this.skipped++; continue; }
        // WHY sorted insert, not "in file order": a rotted record in the middle must not reorder the rest; and two records for one count with different values are KEPT as read, the caller's `add` refuses a new conflicting one.
        points.push(p);
      }
      points.sort((a, b) => a.lines - b.lines);
    }
    this.#cache.set(key, { points, fileRecords: n });
    return points;
  }

  /** 'added', 'known' (same count and value already held), 'conflict' (the same count with another value: the writer signed two histories) or 'full'. */
  async add(wire: Buffer, p: Point): Promise<'added' | 'known' | 'conflict' | 'full'> {
    const points = await this.load(wire);
    const same = points.find((q) => q.lines === p.lines);
    if (same) return same.hash.equals(p.hash) ? 'known' : 'conflict';
    if (points.length >= MAX_POINTS) return 'full';
    const key = wire.toString('hex');
    const entry = this.#cache.get(key) as { points: Point[]; fileRecords: number };
    await this.appendRecord(wire, entry, p);
    points.push(p);
    points.sort((a, b) => a.lines - b.lines);
    if (entry.fileRecords > THIN_AT) await this.thin(wire, entry);
    return 'added';
  }

  /** The smallest held point above `lines`, or null. */
  async nextAfter(wire: Buffer, lines: number): Promise<Point | null> {
    for (const p of await this.load(wire)) if (p.lines > lines) return p;
    return null;
  }
  /** The newest held point (the highest count), or null. */
  async newest(wire: Buffer): Promise<Point | null> {
    const pts = await this.load(wire);
    return pts.length ? pts[pts.length - 1] : null;
  }
  forget(wire: Buffer): void { this.#cache.delete(wire.toString('hex')); }

  private async appendRecord(wire: Buffer, entry: { fileRecords: number }, p: Point): Promise<void> {
    const dir = nodePath.dirname(this.file(wire));
    const fresh = !(await this.fs.exists(this.file(wire)));
    await mkdirDurable(this.fs, dir);
    const f = await this.fs.open(this.file(wire), { create: true });
    try {
      // WHY floor(size / record): a torn tail is a partial record; writing the next one at the last whole boundary replaces it.
      const size = await f.size();
      const at = Math.floor(size / RECORD_BYTES) * RECORD_BYTES;
      // DESTRUCTIVE-OK(torn-tail): bytes past the last whole record are the cut-off start of a record that was never acknowledged
      if (size !== at) await f.truncate(at);
      await f.write(encodeRecord(p), at);
      await f.sync();
      entry.fileRecords = at / RECORD_BYTES + 1;
    } finally { await f.close(); }
    if (fresh) await this.fs.fsyncDir(dir);
  }

  private async thin(wire: Buffer, entry: { points: Point[]; fileRecords: number }): Promise<void> {
    const kept: Point[] = [];
    let linesSince = 0; let bytesSince = 0;
    for (let i = 0; i < entry.points.length; i++) {
      const p = entry.points[i];
      const prevLines = i > 0 ? entry.points[i - 1].lines : 0;
      linesSince += p.lines - prevLines;
      bytesSince = p.spanBytes === UNKNOWN_SPAN || bytesSince === UNKNOWN_SPAN ? UNKNOWN_SPAN : bytesSince + p.spanBytes;
      const last = i === entry.points.length - 1;
      if (last || bytesSince === UNKNOWN_SPAN || linesSince >= KEEP_EVERY_LINES || bytesSince >= KEEP_EVERY_BYTES) {
        // the merged record's span is everything since the previous KEPT point, so the budget guarantee still holds across the dropped ones
        kept.push({ ...p, spanBytes: bytesSince === UNKNOWN_SPAN ? UNKNOWN_SPAN : Math.min(bytesSince, UNKNOWN_SPAN - 1) });
        linesSince = 0; bytesSince = 0;
      }
    }
    // DESTRUCTIVE-OK(thinning): whole-file atomic replace; the dropped points are covered by the kept ones (each kept point's span includes them), and a crash leaves the old, longer file
    await writeFileAtomic(this.fs, this.file(wire), Buffer.concat(kept.map(encodeRecord)));
    entry.points.splice(0, entry.points.length, ...kept);
    entry.fileRecords = kept.length;
  }
}
