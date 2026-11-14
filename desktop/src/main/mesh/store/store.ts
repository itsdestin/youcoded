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
//       scrub.json                     {lines, passEnd}: high-water mark of the rolling integrity scrub and where this pass ends (N3)
//       checkpoint.bin                 count + chain values vouched for, in a file of its own, checksummed (checkpoint.ts, N1)
//       partial.json                   a rebuild set lines [fromLine, fromLine+lost) aside (N7); cleared when a resend fills them
//       stale-conv.json                the evicted lines' conversation chain was written by another classifier (N4)
//       parked/<from>-<hash>.park      appends that arrived with a gap before them
//       rejected/...                   parked appends found NOT to be a prefix (kept, never deleted)
//       tails/<takeoverId>.tail        a host's tail set aside at a takeover
//       torn/  healed/  replaced-index/  bytes the store moved out of the way (kept; see "Recovery" below)
//       damaged.json                   the version failed an integrity check and was quarantined (see below)
//   <root>/aside/<vhex>-<n>/           files of a copy found damaged and recopied (kept, never deleted)
//   <root>/aside/<vhex>-q<n>/          a QUARANTINED copy: index AND bodies moved aside intact, version reports "damaged"
//   <root>/extras/<aa>/<sha256>        extras by content hash; <root>/extras-bad/ holds extras that failed their hash (N6)
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
//    stamp: the index is rebuilt from the body, and the body is ALWAYS verified against chain values stored
//    independently of the index being rebuilt (N1): the valid old records (header or not), the separate
//    checkpoint file, and a previous index in replaced-index/. The old index is kept in replaced-index/.
//    A rebuild is refused ("damaged") rather than accepted when nothing vouches for the body.
//  - a rebuild whose body disagrees with a VALID old record at line k (a rotted byte, N7): lines before the
//    last verified one stay served, the rest is set aside intact (torn/ + replaced-index/), `damagedFromLine`
//    names it, and a correct resend from a peer heals it. The version is never taken out of service for it.
//  - anything else (body shorter than the index or the checkpoint, a missing middle chunk, a checkpoint that
//    cannot be reconciled, nothing vouching for the body): the whole version (index AND bodies) is moved to
//    aside/<vhex>-q<n>/, the version reports a typed `damaged` error and serves nothing until
//    setAsideDamaged() clears it.
// A full disk (N5) is one typed `disk-full` refusal; reads never write anything that can fail (scrub mark,
// checkpoint and summary writes are best effort), and a failed append cuts back what it added.
//
// No file handles are kept open between calls (a user can have 1,400+ chats; handles would exhaust the
// process limit). One in-process lock serialises all calls and lock.ts keeps other processes out.
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { realFs, writeFileAtomic, sweepTemps, mkdirDurable, type Fs } from './fsio';
import { StoreError } from './errors';
import { acquireLock, type StoreLock } from './lock';
import { readCheckpoint, writeCheckpoint, CHECKPOINT_FILE } from './checkpoint';
import { Extras, bytesUnder } from './extras';
import { asLine, decodeTailFile, encodeTailFile, isDiskFull, validateProofShape, type TailFile } from './storeutil';
import { chainStep, crc32, defaultChainSeeds, hex, isHash64, unhex, type ChainSeedFn, type ChainSeeds, type RuntimeKind } from './chain';
import { CLASSIFIER_VERSION, analyseLine, initialReplyState, replyEndStep, type LineInfo, type ReplyEndOptions, type ReplyState } from './classify';
import { HDR, REC, NONE, decodeRecord, encodeRecord, frameLines, headerOk, headerStamp, indexHeader, recPos, unframeLines, type Rec } from './records';
import { ControlStore, type ControlDamage, type ControlEntry } from './control';
import type { AppendResult, EvictionProof, Head, ProofVerifier, ScrubReport, StoreOptions, Summary, TailRecord, VerifyReport, VersionId, VersionMeta } from './types';
import { BodyTools, Damaged, NeedsRebuild, PARTIAL_FILE, STALE_CONV_FILE, chunkPathOf, type BatchState, type RebuildResult, type SumFacts } from './recovery';

export type { VersionId, ProofVerifier, StoreOptions, VersionMeta, Head, AppendResult, Summary, EvictionProof, TailRecord, VerifyReport, ScrubReport } from './types';

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
const MAX_REJECTED_BYTES = 256 * MIB;
const DEFAULT_CHECKPOINT_EVERY = 32;
const DEFAULT_MAX_EXTRAS = 4 * 1024 * MIB;
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
  /** Head count when the current scrub pass began: the pass ends at this line however much the chat grew meanwhile (N3). */
  passEnd: number;
  /** Line count the checkpoint file vouches for (0 when none). */
  ckptCount: number;
  /** Surplus body bytes could not be copied to torn/ because the disk was full: the next write retries before appending (N5). */
  trimDeferred: boolean;
  /** The empty version's index file could not be created (disk full): the first append creates it (N5). */
  indexNeedsInit: boolean;
  /** A rebuild set lines [fromLine, fromLine+lost) aside because their bodies did not match the chain (N7). */
  partial: { fromLine: number; lost: number } | null;
  /** stale-conv.json exists (N4). */
  staleConv: boolean;
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
  private readonly ckptEvery: number;
  private readonly maxExtrasBytes: number;
  private readonly maxRejectedBytes: number;
  private readonly extras: Extras;
  private readonly verifier: ProofVerifier;
  /** Stamp written into every index header (M5): classifier version and the one reply-end option that changes records. */
  private readonly stamp: number;
  private readonly versions = new Map<string, VState>();
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
    this.ckptEvery = Math.max(1, o.checkpointEvery ?? DEFAULT_CHECKPOINT_EVERY);
    this.maxExtrasBytes = o.maxExtrasBytes ?? DEFAULT_MAX_EXTRAS;
    this.maxRejectedBytes = o.maxRejectedBytes ?? MAX_REJECTED_BYTES;
    this.verifier = o.proofVerifier ?? (() => false);
    this.stamp = ((CLASSIFIER_VERSION << 1) | ((this.replyOpts.apiErrorsEndReplies ?? true) ? 1 : 0)) >>> 0;
    this.tools = new BodyTools(this.fs, this.replyOpts);
    this.extras = new Extras(this.fs, this.tools, root, this.maxExtraBytes, this.maxExtrasBytes);
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
    s.lock = await acquireLock(root, { breakLockToken: o.breakLockToken });
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
    // WHY at close (N1): the checkpoint is written every few lines, so up to ckptEvery-1 acknowledged lines are not in it
    // yet; closing brings it level, which makes the next rebuild's verification as strong as possible.
    for (const st of this.versions.values()) {
      if (st.count > 0 && st.count !== st.ckptCount) await this.saveCheckpoint(st).catch((e) => { if (!isDiskFull(e)) throw e; });
    }
    this.closed = true; this.versions.clear();
    const l = this.lock; this.lock = null;
    if (l) await l.release();
  }

  // ---- locking -----------------------------------------------------------------------------
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new StoreError('closed'));
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    // WHY (N5): a full disk is one typed refusal everywhere, never a raw ENOSPC from whichever write hit it
    return run.catch((e) => { throw isDiskFull(e) ? new StoreError('disk-full', String((e as Error).message)) : e; });
  }
  /** Run a mutation; on any failure drop cached state of the version so the next call repairs from disk. */
  private async mutate<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
    try {
      // WHY (N9d): the lock file can be deleted under a live holder; refuse the write instead of racing a second writer
      await this.lock?.assertHeld();
      return await fn();
    }
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
          continue; // a split rebuild leaves the cut-off bytes as surplus, which the next loadOnce moves to torn/
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
    const staleConv = await this.fs.exists(nodePath.join(dir, STALE_CONV_FILE));
    // N4: the evicted bodies are back, so the conversation chain can be recomputed now
    if (staleConv && ev.lines === 0) throw new NeedsRebuild('evicted bodies are back: recompute the conversation chain');

    // 1. Body chunks must be one gapless run that covers the index (a missing middle chunk is damage).
    let layout = await this.tools.checkChunks(dir, ev);
    // 2. The index: repaired in place when only its tail is damaged, otherwise NeedsRebuild / Damaged.
    const ix = await this.tools.settleIndex(dir, ev, layout, this.stamp);
    let { count, last } = ix;
    let trimDeferred = false;
    // N1: the checkpoint is a statement the index must agree with. An index SHORTER than it lost acknowledged records: the body
    // still has the lines (checked below), so re-derive the index from it, verified against the checkpoint, BEFORE the surplus
    // body bytes are moved aside as "never acknowledged".
    const ck = await readCheckpoint(this.fs, dir);
    if (ck && ck.count > count && !ix.adopt) throw new NeedsRebuild('the index is shorter than the checkpoint');
    let bodyEnd = last ? last.offset + last.len : 0;
    if (layout.phys < bodyEnd) throw new Damaged(`body ends at ${layout.phys}, the index claims ${bodyEnd}`);
    if (layout.phys > bodyEnd) {
      // 3. Body bytes the index does not cover.
      if (ix.adopt) {
        // WHY adopt: the index tail was damaged, which means an index write had started, which happens only
        // after the body was fsynced: these lines are whole and were (or were about to be) acknowledged.
        const adopted = await this.tools.adoptSurplus(dir, layout, count, last, seeds, meta.runtime);
        count = adopted.count; last = adopted.last; bodyEnd = adopted.bodyEnd;
      } else {
        // WHY trim: no index write was ever started for these bytes, so they were never acknowledged (crash rule 1).
        // Still kept (torn/), because "never delete" is cheaper than being wrong.
        try { await this.tools.trimBody(dir, bodyEnd, true); }
        catch (e) {
          // WHY (N5): copying the surplus to torn/ needs space. On a full disk keep serving what is indexed (the surplus is
          // never read) and retry the trim before the next write; never make a healthy version unreadable because the disk is full.
          if (!isDiskFull(e)) throw e;
          trimDeferred = true;
        }
      }
      layout = await this.tools.checkChunks(dir, ev);
    }
    // surplus chunk files (only possible while a trim is deferred) are not part of the version
    const chunks = trimDeferred ? layout.chunks.filter((c) => c === 0 || c < bodyEnd) : layout.chunks;

    // N1: a record that disagrees with the checkpoint means the index (not the body) is what is wrong
    if (ck) {
      if (ck.count > count) throw new Damaged(`the checkpoint vouches for ${ck.count} lines but the index and body hold ${count}`);
      if (ck.count > 0 && !(await this.recAtDir(dir, ck.count - 1)).h.equals(ck.h)) throw new NeedsRebuild('the index disagrees with the checkpoint');
    }
    const partialRaw = await this.readPartial(dir);

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
      badLine, scrubMark: 0, passEnd: 0, ckptCount: ck ? ck.count : 0, trimDeferred, indexNeedsInit: !!ix.needsInit,
      partial: partialRaw, staleConv,
      parked: new Map(), parkedBytes: 0,
    };
    const mark = await this.readScrubMark(dir);
    st.passEnd = Math.min(mark.passEnd, count); st.scrubMark = Math.min(mark.lines, st.passEnd);
    await this.loadSummary(st);
    await this.loadParkedIndex(st);
    if (this.scrubOnOpen > 0) await this.scrubSome(st, this.scrubOnOpen, LOAD_SCRUB_RECORDS);
    await this.drainParked(st);
    return st;
  }

  // ---- index and body recovery (recovery.ts: settleIndex, adoptSurplus, rebuildIndex) --------------------------------
  /** Rebuild the index from the body (recovery.ts holds the work); Damaged means the caller quarantines. */
  private async rebuildIndex(key: string, reason: string): Promise<RebuildResult> {
    const dir = this.vdir(key);
    const meta = await this.readMeta(dir);
    if (!meta) throw new StoreError('unknown-version', key.slice(0, 8));
    const seeds = this.seedFn({ chatId: meta.chatId, version: unhex(key), segment: 0 });
    const convStale = await this.fs.exists(nodePath.join(dir, STALE_CONV_FILE));
    const res = await this.tools.rebuildIndex(dir, meta.runtime, seeds, await this.readEvicted(dir), this.stamp, { convStale });
    void reason;
    return res;
  }

  /** partial.json: lines a rebuild set aside because their bodies did not match the chain (N7). */
  private async readPartial(dir: string): Promise<{ fromLine: number; lost: number } | null> {
    const b = await this.fs.readFile(nodePath.join(dir, PARTIAL_FILE));
    if (!b) return null;
    try { const m = JSON.parse(b.toString()); if (Number.isSafeInteger(m.fromLine) && Number.isSafeInteger(m.lost) && m.lost >= 0) return { fromLine: m.fromLine, lost: m.lost }; } catch { /* fallthrough */ }
    return null;   // a damaged marker only loses the "damaged" flag; the lines themselves were already cut
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

  private async readScrubMark(dir: string): Promise<{ lines: number; passEnd: number }> {
    const b = await this.fs.readFile(nodePath.join(dir, 'scrub.json'));
    if (!b) return { lines: 0, passEnd: 0 };
    try {
      const m = JSON.parse(b.toString());
      if (Number.isSafeInteger(m.lines) && m.lines >= 0) return { lines: m.lines, passEnd: Number.isSafeInteger(m.passEnd) && m.passEnd >= m.lines ? m.passEnd : m.lines };
    } catch { /* fallthrough */ }
    return { lines: 0, passEnd: 0 };
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

  // ---- rolling scrub (H3, N3) ------------------------------------------------------------------------
  /**
   * Verify a bounded slice of the version, continuing from a persisted high-water mark: index records
   * (checksum, continuity) and, for lines that still have bodies, the body bytes against the chain. A bad
   * index record throws NeedsRebuild (repair from body); a body that does not match its chain value is
   * flagged in `badLine` (a correct resend heals it) and the mark stays at it.
   *
   * DETECTION BOUND (N3, stated and tested): a pass covers lines [0, passEnd) where passEnd is the line count
   * when the pass STARTED. A pass ends when the mark reaches passEnd, and the next call starts a new one at line
   * 0 whatever was appended meanwhile (before this fix a chat that gained a line between calls never wrapped, so
   * old rot was never found). So a byte that exists when a pass starts is verified within
   * max(ceil(bytes / maxBytes), ceil(lines / maxRecs)) calls, and ANY byte within one pass of being written plus
   * one pass: a chat that keeps growing is covered as fast as one that does not.
   */
  private async scrubSome(st: VState, maxBytes: number, maxRecs: number): Promise<ScrubReport> {
    const report = (): ScrubReport => ({ verifiedLines: st.scrubMark, total: st.count, damagedFromLine: this.damagedFrom(st) });
    if (st.count === 0 || maxBytes <= 0) return report();
    if (st.passEnd > st.count) st.passEnd = st.count;                // the version got shorter (a cut)
    if (st.scrubMark > st.passEnd) st.scrubMark = st.passEnd;
    if (st.scrubMark >= st.passEnd) { st.scrubMark = 0; st.passEnd = st.count; }   // pass finished: start the next
    const end = st.passEnd;
    let n = st.scrubMark; const startN = n;
    let bytes = 0; let recs = 0;
    const f = await this.fs.open(this.ixPath(st.dir), { create: false });
    try {
      let prev: Rec | null = null; let h: Buffer = st.seeds.raw;
      if (n > 0) { prev = decodeRecord(await f.read(recPos(n - 1), REC), 0); if (!prev) throw new NeedsRebuild(`record ${n - 1} fails its checksum`); h = prev.h; }
      while (n < end && bytes < maxBytes && recs < maxRecs) {
        const take = Math.min(256, end - n, maxRecs - recs);
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
    if (n !== startN || st.passEnd !== end) await this.saveScrubMark(st);
    return report();
  }
  /**
   * WHY best effort (N5): the mark is a convenience (losing it only repeats work), and a READ must never fail because the
   * disk is full. Only a full disk is swallowed; every other error still surfaces.
   */
  private async saveScrubMark(st: VState): Promise<void> {
    try { await writeFileAtomic(this.fs, nodePath.join(st.dir, 'scrub.json'), Buffer.from(JSON.stringify({ lines: st.scrubMark, passEnd: st.passEnd }))); }
    catch (e) { if (!isDiskFull(e)) throw e; }
  }

  /** Vouch for the current head in checkpoint.bin (N1). Always after the index it describes is durable. */
  private async saveCheckpoint(st: VState): Promise<void> {
    // a stamp that never equals the real one while the conversation chain is stale: its `c` must not be compared
    const stamp = st.staleConv ? (this.stamp ^ 0x80000000) >>> 0 : this.stamp;
    await writeCheckpoint(this.fs, st.dir, { count: st.count, stamp, h: st.h, c: st.c });
    st.ckptCount = st.count;
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
    // N5: surplus bytes left by an earlier failed write on a full disk are moved aside first (still full: refused, typed)
    if (st.trimDeferred) { await this.tools.trimBody(st.dir, st.bodyEnd, true); st.trimDeferred = false; }
    if (st.indexNeedsInit) { await this.ensureIndex(st.dir); st.indexNeedsInit = false; }
    const bs: BatchState = { count: st.count, h: st.h, c: st.c, convCount: st.convCount, off: st.bodyEnd, rs: st.rs };
    const sum: SumFacts & { lastAppendMs?: number } = { title: st.summary.title, model: st.summary.model, cwd: st.summary.cwd };
    const { recs, confirmed: confirmedNow } = this.tools.encodeBatch(st.meta.runtime, bs, fresh, sum);
    // body
    const body = Buffer.concat(fresh);
    const active = st.chunks.length ? st.chunks[st.chunks.length - 1] : -1;
    let chunkStart = active;
    let created = false;
    if (active < 0 || st.bodyEnd - active >= this.chunkBytes) { chunkStart = st.bodyEnd; created = !st.chunks.includes(chunkStart); }
    try {
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
    } catch (e) {
      // WHY a rollback (N5): a refused write (full disk) must leave exactly what was there. Cutting the bytes this call added
      // needs no free space. Skipped for the "another writer" error, where the bytes are not ours to cut, and best effort
      // otherwise (after it fails, the next load treats the leftover as surplus like after any kill).
      if (!(e instanceof StoreError && e.code === 'corrupt')) await this.rollbackAppend(st, chunkStart, created).catch(() => undefined);
      throw e;
    }
    // acknowledged: now update memory
    if (created) st.chunks.push(chunkStart);
    st.count = bs.count; st.h = bs.h; st.c = bs.c; st.convCount = bs.convCount; st.bodyEnd = bs.off; st.rs = bs.rs;
    if (st.replyEndsCache) st.replyEndsCache.push(...confirmedNow);
    const changed = sum.title !== st.summary.title || sum.model !== st.summary.model || sum.cwd !== st.summary.cwd;
    st.summary = { title: sum.title, model: sum.model, cwd: sum.cwd, lastAppendMs: this.now(), lines: st.count };
    // From here the lines ARE durable. A full disk for the small side files is not a failed append (they are rebuilt on load).
    try {
      // The summary file is only rewritten when a fact in it changed, to keep a live append at one body
      // sync + one index sync. Counts come from the index; arrival time may lag by a few appends after a crash.
      if (changed || st.count - st.summarySavedAt >= SUMMARY_SAVE_EVERY) await this.saveSummary(st);
      // N1: vouch for the head every few lines (every line while the version is short), AFTER the index is durable
      if (st.count - st.ckptCount >= this.ckptEvery || st.count <= this.ckptEvery) await this.saveCheckpoint(st);
      if (st.partial && st.count >= st.partial.fromLine + st.partial.lost) { await this.fs.unlink(nodePath.join(st.dir, PARTIAL_FILE)); await this.fs.fsyncDir(st.dir); st.partial = null; }
    } catch (e) { if (!isDiskFull(e)) throw e; }
  }

  /** Cut back what a failed append added: the body to where it was, the index to its old record count. */
  private async rollbackAppend(st: VState, chunkStart: number, created: boolean): Promise<void> {
    const path = this.chunkPath(st, chunkStart);
    if (await this.fs.exists(path)) {
      const bf = await this.fs.open(path, { create: false });
      try { if ((await bf.size()) > st.bodyEnd - chunkStart) { await bf.truncate(st.bodyEnd - chunkStart); await bf.sync(); } } finally { await bf.close(); }
      if (created && st.bodyEnd - chunkStart === 0) { await this.fs.unlink(path); await this.fs.fsyncDir(st.dir); }
    }
    const xf = await this.fs.open(this.ixPath(st.dir), { create: false });
    try { if ((await xf.size()) > recPos(st.count)) { await xf.truncate(recPos(st.count)); await xf.sync(); } } finally { await xf.close(); }
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
   * Parked appends waiting for a gap to fill (N12a). A `parked` answer is provisional: the lines are safe on disk but are not part of
   * the version until the head reaches `fromLine`. One far past the head occupies the cap until the gap fills; the caller owns the
   * timeout and can give up on it with `releaseParked`.
   */
  parkedList(version: VersionId): Promise<{ name: string; fromLine: number; bytes: number }[]> {
    return this.guard(() => this.exclusive(async () => {
      const st = await this.state(version);
      return [...st.parked].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, bytes]) => ({ name, fromLine: parseInt(name.slice(0, 16), 10), bytes }));
    }));
  }
  /**
   * Parks that were found NOT to be a prefix and set aside (N12b). A caller that was told `parked` must read this to learn that the lines
   * it believed safe were moved here instead. Nothing here is deleted; the files are framed line lists (see `unframeLines`).
   */
  rejectedList(version: VersionId): Promise<{ name: string; fromLine: number; bytes: number }[]> {
    return this.guard(() => {
      const key = this.keyOf(version);
      return this.exclusive(async () => {
        const dir = nodePath.join(this.vdir(key), 'rejected');
        const out = [];
        for (const name of (await this.fs.readdir(dir)).sort()) {
          if (!/^\d{16}-[0-9a-f]{16}\.park$/.test(name)) continue;
          out.push({ name, fromLine: parseInt(name.slice(0, 16), 10), bytes: await this.tools.fileSize(nodePath.join(dir, name)) });
        }
        return out;
      });
    });
  }
  /** Give up on a parked append (a timeout the caller owns): moved to rejected/, kept, never deleted. Returns false when there is no such park. */
  releaseParked(version: VersionId, name: string): Promise<boolean> {
    return this.guard(() => {
      if (!/^\d{16}-[0-9a-f]{16}\.park$/.test(name)) throw new StoreError('bad-argument', 'parked name');
      const key = this.keyOf(version);
      return this.exclusive(() => this.mutate(key, async () => {
        const st = await this.state(version);
        if (!st.parked.has(name)) return false;
        if (!(await this.moveAway(st, nodePath.join(st.dir, 'parked', name), name))) throw new StoreError('limit', 'rejected/ is full');
        return true;
      }));
    });
  }

  /**
   * A parked append that is not a prefix is KEPT (retention rule) under rejected/, never deleted. At the
   * cap it stays in parked/ instead (where it counts toward the parked cap and so surfaces loudly).
   */
  private async moveAway(st: VState, path: string, name: string): Promise<boolean> {
    const rej = nodePath.join(st.dir, 'rejected');
    await mkdirDurable(this.fs, rej);
    if ((await this.fs.readdir(rej)).length >= MAX_REJECTED) return false;
    // N11: a byte cap as well as a file cap (a junk park can be hundreds of MB); at the cap it stays in parked/, counting toward that cap
    if ((await this.bytesUnder(rej)) + (st.parked.get(name) ?? 0) > this.maxRejectedBytes) return false;
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
  /**
   * Every version with its head, or a typed reason it cannot be served. WHY one try per version (N4, N8): one version with a
   * garbage metadata file, a classifier it cannot re-derive or any other unreadable state must never make the listing (and
   * so every other version) throw. A version that cannot be read is listed with `damaged: 'unreadable: <code>'`;
   * `chatId`/`runtime` are null when its own meta.json is what is unreadable.
   */
  listVersions(): Promise<{ version: Buffer; chatId: string | null; runtime: RuntimeKind | null; parent: Buffer | null; head: Head | null; damaged: string | null }[]> {
    return this.exclusive(async () => {
      const out = [];
      for (const key of (await this.fs.readdir(nodePath.join(this.root, 'versions'))).sort()) {
        if (!/^[0-9a-f]{2,256}$/.test(key) || key.length % 2) continue;
        let base: { version: Buffer; chatId: string | null; runtime: RuntimeKind | null; parent: Buffer | null } = { version: unhex(key), chatId: null, runtime: null, parent: null };
        try {
          const meta = await this.readMetaIfPresent(this.vdir(key)); // registration may never have finished
          if (!meta) continue;
          base = { version: unhex(key), chatId: meta.chatId, runtime: meta.runtime, parent: meta.parent ? unhex(meta.parent) : null };
          const dmg = await this.readDamaged(this.vdir(key));
          if (dmg) { out.push({ ...base, head: null, damaged: dmg.asideName }); continue; }
          let st = this.versions.get(key);
          if (!st) { st = await this.load(key); this.versions.set(key, st); }
          out.push({ ...base, head: this.headOf(st), damaged: null });
        } catch (e) {
          this.versions.delete(key);
          if (e instanceof StoreError && e.code === 'damaged') { out.push({ ...base, head: null, damaged: (await this.readDamaged(this.vdir(key)).catch(() => null))?.asideName ?? 'damaged' }); continue; }
          out.push({ ...base, head: null, damaged: `unreadable: ${e instanceof StoreError ? e.code : ((e as { code?: string })?.code ?? 'error')}` });
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
          // N15: a persisted "cut done" marker. Without it, lines the new host appended that happen to be byte-identical to the saved
          // tail would satisfy this test and be cut a second time. (Residual: a kill between the cut and the marker, then the same
          // lines re-appended before this retry, still cuts once more; the tail file keeps them.)
          const done = await this.fs.exists(nodePath.join(dir, `${takeoverId}.done`));
          if (!done && L > 0 && st.count === existing.fromLine + L && hex((await this.stateAtLine(st, st.count)).h) === existing.headHash) { await this.cutTo(st, existing.fromLine); await this.markCutDone(dir, takeoverId); }
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
        await mkdirDurable(this.fs, dir);
        await writeFileAtomic(this.fs, path, encodeTailFile(header, lines));
        if (st.count > from) await this.cutTo(st, from);
        await this.markCutDone(dir, takeoverId);
        return { lines: lines.length };
      }));
    });
  }

  private async markCutDone(dir: string, takeoverId: string): Promise<void> {
    await writeFileAtomic(this.fs, nodePath.join(dir, `${takeoverId}.done`), Buffer.from('cut done\n'));
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

  private async readTailFile(path: string): Promise<TailFile | null> {
    const b = await this.fs.readFile(path);
    return b ? decodeTailFile(b) : null;
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
    // WHY the checkpoint is lowered BEFORE the cut (N1): a checkpoint that outlives the cut would claim lines that are gone, and
    // the next load would call the version damaged. Lowered first, a kill between the two steps leaves it merely behind the index.
    if (st.ckptCount > n) {
      await writeCheckpoint(this.fs, st.dir, { count: n, stamp: st.staleConv ? (this.stamp ^ 0x80000000) >>> 0 : this.stamp, h: lastKept ? lastKept.h : st.seeds.raw, c: lastKept ? lastKept.c : st.seeds.conversation });
      st.ckptCount = n;
    }
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
        // WHY not readMeta alone (N8): the remedy for a version with a garbage meta.json must not itself need that file
        let metaBad = false;
        try { if (!(await this.readMeta(dir))) throw new StoreError('unknown-version', key.slice(0, 8)); }
        catch (e) { if (e instanceof StoreError && e.code === 'corrupt') metaBad = true; else throw e; }
        let dmg: { asideName: string; reason: string } | null = null;
        try { dmg = await this.readDamaged(dir); } catch (e) { if (!(e instanceof StoreError && e.code === 'corrupt')) throw e; await this.fs.unlink(nodePath.join(dir, 'damaged.json')); }
        if (dmg) {
          await this.fs.unlink(nodePath.join(dir, 'damaged.json')); await this.fs.fsyncDir(dir);
          this.versions.delete(key);
          await this.ensureIndex(dir);
          return { asideName: dmg.asideName };
        }
        const taken = (await this.fs.readdir(nodePath.join(this.root, 'aside'))).filter((n) => n.startsWith(key + '-')).length;
        const asideName = `${key}-${taken + 1}`;
        await writeFileAtomic(this.fs, nodePath.join(dir, 'aside.intent'), Buffer.from(JSON.stringify(metaBad ? { asideName, moveMeta: true } : { asideName })));
        this.versions.delete(key);
        await this.finishAside(key, dir);
        return { asideName };
      }));
    });
  }

  private async finishAside(key: string, dir: string): Promise<void> {
    const ib = await this.fs.readFile(nodePath.join(dir, 'aside.intent'));
    if (!ib) return;
    const { asideName, reason, moveMeta } = JSON.parse(ib.toString()) as { asideName: string; reason?: string; moveMeta?: boolean };
    if (!ASIDE_RE.test(asideName)) throw new StoreError('corrupt', 'aside intent');
    const target = nodePath.join(this.root, 'aside', asideName);
    await mkdirDurable(this.fs, target);
    for (const name of await this.fs.readdir(dir)) {
      if (name === 'index.bin' || name === 'index.rebuild' || name === 'evicted.json' || name === 'summary.json' || name === 'scrub.json' || name === CHECKPOINT_FILE || name === PARTIAL_FILE || name === STALE_CONV_FILE || (moveMeta && name === 'meta.json') || /^body-[0-9a-f]{16}\.bin$/.test(name)) {
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
    // a version whose meta.json was garbage has no registration any more (the caller registers it again): no index to create
    if (reason === undefined && !moveMeta) await this.ensureIndex(dir);
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
        // N4: with the bodies back the conversation chain can be recomputed: drop the cached state so the next call rebuilds it
        if (st.staleConv) this.versions.delete(key);
        return { restoredLines: restored };
      }));
    });
  }

  // ---- whole-version check ---------------------------------------------------------------------------
  /** Full scrub: every record's checksum and continuity, the index file's exact size, the chunk files, and every kept body re-hashed against the chain. */
  verify(version: VersionId): Promise<VerifyReport> {
    return this.exclusive(async () => {
      const st = await this.state(version);
      if (st.indexNeedsInit) return { ok: true, lines: 0, firstBadLine: null };
      const f = await this.fs.open(this.ixPath(st.dir), { create: false });
      const fail = (line: number, reason: string): VerifyReport => ({ ok: false, lines: st.count, firstBadLine: line, reason });
      try {
        if ((await f.size()) !== recPos(st.count)) return fail(st.count, 'index size');
        try {
          const lay = await this.tools.checkChunks(st.dir, { lines: st.evictedLines, bytes: st.evictedBytes });
          if (lay.phys !== st.bodyEnd) return fail(st.count, 'body end');
        } catch (e) { return fail(0, e instanceof Damaged ? e.reason : 'body chunks'); }
        // N1: the head must also agree with the checkpoint kept in a separate file
        const ck = await readCheckpoint(this.fs, st.dir);
        if (ck) {
          if (ck.count > st.count) return fail(st.count, 'checkpoint is ahead of the index');
          if (ck.count > 0 && !this.mustRec(await f.read(recPos(ck.count - 1), REC)).h.equals(ck.h)) return fail(ck.count - 1, 'checkpoint');
        }
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

  // ---- extras (extras.ts) ------------------------------------------------------------------------------
  hasExtra(hash: string): Promise<boolean> { return this.guard(() => this.exclusive(() => this.extras.has(hash))); }
  /** The extra's bytes, verified against their hash; a rotted one is set aside and reported `corrupt` once (N6). */
  readExtra(hash: string): Promise<Buffer | null> { return this.guard(() => this.exclusive(() => this.extras.read(hash))); }
  /** Store bytes under their SHA-256. A mismatch is refused: a peer cannot file bytes under a hash they do not have. */
  putExtra(hash: string, bytes: Uint8Array): Promise<'stored' | 'present'> {
    return this.guard(() => { this.extras.check(hash, bytes); return this.exclusive(() => this.extras.put(hash, bytes)); });
  }
  private bytesUnder(path: string): Promise<number> { return bytesUnder(this.fs, this.tools, path); }

  /**
   * Disk used by everything the store KEEPS and never deletes (N11), so the replicator can own a disk budget:
   * set-aside copies, rejected parks, tails, replaced indexes, healed bytes, torn bytes, rotted extras, and extras.
   */
  keptBytes(): Promise<{ aside: number; extrasBad: number; extras: number; perVersion: { version: string; rejected: number; tails: number; replacedIndex: number; healed: number; torn: number; parked: number }[] }> {
    return this.exclusive(async () => {
      const perVersion = [];
      for (const key of (await this.fs.readdir(nodePath.join(this.root, 'versions'))).sort()) {
        const d = this.vdir(key);
        const sz = (n: string) => this.bytesUnder(nodePath.join(d, n));
        perVersion.push({ version: key, rejected: await sz('rejected'), tails: await sz('tails'), replacedIndex: await sz('replaced-index'), healed: await sz('healed'), torn: await sz('torn'), parked: await sz('parked') });
      }
      return { aside: await this.bytesUnder(nodePath.join(this.root, 'aside')), extrasBad: await this.bytesUnder(nodePath.join(this.root, 'extras-bad')), extras: await this.extras.bytes(), perVersion };
    });
  }

  // ---- control log storage (no interpretation) --------------------------------------------------------
  controlLog(chat: string): Promise<ControlEntry[]> { return this.exclusive(() => this.control.log(chat)); }
  /** Byte ranges of a chat's control log that could not be read and were skipped; the rest of the log is served (N2). Empty when clean. */
  controlDamage(chat: string): Promise<ControlDamage[]> { return this.exclusive(() => this.control.damage(chat)); }
  parkedControl(chat: string): Promise<ControlEntry[]> { return this.exclusive(() => this.control.parked(chat)); }
  appendControl(entry: ControlEntry): Promise<'ok' | 'parked' | 'duplicate'> {
    return this.exclusive(() => this.control.append(entry));
  }
  /** A control log reported `damaged`: move its file aside (kept) so the log starts empty and can be refetched. Returns the kept file's name. */
  quarantineControl(chat: string): Promise<string> { return this.exclusive(() => this.control.quarantine(chat)); }

  /** First line whose bytes are not trustworthy: a body that failed its chain value, or lines a rebuild set aside and a resend has not yet replaced. */
  private damagedFrom(st: VState): number | null {
    const p = st.partial && st.count < st.partial.fromLine + st.partial.lost ? st.partial.fromLine : null;
    if (st.badLine === null) return p;
    return p === null ? st.badLine : Math.min(p, st.badLine);
  }

  private headOf(st: VState): Head {
    return { lines: st.count, hash: hex(st.h), conversationLines: st.convCount, conversationHash: hex(st.c), evictedLines: st.evictedLines, classifierStamp: this.stamp, damagedFromLine: this.damagedFrom(st), conversationChainStale: st.staleConv };
  }
}
