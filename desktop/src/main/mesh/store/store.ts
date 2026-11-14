// Seam S2: the chat store. On disk under a caller-supplied root; pure library, called by nothing yet.
//
// Layout (all names computed from validated ids, never from peer strings):
//   <root>/FORMAT                      store format marker
//   <root>/LOCK                        exclusive writer lock (lock.ts)
//   <root>/versions/<vhex>/            one directory per version (vhex = hex of the opaque version id)
//       meta.json                      chat id, runtime, parent (opaque), written once, atomically
//       index.bin                      16-byte header (incl. classifier stamp) + one fixed-width record per line (records.ts)
//       body-<startByte>.bin           raw line bytes, chunked; the index says where each line is
//       evicted.json                   {lines, bytes, holders, hash}: bodies of the first `lines` lines were dropped
//       summary.json                   latest title / model / folder
//       scrub.json                     {lines}: high-water mark of the rolling integrity scrub
//       parked/<from>-<hash>.park      appends that arrived with a gap before them
//       rejected/...                   parked appends found NOT to be a prefix (kept, never deleted)
//       tails/<takeoverId>.tail        a host's tail set aside at a takeover
//       torn/  healed/  replaced-index/  bytes the store moved out of the way (kept; see "Recovery" below)
//       damaged.json                   the version failed an integrity check and was quarantined (see below)
//   <root>/aside/<vhex>-<n>/           files of a copy found damaged and recopied (kept, never deleted)
//   <root>/aside/<vhex>-q<n>/          a QUARANTINED copy: index AND bodies moved aside intact, version reports "damaged"
//   <root>/extras/<aa>/<sha256>        extras by content hash
//   <root>/control/<sha256(chat)>/     control-log storage (control.ts)
//
// Crash rules (the reasons for the write order below):
//  1. A line exists exactly when its index record is whole and CRC-correct AND its body bytes are on
//     disk. So an append writes the BODY, fsyncs it, then writes the INDEX records, fsyncs them, and
//     only then returns ("acknowledged"). A kill between the two leaves body bytes past the last record.
//     Never the other way round.
//  2. Whole-file replacements (meta, summary, evicted marker, parked and tail files, extras) are
//     temp-file + fsync + rename + directory fsync; every NEW directory has its parent fsynced (M2).
//  3. Multi-step operations (set aside a damaged copy, set aside a tail, evict, restore) are ordered so
//     that every prefix of their steps is a state open() understands and finishes or ignores.
//  4. After any failed operation the cached in-memory state of that version is dropped, so the next
//     call re-reads the disk and repairs; memory is never trusted after an error.
//
// Recovery (review C1): open() NEVER deletes or truncates an acknowledged line. What it can see, and what it does:
//  - index tail damaged or torn (a bad/partial record region with NO valid record after it): an index write
//    had started, which happens only after the body was fsynced, so the body is whole. The bad index bytes
//    are kept in torn/, the index is cut back to its last good record, and the lines in the body past it are
//    ADOPTED (their records re-derived from the body). Nothing is dropped.
//  - body bytes past the last record and NO index damage: an append died between body fsync and index write.
//    Never acknowledged by construction. Copied to torn/ (kept), then trimmed.
//  - a bad record FOLLOWED by a valid one, a missing/short index, a bad header or a changed classifier
//    stamp: the index is rebuilt from the body, but only if every surviving old record agrees with the
//    rebuilt chain. The old index is kept in replaced-index/.
//  - anything else (body shorter than the index, a missing middle chunk, rebuilt chain disagreeing with a
//    surviving record): the whole version (index AND bodies) is moved to aside/<vhex>-q<n>/, the version
//    reports a typed `damaged` error and serves nothing until setAsideDamaged() clears it.
//
// No file handles are kept open between calls (a user can have 1,400+ chats; handles would exhaust the
// process limit). One in-process lock serialises all calls and lock.ts keeps other processes out.
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { realFs, writeFileAtomic, sweepTemps, mkdirDurable, type Fs } from './fsio';
import { StoreError } from './errors';
import { acquireLock, type StoreLock } from './lock';
import { chainStep, crc32, defaultChainSeeds, hex, isHash64, unhex, type ChainSeedFn, type ChainSeeds, type RuntimeKind } from './chain';
import { CLASSIFIER_VERSION, analyseLine, initialReplyState, replyEndStep, type LineInfo, type ReplyEndOptions, type ReplyState } from './classify';
import { HDR, REC, NONE, decodeRecord, encodeRecord, frameLines, headerOk, headerStamp, indexHeader, recPos, unframeLines, type Rec } from './records';
import { ControlStore, type ControlEntry } from './control';
import { BodyTools, Damaged, NeedsRebuild, chunkPathOf, type BatchState, type SumFacts } from './recovery';

export type VersionId = Uint8Array;

/**
 * Whether a proof is genuine. Supplied by the caller at construction (the replicator, which can check
 * holder signatures); the store cannot. Must resolve to exactly `true`: anything else, or a throw, refuses.
 */
export type ProofVerifier = (proof: EvictionProof, ctx: { version: string; chatId: string; lines: number; hash: string }) => boolean | Promise<boolean>;

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
  /** Cap on the NUMBER of parked append files per version (M4). */
  maxParkedFiles?: number;
  /** An append may start at most this many lines past the head (M4); further is refused as bad-argument. */
  maxParkGap?: number;
  /** One append call may carry at most this many bytes (L8). */
  maxAppendBytes?: number;
  /** One extra may be at most this many bytes (L9). */
  maxExtraBytes?: number;
  /** Cap on parked control entries per chat (M3). */
  maxParkedControl?: number;
  /** Bytes of the rolling integrity scrub run when a version is first loaded; 0 turns it off (H3). */
  scrubOnOpenBytes?: number;
  replyEnd?: ReplyEndOptions;
  /** Decides whether an eviction proof is genuine. Default refuses everything (H4). */
  proofVerifier?: ProofVerifier;
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
  /**
   * Which classifier (and reply-end option) produced the conversation chain and reply ends (M5). Two heads
   * are comparable on `conversationHash` only when their stamps are equal.
   */
  classifierStamp: number;
  /** First line whose body bytes were found not to match the chain, or null (H3). A correct resend heals it. */
  damagedFromLine: number | null;
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

/** One holder's statement "I hold `lines` lines of `version` and my chain value there is `hash`". */
interface ProofAck {
  holder: string;
  version: string;
  lines: number;
  hash: string;
  /** Opaque to the store; checked by the ProofVerifier. */
  signature: string;
}

/**
 * Proof that other devices hold these lines. The store checks the BINDING (this version, this line count,
 * this chain value, distinct holders) and then asks the caller-supplied ProofVerifier; shape and a matching
 * hash alone never suffice (H4: the store's own hashAt would otherwise forge one).
 */
export interface EvictionProof {
  kind: 'holders-confirmed';
  version: string;
  through: number;
  hash: string;
  acks: ProofAck[];
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
export interface ScrubReport { verifiedLines: number; total: number; damagedFromLine: number | null }

const DEFAULT_CHUNK = 16 * 1024 * 1024;
const VERIFY_WINDOW = 4096;
const SCAN_BATCH = 4096;
const MIB = 1024 * 1024;
/** summary.json is also rewritten every this many lines even when no fact changed, so open() never re-scans far. */
const SUMMARY_SAVE_EVERY = 2048;
const TAKEOVER_RE = /^[0-9a-f]{8,128}$/;
const ASIDE_RE = /^[0-9a-f]+-q?\d+$/;
const MAX_TAILS = 1024;
const MAX_REJECTED = 1024;
const LOAD_SCRUB_RECORDS = 8192;
const STEP_SCRUB_RECORDS = 65536;

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
  /** First line whose body failed its chain check (not persisted: the scrub rediscovers it). */
  badLine: number | null;
  /** Rolling scrub high-water mark: lines [0, mark) were verified in this pass. */
  scrubMark: number;
  /** Parked append files: name -> size, kept in memory so a park never rescans the folder (M4). */
  parked: Map<string, number>;
  parkedBytes: number;
}

export class ChatStore {
  private readonly fs: Fs;
  private readonly seedFn: ChainSeedFn;
  private readonly now: () => number;
  private readonly chunkBytes: number;
  private readonly maxParked: number;
  private readonly maxParkedFiles: number;
  private readonly maxParkGap: number;
  private readonly maxAppendBytes: number;
  private readonly maxExtraBytes: number;
  private readonly scrubOnOpen: number;
  private readonly replyOpts: ReplyEndOptions;
  private readonly verifier: ProofVerifier;
  /** Stamp written into every index header (M5): classifier version and the one reply-end option that changes records. */
  private readonly stamp: number;
  private readonly versions = new Map<string, VState>();
  private readonly sweptExtraDirs = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private lock: StoreLock | null = null;
  private readonly control: ControlStore;
  private readonly tools: BodyTools;

  private constructor(readonly root: string, o: StoreOptions) {
    this.fs = o.fs ?? realFs;
    this.seedFn = o.seeds ?? defaultChainSeeds;
    this.now = o.now ?? Date.now;
    this.chunkBytes = o.chunkBytes ?? DEFAULT_CHUNK;
    this.maxParked = o.maxParkedBytes ?? 256 * MIB;
    this.maxParkedFiles = o.maxParkedFiles ?? 2048;
    this.maxParkGap = o.maxParkGap ?? 1_000_000;
    this.maxAppendBytes = o.maxAppendBytes ?? 512 * MIB;
    this.maxExtraBytes = o.maxExtraBytes ?? 256 * MIB;
    this.scrubOnOpen = o.scrubOnOpenBytes ?? 4 * MIB;
    this.replyOpts = o.replyEnd ?? {};
    this.verifier = o.proofVerifier ?? (() => false);
    this.stamp = ((CLASSIFIER_VERSION << 1) | ((this.replyOpts.apiErrorsEndReplies ?? true) ? 1 : 0)) >>> 0;
    this.tools = new BodyTools(this.fs, this.replyOpts);
    this.control = new ControlStore(this.fs, nodePath.join(root, 'control'), { maxParked: o.maxParkedControl });
  }

  /**
   * Open (creating if needed) a store under `root`. Takes the exclusive writer lock (C2): a second open of
   * the same root, from this or any process, fails with `store-locked` until the first closes or dies.
   * Sweeps interrupted temp files; never deletes data.
   */
  static async open(root: string, o: StoreOptions = {}): Promise<ChatStore> {
    const s = new ChatStore(root, o);
    const fs = s.fs;
    await mkdirDurable(fs, root);
    s.lock = await acquireLock(root);
    try {
      const fmt = nodePath.join(root, 'FORMAT');
      const cur = await fs.readFile(fmt);
      if (cur === null) { await writeFileAtomic(fs, fmt, Buffer.from('youcoded-mesh-store 1\n')); }
      else if (cur.toString() !== 'youcoded-mesh-store 1\n') throw new StoreError('corrupt', 'unknown store format');
      for (const d of ['versions', 'aside', 'extras', 'control']) await mkdirDurable(fs, nodePath.join(root, d));
      // WHY safe now: with the lock held no other process has temp files in flight (review C2: this sweep
      // used to delete a second process's in-flight temp files).
      await sweepTemps(fs, root);
    } catch (e) { await s.lock.release().catch(() => undefined); s.lock = null; throw e; }
    return s;
  }

  async close(): Promise<void> {
    await this.chain.catch(() => undefined);
    this.closed = true; this.versions.clear();
    const l = this.lock; this.lock = null;
    if (l) await l.release();
  }

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
  /** WHY (review L2): argument errors must reject like every other failure, never throw synchronously past a `.catch()`. */
  private guard<T>(fn: () => Promise<T>): Promise<T> {
    try { return fn(); } catch (e) { return Promise.reject(e); }
  }

  // ---- paths -------------------------------------------------------------------------------
  private vdir(key: string): string { return nodePath.join(this.root, 'versions', key); }
  private chunkPath(st: { dir: string }, start: number): string { return chunkPathOf(st.dir, start); }
  private ixPath(dir: string): string { return nodePath.join(dir, 'index.bin'); }
  private keyOf(version: VersionId): string {
    if (!(version instanceof Uint8Array) || version.length < 1 || version.length > 128) throw new StoreError('bad-argument', 'version id must be 1..128 bytes');
    return hex(version);
  }
  private checkSegment(segment: number): void { if (segment !== 0) throw new StoreError('bad-argument', 'segment is always 0'); }

  // ---- registering and loading versions -------------------------------------------------------
  /**
   * Make a version known. Idempotent for the same facts; a conflicting re-registration throws.
   * The chat id is needed because the default seed rule uses it (design 5.3); the version id stays opaque.
   */
  registerVersion(version: VersionId, meta: VersionMeta): Promise<void> {
    return this.guard(() => {
      const key = this.keyOf(version);
      if (typeof meta.chatId !== 'string' || meta.chatId.length === 0 || meta.chatId.length > 1024) throw new StoreError('bad-argument', 'chatId');
      if (meta.runtime !== 'claude-code' && meta.runtime !== 'native') throw new StoreError('bad-argument', 'runtime');
      return this.exclusive(() => this.mutate(key, async () => {
        const dir = this.vdir(key);
        const existing = await this.readMeta(dir);
        const parent = meta.parent ? hex(meta.parent) : null;
        if (existing) {
          if (existing.chatId !== meta.chatId || existing.runtime !== meta.runtime || existing.parent !== parent) throw new StoreError('version-conflict', key.slice(0, 8));
          return;
        }
        await mkdirDurable(this.fs, dir);
        const m = { format: 1, chatId: meta.chatId, runtime: meta.runtime, parent, createdMs: this.now() };
        await writeFileAtomic(this.fs, nodePath.join(dir, 'meta.json'), Buffer.from(JSON.stringify(m)));
        await this.ensureIndex(dir);
        await this.fs.fsyncDir(nodePath.join(this.root, 'versions'));
      }));
    });
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
    const p = this.ixPath(dir);
    const f = await this.fs.open(p, { create: true });
    try {
      if ((await f.size()) < HDR) { await f.truncate(0); await f.write(indexHeader(this.stamp), 0); await f.sync(); }
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

  /**
   * Read a version from disk, repairing whatever an interrupted write left behind (crash rules 1-3) and
   * applying the recovery rules in the file header. A repairable index is rebuilt and the load retried; an
   * unrepairable version is quarantined and reported as `damaged`.
   */
  private async load(key: string): Promise<VState> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.loadOnce(key); }
      catch (e) {
        if (e instanceof NeedsRebuild && attempt < 2) {
          try { await this.rebuildIndex(key, e.reason); } catch (e2) { if (e2 instanceof Damaged) await this.quarantine(key, e2.reason); throw e2; }
          continue;
        }
        if (e instanceof NeedsRebuild) throw new StoreError('corrupt', `index could not be repaired: ${e.reason}`);
        if (e instanceof Damaged) await this.quarantine(key, e.reason);
        throw e;
      }
    }
  }

  private async loadOnce(key: string): Promise<VState> {
    const dir = this.vdir(key);
    const meta = await this.readMeta(dir);
    if (!meta) throw new StoreError('unknown-version', key.slice(0, 8));
    await sweepTemps(this.fs, dir);
    await this.finishAside(key, dir); // a set-aside interrupted half way is completed first
    const dmg = await this.readDamaged(dir);
    if (dmg) throw new StoreError('damaged', dmg.asideName);
    const seeds = this.seedFn({ chatId: meta.chatId, version: unhex(key), segment: 0 });
    const ev = await this.readEvicted(dir);

    // 1. Body chunks must be one gapless run that covers the index (a missing middle chunk is damage).
    let layout = await this.tools.checkChunks(dir, ev);
    // 2. The index: repaired in place when only its tail is damaged, otherwise NeedsRebuild / Damaged.
    const ix = await this.settleIndex(dir, ev, layout);
    let { count, last } = ix;
    let bodyEnd = last ? last.offset + last.len : 0;
    if (layout.phys < bodyEnd) throw new Damaged(`body ends at ${layout.phys}, the index claims ${bodyEnd}`);
    if (layout.phys > bodyEnd) {
      // 3. Body bytes the index does not cover.
      if (ix.adopt) {
        // WHY adopt: the index tail was damaged, which means an index write had started, which happens only
        // after the body was fsynced: these lines are whole and were (or were about to be) acknowledged.
        const adopted = await this.adoptSurplus(dir, layout, ev, count, last, seeds, meta.runtime);
        count = adopted.count; last = adopted.last; bodyEnd = adopted.bodyEnd;
      } else {
        // WHY trim: no index write was ever started for these bytes, so they were never acknowledged (crash rule 1).
        // Still kept (torn/), because "never delete" is cheaper than being wrong.
        await this.tools.trimBody(dir, bodyEnd, true);
      }
      layout = await this.tools.checkChunks(dir, ev);
    }
    const chunks = layout.chunks;

    // A line whose body no longer matches its chain value (checked cheaply for the last line only; the rolling scrub does the rest).
    let badLine: number | null = null;
    if (count > ev.lines && last) {
      const prevH = count > 1 ? (await this.recAtDir(dir, count - 2)).h : seeds.raw;
      const cs = chunks.filter((c) => c <= last!.offset).pop();
      if (cs === undefined) throw new Damaged('no body chunk covers the last line');
      const line = await this.readAt(chunkPathOf(dir, cs), last.offset - cs, last.len);
      if (line.length !== last.len || !chainStep(prevH, line).equals(last.h)) badLine = count - 1;
    }

    // Finish an interrupted eviction: chunks wholly below the evicted byte count are gone for good.
    const keep: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const end = i + 1 < chunks.length ? chunks[i + 1] : bodyEnd;
      if (ev.bytes > 0 && end <= ev.bytes) await this.fs.unlink(chunkPathOf(dir, chunks[i]));
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
      badLine, scrubMark: await this.readScrubMark(dir), parked: new Map(), parkedBytes: 0,
    };
    await this.loadSummary(st);
    await this.loadParkedIndex(st);
    if (this.scrubOnOpen > 0) await this.scrubSome(st, this.scrubOnOpen, LOAD_SCRUB_RECORDS);
    await this.drainParked(st);
    return st;
  }

  // ---- index and body recovery ----------------------------------------------------------------------
  /** Examine index.bin. Repairs a damaged TAIL in place (bytes kept); anything else throws NeedsRebuild. */
  private async settleIndex(dir: string, ev: { lines: number; bytes: number }, layout: { chunks: number[]; phys: number }): Promise<{ count: number; last: Rec | null; adopt: boolean }> {
    const ip = this.ixPath(dir);
    const hasBodies = layout.chunks.length > 0 && layout.phys > ev.bytes;
    if (!(await this.fs.exists(ip))) {
      if (!hasBodies && ev.lines === 0) { await this.ensureIndex(dir); return { count: 0, last: null, adopt: false }; }
      throw new NeedsRebuild('index.bin is missing');
    }
    const f = await this.fs.open(ip, { create: false });
    try {
      const size = await f.size();
      if (size < HDR) {
        if (!hasBodies && ev.lines === 0) { await f.truncate(0); await f.write(indexHeader(this.stamp), 0); await f.sync(); return { count: 0, last: null, adopt: false }; }
        throw new NeedsRebuild('index header is missing');
      }
      const hdr = await f.read(0, HDR);
      if (!headerOk(hdr)) throw new NeedsRebuild('index header is damaged');
      if (headerStamp(hdr) !== this.stamp) throw new NeedsRebuild('classifier stamp changed');
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
        await this.tools.keepBytes(dir, 'index-tail', await f.read(recPos(from + good), size - recPos(from + good)));
        count = from + good; await f.truncate(recPos(count)); await f.sync(); adopt = true;
      } else if (partial > 0) {
        await this.tools.keepBytes(dir, 'index-tail', await f.read(recPos(count), partial));
        await f.truncate(recPos(count)); await f.sync(); adopt = true;
      }
      let last: Rec | null = null;
      if (count > 0) { last = decodeRecord(await f.read(recPos(count - 1), REC), 0); if (!last) throw new NeedsRebuild('last index record is unreadable'); }
      return { count, last, adopt };
    } finally { await f.close(); }
  }

  /** Re-derive records for the whole lines in the body past the index end and append them to the index. */
  private async adoptSurplus(dir: string, layout: { chunks: number[]; sizes: number[]; phys: number }, ev: { lines: number; bytes: number }, count: number, last: Rec | null, seeds: ChainSeeds, runtime: RuntimeKind): Promise<{ count: number; last: Rec | null; bodyEnd: number }> {
    const start: BatchState = last
      ? { count, h: last.h, c: last.c, convCount: last.convCount, off: last.offset + last.len, rs: { cand: last.candN === NONE ? null : { n: last.candN, id: last.candId } } }
      : { count: 0, h: Buffer.from(seeds.raw), c: Buffer.from(seeds.conversation), convCount: 0, off: 0, rs: initialReplyState() };
    const f = await this.fs.open(this.ixPath(dir), { create: false });
    let lastRec: Rec | null = last;
    try {
      const out = await this.tools.deriveFromBody(dir, layout, runtime, start, Infinity, async (recs, firstLine, n) => {
        await f.write(recs, recPos(firstLine));
        lastRec = decodeRecord(recs, (n - 1) * REC);
      });
      await f.sync();
      await this.tools.trimBody(dir, out.end, true); // a partial last line (no newline) is kept aside and cut
      return { count: out.state.count, last: lastRec, bodyEnd: out.end };
    } finally { await f.close(); }
  }

  /** Rebuild the index from the body (recovery.ts holds the work); Damaged means the caller quarantines. */
  private async rebuildIndex(key: string, reason: string): Promise<void> {
    const dir = this.vdir(key);
    const meta = await this.readMeta(dir);
    if (!meta) throw new StoreError('unknown-version', key.slice(0, 8));
    const seeds = this.seedFn({ chatId: meta.chatId, version: unhex(key), segment: 0 });
    await this.tools.rebuildIndex(dir, meta.runtime, seeds, await this.readEvicted(dir), this.stamp);
    void reason;
  }

  /** Move the whole version (index AND bodies) to aside/<vhex>-q<n>, mark it damaged, report it. Never deletes. */
  private async quarantine(key: string, reason: string): Promise<never> {
    const dir = this.vdir(key);
    const taken = (await this.fs.readdir(nodePath.join(this.root, 'aside'))).filter((n) => n.startsWith(key + '-')).length;
    const asideName = `${key}-q${taken + 1}`;
    await writeFileAtomic(this.fs, nodePath.join(dir, 'aside.intent'), Buffer.from(JSON.stringify({ asideName, reason })));
    this.versions.delete(key);
    await this.finishAside(key, dir);
    throw new StoreError('damaged', asideName);
  }

  private async readDamaged(dir: string): Promise<{ asideName: string; reason: string } | null> {
    const b = await this.fs.readFile(nodePath.join(dir, 'damaged.json'));
    if (!b) return null;
    try { const m = JSON.parse(b.toString()); if (typeof m.asideName === 'string') return { asideName: m.asideName, reason: String(m.reason ?? '') }; } catch { /* fallthrough */ }
    throw new StoreError('corrupt', 'damaged.json');
  }

  private async readScrubMark(dir: string): Promise<number> {
    const b = await this.fs.readFile(nodePath.join(dir, 'scrub.json'));
    if (!b) return 0;
    try { const m = JSON.parse(b.toString()); if (Number.isSafeInteger(m.lines) && m.lines >= 0) return m.lines; } catch { /* fallthrough */ }
    return 0;
  }

  private async recAtDir(dir: string, n: number): Promise<Rec> {
    const f = await this.fs.open(this.ixPath(dir), { create: false });
    try { return this.mustRec(await f.read(recPos(n), REC)); } finally { await f.close(); }
  }
  private async readAt(path: string, pos: number, len: number): Promise<Buffer> {
    const f = await this.fs.open(path, { create: false });
    try { return await f.read(pos, len); } finally { await f.close(); }
  }

  private async readEvicted(dir: string): Promise<{ lines: number; bytes: number }> {
    const b = await this.fs.readFile(nodePath.join(dir, 'evicted.json'));
    if (!b) return { lines: 0, bytes: 0 };
    try { const m = JSON.parse(b.toString()); if (Number.isSafeInteger(m.lines) && Number.isSafeInteger(m.bytes)) return { lines: m.lines, bytes: m.bytes }; } catch { /* fallthrough */ }
    throw new StoreError('corrupt', 'evicted.json');
  }

  // ---- rolling scrub (H3) ----------------------------------------------------------------------------
  /**
   * Verify a bounded slice of the version, continuing from a persisted high-water mark: index records
   * (checksum, continuity) and, for lines that still have bodies, the body bytes against the chain. A bad
   * index record throws NeedsRebuild (repair from body); a body that does not match its chain value is
   * flagged in `badLine` (a correct resend heals it) and the mark stays at it. When a pass reaches the
   * end the next call starts over, so the whole version is re-checked continuously, `maxBytes` at a time.
   * Detection bound: a damaged byte is found within ceil(version bytes / maxBytes) calls.
   */
  private async scrubSome(st: VState, maxBytes: number, maxRecs: number): Promise<ScrubReport> {
    const report = (): ScrubReport => ({ verifiedLines: st.scrubMark, total: st.count, damagedFromLine: st.badLine });
    if (st.count === 0 || maxBytes <= 0) return report();
    if (st.scrubMark >= st.count) st.scrubMark = 0;
    let n = st.scrubMark; const startN = n;
    let bytes = 0; let recs = 0;
    const f = await this.fs.open(this.ixPath(st.dir), { create: false });
    try {
      let prev: Rec | null = null; let h: Buffer = st.seeds.raw;
      if (n > 0) { prev = decodeRecord(await f.read(recPos(n - 1), REC), 0); if (!prev) throw new NeedsRebuild(`record ${n - 1} fails its checksum`); h = prev.h; }
      while (n < st.count && bytes < maxBytes && recs < maxRecs) {
        const take = Math.min(256, st.count - n, maxRecs - recs);
        const buf = await f.read(recPos(n), take * REC);
        // records first: a bad one must be reported as repairable index damage before any body read trips over it
        for (let i = 0; i < take; i++) if (!decodeRecord(buf, i * REC)) throw new NeedsRebuild(`record ${n + i} fails its checksum`);
        const lo = Math.max(n, st.evictedLines);
        const bodies = lo < n + take ? await this.readRange(st, lo, n + take, false) : [];
        for (let i = 0; i < take; i++) {
          const r = decodeRecord(buf, i * REC)!;
          if (prev && r.offset !== prev.offset + prev.len) throw new NeedsRebuild(`record ${n + i} breaks the byte offsets`);
          if (n + i >= st.evictedLines) {
            const body = bodies[n + i - lo];
            if (body.length !== r.len || !chainStep(h, body).equals(r.h)) {
              st.badLine = st.badLine === null ? n + i : Math.min(st.badLine, n + i);
              st.scrubMark = n + i;
              if (st.scrubMark !== startN) await this.saveScrubMark(st);
              return report();
            }
            bytes += r.len;
          }
          h = r.h; prev = r; recs++;
        }
        n += take;
      }
    } finally { await f.close(); }
    st.scrubMark = n;
    if (n !== startN) await this.saveScrubMark(st);
    return report();
  }
  private async saveScrubMark(st: VState): Promise<void> {
    await writeFileAtomic(this.fs, nodePath.join(st.dir, 'scrub.json'), Buffer.from(JSON.stringify({ lines: st.scrubMark })));
  }

  /** Run one bounded slice of the rolling integrity scrub (the caller schedules this in the background). */
  scrubStep(version: VersionId, opts: { maxBytes?: number } = {}): Promise<ScrubReport> {
    return this.guard(() => {
      const key = this.keyOf(version);
      return this.exclusive(() => this.mutate(key, async () => {
        for (let attempt = 0; ; attempt++) {
          const st = await this.state(version);
          try { return await this.scrubSome(st, opts.maxBytes ?? 32 * MIB, STEP_SCRUB_RECORDS); }
          catch (e) {
            if (!(e instanceof NeedsRebuild) || attempt > 0) throw e;
            this.versions.delete(key);
            try { await this.rebuildIndex(key, e.reason); } catch (e2) { if (e2 instanceof Damaged) await this.quarantine(key, e2.reason); throw e2; }
          }
        }
      }));
    });
  }

  // ---- reading -------------------------------------------------------------------------------
  /** Current head: both chain values and the line count. */
  head(version: VersionId): Promise<Head> {
    return this.exclusive(async () => { const st = await this.state(version); return this.headOf(st); });
  }

  /**
   * Raw chain value after `n` lines (n = 0 is the seed), or null when the store has fewer than n lines
   * (a documented "not there", not an error). Works for evicted lines.
   */
  hashAt(version: VersionId, segment: number, n: number): Promise<string | null> {
    return this.guard(() => {
      this.checkSegment(segment);
      return this.exclusive(async () => {
        const st = await this.state(version);
        if (!Number.isSafeInteger(n) || n < 0 || n > st.count) return null;
        if (n === 0) return hex(st.seeds.raw);
        const f = await this.fs.open(this.ixPath(st.dir), { create: false });
        try { return hex(this.mustRec(await f.read(recPos(n - 1), REC)).h); } finally { await f.close(); }
      });
    });
  }

  /**
   * Lines [from, to), as raw bytes with their newlines, each checked against the chain (H3); `evicted` when
   * any of them has no body here. A range past the head is refused (L4), not silently clamped.
   */
  read(version: VersionId, segment: number, from: number, to: number): Promise<Buffer[] | 'evicted'> {
    return this.guard(() => {
      this.checkSegment(segment);
      return this.exclusive(async () => {
        const st = await this.state(version);
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new StoreError('bad-argument', 'range');
        if (to > st.count) throw new StoreError('bad-argument', `range ends at ${to}, the head is ${st.count}`);
        if (from >= to) return [];
        if (from < st.evictedLines) return 'evicted';
        return this.readRange(st, from, to, true);
      });
    });
  }

  /** Conversation lines (user/assistant) from `fromLine`, in batches: the "search turns" and page readers' shape. */
  async *conversationLines(version: VersionId, fromLine = 0, batchLines = 512): AsyncGenerator<{ line: number; bytes: Buffer }[]> {
    if (!Number.isSafeInteger(fromLine) || fromLine < 0) throw new StoreError('bad-argument', 'fromLine');
    if (!Number.isSafeInteger(batchLines) || batchLines < 1) throw new StoreError('bad-argument', 'batchLines');
    let cursor = fromLine;
    for (;;) {
      const batch = await this.exclusive(async () => {
        const st = await this.state(version);
        const out: { line: number; bytes: Buffer }[] = [];
        const f = await this.fs.open(this.ixPath(st.dir), { create: false });
        let n = cursor;
        try {
          while (n < st.count && out.length < batchLines) {
            const take = Math.min(SCAN_BATCH, st.count - n);
            const buf = await f.read(recPos(n), take * REC);
            for (let i = 0; i < take && out.length < batchLines; i++, n++) {
              const r = this.mustRec(buf, i * REC);
              if (!r.conversation) continue;
              if (n < st.evictedLines) throw new StoreError('evicted', `line ${n}`);
              out.push({ line: n, bytes: (await this.readRange(st, n, n + 1, true))[0] });
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

  /**
   * Read lines [from, end) from body chunks. Caller holds the lock and has checked eviction. With `verify`
   * each line's bytes are hashed against the chain value in its index record (one SHA-256 over bytes already
   * read; the only extra I/O is the one record before `from`): a mismatch flags the line and throws `corrupt`.
   */
  private async readRange(st: VState, from: number, end: number, verify: boolean): Promise<Buffer[]> {
    const f = await this.fs.open(this.ixPath(st.dir), { create: false });
    let recs: Buffer; const pre = verify && from > 0 ? 1 : 0;
    try { recs = await f.read(recPos(from - pre), (end - from + pre) * REC); } finally { await f.close(); }
    if (recs.length < (end - from + pre) * REC) throw new StoreError('corrupt', 'index shorter than expected');
    let h: Buffer = pre ? this.mustRec(recs, 0).h : st.seeds.raw;
    const rec = (k: number): Rec => this.mustRec(recs, (k + pre) * REC);
    const out: Buffer[] = [];
    let i = 0;
    while (i < end - from) {
      const first = rec(i);
      const cstart = this.chunkFor(st, first.offset);
      // gather as many consecutive lines as live in this chunk, read them with one call
      let j = i; let spanEnd = first.offset;
      const nextChunk = st.chunks.find((c) => c > cstart);
      while (j < end - from) {
        const r = rec(j);
        if (nextChunk !== undefined && r.offset >= nextChunk) break;
        spanEnd = r.offset + r.len; j++;
      }
      const cf = await this.fs.open(this.chunkPath(st, cstart), { create: false });
      try {
        const bytes = await cf.read(first.offset - cstart, spanEnd - first.offset);
        if (bytes.length !== spanEnd - first.offset) throw new StoreError('corrupt', 'body shorter than index');
        for (let k = i; k < j; k++) {
          const r = rec(k);
          const line = bytes.subarray(r.offset - first.offset, r.offset - first.offset + r.len);
          if (verify) {
            h = chainStep(h, line);
            if (!h.equals(r.h)) {
              st.badLine = st.badLine === null ? from + k : Math.min(st.badLine, from + k);
              throw new StoreError('corrupt', `line ${from + k}: body bytes do not match the chain`);
            }
          }
          out.push(line);
        }
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
   * Idempotent: lines already stored are checked against the chain AND against the stored bytes; a body
   * found damaged is healed from the correct resend (bad bytes kept aside), never answered `ok` and left.
   *  - 'ok'           stored (or already stored, byte for byte)
   *  - 'parked'       a gap before `fromLine`: kept on disk, applied when the gap fills
   *  - 'not-a-prefix' some overlapping line differs from what the store holds; nothing was changed
   * Returns only after the write is fsynced (INV-18); throws on ENOSPC and the like, never silently drops.
   */
  append(version: VersionId, segment: number, fromLine: number, lines: Uint8Array[]): Promise<AppendResult> {
    return this.guard(() => {
      this.checkSegment(segment);
      if (!Number.isSafeInteger(fromLine) || fromLine < 0) throw new StoreError('bad-argument', 'fromLine');
      const key = this.keyOf(version);
      const ls = lines.map(asLine);
      let total = 0; for (const l of ls) total += l.length;
      if (total > this.maxAppendBytes) throw new StoreError('limit', `one append of ${total} bytes exceeds the ${this.maxAppendBytes} byte cap`);
      return this.exclusive(() => this.mutate(key, async () => {
        const st = await this.state(version);
        if (fromLine > st.count) {
          if (ls.length === 0) return 'ok';
          if (fromLine - st.count > this.maxParkGap) throw new StoreError('bad-argument', `fromLine is ${fromLine - st.count} lines past the head (cap ${this.maxParkGap})`);
          await this.park(st, fromLine, ls);
          return 'parked';
        }
        const res = await this.applyLines(st, fromLine, ls);
        if (res === 'ok') await this.drainParked(st);
        return res;
      }));
    });
  }

  /** The overlap check and the write. Lock held. */
  private async applyLines(st: VState, fromLine: number, lines: Buffer[]): Promise<'ok' | 'not-a-prefix'> {
    const overlap = Math.min(lines.length, st.count - fromLine);
    if (overlap > 0) {
      // WHY compare chain values first: it works for evicted bodies too, and a chain step over the
      // incoming line equals the stored value exactly when the bytes are identical (and everything before them).
      const f = await this.fs.open(this.ixPath(st.dir), { create: false });
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
      // WHY then compare the stored BYTES (H3): the chain check above only proves the index agrees with the
      // incoming line. If the body bytes on disk differ, answering `ok` would leave the damage in place.
      await this.healBodies(st, fromLine, lines.slice(0, overlap));
    }
    const fresh = lines.slice(overlap);
    if (fresh.length) await this.writeNew(st, fresh);
    return 'ok';
  }

  /** For lines [from, from+good.length) that still have bodies: where the stored bytes differ from the (chain-correct) incoming ones, keep the bad bytes aside and overwrite in place. */
  private async healBodies(st: VState, from: number, good: Buffer[]): Promise<void> {
    const lo = Math.max(from, st.evictedLines);
    for (let a = lo; a < from + good.length;) {
      const b = Math.min(from + good.length, a + 256);
      const stored = await this.readRange(st, a, b, false);
      for (let k = 0; k < stored.length; k++) {
        const want = good[a - from + k];
        if (stored[k].equals(want)) continue;
        const line = a + k;
        const f = await this.fs.open(this.ixPath(st.dir), { create: false });
        let r: Rec; try { r = this.mustRec(await f.read(recPos(line), REC)); } finally { await f.close(); }
        if (want.length !== r.len) throw new StoreError('corrupt', `line ${line}: the index length disagrees with the chain-correct bytes`);
        const hd = nodePath.join(st.dir, 'healed');
        await mkdirDurable(this.fs, hd);
        const n = (await this.fs.readdir(hd)).length + 1;
        await writeFileAtomic(this.fs, nodePath.join(hd, `line-${line}-${n}.bin`), stored[k]);
        const cs = this.chunkFor(st, r.offset);
        const cf = await this.fs.open(this.chunkPath(st, cs), { create: false });
        try { await cf.write(want, r.offset - cs); await cf.sync(); } finally { await cf.close(); }
        if (st.badLine === line) st.badLine = null;
        if (st.scrubMark > line) st.scrubMark = line; // re-check from the healed line
      }
      a = b;
    }
  }

  /** Append lines that continue the head. Body first, fsync, then index, fsync (crash rule 1). */
  private async writeNew(st: VState, fresh: Buffer[]): Promise<void> {
    const bs: BatchState = { count: st.count, h: st.h, c: st.c, convCount: st.convCount, off: st.bodyEnd, rs: st.rs };
    const sum: SumFacts & { lastAppendMs?: number } = { title: st.summary.title, model: st.summary.model, cwd: st.summary.cwd };
    const { recs, confirmed: confirmedNow } = this.tools.encodeBatch(st.meta.runtime, bs, fresh, sum);
    // body
    const body = Buffer.concat(fresh);
    const active = st.chunks.length ? st.chunks[st.chunks.length - 1] : -1;
    let chunkStart = active;
    let created = false;
    if (active < 0 || st.bodyEnd - active >= this.chunkBytes) { chunkStart = st.bodyEnd; created = !st.chunks.includes(chunkStart); }
    const bf = await this.fs.open(this.chunkPath(st, chunkStart), { create: true });
    try {
      // WHY (defence in depth, C2): another writer moved the files since this state was read. The lock
      // should make that impossible; if it ever happens, refuse rather than overwrite its lines.
      if ((await bf.size()) !== st.bodyEnd - chunkStart) throw new StoreError('corrupt', 'body file changed under this store (another writer?)');
      await bf.write(body, st.bodyEnd - chunkStart); await bf.sync();
    } finally { await bf.close(); }
    if (created) await this.fs.fsyncDir(st.dir);
    // index
    const xf = await this.fs.open(this.ixPath(st.dir), { create: false });
    try {
      if ((await xf.size()) !== recPos(st.count)) throw new StoreError('corrupt', 'index file changed under this store (another writer?)');
      await xf.write(recs, recPos(st.count)); await xf.sync();
    } finally { await xf.close(); }
    // acknowledged: now update memory
    if (created) st.chunks.push(chunkStart);
    st.count = bs.count; st.h = bs.h; st.c = bs.c; st.convCount = bs.convCount; st.bodyEnd = bs.off; st.rs = bs.rs;
    if (st.replyEndsCache) st.replyEndsCache.push(...confirmedNow);
    const changed = sum.title !== st.summary.title || sum.model !== st.summary.model || sum.cwd !== st.summary.cwd;
    st.summary = { title: sum.title, model: sum.model, cwd: sum.cwd, lastAppendMs: this.now(), lines: st.count };
    // The summary file is only rewritten when a fact in it changed, to keep a live append at one body
    // sync + one index sync. Counts come from the index; arrival time may lag by a few appends after a crash.
    if (changed || st.count - st.summarySavedAt >= SUMMARY_SAVE_EVERY) await this.saveSummary(st);
  }

  // ---- parked appends ------------------------------------------------------------------------
  private async loadParkedIndex(st: VState): Promise<void> {
    const dir = nodePath.join(st.dir, 'parked');
    st.parked.clear(); st.parkedBytes = 0;
    for (const n of await this.fs.readdir(dir)) {
      if (!n.endsWith('.park')) continue;
      const size = await this.tools.fileSize(nodePath.join(dir, n));
      st.parked.set(n, size); st.parkedBytes += size;
    }
  }

  /**
   * M4: duplicate check, file count and byte total come from memory (built once at load), so a park costs
   * one file write instead of a rescan of every parked file; the count and byte caps make the total bounded.
   */
  private async park(st: VState, fromLine: number, lines: Buffer[]): Promise<void> {
    const hsh = createHash('sha256'); for (const l of lines) hsh.update(l);
    // 16 digits: names sort by line number up to 2^53, past the 12 digits that broke the old ordering
    const name = `${fromLine.toString().padStart(16, '0')}-${hsh.digest('hex').slice(0, 16)}.park`;
    if (st.parked.has(name)) return; // the same parked append again
    const data = frameLines(lines);
    if (st.parked.size >= this.maxParkedFiles) throw new StoreError('parked-full', `${st.key.slice(0, 8)}: ${st.parked.size} parked files`);
    if (st.parkedBytes + data.length > this.maxParked) throw new StoreError('parked-full', st.key.slice(0, 8));
    const dir = nodePath.join(st.dir, 'parked');
    await mkdirDurable(this.fs, dir);
    await writeFileAtomic(this.fs, nodePath.join(dir, name), data);
    st.parked.set(name, data.length); st.parkedBytes += data.length;
  }

  private forgetParked(st: VState, name: string): void {
    const size = st.parked.get(name);
    if (size !== undefined) { st.parked.delete(name); st.parkedBytes -= size; }
  }

  /** Apply every parked append the head has now reached; loop until nothing more applies. */
  private async drainParked(st: VState): Promise<void> {
    const dir = nodePath.join(st.dir, 'parked');
    const skip = new Set<string>();
    for (;;) {
      const names = [...st.parked.keys()].filter((n) => !skip.has(n)).sort();
      let progressed = false;
      for (const name of names) {
        const from = parseInt(name.slice(0, 16), 10);
        if (from > st.count) break; // sorted by line number: the rest still have a gap
        const path = nodePath.join(dir, name);
        const raw = await this.fs.readFile(path);
        const lines = raw ? unframeLines(raw) : null;
        if (!lines) { if (await this.moveAway(st, path, name)) progressed = true; else skip.add(name); continue; }
        const res = await this.applyLines(st, from, lines);
        if (res === 'not-a-prefix') { if (await this.moveAway(st, path, name)) progressed = true; else skip.add(name); }
        else { await this.fs.unlink(path); await this.fs.fsyncDir(dir); this.forgetParked(st, name); progressed = true; }
      }
      if (!progressed) return;
    }
  }

  /**
   * A parked append that is not a prefix is KEPT (retention rule) under rejected/, never deleted. At the
   * cap it stays in parked/ instead (where it counts toward the parked cap and so surfaces loudly).
   */
  private async moveAway(st: VState, path: string, name: string): Promise<boolean> {
    const rej = nodePath.join(st.dir, 'rejected');
    await mkdirDurable(this.fs, rej);
    if ((await this.fs.readdir(rej)).length >= MAX_REJECTED) return false;
    await this.fs.rename(path, nodePath.join(rej, name));
    await this.fs.fsyncDir(rej); await this.fs.fsyncDir(nodePath.join(st.dir, 'parked'));
    this.forgetParked(st, name);
    return true;
  }

  // ---- reply ends and summary --------------------------------------------------------------------
  /** Confirmed reply-end line numbers (ascending) and the one unconfirmed candidate, if any. */
  replyEnds(version: VersionId): Promise<{ confirmed: number[]; pending: number | null }> {
    return this.exclusive(async () => {
      const st = await this.state(version);
      if (!st.replyEndsCache) {
        const out: number[] = [];
        const f = await this.fs.open(this.ixPath(st.dir), { create: false });
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
    const f = await this.fs.open(this.ixPath(st.dir), { create: false });
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
    const f = await this.fs.open(this.ixPath(st.dir), { create: false });
    try {
      for (let n = from; n < st.count; n += SCAN_BATCH) {
        const take = Math.min(SCAN_BATCH, st.count - n);
        const buf = await f.read(recPos(n), take * REC);
        for (let i = 0; i < take; i++) {
          if (!this.mustRec(buf, i * REC).fact) continue;
          if (n + i < st.evictedLines) continue; // body gone: the fact stays as last saved
          // WHY unverified read: a summary is a convenience; one damaged line must not make the whole version unloadable
          const info = analyseLine(st.meta.runtime, (await this.readRange(st, n + i, n + i + 1, false))[0]);
          if (info.title !== undefined) sum.title = info.title;
          if (info.model !== undefined) sum.model = info.model;
          if (info.cwd !== undefined && sum.cwd === null) sum.cwd = info.cwd;
        }
      }
    } finally { await f.close(); }
    st.summary = { ...sum, lines: st.count };
  }

  // ---- versions ------------------------------------------------------------------------------------
  listVersions(): Promise<{ version: Buffer; chatId: string; runtime: RuntimeKind; parent: Buffer | null; head: Head | null; damaged: string | null }[]> {
    return this.exclusive(async () => {
      const out = [];
      for (const key of (await this.fs.readdir(nodePath.join(this.root, 'versions'))).sort()) {
        if (!/^[0-9a-f]{2,256}$/.test(key) || key.length % 2) continue;
        const meta = await this.readMetaIfPresent(this.vdir(key)); // registration may never have finished
        if (!meta) continue;
        const dmg = await this.readDamaged(this.vdir(key));
        const base = { version: unhex(key), chatId: meta.chatId, runtime: meta.runtime, parent: meta.parent ? unhex(meta.parent) : null };
        if (dmg) { out.push({ ...base, head: null, damaged: dmg.asideName }); continue; }
        try {
          let st = this.versions.get(key);
          if (!st) { st = await this.load(key); this.versions.set(key, st); }
          out.push({ ...base, head: this.headOf(st), damaged: null });
        } catch (e) {
          if (e instanceof StoreError && e.code === 'damaged') { out.push({ ...base, head: null, damaged: (await this.readDamaged(this.vdir(key)))?.asideName ?? 'damaged' }); continue; }
          throw e;
        }
      }
      return out;
    });
  }
  private async readMetaIfPresent(dir: string) { return (await this.fs.exists(nodePath.join(dir, 'meta.json'))) ? this.readMeta(dir) : null; }

  // ---- set-asides ----------------------------------------------------------------------------------
  /**
   * An old host's tail: save lines [fromLine, head) under `takeoverId` and cut the version back to
   * `fromLine`. Order (crash rule 3): tail file durable first, then the cut, so a kill between them
   * loses nothing and a retry finishes the cut. Refuses when those lines have no body here.
   * IDEMPOTENT per takeover id (H1): a retry returns the original result and cuts only when the version
   * still holds exactly the saved tail at the saved place; lines appended since are never cut.
   */
  setAsideTail(takeoverId: string, version: VersionId, fromLine: number): Promise<{ lines: number }> {
    return this.guard(() => {
      if (!TAKEOVER_RE.test(takeoverId)) throw new StoreError('bad-argument', 'takeover id must be hex');
      if (!Number.isSafeInteger(fromLine) || fromLine < 0) throw new StoreError('bad-argument', 'fromLine');
      const key = this.keyOf(version);
      return this.exclusive(() => this.mutate(key, async () => {
        const st = await this.state(version);
        const dir = nodePath.join(st.dir, 'tails');
        const path = nodePath.join(dir, `${takeoverId}.tail`);
        const existing = await this.readTailFile(path);
        if (existing) {
          const L = existing.lines.length;
          // a request past the head was clamped to the head the first time: the same request again is the same retry
          const same = existing.fromLine === fromLine || (L === 0 && fromLine > existing.fromLine);
          if (existing.version !== key || !same) throw new StoreError('bad-argument', 'takeover id already used for a different tail');
          if (L > 0 && st.count === existing.fromLine + L && hex((await this.stateAtLine(st, st.count)).h) === existing.headHash) await this.cutTo(st, existing.fromLine);
          return { lines: L };
        }
        if (fromLine < st.evictedLines) throw new StoreError('evicted', 'tail lines have no body here');
        if ((await this.fs.readdir(dir)).filter((n) => n.endsWith('.tail')).length >= MAX_TAILS) throw new StoreError('limit', 'too many set-aside tails for this version');
        const from = Math.min(fromLine, st.count);
        const lines = from < st.count ? await this.readRange(st, from, st.count, true) : [];
        const fromRec = await this.stateAtLine(st, from);
        const re = await this.confirmedBetween(st, from, st.count);
        const header = {
          version: key, fromLine: from, fromHash: hex(fromRec.h), fromConv: hex(fromRec.c), headHash: hex(st.h), headConv: hex(st.c),
          replyEnds: re, pending: st.rs.cand && st.rs.cand.n >= from ? st.rs.cand.n : null,
        };
        const hb = Buffer.from(JSON.stringify(header));
        const hl = Buffer.alloc(4); hl.writeUInt32BE(hb.length);
        const hc = Buffer.alloc(4); hc.writeUInt32BE(crc32(hb));
        await mkdirDurable(this.fs, dir);
        await writeFileAtomic(this.fs, path, Buffer.concat([Buffer.from('YCMTAIL2'), hl, hb, hc, frameLines(lines)]));
        if (st.count > from) await this.cutTo(st, from);
        return { lines: lines.length };
      }));
    });
  }

  /** A previously set-aside tail, with the chain values around it, or null. Pass `version` to look in one version only. */
  tail(takeoverId: string, version?: VersionId): Promise<TailRecord | null> {
    return this.guard(() => {
      if (!TAKEOVER_RE.test(takeoverId)) throw new StoreError('bad-argument', 'takeover id must be hex');
      const only = version ? this.keyOf(version) : null;
      return this.exclusive(async () => {
        const keys = only ? [only] : await this.fs.readdir(nodePath.join(this.root, 'versions'));
        for (const key of keys) {
          const t = await this.readTailFile(nodePath.join(this.vdir(key), 'tails', `${takeoverId}.tail`));
          if (t) return { version: unhex(t.version), fromLine: t.fromLine, fromHash: t.fromHash, fromConversationHash: t.fromConv, headHash: t.headHash, headConversationHash: t.headConv, lines: t.lines, replyEnds: t.replyEnds, pendingReplyEnd: t.pending };
        }
        return null;
      });
    });
  }

  private async readTailFile(path: string): Promise<{ version: string; fromLine: number; fromHash: string; fromConv: string; headHash: string; headConv: string; lines: Buffer[]; replyEnds: number[]; pending: number | null } | null> {
    const b = await this.fs.readFile(path);
    if (!b) return null;
    if (b.length < 16 || b.subarray(0, 8).toString() !== 'YCMTAIL2') throw new StoreError('corrupt', 'tail file');
    const hl = b.readUInt32BE(8);
    // WHY a checksum on the header (L6): the framed lines carry their own, the JSON header did not
    if (12 + hl + 4 > b.length || crc32(b.subarray(12, 12 + hl)) !== b.readUInt32BE(12 + hl)) throw new StoreError('corrupt', 'tail file header');
    let header: any;
    try { header = JSON.parse(b.subarray(12, 12 + hl).toString()); } catch { throw new StoreError('corrupt', 'tail file header'); }
    const lines = unframeLines(b.subarray(12 + hl + 4));
    if (!lines) throw new StoreError('corrupt', 'tail file body');
    return { version: header.version, fromLine: header.fromLine, fromHash: header.fromHash, fromConv: header.fromConv, headHash: header.headHash, headConv: header.headConv, lines, replyEnds: header.replyEnds, pending: header.pending };
  }

  private async stateAtLine(st: VState, n: number): Promise<{ h: Buffer; c: Buffer }> {
    if (n === 0) return { h: st.seeds.raw, c: st.seeds.conversation };
    const f = await this.fs.open(this.ixPath(st.dir), { create: false });
    try { const r = this.mustRec(await f.read(recPos(n - 1), REC)); return { h: r.h, c: r.c }; } finally { await f.close(); }
  }

  private async confirmedBetween(st: VState, from: number, to: number): Promise<number[]> {
    const out: number[] = [];
    const f = await this.fs.open(this.ixPath(st.dir), { create: false });
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
   * The only operation that shortens a version, and only after the cut lines are safe in a tail file. Index
   * first (the cut is committed by it), then the body is trimmed to match here, explicitly: open() would
   * otherwise treat the body as unindexed lines. A kill between the two is harmless: the next open re-adopts
   * the lines (the tail file still holds them) and the retried set-aside cuts again (H1 rule).
   */
  private async cutTo(st: VState, n: number): Promise<void> {
    if (n < st.evictedLines) throw new StoreError('evicted', 'cannot cut into evicted lines');
    const lastKept = n === 0 ? null : this.mustRec(await this.readAt(this.ixPath(st.dir), recPos(n - 1), REC));
    const endOff = lastKept ? lastKept.offset + lastKept.len : 0;
    const f = await this.fs.open(this.ixPath(st.dir), { create: false });
    try { await f.truncate(recPos(n)); await f.sync(); } finally { await f.close(); }
    await this.tools.trimBody(st.dir, endOff, false);
    this.versions.delete(st.key);
    const fresh = await this.load(st.key); // re-derives the state
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
   * For a version the store already quarantined (`damaged`), this only clears the marker: the quarantined
   * copy is already aside, intact.
   */
  setAsideDamaged(version: VersionId): Promise<{ asideName: string }> {
    return this.guard(() => {
      const key = this.keyOf(version);
      return this.exclusive(() => this.mutate(key, async () => {
        const dir = this.vdir(key);
        if (!(await this.readMeta(dir))) throw new StoreError('unknown-version', key.slice(0, 8));
        const dmg = await this.readDamaged(dir);
        if (dmg) {
          await this.fs.unlink(nodePath.join(dir, 'damaged.json')); await this.fs.fsyncDir(dir);
          this.versions.delete(key);
          await this.ensureIndex(dir);
          return { asideName: dmg.asideName };
        }
        const taken = (await this.fs.readdir(nodePath.join(this.root, 'aside'))).filter((n) => n.startsWith(key + '-')).length;
        const asideName = `${key}-${taken + 1}`;
        await writeFileAtomic(this.fs, nodePath.join(dir, 'aside.intent'), Buffer.from(JSON.stringify({ asideName })));
        this.versions.delete(key);
        await this.finishAside(key, dir);
        return { asideName };
      }));
    });
  }

  private async finishAside(key: string, dir: string): Promise<void> {
    const ib = await this.fs.readFile(nodePath.join(dir, 'aside.intent'));
    if (!ib) return;
    const { asideName, reason } = JSON.parse(ib.toString()) as { asideName: string; reason?: string };
    if (!ASIDE_RE.test(asideName)) throw new StoreError('corrupt', 'aside intent');
    const target = nodePath.join(this.root, 'aside', asideName);
    await mkdirDurable(this.fs, target);
    for (const name of await this.fs.readdir(dir)) {
      if (name === 'index.bin' || name === 'index.rebuild' || name === 'evicted.json' || name === 'summary.json' || name === 'scrub.json' || /^body-[0-9a-f]{16}\.bin$/.test(name)) {
        // WHY never overwrite (H2): a rename over an existing aside file would destroy the very copy being kept.
        // The aside copy already holds this file, so the move happened before; what is in the version
        // folder is newer and stays where it is.
        if (await this.fs.exists(nodePath.join(target, name))) continue;
        await this.fs.rename(nodePath.join(dir, name), nodePath.join(target, name));
      }
    }
    await this.fs.fsyncDir(target); await this.fs.fsyncDir(dir);
    if (reason !== undefined) await writeFileAtomic(this.fs, nodePath.join(dir, 'damaged.json'), Buffer.from(JSON.stringify({ asideName, reason, atMs: this.now() })));
    // WHY the intent goes BEFORE the fresh index (H2): once the moves are durable the intent has done its job.
    // If it outlived the fresh index, a rerun would move that new empty index over the aside copy's index.
    await this.fs.unlink(nodePath.join(dir, 'aside.intent'));
    await this.fs.fsyncDir(dir);
    if (reason === undefined) await this.ensureIndex(dir);
    void key;
  }

  // ---- eviction ------------------------------------------------------------------------------------
  /**
   * Drop line BODIES (never chain values) for lines [0, proof.through). The caller-supplied ProofVerifier
   * decides whether the proof is genuine (default: refuses everything). The store additionally checks the
   * proof is BOUND to this version, this line count and the chain value it holds, that holders are distinct,
   * and that the bytes it is about to drop still match the chain; who counts as a safe holder is policy (S9).
   * The holders that confirmed are recorded in evicted.json.
   */
  evictBody(version: VersionId, proof: EvictionProof): Promise<{ evictedLines: number; freedBytes: number }> {
    return this.guard(() => {
      const key = this.keyOf(version);
      return this.exclusive(() => this.mutate(key, async () => {
        const st = await this.state(version);
        validateProofShape(proof);
        if (proof.version !== key) throw new StoreError('bad-proof', 'proof is for another version');
        for (const a of proof.acks) {
          if (a.version !== key) throw new StoreError('bad-proof', `acknowledgement by ${a.holder} is for another version`);
          if (a.lines !== proof.through) throw new StoreError('bad-proof', `acknowledgement by ${a.holder} is for another line count`);
          if (a.hash !== proof.hash) throw new StoreError('bad-proof', `acknowledgement by ${a.holder} is for another chain value`);
        }
        if (proof.through > st.count) throw new StoreError('bad-proof', 'proof is for lines this store does not have');
        const mine = hex((await this.stateAtLine(st, proof.through)).h);
        if (mine !== proof.hash) throw new StoreError('bad-proof', 'proof does not match this store\'s chain (stale or foreign)');
        let genuine = false;
        try { genuine = (await this.verifier(proof, { version: key, chatId: st.meta.chatId, lines: proof.through, hash: proof.hash })) === true; } catch { genuine = false; }
        if (!genuine) throw new StoreError('bad-proof', 'proof was not accepted by the verifier');
        if (proof.through <= st.evictedLines) return { evictedLines: st.evictedLines, freedBytes: 0 };
        // never drop the last good copy of bytes that no longer match their chain value
        const bad = await this.firstBadBody(st, st.evictedLines, proof.through);
        if (bad !== null) throw new StoreError('corrupt', `line ${bad}: body bytes do not match the chain; not evicting`);
        const f = await this.fs.open(this.ixPath(st.dir), { create: false });
        let byteAt: number;
        try { const r = this.mustRec(await f.read(recPos(proof.through - 1), REC)); byteAt = r.offset + r.len; } finally { await f.close(); }
        // 1. the marker (atomic) 2. unlink the chunks wholly below it. A kill between leaves chunks that load() removes.
        await writeFileAtomic(this.fs, nodePath.join(st.dir, 'evicted.json'), Buffer.from(JSON.stringify({ lines: proof.through, bytes: byteAt, hash: proof.hash, holders: proof.acks.map((a) => a.holder), atMs: this.now() })));
        let freed = 0; const keep: number[] = [];
        for (let i = 0; i < st.chunks.length; i++) {
          const end = i + 1 < st.chunks.length ? st.chunks[i + 1] : st.bodyEnd;
          if (end <= byteAt) { freed += end - st.chunks[i]; await this.fs.unlink(this.chunkPath(st, st.chunks[i])); } else keep.push(st.chunks[i]);
        }
        await this.fs.fsyncDir(st.dir);
        st.chunks = keep; st.evictedLines = proof.through; st.evictedBytes = byteAt;
        return { evictedLines: st.evictedLines, freedBytes: freed };
      }));
    });
  }

  /** First line in [from, to) whose body bytes do not hash to its recorded chain value, or null. */
  private async firstBadBody(st: VState, from: number, to: number): Promise<number | null> {
    let h: Buffer = from === 0 ? st.seeds.raw : (await this.stateAtLine(st, from)).h;
    const f = await this.fs.open(this.ixPath(st.dir), { create: false });
    try {
      for (let n = from; n < to; n += 256) {
        const take = Math.min(256, to - n);
        const buf = await f.read(recPos(n), take * REC);
        const bodies = await this.readRange(st, n, n + take, false);
        for (let i = 0; i < take; i++) {
          const r = this.mustRec(buf, i * REC);
          h = chainStep(h, bodies[i]);
          if (bodies[i].length !== r.len || !h.equals(r.h)) return n + i;
        }
      }
    } finally { await f.close(); }
    return null;
  }

  /**
   * Bring evicted bodies back. `lines` must be lines 0.. of this version (at least the evicted prefix);
   * EVERY evicted line is checked against the stored chain before anything is written (also when the first
   * chunk survived: L5). Chunk file first, marker last (crash rule 3), so a kill leaves the version still
   * reading as evicted and a retry completes.
   */
  restoreBody(version: VersionId, lines: Uint8Array[]): Promise<{ restoredLines: number }> {
    return this.guard(() => {
      const key = this.keyOf(version);
      const ls = lines.map(asLine);
      return this.exclusive(() => this.mutate(key, async () => {
        const st = await this.state(version);
        if (st.evictedLines === 0) return { restoredLines: 0 };
        if (ls.length < st.evictedLines) throw new StoreError('bad-argument', 'need every evicted line, from line 0');
        // the restored region is [0, S) where S is where the earliest surviving chunk starts (or the end of data)
        const S = st.chunks.length ? st.chunks[0] : st.bodyEnd;
        const f = await this.fs.open(this.ixPath(st.dir), { create: false });
        const parts: Buffer[] = []; let h: Buffer = st.seeds.raw;
        try {
          for (let n = 0; n < st.evictedLines;) {
            const take = Math.min(SCAN_BATCH, st.evictedLines - n);
            const buf = await f.read(recPos(n), take * REC);
            for (let i = 0; i < take; i++, n++) {
              const r = this.mustRec(buf, i * REC);
              h = chainStep(h, ls[n]);
              if (!h.equals(r.h)) throw new StoreError('bad-argument', `line ${n} does not match this store's chain`);
              if (r.offset < S) parts.push(ls[n]);
            }
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
    });
  }

  // ---- whole-version check ---------------------------------------------------------------------------
  /** Full scrub: every record's checksum and continuity, the index file's exact size, the chunk files, and every kept body re-hashed against the chain. */
  verify(version: VersionId): Promise<VerifyReport> {
    return this.exclusive(async () => {
      const st = await this.state(version);
      const f = await this.fs.open(this.ixPath(st.dir), { create: false });
      const fail = (line: number, reason: string): VerifyReport => ({ ok: false, lines: st.count, firstBadLine: line, reason });
      try {
        if ((await f.size()) !== recPos(st.count)) return fail(st.count, 'index size');
        try {
          const lay = await this.tools.checkChunks(st.dir, { lines: st.evictedLines, bytes: st.evictedBytes });
          if (lay.phys !== st.bodyEnd) return fail(st.count, 'body end');
        } catch (e) { return fail(0, e instanceof Damaged ? e.reason : 'body chunks'); }
        // chain start: the seed, or (bodies evicted) the stored value at the last evicted line
        let h: Buffer = st.seeds.raw; let prev: Rec | null = null;
        for (let n = 0; n < st.count; n += 256) {
          const take = Math.min(256, st.count - n);
          const buf = await f.read(recPos(n), take * REC);
          const lo = Math.max(n, st.evictedLines);
          let bodies: Buffer[] = [];
          if (lo < n + take) { try { bodies = await this.readRange(st, lo, n + take, false); } catch { return fail(lo, 'body unreadable'); } }
          for (let i = 0; i < take; i++) {
            const r = decodeRecord(buf, i * REC);
            if (!r) return fail(n + i, 'index checksum');
            if (prev && r.offset !== prev.offset + prev.len) return fail(n + i, 'index continuity');
            prev = r;
            const li = n + i;
            if (li < st.evictedLines) { h = r.h; continue; }
            const body = bodies[li - lo];
            if (!body || body.length !== r.len) return fail(li, 'body length');
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
  hasExtra(hash: string): Promise<boolean> { return this.guard(() => { const p = this.extraPath(hash); return this.exclusive(() => this.fs.exists(p)); }); }
  readExtra(hash: string): Promise<Buffer | null> { return this.guard(() => { const p = this.extraPath(hash); return this.exclusive(() => this.fs.readFile(p)); }); }
  /** Store bytes under their SHA-256. A mismatch is refused: a peer cannot file bytes under a hash they do not have. */
  putExtra(hash: string, bytes: Uint8Array): Promise<'stored' | 'present'> {
    return this.guard(() => {
      const path = this.extraPath(hash);
      if (bytes.length > this.maxExtraBytes) throw new StoreError('limit', `extra of ${bytes.length} bytes exceeds the ${this.maxExtraBytes} byte cap`);
      if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new StoreError('bad-argument', 'extra bytes do not match their hash');
      return this.exclusive(async () => {
        if (await this.fs.exists(path)) return 'present';
        const dir = nodePath.dirname(path);
        await mkdirDurable(this.fs, dir);
        // interrupted writes into an extras folder are swept the first time it is written to in this run (L9)
        if (!this.sweptExtraDirs.has(dir)) { await sweepTemps(this.fs, dir); this.sweptExtraDirs.add(dir); }
        await writeFileAtomic(this.fs, path, bytes);
        return 'stored';
      });
    });
  }

  // ---- control log storage (no interpretation) --------------------------------------------------------
  controlLog(chat: string): Promise<ControlEntry[]> { return this.exclusive(() => this.control.log(chat)); }
  parkedControl(chat: string): Promise<ControlEntry[]> { return this.exclusive(() => this.control.parked(chat)); }
  appendControl(entry: ControlEntry): Promise<'ok' | 'parked' | 'duplicate'> {
    return this.exclusive(() => this.control.append(entry));
  }
  /** A control log reported `damaged`: move its file aside (kept) so the log starts empty and can be refetched. Returns the kept file's name. */
  quarantineControl(chat: string): Promise<string> { return this.exclusive(() => this.control.quarantine(chat)); }

  private headOf(st: VState): Head {
    return { lines: st.count, hash: hex(st.h), conversationLines: st.convCount, conversationHash: hex(st.c), evictedLines: st.evictedLines, classifierStamp: this.stamp, damagedFromLine: st.badLine };
  }
}

/** A line must be exactly one line: ends in 0x0a and has no other 0x0a. */
function asLine(l: Uint8Array): Buffer {
  const b = Buffer.from(l.buffer, l.byteOffset, l.byteLength);
  if (b.length === 0 || b[b.length - 1] !== 0x0a || b.indexOf(0x0a) !== b.length - 1) throw new StoreError('bad-line');
  return b;
}

function validateProofShape(p: EvictionProof): void {
  const bad = (m: string): never => { throw new StoreError('bad-proof', m); };
  if (!p || typeof p !== 'object' || p.kind !== 'holders-confirmed') bad('kind');
  if (typeof p.version !== 'string') bad('version');
  if (!Number.isSafeInteger(p.through) || p.through < 1) bad('through');
  if (!isHash64(p.hash)) bad('hash');
  if (!Array.isArray(p.acks) || p.acks.length < 1 || p.acks.length > 64) bad('acknowledgements');
  const holders = new Set<string>();
  for (const a of p.acks) {
    if (!a || typeof a !== 'object' || typeof a.holder !== 'string' || a.holder.length < 1 || a.holder.length > 256) bad('holder id');
    if (typeof a.version !== 'string' || !Number.isSafeInteger(a.lines) || !isHash64(a.hash) || typeof a.signature !== 'string') bad('acknowledgement fields');
    if (holders.has(a.holder)) bad('the same holder twice');
    holders.add(a.holder);
  }
}
