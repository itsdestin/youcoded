// Seam S2: the chat store. On disk under a caller-supplied root; pure library, called by nothing yet.
//
// Layout (all names computed from validated ids, never from peer strings):
//   <root>/FORMAT                      store format marker
//   <root>/versions/<vhex>/            one directory per version (vhex = hex of the opaque version id)
//       meta.json                      chat id, runtime, parent (opaque), written once, atomically
//       index.bin                      16-byte header + one fixed-width record per line (records.ts)
//       body-<startByte>.bin           raw line bytes, chunked; the index says where each line is
//       evicted.json                   {lines, bytes}: bodies of the first `lines` lines were dropped
//       summary.json                   latest title / model / folder
//       parked/<from>-<hash>.park      appends that arrived with a gap before them
//       rejected/...                   parked appends found NOT to be a prefix (kept, never deleted)
//       tails/<takeoverId>.tail        a host's tail set aside at a takeover
//   <root>/aside/<vhex>-<n>/           files of a copy found damaged and recopied (kept, never deleted)
//   <root>/extras/<aa>/<sha256>        extras by content hash
//   <root>/control/<sha256(chat)>/     control-log storage (control.ts)
//
// Crash rules (the reasons for the write order below):
//  1. A line exists exactly when its index record is whole and CRC-correct AND its body bytes are on
//     disk. So an append writes the BODY, fsyncs it, then writes the INDEX records, fsyncs them, and
//     only then returns ("acknowledged"). A kill between the two leaves body bytes past the last record,
//     which the next open trims. Never the other way round.
//  2. Whole-file replacements (meta, summary, evicted marker, parked and tail files, extras) are
//     temp-file + fsync + rename + directory fsync.
//  3. Multi-step operations (set aside a damaged copy, set aside a tail, evict, restore) are ordered so
//     that every prefix of their steps is a state open() understands and finishes or ignores.
//  4. After any failed operation the cached in-memory state of that version is dropped, so the next
//     call re-reads the disk and repairs; memory is never trusted after an error.
//
// No file handles are kept open between calls (a user can have 1,400+ chats; handles would exhaust the
// process limit). One in-process lock serialises all calls: the store is single-process by design.
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { realFs, writeFileAtomic, sweepTemps, type Fs, type FileLike } from './fsio';
import { StoreError } from './errors';
import { chainStep, defaultChainSeeds, hex, isHash64, unhex, type ChainSeedFn, type ChainSeeds, type RuntimeKind } from './chain';
import { analyseLine, initialReplyState, replyEndStep, type LineInfo, type ReplyEndOptions, type ReplyState } from './classify';
import { HDR, REC, NONE, decodeRecord, encodeRecord, frameLines, headerOk, indexHeader, recPos, unframeLines, type Rec } from './records';
import { ControlStore, type ControlEntry } from './control';

export type VersionId = Uint8Array;

export interface StoreOptions {
  fs?: Fs;
  /** The single replaceable rule that seeds both chains (chain.ts). */
  seeds?: ChainSeedFn;
  /** Arrival-time clock for "last used" (never a line timestamp: T2 finding 10). */
  now?: () => number;
  /** A new body chunk file starts once the active one reaches this size. */
  chunkBytes?: number;
  /** Cap on bytes of parked (gapped) appends held per version. */
  maxParkedBytes?: number;
  replyEnd?: ReplyEndOptions;
}

export interface VersionMeta {
  chatId: string;
  runtime: RuntimeKind;
  /** Opaque parent version id (rewrite becomes a new version whose parent is the old one); not interpreted here. */
  parent?: VersionId | null;
}

export interface Head {
  lines: number;
  /** Raw chain value after `lines` lines, 64 hex. */
  hash: string;
  conversationLines: number;
  conversationHash: string;
  /** Lines whose bodies were evicted (chain values are always kept). */
  evictedLines: number;
}

export type AppendResult = 'ok' | 'parked' | 'not-a-prefix';

export interface Summary {
  lines: number;
  conversationLines: number;
  replyEnds: number;
  title: string | null;
  model: string | null;
  cwd: string | null;
  /** Arrival time (ms since epoch) of the last append: "used" comes from arrival, never from line timestamps. */
  lastAppendMs: number | null;
}

/** Opaque proof that other devices hold these lines. Validated by SHAPE and chain match only; policy is elsewhere. */
export interface EvictionProof {
  kind: 'holders-confirmed';
  holders: string[];
  through: number;
  hash: string;
}

export interface TailRecord {
  version: VersionId;
  fromLine: number;
  fromHash: string;
  fromConversationHash: string;
  headHash: string;
  headConversationHash: string;
  lines: Buffer[];
  /** Reply ends confirmed inside the tail (absolute line numbers) and the unconfirmed candidate, if any. */
  replyEnds: number[];
  pendingReplyEnd: number | null;
}

export interface VerifyReport { ok: boolean; lines: number; firstBadLine: number | null; reason?: string }

const DEFAULT_CHUNK = 16 * 1024 * 1024;
const VERIFY_WINDOW = 4096;
const SCAN_BATCH = 4096;
/** summary.json is also rewritten every this many lines even when no fact changed, so open() never re-scans far. */
const SUMMARY_SAVE_EVERY = 2048;
const hexName = (b: Uint8Array): string => hex(b);
const TAKEOVER_RE = /^[0-9a-f]{8,128}$/;

interface VState {
  key: string;
  dir: string;
  meta: { chatId: string; runtime: RuntimeKind; parent: string | null; createdMs: number };
  seeds: ChainSeeds;
  count: number;
  h: Buffer;
  c: Buffer;
  convCount: number;
  bodyEnd: number;
  rs: ReplyState;
  evictedLines: number;
  evictedBytes: number;
  chunks: number[];             // start offsets of body chunk files, ascending
  replyEndsCache: number[] | null;
  /** Line count when summary.json was last written; bounds how much open() has to catch up. */
  summarySavedAt: number;
  summary: { title: string | null; model: string | null; cwd: string | null; lastAppendMs: number | null; lines: number };
}

export class ChatStore {
  private readonly fs: Fs;
  private readonly seedFn: ChainSeedFn;
  private readonly now: () => number;
  private readonly chunkBytes: number;
  private readonly maxParked: number;
  private readonly replyOpts: ReplyEndOptions;
  private readonly versions = new Map<string, VState>();
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly control: ControlStore;

  private constructor(readonly root: string, o: StoreOptions) {
    this.fs = o.fs ?? realFs;
    this.seedFn = o.seeds ?? defaultChainSeeds;
    this.now = o.now ?? Date.now;
    this.chunkBytes = o.chunkBytes ?? DEFAULT_CHUNK;
    this.maxParked = o.maxParkedBytes ?? 256 * 1024 * 1024;
    this.replyOpts = o.replyEnd ?? {};
    this.control = new ControlStore(this.fs, nodePath.join(root, 'control'));
  }

  /** Open (creating if needed) a store under `root`. Sweeps interrupted temp files; never deletes data. */
  static async open(root: string, o: StoreOptions = {}): Promise<ChatStore> {
    const s = new ChatStore(root, o);
    const fs = s.fs;
    await fs.mkdir(root);
    const fmt = nodePath.join(root, 'FORMAT');
    const cur = await fs.readFile(fmt);
    if (cur === null) { await writeFileAtomic(fs, fmt, Buffer.from('youcoded-mesh-store 1\n')); }
    else if (cur.toString() !== 'youcoded-mesh-store 1\n') throw new StoreError('corrupt', 'unknown store format');
    for (const d of ['versions', 'aside', 'extras', 'control']) await fs.mkdir(nodePath.join(root, d));
    await sweepTemps(fs, root);
    return s;
  }

  async close(): Promise<void> { await this.chain.catch(() => undefined); this.closed = true; this.versions.clear(); }

  // ---- locking -----------------------------------------------------------------------------
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new StoreError('closed'));
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
  /** Run a mutation; on any failure drop cached state of the version so the next call repairs from disk. */
  private async mutate<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (e) { if (key) this.versions.delete(key); else this.versions.clear(); throw e; }
  }

  // ---- paths -------------------------------------------------------------------------------
  private vdir(key: string): string { return nodePath.join(this.root, 'versions', key); }
  private chunkPath(st: { dir: string }, start: number): string { return nodePath.join(st.dir, `body-${start.toString(16).padStart(16, '0')}.bin`); }
  private keyOf(version: VersionId): string {
    if (!(version instanceof Uint8Array) || version.length < 1 || version.length > 128) throw new StoreError('bad-argument', 'version id must be 1..128 bytes');
    return hexName(version);
  }
  private checkSegment(segment: number): void { if (segment !== 0) throw new StoreError('bad-argument', 'segment is always 0'); }

  // ---- registering and loading versions -------------------------------------------------------
  /**
   * Make a version known. Idempotent for the same facts; a conflicting re-registration throws.
   * The chat id is needed because the default seed rule uses it (design 5.3); the version id stays opaque.
   */
  registerVersion(version: VersionId, meta: VersionMeta): Promise<void> {
    const key = this.keyOf(version);
    if (typeof meta.chatId !== 'string' || meta.chatId.length === 0 || meta.chatId.length > 1024) throw new StoreError('bad-argument', 'chatId');
    if (meta.runtime !== 'claude-code' && meta.runtime !== 'native') throw new StoreError('bad-argument', 'runtime');
    return this.exclusive(() => this.mutate(key, async () => {
      const dir = this.vdir(key);
      const existing = await this.readMeta(dir);
      const parent = meta.parent ? hexName(meta.parent) : null;
      if (existing) {
        if (existing.chatId !== meta.chatId || existing.runtime !== meta.runtime || existing.parent !== parent) throw new StoreError('version-conflict', key.slice(0, 8));
        return;
      }
      await this.fs.mkdir(dir);
      const m = { format: 1, chatId: meta.chatId, runtime: meta.runtime, parent, createdMs: this.now() };
      await writeFileAtomic(this.fs, nodePath.join(dir, 'meta.json'), Buffer.from(JSON.stringify(m)));
      await this.ensureIndex(dir);
      await this.fs.fsyncDir(nodePath.join(this.root, 'versions'));
    }));
  }

  private async readMeta(dir: string): Promise<{ chatId: string; runtime: RuntimeKind; parent: string | null; createdMs: number } | null> {
    const b = await this.fs.readFile(nodePath.join(dir, 'meta.json'));
    if (!b) return null;
    try {
      const m = JSON.parse(b.toString());
      if (typeof m.chatId === 'string' && (m.runtime === 'claude-code' || m.runtime === 'native')) return { chatId: m.chatId, runtime: m.runtime, parent: m.parent ?? null, createdMs: Number(m.createdMs) || 0 };
    } catch { /* fallthrough */ }
    throw new StoreError('corrupt', 'meta.json');
  }

  private async ensureIndex(dir: string): Promise<void> {
    const p = nodePath.join(dir, 'index.bin');
    const f = await this.fs.open(p, { create: true });
    try {
      if ((await f.size()) < HDR) { await f.truncate(0); await f.write(indexHeader(), 0); await f.sync(); }
    } finally { await f.close(); }
    await this.fs.fsyncDir(dir);
  }

  private async state(version: VersionId): Promise<VState> {
    const key = this.keyOf(version);
    const cached = this.versions.get(key);
    if (cached) return cached;
    const st = await this.load(key);
    this.versions.set(key, st);
    return st;
  }

  /** Read a version from disk, repairing whatever an interrupted write left behind (crash rules 1-3). */
  private async load(key: string): Promise<VState> {
    const dir = this.vdir(key);
    const meta = await this.readMeta(dir);
    if (!meta) throw new StoreError('unknown-version', key.slice(0, 8));
    await sweepTemps(this.fs, dir);
    await this.finishAside(key, dir); // a set-aside interrupted half way is completed first
    await this.ensureIndex(dir);
    const seeds = this.seedFn({ chatId: meta.chatId, version: unhex(key), segment: 0 });
    const ev = await this.readEvicted(dir);

    const f = await this.fs.open(nodePath.join(dir, 'index.bin'), { create: false });
    let count: number; let last: Rec | null = null;
    try {
      const size = await f.size();
      const hdr = await f.read(0, HDR);
      if (!headerOk(hdr)) throw new StoreError('corrupt', 'index header');
      count = Math.floor((size - HDR) / REC);
      if (size !== HDR + count * REC) { await f.truncate(HDR + count * REC); await f.sync(); }
      // Verify only the window a crash could have damaged (the last VERIFY_WINDOW records): whole-file
      // verification is `verify()`, not open(), so a cold head() stays fast on a 300 MB chat.
      const from = Math.max(0, count - VERIFY_WINDOW);
      const buf = await f.read(recPos(from), (count - from) * REC);
      let good = 0; let prev: Rec | null = null;
      for (; good < count - from; good++) {
        const r = decodeRecord(buf, good * REC);
        if (!r || (prev && r.offset !== prev.offset + prev.len)) break;
        prev = r;
      }
      if (from + good < count) { count = from + good; await f.truncate(recPos(count)); await f.sync(); }
      if (count > 0) last = decodeRecord(await f.read(recPos(count - 1), REC), 0);
      if (count > 0 && !last) throw new StoreError('corrupt', 'last index record');
    } finally { await f.close(); }

    // Body chunks: find them, drop strays, make the last one agree with the index.
    const chunks: number[] = [];
    for (const name of await this.fs.readdir(dir)) {
      const m = /^body-([0-9a-f]{16})\.bin$/.exec(name);
      if (m) chunks.push(parseInt(m[1], 16));
    }
    chunks.sort((a, b) => a - b);
    const cpath = (start: number) => nodePath.join(dir, `body-${start.toString(16).padStart(16, '0')}.bin`);
    let bodyEnd = last ? last.offset + last.len : 0;
    for (;;) {
      // A chunk that starts at or after the end of the data is a stray from an append that was cut off
      // before its index records landed; it is recreated on demand.
      while (chunks.length && chunks[chunks.length - 1] >= bodyEnd) await this.fs.unlink(cpath(chunks.pop()!));
      if (!chunks.length) {
        // no body at all: lines past the evicted prefix cannot exist
        if (count > ev.lines) { count = ev.lines; await this.cutIndex(dir, count); last = count > 0 ? await this.recAt(dir, count - 1) : null; bodyEnd = last ? last.offset + last.len : 0; continue; }
        break;
      }
      const start = chunks[chunks.length - 1];
      const phys = start + await this.fileSize(cpath(start));
      if (phys === bodyEnd) break;
      if (phys > bodyEnd) { // body bytes past the last record: an append cut off after its body was written
        const cf = await this.fs.open(cpath(start), { create: false });
        try { await cf.truncate(bodyEnd - start); await cf.sync(); } finally { await cf.close(); }
        break;
      }
      // physical body shorter than the index claims (the body is fsynced before the index, so this is rare):
      // drop the records that are not fully backed
      while (count > ev.lines) {
        const r = await this.recAt(dir, count - 1);
        if (r && r.offset + r.len <= phys) break;
        count--;
      }
      await this.cutIndex(dir, count);
      last = count > 0 ? await this.recAt(dir, count - 1) : null;
      bodyEnd = last ? last.offset + last.len : 0;
    }
    // Finish an interrupted eviction: chunks wholly below the evicted byte count are gone for good.
    const keep: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const end = i + 1 < chunks.length ? chunks[i + 1] : bodyEnd;
      if (ev.bytes > 0 && end <= ev.bytes) await this.fs.unlink(nodePath.join(dir, `body-${chunks[i].toString(16).padStart(16, '0')}.bin`));
      else keep.push(chunks[i]);
    }
    const st: VState = {
      key, dir, meta, seeds, count,
      h: last ? last.h : Buffer.from(seeds.raw), c: last ? last.c : Buffer.from(seeds.conversation),
      convCount: last ? last.convCount : 0, bodyEnd,
      rs: last ? { cand: last.candN === NONE ? null : { n: last.candN, id: last.candId } } : initialReplyState(),
      evictedLines: Math.min(ev.lines, count), evictedBytes: ev.lines <= count ? ev.bytes : 0,
      chunks: keep, replyEndsCache: null, summarySavedAt: 0,
      summary: { title: null, model: null, cwd: null, lastAppendMs: null, lines: 0 },
    };
    await this.loadSummary(st);
    await this.drainParked(st);
    return st;
  }

  private async recAt(dir: string, n: number): Promise<Rec | null> {
    const f = await this.fs.open(nodePath.join(dir, 'index.bin'), { create: false });
    try { return decodeRecord(await f.read(recPos(n), REC), 0); } finally { await f.close(); }
  }
  private async cutIndex(dir: string, count: number): Promise<void> {
    const f = await this.fs.open(nodePath.join(dir, 'index.bin'), { create: false });
    try { await f.truncate(recPos(count)); await f.sync(); } finally { await f.close(); }
  }

  private async fileSize(path: string): Promise<number> {
    const f = await this.fs.open(path, { create: false });
    try { return await f.size(); } finally { await f.close(); }
  }

  private async readEvicted(dir: string): Promise<{ lines: number; bytes: number }> {
    const b = await this.fs.readFile(nodePath.join(dir, 'evicted.json'));
    if (!b) return { lines: 0, bytes: 0 };
    try { const m = JSON.parse(b.toString()); if (Number.isSafeInteger(m.lines) && Number.isSafeInteger(m.bytes)) return { lines: m.lines, bytes: m.bytes }; } catch { /* fallthrough */ }
    throw new StoreError('corrupt', 'evicted.json');
  }

  // ---- reading -------------------------------------------------------------------------------
  /** Current head: both chain values and the line count. */
  head(version: VersionId): Promise<Head> {
    return this.exclusive(async () => { const st = await this.state(version); return headOf(st); });
  }

  /** Raw chain value after `n` lines (n = 0 is the seed), or null when the store has fewer than n lines. Works for evicted lines. */
  hashAt(version: VersionId, segment: number, n: number): Promise<string | null> {
    this.checkSegment(segment);
    return this.exclusive(async () => {
      const st = await this.state(version);
      if (!Number.isSafeInteger(n) || n < 0 || n > st.count) return null;
      if (n === 0) return hex(st.seeds.raw);
      const f = await this.fs.open(nodePath.join(st.dir, 'index.bin'), { create: false });
      try { return hex(this.mustRec(await f.read(recPos(n - 1), REC)).h); } finally { await f.close(); }
    });
  }

  /** Lines [from, to), as raw bytes with their newlines; `evicted` when any of them has no body here. */
  read(version: VersionId, segment: number, from: number, to: number): Promise<Buffer[] | 'evicted'> {
    this.checkSegment(segment);
    return this.exclusive(async () => {
      const st = await this.state(version);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new StoreError('bad-argument', 'range');
      const end = Math.min(to, st.count);
      if (from >= end) return [];
      if (from < st.evictedLines) return 'evicted';
      return this.readRange(st, from, end);
    });
  }

  /** Conversation lines (user/assistant) from `fromLine`, in batches: the "search turns" and page readers' shape. */
  async *conversationLines(version: VersionId, fromLine = 0, batchLines = 512): AsyncGenerator<{ line: number; bytes: Buffer }[]> {
    let cursor = fromLine;
    for (;;) {
      const batch = await this.exclusive(async () => {
        const st = await this.state(version);
        const out: { line: number; bytes: Buffer }[] = [];
        const f = await this.fs.open(nodePath.join(st.dir, 'index.bin'), { create: false });
        let n = cursor;
        try {
          while (n < st.count && out.length < batchLines) {
            const take = Math.min(SCAN_BATCH, st.count - n);
            const buf = await f.read(recPos(n), take * REC);
            for (let i = 0; i < take && out.length < batchLines; i++, n++) {
              const r = this.mustRec(buf, i * REC);
              if (!r.conversation) continue;
              if (n < st.evictedLines) throw new StoreError('evicted', `line ${n}`);
              out.push({ line: n, bytes: (await this.readRange(st, n, n + 1))[0] });
            }
          }
        } finally { await f.close(); }
        cursor = n;
        return out;
      });
      if (batch.length === 0) return;
      yield batch;
    }
  }

  private mustRec(buf: Buffer, pos = 0): Rec {
    const r = decodeRecord(buf, pos);
    if (!r) throw new StoreError('corrupt', 'index record failed its checksum');
    return r;
  }

  /** Read lines [from, end) from body chunks. Caller holds the lock and has checked eviction. */
  private async readRange(st: VState, from: number, end: number): Promise<Buffer[]> {
    const f = await this.fs.open(nodePath.join(st.dir, 'index.bin'), { create: false });
    let recs: Buffer;
    try { recs = await f.read(recPos(from), (end - from) * REC); } finally { await f.close(); }
    if (recs.length < (end - from) * REC) throw new StoreError('corrupt', 'index shorter than expected');
    const out: Buffer[] = [];
    let i = 0;
    while (i < end - from) {
      const first = this.mustRec(recs, i * REC);
      const cstart = this.chunkFor(st, first.offset);
      // gather as many consecutive lines as live in this chunk, read them with one call
      let j = i; let spanEnd = first.offset;
      const nextChunk = st.chunks.find((c) => c > cstart);
      while (j < end - from) {
        const r = this.mustRec(recs, j * REC);
        if (nextChunk !== undefined && r.offset >= nextChunk) break;
        spanEnd = r.offset + r.len; j++;
      }
      const cf = await this.fs.open(this.chunkPath(st, cstart), { create: false });
      try {
        const bytes = await cf.read(first.offset - cstart, spanEnd - first.offset);
        if (bytes.length !== spanEnd - first.offset) throw new StoreError('corrupt', 'body shorter than index');
        for (let k = i; k < j; k++) { const r = this.mustRec(recs, k * REC); out.push(bytes.subarray(r.offset - first.offset, r.offset - first.offset + r.len)); }
      } finally { await cf.close(); }
      i = j;
    }
    return out;
  }

  private chunkFor(st: VState, offset: number): number {
    let found = -1;
    for (const c of st.chunks) { if (c <= offset) found = c; else break; }
    if (found < 0) throw new StoreError('corrupt', 'no body chunk covers offset');
    return found;
  }

  // ---- appending -----------------------------------------------------------------------------
  /**
   * Add `lines` (each exactly one line ending in 0x0a) that start at line number `fromLine`.
   * Idempotent: lines already stored are checked against the chain and skipped.
   *  - 'ok'           stored (or already stored, byte for byte)
   *  - 'parked'       a gap before `fromLine`: kept on disk, applied when the gap fills
   *  - 'not-a-prefix' some overlapping line differs from what the store holds; nothing was changed
   * Returns only after the write is fsynced (INV-18); throws on ENOSPC and the like, never silently drops.
   */
  append(version: VersionId, segment: number, fromLine: number, lines: Uint8Array[]): Promise<AppendResult> {
    this.checkSegment(segment);
    if (!Number.isSafeInteger(fromLine) || fromLine < 0) throw new StoreError('bad-argument', 'fromLine');
    const key = this.keyOf(version);
    const ls = lines.map(asLine);
    return this.exclusive(() => this.mutate(key, async () => {
      const st = await this.state(version);
      if (fromLine > st.count) {
        if (ls.length === 0) return 'ok';
        await this.park(st, fromLine, ls);
        return 'parked';
      }
      const res = await this.applyLines(st, fromLine, ls);
      if (res === 'ok') await this.drainParked(st);
      return res;
    }));
  }

  /** The overlap check and the write. Lock held. */
  private async applyLines(st: VState, fromLine: number, lines: Buffer[]): Promise<'ok' | 'not-a-prefix'> {
    const overlap = Math.min(lines.length, st.count - fromLine);
    if (overlap > 0) {
      // WHY compare chain values, not bytes: it works for evicted bodies too, and a chain step over the
      // incoming line equals the stored value exactly when the bytes are identical (and everything before them).
      const f = await this.fs.open(nodePath.join(st.dir, 'index.bin'), { create: false });
      try {
        let h: Buffer = fromLine === 0 ? st.seeds.raw : this.mustRec(await f.read(recPos(fromLine - 1), REC)).h;
        for (let done = 0; done < overlap;) {
          const take = Math.min(SCAN_BATCH, overlap - done);
          const buf = await f.read(recPos(fromLine + done), take * REC);
          for (let i = 0; i < take; i++) {
            h = chainStep(h, lines[done + i]);
            if (!h.equals(this.mustRec(buf, i * REC).h)) return 'not-a-prefix';
          }
          done += take;
        }
      } finally { await f.close(); }
    }
    const fresh = lines.slice(overlap);
    if (fresh.length) await this.writeNew(st, fresh);
    return 'ok';
  }

  /** Append lines that continue the head. Body first, fsync, then index, fsync (crash rule 1). */
  private async writeNew(st: VState, fresh: Buffer[]): Promise<void> {
    const recs = Buffer.alloc(fresh.length * REC);
    let h = st.h; let c = st.c; let convCount = st.convCount; let rs: ReplyState = st.rs; let off = st.bodyEnd;
    const sum = { ...st.summary };
    const startLine = st.count;
    const confirmedNow: number[] = [];
    for (let i = 0; i < fresh.length; i++) {
      const line = fresh[i];
      const info: LineInfo = analyseLine(st.meta.runtime, line);
      h = chainStep(h, line);
      if (info.conversation) { c = chainStep(c, line); convCount++; }
      const step = replyEndStep(st.meta.runtime, rs, info, startLine + i, this.replyOpts);
      rs = step.rs;
      if (step.confirmed.length > 1) throw new StoreError('corrupt', 'one line confirmed several reply ends');
      if (step.confirmed.length === 1) confirmedNow.push(step.confirmed[0]);
      let fact = false;
      if (info.title !== undefined && info.title !== sum.title) { sum.title = info.title; fact = true; }
      if (info.model !== undefined && info.model !== sum.model) { sum.model = info.model; fact = true; }
      if (info.cwd !== undefined && sum.cwd === null) { sum.cwd = info.cwd; fact = true; }
      encodeRecord({
        offset: off, len: line.length, conversation: info.conversation, fact, kind: info.kind,
        confirms: step.confirmed.length ? step.confirmed[0] : NONE,
        candN: rs.cand ? rs.cand.n : NONE, candId: rs.cand ? rs.cand.id : null,
        convCount, h, c,
      }, recs, i * REC);
      off += line.length;
    }
    // body
    const body = Buffer.concat(fresh);
    const active = st.chunks.length ? st.chunks[st.chunks.length - 1] : -1;
    let chunkStart = active;
    let created = false;
    if (active < 0 || st.bodyEnd - active >= this.chunkBytes) { chunkStart = st.bodyEnd; created = !st.chunks.includes(chunkStart); }
    const bf = await this.fs.open(this.chunkPath(st, chunkStart), { create: true });
    try { await bf.write(body, st.bodyEnd - chunkStart); await bf.sync(); } finally { await bf.close(); }
    if (created) await this.fs.fsyncDir(st.dir);
    // index
    const xf = await this.fs.open(nodePath.join(st.dir, 'index.bin'), { create: false });
    try { await xf.write(recs, recPos(st.count)); await xf.sync(); } finally { await xf.close(); }
    // acknowledged: now update memory
    if (created) st.chunks.push(chunkStart);
    st.count += fresh.length; st.h = h; st.c = c; st.convCount = convCount; st.bodyEnd = off; st.rs = rs;
    if (st.replyEndsCache) st.replyEndsCache.push(...confirmedNow);
    const changed = sum.title !== st.summary.title || sum.model !== st.summary.model || sum.cwd !== st.summary.cwd;
    st.summary = { ...sum, lastAppendMs: this.now(), lines: st.count };
    // The summary file is only rewritten when a fact in it changed, to keep a live append at one body
    // sync + one index sync. Counts come from the index; arrival time may lag by a few appends after a crash.
    if (changed || st.count - st.summarySavedAt >= SUMMARY_SAVE_EVERY) await this.saveSummary(st);
  }

  // ---- parked appends ------------------------------------------------------------------------
  private async park(st: VState, fromLine: number, lines: Buffer[]): Promise<void> {
    const dir = nodePath.join(st.dir, 'parked');
    await this.fs.mkdir(dir);
    const hsh = createHash('sha256'); for (const l of lines) hsh.update(l);
    const name = `${fromLine.toString().padStart(12, '0')}-${hsh.digest('hex').slice(0, 16)}.park`;
    const path = nodePath.join(dir, name);
    if (await this.fs.exists(path)) return; // the same parked append again
    let held = 0;
    for (const n of await this.fs.readdir(dir)) if (n.endsWith('.park')) held += (await this.fileSize(nodePath.join(dir, n)));
    const data = frameLines(lines);
    if (held + data.length > this.maxParked) throw new StoreError('parked-full', st.key.slice(0, 8));
    await writeFileAtomic(this.fs, path, data);
  }

  /** Apply every parked append the head has now reached; loop until nothing more applies. */
  private async drainParked(st: VState): Promise<void> {
    const dir = nodePath.join(st.dir, 'parked');
    for (;;) {
      const names = (await this.fs.readdir(dir)).filter((n) => n.endsWith('.park')).sort();
      let progressed = false;
      for (const name of names) {
        const from = parseInt(name.slice(0, 12), 10);
        if (from > st.count) break; // sorted by line number: the rest still have a gap
        const path = nodePath.join(dir, name);
        const raw = await this.fs.readFile(path);
        const lines = raw ? unframeLines(raw) : null;
        if (!lines) { await this.moveAway(st, path, name); progressed = true; continue; }
        const res = await this.applyLines(st, from, lines);
        if (res === 'not-a-prefix') await this.moveAway(st, path, name);
        else { await this.fs.unlink(path); await this.fs.fsyncDir(dir); }
        progressed = true;
      }
      if (!progressed) return;
    }
  }

  /** A parked append that is not a prefix is KEPT (retention rule) under rejected/, never deleted. */
  private async moveAway(st: VState, path: string, name: string): Promise<void> {
    const rej = nodePath.join(st.dir, 'rejected');
    await this.fs.mkdir(rej);
    await this.fs.rename(path, nodePath.join(rej, name));
    await this.fs.fsyncDir(rej); await this.fs.fsyncDir(nodePath.join(st.dir, 'parked'));
  }

  // ---- reply ends and summary --------------------------------------------------------------------
  /** Confirmed reply-end line numbers (ascending) and the one unconfirmed candidate, if any. */
  replyEnds(version: VersionId): Promise<{ confirmed: number[]; pending: number | null }> {
    return this.exclusive(async () => {
      const st = await this.state(version);
      if (!st.replyEndsCache) {
        const out: number[] = [];
        const f = await this.fs.open(nodePath.join(st.dir, 'index.bin'), { create: false });
        try {
          for (let n = 0; n < st.count; n += SCAN_BATCH) {
            const take = Math.min(SCAN_BATCH, st.count - n);
            const buf = await f.read(recPos(n), take * REC);
            for (let i = 0; i < take; i++) { const r = this.mustRec(buf, i * REC); if (r.confirms !== NONE) out.push(r.confirms); }
          }
        } finally { await f.close(); }
        st.replyEndsCache = out;
      }
      return { confirmed: [...st.replyEndsCache], pending: st.rs.cand ? st.rs.cand.n : null };
    });
  }

  summary(version: VersionId): Promise<Summary> {
    return this.exclusive(async () => {
      const st = await this.state(version);
      const re = st.replyEndsCache ? st.replyEndsCache.length : await this.countReplyEnds(st);
      return { lines: st.count, conversationLines: st.convCount, replyEnds: re, title: st.summary.title, model: st.summary.model, cwd: st.summary.cwd, lastAppendMs: st.summary.lastAppendMs };
    });
  }
  private async countReplyEnds(st: VState): Promise<number> {
    let n = 0;
    const f = await this.fs.open(nodePath.join(st.dir, 'index.bin'), { create: false });
    try {
      for (let at = 0; at < st.count; at += SCAN_BATCH) {
        const take = Math.min(SCAN_BATCH, st.count - at);
        const buf = await f.read(recPos(at), take * REC);
        for (let i = 0; i < take; i++) if (this.mustRec(buf, i * REC).confirms !== NONE) n++;
      }
    } finally { await f.close(); }
    return n;
  }

  private async saveSummary(st: VState): Promise<void> {
    await writeFileAtomic(this.fs, nodePath.join(st.dir, 'summary.json'), Buffer.from(JSON.stringify({ ...st.summary, lines: st.count })));
    st.summarySavedAt = st.count;
  }

  /** Load the saved summary and replay any lines it has not seen (needs their bodies; stays stale if evicted). */
  private async loadSummary(st: VState): Promise<void> {
    const b = await this.fs.readFile(nodePath.join(st.dir, 'summary.json'));
    let from = 0;
    if (b) {
      try {
        const m = JSON.parse(b.toString());
        st.summary = { title: m.title ?? null, model: m.model ?? null, cwd: m.cwd ?? null, lastAppendMs: m.lastAppendMs ?? null, lines: Number(m.lines) || 0 };
        from = st.summary.lines <= st.count ? st.summary.lines : 0;
      } catch { from = 0; }
    }
    if (from === 0) st.summary = { title: null, model: null, cwd: null, lastAppendMs: st.summary.lastAppendMs, lines: 0 };
    st.summarySavedAt = from;
    if (from >= st.count) { st.summary.lines = st.count; return; }
    // Catch up: only lines flagged as having changed a fact are re-read, so this costs one pass over the
    // index records after `from`, not over the chat's bodies (a cold head() on 300 MB stays milliseconds).
    const sum = { ...st.summary };
    const f = await this.fs.open(nodePath.join(st.dir, 'index.bin'), { create: false });
    try {
      for (let n = from; n < st.count; n += SCAN_BATCH) {
        const take = Math.min(SCAN_BATCH, st.count - n);
        const buf = await f.read(recPos(n), take * REC);
        for (let i = 0; i < take; i++) {
          if (!this.mustRec(buf, i * REC).fact) continue;
          if (n + i < st.evictedLines) continue; // body gone: the fact stays as last saved
          const info = analyseLine(st.meta.runtime, (await this.readRange(st, n + i, n + i + 1))[0]);
          if (info.title !== undefined) sum.title = info.title;
          if (info.model !== undefined) sum.model = info.model;
          if (info.cwd !== undefined && sum.cwd === null) sum.cwd = info.cwd;
        }
      }
    } finally { await f.close(); }
    st.summary = { ...sum, lines: st.count };
  }

  // ---- versions ------------------------------------------------------------------------------------
  listVersions(): Promise<{ version: Buffer; chatId: string; runtime: RuntimeKind; parent: Buffer | null; head: Head }[]> {
    return this.exclusive(async () => {
      const out = [];
      for (const key of (await this.fs.readdir(nodePath.join(this.root, 'versions'))).sort()) {
        if (!/^[0-9a-f]{2,256}$/.test(key) || key.length % 2) continue;
        if (!(await this.fs.exists(nodePath.join(this.vdir(key), 'meta.json')))) continue; // registration never finished
        let st = this.versions.get(key);
        if (!st) { st = await this.load(key); this.versions.set(key, st); }
        out.push({ version: unhex(key), chatId: st.meta.chatId, runtime: st.meta.runtime, parent: st.meta.parent ? unhex(st.meta.parent) : null, head: headOf(st) });
      }
      return out;
    });
  }

  // ---- set-asides ----------------------------------------------------------------------------------
  /**
   * An old host's tail: save lines [fromLine, head) under `takeoverId` and cut the version back to
   * `fromLine`. Order (crash rule 3): tail file durable first, then the cut, so a kill between them
   * loses nothing and a retry finishes the cut. Refuses when those lines have no body here.
   */
  setAsideTail(takeoverId: string, version: VersionId, fromLine: number): Promise<{ lines: number }> {
    if (!TAKEOVER_RE.test(takeoverId)) throw new StoreError('bad-argument', 'takeover id must be hex');
    if (!Number.isSafeInteger(fromLine) || fromLine < 0) throw new StoreError('bad-argument', 'fromLine');
    const key = this.keyOf(version);
    return this.exclusive(() => this.mutate(key, async () => {
      const st = await this.state(version);
      const dir = nodePath.join(st.dir, 'tails');
      const path = nodePath.join(dir, `${takeoverId}.tail`);
      const existing = await this.readTailFile(path);
      if (existing) {
        if (existing.version !== key || existing.fromLine !== fromLine) throw new StoreError('bad-argument', 'takeover id already used for a different tail');
        if (st.count > fromLine) await this.cutTo(st, fromLine);
        return { lines: existing.lines.length };
      }
      if (fromLine < st.evictedLines) throw new StoreError('evicted', 'tail lines have no body here');
      const from = Math.min(fromLine, st.count);
      const lines = from < st.count ? await this.readRange(st, from, st.count) : [];
      const fromRec = await this.stateAtLine(st, from);
      const re = await this.confirmedBetween(st, from, st.count);
      const header = {
        version: key, fromLine: from, fromHash: hex(fromRec.h), fromConv: hex(fromRec.c), headHash: hex(st.h), headConv: hex(st.c),
        replyEnds: re, pending: st.rs.cand && st.rs.cand.n >= from ? st.rs.cand.n : null,
      };
      const hb = Buffer.from(JSON.stringify(header));
      const hl = Buffer.alloc(4); hl.writeUInt32BE(hb.length);
      await this.fs.mkdir(dir);
      await writeFileAtomic(this.fs, path, Buffer.concat([Buffer.from('YCMTAIL1'), hl, hb, frameLines(lines)]));
      if (st.count > from) await this.cutTo(st, from);
      return { lines: lines.length };
    }));
  }

  /** A previously set-aside tail, with the chain values around it, or null. */
  tail(takeoverId: string): Promise<TailRecord | null> {
    if (!TAKEOVER_RE.test(takeoverId)) throw new StoreError('bad-argument', 'takeover id must be hex');
    return this.exclusive(async () => {
      for (const key of await this.fs.readdir(nodePath.join(this.root, 'versions'))) {
        const t = await this.readTailFile(nodePath.join(this.vdir(key), 'tails', `${takeoverId}.tail`));
        if (t) return { version: unhex(t.version), fromLine: t.fromLine, fromHash: t.fromHash, fromConversationHash: t.fromConv, headHash: t.headHash, headConversationHash: t.headConv, lines: t.lines, replyEnds: t.replyEnds, pendingReplyEnd: t.pending };
      }
      return null;
    });
  }

  private async readTailFile(path: string): Promise<{ version: string; fromLine: number; fromHash: string; fromConv: string; headHash: string; headConv: string; lines: Buffer[]; replyEnds: number[]; pending: number | null } | null> {
    const b = await this.fs.readFile(path);
    if (!b) return null;
    if (b.length < 12 || b.subarray(0, 8).toString() !== 'YCMTAIL1') throw new StoreError('corrupt', 'tail file');
    const hl = b.readUInt32BE(8);
    const header = JSON.parse(b.subarray(12, 12 + hl).toString());
    const lines = unframeLines(b.subarray(12 + hl));
    if (!lines) throw new StoreError('corrupt', 'tail file body');
    return { version: header.version, fromLine: header.fromLine, fromHash: header.fromHash, fromConv: header.fromConv, headHash: header.headHash, headConv: header.headConv, lines, replyEnds: header.replyEnds, pending: header.pending };
  }

  private async stateAtLine(st: VState, n: number): Promise<{ h: Buffer; c: Buffer }> {
    if (n === 0) return { h: st.seeds.raw, c: st.seeds.conversation };
    const f = await this.fs.open(nodePath.join(st.dir, 'index.bin'), { create: false });
    try { const r = this.mustRec(await f.read(recPos(n - 1), REC)); return { h: r.h, c: r.c }; } finally { await f.close(); }
  }

  private async confirmedBetween(st: VState, from: number, to: number): Promise<number[]> {
    const out: number[] = [];
    const f = await this.fs.open(nodePath.join(st.dir, 'index.bin'), { create: false });
    try {
      for (let n = from; n < to; n += SCAN_BATCH) {
        const take = Math.min(SCAN_BATCH, to - n);
        const buf = await f.read(recPos(n), take * REC);
        for (let i = 0; i < take; i++) { const r = this.mustRec(buf, i * REC); if (r.confirms !== NONE) out.push(r.confirms); }
      }
    } finally { await f.close(); }
    return out;
  }

  /**
   * The only operation that shortens a version. Index first (the cut is committed by it), then the
   * body is trimmed to match; a kill between the two is repaired by load(). Chunks that start at or
   * after the new end are removed, and the tracker/summary are re-derived.
   */
  private async cutTo(st: VState, n: number): Promise<void> {
    if (n < st.evictedLines) throw new StoreError('evicted', 'cannot cut into evicted lines');
    const f = await this.fs.open(nodePath.join(st.dir, 'index.bin'), { create: false });
    try { await f.truncate(recPos(n)); await f.sync(); } finally { await f.close(); }
    this.versions.delete(st.key);
    const fresh = await this.load(st.key); // load() trims the body to the new index end and re-derives the state
    // The summary may mention facts from the removed tail: recompute it from the kept lines.
    fresh.summary = { title: null, model: null, cwd: null, lastAppendMs: fresh.summary.lastAppendMs, lines: 0 };
    await this.loadSummary(fresh);
    await this.saveSummary(fresh);
    this.versions.set(st.key, fresh);
  }

  /**
   * The copy is damaged (its bytes no longer match its chain): move everything into aside/ (kept, never
   * deleted, retention rule 5.3) and start the version empty so it can be recopied. Parked appends stay.
   * Crash rule 3: an intent file names the target first; load() completes an interrupted move.
   */
  setAsideDamaged(version: VersionId): Promise<{ asideName: string }> {
    const key = this.keyOf(version);
    return this.exclusive(() => this.mutate(key, async () => {
      const dir = this.vdir(key);
      if (!(await this.readMeta(dir))) throw new StoreError('unknown-version', key.slice(0, 8));
      const taken = (await this.fs.readdir(nodePath.join(this.root, 'aside'))).filter((n) => n.startsWith(key + '-')).length;
      const asideName = `${key}-${taken + 1}`;
      await writeFileAtomic(this.fs, nodePath.join(dir, 'aside.intent'), Buffer.from(JSON.stringify({ asideName })));
      this.versions.delete(key);
      await this.finishAside(key, dir);
      return { asideName };
    }));
  }

  private async finishAside(key: string, dir: string): Promise<void> {
    const ib = await this.fs.readFile(nodePath.join(dir, 'aside.intent'));
    if (!ib) return;
    const { asideName } = JSON.parse(ib.toString()) as { asideName: string };
    if (!/^[0-9a-f]+-\d+$/.test(asideName)) throw new StoreError('corrupt', 'aside intent');
    const target = nodePath.join(this.root, 'aside', asideName);
    await this.fs.mkdir(target);
    for (const name of await this.fs.readdir(dir)) {
      if (name === 'index.bin' || name === 'evicted.json' || name === 'summary.json' || /^body-[0-9a-f]{16}\.bin$/.test(name)) {
        await this.fs.rename(nodePath.join(dir, name), nodePath.join(target, name));
      }
    }
    await this.fs.fsyncDir(target); await this.fs.fsyncDir(dir);
    await this.ensureIndex(dir);
    await this.fs.unlink(nodePath.join(dir, 'aside.intent'));
    await this.fs.fsyncDir(dir);
    void key;
  }

  // ---- eviction ------------------------------------------------------------------------------------
  /**
   * Drop line BODIES (never chain values) for lines [0, proof.through). Refuses unless the caller passes
   * a proof that has the right shape AND names the chain value this store holds at `through`: a
   * proof about a different chain state (a stale acknowledgement) is refused. Who counts as a safe
   * holder is policy and lives elsewhere (S9); this only checks the token is well formed.
   */
  evictBody(version: VersionId, proof: EvictionProof): Promise<{ evictedLines: number; freedBytes: number }> {
    const key = this.keyOf(version);
    return this.exclusive(() => this.mutate(key, async () => {
      const st = await this.state(version);
      validateProofShape(proof);
      if (proof.through > st.count) throw new StoreError('bad-proof', 'proof is for lines this store does not have');
      const mine = await (async () => {
        const f = await this.fs.open(nodePath.join(st.dir, 'index.bin'), { create: false });
        try { return hex(this.mustRec(await f.read(recPos(proof.through - 1), REC)).h); } finally { await f.close(); }
      })();
      if (mine !== proof.hash) throw new StoreError('bad-proof', 'proof does not match this store\'s chain (stale or foreign)');
      if (proof.through <= st.evictedLines) return { evictedLines: st.evictedLines, freedBytes: 0 };
      const f = await this.fs.open(nodePath.join(st.dir, 'index.bin'), { create: false });
      let byteAt: number;
      try { const r = this.mustRec(await f.read(recPos(proof.through - 1), REC)); byteAt = r.offset + r.len; } finally { await f.close(); }
      // 1. the marker (atomic) 2. unlink the chunks wholly below it. A kill between leaves chunks that load() removes.
      await writeFileAtomic(this.fs, nodePath.join(st.dir, 'evicted.json'), Buffer.from(JSON.stringify({ lines: proof.through, bytes: byteAt })));
      let freed = 0; const keep: number[] = [];
      for (let i = 0; i < st.chunks.length; i++) {
        const end = i + 1 < st.chunks.length ? st.chunks[i + 1] : st.bodyEnd;
        if (end <= byteAt) { freed += end - st.chunks[i]; await this.fs.unlink(this.chunkPath(st, st.chunks[i])); } else keep.push(st.chunks[i]);
      }
      await this.fs.fsyncDir(st.dir);
      st.chunks = keep; st.evictedLines = proof.through; st.evictedBytes = byteAt;
      return { evictedLines: st.evictedLines, freedBytes: freed };
    }));
  }

  /**
   * Bring evicted bodies back. `lines` must be lines 0.. of this version (at least the evicted prefix);
   * every one is checked against the stored chain before anything is written. Chunk file first, marker
   * last (crash rule 3), so a kill leaves the version still reading as evicted and a retry completes.
   */
  restoreBody(version: VersionId, lines: Uint8Array[]): Promise<{ restoredLines: number }> {
    const key = this.keyOf(version);
    const ls = lines.map(asLine);
    return this.exclusive(() => this.mutate(key, async () => {
      const st = await this.state(version);
      if (st.evictedLines === 0) return { restoredLines: 0 };
      if (ls.length < st.evictedLines) throw new StoreError('bad-argument', 'need every evicted line, from line 0');
      // the restored region is [0, S) where S is where the earliest surviving chunk starts (or the end of data)
      const S = st.chunks.length ? st.chunks[0] : st.bodyEnd;
      const f = await this.fs.open(nodePath.join(st.dir, 'index.bin'), { create: false });
      const parts: Buffer[] = []; let h: Buffer = st.seeds.raw; let n = 0;
      try {
        for (; n < st.count; ) {
          const take = Math.min(SCAN_BATCH, st.count - n);
          const buf = await f.read(recPos(n), take * REC);
          let stop = false;
          for (let i = 0; i < take; i++, n++) {
            const r = this.mustRec(buf, i * REC);
            if (r.offset >= S) { stop = true; break; }
            if (n >= ls.length) throw new StoreError('bad-argument', 'not enough lines to restore');
            h = chainStep(h, ls[n]);
            if (!h.equals(r.h)) throw new StoreError('bad-argument', `line ${n} does not match this store's chain`);
            parts.push(ls[n]);
          }
          if (stop) break;
        }
      } finally { await f.close(); }
      // WHY skip when S is 0: eviction frees whole chunk files only, so the chunk holding the boundary
      // (and every line before it, if it is the first chunk) is still physically there; overwriting it
      // with the empty restored region would destroy the very lines we are restoring.
      if (S > 0) await writeFileAtomic(this.fs, this.chunkPath(st, 0), Buffer.concat(parts));
      await writeFileAtomic(this.fs, nodePath.join(st.dir, 'evicted.json'), Buffer.from(JSON.stringify({ lines: 0, bytes: 0 })));
      const restored = st.evictedLines;
      st.evictedLines = 0; st.evictedBytes = 0;
      if (S > 0 && !st.chunks.includes(0)) st.chunks.unshift(0);
      return { restoredLines: restored };
    }));
  }

  // ---- whole-version check ---------------------------------------------------------------------------
  /** Full scrub: every record's checksum and continuity, and every kept body re-hashed against the chain. */
  verify(version: VersionId): Promise<VerifyReport> {
    return this.exclusive(async () => {
      const st = await this.state(version);
      const f = await this.fs.open(nodePath.join(st.dir, 'index.bin'), { create: false });
      const fail = (line: number, reason: string): VerifyReport => ({ ok: false, lines: st.count, firstBadLine: line, reason });
      try {
        // chain start: the seed, or (bodies evicted) the stored value at the last evicted line
        let h: Buffer = st.seeds.raw; let prev: Rec | null = null;
        for (let n = 0; n < st.count; n += 256) {
          const take = Math.min(256, st.count - n);
          const buf = await f.read(recPos(n), take * REC);
          const lo = Math.max(n, st.evictedLines);
          let bodies: Buffer[] = [];
          if (lo < n + take) { try { bodies = await this.readRange(st, lo, n + take); } catch { return fail(lo, 'body unreadable'); } }
          for (let i = 0; i < take; i++) {
            const r = decodeRecord(buf, i * REC);
            if (!r) return fail(n + i, 'index checksum');
            if (prev && r.offset !== prev.offset + prev.len) return fail(n + i, 'index continuity');
            prev = r;
            const li = n + i;
            if (li < st.evictedLines) { h = r.h; continue; }
            const body = bodies[li - lo];
            if (body.length !== r.len) return fail(li, 'body length');
            h = chainStep(h, body);
            if (!h.equals(r.h)) return fail(li, 'chain mismatch');
          }
        }
        return { ok: true, lines: st.count, firstBadLine: null };
      } finally { await f.close(); }
    });
  }

  // ---- extras ----------------------------------------------------------------------------------------
  private extraPath(h: string): string {
    if (!isHash64(h)) throw new StoreError('bad-argument', 'extra hash must be 64 lowercase hex');
    return nodePath.join(this.root, 'extras', h.slice(0, 2), h);
  }
  hasExtra(hash: string): Promise<boolean> { const p = this.extraPath(hash); return this.exclusive(() => this.fs.exists(p)); }
  readExtra(hash: string): Promise<Buffer | null> { const p = this.extraPath(hash); return this.exclusive(() => this.fs.readFile(p)); }
  /** Store bytes under their SHA-256. A mismatch is refused: a peer cannot file bytes under a hash they do not have. */
  putExtra(hash: string, bytes: Uint8Array): Promise<'stored' | 'present'> {
    const path = this.extraPath(hash);
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new StoreError('bad-argument', 'extra bytes do not match their hash');
    return this.exclusive(async () => {
      if (await this.fs.exists(path)) return 'present';
      await this.fs.mkdir(nodePath.dirname(path));
      await writeFileAtomic(this.fs, path, bytes);
      return 'stored';
    });
  }

  // ---- control log storage (no interpretation) --------------------------------------------------------
  controlLog(chat: string): Promise<ControlEntry[]> { return this.exclusive(() => this.control.log(chat)); }
  parkedControl(chat: string): Promise<ControlEntry[]> { return this.exclusive(() => this.control.parked(chat)); }
  appendControl(entry: ControlEntry): Promise<'ok' | 'parked' | 'duplicate'> {
    return this.exclusive(() => this.control.append(entry));
  }
}

function headOf(st: VState): Head {
  return { lines: st.count, hash: hex(st.h), conversationLines: st.convCount, conversationHash: hex(st.c), evictedLines: st.evictedLines };
}

/** A line must be exactly one line: ends in 0x0a and has no other 0x0a. */
function asLine(l: Uint8Array): Buffer {
  const b = Buffer.from(l.buffer, l.byteOffset, l.byteLength);
  if (b.length === 0 || b[b.length - 1] !== 0x0a || b.indexOf(0x0a) !== b.length - 1) throw new StoreError('bad-line');
  return b;
}

function validateProofShape(p: EvictionProof): void {
  const bad = (m: string) => { throw new StoreError('bad-proof', m); };
  if (!p || typeof p !== 'object' || p.kind !== 'holders-confirmed') bad('kind');
  if (!Array.isArray(p.holders) || p.holders.length < 1 || p.holders.length > 64) bad('holders');
  if (new Set(p.holders).size !== p.holders.length || !p.holders.every((h) => typeof h === 'string' && h.length > 0 && h.length <= 256)) bad('holder ids');
  if (!Number.isSafeInteger(p.through) || p.through < 1) bad('through');
  if (!isHash64(p.hash)) bad('hash');
}
