// Seam S2: the chat store. On disk under a caller-supplied root; pure library, called by nothing yet.
//
// THE ONE INVARIANT (review 3, class fix; extended by review 4). Every acknowledged line is either served byte-identical, or reported as damaged/evicted with its
// bytes still present somewhere under the root; never silently absent, never served wrong. No single-file fault and no single crash point may break this, where a
// file fault is ANY of: rotted bytes, an OLDER valid copy of the file put back, a valid copy that belongs to ANOTHER chat or version put in its place, the file
// missing, or the file cut short at a clean boundary (a record, a slot, a line) so that nothing in it fails a checksum. Review 4 found that the first of these (rot)
// was the only one the earlier rounds attacked; the other four are the "valid but WRONG file" class, which checksums cannot see. inventory.ts answers all five for every
// file; the mechanisms are IDENTITY (version tags in the index header, the checkpoint slots and every small file), FRESHNESS (what must be current, the eviction state,
// lives only in the checkpoint) and ANCHORS (the control log and the extras have a second record of what was acknowledged). No destructive action (unlink, truncate,
// overwrite of a body or of the only copy of anything acknowledged) is ever taken on the say-so of a marker that was merely true once: a body is unlinked only inside
// evictBody under a proof that was just verified (load never unlinks a body), and surplus body bytes are cut only after the index was checked against the checkpoint and
// copied to torn/ first. A missing, short or cut body chunk costs exactly the lines it held (reported, a resend writes them back); it never hides the other lines.
// Honest limits (inventory.ts): (1) a fault that destroys the ONLY copy of some bytes (a body chunk, a control log, an extra, a kept tail) destroys them; the store then
// never serves them wrong and always reports it (a chain mismatch, `damagedFromLine`, `controlDamage`, a typed error) so a peer's copy can heal it. (2) After a successful
// eviction the chain values of the evicted lines exist only in index.bin and its kept copies; a fault there that no kept copy covers quarantines the version. (3) Parked
// appends are provisional. (4) Two faults are not promised, except that the store repairs every second copy it finds damaged AS IT LOADS (meta, checkpoint, control anchor).
// Enforced by faults.test.ts, fuzz.test.ts (random crash points x one fault of EVERY kind in a random file of the real folder x reopen, invariant checked every time; opt-in
// long run by environment variable), matrix.test.ts (every file x every fault, deterministic), inventory.test.ts (no file outside the table; five answers per row; every
// unlink/truncate/rename/overwrite carries a DESTRUCTIVE-OK(<why>) reason), durability-guards.test.ts (the places a mutation check showed no test would notice a wrong line) and the mutation check recorded in the round-4 commit message.
//
// EVERY FILE THE STORE WRITES, how a damaged copy is detected and what a damaged or missing one means (always non-destructive): inventory.ts.
//
// Layout (all names computed from validated ids, never from peer strings):
//   <root>/FORMAT, <root>/LOCK
//   <root>/versions/<vhex>/   one directory per version (vhex = hex of the opaque version id): the files above, plus
//       index.bin             36-byte header (classifier stamp, version tag, checksum) + one fixed-width record per line (records.ts)
//       body-<startByte>.bin  raw line bytes, chunked; the index says where each line is
//   <root>/aside/<vhex>-<n>/ and <vhex>-q<n>/   a copy found damaged and recopied / a QUARANTINED copy: index AND bodies moved aside intact
//   <root>/extras/, <root>/extras-bad/, <root>/control/<sha256(chat)>/
//
// Crash rules (the reasons for the write order below):
//  1. A line exists exactly when its index record is whole and CRC-correct AND its body bytes are on disk. An append writes the BODY, fsyncs it,
//     then the INDEX records, fsyncs them, then the CHECKPOINT slot, fsyncs it, and only then returns ("acknowledged"). So the checkpoint is
//     the independent record of what was acknowledged: body or index past it were never acknowledged.
//  2. Whole-file replacements are temp-file + fsync + rename + directory fsync; every NEW directory has its parent fsynced (M2).
//  3. Multi-step operations (set aside a damaged copy, set aside a tail, evict, restore) are ordered so that every prefix of their steps is a
//     state open() understands and finishes or ignores.
//  4. After any failed operation the cached in-memory state of that version is dropped, so the next call re-reads the disk and repairs.
//
// Recovery: open() NEVER deletes or truncates an acknowledged line, and copies bytes to torn/ (fsynced) before any cut.
//  - index tail damaged or torn: the bad index bytes are kept in torn/ and the index is cut back to its last good record. Body lines past it are
//    NOT adopted from their own bytes (review 3, F3: that is how rot in a crashed batch forked the head). If the checkpoint says they were
//    acknowledged the index is re-derived from the body and CONFIRMED against the checkpoint's chain value; if it says they were not, they are kept
//    in torn/ and cut; with neither (tail damaged and no checkpoint) they are kept AND reported (partial.json, damagedFromLine = the head).
//  - a bad record followed by a valid one, a missing/short index, a bad header, an index that belongs to another version or a changed classifier stamp: rebuilt from
//    the body keeping every valid old record of THIS version, so a rotted line is reported alone and every later line is still served (F2). Nothing vouching at all: quarantine.
//  - body files that are missing, short or cut (review 4, F3/F4): the lines whose bytes are not wholly inside a chunk file are reported damaged (the first one is
//    `damagedFromLine`), every other line is served, new appends start a fresh chunk at the head, and a correct resend writes the lines back. Never "evicted".
//  - only an unresolvable disagreement (a rebuild that cannot confirm anything, an index whose evicted-prefix records exist nowhere): the whole version (index AND
//    bodies) is moved to aside/<vhex>-q<n>/, reports a typed `damaged` error and serves nothing until setAsideDamaged() clears it.
// A full disk (N5) is one typed `disk-full` refusal; reads never write anything that can fail (a copy-then-cut a read could not do is postponed to the
// next write, and a full keep-area is a typed `limit` for new writes only), and a failed append cuts back what it added.
//
// No file handles are kept open between calls (a user can have 1,400+ chats; handles would exhaust the
// process limit). One in-process lock serialises all calls and lock.ts keeps other processes out.
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { realFs, writeFileAtomic, sweepTemps, mkdirDurable, type Fs } from './fsio';
import { StoreError } from './errors';
import { acquireLock, type StoreLock } from './lock';

// DESTRUCTIVE-OK(hint): FORMAT is a constant; writing it replaces nothing that is not a constant
const writeSide0 = (fs: Fs, path: string, text: string): Promise<void> => writeFileAtomic(fs, path, Buffer.from(text));
import { readCheckpoint, readCheckpointState, appendCheckpoint, writeCheckpoint, CHECKPOINT_FILE, type CheckpointState } from './checkpoint';
import { readSide, readSideFor, writeSide, writeSideFor, keepBadSideFile, formatLine, parseFormat, type SideRead } from './sidefile';
import { Extras, bytesUnder } from './extras';
import { asLine, decodeTailFile, encodeTailFile, isDiskFull, validateProofShape, type TailFile } from './storeutil';
import { chainStep, crc32, defaultChainSeeds, hex, isHash64, unhex, versionTag, type ChainSeedFn, type ChainSeeds, type RuntimeKind } from './chain';
import { CLASSIFIER_VERSION, analyseLine, initialReplyState, replyEndStep, type LineInfo, type ReplyEndOptions, type ReplyState } from './classify';
import { HDR, REC, NONE, decodeRecord, encodeRecord, frameLines, headerOk, headerStamp, indexHeader, recPos, unframeLines, type Rec } from './records';
import { ControlStore, type ControlDamage, type ControlEntry } from './control';
import type { AppendResult, EvictionProof, Head, ProofVerifier, ScrubReport, StoreOptions, Summary, TailRecord, VerifyReport, VersionId, VersionMeta } from './types';
import type { VState } from './vstate';
import { readMeta, readPartial, readDamaged, readScrubMark, readEvictedNote, lineVerifies, nextAsideName } from './versionfiles';
import { BodyTools, Damaged, NeedsRebuild, PARTIAL_FILE, PARTIAL_COPY, DAMAGED_COPY, writePartial, writeDamaged, STALE_CONV_FILE, chunkPathOf, nextNumbered, type BatchState, type RebuildResult, type SumFacts } from './recovery';

export type { VersionId, ProofVerifier, StoreOptions, VersionMeta, Head, AppendResult, Summary, EvictionProof, TailRecord, VerifyReport, ScrubReport } from './types';

const DEFAULT_CHUNK = 16 * 1024 * 1024;
const VERIFY_WINDOW = 4096;
const SCAN_BATCH = 4096;
const MIB = 1024 * 1024;
/** summary.json is also rewritten every this many lines even when no fact changed, so open() never re-scans far. */
const SUMMARY_SAVE_EVERY = 2048;
const TAKEOVER_RE = /^[0-9a-f]{8,128}$/;
const ASIDE_RE = /^[0-9a-f]+-q?\d+$/;
/** Longest version id the store accepts (see keyOf). */
export const MAX_VERSION_ID_BYTES = 64;
const MAX_TAILS = 1024;
const MAX_REJECTED = 1024;
const MAX_REJECTED_BYTES = 256 * MIB;
const DEFAULT_MAX_EXTRAS = 4 * 1024 * MIB;
const LOAD_SCRUB_RECORDS = 8192;
const STEP_SCRUB_RECORDS = 65536;

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
      if (cur === null) await writeSide0(fs, fmt, formatLine(1));
      else {
        const p = parseFormat(cur);
        // WHY (review 3, F5): a format number with a GOOD checksum is a store from another version of the code: refuse, touch nothing. One that
        // fails its checksum (a flipped bit, a zero-length file) is a damaged copy of a constant: it is kept as FORMAT.bad-N and rewritten.
        if (p.kind === 'ok' && p.n !== 1) throw new StoreError('corrupt', 'unknown store format');
        if (p.kind === 'bad') { await keepBadSideFile(fs, fmt); await writeSide0(fs, fmt, formatLine(1)); }
      }
      for (const d of ['versions', 'aside', 'extras', 'control']) await mkdirDurable(fs, nodePath.join(root, d));
      // WHY safe now: with the lock held no other process has temp files in flight (review C2: this sweep
      // used to delete a second process's in-flight temp files).
      await sweepTemps(fs, root);
    } catch (e) { await s.lock.release().catch(() => undefined); s.lock = null; throw e; }
    return s;
  }

  async close(): Promise<void> {
    await this.chain.catch(() => undefined);
    // WHY the finally (review 3, F8): a close that fails while writing (an I/O error at shutdown) used to skip releasing the lock, so the next open in
    // the same process answered `store-locked` until restart. Whatever happens here, the store is closed and the lock is released; the error still surfaces.
    try {
      // arrival times are kept in memory between summary saves; closing writes them (a convenience file: a full disk is not an error here)
      for (const st of this.versions.values()) {
        if (st.summaryDirty) { try { await this.saveSummary(st); } catch (e) { if (!isDiskFull(e)) throw e; } }
      }
    } finally {
      this.closed = true; this.versions.clear();
      const l = this.lock; this.lock = null;
      if (l) await l.release();
    }
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
    // WHY 64 (review 4, F9): the id becomes folder names in hex (2 characters per byte) and the longest name the store makes is the quarantine folder
    // `<hex>-q<n>`; file systems stop at 255 characters. 64 bytes (128 hex characters) leaves room for every name with a wide margin; real ids are 32 bytes.
    if (!(version instanceof Uint8Array) || version.length < 1 || version.length > MAX_VERSION_ID_BYTES) throw new StoreError('bad-argument', `version id must be 1..${MAX_VERSION_ID_BYTES} bytes`);
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
        const existing = await readMeta(this.fs, dir);
        const parent = meta.parent ? hex(meta.parent) : null;
        if (existing) {
          if (existing.chatId !== meta.chatId || existing.runtime !== meta.runtime || existing.parent !== parent) throw new StoreError('version-conflict', key.slice(0, 8));
          return;
        }
        await mkdirDurable(this.fs, dir);
        const m = { format: 1, version: key, chatId: meta.chatId, runtime: meta.runtime, parent, createdMs: this.now() };
        // WHY two copies, each checksummed (review 3, F5): one flipped letter of the chat id changes every chain seed, so every line would read as rotted.
        // Either copy alone is enough; a damaged one is replaced from the other (readMeta). Both are new files here (neither existed).
        await writeSide(this.fs, nodePath.join(dir, 'meta.json'), m); // DESTRUCTIVE-OK(verified-record): a NEW file, the version had no meta
        await writeSide(this.fs, nodePath.join(dir, 'meta.copy'), m); // DESTRUCTIVE-OK(verified-record): a NEW file, the version had no meta
        await this.ensureIndex(dir);
        // WHY a checkpoint from the very start: "no checkpoint" must always mean a fault, never "nothing was written yet" (review 3, F3)
        const seeds = this.seedFn({ chatId: meta.chatId, version: unhex(key), segment: 0 });
        // DESTRUCTIVE-OK(verified-record): only when no checkpoint exists yet (a new version has none)
        if (!(await readCheckpoint(this.fs, dir))) await writeCheckpoint(this.fs, dir, { count: 0, stamp: this.stamp, evLines: 0, evBytes: 0, h: Buffer.from(seeds.raw), c: Buffer.from(seeds.conversation) });
        await this.fs.fsyncDir(nodePath.join(this.root, 'versions'));
      }));
    });
  }


  private async ensureIndex(dir: string): Promise<void> {
    const p = this.ixPath(dir);
    const f = await this.fs.open(p, { create: true });
    try {
      // DESTRUCTIVE-OK(scratch): only when the file is shorter than a header, i.e. holds no record
      if ((await f.size()) < HDR) { await f.truncate(0); await f.write(indexHeader(this.stamp, versionTag(nodePath.basename(dir))), 0); await f.sync(); }
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
          try { await this.rebuildIndex(key, e.reason); } catch (e2) { if (e2 instanceof Damaged) await this.quarantineOrReport(key, e2.reason); throw e2; }
          continue; // a split rebuild leaves the cut-off bytes as surplus, which the next loadOnce moves to torn/
        }
        if (e instanceof NeedsRebuild) throw new StoreError('corrupt', `index could not be repaired: ${e.reason}`);
        if (e instanceof Damaged) await this.quarantineOrReport(key, e.reason);
        throw e;
      }
    }
  }

  private async loadOnce(key: string): Promise<VState> {
    const dir = this.vdir(key);
    const meta = await readMeta(this.fs, dir);
    if (!meta) throw new StoreError('unknown-version', key.slice(0, 8));
    await sweepTemps(this.fs, dir);
    await this.finishAside(key, dir); // a set-aside interrupted half way is completed first
    const dmg = await readDamaged(this.fs, dir);
    if (dmg) throw new StoreError('damaged', dmg.asideName);
    // WHY (review 4, F5 class): a damaged.json that survives next to a live index.bin is an OLDER copy of a marker (a quarantine really moves the index away).
    // readDamaged ignores it; it is moved to damaged.json.bad-N (kept) so it cannot confuse the next reader. Best effort: a read never fails for lack of space.
    try { for (const n of ['damaged.json', DAMAGED_COPY]) if (await this.fs.exists(nodePath.join(dir, n))) await keepBadSideFile(this.fs, nodePath.join(dir, n)); } catch (e) { if (!isDiskFull(e)) throw e; }
    const seeds = this.seedFn({ chatId: meta.chatId, version: unhex(key), segment: 0 });

    // 0. What was evicted ON PURPOSE. Review 4 (F1, F4, F5): the only authority is the eviction state inside the checkpoint (checkpoint.ts), which is rewritten in
    // place at every acknowledgement and carries this version's identity. evicted.json is NOT read: it had no freshness, so an older copy of it deleted restored
    // bodies (F1), quarantined a healthy chat (F5), and "which chunk files exist" made a deleted first chunk look like an eviction (F4). Nothing is unlinked here.
    const ckState = await readCheckpointState(this.fs, dir);
    const ck = ckState.ck;
    // 1. The chunk files as they are: holes are allowed here (F3), they are reported below line by line and never hide the lines that are whole.
    let layout = await this.tools.layout(dir);
    // WHY the veto (review 4, F1 through the checkpoint): "evicted" means the bodies are gone on purpose. When every body below the recorded eviction point is in fact still on
    // disk AND the holders' note (evicted.json, written after every eviction and every restore) records a DIFFERENT state, the checkpoint's record is an older copy (a restore
    // undid it and an old checkpoint brought it back, or a kill came between the record and the unlinks). Those lines are served, never relabelled "proven held elsewhere",
    // and the next checkpoint write forgets the stale record. The note alone decides nothing: it can only veto an eviction whose bodies are all present.
    let evInForce = !!ck && ck.evLines > 0;
    if (evInForce && this.tools.gapStart(layout, 0, ck!.evBytes) === null) {
      const note = await readEvictedNote(this.fs, dir);
      if (note && (note.lines !== ck!.evLines || note.bytes !== ck!.evBytes)) evInForce = false;
    }
    const ev = evInForce ? { lines: ck!.evLines, bytes: ck!.evBytes } : { lines: 0, bytes: 0 };
    // 2. The index: only its tail is repaired in place (bytes kept); anything else is NeedsRebuild / Damaged.
    const ix = await this.tools.settleIndex(dir, ev, layout, this.stamp);
    let { count, last } = ix;
    // an index SHORTER than the checkpoint lost records (an older copy, a cut at a record boundary): re-derive it before anything is decided from it
    if (ck && ck.count > count) throw new NeedsRebuild('the index is shorter than the checkpoint');
    // N1: a record that disagrees with the checkpoint means the index (a foreign or damaged one), not the body, is what is wrong. WHY BEFORE the surplus cut below
    // (review 4, F8): a foreign index is shorter than the body, so the body's "extra" bytes were being moved away as never-acknowledged before anything compared the index with the checkpoint.
    if (ck && ck.count > 0) {
      const r = decodeRecord(await this.readAt(this.ixPath(dir), recPos(ck.count - 1), REC), 0);
      if (!r) throw new NeedsRebuild(`record ${ck.count - 1} fails its checksum`);
      if (!r.h.equals(ck.h)) throw new NeedsRebuild('the index disagrees with the checkpoint');
    }
    // the eviction record must agree with the index record of its last line (an independent, checksummed record)
    if (ev.lines > 0) {
      const r = decodeRecord(await this.readAt(this.ixPath(dir), recPos(ev.lines - 1), REC), 0);
      if (!r) throw new NeedsRebuild(`record ${ev.lines - 1} fails its checksum`);
      if (r.offset + r.len !== ev.bytes) throw new NeedsRebuild('the index disagrees with the eviction record');
    }
    // the conversation chain's staleness is recorded twice (the marker file and the checkpoint stamp), so losing either one restores it from the other
    const staleConv = (await this.fs.exists(nodePath.join(dir, STALE_CONV_FILE))) || (ck !== null && ck.stamp === ((this.stamp ^ 0x80000000) >>> 0));
    // N4: the evicted bodies are back, so the conversation chain can be recomputed now
    if (staleConv && ev.lines === 0) {
      // WHY not always (review 3): the chain is also stale while a rotted line is not healed yet (the marker says which). Rebuilding then changes nothing and would loop.
      const mk = await readSideFor(this.fs, nodePath.join(dir, STALE_CONV_FILE), key);
      const bad = mk.kind === 'ok' && Number.isSafeInteger(mk.value?.bad) ? (mk.value.bad as number) : null;
      if (bad === null || bad >= count || (await lineVerifies(this.fs, dir, layout.chunks, bad, seeds.raw))) throw new NeedsRebuild('evicted bodies are back or the rotted line was healed: recompute the conversation chain');
    }
    let bodyEnd = last ? last.offset + last.len : 0;
    let deferred: VState['deferred'] = ix.tailDeferred ? { trimTo: null, indexTail: true, partial: null } : null;
    let partial = await readPartial(this.fs, dir, count);
    if (layout.phys > bodyEnd) {
      // 3. Body bytes the index does not cover. WHY they are NOT adopted (review 3, F3): their records would be derived from the bytes
      // with nothing to compare against, so a rotted byte in a crashed batch would be hashed into the chain and fork the head. The
      // checkpoint is written before every acknowledgement, so lines past it were never acknowledged; they are kept in torn/ and cut.
      // Only when NOTHING independent says so (the index tail was damaged AND there is no checkpoint) could they have been
      // acknowledged: then they are kept AND reported (damagedFromLine = the head) until a peer's resend fills them.
      let marker: { fromLine: number; lost: number } | null = null;
      if (ix.tailDamaged && !ck) { const lost = await this.tools.countWholeLines(dir, bodyEnd); if (lost > 0) marker = { fromLine: count, lost }; }
      if (marker) partial = marker;
      try {
        if (marker) await writePartial(this.fs, dir, { ...marker, atMs: this.now() }); // DESTRUCTIVE-OK(hint): a marker; replaces an older marker of the same kind
        await this.tools.trimBody(dir, bodyEnd, true);
      } catch (e) {
        // WHY (N5, review 3 F7): copying the surplus to torn/ needs space and a free slot in the keep-area. Keep serving what is indexed (the surplus
        // is never read) and retry before the next write; never make a healthy version unreadable because the disk or the keep-area is full.
        if (!isDiskFull(e) && !(e instanceof StoreError && e.code === 'limit')) throw e;
        deferred = { trimTo: bodyEnd, indexTail: ix.tailDeferred, partial: marker };
      }
      layout = await this.tools.layout(dir);
    }
    // surplus chunk files (only possible while a trim is deferred) are not part of the version
    const chunks = deferred && deferred.trimTo !== null ? layout.chunks.filter((c) => c < bodyEnd || c === layout.chunks[0]) : layout.chunks;

    // Lines whose body is not on disk (F3, F4): a hole in the chunk files from the eviction point on. Reported as damaged from the first such line; every line
    // that lies wholly inside a chunk file is still served. A hole below the eviction point is nothing (those bodies were dropped on purpose).
    let badLine: number | null = null;
    if (count > ev.lines) {
      const gs = this.tools.gapStart(layout, ev.bytes, bodyEnd);
      if (gs !== null) badLine = await this.tools.firstLineEndingAfter(dir, ev.lines, count, gs);
    }
    // A line whose body no longer matches its chain value (checked cheaply for the last line only; the rolling scrub does the rest).
    if (badLine === null && count > ev.lines && last) {
      const prevH = count > 1 ? (await this.recAtDir(dir, count - 2)).h : seeds.raw;
      const cs = chunks.filter((c) => c <= last!.offset).pop();
      const line = cs === undefined ? Buffer.alloc(0) : await this.readAt(chunkPathOf(dir, cs), last.offset - cs, last.len);
      if (line.length !== last.len || !chainStep(prevH, line).equals(last.h)) badLine = count - 1;
    }

    const st: VState = {
      key, dir, meta, seeds, count,
      h: last ? last.h : Buffer.from(seeds.raw), c: last ? last.c : Buffer.from(seeds.conversation),
      convCount: last ? last.convCount : 0, bodyEnd,
      rs: last ? { cand: last.candN === NONE ? null : { n: last.candN, id: last.candId } } : initialReplyState(),
      evictedLines: ev.lines, evictedBytes: ev.bytes,
      chunks, tailShort: layout.chunks.length > 0 && layout.phys < bodyEnd, replyEndsCache: null, summarySavedAt: 0,
      summary: { title: null, model: null, cwd: null, lastAppendMs: null, lines: 0 },
      badLine, scrubMark: 0, passEnd: 0, ck: ckState, deferred, summaryDirty: false, indexNeedsInit: !!ix.needsInit,
      partial, staleConv,
      parked: new Map(), parkedBytes: 0,
    };
    await this.restoreRedundancy(st);
    const mark = await readScrubMark(this.fs, dir);
    st.passEnd = Math.min(mark.passEnd, count); st.scrubMark = Math.min(mark.lines, st.passEnd);
    await this.loadSummary(st);
    await this.loadParkedIndex(st);
    if (this.scrubOnOpen > 0) await this.scrubSome(st, this.scrubOnOpen, LOAD_SCRUB_RECORDS);
    // WHY tolerant (review 3, F7): applying a parked append writes; a read must not fail because the disk is full. It is retried by the next append.
    try { await this.drainParked(st); } catch (e) { if (!isDiskFull(e)) throw e; }
    return st;
  }

  /**
   * Give back the second copy of anything that is kept twice, as soon as a version loads (review 3, class fix). WHY: "any one fault is survivable"
   * only stays true if a fault found at open is repaired at open; otherwise a second fault in the OTHER copy, found later, is two faults in a row.
   * The checkpoint (two slots, and the stale-chain bit also lives in its stamp) is rewritten level with the head when a slot is bad, it is missing, or it
   * lags (the lines past it are in valid index records: a crash between the index and the checkpoint). Best effort: a full disk only postpones it.
   */
  private async restoreRedundancy(st: VState): Promise<void> {
    try {
      const want = { count: st.count, stamp: st.staleConv ? (this.stamp ^ 0x80000000) >>> 0 : this.stamp, evLines: st.evictedLines, evBytes: st.evictedBytes, h: st.h, c: st.c };
      const cur = st.ck.ck;
      // DESTRUCTIVE-OK(verified-record): the head's chain values come from the CRC-checked index record and the load checks above; a lagging or damaged slot is replaced, a statement AHEAD of the index never reaches here
      if (!cur || cur.count !== st.count || cur.stamp !== want.stamp || cur.evLines !== want.evLines || cur.evBytes !== want.evBytes || st.ck.slotsOk < 2) await writeCheckpoint(this.fs, st.dir, want, st.ck);
      const sp = nodePath.join(st.dir, STALE_CONV_FILE);
      if (st.staleConv && !(await this.fs.exists(sp))) await writeSideFor(this.fs, sp, st.key, { through: st.evictedLines, bad: null }); // DESTRUCTIVE-OK(hint): existence-only marker, restored from the checkpoint stamp
    } catch (e) { if (!isDiskFull(e)) throw e; }
  }



  // ---- index and body recovery (recovery.ts: settleIndex, rebuildIndex) --------------------------------
  /** Rebuild the index from the body (recovery.ts holds the work); Damaged means the caller quarantines. */
  private async rebuildIndex(key: string, reason: string): Promise<RebuildResult> {
    const dir = this.vdir(key);
    const meta = await readMeta(this.fs, dir);
    if (!meta) throw new StoreError('unknown-version', key.slice(0, 8));
    const seeds = this.seedFn({ chatId: meta.chatId, version: unhex(key), segment: 0 });
    const ck0 = (await readCheckpoint(this.fs, dir));
    const convStale = (await this.fs.exists(nodePath.join(dir, STALE_CONV_FILE))) || (ck0 !== null && ck0.stamp === ((this.stamp ^ 0x80000000) >>> 0));
    // the only record of what was evicted on purpose is the checkpoint's (review 4): never evicted.json, never "which chunk files exist"
    const hint = ck0 && ck0.evLines > 0 ? { lines: ck0.evLines, bytes: ck0.evBytes } : null;
    const res = await this.tools.rebuildIndex(dir, meta.runtime, seeds, { hint }, this.stamp, { convStale });
    void reason;
    return res;
  }


  /** quarantine(), but a full disk (no room for the note of intent) still reports `damaged`: nothing was moved, and the next load with space does it. */
  private async quarantineOrReport(key: string, reason: string): Promise<never> {
    try { return await this.quarantine(key, reason); }
    catch (e) { if (isDiskFull(e)) throw new StoreError('damaged', 'pending (the disk is full): ' + reason); throw e; }
  }

  /** Move the whole version (index AND bodies) to aside/<vhex>-q<n>, mark it damaged, report it. Never deletes. */
  private async quarantine(key: string, reason: string): Promise<never> {
    const dir = this.vdir(key);
    const asideName = await nextAsideName(this.fs, this.root, key, true);
    await mkdirDurable(this.fs, nodePath.join(this.root, 'aside', asideName));   // the space-needing step first: a later read that has to finish the move then needs none
    await writeSideFor(this.fs, nodePath.join(dir, 'aside.intent'), key, { asideName, reason }); // DESTRUCTIVE-OK(hint): a note of intent; load() finishes the move it names
    this.versions.delete(key);
    await this.finishAside(key, dir);
    throw new StoreError('damaged', asideName);
  }




  private async recAtDir(dir: string, n: number): Promise<Rec> {
    const f = await this.fs.open(this.ixPath(dir), { create: false });
    try { return this.mustRec(await f.read(recPos(n), REC)); } finally { await f.close(); }
  }
  private async readAt(path: string, pos: number, len: number): Promise<Buffer> {
    const f = await this.fs.open(path, { create: false });
    try { return await f.read(pos, len); } finally { await f.close(); }
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
        let take = Math.min(256, end - n, maxRecs - recs);
        const buf = await f.read(recPos(n), take * REC);
        // records first: a bad one must be reported as repairable index damage before any body read trips over it
        for (let i = 0; i < take; i++) if (!decodeRecord(buf, i * REC)) throw new NeedsRebuild(`record ${n + i} fails its checksum`);
        const lo = Math.max(n, st.evictedLines);
        // WHY the fallback (review 4, F3): a hole in the chunk files makes a batch read fail as a whole. Find the first line that cannot be read, serve the checks for
        // the whole lines before it, and flag it like any line whose bytes do not match (`badLine`; a correct resend heals it).
        let bodies: Buffer[] = [];
        if (lo < n + take) {
          try { bodies = await this.readRange(st, lo, n + take, false); }
          catch (e) {
            if (!(e instanceof StoreError && e.code === 'corrupt') && (e as { code?: string } | null)?.code !== 'ENOENT') throw e;
            let k = lo;
            for (; k < n + take; k++) { try { await this.readRange(st, k, k + 1, false); } catch (e2) { if ((e2 instanceof StoreError && e2.code === 'corrupt') || (e2 as { code?: string } | null)?.code === 'ENOENT') break; throw e2; } }
            st.badLine = st.badLine === null ? k : Math.min(st.badLine, k);
            if (k === lo) { st.scrubMark = k; if (st.scrubMark !== startN) await this.saveScrubMark(st); return report(); }
            take = k - n; bodies = await this.readRange(st, lo, k, false);
          }
        }
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
    try { await writeSideFor(this.fs, nodePath.join(st.dir, 'scrub.json'), st.key, { lines: st.scrubMark, passEnd: st.passEnd }); } // DESTRUCTIVE-OK(hint): a progress mark; losing it only repeats work
    catch (e) { if (!isDiskFull(e)) throw e; }
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
            try { await this.rebuildIndex(key, e.reason); } catch (e2) { if (e2 instanceof Damaged) await this.quarantineOrReport(key, e2.reason); throw e2; }
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
      await this.repairBodies(st, fromLine, lines.slice(0, overlap), st.evictedLines);
      // WHY (review 4): `ok` for lines that are already stored is an ACKNOWLEDGEMENT, and the checkpoint is the record of what was acknowledged. Lines can sit beyond it: an append
      // that failed on a full disk wrote them but not its statement, and the reload could not repair that (a read never fails for lack of space). The statement is written now,
      // before the answer; if that fails the caller gets the error, not an `ok`.
      if (!st.ck.ck || st.ck.ck.count < fromLine + overlap) {
        await appendCheckpoint(this.fs, st.dir, st.ck, { count: st.count, stamp: st.staleConv ? (this.stamp ^ 0x80000000) >>> 0 : this.stamp, evLines: st.evictedLines, evBytes: st.evictedBytes, h: st.h, c: st.c });
      }
    }
    const fresh = lines.slice(overlap);
    if (fresh.length) await this.writeNew(st, fresh);
    return 'ok';
  }

  /**
   * For lines [from, from+good.length) (below `floor` nothing is expected: evicted lines have no body): make the stored bytes the chain-correct ones.
   *  - a line whose bytes differ: the bad bytes are kept under healed/ first, then overwritten in place;
   *  - a line whose bytes are NOT THERE (a missing or short chunk file, review 4 F3/F4): written back, coalesced into runs, into the chunk file that holds or
   *    touches that place, or into a new chunk file named by the line's own offset. No file is ever recreated from zeros and no other line is touched.
   * The caller has already checked every `good` line against the index's chain values (applyLines, restoreBody).
   */
  private async repairBodies(st: VState, from: number, good: Buffer[], floor: number): Promise<void> {
    const lo = Math.max(from, floor); const hiLine = from + good.length;
    let run: { offset: number; parts: Buffer[]; len: number } | null = null;
    let wrote = false;
    const flush = async (): Promise<void> => { if (run) { const r = run; run = null; wrote = true; await this.writeAt(st, r.offset, Buffer.concat(r.parts)); } };
    const isMissing = (e: unknown): boolean => (e instanceof StoreError && e.code === 'corrupt') || (e as { code?: string } | null)?.code === 'ENOENT';
    for (let a = lo; a < hiLine;) {
      const b = Math.min(hiLine, a + 256);
      let stored: (Buffer | null)[];
      try { stored = await this.readRange(st, a, b, false); }
      catch (e) {
        if (!isMissing(e)) throw e;
        stored = [];
        for (let k = a; k < b; k++) { try { stored.push((await this.readRange(st, k, k + 1, false))[0]); } catch (e2) { if (!isMissing(e2)) throw e2; stored.push(null); } }
      }
      const f = await this.fs.open(this.ixPath(st.dir), { create: false });
      let recs: Buffer; try { recs = await f.read(recPos(a), (b - a) * REC); } finally { await f.close(); }
      for (let k = 0; k < b - a; k++) {
        const line = a + k; const want = good[line - from]; const have = stored[k];
        if (have && have.equals(want)) { await flush(); continue; }
        const r = this.mustRec(recs, k * REC);
        if (want.length !== r.len) throw new StoreError('corrupt', `line ${line}: the index length disagrees with the chain-correct bytes`);
        if (have) {
          await flush();
          const hd = nodePath.join(st.dir, 'healed');
          await mkdirDurable(this.fs, hd);
          // DESTRUCTIVE-OK(kept-copy-first): the bad bytes are saved under a NEW name (never reused) before they are overwritten below
          await writeFileAtomic(this.fs, nodePath.join(hd, await nextNumbered(this.fs, hd, `line-${line}-`, '.bin', 1)), have);
          // DESTRUCTIVE-OK(verified-record): `want` hashes to the index record's chain value (checked by the caller) and the bytes replaced were saved to healed/ above
          wrote = true; await this.writeAt(st, r.offset, want);
        } else if (run && run.offset + run.len === r.offset && !st.chunks.some((c) => c > run!.offset && c <= r.offset)) { run.parts.push(want); run.len += want.length; }
        else { await flush(); run = { offset: r.offset, parts: [want], len: want.length }; }
        if (st.scrubMark > line) st.scrubMark = line; // re-check from the healed line
      }
      a = b;
    }
    await flush();
    if (!wrote) return;                                                // a resend that found everything in place changes nothing (and costs no directory scan)
    // the first line that is still not readable may now be a later one (or none)
    if (st.badLine !== null && st.badLine >= lo && st.badLine < hiLine) st.badLine = null;
    const gb = await this.gapBadLine(st);
    if (gb !== null) st.badLine = st.badLine === null ? gb : Math.min(st.badLine, gb);
  }

  /** The first line whose bytes are not in any chunk file (a hole from the eviction point on), or null. */
  private async gapBadLine(st: VState): Promise<number | null> {
    if (st.count <= st.evictedLines) return null;
    const gs = this.tools.gapStart(await this.tools.layout(st.dir), st.evictedBytes, st.bodyEnd);
    return gs === null ? null : this.tools.firstLineEndingAfter(st.dir, st.evictedLines, st.count, gs);
  }

  /**
   * Put `data` at logical byte `offset` of the body. Into the last chunk file that starts at or before it when that file reaches the offset (an in-place overwrite
   * or a contiguous extension); otherwise into a NEW chunk file named by `offset`. The caller has proved `data` hashes to the index record's chain value.
   */
  private async writeAt(st: VState, offset: number, data: Buffer): Promise<void> {
    let ci = -1;
    for (let i = 0; i < st.chunks.length; i++) { if (st.chunks[i] <= offset) ci = i; else break; }
    if (ci >= 0) {
      const cs = st.chunks[ci];
      const cf = await this.fs.open(this.chunkPath(st, cs), { create: false });
      try {
        if (cs + (await cf.size()) >= offset) { await cf.write(data, offset - cs); await cf.sync(); return; }   // DESTRUCTIVE-OK(verified-record): see the doc comment above
      } finally { await cf.close(); }
    }
    const nf = await this.fs.open(this.chunkPath(st, offset), { create: true });
    try { await nf.write(data, 0); await nf.sync(); } finally { await nf.close(); }
    await this.fs.fsyncDir(st.dir);
    if (!st.chunks.includes(offset)) { st.chunks.push(offset); st.chunks.sort((x, y) => x - y); }
  }

  /** Append lines that continue the head. Body first, fsync, then index, fsync, then the checkpoint, fsync (crash rule 1), and only then acknowledge. */
  private async writeNew(st: VState, fresh: Buffer[]): Promise<void> {
    // N5 / review 3 F7: a copy-then-cut that could not be done while reading is retried first; still impossible: refused, typed (disk-full or limit)
    if (st.deferred) await this.runDeferred(st);
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
    // WHY (review 4, F3): an active chunk that is SHORTER than the index says lost its tail to a fault. New lines must not be written at a position past its end (that would
    // zero-fill the hole and the guard below would refuse every append): they start a NEW chunk at the head. The hole stays reported and a correct resend fills it.
    else if (st.tailShort) {
      if ((await this.tools.fileSize(this.chunkPath(st, active))) < st.bodyEnd - active) { chunkStart = st.bodyEnd; created = !st.chunks.includes(chunkStart); } else st.tailShort = false;
    }
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
    // WHY the checkpoint BEFORE the acknowledgement, every time (review 3, F3/F9): it is the independent record that says which lines were
    // acknowledged. If it fails, the lines stay (they are whole and valid, just not acknowledged), the append reports the error, the cached state
    // is dropped, and the caller's retry finds them already stored. No rollback here: a rollback after a checkpoint that may have landed would leave it ahead of the index.
    await appendCheckpoint(this.fs, st.dir, st.ck, { count: bs.count, stamp: st.staleConv ? (this.stamp ^ 0x80000000) >>> 0 : this.stamp, evLines: st.evictedLines, evBytes: st.evictedBytes, h: bs.h, c: bs.c });
    // acknowledged: now update memory
    if (created) st.chunks.push(chunkStart);
    st.tailShort = false;                                       // the chunk just written to ends exactly at the new body end
    st.count = bs.count; st.h = bs.h; st.c = bs.c; st.convCount = bs.convCount; st.bodyEnd = bs.off; st.rs = bs.rs;
    if (st.replyEndsCache) st.replyEndsCache.push(...confirmedNow);
    const changed = sum.title !== st.summary.title || sum.model !== st.summary.model || sum.cwd !== st.summary.cwd;
    st.summary = { title: sum.title, model: sum.model, cwd: sum.cwd, lastAppendMs: this.now(), lines: st.count };
    st.summaryDirty = true;
    // From here the lines ARE durable. A full disk for the small side files is not a failed append (they are rebuilt on load).
    try {
      // The summary file is only rewritten when a fact in it changed, to keep a live append at three small syncs.
      // Counts come from the index; arrival time is written at close and may lag by a few appends after a crash.
      if (changed || st.count - st.summarySavedAt >= SUMMARY_SAVE_EVERY) await this.saveSummary(st);
      if (st.partial && st.count >= st.partial.fromLine + st.partial.lost) { await this.fs.unlink(nodePath.join(st.dir, PARTIAL_FILE)); await this.fs.unlink(nodePath.join(st.dir, PARTIAL_COPY)); await this.fs.fsyncDir(st.dir); st.partial = null; } // DESTRUCTIVE-OK(hint): the lines the marker said were missing have been filled
    } catch (e) { if (!isDiskFull(e)) throw e; }
  }

  /** Do now what a read had to postpone (a copy to torn/ and a cut). Throws the typed error again when it still cannot be done. */
  private async runDeferred(st: VState): Promise<void> {
    const d = st.deferred!;
    if (d.partial) await writePartial(this.fs, st.dir, { ...d.partial, atMs: this.now() }); // DESTRUCTIVE-OK(hint): a marker; replaces an older marker of the same kind
    if (d.indexTail) {
      const f = await this.fs.open(this.ixPath(st.dir), { create: false });
      try {
        const size = await f.size();
        if (size > recPos(st.count)) {
          await this.tools.keepBytes(st.dir, 'index-tail', await f.read(recPos(st.count), size - recPos(st.count)));
          await f.truncate(recPos(st.count)); await f.sync(); // DESTRUCTIVE-OK(kept-copy-first): the cut-off bytes were copied to torn/ and fsynced on the line above
        }
      } finally { await f.close(); }
    }
    if (d.trimTo !== null) await this.tools.trimBody(st.dir, d.trimTo, true);
    st.deferred = null;
  }

  /** Cut back what a failed append added: the body to where it was, the index to its old record count. */
  private async rollbackAppend(st: VState, chunkStart: number, created: boolean): Promise<void> {
    const path = this.chunkPath(st, chunkStart);
    if (await this.fs.exists(path)) {
      const bf = await this.fs.open(path, { create: false });
      // DESTRUCTIVE-OK(rollback-own-bytes): cuts back only what THIS failed call appended (size checked against the in-memory state before the write)
      try { if ((await bf.size()) > st.bodyEnd - chunkStart) { await bf.truncate(st.bodyEnd - chunkStart); await bf.sync(); } } finally { await bf.close(); }
      // DESTRUCTIVE-OK(rollback-own-bytes): the chunk file this failed call created, still empty
      if (created && st.bodyEnd - chunkStart === 0) { await this.fs.unlink(path); await this.fs.fsyncDir(st.dir); }
    }
    const xf = await this.fs.open(this.ixPath(st.dir), { create: false });
    // DESTRUCTIVE-OK(rollback-own-bytes): the index records this failed call appended
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
    // WHY the version tag in front (review 4, class fix): a parked file copied in from another version has a good checksum and a content-derived name; applied, it would put
    // another chat's lines at the head of this one. The tag makes it foreign (moved to rejected/, never applied).
    const data = Buffer.concat([versionTag(st.key), frameLines(lines)]);
    if (st.parked.has(name)) {
      // WHY not simply "already parked" (the file could have rotted since): an intact copy is enough, a damaged one is kept in rejected/ and replaced
      const have = await this.fs.readFile(nodePath.join(st.dir, 'parked', name));
      if (have && have.equals(data)) return;
      if (have) await this.moveAway(st, nodePath.join(st.dir, 'parked', name), name, true); else this.forgetParked(st, name);
    }
    if (st.parked.size >= this.maxParkedFiles) throw new StoreError('parked-full', `${st.key.slice(0, 8)}: ${st.parked.size} parked files`);
    if (st.parkedBytes + data.length > this.maxParked) throw new StoreError('parked-full', st.key.slice(0, 8));
    const dir = nodePath.join(st.dir, 'parked');
    await mkdirDurable(this.fs, dir);
    // DESTRUCTIVE-OK(verified-record): the name is derived from the lines' hash, so a file of this name holds the same lines; a rotted one was moved to rejected/ above
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
        const lines = raw && raw.length > 16 && raw.subarray(0, 16).equals(versionTag(st.key)) ? unframeLines(raw.subarray(16)) : null;
        if (!lines) { if (await this.moveAway(st, path, name)) progressed = true; else skip.add(name); continue; }
        const res = await this.applyLines(st, from, lines);
        if (res === 'not-a-prefix') { if (await this.moveAway(st, path, name)) progressed = true; else skip.add(name); }
        // DESTRUCTIVE-OK(verified-record): the file passed its CRC and carried THIS version's identity tag when read above and applyLines returned `ok` (lines compared with the chain, fresh ones fsynced), so every line in it is in the version
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
  private async moveAway(st: VState, path: string, name: string, damaged = false): Promise<boolean> {
    const rej = nodePath.join(st.dir, 'rejected');
    await mkdirDurable(this.fs, rej);
    if ((await this.fs.readdir(rej)).length >= MAX_REJECTED) return false;
    // N11: a byte cap as well as a file cap (a junk park can be hundreds of MB); at the cap it stays in parked/, counting toward that cap
    if ((await this.bytesUnder(rej)) + (st.parked.get(name) ?? 0) > this.maxRejectedBytes) return false;
    // WHY a free name: a rename onto an existing rejected copy would destroy it. The name is content-derived, so the same name means the same bytes, except when a copy rotted.
    let target = nodePath.join(rej, name);
    if (damaged || await this.fs.exists(target)) target = nodePath.join(rej, await nextNumbered(this.fs, rej, 'older-', `-${name}`, 1));
    // DESTRUCTIVE-OK(kept-copy-first): a rename to a name nothing uses; the parked bytes are kept in rejected/, never deleted
    await this.fs.rename(path, target);
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
    await writeSideFor(this.fs, nodePath.join(st.dir, 'summary.json'), st.key, { ...st.summary, lines: st.count }); // DESTRUCTIVE-OK(hint): a cache of facts the index and bodies can recompute
    st.summarySavedAt = st.count; st.summaryDirty = false;
  }

  /** Load the saved summary and replay any lines it has not seen (needs their bodies; stays stale if evicted). */
  private async loadSummary(st: VState): Promise<void> {
    const r = await readSideFor(this.fs, nodePath.join(st.dir, 'summary.json'), st.key);
    let from = 0;
    if (r.kind === 'ok' && r.value && typeof r.value === 'object') {
      const m = r.value;
      st.summary = { title: m.title ?? null, model: m.model ?? null, cwd: m.cwd ?? null, lastAppendMs: m.lastAppendMs ?? null, lines: Number(m.lines) || 0 };
      from = st.summary.lines <= st.count ? st.summary.lines : 0;
    }   // absent or damaged: everything is recomputed below
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
          // WHY the catch (review 4): a line whose body is not on disk (a hole in the chunk files) leaves its fact as last saved; it must not make the version unloadable
          let body: Buffer;
          try { body = (await this.readRange(st, n + i, n + i + 1, false))[0]; } catch (e) { if (e instanceof StoreError && e.code === 'corrupt') continue; throw e; }
          const info = analyseLine(st.meta.runtime, body);
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
        if (!/^[0-9a-f]{2,128}$/.test(key) || key.length % 2) continue;
        let base: { version: Buffer; chatId: string | null; runtime: RuntimeKind | null; parent: Buffer | null } = { version: unhex(key), chatId: null, runtime: null, parent: null };
        try {
          const meta = await this.readMetaIfPresent(this.vdir(key)); // registration may never have finished
          if (!meta) continue;
          base = { version: unhex(key), chatId: meta.chatId, runtime: meta.runtime, parent: meta.parent ? unhex(meta.parent) : null };
          const dmg = await readDamaged(this.fs, this.vdir(key));
          if (dmg) { out.push({ ...base, head: null, damaged: dmg.asideName }); continue; }
          let st = this.versions.get(key);
          if (!st) { st = await this.load(key); this.versions.set(key, st); }
          out.push({ ...base, head: this.headOf(st), damaged: null });
        } catch (e) {
          this.versions.delete(key);
          if (e instanceof StoreError && e.code === 'damaged') { out.push({ ...base, head: null, damaged: (await readDamaged(this.fs, this.vdir(key)).catch(() => null))?.asideName ?? 'damaged' }); continue; }
          out.push({ ...base, head: null, damaged: `unreadable: ${e instanceof StoreError ? e.code : ((e as { code?: string })?.code ?? 'error')}` });
        }
      }
      return out;
    });
  }
  private async readMetaIfPresent(dir: string) { return (await this.fs.exists(nodePath.join(dir, 'meta.json'))) || (await this.fs.exists(nodePath.join(dir, 'meta.copy'))) ? readMeta(this.fs, dir) : null; }

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
        // WHY (review 4, F6): a `.done` marker with no tail file means the tail (the only copy of the cut lines) was lost. A retry must not write an empty valid tail over
        // that evidence; it is reported, and nothing is written.
        if (!existing && await this.fs.exists(nodePath.join(dir, `${takeoverId}.done`))) throw new StoreError('corrupt', 'the saved tail file is missing although the cut was marked done');
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
        await writeFileAtomic(this.fs, path, encodeTailFile(header, lines)); // DESTRUCTIVE-OK(kept-copy-first): a NEW file (checked absent above)
        // WHY read it back before cutting: the cut deletes the only other copy of these lines, so it acts on the bytes that are really in the tail file
        const back = await this.readTailFile(path);
        if (!back || back.lines.length !== lines.length || !back.lines.every((l, i) => l.equals(lines[i]))) throw new StoreError('corrupt', 'the tail file does not read back as written; nothing was cut');
        if (st.count > from) await this.cutTo(st, from);
        await this.markCutDone(dir, takeoverId);
        return { lines: lines.length };
      }));
    });
  }

  private async markCutDone(dir: string, takeoverId: string): Promise<void> {
    await writeFileAtomic(this.fs, nodePath.join(dir, `${takeoverId}.done`), Buffer.from('cut done\n')); // DESTRUCTIVE-OK(hint): an existence-only marker
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
          if (!t && await this.fs.exists(nodePath.join(this.vdir(key), 'tails', `${takeoverId}.done`))) throw new StoreError('corrupt', 'the saved tail file is missing although the cut was marked done');
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
    if (st.ck.ck && st.ck.ck.count > n) {
      // DESTRUCTIVE-OK(verified-record): lowers the statement to the chain value of record n-1, read from the checksummed index; the caller saved the cut lines in a verified tail file
      await writeCheckpoint(this.fs, st.dir, { count: n, stamp: st.staleConv ? (this.stamp ^ 0x80000000) >>> 0 : this.stamp, evLines: st.evictedLines, evBytes: st.evictedBytes, h: lastKept ? lastKept.h : st.seeds.raw, c: lastKept ? lastKept.c : st.seeds.conversation }, st.ck);
    }
    const f = await this.fs.open(this.ixPath(st.dir), { create: false });
    // DESTRUCTIVE-OK(kept-copy-first): the lines past n were saved in a tail file that was read back and compared before this call (setAsideTail)
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
        try { if (!(await readMeta(this.fs, dir))) throw new StoreError('unknown-version', key.slice(0, 8)); }
        catch (e) { if (e instanceof StoreError && e.code === 'corrupt') metaBad = true; else throw e; }
        const dmg = await readDamaged(this.fs, dir);
        if (dmg) {
          // WHY the check: the marker may only be cleared when the quarantined copy it names is really there (a cross-check, not the marker's say-so)
          const asideOk = dmg.asideName === 'unknown' || await this.fs.exists(nodePath.join(this.root, 'aside', dmg.asideName));
          if (!asideOk) throw new StoreError('corrupt', `the quarantined copy ${dmg.asideName} is missing; the damaged marker is kept`);
          for (const n of ['damaged.json', DAMAGED_COPY]) {
            const mp = nodePath.join(dir, n);
            if (!(await this.fs.exists(mp))) continue;
            if (dmg.asideName === 'unknown') await keepBadSideFile(this.fs, mp);
            else await this.fs.unlink(mp); // DESTRUCTIVE-OK(explicit-request): the caller asked for the marker to be cleared; the aside copy it names was found above
          }
          await this.fs.fsyncDir(dir);
          this.versions.delete(key);
          await this.ensureIndex(dir);
          return { asideName: dmg.asideName };
        }
        const asideName = await nextAsideName(this.fs, this.root, key, false);
        await mkdirDurable(this.fs, nodePath.join(this.root, 'aside', asideName));   // the space-needing step first (see quarantine)
        await writeSideFor(this.fs, nodePath.join(dir, 'aside.intent'), key, metaBad ? { asideName, moveMeta: true } : { asideName }); // DESTRUCTIVE-OK(hint): a note of intent; load() finishes the move it names
        this.versions.delete(key);
        await this.finishAside(key, dir);
        return { asideName };
      }));
    });
  }

  private async finishAside(key: string, dir: string): Promise<void> {
    const intentPath = nodePath.join(dir, 'aside.intent');
    const ir = await readSide(this.fs, intentPath);
    if (ir.kind === 'absent') return;
    // WHY (review 4, class fix): an intent is a note that exists only while a move is in flight. One that names ANOTHER version is a foreign copy, and one whose aside
    // folder already carries the COMPLETE mark (written last, just before the note is removed) is an older copy of a note that did its job. Acting on either would move
    // a healthy version aside. Both are kept as aside.intent.bad-N and ignored. (An intent that merely fails its checksum is still finished, below.)
    if (ir.kind === 'ok' && ir.value?.version !== key) { await keepBadSideFile(this.fs, intentPath); return; }
    if (ir.kind === 'ok' && typeof ir.value?.asideName === 'string' && ASIDE_RE.test(ir.value.asideName) && await this.fs.exists(nodePath.join(this.root, 'aside', ir.value.asideName, 'COMPLETE'))) { await keepBadSideFile(this.fs, intentPath); return; }
    let { asideName, reason, moveMeta } = (ir.kind === 'ok' && ir.value ? ir.value : {}) as { asideName?: string; reason?: string; moveMeta?: boolean };
    // WHY not an error when the note is unreadable (review 3, class fix): the move still has to be finished, and a version must never be wedged by it. A fresh aside
    // name is chosen and the version reports `damaged` until the caller clears it; the files already moved stay where they are.
    if (typeof asideName !== 'string' || !ASIDE_RE.test(asideName)) { asideName = await nextAsideName(this.fs, this.root, key, true); reason = 'the set-aside note was unreadable'; moveMeta = false; }
    const target = nodePath.join(this.root, 'aside', asideName);
    await mkdirDurable(this.fs, target);
    for (const name of await this.fs.readdir(dir)) {
      if (name === 'index.bin' || name === 'index.rebuild' || name === 'evicted.json' || name === 'summary.json' || name === 'scrub.json' || name === CHECKPOINT_FILE || name === PARTIAL_FILE || name === PARTIAL_COPY || name === STALE_CONV_FILE || (moveMeta && (name === 'meta.json' || name === 'meta.copy')) || /^body-[0-9a-f]{16}\.bin$/.test(name)) {
        // WHY never overwrite (H2): a rename over an existing aside file would destroy the very copy being kept.
        // The aside copy already holds this file, so the move happened before; what is in the version
        // folder is newer and stays where it is.
        if (await this.fs.exists(nodePath.join(target, name))) continue;
        // DESTRUCTIVE-OK(kept-copy-first): a rename to a name that does not exist in the aside copy; the bytes are kept there
        await this.fs.rename(nodePath.join(dir, name), nodePath.join(target, name));
      }
    }
    await this.fs.fsyncDir(target); await this.fs.fsyncDir(dir);
    // WHY (review 3, F7): reading must not fail because the disk is full. With no room for the marker the version is still reported `damaged` (typed), and the intent stays so the marker is written when space returns.
    try { if (reason !== undefined) await writeDamaged(this.fs, dir, { asideName, reason, atMs: this.now() }); } // DESTRUCTIVE-OK(hint): the marker that says where the copy went
    catch (e) { if (!isDiskFull(e)) throw e; throw new StoreError('damaged', asideName); }
    // WHY the intent goes BEFORE the fresh index (H2): once the moves are durable the intent has done its job.
    // If it outlived the fresh index, a rerun would move that new empty index over the aside copy's index.
    try {
      await writeFileAtomic(this.fs, nodePath.join(target, 'COMPLETE'), Buffer.from('complete\n')); // DESTRUCTIVE-OK(hint): a NEW existence-only mark in the aside folder; it lets a later reader tell this finished note from a live one
      await this.fs.unlink(nodePath.join(dir, 'aside.intent')); // DESTRUCTIVE-OK(hint): the note has done its job; every move it described is durable
      await this.fs.fsyncDir(dir);
    } catch (e) {
      // WHY (review 3 F7 again): a read must not fail for lack of space. The note stays (every step it describes is repeatable) and is finished when space returns.
      if (!isDiskFull(e)) throw e;
      if (reason !== undefined) throw new StoreError('damaged', asideName);
      return;
    }
    // a version whose meta.json was garbage has no registration any more (the caller registers it again): no index to create
    if (reason === undefined && !moveMeta) { try { await this.ensureIndex(dir); } catch (e) { if (!isDiskFull(e)) throw e; } }   // a full disk: the empty version is served, the first append creates the index
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
        if (proof.through <= st.evictedLines) {
          // Nothing new to evict. A kill between the eviction record and the unlinks leaves chunk files that lie wholly below the evicted bytes; load never removes them
          // (review 4, F1: only a CURRENT proof may justify an unlink). This proof is current and bound to this chain value, so it finishes that job.
          const f0 = await this.fs.open(this.ixPath(st.dir), { create: false });
          let upTo: number; try { const r = this.mustRec(await f0.read(recPos(proof.through - 1), REC)); upTo = r.offset + r.len; } finally { await f0.close(); }
          return { evictedLines: st.evictedLines, freedBytes: await this.dropChunksBelow(st, upTo) };
        }
        // never drop the last good copy of bytes that no longer match their chain value
        const bad = await this.firstBadBody(st, st.evictedLines, proof.through);
        if (bad !== null) throw new StoreError('corrupt', `line ${bad}: body bytes do not match the chain; not evicting`);
        const f = await this.fs.open(this.ixPath(st.dir), { create: false });
        let byteAt: number;
        try { const r = this.mustRec(await f.read(recPos(proof.through - 1), REC)); byteAt = r.offset + r.len; } finally { await f.close(); }
        // 1. the eviction record, inside the checkpoint (both slots, atomic enough: each slot is its own checksummed write) 2. the holders' note 3. unlink the chunks wholly
        // below it. A kill between 1 and 3 leaves chunk files that a later proof removes; nothing is ever removed on load.
        // DESTRUCTIVE-OK(verified-record): a proven eviction; `byteAt` is read from the checksummed index record of the last evicted line; the new statement keeps the head's own chain values
        await writeCheckpoint(this.fs, st.dir, { count: st.count, stamp: st.staleConv ? (this.stamp ^ 0x80000000) >>> 0 : this.stamp, evLines: proof.through, evBytes: byteAt, h: st.h, c: st.c }, st.ck);
        st.evictedLines = proof.through; st.evictedBytes = byteAt;
        await writeSideFor(this.fs, nodePath.join(st.dir, 'evicted.json'), st.key, { lines: proof.through, bytes: byteAt, hash: proof.hash, holders: proof.acks.map((a) => a.holder), atMs: this.now() }); // DESTRUCTIVE-OK(hint): a record of who held the lines; nothing is decided from it
        const freed = await this.dropChunksBelow(st, byteAt);
        return { evictedLines: st.evictedLines, freedBytes: freed };
      }));
    });
  }

  /** Unlink the chunk files that lie wholly below byte `upTo` (the caller holds a proof that justifies it). Returns the bytes freed. */
  private async dropChunksBelow(st: VState, upTo: number): Promise<number> {
    let freed = 0; const keep: number[] = [];
    for (let i = 0; i < st.chunks.length; i++) {
      const end = i + 1 < st.chunks.length ? st.chunks[i + 1] : st.bodyEnd;
      // DESTRUCTIVE-OK(verified-record): the CALLER'S proof (this very call: evictBody, or a later proof that finishes an interrupted eviction) was accepted by the verifier and bound to this chain value; load never reaches here, so no marker that was merely true once can unlink a body
      if (end <= upTo) { freed += end - st.chunks[i]; await this.fs.unlink(this.chunkPath(st, st.chunks[i])); } else keep.push(st.chunks[i]);
    }
    if (keep.length !== st.chunks.length) await this.fs.fsyncDir(st.dir);
    st.chunks = keep;
    return freed;
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
        // WHY the second mode (review 4): the eviction record can be LOST (a missing, damaged or older checkpoint) while the bodies really are gone. The store then reports those lines
        // damaged, and a caller who asks for the bodies back must get them: with no eviction in force, "restore" repairs whatever lines the caller supplies that are not on disk.
        let E = st.evictedLines;
        if (E === 0) {
          if ((await this.gapBadLine(st)) === null) return { restoredLines: 0 };
          E = Math.min(ls.length, st.count);
          if (E === 0) return { restoredLines: 0 };
        }
        if (ls.length < E) throw new StoreError('bad-argument', 'need every evicted line, from line 0');
        // the restored region is [0, S) where S is where the earliest surviving chunk starts (or the end of data)
        const S = st.chunks.length ? st.chunks[0] : st.bodyEnd;
        const f = await this.fs.open(this.ixPath(st.dir), { create: false });
        const parts: Buffer[] = []; let h: Buffer = st.seeds.raw;
        try {
          for (let n = 0; n < E;) {
            const take = Math.min(SCAN_BATCH, E - n);
            const buf = await f.read(recPos(n), take * REC);
            for (let i = 0; i < take; i++, n++) {
              const r = this.mustRec(buf, i * REC);
              h = chainStep(h, ls[n]);
              if (!h.equals(r.h)) throw new StoreError('bad-argument', `line ${n} does not match this store's chain`);
              if (r.offset < S) parts.push(ls[n]);
            }
          }
        } finally { await f.close(); }
        // The common case: every chunk file below the boundary was freed, so the whole region [0, S) is one new chunk file written in one go. Whatever else is not
        // right (a rotted byte in the boundary chunk, a missing chunk in the middle: review 4, F7) is repaired line by line below.
        // DESTRUCTIVE-OK(verified-record): no chunk file starts at or before 0 here (S > 0); the bytes were checked line by line against the index above
        if (S > 0 && parts.length) await this.writeAt(st, 0, Buffer.concat(parts));
        await this.repairBodies(st, 0, ls.slice(0, E), 0);
        // WHY the read-back (review 4, F7): "restored" must mean the lines read back from disk byte for byte. Only then is the eviction record cleared.
        await this.readRange(st, 0, E, true);
        if (st.evictedLines > 0) {
          // DESTRUCTIVE-OK(verified-record): every evicted line was just verified against the chain and read back from disk
          await writeCheckpoint(this.fs, st.dir, { count: st.count, stamp: st.staleConv ? (this.stamp ^ 0x80000000) >>> 0 : this.stamp, evLines: 0, evBytes: 0, h: st.h, c: st.c }, st.ck);
          await writeSideFor(this.fs, nodePath.join(st.dir, 'evicted.json'), st.key, { lines: 0, bytes: 0 }); // DESTRUCTIVE-OK(hint): the holders' note; nothing is decided from it
          st.evictedLines = 0; st.evictedBytes = 0;
        }
        // the lines just written back are no longer damaged; a hole further on (lines the caller did not supply) still is
        if (st.badLine !== null && st.badLine < E) st.badLine = null;
        const gb = await this.gapBadLine(st);
        if (gb !== null) st.badLine = st.badLine === null ? gb : Math.min(st.badLine, gb);
        // N4: with the bodies back the conversation chain can be recomputed: drop the cached state so the next call rebuilds it
        if (st.staleConv) this.versions.delete(key);
        return { restoredLines: E };
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
          const lay = await this.tools.layout(st.dir);
          if (Math.max(lay.phys, st.evictedBytes) !== st.bodyEnd) return fail(st.count, 'body end');
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
