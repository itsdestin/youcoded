// Body-file helpers for the chat store (split out of store.ts to keep it inside its line budget): chunk
// layout checks, re-deriving index records from body bytes, and moving unacknowledged or cut-off bytes
// aside (torn/) instead of deleting them. Pure helpers over the Fs door; they hold no store state.
import * as nodePath from 'node:path';
import { writeFileAtomic, mkdirDurable, type Fs, type FileLike } from './fsio';
import { readCheckpoint, writeCheckpoint } from './checkpoint';
import { StoreError } from './errors';
import { chainStep, type ChainSeeds, type RuntimeKind } from './chain';
import { analyseLine, initialReplyState, replyEndStep, type LineInfo, type ReplyEndOptions, type ReplyState } from './classify';
import { isDiskFull } from './storeutil';
import { HDR, REC, NONE, decodeRecord, encodeRecord, headerOk, headerStamp, indexHeader, recPos, type Rec } from './records';

const MIB = 1024 * 1024;
/** Verify only the window a crash could have damaged (the last this-many records); the rolling scrub walks the older part. */
const VERIFY_WINDOW = 4096;
const SCAN_BATCH = 4096;
/**
 * Cap on kept files in torn/ per version. WHY a cap that REFUSES and no pruning (N2/N17): torn/ holds bytes
 * nobody proved redundant (an unacknowledged tail can be a lost acknowledged one after a second fault), so
 * deleting the oldest to make room is deleting data. At the cap the version reports `limit` and stays as it is.
 */
const MAX_TORN_FILES = 4096;
/** Marker file: the conversation chain of the lines after the evicted prefix was derived from a prefix written by another classifier (N4). */
export const STALE_CONV_FILE = 'stale-conv.json';
/** Marker file: lines from `fromLine` were set aside by a rebuild because their bodies did not match the chain (N7). */
export const PARTIAL_FILE = 'partial.json';

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

  /** Save `data` under torn/ (kept, never pruned: see MAX_TORN_FILES). Never holds acknowledged data that exists elsewhere. */
  async keepBytes(dir: string, kind: string, data: Buffer): Promise<void> {
    if (data.length === 0) return;
    const d = nodePath.join(dir, 'torn');
    await mkdirDurable(this.fs, d);
    const name = `${String(await this.nextTornNumber(d)).padStart(6, '0')}-${kind}`;
    await writeFileAtomic(this.fs, nodePath.join(d, name), data);
  }
  private async nextTornNumber(d: string): Promise<number> {
    let max = 0; let count = 0;
    for (const n of await this.fs.readdir(d)) { const m = /^(\d{6})-/.exec(n); if (m) { count++; max = Math.max(max, parseInt(m[1], 10)); } }
    if (count >= MAX_TORN_FILES) throw new StoreError('limit', `${count} set-aside torn files are already kept for this version; nothing is deleted to make room`);
    return max + 1;
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
    }
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i] >= end) await this.fs.unlink(chunkPathOf(dir, chunks[i]));
      else if (chunks[i] + sizes[i] > end) { const cf = await this.fs.open(chunkPathOf(dir, chunks[i]), { create: false }); try { await cf.truncate(end - chunks[i]); await cf.sync(); } finally { await cf.close(); } }
    }
    await this.fs.fsyncDir(dir);
  }


  /**
   * Rebuild index.bin from the body, VERIFYING the body against chain values that are stored independently of
   * the index being replaced (review N1, N7). Sources, strongest first:
   *   1. every CRC-valid record of the old index, read whether or not its 16-byte header is intact (a damaged
   *      header is not a reason to throw the records away);
   *   2. the separate checkpoint file (checkpoint.ts): the chain value at the last checkpointed line;
   *   3. only when the old index has no usable record at all (missing, or under one record): the newest
   *      replaced-index/ files (previous real indexes).
   * Outcomes:
   *   - full: every derived line agrees (or sits before a verified anchor). The index is replaced; the old one is kept.
   *   - split: the FIRST line whose body disagrees with a valid record is `k`; the lines before the last verified
   *     one are kept and served, the rest is set aside (the body bytes are copied to torn/ by the next load, the old
   *     index is kept in replaced-index/) and `partial.json` marks it. A correct resend from a peer heals it.
   *   - Damaged: the chain cannot be anchored at all (nothing stored vouches for the body, the checkpoint
   *     disagrees without a localisable line, or the body is shorter than what is vouched for). The caller
   *     quarantines the whole version, intact.
   * Never "verify ok with a different head": a rebuild that derives bytes nothing vouches for is refused.
   * Lines after the newest anchor (at most the checkpoint interval when the index is lost) are unverifiable
   * and are accepted; that residue is the documented bound.
   */
  async rebuildIndex(dir: string, runtime: RuntimeKind, seeds: ChainSeeds, ev: { lines: number; bytes: number }, stamp: number, opts: { convStale?: boolean } = {}): Promise<RebuildResult> {
    const layout = await this.checkChunks(dir, ev);
    const oldPath = nodePath.join(dir, 'index.bin');
    const tmpPath = nodePath.join(dir, 'index.rebuild');
    const hadOld = await this.fs.exists(oldPath);
    const ckpt = await readCheckpoint(this.fs, dir);
    const handles: FileLike[] = [];
    // WHY every handle is opened INSIDE the try and closed in the one finally (N10): an open that fails after another
    // succeeded (inode exhaustion, permissions, an injected crash) used to leak the first handle.
    try {
      const open = async (path: string, create = false): Promise<FileLike> => { const f = await this.fs.open(path, { create }); handles.push(f); return f; };
      const refs: Ref[] = [];
      const addRef = async (path: string): Promise<Ref> => {
        const f = await open(path); const size = await f.size();
        const hdrOk = size >= HDR && headerOk(await f.read(0, HDR));
        const ref: Ref = { f, slots: size >= HDR ? Math.ceil((size - HDR) / REC) : 0, stampSame: hdrOk && headerStamp(await f.read(0, HDR)) === stamp && !opts.convStale, size };
        refs.push(ref); return ref;
      };
      const primary = hadOld ? await addRef(oldPath) : null;
      if (!primary || primary.size < HDR + REC) {
        const rd = nodePath.join(dir, 'replaced-index');
        for (const n of (await this.fs.readdir(rd)).filter((x) => /^index-\d{4}\.bin$/.test(x)).sort().reverse().slice(0, 2)) await addRef(nodePath.join(rd, n));
      }
      const nf = await open(tmpPath, true);
      await nf.truncate(0);
      await nf.write(indexHeader(stamp), 0);
      let start: BatchState = { count: 0, h: Buffer.from(seeds.raw), c: Buffer.from(seeds.conversation), convCount: 0, off: 0, rs: initialReplyState() };
      let staleOut = false;
      let prefixBuf: Buffer | null = null;
      if (ev.lines > 0) {
        // evicted bodies cannot be re-derived: their records come from the first copy of the index that has them all intact
        let src: Ref | null = null;
        for (const r of refs) {
          if (r.slots < ev.lines) continue;
          const buf = await r.f.read(recPos(0), ev.lines * REC);
          let ok = buf.length === ev.lines * REC; let prev: { offset: number; len: number } | null = null;
          for (let i = 0; ok && i < ev.lines; i++) { const d = decodeRecord(buf, i * REC); if (!d || (prev && d.offset !== prev.offset + prev.len)) ok = false; else prev = d; }
          if (ok) { src = r; prefixBuf = buf; break; }
        }
        if (!src || !prefixBuf) throw new Damaged('the index records of the evicted lines are damaged and no other copy of them exists');
        // WHY not an error (N4): the evicted lines' conversation chain was written by another classifier; it can only be
        // recomputed from their bodies. Keep serving everything else and say so (stale-conv.json) until the bodies return.
        staleOut = !src.stampSame;
        await nf.write(prefixBuf, recPos(0));
        const lr = decodeRecord(prefixBuf, (ev.lines - 1) * REC)!;
        start = { count: ev.lines, h: lr.h, c: lr.c, convCount: lr.convCount, off: lr.offset + lr.len, rs: { cand: lr.candN === NONE ? null : { n: lr.candN, id: lr.candId } } };
      }
      // Derive no more lines than the old index claimed when there was one: lines past that were never
      // indexed (never acknowledged) and are handled as ordinary surplus on the next load.
      // the checkpoint proves lines were acknowledged even when the index lost their records
      const limit = primary && primary.size >= HDR ? Math.max(0, Math.max(primary.slots, ckpt ? ckpt.count : 0) - ev.lines) : Infinity;
      let lastAnchored = ev.lines - 1;        // the newest line a stored record vouched for; everything at or before it is verified
      const found: { mismatchAt: number | null } = { mismatchAt: null };   // an object, not a variable: the callback below assigns it
      const refRec = async (line: number, cache: Map<Ref, Buffer>, first: number, n: number): Promise<{ rec: Rec; stampSame: boolean } | null> => {
        for (const r of refs) {
          if (line >= r.slots) continue;
          let buf = cache.get(r);
          if (!buf) { buf = await r.f.read(recPos(first), Math.max(0, Math.min(n, r.slots - first)) * REC); cache.set(r, buf); }
          const d = decodeRecord(buf, (line - first) * REC);
          if (d) return { rec: d, stampSame: r.stampSame };
        }
        return null;
      };
      const Stop = Symbol('stop');
      let out: { state: BatchState; end: number } | null = null;
      try {
        out = await this.deriveFromBody(dir, layout, runtime, start, limit, async (recs, firstLine, n) => {
          const cache = new Map<Ref, Buffer>();
          for (let i = 0; i < n; i++) {
            const o = await refRec(firstLine + i, cache, firstLine, n);
            if (!o) continue;
            const r = decodeRecord(recs, i * REC)!;
            if (o.rec.offset !== r.offset || o.rec.len !== r.len || !o.rec.h.equals(r.h) || (o.stampSame && (!o.rec.c.equals(r.c) || o.rec.convCount !== r.convCount))) {
              found.mismatchAt = firstLine + i;
              if (i > 0) await nf.write(recs.subarray(0, i * REC), recPos(firstLine));
              throw Object.assign(new Error('stop'), { [Stop]: true });
            }
            lastAnchored = firstLine + i;
          }
          await nf.write(recs, recPos(firstLine));
        });
      } catch (e) { if (!(e as any)?.[Stop]) throw e; }

      const finishSwap = async (): Promise<void> => {
        await nf.sync();
        // WHY close before renaming: Windows refuses to rename a file that is still open
        for (const f of handles.splice(0)) await f.close();
        if (hadOld) {
          const rd = nodePath.join(dir, 'replaced-index');
          await mkdirDurable(this.fs, rd);
          const n = (await this.fs.readdir(rd)).length + 1;
          await this.fs.rename(oldPath, nodePath.join(rd, `index-${String(n).padStart(4, '0')}.bin`));
          await this.fs.fsyncDir(rd); await this.fs.fsyncDir(dir);
        }
        await this.fs.rename(tmpPath, oldPath);
        await this.fs.fsyncDir(dir);
        // verified under the old index: start the pass over (directory synced: an unsynced unlink could bring the stale mark back)
        await this.fs.unlink(nodePath.join(dir, 'scrub.json')); await this.fs.fsyncDir(dir);
      };
      const ckStamp = staleOut ? (stamp ^ 0x80000000) >>> 0 : stamp;   // a stamp that never equals the real one: its `c` is not comparable
      const recAt = async (line: number): Promise<Rec | null> => {
        if (line < ev.lines && prefixBuf) return decodeRecord(prefixBuf, line * REC);
        const b = await nf.read(recPos(line), REC); return b.length === REC ? decodeRecord(b, 0) : null;
      };

      const mismatchAt = found.mismatchAt;
      if (mismatchAt !== null) {
        // SPLIT (N7): keep the verified prefix, set the rest aside.
        const keep = lastAnchored + 1;
        const newest = Math.max(...refs.map((r) => r.slots), 0);
        const lost = Math.max(mismatchAt + 1, newest) - keep;
        await nf.truncate(recPos(keep));
        const keepRec = keep > 0 ? await recAt(keep - 1) : null;
        // the checkpoint is lowered BEFORE the swap, never left ahead of the index
        await writeCheckpoint(this.fs, dir, { count: keep, stamp: ckStamp, h: keepRec ? keepRec.h : Buffer.from(seeds.raw), c: keepRec ? keepRec.c : Buffer.from(seeds.conversation) });
        await writeFileAtomic(this.fs, nodePath.join(dir, PARTIAL_FILE), Buffer.from(JSON.stringify({ fromLine: keep, lost, atMs: Date.now() })));
        if (staleOut) await writeFileAtomic(this.fs, nodePath.join(dir, STALE_CONV_FILE), Buffer.from(JSON.stringify({ through: ev.lines })));
        await finishSwap();
        return { split: { keep, lost }, staleConv: staleOut };
      }

      const total = out!.state.count;
      // a surviving valid old record past the rebuilt end means the body is short
      if (primary) {
        for (let i = total; i < primary.slots; i++) {
          if (decodeRecord(await primary.f.read(recPos(i), REC), 0)) throw new Damaged(`record ${i} survives but the body has no line for it`);
        }
      }
      let covered = lastAnchored;
      if (ckpt) {
        if (ckpt.count > total) throw new Damaged(`the checkpoint vouches for ${ckpt.count} lines but the body holds ${total}`);
        if (ckpt.count > 0) {
          const r = await recAt(ckpt.count - 1);
          if (!r || !r.h.equals(ckpt.h) || (ckpt.stamp === stamp && !staleOut && !r.c.equals(ckpt.c))) throw new Damaged(`the rebuilt chain disagrees with the checkpoint at line ${ckpt.count}`);
          covered = Math.max(covered, ckpt.count - 1);
        }
      }
      // nothing stored vouches for any derived line: the rebuild would only compare the bytes with themselves
      if (total > ev.lines && covered < ev.lines) throw new Damaged('nothing stored vouches for the body (no valid index record and no checkpoint): refusing to accept it');
      if (total > 0 && covered === total - 1 && !(ckpt && ckpt.count === total && !staleOut)) {
        const lr = await recAt(total - 1);
        if (lr) await writeCheckpoint(this.fs, dir, { count: total, stamp: ckStamp, h: lr.h, c: lr.c });
      }
      if (staleOut) await writeFileAtomic(this.fs, nodePath.join(dir, STALE_CONV_FILE), Buffer.from(JSON.stringify({ through: ev.lines })));
      await finishSwap();
      if (!staleOut && ev.lines === 0) { await this.fs.unlink(nodePath.join(dir, STALE_CONV_FILE)); await this.fs.fsyncDir(dir); }
      return { split: null, staleConv: staleOut };
    } finally { for (const f of handles) await f.close().catch(() => undefined); }
  }

  /** Examine index.bin. Repairs a damaged TAIL in place (bytes kept); anything else throws NeedsRebuild. */
  async settleIndex(dir: string, ev: { lines: number; bytes: number }, layout: { chunks: number[]; phys: number }, stamp: number): Promise<{ count: number; last: Rec | null; adopt: boolean; needsInit?: boolean }> {
    const ip = nodePath.join(dir, 'index.bin');
    const hasBodies = layout.chunks.length > 0 && layout.phys > ev.bytes;
    if (!(await this.fs.exists(ip))) {
      if (!hasBodies && ev.lines === 0) {
        // WHY tolerate a full disk (N5): a version that was registered but never written to is empty, and "empty" can be served
        // without creating its index file; the file is created by the first append (which is then refused, typed, while the disk is full)
        try { await this.ensureIndex(dir, stamp); } catch (e) { if (!isDiskFull(e)) throw e; return { count: 0, last: null, adopt: false, needsInit: true }; }
        return { count: 0, last: null, adopt: false };
      }
      throw new NeedsRebuild('index.bin is missing');
    }
    const f = await this.fs.open(ip, { create: false });
    try {
      const size = await f.size();
      if (size < HDR) {
        if (!hasBodies && ev.lines === 0) {
          try { await f.truncate(0); await f.write(indexHeader(stamp), 0); await f.sync(); } catch (e) { if (!isDiskFull(e)) throw e; return { count: 0, last: null, adopt: false, needsInit: true }; }
          return { count: 0, last: null, adopt: false };
        }
        throw new NeedsRebuild('index header is missing');
      }
      const hdr = await f.read(0, HDR);
      if (!headerOk(hdr)) throw new NeedsRebuild('index header is damaged');
      if (headerStamp(hdr) !== stamp) throw new NeedsRebuild('classifier stamp changed');
      let count = Math.floor((size - HDR) / REC);
      const partial = size - HDR - count * REC;
      // Verify only the window a crash could have damaged (the last VERIFY_WINDOW records); the rolling
      // scrub (scrubSome) walks the older part a bounded amount per open.
      const from = Math.max(0, count - VERIFY_WINDOW);
      const buf = await f.read(recPos(from), (count - from) * REC);
      let good = 0; let prev: Rec | null = null;
      for (; good < count - from; good++) {
        const r = decodeRecord(buf, good * REC);
        if (!r || (prev && r.offset !== prev.offset + prev.len)) break;
        prev = r;
      }
      let adopt = false;
      if (from + good < count) {
        // A valid record after the first bad one is NOT a torn tail: that is bit rot or a lost record (C1).
        for (let i = good; i < count - from; i++) if (decodeRecord(buf, i * REC)) throw new NeedsRebuild(`record ${from + good} is damaged but later records are valid`);
        await this.keepBytes(dir, 'index-tail', await f.read(recPos(from + good), size - recPos(from + good)));
        count = from + good; await f.truncate(recPos(count)); await f.sync(); adopt = true;
      } else if (partial > 0) {
        await this.keepBytes(dir, 'index-tail', await f.read(recPos(count), partial));
        await f.truncate(recPos(count)); await f.sync(); adopt = true;
      }
      let last: Rec | null = null;
      if (count > 0) { last = decodeRecord(await f.read(recPos(count - 1), REC), 0); if (!last) throw new NeedsRebuild('last index record is unreadable'); }
      return { count, last, adopt };
    } finally { await f.close(); }
  }

  /** Re-derive records for the whole lines in the body past the index end and append them to the index. */
  async adoptSurplus(dir: string, layout: { chunks: number[]; sizes: number[]; phys: number }, count: number, last: Rec | null, seeds: ChainSeeds, runtime: RuntimeKind): Promise<{ count: number; last: Rec | null; bodyEnd: number }> {
    const start: BatchState = last
      ? { count, h: last.h, c: last.c, convCount: last.convCount, off: last.offset + last.len, rs: { cand: last.candN === NONE ? null : { n: last.candN, id: last.candId } } }
      : { count: 0, h: Buffer.from(seeds.raw), c: Buffer.from(seeds.conversation), convCount: 0, off: 0, rs: initialReplyState() };
    const f = await this.fs.open(nodePath.join(dir, 'index.bin'), { create: false });
    let lastRec: Rec | null = last;
    try {
      const out = await this.deriveFromBody(dir, layout, runtime, start, Infinity, async (recs, firstLine, n) => {
        await f.write(recs, recPos(firstLine));
        lastRec = decodeRecord(recs, (n - 1) * REC);
      });
      await f.sync();
      await this.trimBody(dir, out.end, true); // a partial last line (no newline) is kept aside and cut
      return { count: out.state.count, last: lastRec, bodyEnd: out.end };
    } finally { await f.close(); }
  }


  /** Create index.bin with just a header when it is missing or short (an empty version). */
  async ensureIndex(dir: string, stamp: number): Promise<void> {
    const f = await this.fs.open(nodePath.join(dir, 'index.bin'), { create: true });
    try {
      if ((await f.size()) < HDR) { await f.truncate(0); await f.write(indexHeader(stamp), 0); await f.sync(); }
    } finally { await f.close(); }
    await this.fs.fsyncDir(dir);
  }
}

interface Ref { f: FileLike; slots: number; stampSame: boolean; size: number }
export interface RebuildResult { split: { keep: number; lost: number } | null; staleConv: boolean }
