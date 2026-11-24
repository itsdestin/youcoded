// Seam S2: the chat store. On disk under a caller-supplied root; pure library, called by nothing yet.
//
// THE ONE INVARIANT. Every acknowledged line is either served byte-identical, or reported as damaged/evicted/rolled back with its bytes still present somewhere under the root; never silently
// absent, never served wrong. No single-file fault and no single crash point may break this, where a file fault is ANY of: rotted bytes, an OLDER valid copy, a valid copy of the same kind that
// belongs to ANOTHER chat, version, position or id, the file missing, or the file cut short at a clean boundary.
//
// THE ENVELOPE RULE (review 5, the end of "a file that does not state what it is"): every small file is written and read through ONE helper (envelope.ts). Inside its checksum a file carries its
// role, the version key (or chat hash), the position or id it stands for, and where it applies a freshness counter; the reader compares every field with what the CALLER expects, never with the
// file name alone. A mismatch is typed `foreign` and the file is kept, never adopted, never deleted. The index header, the checkpoint slots and the body/chain values are the same rule in fixed-width
// binary (magic = role, version tag, record position, sequence number). inventory.ts lists every file, and matrix.test.ts swaps a valid same-kind sibling into every one of them.
//
// Honest limits (inventory.ts): (1) a fault that destroys the ONLY copy of some bytes (a body chunk, a control log, an extra, a kept tail) destroys them; the store never serves them wrong and always
// reports it so a peer's copy can heal it. (2) After an eviction AND the loss of the whole index, the chain values of the evicted lines are gone (the boundary survives in the checkpoint): the kept
// lines stay served and re-derived from their bodies. (3) Parked appends are provisional. (4) A whole chat folder put back is REPORTED against the high-water record kept outside it (highwater.ts);
// a rollback of the whole store root is undetectable. (5) Two faults are not promised, except that the store repairs every second copy it finds damaged AS IT LOADS.
//
// Layout (names computed from validated ids, never from peer strings): <root>/FORMAT, LOCK, highwater/<vhex>.hw, versions/<vhex>/ (meta.json+copy, index.bin, checkpoint.bin, marks.bin, summary.json,
// scrub.json, body-<startByte>.bin, parked/, rejected/, tails/, torn/, healed/, replaced-index/), aside/<vhex>-<n>/ and -q<n>/ (set-aside and quarantined copies), extras/, extras-bad/, control/<sha256(chat)>/.
//
// Crash rules: 1. A line exists exactly when its index record is whole and CRC-correct AND its body is on disk. An append writes BODY, fsync, INDEX, fsync, CHECKPOINT slot, fsync, and only then
// returns; the checkpoint is the independent record of what was acknowledged. 2. Whole-file replacements are temp file + fsync + rename + directory fsync; every NEW directory has its parent fsynced.
// 3. Multi-step operations (set aside, evict, restore) are ordered so that every prefix of their steps is a state open() understands. 4. After any failed operation the cached state of that version is dropped.
// Recovery: open() NEVER deletes or truncates an acknowledged line, and copies bytes to torn/ (fsynced) before any cut. A bad index tail is cut back (bytes kept); anything else is rebuilt from the bodies
// keeping every valid record, confirmed against the checkpoint (which, when the bodies reach exactly its chain value, is believed over an older index); a missing/short body costs exactly the lines it held;
// only an unresolvable disagreement quarantines the whole version (aside/<vhex>-q<n>/, typed `damaged`). A full disk is one typed `disk-full` refusal; reads never write anything that can fail.
// No file handles are kept open between calls. One in-process lock serialises all calls and lock.ts keeps other processes out.
import * as nodePath from 'node:path';
import { realFs, writeFileAtomic, sweepTemps, mkdirDurable, type Fs } from './fsio';
import { StoreError } from './errors';
import { acquireLock, type StoreLock } from './lock';

// DESTRUCTIVE-OK(hint): FORMAT is a constant; writing it replaces nothing that is not a constant
const writeSide0 = (fs: Fs, path: string, text: string): Promise<void> => writeFileAtomic(fs, path, Buffer.from(text));
import { readCheckpoint, readCheckpointState, appendCheckpoint, writeCheckpoint, type Boundary, type Checkpoint } from './checkpoint';
import { readSideFor, writeSideFor, keepBadSideFile, formatLine, parseFormat } from './sidefile';
import { readMarksState, readPartial, readDamaged, setMarks } from './marks';
import { resetHw, checkRollback, noteHw, lowerHwTo, readHw, recordTakeovers, type HwEnv } from './highwater';
import { Extras, bytesUnder } from './extras';
import { asLine, isDiskFull, validateProofShape, ForeignTail, type TailFile } from './storeutil';
import { setAsideTailLocked, readTailFile, readEpoch, tailWasProtected, takeoverIds, histCount, cutAwayBranchHit, lostTakeovers, LOST_TAIL, type TailEnv } from './tails';
import { chainStep, defaultChainSeeds, hex, unhex, versionTag, type ChainSeedFn, type RuntimeKind } from './chain';
import { CLASSIFIER_VERSION, analyseLine, initialReplyState, type ReplyEndOptions } from './classify';
import { HDR, REC, NONE, decodeRecord, indexHeader, recPos, unframeLines, type Rec } from './records';
import { Parked, parseRejectedName, type RejectReason } from './parked';
import { openEnv } from './envelope';
import { Asides } from './asides';
import { ControlStore, type ControlDamage, type ControlEntry } from './control';
import type { AppendResult, EvictionProof, Head, ProofVerifier, ScrubReport, StoreOptions, Summary, TailRecord, VerifyReport, VersionId, VersionMeta } from './types';
import type { VState } from './vstate';
import { readMeta, readScrubMark, lineVerifies } from './versionfiles';
import { BodyTools, Damaged, NeedsRebuild, chunkPathOf, nextNumbered, type BatchState, type RebuildResult, type SumFacts } from './recovery';

export type { VersionId, ProofVerifier, StoreOptions, VersionMeta, Head, AppendResult, Summary, EvictionProof, TailRecord, VerifyReport, ScrubReport } from './types';

const DEFAULT_CHUNK = 16 * 1024 * 1024;
const SCAN_BATCH = 4096;
const MIB = 1024 * 1024;
/** summary.json is also rewritten every this many lines even when no fact changed, so open() never re-scans far. */
const SUMMARY_SAVE_EVERY = 2048;
const TAKEOVER_RE = /^[0-9a-f]{8,128}$/;
/** Longest version id the store accepts (see keyOf). */
const MAX_VERSION_ID_BYTES = 64;
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
  private readonly parkedStore: Parked;
  private readonly asides: Asides;

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
    this.parkedStore = new Parked(this.fs, this.tools, { maxFiles: this.maxParkedFiles, maxBytes: this.maxParked, maxRejectedBytes: this.maxRejectedBytes, bytesUnder: (p) => this.bytesUnder(p) }, (st, from, lines) => this.applyLines(st, from, lines));
    this.asides = new Asides(this.fs, root, { forget: (k) => { this.versions.delete(k); }, ensureIndex: async (d) => { await this.ensureIndex(d); await this.ensureEmptyCheckpoint(d); }, resetHw: (k) => this.resetHwFor(k), rejectParks: (d) => this.parkedStore.rejectAllOnDisk(d) });
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
        await this.noteHw(st, st.count > st.hw.noted);   // the high-water record is also raised at close
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
        const m = { format: 1, chatId: meta.chatId, runtime: meta.runtime, parent, createdMs: this.now() };
        // WHY two copies, each checksummed (review 3, F5): one flipped letter of the chat id changes every chain seed, so every line would read as rotted.
        // Either copy alone is enough; a damaged one is replaced from the other (readMeta). Both are new files here (neither existed).
        await writeSideFor(this.fs, nodePath.join(dir, 'meta.json'), { role: 'meta', key }, m); // DESTRUCTIVE-OK(verified-record): a NEW file, the version had no meta
        await writeSideFor(this.fs, nodePath.join(dir, 'meta.copy'), { role: 'meta', key }, m); // DESTRUCTIVE-OK(verified-record): a NEW file, the version had no meta
        await this.ensureIndex(dir);
        // WHY a checkpoint from the very start: "no checkpoint" must always mean a fault, never "nothing was written yet" (review 3, F3)
        const seeds = this.seedFn({ chatId: meta.chatId, version: unhex(key), segment: 0 });
        // DESTRUCTIVE-OK(verified-record): only when no checkpoint exists yet (a new version has none)
        if (!(await readCheckpoint(this.fs, dir))) await writeCheckpoint(this.fs, dir, { count: 0, stamp: this.stamp, evLines: 0, evBytes: 0, boundary: null, lostRecs: 0, staleBad: null, hist: await histCount(this.fs, dir), h: Buffer.from(seeds.raw), c: Buffer.from(seeds.conversation) });
        await this.fs.fsyncDir(nodePath.join(this.root, 'versions'));
      }));
    });
  }

  /**
   * WHY (round 7, F1, found by the fuzz): a set-aside moves the checkpoint away with the rest and nothing wrote a new one, so the emptied version had NO checkpoint until its first append, and older index
   * and bodies put back into it had nothing to be compared with. The empty statement (count 0, the history count with the new aside folder in it) is written here, as at registration, so "no checkpoint" keeps meaning "a fault".
   */
  private async ensureEmptyCheckpoint(dir: string): Promise<void> {
    let meta: Awaited<ReturnType<typeof readMeta>> = null;
    try { meta = await readMeta(this.fs, dir); } catch (e) { if (!(e instanceof StoreError)) throw e; }
    if (!meta || await readCheckpoint(this.fs, dir)) return;
    const seeds = this.seedFn({ chatId: meta.chatId, version: unhex(nodePath.basename(dir)), segment: 0 });
    // DESTRUCTIVE-OK(verified-record): only when no checkpoint exists (the set-aside just moved it away)
    await writeCheckpoint(this.fs, dir, { count: 0, stamp: this.stamp, evLines: 0, evBytes: 0, boundary: null, lostRecs: 0, staleBad: null, hist: await histCount(this.fs, dir), h: Buffer.from(seeds.raw), c: Buffer.from(seeds.conversation) });
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
          try { await this.rebuildIndex(key, e.reason); } catch (e2) { if (e2 instanceof Damaged) await this.asides.quarantineOrReport(key, e2.reason); throw e2; }
          continue; // a split rebuild leaves the cut-off bytes as surplus, which the next loadOnce moves to torn/
        }
        if (e instanceof NeedsRebuild) throw new StoreError('corrupt', `index could not be repaired: ${e.reason}`);
        if (e instanceof Damaged) await this.asides.quarantineOrReport(key, e.reason);
        throw e;
      }
    }
  }

  private async loadOnce(key: string): Promise<VState> {
    const dir = this.vdir(key);
    const meta = await readMeta(this.fs, dir);
    if (!meta) throw new StoreError('unknown-version', key.slice(0, 8));
    await sweepTemps(this.fs, dir);
    await this.asides.finishAside(key, dir); // a set-aside interrupted half way is completed first
    const marks = await readMarksState(this.fs, dir);
    const dmg = await readDamaged(this.fs, dir, marks);
    if (dmg) throw new StoreError('damaged', dmg.asideName);
    // WHY (review 4, F5 class): a damaged marker that survives next to a live index.bin is an OLDER copy of a marker (a quarantine really moves the index away); readDamaged ignores it.
    // Review 5: it is cleared by writing a newer statement into marks.bin (nothing is deleted). Best effort: a read never fails for lack of space.
    if (marks.kind === 'ok' && marks.value?.damaged) { try { await setMarks(this.fs, dir, { damaged: null }, marks); } catch (e) { if (!isDiskFull(e)) throw e; } }
    const seeds = this.seedFn({ chatId: meta.chatId, version: unhex(key), segment: 0 });

    // 0. What was evicted ON PURPOSE. The only authority is the eviction state inside the checkpoint (checkpoint.ts), which is rewritten in place at every acknowledgement and carries this
    // version's identity (review 4: F1, F4, F5). Review 5 removed evicted.json altogether: nothing was ever decided from it except a veto, and the veto is now "the bodies are still all on
    // disk". Nothing is unlinked here.
    const ckState = await readCheckpointState(this.fs, dir);
    const ck = ckState.ck;
    // 1. The chunk files as they are: holes are allowed here (F3), they are reported below line by line and never hide the lines that are whole.
    let layout = await this.tools.layout(dir);
    // The eviction in force. Review 5 removed evicted.json; the checkpoint is the record, and the high-water record (written at every eviction and every restore) is its witness, below.
    const hw = await readHw(this.fs, this.root, key);
    const hv = hw.st.value;
    let ev = ck && ck.evLines > 0 ? { lines: ck.evLines, bytes: ck.evBytes } : { lines: 0, bytes: 0 };
    let evB: Boundary | null = ev.lines > 0 ? ck!.boundary : null;
    // 2. The index: only its tail is repaired in place (bytes kept); anything else is NeedsRebuild / Damaged.
    const lostRecs = ev.lines > 0 && ck ? ck.lostRecs : 0;
    const ix = await this.tools.settleIndex(dir, ev, layout, this.stamp, lostRecs);
    let { count, last } = ix;
    // WHY the high-water record here (review 5, F5 and the review 4 veto): the checkpoint can come back OLDER than the truth.
    //  - it names FEWER evicted lines than were really dropped (a later eviction was forgotten): the lines in between read as damaged. The high-water record remembers the newer eviction. It is
    //    believed only when PROVEN against the disk: the index record of its last evicted line ends exactly at its byte count, and not one byte of [what the checkpoint says, what the record
    //    says) exists in any chunk file (the bodies really are gone).
    //  - it names MORE evicted lines than the high-water record (a restore undid the eviction and an old checkpoint brought it back): when the bodies in between are all on disk the lower value stands,
    //    so those lines are served, never relabelled "proven held elsewhere". A wrong choice here is harmless (a body that is present is served); with no record the checkpoint's eviction stands (a chat in
    //    ONE chunk file has every body present after a genuine eviction).
    // Nothing is unlinked on the word of either record.
    if (hv && hv.evLines > ev.lines && hv.evLines <= count && hv.evBytes > ev.bytes) {
      // the first byte the checkpoint thinks is kept is in no chunk file (a chunk that straddles the newer boundary starts below it and still holds the lines past it: that is how a genuine eviction looks)
      const covered = this.tools.gapStart(layout, ev.bytes, hv.evBytes) !== ev.bytes;
      const r = covered ? null : decodeRecord(await this.readAt(this.ixPath(dir), recPos(hv.evLines - 1), REC), 0);
      if (r && r.offset + r.len === hv.evBytes && (lostRecs === 0 || hv.evLines > lostRecs)) {
        ev = { lines: hv.evLines, bytes: hv.evBytes };
        evB = { h: Buffer.from(r.h), c: Buffer.from(r.c), convCount: r.convCount, candN: r.candN, candId: r.candId };
      }
    } else if (hv && ev.lines > 0 && hv.evLines < ev.lines && this.tools.gapStart(layout, hv.evBytes, ev.bytes) === null) {
      if (hv.evLines === 0) { ev = { lines: 0, bytes: 0 }; evB = null; }
      else {
        const r = hv.evLines <= count && hv.evLines > lostRecs ? decodeRecord(await this.readAt(this.ixPath(dir), recPos(hv.evLines - 1), REC), 0) : null;
        if (r && r.offset + r.len === hv.evBytes) { ev = { lines: hv.evLines, bytes: hv.evBytes }; evB = { h: Buffer.from(r.h), c: Buffer.from(r.c), convCount: r.convCount, candN: r.candN, candId: r.candId }; }
      }
    }
    // an index SHORTER than the checkpoint lost records (an older copy, a cut at a record boundary): re-derive it before anything is decided from it
    if (ck && ck.count > count) throw new NeedsRebuild('the index is shorter than the checkpoint');
    // N1: a record that disagrees with the checkpoint means the index (a foreign or damaged one), not the body, is what is wrong. WHY BEFORE the surplus cut below
    // (review 4, F8): a foreign index is shorter than the body, so the body's "extra" bytes were being moved away as never-acknowledged before anything compared the index with the checkpoint.
    if (ck && ck.count > 0) {
      const r = decodeRecord(await this.readAt(this.ixPath(dir), recPos(ck.count - 1), REC), 0);
      if (!r) throw new NeedsRebuild(`record ${ck.count - 1} fails its checksum`);
      if (!r.h.equals(ck.h)) throw new NeedsRebuild('the index disagrees with the checkpoint');
    }
    // (An older checkpoint whose head passed this proof, with no damage found, is then restated under the current count by restoreRedundancy: the proof is what makes it true, and without it the older count would
    // stay forever and degrade every later repair. When the proof could not run, the older count is kept: a catch-up must never bless content it did not check.)
    // WHY (round 7, F1, found by the fuzz): an index AHEAD of the checkpoint looks exactly like a crash between the index write and the checkpoint write, and the checkpoint was then simply "caught up" to
    // it. After a takeover whose cut FINISHED (`.done`) it is also what an older index and older bodies put back look like when the checkpoint was lowered at the cut and agrees at the cut point. A restored
    // one runs along the tail of a finished takeover (the tail holds every line the old host had past the cut, with the chain value at each) while the checkpoint says the version has nothing past the cut
    // (`ck.count <= fromLine`). So an index ahead of the checkpoint whose head is a point on such a tail is refused (quarantined), never caught up to. A takeover whose evidence cannot be read does not
    // decide this: only a definite hit does. Equal chain values mean equal lines, so a hit is either the old history or a byte-identical rewrite by the new host that crashed before its checkpoint
    // write (the first batch after the cut): the store cannot tell those two apart and the rule is to stay loud when it cannot (a quarantine, recopied from a peer; never a quiet answer).
    // The same proof covers a checkpoint written BEFORE the takeover (its history count is below the folder's; after a takeover the checkpoint is restated at once, tails.ts step 3c, so an older one can only
    // have been put back) when the index and bodies were put back with it: all three older, nothing disagrees, and only the tail says the head is a replaced history's. A checkpoint with one damaged slot
    // (`slotsOk` 1) lags by one append through nothing but that damage, so the lag alone is not evidence there.
    // Only when the BODIES hold what the index head claims (`layout.phys`): an older index alone, whose extra records point past the trimmed bodies, would serve nothing old, and the rebuild below deals with it.
    const histNow = await histCount(this.fs, dir);
    let blessed = false;   // the head was PROVEN not to lie on a replaced history, so an older checkpoint may be restated under the current count (below)
    if (ck && last && layout.phys >= last.offset + last.len && ((count > ck.count && ckState.slotsOk === 2) || ck.hist < histNow)) {
      const hit = await cutAwayBranchHit(this.fs, dir, key, count, hex(last.h), 0, true, ck.hist < histNow ? 0 : ck.count);
      if (hit === null && ck.hist < histNow) blessed = true;
      if (hit !== null && hit !== 'unproven') throw new Damaged(`the index runs ahead of the checkpoint along the lines takeover ${hit} cut away, or the checkpoint predates it: older files put back, refusing to serve them`);
    }
    // the eviction record must agree with the index record of its last line (an independent, checksummed record)
    if (ev.lines > 0) {
      const r = decodeRecord(await this.readAt(this.ixPath(dir), recPos(ev.lines - 1), REC), 0);
      if (!r) throw new NeedsRebuild(`record ${ev.lines - 1} fails its checksum`);
      if (r.offset + r.len !== ev.bytes) throw new NeedsRebuild('the index disagrees with the eviction record');
      // review 5, F4: the checkpoint's boundary state must be this record's chain state; a disagreement means the record (or the checkpoint) is wrong: re-derive from what can be confirmed
      if (evB && !(r.h.equals(evB.h) && r.convCount === evB.convCount)) throw new NeedsRebuild('the index disagrees with the checkpoint at the eviction boundary');
    }
    // the conversation chain's staleness lives in the checkpoint stamp (review 5: stale-conv.json is gone), with the unhealed line in `staleBad`
    const staleConv = ck !== null && ck.stamp === ((this.stamp ^ 0x80000000) >>> 0);
    // N4: the evicted bodies are back, so the conversation chain can be recomputed now
    if (staleConv && ev.lines === 0) {
      // WHY not always (review 3): the chain is also stale while a rotted line is not healed yet (`staleBad` says which). Rebuilding then changes nothing and would loop.
      const bad = ck!.staleBad;
      if (bad === null || bad >= count || (await lineVerifies(this.fs, dir, layout.chunks, bad, seeds.raw))) throw new NeedsRebuild('evicted bodies are back or the rotted line was healed: recompute the conversation chain');
    }
    let bodyEnd = last ? last.offset + last.len : 0;
    let deferred: VState['deferred'] = ix.tailDeferred ? { trimTo: null, indexTail: true, partial: null } : null;
    let partial = await readPartial(this.fs, dir, count, marks);
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
        if (marker) await setMarks(this.fs, dir, { partial: marker }, marks); // DESTRUCTIVE-OK(hint): a marker; replaces an older marker of the same kind
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
      evictedLines: ev.lines, evictedBytes: ev.bytes, evB, lostRecs, staleBad: ck ? ck.staleBad : null,
      chunks, tailShort: layout.chunks.length > 0 && layout.phys < bodyEnd, replyEndsCache: null, summarySavedAt: 0,
      summary: { title: null, model: null, cwd: null, lastAppendMs: null, lines: 0 },
      badLine, scrubMark: 0, passEnd: 0, ck: ckState, deferred, summaryDirty: false, indexNeedsInit: !!ix.needsInit,
      partial, staleConv, marks, hw, rolledBack: null,
      parked: new Map(), parkedBytes: 0, epoch: await readEpoch(this.fs, dir), hist: ck && !(blessed && badLine === null && !partial) ? ck.hist : histNow, tailsShown: (await takeoverIds(this.fs, dir)).length, rejected: 0,
    };
    await this.restoreRedundancy(st);
    await this.checkRollback(st);
    const mark = await readScrubMark(this.fs, dir);
    st.passEnd = Math.min(mark.passEnd, count); st.scrubMark = Math.min(mark.lines, st.passEnd);
    await this.loadSummary(st);
    await this.parkedStore.loadIndex(st);
    if (this.scrubOnOpen > 0) await this.scrubSome(st, this.scrubOnOpen, LOAD_SCRUB_RECORDS);
    // WHY tolerant (review 3, F7): applying a parked append writes; a read must not fail because the disk is full. It is retried by the next append.
    try { await this.parkedStore.drain(st); } catch (e) { if (!isDiskFull(e)) throw e; }
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
      const want = this.ckOf(st);
      const cur = st.ck.ck;
      // DESTRUCTIVE-OK(verified-record): the head's chain values come from the CRC-checked index record and the load checks above; a lagging or damaged slot is replaced, a statement AHEAD of the index never reaches here
      if (!cur || cur.count !== st.count || cur.stamp !== want.stamp || cur.evLines !== want.evLines || cur.evBytes !== want.evBytes || cur.lostRecs !== want.lostRecs || cur.staleBad !== want.staleBad || cur.hist !== want.hist || st.ck.slotsOk < 2) await writeCheckpoint(this.fs, st.dir, want, st.ck);
    } catch (e) { if (!isDiskFull(e)) throw e; }
  }

  /** The checkpoint statement for what `st` holds now (`over` changes single fields: a new head, a new eviction state). One place, so no site can forget the boundary or the stale bit. */
  private ckOf(st: VState, over: Partial<Checkpoint> = {}): Checkpoint {
    return { count: st.count, stamp: st.staleConv ? (this.stamp ^ 0x80000000) >>> 0 : this.stamp, evLines: st.evictedLines, evBytes: st.evictedBytes, boundary: st.evictedLines > 0 ? st.evB : null, lostRecs: st.evictedLines > 0 ? st.lostRecs : 0, staleBad: st.staleConv ? st.staleBad : null, hist: st.hist, h: st.h, c: st.c, ...over };
  }

  // ---- high-water record (highwater.ts: ChatStore only forwards, the record is advisory) ------------
  private hwEnv(): HwEnv { return { fs: this.fs, root: this.root, readRecordHash: async (st, n) => { const r = decodeRecord(await this.readAt(this.ixPath(st.dir), recPos(n - 1), REC), 0); return r ? hex(r.h) : null; } }; }
  private resetHwFor(key: string): Promise<void> {
    return resetHw(this.hwEnv(), key, async () => { const meta = await readMeta(this.fs, this.vdir(key)); return meta ? hex(this.seedFn({ chatId: meta.chatId, version: unhex(key), segment: 0 }).raw) : null; });
  }
  private checkRollback(st: VState): Promise<void> { return checkRollback(this.hwEnv(), st); }
  private noteHw(st: VState, force = false): Promise<void> { return noteHw(this.hwEnv(), st, force); }
  private lowerHwTo(st: VState, count: number): Promise<void> { return lowerHwTo(this.hwEnv(), st, count); }

  // ---- index and body recovery (recovery.ts: settleIndex, rebuildIndex) --------------------------------
  private async rebuildIndex(key: string, reason: string): Promise<RebuildResult> {
    const dir = this.vdir(key);
    const meta = await readMeta(this.fs, dir);
    if (!meta) throw new StoreError('unknown-version', key.slice(0, 8));
    const seeds = this.seedFn({ chatId: meta.chatId, version: unhex(key), segment: 0 });
    return this.tools.rebuildIndex(dir, meta.runtime, seeds, this.stamp);
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
   * Verify a bounded slice, continuing from a persisted mark: index records (checksum, continuity) and, for lines that still have bodies, the body bytes against the chain. A bad index record
   * throws NeedsRebuild; a body that does not match its chain value sets `badLine` (a resend heals it) and the mark stays at it. DETECTION BOUND (N3): a pass covers lines [0, passEnd) where passEnd
   * is the head when the pass STARTED, then the next call starts a new pass at 0 however much was appended meanwhile, so growth never keeps old rot from being found.
   */
  private async scrubSome(st: VState, maxBytes: number, maxRecs: number): Promise<ScrubReport> {
    const report = (): ScrubReport => ({ verifiedLines: st.scrubMark, total: st.count, damagedFromLine: this.damagedFrom(st) });
    if (st.count === 0 || maxBytes <= 0) return report();
    if (st.passEnd > st.count) st.passEnd = st.count;                // the version got shorter (a cut)
    if (st.scrubMark > st.passEnd) st.scrubMark = st.passEnd;
    if (st.scrubMark >= st.passEnd) { st.scrubMark = 0; st.passEnd = st.count; }   // pass finished: start the next
    if (st.scrubMark < this.firstRealSlot(st)) st.scrubMark = Math.min(this.firstRealSlot(st), st.passEnd);   // review 5: slots before the stand-in record hold nothing to check
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
  /** Best effort (N5): the mark is a convenience, and a READ must never fail because the disk is full. */
  private async saveScrubMark(st: VState): Promise<void> {
    try { await writeSideFor(this.fs, nodePath.join(st.dir, 'scrub.json'), { role: 'scrub', key: st.key }, { lines: st.scrubMark, passEnd: st.passEnd }); } // DESTRUCTIVE-OK(hint): a progress mark; losing it only repeats work
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
            try { await this.rebuildIndex(key, e.reason); } catch (e2) { if (e2 instanceof Damaged) await this.asides.quarantineOrReport(key, e2.reason); throw e2; }
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
        if (n < this.firstRealSlot(st)) throw new StoreError('evicted', `line ${n}: the chain value of this evicted line was lost with the index`);
        const f = await this.fs.open(this.ixPath(st.dir), { create: false });
        try { return hex(this.mustRec(await f.read(recPos(n - 1), REC)).h); } finally { await f.close(); }
      });
    });
  }

  /**
   * Lines [from, to), as raw bytes with their newlines, each checked against the chain (H3); `evicted` when
   * any of them has no body here. A range past the head is refused (L4), not silently clamped.
   * NOTE FOR CALLERS (review 6, B4): a `corrupt` throw here is the damage signal; head().damagedFromLine can still be null until the next scrub, so a screen must not decide "healthy" from head() alone.
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
        if (cursor < this.firstRealSlot(st)) throw new StoreError('evicted', `line ${cursor}: the index records of the evicted lines were lost`);
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

  /** Slots [0, lostRecs) of the index hold no real record (review 5, F4); every scan starts at this slot. 0 normally. */
  private firstRealSlot(st: VState): number { return st.evictedLines > 0 ? st.lostRecs : 0; }

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
   * Returns only after the write is fsynced (INV-18); throws on ENOSPC and the like.
   *
   * RULE FOR THE NEXT LAYER (round 7, F4; no behaviour here): the store cannot know WHO sent these lines. A park is sealed with the history (epoch) that is current when the store RECEIVES it, so a
   * late append from a host that was already deposed, arriving after the takeover, is sealed with the NEW history and will drain onto the new host's lines. The caller (the replicator) must therefore
   * fence the deposed host BEFORE calling append(): refuse its lines at the door, never hand them to the store. The store only fences parks that were RECEIVED before a takeover or a quarantine.
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
          await this.parkedStore.park(st, fromLine, ls);
          return 'parked';
        }
        const res = await this.applyLines(st, fromLine, ls);
        if (res === 'ok') await this.parkedStore.drain(st);
        return res;
      }));
    });
  }

  /** The overlap check and the write. Lock held. */
  private async applyLines(st: VState, fromLine: number, lines: Buffer[]): Promise<'ok' | 'not-a-prefix'> {
    const overlap = Math.min(lines.length, st.count - fromLine);
    // review 5: lines below the stand-in record have no chain value to compare with (their records were lost); they are evicted, a peer holds them, and nothing is written for them
    const L = this.firstRealSlot(st);
    if (overlap > 0 && fromLine < L) {
      return this.applyLines(st, L, lines.slice(L - fromLine));
    }
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
        await appendCheckpoint(this.fs, st.dir, st.ck, this.ckOf(st));
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
    await appendCheckpoint(this.fs, st.dir, st.ck, this.ckOf(st, { count: bs.count, h: bs.h, c: bs.c }));
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
      if (st.partial && st.count >= st.partial.fromLine + st.partial.lost) { await setMarks(this.fs, st.dir, { partial: null }, st.marks); st.partial = null; } // DESTRUCTIVE-OK(hint): the lines the marker said were missing have been filled; a newer statement replaces it, nothing is deleted
    } catch (e) { if (!isDiskFull(e)) throw e; }
    await this.noteHw(st);   // review 5, F3: the high-water record is raised every HW_EVERY lines (after the lines are durable; advisory)
  }

  /** Do now what a read had to postpone (a copy to torn/ and a cut). Throws the typed error again when it still cannot be done. */
  private async runDeferred(st: VState): Promise<void> {
    const d = st.deferred!;
    if (d.partial) await setMarks(this.fs, st.dir, { partial: d.partial }, st.marks); // DESTRUCTIVE-OK(hint): a marker; replaces an older marker of the same kind
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
  rejectedList(version: VersionId): Promise<{ name: string; fromLine: number; lines: number | null; bytes: number; reason: RejectReason | 'unknown' }[]> {
    return this.guard(() => {
      const key = this.keyOf(version);
      return this.exclusive(async () => {
        const dir = nodePath.join(this.vdir(key), 'rejected');
        const out = [];
        for (const name of (await this.fs.readdir(dir)).sort()) {
          const p = parseRejectedName(name);
          if (!p) continue;
          // WHY `lines` can be null: a rejected park that rotted is kept as it is and cannot be counted; the caller resends from `fromLine` either way
          const raw = await this.fs.readFile(nodePath.join(dir, name));
          const env = raw ? openEnv(raw, { role: 'park', version: key }) : null;
          const fr = env && env.kind === 'ok' ? unframeLines(env.payload) : null;
          out.push({ name, fromLine: parseInt(p.name.slice(0, 16), 10), lines: fr ? fr.length : null, bytes: raw ? raw.length : 0, reason: p.reason });
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
        if (!(await this.parkedStore.moveAway(st, nodePath.join(st.dir, 'parked', name), name, 'released'))) throw new StoreError('limit', 'rejected/ is full');
        return true;
      }));
    });
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
          for (let n = this.firstRealSlot(st); n < st.count; n += SCAN_BATCH) {   // (a lost prefix's reply ends are unknown: documented limit)
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
      for (let at = this.firstRealSlot(st); at < st.count; at += SCAN_BATCH) {
        const take = Math.min(SCAN_BATCH, st.count - at);
        const buf = await f.read(recPos(at), take * REC);
        for (let i = 0; i < take; i++) if (this.mustRec(buf, i * REC).confirms !== NONE) n++;
      }
    } finally { await f.close(); }
    return n;
  }

  private async saveSummary(st: VState): Promise<void> {
    await writeSideFor(this.fs, nodePath.join(st.dir, 'summary.json'), { role: 'summary', key: st.key }, { ...st.summary, lines: st.count }); // DESTRUCTIVE-OK(hint): a cache of facts the index and bodies can recompute
    st.summarySavedAt = st.count; st.summaryDirty = false;
  }

  /** Load the saved summary and replay any lines it has not seen (needs their bodies; stays stale if evicted). */
  private async loadSummary(st: VState): Promise<void> {
    const r = await readSideFor(this.fs, nodePath.join(st.dir, 'summary.json'), { role: 'summary', key: st.key });
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
      for (let n = Math.max(from, this.firstRealSlot(st)); n < st.count; n += SCAN_BATCH) {
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
   * An old host's tail: save lines [fromLine, head) under `takeoverId` (sealed with the version AND the id, review 5 F2) and cut the version back. IDEMPOTENT per takeover id: a retry returns the
   * original result and cuts only when the version still holds exactly the saved tail. The ordered steps, what a crash behind each leaves and what the retry does are in tails.ts (review 6).
   * Every call ALSO starts a new history for parked appends, even when there is nothing to cut (tails.ts, invariant H).
   */
  setAsideTail(takeoverId: string, version: VersionId, fromLine: number): Promise<{ lines: number }> {
    return this.guard(() => {
      if (!TAKEOVER_RE.test(takeoverId)) throw new StoreError('bad-argument', 'takeover id must be hex');
      if (!Number.isSafeInteger(fromLine) || fromLine < 0) throw new StoreError('bad-argument', 'fromLine');
      const key = this.keyOf(version);
      return this.exclusive(() => this.mutate(key, async () => setAsideTailLocked(this.tailEnv(), await this.state(version), takeoverId, fromLine)));
    });
  }
  private tailEnv(): TailEnv {
    return { fs: this.fs, parked: this.parkedStore, readRange: (st, a, b, v) => this.readRange(st, a, b, v), stateAtLine: (st, n) => this.stateAtLine(st, n), confirmedBetween: (st, a, b) => this.confirmedBetween(st, a, b), cutTo: (st, n) => this.cutTo(st, n), recordTakeovers: (st) => recordTakeovers(this.hwEnv(), st, st.tailsShown), stampHistory: async (st) => { const live = this.versions.get(st.key) ?? st; live.hist = await histCount(this.fs, live.dir); await appendCheckpoint(this.fs, live.dir, live.ck, this.ckOf(live)); } };   // the live state: cutTo replaced it
  }

  /** A previously set-aside tail, with the chain values around it, or null. Pass `version` to look in one version only. */
  tail(takeoverId: string, version?: VersionId): Promise<TailRecord | null> {
    return this.guard(() => {
      if (!TAKEOVER_RE.test(takeoverId)) throw new StoreError('bad-argument', 'takeover id must be hex');
      const only = version ? this.keyOf(version) : null;
      return this.exclusive(async () => {
        const keys = only ? [only] : await this.fs.readdir(nodePath.join(this.root, 'versions'));
        for (const key of keys) {
          let t: TailFile | null;
          // asked of ONE version: a file that is not that version's tail for this id throws `corrupt`. Looking across versions, a tail for THIS id sealed for another version is found under its own folder, so it is skipped here; any other file under this name is an overwritten tail and throws
          try { t = await readTailFile(this.fs, nodePath.join(this.vdir(key), 'tails', `${takeoverId}.tail`), key, takeoverId); } catch (e) { if (only || !(e instanceof ForeignTail && e.elsewhere)) throw e; continue; }
          if (!t && await tailWasProtected(this.fs, this.vdir(key), takeoverId)) throw LOST_TAIL();   // review 6 B2: the intent marker counts too, not only `.done`
          if (t) return { version: unhex(key), fromLine: t.fromLine, fromHash: t.fromHash, fromConversationHash: t.fromConv, headHash: t.headHash, headConversationHash: t.headConv, lines: t.lines, replyEnds: t.replyEnds, pendingReplyEnd: t.pending };
        }
        return null;
      });
    });
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
    // WHY the high-water record is lowered BEFORE the cut (review 5, F3): the cut is deliberate, so the shorter head must not later be reported as a rollback; lowered first, a kill between the two
    // steps leaves the record merely lower than the head (it can only under-report)
    await this.lowerHwTo(st, n);
    // WHY the checkpoint is lowered BEFORE the cut (N1): a checkpoint that outlives the cut would claim lines that are gone, and
    // the next load would call the version damaged. Lowered first, a kill between the two steps leaves it merely behind the index.
    if (st.ck.ck && st.ck.ck.count > n) {
      // DESTRUCTIVE-OK(verified-record): lowers the statement to the chain value of record n-1, read from the checksummed index; the caller saved the cut lines in a verified tail file
      await writeCheckpoint(this.fs, st.dir, this.ckOf(st, { count: n, h: lastKept ? lastKept.h : st.seeds.raw, c: lastKept ? lastKept.c : st.seeds.conversation }), st.ck);
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
   * The copy is damaged (its bytes no longer match its chain): move everything into aside/ (kept, never deleted, retention rule 5.3) and start the version empty so it can be recopied.
   * For a version the store already quarantined (`damaged`), this only clears the marker: the quarantined copy is already aside, intact. Parked appends stay. (asides.ts)
   */
  setAsideDamaged(version: VersionId): Promise<{ asideName: string }> {
    return this.guard(() => {
      const key = this.keyOf(version);
      return this.exclusive(() => this.mutate(key, () => this.asides.setAside(key)));
    });
  }

  // ---- eviction ------------------------------------------------------------------------------------
  /**
   * Drop line BODIES (never chain values) for lines [0, proof.through). The caller's ProofVerifier decides whether the proof is genuine (default: refuses everything); the store also checks it is
   * BOUND to this version, line count and chain value, that holders are distinct, and that the bytes about to be dropped still match the chain. The record is the checkpoint's (with the boundary state).
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
        let byteAt: number; let br: Rec;
        try { br = this.mustRec(await f.read(recPos(proof.through - 1), REC)); byteAt = br.offset + br.len; } finally { await f.close(); }
        // 1. the eviction record, inside the checkpoint (both slots, atomic enough: each slot is its own checksummed write), WITH the chain state at the boundary (review 5, F4) 2. the high-water record
        // (so an older checkpoint that comes back later can be told the bodies really were dropped, F5) 3. unlink the chunks wholly below it. A kill between 1 and 3 leaves chunk files that a later proof
        // removes; nothing is ever removed on load.
        const boundary: Boundary = { h: Buffer.from(br.h), c: Buffer.from(br.c), convCount: br.convCount, candN: br.candN, candId: br.candId };
        // DESTRUCTIVE-OK(verified-record): a proven eviction; `byteAt` is read from the checksummed index record of the last evicted line; the new statement keeps the head's own chain values
        await writeCheckpoint(this.fs, st.dir, this.ckOf(st, { evLines: proof.through, evBytes: byteAt, boundary }), st.ck);
        st.evictedLines = proof.through; st.evictedBytes = byteAt; st.evB = boundary;
        await this.noteHw(st, true);
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
   * Bring evicted bodies back, and repair every other line the caller supplied that has no body. `lines` must be lines 0.. (at least the evicted prefix); EVERY line supplied up to the head is
   * checked against the stored chain before anything is written. Chunk file first, marker last (crash rule 3). Review 5, F5: ONE call restores everything it was given. With the whole index lost
   * after an eviction (`lostRecs`) the prefix is checked as ONE chain against the boundary the checkpoint kept, and the index is re-derived from the bodies on the next load.
   */
  restoreBody(version: VersionId, lines: Uint8Array[]): Promise<{ restoredLines: number }> {
    return this.guard(() => {
      const key = this.keyOf(version);
      const ls = lines.map(asLine);
      return this.exclusive(() => this.mutate(key, async () => {
        const st = await this.state(version);
        // WHY the second mode (review 4): the eviction record can be LOST (a missing, damaged or older checkpoint) while the bodies really are gone. The store then reports those lines
        // damaged, and a caller who asks for the bodies back must get them: with no eviction in force, "restore" repairs whatever lines the caller supplies that are not on disk.
        const upto = Math.min(ls.length, st.count);
        let E = st.evictedLines;
        if (E === 0) {
          if ((await this.gapBadLine(st)) === null) return { restoredLines: 0 };
          E = upto;
          if (E === 0) return { restoredLines: 0 };
        }
        if (ls.length < E) throw new StoreError('bad-argument', 'need every evicted line, from line 0');
        const N = Math.max(E, upto);                       // everything supplied, up to the head
        const L = st.evictedLines > 0 ? st.lostRecs : 0;   // slots [0, L) hold no real record
        // the restored region is [0, S) where S is where the earliest surviving chunk starts (or the end of data)
        const S = st.chunks.length ? st.chunks[0] : st.bodyEnd;
        const f = await this.fs.open(this.ixPath(st.dir), { create: false });
        const parts: Buffer[] = []; let h: Buffer = st.seeds.raw; let preLen = 0;
        try {
          if (L > 0) {
            // the lost prefix: one chain over all of it, compared with the boundary kept in the stand-in record (which the checkpoint's own boundary was checked against at load)
            for (let n = 0; n < L; n++) { h = chainStep(h, ls[n]); parts.push(ls[n]); preLen += ls[n].length; }
            const bd = this.mustRec(await f.read(recPos(L - 1), REC));
            if (!h.equals(bd.h) || preLen !== st.evictedBytes) throw new StoreError('bad-argument', 'the evicted lines do not match this store\'s chain');
          }
          for (let n = L; n < N;) {
            const take = Math.min(SCAN_BATCH, N - n);
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
        if (N > L) await this.repairBodies(st, L, ls.slice(L, N), 0);
        // WHY the read-back (review 4, F7): "restored" must mean the lines read back from disk byte for byte. Only then is the eviction record cleared.
        if (N > L) await this.readRange(st, L, N, true);
        if (L > 0) {
          const back = await this.readBodyBytes(st, 0, preLen);
          if (!back.equals(Buffer.concat(ls.slice(0, L)))) throw new StoreError('corrupt', 'the restored prefix does not read back as written');
        }
        if (st.evictedLines > 0) {
          // DESTRUCTIVE-OK(verified-record): every evicted line was just verified against the chain and read back from disk
          await writeCheckpoint(this.fs, st.dir, this.ckOf(st, { evLines: 0, evBytes: 0, boundary: null, lostRecs: 0 }), st.ck);
          st.evictedLines = 0; st.evictedBytes = 0; st.evB = null; st.lostRecs = 0;
          await this.noteHw(st, true);
          // the index still holds the stand-in for the lost prefix: drop the cached state, the next load re-derives the index from the bodies (confirmed by the checkpoint's head)
          if (L > 0) { this.versions.delete(key); return { restoredLines: N }; }
        }
        // the lines just written back are no longer damaged; a hole further on (lines the caller did not supply) still is
        if (st.badLine !== null && st.badLine < N) st.badLine = null;
        const gb = await this.gapBadLine(st);
        if (gb !== null) st.badLine = st.badLine === null ? gb : Math.min(st.badLine, gb);
        // N4: with the bodies back the conversation chain can be recomputed: drop the cached state so the next call rebuilds it
        if (st.staleConv) this.versions.delete(key);
        return { restoredLines: N };
      }));
    });
  }

  /** `len` body bytes from logical offset `from`, across chunk files (a read-back helper: no index record needed). */
  private async readBodyBytes(st: VState, from: number, len: number): Promise<Buffer> {
    const out: Buffer[] = []; let at = from;
    while (at < from + len) {
      const cs = this.chunkFor(st, at);
      const next = st.chunks.find((c) => c > cs);
      const n = Math.min(from + len - at, (next ?? Infinity) - at);
      const b = await this.readAt(this.chunkPath(st, cs), at - cs, n);
      if (b.length !== n) throw new StoreError('corrupt', 'body shorter than expected');
      out.push(b); at += n;
    }
    return Buffer.concat(out);
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
        const L0 = this.firstRealSlot(st);
        if (L0 > 0) { prev = this.mustRec(await f.read(recPos(L0 - 1), REC)); h = prev.h; }
        for (let n = L0; n < st.count; n += 256) {
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

  /** First line whose bytes are not trustworthy: a body that failed its chain value, lines a rebuild set aside and a resend has not yet replaced, or (review 5, F3) the lines a rolled-back folder lost. */
  private damagedFrom(st: VState): number | null {
    const p = st.partial && st.count < st.partial.fromLine + st.partial.lost ? st.partial.fromLine : null;
    const rb = this.rolledBackOf(st);
    let out: number | null = null;
    for (const v of [p, st.badLine, rb ? rb.from : null]) if (v !== null) out = out === null ? v : Math.min(out, v);
    return out;
  }
  private rolledBackOf(st: VState): { from: number; had: number } | null { return st.rolledBack && st.count < st.rolledBack.had ? st.rolledBack : null; }

  private headOf(st: VState): Head {
    return { lines: st.count, hash: hex(st.h), conversationLines: st.convCount, conversationHash: hex(st.c), evictedLines: st.evictedLines, classifierStamp: this.stamp, damagedFromLine: this.damagedFrom(st), conversationChainStale: st.staleConv, rolledBack: this.rolledBackOf(st), rejectedParks: st.rejected, lostTakeovers: lostTakeovers(st) };
  }
}
