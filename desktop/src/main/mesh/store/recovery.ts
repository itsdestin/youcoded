// Body-file helpers for the chat store (split out of store.ts to keep it inside its line budget): chunk
// layout checks, re-deriving index records from body bytes, and moving unacknowledged or cut-off bytes
// aside (torn/) instead of deleting them. Pure helpers over the Fs door; they hold no store state.
import * as nodePath from 'node:path';
import { writeFileAtomic, mkdirDurable, type Fs, type FileLike } from './fsio';
import { readCheckpoint, writeCheckpoint, CHECKPOINT_FILE, type Boundary } from './checkpoint';
import { writeSideFor } from './sidefile';
import { setMarks } from './marks';
import { StoreError } from './errors';
import { chainStep, versionTag, type ChainSeeds, type RuntimeKind } from './chain';
import { analyseLine, initialReplyState, replyEndStep, type LineInfo, type ReplyEndOptions, type ReplyState } from './classify';
import { isDiskFull } from './storeutil';
import { cutAwayBranchHit, histCount, pendingTakeovers, sharedPrefixBound } from './tails';
import { readHw } from './highwater';
import { hex } from './chain';
import { HDR, REC, NONE, decodeRecord, encodeRecord, headerOk, headerStamp, headerTag, indexHeader, recPos, type Rec } from './records';

const MIB = 1024 * 1024;
/** Verify only the window a crash could have damaged (the last this-many records); the rolling scrub walks the older part. */
const VERIFY_WINDOW = 4096;
/**
 * Cap on kept files in torn/ per version. WHY a cap that REFUSES and no pruning (N2/N17): torn/ holds bytes
 * nobody proved redundant (an unacknowledged tail can be a lost acknowledged one after a second fault), so
 * deleting the oldest to make room is deleting data. At the cap the version reports `limit` and stays as it is.
 */
const MAX_TORN_FILES = 4096;
/** Internal: the index can be repaired by re-deriving it from the body. */
export class NeedsRebuild extends Error { constructor(readonly reason: string) { super(reason); } }
/** Internal: not repairable; the store quarantines the version. */
export class Damaged extends Error { constructor(readonly reason: string) { super(reason); } }

/** The running state a batch of lines is encoded against. */
export interface BatchState { count: number; h: Buffer; c: Buffer; convCount: number; off: number; rs: ReplyState }
export interface SumFacts { title: string | null; model: string | null; cwd: string | null }

/** The version key a version folder belongs to (the folder name), and its identity tag (chain.ts versionTag). */
const keyOfDir = (dir: string): string => nodePath.basename(dir);
const tagOfDir = (dir: string): Buffer => versionTag(keyOfDir(dir));

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

  /**
   * The body chunk files as they are, WITHOUT demanding that they form one gapless run (review 4, F3): `chunks` are the start offsets in order, `sizes` the
   * file sizes, `phys` the end of the last one. A missing, short or cut chunk is a hole in the byte space, found by `gapStart`; it must never hide the lines
   * that are still whole.
   */
  async layout(dir: string): Promise<{ chunks: number[]; sizes: number[]; phys: number }> {
    const chunks = await this.listChunks(dir);
    const sizes: number[] = [];
    for (const c of chunks) sizes.push(await this.fileSize(chunkPathOf(dir, c)));
    const i = chunks.length - 1;
    return { chunks, sizes, phys: i >= 0 ? chunks[i] + sizes[i] : 0 };
  }

  /**
   * The first byte in [from, to) that no chunk file holds, or null when the whole range is covered. A chunk covers [start, min(start + size, next start)): bytes
   * a chunk holds past the next chunk's start are never read (that is how a doubled or foreign-length file stays harmless).
   */
  gapStart(lay: { chunks: number[]; sizes: number[] }, from: number, to: number): number | null {
    let cur = from;
    for (let i = 0; i < lay.chunks.length && cur < to; i++) {
      const end = Math.min(lay.chunks[i] + lay.sizes[i], i + 1 < lay.chunks.length ? lay.chunks[i + 1] : Infinity);
      if (end <= cur) continue;
      if (lay.chunks[i] > cur) return cur;
      cur = end;
    }
    return cur < to ? cur : null;
  }

  /** The first line in [fromLine, count) whose bytes end after byte `at` (binary search over the index; offsets only grow), or null. */
  async firstLineEndingAfter(dir: string, fromLine: number, count: number, at: number): Promise<number | null> {
    if (fromLine >= count) return null;
    const f = await this.fs.open(nodePath.join(dir, 'index.bin'), { create: false });
    try {
      let lo = fromLine; let hi = count - 1; let found: number | null = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = decodeRecord(await f.read(recPos(mid), REC), 0);
        if (!r) throw new NeedsRebuild(`record ${mid} fails its checksum`);
        if (r.offset + r.len > at) { found = mid; hi = mid - 1; } else lo = mid + 1;
      }
      return found;
    } finally { await f.close(); }
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


  /**
   * Save `data` under torn/ (kept, never pruned: see MAX_TORN_FILES). Refuses with `limit` at the cap instead of deleting to make room.
   * WHY the exists check: the next number is max+1, but a kept file that vanished (a fault) must never let a later keep land on a name
   * that still exists, so a kept copy is never overwritten.
   */
  async keepBytes(dir: string, kind: string, data: Buffer): Promise<void> {
    if (data.length === 0) return;
    const d = nodePath.join(dir, 'torn');
    await mkdirDurable(this.fs, d);
    const name = await this.nextTornName(d, kind);
    // DESTRUCTIVE-OK(kept-copy-first): writes a NEW name that does not exist (checked); nothing is replaced
    await writeFileAtomic(this.fs, nodePath.join(d, name), data);
  }
  private async nextTornName(d: string, kind: string): Promise<string> {
    let max = 0; let count = 0;
    for (const n of await this.fs.readdir(d)) { const m = /^(\d{6})-/.exec(n); if (m) { count++; max = Math.max(max, parseInt(m[1], 10)); } }
    if (count >= MAX_TORN_FILES) throw new StoreError('limit', `${count} set-aside torn files are already kept for this version; nothing is deleted to make room`);
    for (let n = max + 1; ; n++) { const name = `${String(n).padStart(6, '0')}-${kind}`; if (!(await this.fs.exists(nodePath.join(d, name)))) return name; }
  }

  /**
   * Cut the body back to logical offset `end`: the bytes past it are copied to torn/ first when `keep` (durably, before anything is
   * cut), chunks starting at or after `end` are removed and the chunk holding `end` is truncated.
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
      const dest = nodePath.join(td, await this.nextTornName(td, 'body'));
      // DESTRUCTIVE-OK(kept-copy-first): the destination is a new file; the copy is fsynced before the cut below
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
      // DESTRUCTIVE-OK(kept-copy-first): every byte past `end` was copied to torn/ and fsynced above, or (keep=false, a cut) is saved by the caller in a verified tail file
      if (chunks[i] >= end) await this.fs.unlink(chunkPathOf(dir, chunks[i]));
      else if (chunks[i] + sizes[i] > end) { const cf = await this.fs.open(chunkPathOf(dir, chunks[i]), { create: false }); try { await cf.truncate(end - chunks[i]); await cf.sync(); } finally { await cf.close(); } } // DESTRUCTIVE-OK(kept-copy-first): same bytes, same reason
    }
    await this.fs.fsyncDir(dir);
  }

  /** Number of whole lines (ending in 0x0a) in the body from `from` on; the partial last line is not counted. */
  async countWholeLines(dir: string, from: number): Promise<number> {
    const chunks = await this.listChunks(dir); let n = 0;
    for (const c of chunks) {
      const size = await this.fileSize(chunkPathOf(dir, c)); const cend = c + size;
      if (cend <= from) continue;
      const cf = await this.fs.open(chunkPathOf(dir, c), { create: false });
      try {
        for (let p = Math.max(from, c); p < cend; p += 4 * MIB) {
          const b = await cf.read(p - c, Math.min(4 * MIB, cend - p));
          for (let i = b.indexOf(0x0a); i !== -1; i = b.indexOf(0x0a, i + 1)) n++;
        }
      } finally { await cf.close(); }
    }
    return n;
  }

  /**
   * Rebuild index.bin from the body, keeping EVERY valid record of the old index (review 3, F2) and verifying the body against chain
   * values that are stored independently of the index being replaced (N1): the CRC-valid records of the old index (whether or not its
   * 16-byte header is intact), the checkpoint file, and only when the old index has no usable record at all the newest replaced-index/ files.
   *
   * Walking slot by slot:
   *  - a slot WITH a valid record: the line is cut from the body by the record's own offset and length, hashed from the previous record's
   *    chain value, and compared with the record. A mismatch means THAT line's body rotted: the record is kept (its chain value is the truth),
   *    the first such line is reported (scrub.json is pointed at it), and the walk goes on. Lines after it are served.
   *  - a slot WITHOUT one (a rotted record, or records lost past the end): the line is derived from the body, and is trusted only when the
   *    next valid record or the checkpoint's chain value confirms it. If that confirmation fails, two independent faults hit the same stretch
   *    and nothing can tell which line is bad: the verified lines before the stretch are kept and everything from it on is set aside
   *    (bytes kept in torn/) and marked partial.json, so the head never forks.
   * Lines past max(last valid record, checkpoint) were never acknowledged (the checkpoint is written before every acknowledgement) and are
   * left as surplus for the next load to keep aside; when no checkpoint exists they are possibly acknowledged and are also marked partial.
   * Nothing vouching at all (no valid record, no checkpoint) for a body with whole lines is refused as damaged (quarantine, bytes kept).
   */
  async rebuildIndex(dir: string, runtime: RuntimeKind, seeds: ChainSeeds, stamp: number): Promise<RebuildResult> {
    // WHY the lenient layout (review 4): a crash in the middle of a cut leaves a truncated chunk next to chunk files that were about to be removed, a hole beyond the
    // lines the rebuild needs. Only a hole INSIDE the lines it has to read matters, and the cursor below reports exactly that (Damaged); the strict check refused the whole version.
    const layout = await this.layout(dir);
    // eviction: the CHECKPOINT's record of it (hint) is the only candidate, and only when a prefix of valid records ends exactly there. WHY not "the first chunk file's
    // start" any more (review 4, F4): a deleted first chunk looks exactly like an eviction, and must be reported as damage, never relabelled as one.
    const candidates: { lines: number | null; bytes: number }[] = [];
    const ckpt = await readCheckpoint(this.fs, dir);
    // the checkpoint's record of the eviction is the only candidate; its boundary state (review 5, F4) lets the prefix be synthesized when no copy of the prefix records survives
    if (ckpt && ckpt.evLines > 0) candidates.push({ lines: ckpt.evLines, bytes: ckpt.evBytes });
    // a stale-conversation-chain bit in the checkpoint's stamp (replaces stale-conv.json)
    const convStale = ckpt !== null && ckpt.stamp === ((stamp ^ 0x80000000) >>> 0);
    // The checkpoint's record can be STALE (an older copy, written before a restore): when the bodies it says are gone are in fact there (a chunk file starts at 0), the
    // prefix records can be derived from them like any others, so a prefix nothing else supplies is not a reason to quarantine.
    let ev: { lines: number | null; bytes: number } = { lines: 0, bytes: 0 };
    const oldPath = nodePath.join(dir, 'index.bin');
    const tmpPath = nodePath.join(dir, 'index.rebuild');
    const hadOld = await this.fs.exists(oldPath);
    const handles: FileLike[] = [];
    // WHY every handle is opened INSIDE the try and closed in the one finally (N10)
    try {
      const open = async (path: string, create = false): Promise<FileLike> => { const f = await this.fs.open(path, { create }); handles.push(f); return f; };
      const refs: Ref[] = [];
      const myTag = tagOfDir(dir);
      /** Returns null for an index that belongs to ANOTHER version (valid header, other identity tag): none of its records is ever used (review 4, F8). */
      const addRef = async (path: string): Promise<Ref | null> => {
        const f = await open(path); const size = await f.size();
        const hdr = size >= HDR ? await f.read(0, HDR) : Buffer.alloc(0);
        const hdrOk = hdr.length >= HDR && headerOk(hdr);
        if (hdrOk && !headerTag(hdr).equals(myTag)) return null;
        // WHY three states: a damaged header cannot say which classifier wrote the records, so it is "unknown" and decided by the records themselves
        const ref: Ref = { f, slots: size >= HDR ? Math.ceil((size - HDR) / REC) : 0, size, mode: convStale ? 'changed' : hdrOk ? (headerStamp(hdr) === stamp ? 'same' : 'changed') : 'unknown', cache: new Map() };
        refs.push(ref); return ref;
      };
      const primary = hadOld ? await addRef(oldPath) : null;
      if (!primary || primary.size < HDR + REC) {   // (a foreign primary is `null` here: it counts as having no usable record)
        const rd = nodePath.join(dir, 'replaced-index');
        for (const n of (await this.fs.readdir(rd)).filter((x) => /^index-\d{4}\.bin$/.test(x)).sort().reverse().slice(0, 2)) await addRef(nodePath.join(rd, n));
      }
      /** The valid record of `slot` from the first source that has one (windows of 1024 records are cached per source). */
      const refRec = async (slot: number): Promise<{ rec: Rec; ref: Ref; raw: Buffer } | null> => {
        for (const r of refs) {
          if (slot >= r.slots) continue;
          const first = slot - (slot % 1024);
          let buf = r.cache.get(first);
          if (!buf) { r.cache.clear(); buf = await r.f.read(recPos(first), Math.min(1024, r.slots - first) * REC); r.cache.set(first, buf); }
          const d = decodeRecord(buf, (slot - first) * REC);
          if (d && !d.standIn) return { rec: d, ref: r, raw: buf.subarray((slot - first) * REC, (slot - first + 1) * REC) };
        }
        return null;
      };
      // the newest slot any source has a valid record for (a pass over the sources' checksums only)
      let lastValid = -1;
      for (const r of refs) for (let first = 0; first < r.slots; first += 1024) {
        const buf = await r.f.read(recPos(first), Math.min(1024, r.slots - first) * REC);
        for (let i = Math.min(1024, r.slots - first) - 1; i >= 0; i--) { const d = decodeRecord(buf, i * REC); if (d && !d.standIn) { lastValid = Math.max(lastValid, first + i); break; } }
      }
      // WHY before the scratch file exists: refusing needs no free space, so a version nothing can vouch for is quarantined (typed `damaged`) even on a full disk
      if (lastValid < 0 && !ckpt && !candidates.length && (await this.countWholeLines(dir, 0)) > 0) throw new Damaged('nothing stored vouches for the body (no valid index record and no checkpoint): refusing to accept it');
      const nf = await open(tmpPath, true);
      // DESTRUCTIVE-OK(scratch): index.rebuild is a scratch file derived from the body and the old index; it is never the only copy of anything
      await nf.truncate(0);
      await nf.write(indexHeader(stamp, myTag), 0);
      let start: BatchState = { count: 0, h: Buffer.from(seeds.raw), c: Buffer.from(seeds.conversation), convCount: 0, off: 0, rs: initialReplyState() };
      let staleOut = false;
      let prefixBuf: Buffer | null = null;
      let evLines = 0; let synthesized = false;
      if (candidates.length) {
        // evicted bodies cannot be re-derived: their records come from the first copy of the index that has them all intact
        let src: Ref | null = null;
        for (const cand of candidates) {
          for (const r of refs) {
            const buf = await r.f.read(recPos(0), Math.min(cand.lines ?? r.slots, r.slots) * REC);
            let n = 0; let prevEnd = 0; let found = false;
            for (; (n + 1) * REC <= buf.length; n++) {
              const d = decodeRecord(buf, n * REC);
              if (!d || d.offset !== prevEnd) break;
              prevEnd = d.offset + d.len;
              if (cand.lines === null ? prevEnd === cand.bytes : n + 1 === cand.lines) { n++; found = prevEnd === cand.bytes; break; }
            }
            if (found) { src = r; prefixBuf = buf.subarray(0, n * REC); evLines = n; ev = cand; break; }
          }
          if (src) break;
        }
        if (!src || !prefixBuf) {
          if (layout.chunks.length > 0 && layout.chunks[0] === 0) { ev = { lines: 0, bytes: 0 }; evLines = 0; }   // derived from the bodies below; the rebuilt checkpoint forgets the stale eviction record
          else if (ckpt && ckpt.boundary && ckpt.evBytes < 0xffffffff) {
            // WHY (review 5, F4): no copy of the evicted lines' index records survives (one deleted index.bin after an eviction). The checkpoint kept the chain state AT the boundary, so the
            // KEPT lines can be re-derived from their bodies and confirmed against the checkpoint's head. The evicted lines' own chain values are gone for good (peers hold the lines): the
            // slots before the boundary are zeros and slot evLines-1 is a stand-in carrying the boundary (`lostRecs` in the new checkpoint says so); nothing kept is hidden.
            const bd = ckpt.boundary;
            prefixBuf = Buffer.alloc(ckpt.evLines * REC);
            encodeRecord({ offset: ckpt.evBytes - 1, len: 1, conversation: false, fact: false, standIn: true, kind: 'bookkeeping', confirms: NONE, candN: bd.candN < 0 ? NONE : bd.candN, candId: bd.candId, convCount: bd.convCount, h: bd.h, c: bd.c }, prefixBuf, (ckpt.evLines - 1) * REC);
            evLines = ckpt.evLines; ev = candidates[0]; synthesized = true;
            staleOut = ckpt.stamp !== stamp;
            await nf.write(prefixBuf, recPos(0));
            start = { count: evLines, h: Buffer.from(bd.h), c: Buffer.from(bd.c), convCount: bd.convCount, off: ckpt.evBytes, rs: { cand: bd.candN < 0 ? null : { n: bd.candN, id: bd.candId } } };
          } else throw new Damaged('the index records of the evicted lines are damaged and no other copy of them exists');
        } else {
          staleOut = src.mode === 'changed';
          await nf.write(prefixBuf, recPos(0));
          const lr = decodeRecord(prefixBuf, (evLines - 1) * REC)!;
          start = { count: evLines, h: lr.h, c: lr.c, convCount: lr.convCount, off: lr.offset + lr.len, rs: { cand: lr.candN === NONE ? null : { n: lr.candN, id: lr.candId } } };
        }
      }
      let include = Math.max(lastValid + 1, ckpt ? ckpt.count : 0, evLines);
      const cursor = new BodyCursor(this.fs, dir, layout, handles);
      // WHY the checkpoint as arbiter (review 5, found by the reviewer's fuzz: an OLDER index.bin whose records describe a history that a set-aside tail later replaced): old records that
      // disagree with the bodies were being trusted as "the truth about a rotted line", which forked the head and cost every line after them. When the bodies, hashed from the start state, reach
      // EXACTLY the checkpoint's chain value at its count, nothing is rotted and the checkpoint (a separate, current file) says the bodies are right: the old records are not used at all and
      // every line is derived from its body, confirmed by that same value. (Only when no valid record lies beyond the checkpoint: those would be a crash between index and checkpoint.)
      // WHY the checkpoint is graded by its history count (round 7, F1): a checkpoint written in the CURRENT history (count equal) is the newest statement there is, and an index or bodies that disagree with
      // it are the old ones; a checkpoint written BEFORE a later takeover or quarantine (count lower) is the old one, and may only be believed for lines every history shares (the prefix bound,
      // tails.ts); a count above the folder's means takeover evidence was lost, so nothing is believed. `usable` is how many lines the checkpoint may vouch for AS THE ONLY WITNESS of lines derived from the bodies (the
      // derived-stretch check below); the pure path needs no such gate because the cut-away-branch check covers it (mutation check, round 7: removing the gate there changed no test and no fuzz seed).
      const histNow = await histCount(this.fs, dir);
      let usable = Infinity; let ckptOlder = false;
      if (ckpt && ckpt.hist < histNow) {
        ckptOlder = true;
        const b = await sharedPrefixBound(this.fs, dir, nodePath.basename(dir));
        usable = b === 'unproven' ? -1 : b;
        // WHY (found by the final fuzz run): when every history change newer than the checkpoint can be a takeover that has only BEGUN (its cut is not finished, so the folder still holds what the checkpoint
        // states), no finished change lies after it and nothing bounds it; counting an older, long finished quarantine against it made a stopped takeover plus one damaged index read as "nothing vouches"
        if (histNow - ckpt.hist <= await pendingTakeovers(this.fs, dir)) usable = Infinity;
      } else if (ckpt && ckpt.hist > histNow) usable = -1;
      let pure = false;
      // WHY the second way in (review 6, found by the fuzz once it wrote DIVERGENT histories): an older index.bin from BEFORE a takeover can hold valid records BEYOND the checkpoint that describe the
      // old host's line of history. A crash between index and checkpoint also leaves records beyond the checkpoint, but then the record AT the checkpoint's count agrees with the checkpoint (the
      // checkpoint is written after the index). So records beyond the checkpoint whose own record at the checkpoint's count DISAGREES with it are not "a crash that was ahead": they are another
      // history, and when the bodies reach the checkpoint's chain value exactly, the bodies are right and none of those records is used.
      if (ckpt && ckpt.count > evLines) {
        const pc = new BodyCursor(this.fs, dir, layout, handles);
        let hh: Buffer = Buffer.from(start.h); let at = start.off; let ok = true;
        const atCk = lastValid + 1 > ckpt.count ? await refRec(ckpt.count - 1) : null;
        if (lastValid + 1 <= ckpt.count || (atCk !== null && !atCk.rec.h.equals(ckpt.h))) {
          for (let i = evLines; i < ckpt.count; i++) { const ln = await pc.takeLine(at); if (!ln) { ok = false; break; } hh = chainStep(hh, ln); at += ln.length; }
          pure = ok && hh.equals(ckpt.h);
          if (pure) include = ckpt.count;
        }
      }
      const s: BatchState = { ...start };
      const sum: SumFacts = { title: null, model: null, cwd: null };
      let gapStart = -1;                 // first slot of the current run of derived-only records, or -1
      let firstBad: number | null = null;
      let convStaleNow = staleOut;
      let pos = start.off;
      let stopAt = include;              // slots [evLines, stopAt) end up in the new index
      let ambiguous = false;
      // WHY (round 7, F1): set when this rebuild SERVES something that a valid file contradicts: a valid index record whose chain value differs from the line derived from the body (the pure path), or a
      // checkpoint whose chain value differs from the rebuilt one and is rewritten. Those are the two relaxations of rounds 5 and 6; they are right when ONE file is older, and wrong when TWO files are older
      // together (an older index with older bodies and a newer checkpoint reads as "the checkpoint is the odd one out"). The cut-away-branch check below is what tells the two apart.
      let overrode = false;
      let derivedAny = false;            // some slot had no valid record and was derived from its body alone (review 6: then nothing but the checkpoint vouches for it)
      const out: Buffer[] = []; let outFrom = evLines;
      const flush = async (to: number) => { if (out.length) { await nf.write(Buffer.concat(out), recPos(outFrom)); out.length = 0; } outFrom = to; };
      for (let i = evLines; i < include; i++) {
        const o = pure ? null : await refRec(i);
        let line: Buffer | null;
        if (o) {
          if (o.rec.offset !== pos) { if (gapStart >= 0) { ambiguous = true; stopAt = gapStart; break; } throw new Damaged(`record ${i} says its line starts at byte ${o.rec.offset}, the body is at ${pos}`); }
          line = await cursor.take(pos, o.rec.len);
          if (!line) {
            // WHY not Damaged past the checkpoint (review 4): a record the checkpoint never vouched for and whose body is not there is not an acknowledged line. It comes from an
            // OLDER index copy (replaced-index/ after a cut, an older index.bin) whose lines were cut away since. The rebuild ends before it; the lines before it are untouched.
            if (ckpt && i >= ckpt.count && i >= evLines && gapStart < 0) { include = i; stopAt = i; break; }
            // WHY not Damaged for a record the checkpoint (or nothing) vouches for (review 4, F3): a body that is simply not there is a hole, reported line by line, exactly like a body that
            // does not match its chain value. The record's own chain value stays the truth, it is kept as it is, and the first such line is reported (scrub.json points at it).
            // A derived-only stretch before it cannot be confirmed past a hole: it is dropped from its start, as for any unconfirmed stretch.
            if (gapStart >= 0) { ambiguous = true; stopAt = gapStart; break; }
            if (firstBad === null) firstBad = i;
            if (o.ref.mode === 'changed') convStaleNow = true;
            s.h = Buffer.from(o.rec.h); s.c = Buffer.from(o.rec.c); s.convCount = o.rec.convCount; s.rs = { cand: o.rec.candN === NONE ? null : { n: o.rec.candN, id: o.rec.candId } };
            s.off = o.rec.offset + o.rec.len; s.count++; pos = s.off;
            const hb = Buffer.alloc(REC); encodeRecord(o.rec, hb, 0); out.push(hb);
            if (out.length >= 1024) await flush(i + 1);
            continue;
          }
        } else {
          line = await cursor.takeLine(pos);
          if (!line) {
            // WHY (review 5, fuzz seed 9708): the same rule as for a record with no body, for a SLOT with no valid record. Past the checkpoint nothing was ever acknowledged, so a missing body there ends the
            // rebuild; it must not be Damaged just because an OLDER index copy (replaced-index/, after a cut) still has valid records further on and one rotted record exactly at the cut.
            if (ckpt && i >= ckpt.count && i >= evLines && gapStart < 0) { include = i; stopAt = i; break; }
            // WHY not Damaged when ONLY the checkpoint vouches for this line and every line before it has a valid record (review 4): the body holds exactly what the index
            // holds, so the checkpoint is the file that is ahead of everything (an older copy taken before a cut, which setAsideTail makes legitimate). The lines the
            // checkpoint claimed are reported as set aside (partial.json) and the old statement is kept in torn/ before it is lowered; the chat is not hidden.
            // (When earlier lines in this stretch were derived from the body alone, nothing can confirm them either: the stretch is dropped from its start, the lines stay in torn/.)
            if (i > lastValid) { ambiguous = true; stopAt = gapStart >= 0 ? gapStart : i; break; }
            throw new Damaged(`the body holds no line ${i}, but the index or the checkpoint vouches for it`);
          }
        }
        const sb = { ...s };
        const { recs } = this.encodeBatch(runtime, s, [line], sum);
        let d = decodeRecord(recs, 0)!;
        if (pure) { const seen = await refRec(i); if (seen && !seen.rec.h.equals(d.h)) overrode = true; }   // a valid record of another chain was not used (round 7, F1)
        if (o) {
          const rawOk = d.h.equals(o.rec.h);
          const fieldsSame = d.c.equals(o.rec.c) && d.convCount === o.rec.convCount && d.kind === o.rec.kind && d.confirms === o.rec.confirms && d.candN === o.rec.candN && d.candId === o.rec.candId && d.conversation === o.rec.conversation;
          if (o.ref.mode === 'unknown' && rawOk && !fieldsSame) o.ref.mode = 'changed';
          const trust = o.ref.mode !== 'changed';
          if (!rawOk) {
            if (gapStart >= 0) { ambiguous = true; stopAt = gapStart; Object.assign(s, sb); break; }
            if (firstBad === null) firstBad = i;
            // the old record's chain value is the truth; the rotted bytes only taint what is derived from them
            s.h = Buffer.from(o.rec.h);
            if (trust) { s.c = Buffer.from(o.rec.c); s.convCount = o.rec.convCount; s.rs = { cand: o.rec.candN === NONE ? null : { n: o.rec.candN, id: o.rec.candId } }; d = o.rec; }
            else { convStaleNow = true; d = { ...d, h: Buffer.from(o.rec.h) }; }
          } else {
            gapStart = -1;
            if (trust) { s.c = Buffer.from(o.rec.c); s.convCount = o.rec.convCount; s.rs = { cand: o.rec.candN === NONE ? null : { n: o.rec.candN, id: o.rec.candId } }; d = o.rec; }
          }
        } else { derivedAny = true; if (gapStart < 0) gapStart = i; }
        const ob = Buffer.alloc(REC); encodeRecord(d, ob, 0); out.push(ob);
        pos += line.length;
        if (out.length >= 1024) await flush(i + 1);
      }
      await flush(stopAt);
      let count = ambiguous ? stopAt : include;
      // a derived-only stretch at the end is confirmed by the checkpoint's chain value or not at all
      if (!ambiguous && gapStart >= 0) {
        const lr = await this.recFromFile(nf, include - 1);
        if (!ckpt || ckpt.count !== include || ckpt.count > usable || !lr || !lr.h.equals(ckpt.h)) { ambiguous = true; count = gapStart; }   // (an older checkpoint cannot confirm lines past the shared prefix, round 7 F1)
      }
      if (!ambiguous && ckpt && ckpt.count > 0 && ckpt.count <= include) {
        const lr = await this.recFromFile(nf, ckpt.count - 1);
        // WHY not Damaged when EVERY line has a valid record that its own body confirms (review 6, found by the fuzz with divergent histories): the index and the bodies agree with each other
        // all the way, so the checkpoint is the odd one out. Time only runs one way (a takeover replaces a history, never the reverse), so a checkpoint of another history is an OLDER copy
        // from before a takeover; it is not evidence and is rewritten from the index below. Rot cannot look like this: a rotted body breaks its record's chain value (that is `firstBad`). Only when the index is strictly AHEAD of the checkpoint: a checkpoint that states the head itself and disagrees is still quarantined (second-round N1 test).
        if ((!lr || !lr.h.equals(ckpt.h)) && (pure || firstBad !== null || derivedAny || ckpt.count >= include || !ckptOlder)) throw new Damaged(`the rebuilt chain disagrees with the checkpoint at line ${ckpt.count}`);
        if (!lr || !lr.h.equals(ckpt.h)) overrode = true;   // the checkpoint is overruled by an index and bodies that agree with each other (round 7, F1)
      }
      if (ckpt && ckpt.count > include) throw new Damaged(`the checkpoint vouches for ${ckpt.count} lines but the body holds ${include}`);
      // nothing at all is verified (no valid record, and the one stretch the checkpoint covers does not match): refused as damaged, the whole version is kept intact in aside/
      // (a body with NO whole line at all is not "unvouched bytes": it is an empty version whose checkpoint is stale, e.g. an older copy taken before a set-aside moved everything away;
      // that is reported as lines set aside from the head, below, instead of quarantining nothing)
      if (ambiguous && count === 0 && (await this.countWholeLines(dir, 0)) > 0) throw new Damaged('nothing stored vouches for the body: the checkpoint disagrees with the derived chain and no valid record narrows it down');
      await nf.truncate(recPos(count));        // DESTRUCTIVE-OK(scratch): cuts only the scratch file
      // lines past what is vouched for: never acknowledged when a checkpoint says so, possibly acknowledged when it does not
      const lastRec = count > 0 ? await this.recFromFile(nf, count - 1) : null;
      // WHY (round 7, F1, the class behind review 7's finding): the two relaxations above cannot know WHICH side of a disagreement is the older one; "time only runs one way" holds for one older file but
      // not for two put back together. What CAN be proven, from evidence an older-file fault cannot forge, is whether the head we are about to serve lies on a history a takeover REPLACED: the takeover's
      // tail file holds every line the old host had past the cut, so the chain value after each of them is on file (tails.ts cutAwayBranchHit). Older files from before a takeover are either shorter than
      // the cut (a shared prefix: correct) or run along that tail's branch (a hit). So when a file was overridden and the head is on a replaced branch, or the evidence needed to say cannot be read
      // (a tail missing or unreadable, or the high-water record counting takeovers tails/ no longer shows), the version stays LOUD: quarantined, recopied from a peer later. PROVEN: a served head is never a
      // point of a replaced history after an override. NOT claimed: all files older together with the tails also gone (the lost-tails report above says so), or a restore from before a quarantine.
      if ((overrode || (ambiguous && ckpt)) && lastRec && count > 0) {   // `ambiguous`: the checkpoint vouches for more than the files can confirm, so what is served cannot be reconciled with it either (found by the round-7 fuzz: an older index and bodies behind a newer checkpoint)
        const key = nodePath.basename(dir);
        const hv = (await readHw(this.fs, nodePath.dirname(nodePath.dirname(dir)), key)).st.value;
        const hit = await cutAwayBranchHit(this.fs, dir, key, count, hex(lastRec.h), hv?.takeovers ?? 0);
        if (hit === 'unproven') throw new Damaged('the files disagree and the takeover records that could say which are missing or unreadable: refusing to pick one');
        if (hit !== null) throw new Damaged(`the index and bodies end where takeover ${hit} cut an older history away, while the checkpoint states another: older files put back together, refusing to serve them`);
      }
      const endOff = lastRec ? lastRec.offset + lastRec.len : 0;
      const surplusLines = await this.countWholeLines(dir, endOff);
      let partial: { fromLine: number; lost: number } | null = null;
      if (ambiguous) partial = { fromLine: count, lost: Math.max(1, (ckpt ? Math.max(ckpt.count, include) : include) - count) };
      else if (!ckpt && surplusLines > 0) {
        if (count === evLines && count === 0) throw new Damaged('nothing stored vouches for the body (no valid index record and no checkpoint): refusing to accept it');
        partial = { fromLine: count, lost: surplusLines };
      }
      const ckStamp = convStaleNow ? (stamp ^ 0x80000000) >>> 0 : stamp;   // a stamp that never equals the real one: its `c` is not comparable
      const finishSwap = async (): Promise<void> => {
        await nf.sync();
        // WHY close before renaming: Windows refuses to rename a file that is still open
        for (const f of handles.splice(0)) await f.close();
        if (hadOld) {
          const rd = nodePath.join(dir, 'replaced-index');
          await mkdirDurable(this.fs, rd);
          const to = nodePath.join(rd, await nextNumbered(this.fs, rd, 'index-', '.bin', 4));
          // DESTRUCTIVE-OK(kept-copy-first): the old index moves to a NEW name in replaced-index/ (never overwritten) before the new one takes its place
          await this.fs.rename(oldPath, to);
          await this.fs.fsyncDir(rd); await this.fs.fsyncDir(dir);
        }
        // DESTRUCTIVE-OK(kept-copy-first): the target name was just vacated by the move above, or never existed
        await this.fs.rename(tmpPath, oldPath);
        await this.fs.fsyncDir(dir);
      };
      if (partial) {
        // the checkpoint would claim lines the index no longer has: keep its old statement in torn/, then lower it BEFORE the swap
        if (ckpt && ckpt.count > count) {
          const old = await this.fs.readFile(nodePath.join(dir, CHECKPOINT_FILE));
          // WHY Damaged and not the raw error: the statement must not be lowered without a kept copy, and a full keep-area or disk must not wedge the version; quarantine needs only renames
          try { if (old) await this.keepBytes(dir, 'checkpoint', old); }
          catch (e) { if (isDiskFull(e) || (e instanceof StoreError && e.code === 'limit')) throw new Damaged('the old checkpoint statement could not be kept (the keep-area or the disk is full)'); throw e; }
        }
        await setMarks(this.fs, dir, { partial: { fromLine: partial.fromLine, lost: partial.lost } }); // DESTRUCTIVE-OK(hint): marks lines as set aside; replaces an older marker of the same kind
      }
      const evBytesOut = evLines > 0 ? ev.bytes : 0;
      // the boundary is read back from the new index (a real record or the stand-in), so the checkpoint and the index agree by construction
      let boundary: Boundary | null = null;
      if (evLines > 0) { const br = await this.recFromFile(nf, evLines - 1); if (br) boundary = { h: Buffer.from(br.h), c: Buffer.from(br.c), convCount: br.convCount, candN: br.candN, candId: br.candId }; }
      // DESTRUCTIVE-OK(verified-record): the new statement is the chain value of a verified record; an older, higher statement was copied to torn/ above whenever it is being lowered
      await writeCheckpoint(this.fs, dir, { count, stamp: ckStamp, evLines: boundary ? evLines : 0, evBytes: boundary ? evBytesOut : 0, boundary, lostRecs: boundary && synthesized ? evLines : 0, staleBad: convStaleNow ? firstBad : null, hist: histNow, h: lastRec ? lastRec.h : Buffer.from(seeds.raw), c: lastRec ? lastRec.c : Buffer.from(seeds.conversation) });
      await finishSwap();
      // scrub.json: the old mark described the old index. Point the scrub at the first bad line so the next open reports it at once.
      await writeSideFor(this.fs, nodePath.join(dir, 'scrub.json'), { role: 'scrub', key: keyOfDir(dir) }, { lines: firstBad ?? 0, passEnd: count }); // DESTRUCTIVE-OK(hint): a progress hint
      return { count, firstBad, partial, staleConv: convStaleNow };
    } finally { for (const f of handles) await f.close().catch(() => undefined); }
  }

  private async recFromFile(f: FileLike, slot: number): Promise<Rec | null> {
    if (slot < 0) return null;
    const b = await f.read(recPos(slot), REC);
    return b.length === REC ? decodeRecord(b, 0) : null;
  }

  /**
   * Examine index.bin. Repairs a damaged or torn TAIL in place (the bytes are kept in torn/ first); anything else throws NeedsRebuild.
   * Nothing is ever re-derived or adopted here (review 3, F3): a cut-off record region says "an index write was in flight or a record rotted"
   * and loadOnce decides, from the checkpoint, whether the body lines after it were acknowledged. `tailDamaged` says there was such a region.
   * When the cut cannot be made (the keep-area is full or the disk is full) the index file is left alone and `tailDeferred` says so.
   */
  async settleIndex(dir: string, ev: { lines: number; bytes: number }, layout: { chunks: number[]; phys: number }, stamp: number, lostRecs = 0): Promise<{ count: number; last: Rec | null; tailDamaged: boolean; tailDeferred: boolean; needsInit?: boolean }> {
    const ip = nodePath.join(dir, 'index.bin');
    const hasBodies = layout.chunks.length > 0 && layout.phys > ev.bytes;
    const none = { count: 0, last: null, tailDamaged: false, tailDeferred: false };
    if (!(await this.fs.exists(ip))) {
      if (!hasBodies && ev.lines === 0) {
        // WHY tolerate a full disk (N5): a version that was registered but never written to is empty, and "empty" can be served
        // without creating its index file; the file is created by the first append (which is then refused, typed, while the disk is full)
        try { await this.ensureIndex(dir, stamp); } catch (e) { if (!isDiskFull(e)) throw e; return { ...none, needsInit: true }; }
        return none;
      }
      throw new NeedsRebuild('index.bin is missing');
    }
    const f = await this.fs.open(ip, { create: false });
    try {
      const size = await f.size();
      if (size < HDR) {
        if (!hasBodies && ev.lines === 0) {
          // DESTRUCTIVE-OK(scratch): a file shorter than its own header holds no record; with no bodies and nothing evicted there is nothing it could describe
          try { await f.truncate(0); await f.write(indexHeader(stamp, tagOfDir(dir)), 0); await f.sync(); } catch (e) { if (!isDiskFull(e)) throw e; return { ...none, needsInit: true }; }
          return none;
        }
        throw new NeedsRebuild('index header is missing');
      }
      const hdr = await f.read(0, HDR);
      if (!headerOk(hdr)) throw new NeedsRebuild('index header is damaged');
      // WHY (review 4, F8): a header with a good checksum and another version's tag is a FOREIGN index (a wrong-folder copy). Its records are valid for someone else; the
      // rebuild leaves them out entirely and re-derives this version's index from its own bodies, confirmed by its own checkpoint.
      if (!headerTag(hdr).equals(tagOfDir(dir))) throw new NeedsRebuild('index belongs to another version');
      if (headerStamp(hdr) !== stamp) throw new NeedsRebuild('classifier stamp changed');
      let count = Math.floor((size - HDR) / REC);
      const partial = size - HDR - count * REC;
      // WHY (review 5, fuzz seed 27188): an index shorter than the stand-in record the checkpoint says it holds (an older copy) cannot be walked from there: re-derive it
      if (lostRecs > 0 && count < lostRecs) throw new NeedsRebuild('the index is shorter than the evicted prefix the checkpoint describes');
      // Verify only the window a crash could have damaged (the last VERIFY_WINDOW records); the rolling
      // scrub (scrubSome) walks the older part a bounded amount per open.
      // WHY the lostRecs floor (review 5, F4): the slots before the stand-in record hold no real record by design; they are not damage
      const from = Math.max(0, count - VERIFY_WINDOW, lostRecs > 0 ? lostRecs - 1 : 0);
      const buf = await f.read(recPos(from), (count - from) * REC);
      let good = 0; let prev: Rec | null = null;
      for (; good < count - from; good++) {
        const r = decodeRecord(buf, good * REC);
        if (!r || (prev && r.offset !== prev.offset + prev.len)) break;
        prev = r;
      }
      let tailDamaged = false; let tailDeferred = false;
      const cut = async (keepFrom: number, newCount: number): Promise<void> => {
        tailDamaged = true;
        try {
          await this.keepBytes(dir, 'index-tail', await f.read(keepFrom, size - keepFrom));
          // DESTRUCTIVE-OK(kept-copy-first): the cut-off bytes were copied to torn/ and fsynced just above
          await f.truncate(recPos(newCount)); await f.sync();
        } catch (e) {
          // WHY not fatal: the keep-area is full (`limit`) or the disk is full. Serving the valid records needs no write; the cut is retried before the next write.
          if (!isDiskFull(e) && !(e instanceof StoreError && e.code === 'limit')) throw e;
          tailDeferred = true;
        }
        count = newCount;
      };
      if (from + good < count) {
        // A valid record after the first bad one is NOT a torn tail: that is bit rot or a lost record (C1).
        for (let i = good; i < count - from; i++) if (decodeRecord(buf, i * REC)) throw new NeedsRebuild(`record ${from + good} is damaged but later records are valid`);
        await cut(recPos(from + good), from + good);
      } else if (partial > 0) await cut(recPos(count), count);
      let last: Rec | null = null;
      if (count > 0) { last = decodeRecord(await f.read(recPos(count - 1), REC), 0); if (!last) throw new NeedsRebuild('last index record is unreadable'); }
      return { count, last, tailDamaged, tailDeferred };
    } finally { await f.close(); }
  }

  /** Create index.bin with just a header when it is missing or short (an empty version). */
  async ensureIndex(dir: string, stamp: number): Promise<void> {
    const f = await this.fs.open(nodePath.join(dir, 'index.bin'), { create: true });
    try {
      // DESTRUCTIVE-OK(scratch): only when the file is shorter than a header, i.e. holds no record
      if ((await f.size()) < HDR) { await f.truncate(0); await f.write(indexHeader(stamp, tagOfDir(dir)), 0); await f.sync(); }
    } finally { await f.close(); }
    await this.fs.fsyncDir(dir);
  }
}

/** Reads the body by logical offset across chunk files with a one-block cache. Lines never cross a chunk. */
class BodyCursor {
  private cache: { chunk: number; start: number; buf: Buffer } | null = null;
  private readonly files = new Map<number, FileLike>();
  constructor(private readonly fs: Fs, private readonly dir: string, private readonly layout: { chunks: number[]; sizes: number[] }, private readonly handles: FileLike[]) {}
  /** A chunk covers [start, min(start + size, next chunk's start)): bytes it holds past the next start are never read (a doubled or too-long file stays harmless). */
  private endOf(i: number): number { return Math.min(this.layout.chunks[i] + this.layout.sizes[i], i + 1 < this.layout.chunks.length ? this.layout.chunks[i + 1] : Infinity); }
  private chunkIdx(pos: number): number { for (let i = 0; i < this.layout.chunks.length; i++) if (pos >= this.layout.chunks[i] && pos < this.endOf(i)) return i; return -1; }
  private async file(i: number): Promise<FileLike> {
    let f = this.files.get(i);
    if (!f) { f = await this.fs.open(chunkPathOf(this.dir, this.layout.chunks[i]), { create: false }); this.handles.push(f); this.files.set(i, f); }
    return f;
  }
  private async load(i: number, pos: number, want: number): Promise<Buffer> {
    const cend = this.endOf(i);
    const n = Math.min(Math.max(want, 4 * MIB), cend - pos);
    const b = await (await this.file(i)).read(pos - this.layout.chunks[i], n);
    this.cache = { chunk: i, start: pos, buf: b };
    return b;
  }
  /** `len` bytes at `pos`, or null when they do not lie wholly inside one chunk. */
  async take(pos: number, len: number): Promise<Buffer | null> {
    const i = this.chunkIdx(pos);
    if (i < 0 || pos + len > this.endOf(i)) return null;
    let c = this.cache;
    if (!c || c.chunk !== i || pos < c.start || pos + len > c.start + c.buf.length) { await this.load(i, pos, len); c = this.cache!; }
    return c.buf.length >= pos - c.start + len ? c.buf.subarray(pos - c.start, pos - c.start + len) : null;
  }
  /** The line at `pos` including its newline, or null when the chunk ends first (a partial line is not a line). */
  async takeLine(pos: number): Promise<Buffer | null> {
    const i = this.chunkIdx(pos);
    if (i < 0) return null;
    const cend = this.endOf(i);
    let want = 4 * MIB;
    for (;;) {
      let c = this.cache;
      if (!c || c.chunk !== i || pos < c.start || pos >= c.start + c.buf.length) { await this.load(i, pos, want); c = this.cache!; }
      const nl = c.buf.indexOf(0x0a, pos - c.start);
      if (nl !== -1) return c.buf.subarray(pos - c.start, nl + 1);
      if (c.start + c.buf.length >= cend) return null;
      want = Math.min(cend - pos, (c.buf.length - (pos - c.start)) * 2 + 4 * MIB);
      await this.load(i, pos, want);
    }
  }
}

/** The next free `<prefix><n><suffix>` in `dir` (max existing + 1, never a name that exists). WHY not a directory count: a kept file that vanished must not let a later one reuse its name. */
export async function nextNumbered(fs: Fs, dir: string, prefix: string, suffix: string, width: number): Promise<string> {
  let max = 0;
  for (const n of await fs.readdir(dir)) { if (n.startsWith(prefix) && n.endsWith(suffix)) { const v = parseInt(n.slice(prefix.length, n.length - suffix.length), 10); if (Number.isFinite(v)) max = Math.max(max, v); } }
  for (let v = max + 1; ; v++) { const name = `${prefix}${String(v).padStart(width, '0')}${suffix}`; if (!(await fs.exists(nodePath.join(dir, name)))) return name; }
}

interface Ref { f: FileLike; slots: number; size: number; mode: 'same' | 'changed' | 'unknown'; cache: Map<number, Buffer> }
export interface RebuildResult { count: number; firstBad: number | null; partial: { fromLine: number; lost: number } | null; staleConv: boolean }
