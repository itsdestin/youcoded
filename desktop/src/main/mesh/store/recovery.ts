// Body-file helpers for the chat store (split out of store.ts to keep it inside its line budget): chunk
// layout checks, re-deriving index records from body bytes, and moving unacknowledged or cut-off bytes
// aside (torn/) instead of deleting them. Pure helpers over the Fs door; they hold no store state.
import * as nodePath from 'node:path';
import { writeFileAtomic, mkdirDurable, type Fs } from './fsio';
import { StoreError } from './errors';
import { chainStep, type ChainSeeds, type RuntimeKind } from './chain';
import { analyseLine, initialReplyState, replyEndStep, type LineInfo, type ReplyEndOptions, type ReplyState } from './classify';
import { HDR, REC, NONE, decodeRecord, encodeRecord, headerOk, headerStamp, indexHeader, recPos } from './records';

const MIB = 1024 * 1024;
const SCAN_BATCH = 4096;
/** Kept debris folders (torn/) are pruned to the newest few: they only ever hold unacknowledged or redundant bytes. */
const TORN_KEEP = 8;

/** Internal: the index can be repaired by re-deriving it from the body. */
export class NeedsRebuild extends Error { constructor(readonly reason: string) { super(reason); } }
/** Internal: not repairable; the store quarantines the version. */
export class Damaged extends Error { constructor(readonly reason: string) { super(reason); } }

/** The running state a batch of lines is encoded against. */
export interface BatchState { count: number; h: Buffer; c: Buffer; convCount: number; off: number; rs: ReplyState }
export interface SumFacts { title: string | null; model: string | null; cwd: string | null }

export function chunkPathOf(dir: string, start: number): string { return nodePath.join(dir, `body-${start.toString(16).padStart(16, '0')}.bin`); }

export class BodyTools {
  constructor(private readonly fs: Fs, private readonly replyOpts: ReplyEndOptions) {}

  async fileSize(path: string): Promise<number> {
    const f = await this.fs.open(path, { create: false });
    try { return await f.size(); } finally { await f.close(); }
  }

  async listChunks(dir: string): Promise<number[]> {
    const chunks: number[] = [];
    for (const name of await this.fs.readdir(dir)) {
      const m = /^body-([0-9a-f]{16})\.bin$/.exec(name);
      if (m) chunks.push(parseInt(m[1], 16));
    }
    return chunks.sort((a, b) => a - b);
  }

  /** Chunk files must meet end to end and the first must not start past the evicted bytes. */
  async checkChunks(dir: string, ev: { lines: number; bytes: number }): Promise<{ chunks: number[]; sizes: number[]; phys: number }> {
    const chunks = await this.listChunks(dir);
    const sizes: number[] = [];
    for (const c of chunks) sizes.push(await this.fileSize(chunkPathOf(dir, c)));
    if (!chunks.length) return { chunks, sizes, phys: ev.bytes };
    for (let i = 0; i + 1 < chunks.length; i++) {
      if (chunks[i] + sizes[i] !== chunks[i + 1]) throw new Damaged(`body chunk ${chunks[i].toString(16)} does not meet the next (a chunk is missing or the wrong length)`);
    }
    if (chunks[0] > ev.bytes) throw new Damaged('the first body chunk is missing');
    const i = chunks.length - 1;
    return { chunks, sizes, phys: chunks[i] + sizes[i] };
  }

  /**
   * Walk the body from `start.off`, split into lines, encode records in batches and hand each batch to
   * `onBatch`. Stops after `limit` lines. Returns the final state and the byte offset after the last whole line.
   */
  async deriveFromBody(dir: string, layout: { chunks: number[]; sizes: number[] }, runtime: RuntimeKind, start: BatchState, limit: number,
    onBatch: (recs: Buffer, firstLine: number, n: number) => Promise<void>): Promise<{ state: BatchState; end: number }> {
    const s: BatchState = { ...start };
    const sum: SumFacts = { title: null, model: null, cwd: null };
    let lines: Buffer[] = []; let lineBytes = 0; let emitted = 0;
    const flush = async () => {
      if (!lines.length) return;
      const first = s.count;
      const { recs } = this.encodeBatch(runtime, s, lines, sum);
      await onBatch(recs, first, lines.length);
      lines = []; lineBytes = 0;
    };
    outer: for (let ci = 0; ci < layout.chunks.length; ci++) {
      const cstart = layout.chunks[ci]; const cend = cstart + layout.sizes[ci];
      if (cend <= start.off) continue;
      let pos = Math.max(start.off, cstart);
      const cf = await this.fs.open(chunkPathOf(dir, cstart), { create: false });
      let carry: Buffer = Buffer.alloc(0);
      try {
        while (pos < cend) {
          const block = await cf.read(pos - cstart, Math.min(4 * MIB, cend - pos));
          if (block.length === 0) throw new Damaged('body chunk shorter than its size');
          pos += block.length;
          const data = carry.length ? Buffer.concat([carry, block]) : block;
          let from = 0; let nl: number;
          while ((nl = data.indexOf(0x0a, from)) !== -1) {
            lines.push(Buffer.from(data.subarray(from, nl + 1))); lineBytes += nl + 1 - from; from = nl + 1; emitted++;
            if (lineBytes >= 8 * MIB || lines.length >= SCAN_BATCH) await flush();
            if (emitted >= limit) { await flush(); break outer; }
          }
          carry = Buffer.from(data.subarray(from));
        }
      } finally { await cf.close(); }
      if (carry.length && ci + 1 < layout.chunks.length) throw new Damaged('a line runs across two body chunks');
    }
    await flush();
    return { state: s, end: s.off };
  }

  /**
   * Encode `lines` as index records continuing `s` (which is advanced). Shared by appends and by every
   * recovery path, so a rebuilt record is identical to the one an append would have written.
   */
  encodeBatch(runtime: RuntimeKind, s: BatchState, lines: Buffer[], sum: SumFacts): { recs: Buffer; confirmed: number[] } {
    const recs = Buffer.alloc(lines.length * REC);
    const confirmed: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const info: LineInfo = analyseLine(runtime, line);
      s.h = chainStep(s.h, line);
      if (info.conversation) { s.c = chainStep(s.c, line); s.convCount++; }
      const step = replyEndStep(runtime, s.rs, info, s.count, this.replyOpts);
      s.rs = step.rs;
      if (step.confirmed.length > 1) throw new StoreError('corrupt', 'one line confirmed several reply ends');
      if (step.confirmed.length === 1) confirmed.push(step.confirmed[0]);
      let fact = false;
      if (info.title !== undefined && info.title !== sum.title) { sum.title = info.title; fact = true; }
      if (info.model !== undefined && info.model !== sum.model) { sum.model = info.model; fact = true; }
      if (info.cwd !== undefined && sum.cwd === null) { sum.cwd = info.cwd; fact = true; }
      encodeRecord({
        offset: s.off, len: line.length, conversation: info.conversation, fact, kind: info.kind,
        confirms: step.confirmed.length ? step.confirmed[0] : NONE,
        candN: s.rs.cand ? s.rs.cand.n : NONE, candId: s.rs.cand ? s.rs.cand.id : null,
        convCount: s.convCount, h: s.h, c: s.c,
      }, recs, i * REC);
      s.off += line.length; s.count++;
    }
    return { recs, confirmed };
  }

  /** Save `data` under torn/ (kept, pruned to the newest TORN_KEEP). Never holds acknowledged data that exists elsewhere. */
  async keepBytes(dir: string, kind: string, data: Buffer): Promise<void> {
    if (data.length === 0) return;
    const d = nodePath.join(dir, 'torn');
    await mkdirDurable(this.fs, d);
    const name = `${String(await this.nextTornNumber(d)).padStart(6, '0')}-${kind}`;
    await writeFileAtomic(this.fs, nodePath.join(d, name), data);
    await this.pruneTorn(d);
  }
  private async nextTornNumber(d: string): Promise<number> {
    let max = 0;
    for (const n of await this.fs.readdir(d)) { const m = /^(\d{6})-/.exec(n); if (m) max = Math.max(max, parseInt(m[1], 10)); }
    return max + 1;
  }
  private async pruneTorn(d: string): Promise<void> {
    const names = (await this.fs.readdir(d)).filter((n) => /^\d{6}-/.test(n)).sort();
    for (const n of names.slice(0, Math.max(0, names.length - TORN_KEEP))) await this.fs.unlink(nodePath.join(d, n));
  }

  /**
   * Cut the body back to logical offset `end`: the bytes past it are copied to torn/ first when `keep`,
   * chunks starting at or after `end` are removed and the chunk holding `end` is truncated.
   */
  async trimBody(dir: string, end: number, keep: boolean): Promise<void> {
    const chunks = await this.listChunks(dir);
    const sizes: number[] = [];
    for (const c of chunks) sizes.push(await this.fileSize(chunkPathOf(dir, c)));
    const phys = chunks.length ? chunks[chunks.length - 1] + sizes[sizes.length - 1] : 0;
    if (phys <= end) return;
    if (keep) {
      const td = nodePath.join(dir, 'torn');
      await mkdirDurable(this.fs, td);
      const dest = nodePath.join(td, `${String(await this.nextTornNumber(td)).padStart(6, '0')}-body`);
      const df = await this.fs.open(dest, { create: true });
      try {
        let at = 0;
        for (let i = 0; i < chunks.length; i++) {
          const lo = Math.max(end, chunks[i]); const hi = chunks[i] + sizes[i];
          if (hi <= lo) continue;
          const cf = await this.fs.open(chunkPathOf(dir, chunks[i]), { create: false });
          try { for (let p = lo; p < hi; p += 4 * MIB) { const b = await cf.read(p - chunks[i], Math.min(4 * MIB, hi - p)); await df.write(b, at); at += b.length; } } finally { await cf.close(); }
        }
        await df.sync();
      } finally { await df.close(); }
      await this.fs.fsyncDir(td);
      await this.pruneTorn(td);
    }
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i] >= end) await this.fs.unlink(chunkPathOf(dir, chunks[i]));
      else if (chunks[i] + sizes[i] > end) { const cf = await this.fs.open(chunkPathOf(dir, chunks[i]), { create: false }); try { await cf.truncate(end - chunks[i]); await cf.sync(); } finally { await cf.close(); } }
    }
    await this.fs.fsyncDir(dir);
  }


  /**
   * Rebuild index.bin from the body. Only done when every surviving (CRC-valid) old record agrees with the
   * rebuilt chain, so the body is verified against what remains of the chain; otherwise Damaged (the caller
   * quarantines). The old index is kept in replaced-index/.
   */
  async rebuildIndex(dir: string, runtime: RuntimeKind, seeds: ChainSeeds, ev: { lines: number; bytes: number }, stamp: number): Promise<void> {
    const layout = await this.checkChunks(dir, ev);
    const oldPath = nodePath.join(dir, 'index.bin');
    const hadOld = await this.fs.exists(oldPath);
    const oldFile = hadOld ? await this.fs.open(oldPath, { create: false }) : null;
    const tmpPath = nodePath.join(dir, 'index.rebuild');
    const nf = await this.fs.open(tmpPath, { create: true });
    try {
      const oldSize = oldFile ? await oldFile.size() : 0;
      const oldHdrOk = !!oldFile && oldSize >= HDR && headerOk(await oldFile.read(0, HDR));
      const oldSlots = oldHdrOk ? Math.floor((oldSize - HDR) / REC) + ((oldSize - HDR) % REC > 0 ? 1 : 0) : 0;
      // c / convCount / reply ends are only comparable when the old index was written by this classifier
      const sameStamp = oldHdrOk && headerStamp(await oldFile!.read(0, HDR)) === stamp;
      await nf.truncate(0);
      await nf.write(indexHeader(stamp), 0);
      let start: BatchState = { count: 0, h: Buffer.from(seeds.raw), c: Buffer.from(seeds.conversation), convCount: 0, off: 0, rs: initialReplyState() };
      if (ev.lines > 0) {
        // evicted bodies cannot be re-derived: keep the old records for them, which must all be intact
        if (!oldHdrOk) throw new Damaged('index lost and the evicted bodies cannot rebuild it');
        if (!sameStamp) throw new StoreError('classifier-changed', 'bodies of the first lines were evicted, so their conversation chain cannot be re-derived');
        const buf = await oldFile!.read(recPos(0), ev.lines * REC);
        for (let i = 0; i < ev.lines; i++) if (!decodeRecord(buf, i * REC)) throw new Damaged(`evicted-prefix record ${i} is damaged`);
        await nf.write(buf, recPos(0));
        const lr = decodeRecord(buf, (ev.lines - 1) * REC)!;
        start = { count: ev.lines, h: lr.h, c: lr.c, convCount: lr.convCount, off: lr.offset + lr.len, rs: { cand: lr.candN === NONE ? null : { n: lr.candN, id: lr.candId } } };
      }
      // Derive no more lines than the old index claimed when there was one: lines past that were never
      // indexed (never acknowledged) and are handled as ordinary surplus on the next load.
      const limit = oldHdrOk ? Math.max(0, oldSlots - ev.lines) : Infinity;
      const out = await this.deriveFromBody(dir, layout, runtime, start, limit, async (recs, firstLine, n) => {
        if (oldHdrOk) {
          const want = Math.max(0, Math.min(n, oldSlots - firstLine));
          if (want > 0) {
            const ob = await oldFile!.read(recPos(firstLine), want * REC);
            for (let i = 0; i < want; i++) {
              const o = decodeRecord(ob, i * REC); if (!o) continue; // damaged old record: nothing to compare
              const r = decodeRecord(recs, i * REC)!;
              if (o.offset !== r.offset || o.len !== r.len || !o.h.equals(r.h) || (sameStamp && (!o.c.equals(r.c) || o.convCount !== r.convCount))) {
                throw new Damaged(`rebuilt chain disagrees with surviving record ${firstLine + i}`);
              }
            }
          }
        }
        await nf.write(recs, recPos(firstLine));
      });
      // a surviving valid old record past the rebuilt end means the body is short
      for (let i = out.state.count; i < oldSlots; i++) {
        const o = decodeRecord(await oldFile!.read(recPos(i), REC), 0);
        if (o) throw new Damaged(`record ${i} survives but the body has no line for it`);
      }
      await nf.sync();
    } finally { await nf.close(); await oldFile?.close(); }
    if (hadOld) {
      const rd = nodePath.join(dir, 'replaced-index');
      await mkdirDurable(this.fs, rd);
      const n = (await this.fs.readdir(rd)).length + 1;
      await this.fs.rename(oldPath, nodePath.join(rd, `index-${String(n).padStart(4, '0')}.bin`));
      await this.fs.fsyncDir(rd); await this.fs.fsyncDir(dir);
    }
    await this.fs.rename(tmpPath, oldPath);
    await this.fs.fsyncDir(dir);
    await this.fs.unlink(nodePath.join(dir, 'scrub.json')); // verified under the old index: start the pass over
  }
}
