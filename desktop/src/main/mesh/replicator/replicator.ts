// The replicator: copies chat lines between this user's own devices by joining the on-disk chat store (store/) to the encrypted link (link.ts).
// SHIPS SWITCHED OFF: the service creates it only in test mode or behind its own flag until adapters exist (see service.ts); nothing a user can see changes.
//
// ============================================================================================================================================================================
// INVARIANTS (plan section 5). Each one has a test that fails when its guard is removed (tests/mesh/replicator.test.ts, "mutation guards").
//  1. No line reaches `append` unless a writer signature covers its chain value (receive.ts: signature, then chain, then append).
//  2. No append past the head, and no store parking for peer lines: a batch that starts past my head is dropped and re-asked for.
//  3. An ack follows an fsynced `ok` from `append` and names the lines held and the chain value there. Acks may FALL as well as rise (a peer can roll back).
//  4. A peer's claim (a head, a count, a nak) schedules work and never proves anything.
//  5. Divergence is never settled by length: the chain value at the shared count decides, and only a writer-signed batch may make me set a copy aside.
//  6. A retired id is never reused: a recopy goes to the next incarnation (idmap.ts).
//  7. Only the named writer appends locally (appendLocal refuses otherwise); peer lines for my own version beyond my head are accepted only when the store reports a refill.
//  8. A repair report clears only on store evidence (repair.ts): the store reports nothing AND the whole range reads back.
//  9. Every failure ends in a named status (`status()`), never in silence; work on one version runs one step at a time.
// 10. Bounded memory (budget.ts) and frames of at most 1 MiB (wire.ts).
// 11. No frame body, chat text or key material in any log or failure report; keys never leave the device (this folder only calls `sign` and `verify`).
// 12. (reviews 1-3) THE WRITER'S GATE is best-effort and simple: it appends only while it is not behind its own checksummed records (a detector for PARTIAL rollbacks), no fresh peer claim of more lines or another
//     chain value is still plausible (an unbacked claim is discounted after 10 minutes, its clock reset only by a batch from that device), and the process gate is open (every reachable roster device has sent its heads
//     COMPLETELY, or nobody is reachable after 5 s). The gate latches and never expires; a status read never changes it; every refusal asks for heads again. `appendLocal` REQUIRES the head the caller last saw.
// 13. What no local gate can see (a whole-profile restore) is made LOSSLESS, not fatal: a writer that signed two histories moves its newer lines into a second version (selffork.ts) and brings its copy of the first back
//     to the peers' history; a contradicted peer copy is kept under a named, non-calm state and resolved on the writer's announcement. No device ever drops a line that does not exist, verified, in one of the two versions.
// 14. A status is never calm while the writer is refusing or a copy is stalled: every refusal reason of `appendLocal` is a status (`writerGate`), and `in-sync` carries a note when the own records were rebuilt.
// ============================================================================================================================================================================
//
// HOW IT WORKS, in one paragraph. Every device says what it holds (`rep.sum`, then `rep.heads` when the summaries differ). The device that is BEHIND asks the device that is ahead
// (`rep.want`: "I hold N lines, chain value H"); the answer is a stream of `rep.lines` batches, each ending at a point the writer signed, which the receiver verifies, appends and
// acknowledges. The writer also pushes each new line to everyone as soon as it is appended, on the durable lane, so a device that is offline finds it waiting. The receiver drives:
// a lost frame is simply asked for again.
import { createHash, randomBytes } from 'node:crypto';
import { StoreError, deriveForkId } from '../store';
import { MAX_LINE_BYTES } from './wire';
import { mkdirDurable, writeFileAtomic } from '../store/fsio';
import { OwnRecords } from './own-record';
import { vouchLines } from './ctx';
import * as nodePath from 'node:path';
import type { ChatStore, Head } from '../store';
import { unhex } from '../store/chain';
import { realFs, type Fs } from '../store/fsio';
import { FrameReject, type LinkFrame } from '../link';
import { reportFailure } from '../../report-failure';
import { ByteBudget, CLAIM_UNBACKED_MS, INTRO_PERIOD_MS, WRITER_ALONE_MS, MAX_HOLDS_PER_SECOND, MAX_INTRO_ASKS_PER_PERIOD, MAX_PEER_HEADS, QUEUE_STEP_LIMIT_MS, WANT_GAP_MS, RateLimiter, READ_BUFFER_BUDGET_BYTES, REASSEMBLY_BUDGET_BYTES } from './budget';
import { compareHeads, type HeadView, type MineAtTheirs } from './compare';
import { chatGroup, hex8, realClock, repairFrom, type Clock, type PeerAck, type PeerInfo, type RepCtx, type ReplicatorLink, type SourceRefill, type VersionStatus, type VRun } from './ctx';
import { InterimDirectory, type ReplicatorCrypto, type VersionDescriptor, type VersionDirectory } from './directory';
import { setupVersion } from './forks';
import { IdMap, type Probe } from './idmap';
import { askIntro, dropReassembly, receiveLines, sendNak } from './receive';
import { checkRepair, onCorruptRead, retireAndRecopy } from './repair';
import { isSelfForkToken, selfForkToken, type SelfForkJournal } from './selffork';
import { onAck, onWant, pushNew } from './serve';
import { SignedHeads } from './signed-heads';
import { GROUP_LIVE, headMessage, headsBodyOf, introBodyOf, KIND_ACK, KIND_HEADS, KIND_INTRO, KIND_LINES, KIND_NAK, KIND_SUM, KIND_WANT, parseAckBody, parseHeadsBody, parseIntroBody, parseLinesBody, parseNakBody, parseSumBody, parseWantBody, REPLICATOR_KINDS, sumBody, wantBodyOf, type AdvertisedState, type HeadEntry, type NakBody, type HeadsBody } from './wire';

const HEADS_PER_PAGE = 500;
const DEFAULT_DISCOVERY_MS = 60_000;
const DEFAULT_STALL_MS = 20_000;
const PUSH_RATE_PER_SECOND = 40;
/** A peer whose last word is older than this is not chosen as a source (its heads may be long out of date). */
const PEER_FRESH_MS = 10 * 60_000;
/** A roster device counts as reachable for the writer gate when something from it arrived this recently. */
const REACH_MS = 120_000;
const DEFAULT_SCRUB_MS = 30_000;
const SCRUB_SLICE_BYTES = 4 * 1024 * 1024;
const MAX_INTRO_ASKS_PER_FRAME = 16;

export interface ReplicatorOptions {
  store: ChatStore;
  link: ReplicatorLink;
  /** The replicator's own folder (`<userData>/mesh/replicator`). Created on first write, never before. */
  dir: string;
  crypto: ReplicatorCrypto;
  setId: Buffer;
  /** The OTHER devices of the set (the roster minus this device). */
  devices: () => Buffer[];
  fs?: Fs;
  /** Where the writer's second copy of its highest-head record lives: a folder outside both the store and the replicator folder (default: `witness` next to the replicator folder). */
  witnessDir?: string;
  clock?: Clock;
  directory?: VersionDirectory;
  sourceRefill?: SourceRefill;
  discoveryMs?: number;
  stallMs?: number;
  /** How often the replicator scrubs one slice of one version (review 1, F9); 0 turns it off. Default 30 s. */
  scrubEveryMs?: number;
  /** Called when this device, as a writer, moved lines into a second version (review 3): the adapter and the control log learn that lines from `from` now live in `movedTo`. */
  onSelfFork?: (e: { version: Buffer; from: number; movedTo: Buffer }) => void;
  /** A queued step that has not finished after this many REAL milliseconds is given up as `stuck(store-call-blocked)` (default 120 s). Real time on purpose: it measures a call that never answers, not virtual time. */
  stepLimitMs?: number;
}

const newRun = (): VRun => ({ rounds: [], ownNote: null, discounted: null, stuck: null, diverged: null, retiredRecopy: false, refill: null, pull: null, seenRejected: 0, lastHead: { lines: 0, incarnation: 0 }, recopies: 0, rewanted: new Set(), lastSigned: new Map(), stall: null, pushedThrough: null, pushing: false, skip: new Set(), fault: null, caughtUp: false, serveWait: false, incarnationSeen: null, wantAt: new Map(), parentAskAt: null, parentAskLines: null, unavailable: new Set(), unavailableRounds: 0, ownPending: null, evidence: false });

export class Replicator {
  readonly #o: ReplicatorOptions;
  readonly #ctx: RepCtx;
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #introAsked = new Set<string>();
  readonly #savedFaults = new Map<string, string>();
  readonly #adopting = new Set<string>();
  #scrub: { cancel(): void } | null = null;
  #scrubIdx = 0;
  readonly #directory: VersionDirectory;
  #discovery: { cancel(): void } | null = null;
  #stopped = false;
  readonly #own: OwnRecords;
  readonly #selfForks: Array<{ version: Buffer; from: number; movedTo: Buffer }> = [];
  #gate = false; // latched: the writer gate has opened in this process (never expires)
  #gateTimer: { cancel(): void } | null = null;
  #askedAt = -1e12;
  /** When this process's replicator started (virtual clock): evidence must be newer than this. */
  readonly #startedAt: number;

  private constructor(o: ReplicatorOptions, directory: VersionDirectory, savedFaults: Map<string, string>) {
    for (const [k, v] of savedFaults) this.#savedFaults.set(k, v);
    this.#o = o;
    this.#directory = directory;
    const clock = o.clock ?? realClock;
    const fs = o.fs ?? realFs;
    this.#startedAt = clock.now();
    this.#own = new OwnRecords(fs, nodePath.join(o.dir, 'own'), o.witnessDir ?? nodePath.join(nodePath.dirname(o.dir), 'witness'));
    const probe: Probe = async (local) => {
      try { await o.store.head(local); return 'live'; } catch (e) {
        if (e instanceof StoreError && e.code === 'unknown-version') return 'absent';
        if (e instanceof StoreError && e.code === 'damaged') return 'retired';
        throw e;
      }
    };
    const self = this;
    this.#ctx = {
      store: o.store, link: o.link, crypto: o.crypto, directory, heads: new SignedHeads(fs, o.dir), ids: new IdMap(probe), clock, setId: o.setId,
      holds: new RateLimiter(MAX_HOLDS_PER_SECOND, () => clock.now()), pushRate: new RateLimiter(PUSH_RATE_PER_SECOND, () => clock.now()),
      readBytes: new ByteBudget(READ_BUFFER_BUDGET_BYTES), reassemblyBytes: new ByteBudget(REASSEMBLY_BUDGET_BYTES), sourceRefill: o.sourceRefill,
      peers: new Map(), runs: new Map(), counters: new Map(), reasm: new Map(), sessions: new Map(),
      run: (wire, fn) => self.queue(wire, fn),
      runOf: (wire) => { const k = wire.toString('hex'); let r = self.#ctx.runs.get(k); if (!r) { r = newRun(); r.fault = self.#savedFaults.get(k) ?? null; self.#ctx.runs.set(k, r); } return r; },
      fault: (wire, reason) => self.recordFault(wire, reason),
      selfFork: (wire, p) => self.selfForkNow(wire, p),
      localOf: (wire) => self.localOf(wire),
      bump: (c) => { self.#ctx.counters.set(c, (self.#ctx.counters.get(c) ?? 0) + 1); },
      sendLive: (kind, body, to) => o.link.sendLive({ group: GROUP_LIVE, kind, body, ...(to ? { to } : {}) }),
      want: (wire, peer, opts) => self.want(wire, peer, opts),
      reconsider: (wire) => self.reconsider(wire),
      advertise: () => { void self.broadcastHeads().catch((e: unknown) => reportFailure({ what: 'tell the other devices what this device holds', cause: e, where: 'mesh.replicator' })); },
    };
  }

  /** Make a replicator over `o`. Reads nothing from disk except the saved announcements (a missing folder is an empty one). */
  static async create(o: ReplicatorOptions): Promise<Replicator> {
    let directory = o.directory;
    if (!directory) { const d = new InterimDirectory(o.fs ?? realFs, o.dir, o.crypto, { setId: o.setId }); await d.load(); directory = d; }
    // sticky faults saved by an earlier run (F1): read back before anything else can touch a version
    const faults = new Map<string, string>();
    const fs = o.fs ?? realFs;
    for (const name of await fs.readdir(nodePath.join(o.dir, 'faults'))) {
      if (!/^[0-9a-f]{2,128}$/.test(name)) continue;
      try { const raw = await fs.readFile(nodePath.join(o.dir, 'faults', name)); if (raw) faults.set(name, raw.toString('utf8').slice(0, 200)); } catch (cause) { reportFailure({ what: 'read a saved version fault (the version is treated as faulted)', cause, where: 'mesh.replicator' }); faults.set(name, 'fault-file-unreadable'); }
    }
    return new Replicator(o, directory, faults);
  }
  /** A sticky fault: in memory and on disk. Nothing in this folder ever clears it (F1/F4); only a person-level decision (a later piece) can. */
  private async recordFault(wire: Buffer, reason: string): Promise<void> {
    const k = wire.toString('hex'); const run = this.#ctx.runOf(wire);
    if (run.fault) return;
    run.fault = reason; this.#savedFaults.set(k, reason); this.#ctx.bump(`fault-${reason}`);
    reportFailure({ what: `keep a chat copy as it is (${reason})`, where: 'mesh.replicator' });
    const dir = nodePath.join(this.#o.dir, 'faults');
    try { await mkdirDurable(this.#o.fs ?? realFs, dir); await writeFileAtomic(this.#o.fs ?? realFs, nodePath.join(dir, k), Buffer.from(reason, 'utf8')); } catch (cause) { reportFailure({ what: 'save a version fault (it stays in memory until restart)', cause, where: 'mesh.replicator' }); }
  }

  /** A fault that a resolution (below) has shown to be over: forgotten in memory and on disk. Only the self-fork resolution calls this; nothing else clears a fault. */
  private async clearFault(wire: Buffer): Promise<void> {
    const k = wire.toString('hex'); const run = this.#ctx.runOf(wire);
    if (!run.fault) return;
    run.fault = null; this.#savedFaults.delete(k); this.#ctx.bump('fault-cleared');
    try { await (this.#o.fs ?? realFs).unlink(nodePath.join(this.#o.dir, 'faults', k)); } catch (cause) { reportFailure({ what: 'forget a resolved version fault (it will be forgotten again at the next start)', cause, where: 'mesh.replicator' }); }
  }

  // ------------------------------------------------------------------ the self-fork (selffork.ts)
  private journalPath(wire: Buffer): string { return nodePath.join(this.#o.dir, 'selffork', wire.toString('hex')); }
  /** Lines moved by a self-fork in this process or found in a journal at start: `from` is where the histories parted, `movedTo` the second version. Exposed so the adapter and the control log can see both. */
  selfForks(): Array<{ version: Buffer; from: number; movedTo: Buffer }> { return this.#selfForks.map((x) => ({ ...x })); }
  /** The writer found it signed two histories of `wire` that part at line `p`: move its lines from `p` into a second version and bring `wire` back to the history the peers hold. Crash-safe (journal), runs inside
   *  the version's queue. Nothing is deleted: the old bytes of `wire` go to the store's aside folder like any retired copy. */
  private async selfForkNow(wire: Buffer, p: number, resume?: SelfForkJournal): Promise<void> {
    const ctx = this.#ctx; const fs = this.#o.fs ?? realFs;
    const desc = this.#directory.describe(wire); const v = await this.localOf(wire);
    if (!desc || !v) return;
    const head = await this.#o.store.head(v.local);
    let j = resume;
    if (!j) {
      const hp = await this.#o.store.hashAt(v.local, 0, p);
      if (hp === null || p > head.lines) throw new Error('self-fork: no chain value at the parting point');
      const v2 = deriveForkId(wire, p, hp, selfForkToken(ctx.crypto.self, desc.chatId));
      j = { p, hp, v2: v2.toString('hex'), inc: v.incarnation, stage: 'start' };
      await mkdirDurable(fs, nodePath.dirname(this.journalPath(wire)));
      await writeFileAtomic(fs, this.journalPath(wire), Buffer.from(JSON.stringify(j)));
    }
    const v2 = Buffer.from(j.v2, 'hex');
    if (j.stage === 'start') {
      // 1. announce the second version (a fork of this one at p; the announcement is the writer-signed statement) and make its copy
      if (!this.#directory.describe(v2)) await this.createVersion({ version: v2, chatId: desc.chatId, runtime: desc.runtime, parent: wire, forkLine: j.p, forkHash: Buffer.from(j.hp, 'hex'), token: selfForkToken(ctx.crypto.self, desc.chatId) });
      else await this.adopt(v2);
      const v2v = await this.localOf(v2);
      if (!v2v) throw new Error('self-fork: the second version cannot be set up yet');
      // 2. copy my lines from p on into it (my copy of this version still holds them: it is retired only after this)
      for (;;) {
        const h2 = await this.#o.store.head(v2v.local);
        if (h2.lines >= head.lines) break;
        const upto = Math.min(head.lines, h2.lines + 200);
        const got = await this.#o.store.read(v.local, 0, h2.lines, upto);
        if (got === 'evicted') throw new Error('self-fork: my own lines are not readable');
        const res = await this.queue(v2, () => this.#o.store.append(v2v.local, 0, h2.lines, got));
        if (res !== 'ok') throw new Error(`self-fork: append answered ${res}`);
      }
      const h2 = await this.#o.store.head(v2v.local);
      await this.saveOwnHead(v2, h2.lines, h2.hash);
      j = { ...j, stage: 'copied' };
      await writeFileAtomic(fs, this.journalPath(wire), Buffer.from(JSON.stringify(j)));
      void pushNew(ctx, v2).catch((e: unknown) => reportFailure({ what: 'send the moved lines of the second version to the other devices', cause: e, where: 'mesh.replicator' }));
    }
    // 3. bring this version back to the peers' history: its records are reset (they describe the history that now lives in the second version) and its copy is set aside and refilled from the peers
    if (v.incarnation === j.inc) {
      await this.#own.clear(wire);
      this.#ctx.runOf(wire).caughtUp = false;
      await retireAndRecopy(ctx, wire, 'self-fork');
    }
    try { await fs.unlink(this.journalPath(wire)); } catch (cause) { reportFailure({ what: 'remove the finished self-fork note', cause, where: 'mesh.replicator' }); }
    this.#selfForks.push({ version: wire, from: j.p, movedTo: v2 });
    this.#ctx.bump('self-fork-done');
    this.#o.onSelfFork?.({ version: wire, from: j.p, movedTo: v2 });
  }
  /** At start: finish any self-fork that a crash interrupted. */
  private async resumeSelfForks(): Promise<void> {
    const fs = this.#o.fs ?? realFs;
    for (const name of await fs.readdir(nodePath.join(this.#o.dir, 'selffork'))) {
      if (!/^[0-9a-f]{2,128}$/.test(name)) continue;
      try {
        const raw = await fs.readFile(nodePath.join(this.#o.dir, 'selffork', name)); if (!raw) continue;
        const j = JSON.parse(raw.toString('utf8')) as SelfForkJournal; const wire = Buffer.from(name, 'hex');
        await this.queue(wire, () => this.selfForkNow(wire, j.p, j));
      } catch (cause) { reportFailure({ what: 'finish a chat move that an earlier run began', cause, where: 'mesh.replicator' }); }
    }
  }
  /** A peer's side: a self-fork announcement for V2 (a fork of V) resolves V's named state when it shows which history this device holds (see selffork.ts). */
  private async resolveSelfFork(v2: Buffer): Promise<void> {
    const d2 = this.#directory.describe(v2);
    if (!d2 || !d2.parent || d2.forkLine === null || !d2.forkHash) return;
    const V = d2.parent; const dV = this.#directory.describe(V);
    if (!dV || dV.writer.equals(this.#ctx.crypto.self) || !d2.writer.equals(dV.writer) || !isSelfForkToken(d2.writer, d2.token)) return;
    const runV = this.#ctx.runOf(V);
    if (runV.fault !== 'writer-signed-two-histories' && runV.fault !== 'unsigned-lines-contradicted') return;
    await this.queue(V, async () => {
      const vv = await this.localOf(V); const v2v = await this.localOf(v2);
      if (!vv || !v2v) return;
      const hV = await this.#o.store.head(vv.local); const h2 = await this.#o.store.head(v2v.local);
      const p = d2.forkLine as number;
      if (hV.lines < p || (await this.#o.store.hashAt(vv.local, 0, p)) !== (d2.forkHash as Buffer).toString('hex')) return; // not a statement about my copy
      const k = Math.min(hV.lines, h2.lines);
      if (k <= p) { if (h2.lines >= hV.lines) await this.clearFault(V); return; } // nothing of mine past p to compare
      const mine = await this.#o.store.hashAt(vv.local, 0, k); const theirs = await this.#o.store.hashAt(v2v.local, 0, k);
      if (mine !== theirs) { await this.clearFault(V); this.#ctx.bump('self-fork-old-history-kept'); return; } // I hold the older history: it stays under V
      if (h2.lines >= hV.lines) { // my lines past p are exactly what now lives, verified, under V2: set this copy aside and refill V from the peers
        await retireAndRecopy(this.#ctx, V, 'moved-to-self-fork'); await this.clearFault(V); this.#ctx.bump('self-fork-newer-history-moved');
      }
      // else: the second version has not caught up with my lines yet; asked again when it grows
    });
  }

  // ------------------------------------------------------------------ plumbing
  private queue<T>(wire: Buffer, fn: () => Promise<T>): Promise<T> {
    const k = wire.toString('hex');
    const next = (this.#queues.get(k) ?? Promise.resolve()).then(() => this.guarded(wire, fn));
    const tail = next.then(() => undefined, () => undefined /* benign: the step's failure goes to the caller of `next` and was reported where it happened; it must not stop the next step */);
    this.#queues.set(k, tail);
    // an idle version leaves no entry behind (F6): the map is bounded by the versions with work in flight
    void tail.then(() => { if (this.#queues.get(k) === tail) this.#queues.delete(k); });
    return next;
  }
  /** One step of a version's queue, with a ceiling (review 1, F8): a store call that never answers ends in the named state `stuck(store-call-blocked)` and the queue moves on, instead of wedging every later step. */
  private guarded<T>(wire: Buffer, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const timer = { cancel: ((): (() => void) => { const t = setTimeout(() => {
        if (done) return;
        done = true; this.#ctx.runOf(wire).stuck = 'store-call-blocked'; this.#ctx.bump('store-call-blocked');
        reportFailure({ what: 'finish a step on a chat copy (the store did not answer; the step was given up)', where: 'mesh.replicator' });
        reject(new Error('store-call-blocked'));
      }, this.#o.stepLimitMs ?? QUEUE_STEP_LIMIT_MS); t.unref?.(); return () => clearTimeout(t); })() };
      // WHY the late answer clears the named state (review 2, finding 7): `stuck(store-call-blocked)` means the store has not answered; once it HAS (even long after the ceiling) the state would be a lie
      const answered = (): void => { const r = this.#ctx.runOf(wire); if (r.stuck === 'store-call-blocked') { r.stuck = null; this.#ctx.bump('store-call-answered-late'); } void this.reconsider(wire).catch((e: unknown) => reportFailure({ what: 'look at a chat copy again after its store answered late', cause: e, where: 'mesh.replicator' })); };
      fn().then((v) => { if (!done) { done = true; timer.cancel(); resolve(v); } else answered(); }, (e: unknown) => { if (!done) { done = true; timer.cancel(); reject(e); } else answered(); });
    });
  }
  /** Resolves when no work is queued (for tests and orderly shutdown). */
  async idle(): Promise<void> {
    for (let i = 0; i < 50; i++) { const q = [...this.#queues.values()]; await Promise.all(q); await Promise.resolve(); if (this.#queues.size === 0) return; if ([...this.#queues.values()].every((p, j) => p === q[j]) && this.#queues.size === q.length) return; }
  }
  /** Sizes of every per-peer and per-version table, so a test (and a status screen) can see they stay bounded (F6). */
  stateSizes(): { runs: number; queues: number; peerHeads: number; introAsked: number; reassemblyBytes: number; sessions: number } {
    let heads = 0; for (const p of this.#ctx.peers.values()) heads += p.heads.size;
    return { runs: this.#ctx.runs.size, queues: this.#queues.size, peerHeads: heads, introAsked: this.#introAsked.size, reassemblyBytes: this.#ctx.reassemblyBytes.used, sessions: this.#ctx.sessions.size };
  }
  /** The announced description of a version, or null (for tests and the service). */
  describe(wire: Buffer): VersionDescriptor | null { return this.#directory.describe(wire); }
  /** Counters by name (never content), for tests and status. */
  counters(): Record<string, number> { return Object.fromEntries(this.#ctx.counters); }
  private peerOf(id: Buffer): PeerInfo {
    const k = id.toString('hex');
    let p = this.#ctx.peers.get(k);
    if (!p) { p = { hex: k, id, lastSeen: this.#ctx.clock.now(), heads: new Map(), acks: new Map(), headsComplete: null, pages: null, claimSince: new Map(), introAsks: 0, introPeriodStart: this.#ctx.clock.now(), answers: new RateLimiter(0.5, () => this.#ctx.clock.now(), 6) }; this.#ctx.peers.set(k, p); }
    return p;
  }

  private async localOf(wire: Buffer): Promise<{ local: Buffer; incarnation: number; desc: VersionDescriptor } | null> {
    const desc = this.#directory.describe(wire);
    if (!desc) return null;
    const r = await setupVersion(this.#ctx, wire, desc);
    return r ? { ...r, desc } : null;
  }

  // ------------------------------------------------------------------ start, stop, connect
  async start(): Promise<void> {
    for (const wire of this.#directory.list()) await this.adopt(wire);
    await this.resumeSelfForks();
    for (const wire of this.#directory.list()) void this.resolveSelfFork(wire).catch((e: unknown) => reportFailure({ what: 'resolve a version that was contradicted', cause: e, where: 'mesh.replicator' }));
    this.#directory.onChange((wire) => { void this.adopt(wire).catch((e: unknown) => reportFailure({ what: 'start copying a new chat version', cause: e, where: 'mesh.replicator' })); });
    this.hello();
    this.armScrub();
    this.askHeads();
    this.armGate();
  }
  /** Review 1, F9: the store finds rot past its scrub mark only when something reads it. One slice of one version is scrubbed per tick (round robin, 4 MiB at most), so a copy that rots at rest is found while peers still hold the lines. */
  private armScrub(): void {
    const every = this.#o.scrubEveryMs ?? DEFAULT_SCRUB_MS;
    if (this.#stopped || every <= 0) return;
    this.#scrub = this.#ctx.clock.setTimeout(() => { void this.scrubTick().catch((e: unknown) => reportFailure({ what: 'scrub a chat copy in the background', cause: e, where: 'mesh.replicator' })).finally(() => this.armScrub()); }, every);
  }
  private async scrubTick(): Promise<void> {
    const list = this.#directory.list();
    if (list.length === 0) return;
    const wire = list[this.#scrubIdx++ % list.length];
    await this.queue(wire, async () => {
      const v = await this.localOf(wire);
      if (!v) return;
      const r = await this.#o.store.scrubStep(v.local, { maxBytes: SCRUB_SLICE_BYTES });
      this.#ctx.bump('scrub-slice');
      if (r.damagedFromLine !== null) { this.#ctx.bump('scrub-found-damage'); await checkRepair(this.#ctx, wire); }
      // the writer's own record could not be saved earlier: try again here, and announce once it is saved (review 3, finding 11)
      const run = this.#ctx.runOf(wire);
      if (run.ownPending) { await this.retryOwnPending(wire); if (!run.ownPending) void pushNew(this.#ctx, wire).catch((e: unknown) => reportFailure({ what: 'push new chat lines to the other devices', cause: e, where: 'mesh.replicator' })); }
    });
  }
  stop(): void {
    this.#stopped = true;
    this.#discovery?.cancel();
    this.#gateTimer?.cancel();
    this.#scrub?.cancel();
    for (const s of this.#ctx.sessions.values()) s.timer?.cancel();
    this.#ctx.sessions.clear();
    for (const r of this.#ctx.runs.values()) r.stall?.cancel();
    dropReassembly(this.#ctx);
  }
  /** A version became known: set it up, follow its group, read what waits there, and look at it. */
  private async adopt(wire: Buffer): Promise<void> {
    const v = await this.queue(wire, () => this.localOf(wire));
    const desc = this.#directory.describe(wire);
    if (desc) { const g = chatGroup(this.#o.setId, desc.chatId); this.#o.link.follow(g); void this.#o.link.sync(g); }
    this.#o.link.retryPending();
    if (v) await this.queue(wire, () => checkRepair(this.#ctx, wire));
    await this.reconsider(wire);
  }
  /** Connected (or reconnected, or the timer): say what I hold. Drops everything that belonged to the old connection. */
  hello(): void {
    if (this.#stopped) return;
    for (const s of this.#ctx.sessions.values()) s.timer?.cancel();
    this.#ctx.sessions.clear(); // WHY: "reconnect: drop all sessions"; the receiver re-asks
    // WHY acks are NOT wiped here any more (review 1, F2): a quiet, in-sync system must still be able to list them. An ack is valid only while the holder's latest heads agree with it (see peerAcks), and `solicitAcks` asks again.
    for (const r of this.#ctx.runs.values()) { r.rewanted.clear(); r.skip.clear(); r.lastSigned.clear(); }
    dropReassembly(this.#ctx);
    this.#introAsked.clear();
    // WHY here: damage the store finds on its own (a scrub, a read) is otherwise noticed only at the next append; every hello looks again
    for (const wire of this.#directory.list()) void this.queue(wire, () => checkRepair(this.#ctx, wire)).catch((e: unknown) => reportFailure({ what: 'look over a chat copy for damage', cause: e, where: 'mesh.replicator' }));
    void this.sendSum().catch((e: unknown) => reportFailure({ what: 'announce what this device holds', cause: e, where: 'mesh.replicator' }));
    this.#discovery?.cancel();
    this.#discovery = this.#ctx.clock.setTimeout(() => this.hello(), this.#o.discoveryMs ?? DEFAULT_DISCOVERY_MS);
  }

  // ------------------------------------------------------------------ what I advertise
  private async myEntries(): Promise<HeadEntry[]> {
    const out: HeadEntry[] = [];
    for (const wire of this.#directory.list().sort(Buffer.compare)) {
      const cur = await this.#ctx.ids.current(wire).catch(() => null /* benign: an id the store cannot answer for yet is simply not advertised; the next hello asks again */);
      if (!cur || !cur.registered) continue;
      let h: Head;
      try { h = await this.#o.store.head(cur.local); } catch (e) { if (!(e instanceof StoreError)) throw e; continue; }
      const from = repairFrom(h);
      let lines = h.lines; let hash = h.hash; let state: AdvertisedState = 'ok';
      // WHY the point I can vouch for, not my full head, while I repair (plan "Advertising the full head while refilling" is a quiet wrong answer)
      if (from !== null) { lines = from; state = 'refilling'; try { hash = (await this.#o.store.hashAt(cur.local, 0, from)) ?? hash; } catch (e) { if (!(e instanceof StoreError)) throw e; lines = 0; hash = (await this.#o.store.hashAt(cur.local, 0, 0)) ?? hash; } }
      out.push({ version: wire, lines, hash: unhex(hash), conversationHash: unhex(h.conversationHash), stamp: h.classifierStamp, state });
    }
    return out;
  }
  private async sendSum(): Promise<void> {
    const entries = await this.myEntries();
    this.#ctx.sendLive(KIND_SUM, sumBody({ count: entries.length, digest: digestOf(entries), ask: true }));
  }
  private async sendHeads(to: PeerInfo | null, ask: boolean, known?: HeadEntry[]): Promise<void> {
    const entries = known ?? await this.myEntries();
    const pages = Math.max(1, Math.ceil(entries.length / HEADS_PER_PAGE));
    for (let i = 0; i < pages; i++) this.#ctx.sendLive(KIND_HEADS, headsBodyOf({ page: i, of: pages, ask: ask && i === 0, heads: entries.slice(i * HEADS_PER_PAGE, (i + 1) * HEADS_PER_PAGE) }), to?.id);
  }
  private async broadcastHeads(): Promise<void> { await this.sendHeads(null, false); }

  // ------------------------------------------------------------------ frames in
  /** The link's frame handler for every `rep.*` kind. Parse failures throw (the link counts them by name); everything else is handled here and never throws past this line. */
  async onFrame(f: LinkFrame): Promise<void> {
    if (!REPLICATOR_KINDS.has(f.header.kind) || this.#stopped) return;
    const peer = this.peerOf(f.header.from);
    peer.lastSeen = this.#ctx.clock.now();
    if (f.header.kind === KIND_LINES) { await receiveLines(this.#ctx, peer, parseLinesBody(f.body)); return; }
    try {
      // WHY an if-chain, not a `switch`: the channel-table guard (tests/channel-table-complete.test.ts) reads any `case` on an imported
      // name as a possible hand-served app channel. These are mesh message kinds, not app channels; the chain keeps that guard exception-free.
      const kind = f.header.kind;
      if (kind === KIND_SUM) { const sb = parseSumBody(f.body); await this.onSum(peer, sb.digest, sb.ask); }
      else if (kind === KIND_HEADS) await this.onHeads(peer, parseHeadsBody(f.body));
      else if (kind === KIND_WANT) await onWant(this.#ctx, peer, parseWantBody(f.body));
      else if (kind === KIND_ACK) await onAck(this.#ctx, peer, parseAckBody(f.body));
      else if (kind === KIND_NAK) await this.onNak(peer, parseNakBody(f.body));
      else if (kind === KIND_INTRO) await this.onIntro(peer, parseIntroBody(f.body));
    } catch (e) {
      if (e instanceof FrameReject || (e as { name?: string }).name === 'MeshCryptoError') throw e; // named by the link
      this.#ctx.bump('handler-error');
      reportFailure({ what: 'handle a message from another device', cause: e, where: 'mesh.replicator' });
    }
  }

  private async onSum(peer: PeerInfo, digest: Buffer, ask: boolean): Promise<void> {
    // F6: one tiny frame must not cost a full read of every version; a peer gets a few answers, then one every two seconds
    if (!peer.answers.take()) { this.#ctx.bump('sum-rate-limited'); return; }
    const entries = await this.myEntries();
    if (ask) this.#ctx.sendLive(KIND_SUM, sumBody({ count: entries.length, digest: digestOf(entries), ask: false }), peer.id); // answer a hello with mine, once
    // WHY equal digests do not end the exchange until this peer has sent its heads once in this process: a digest can be echoed by a hostile device and proves nothing about what it HOLDS (review 2, finding 1)
    // ... and not for a recopied copy that still waits for a peer to be level with it, when this peer's claim about it is only an echo (that peer must say it in its own heads frame)
    const needsHeads = entries.some((e) => { const k = e.version.toString('hex'); const r = this.#ctx.runs.get(k); const ph = peer.heads.get(k); return r !== undefined && (r.retiredRecopy || (r.lastHead.incarnation > 0 && !r.caughtUp)) && (!ph || ph.echo === true); });
    if (digestOf(entries).equals(digest) && peer.headsComplete !== null && !needsHeads) {
      // the digest covers every (version, count, chain value, state): equal means this peer holds exactly what I hold, for every version
      this.#ctx.bump('sum-equal');
      const now = this.#ctx.clock.now();
      for (const e of entries) {
        const k = e.version.toString('hex');
        // WHY the echo flag is kept OFF when this peer's own heads already said exactly this (review 2, finding 1): an equal digest only repeats what its heads frame said, so evidence it gave stays evidence
        const prevE = peer.heads.get(k); const hexE = e.hash.toString('hex');
        const backed = prevE !== undefined && !prevE.echo && prevE.lines === e.lines && prevE.hash === hexE && prevE.state === e.state;
        peer.heads.set(k, { lines: e.lines, hash: hexE, state: e.state, at: now, ...(backed ? {} : { echo: true }) });
        // a version still marked diverged or pulling is looked at again now that this peer holds exactly what I hold (a stale or forged claim no longer stands)
        const r = this.#ctx.runs.get(k);
        if (r && (r.diverged || r.pull || r.retiredRecopy || !r.caughtUp)) void this.reconsider(e.version);
      }
      return;
    }
    await this.sendHeads(peer, true, entries); // the summaries differ: say what I hold and ask for theirs
  }
  private async onHeads(peer: PeerInfo, b: HeadsBody): Promise<void> {
    if (b.ask) { if (peer.answers.take()) await this.sendHeads(peer, false); else this.#ctx.bump('heads-rate-limited'); }
    const now = this.#ctx.clock.now();
    if (now - peer.introPeriodStart > INTRO_PERIOD_MS) { peer.introPeriodStart = now; peer.introAsks = 0; }
    let askedInFrame = 0;
    for (const e of b.heads) {
      const k = e.version.toString('hex');
      if (!this.#directory.describe(e.version)) {
        // F6: a version nobody announced to me costs at most an intro request (capped per frame and per period) and no stored claim beyond a small allowance
        const ik = `${peer.hex}/${k}`;
        if (peer.heads.size >= MAX_PEER_HEADS && !peer.heads.has(k)) { this.#ctx.bump('peer-heads-full'); continue; } // finding 8: claims about versions nobody announced count against the same cap
        if (!this.#introAsked.has(ik) && askedInFrame < MAX_INTRO_ASKS_PER_FRAME && peer.introAsks < MAX_INTRO_ASKS_PER_PERIOD) {
          this.#introAsked.add(ik); askedInFrame++; peer.introAsks++; askIntro(this.#ctx, peer, e.version);
          peer.heads.set(k, { lines: e.lines, hash: e.hash.toString('hex'), state: e.state, at: now }); // kept so the announcement, when it comes, can be acted on at once
        } else this.#ctx.bump('heads-unknown-version-ignored');
        continue;
      }
      // a peer that now says fewer lines than it acknowledged has rolled back: its ack no longer counts (acks may fall)
      const ack = peer.acks.get(k);
      if (ack && (e.lines < ack.lines || e.state !== 'ok')) peer.acks.delete(k);
      if (peer.heads.size >= MAX_PEER_HEADS && !peer.heads.has(k)) { this.#ctx.bump('peer-heads-full'); continue; }
      const prevH = peer.heads.get(k); const hx = e.hash.toString('hex');
      peer.heads.set(k, { lines: e.lines, hash: hx, state: e.state, at: now });
      await this.reconsider(e.version);
    }
    // per-page bookkeeping (review 3, finding 2): complete means EVERY page of one list arrived, not that the last one did
    if (b.page === 0 || peer.pages === null || peer.pages.of !== b.of) peer.pages = { of: b.of, seen: new Set() };
    peer.pages.seen.add(b.page);
    if (peer.pages.seen.size === peer.pages.of) { peer.headsComplete = now; peer.pages = null; }
  }
  private async onIntro(peer: PeerInfo, body: ReturnType<typeof parseIntroBody>): Promise<void> {
    const r = await (this.#directory as InterimDirectory).accept?.(body);
    if (r === undefined) return; // a directory that does not take announcements (the control log) ignores them
    if (r === 'new') { await this.adopt(body.version); void this.resolveSelfFork(body.version).catch((e: unknown) => reportFailure({ what: 'resolve a version that was contradicted', cause: e, where: 'mesh.replicator' })); return; }
    if (r === 'known') return;
    if (r === 'unknown-writer') { this.#ctx.bump('intro-unknown-writer'); return; } // the roster has not arrived yet; the next heads ask again
    if (r === 'conflict') { this.#ctx.bump('intro-conflict'); reportFailure({ what: 'accept a version announcement (it contradicts the one already held; the version is marked faulted)', where: 'mesh.replicator' }); return; }
    this.#ctx.bump(`intro-${r}`);
    throw new FrameReject(`intro-${r}`);
  }
  private async onNak(peer: PeerInfo, n: NakBody): Promise<void> {
    if (!this.#directory.describe(n.version)) { this.#ctx.bump('nak-unknown-version-ignored'); return; } // F6: nothing is created for a version nobody announced
    const run = this.#ctx.runOf(n.version);
    this.#ctx.bump(`nak-${n.why}`);
    // WHY a nak never changes a copy (invariant 4/5): it is unsigned. `not-a-prefix` only makes me ask this peer for the version from line 0, where every batch is signature-checked and `append` decides.
    if (n.why === 'not-a-prefix') {
      run.diverged = `peer ${hex8(peer.id)} says my copy is not a prefix of theirs`;
      if (!run.rewanted.has(peer.hex)) { run.rewanted.add(peer.hex); await this.want(n.version, peer, { haveLines: 0 }); }
      return;
    }
    if (n.why === 'unavailable' || n.why === 'evicted') { run.unavailable.add(peer.hex); run.unavailableRounds++; }
    run.skip.add(peer.hex);
    await this.reconsider(n.version);
  }

  // ------------------------------------------------------------------ comparing and asking
  private async want(wire: Buffer, peer: PeerInfo, opts: { haveLines?: number; through?: number | null; solicit?: boolean; round?: number } = {}): Promise<void> {
    const v = await this.localOf(wire);
    if (!v) return;
    const run = this.#ctx.runOf(wire);
    // the same peer is not asked again at once (a peer that cannot serve answers at once, and re-asking at once made two devices ping-pong at full speed, fuzz seed 815612): the stall timer or the
    // next heads exchange asks again after the gap. A different question (a restart from line 0, or a confirmation request) is not held back.
    if (!opts.solicit && opts.haveLines === undefined) {
      const last = run.wantAt.get(peer.hex); const nowMs = this.#ctx.clock.now();
      if (last !== undefined && nowMs - last < WANT_GAP_MS) { this.#ctx.bump('want-held-back'); this.armWantRetry(wire, run, WANT_GAP_MS - (nowMs - last)); return; }
      run.wantAt.set(peer.hex, nowMs);
    }
    const head = await this.#o.store.head(v.local);
    let have = opts.haveLines ?? (repairFrom(head) ?? head.lines);
    let hash: string | null = null;
    try { hash = await this.#o.store.hashAt(v.local, 0, have); } catch (e) { if (!(e instanceof StoreError && e.code === 'evicted')) throw e; }
    if (hash === null) { have = 0; hash = await this.#o.store.hashAt(v.local, 0, 0); } // a chain value I cannot give is replaced by the public start
    // finding 3: the newest writer-signed point I hold ABOVE what I am asking from, so a holder that has the lines but not that signature may serve up to it (I check every byte against the signature I hold)
    const newest = await this.#ctx.heads.newest(wire);
    let cover = newest && newest.lines > have ? { lines: newest.lines, hash: newest.hash, sig: newest.sig } : null;
    // the WRITER keeps no saved points of its own (it signs on demand): when its own record says it signed more than it holds, it signs that record again and offers it as the cover
    const wd = this.#directory.describe(wire);
    if (!cover && wd && wd.writer.equals(this.#ctx.crypto.self)) {
      const ev = await this.#own.read(wire);
      if (ev.effective && ev.effective.lines > have) { const raw = unhex(ev.effective.hash); cover = { lines: ev.effective.lines, hash: raw, sig: this.#ctx.crypto.sign(headMessage(wire, ev.effective.lines, raw)) }; }
    }
    if (opts.solicit && opts.round !== undefined) { run.rounds.push(opts.round); if (run.rounds.length > 8) run.rounds.shift(); }
    this.#ctx.sendLive(KIND_WANT, wantBodyOf({ version: wire, haveLines: have, haveHash: unhex(hash as string), through: opts.through ?? null, intro: false, round: opts.solicit ? (opts.round ?? 0) : 0, cover: opts.solicit ? null : cover }), peer.id);
    if (opts.solicit) return; // asking a peer to confirm what it holds is not a pull
    run.pull = { peer: peer.hex, haveLines: have, at: this.#ctx.clock.now() };
    run.stall?.cancel();
    run.stall = this.#ctx.clock.setTimeout(() => { void this.stalled(wire, have); }, this.#o.stallMs ?? DEFAULT_STALL_MS);
  }
  /** One re-look at the version after a held-back want (not one per held-back call). */
  private armWantRetry(wire: Buffer, run: VRun, inMs: number): void {
    if (run.stall) return; // a stall timer is already going to look again
    run.stall = this.#ctx.clock.setTimeout(() => { run.stall = null; void this.reconsider(wire); }, Math.max(100, inMs));
  }
  /** No progress since the want: the peer is gone or slow. Do not ask it again until someone else has been tried. */
  private async stalled(wire: Buffer, haveLines: number): Promise<void> {
    if (this.#stopped) return;
    const run = this.#ctx.runOf(wire);
    run.stall = null;
    try {
      const v = await this.localOf(wire);
      if (!v) return;
      const head = await this.#o.store.head(v.local);
      if (!run.pull || head.lines > haveLines) { await this.reconsider(wire); return; }
      run.skip.add(run.pull.peer); this.#ctx.bump('pull-stalled');
      run.pull = null;
      await this.reconsider(wire);
    } catch (e) { reportFailure({ what: 'retry asking for chat lines', cause: e, where: 'mesh.replicator' }); }
  }

  private async reconsider(wire: Buffer): Promise<void> {
    if (this.#stopped) return;
    const ctx = this.#ctx; const run = ctx.runOf(wire);
    // a self-fork child that grew may now show which history a contradicted parent copy holds (selffork.ts); only a contradicted parent is looked at
    const dd = this.#directory.describe(wire);
    if (dd?.parent && ctx.runOf(dd.parent).fault) void this.resolveSelfFork(wire).catch((e: unknown) => reportFailure({ what: 'resolve a version that was contradicted', cause: e, where: 'mesh.replicator' }));
    try {
      const v = await this.localOf(wire);
      if (!v) return;
      const wk = wire.toString('hex');
      const head = await this.#o.store.head(v.local);
      const from = repairFrom(head);
      const mine: HeadView = from === null ? { lines: head.lines, hash: head.hash, state: 'ok' } : { lines: from, hash: (await this.#o.store.hashAt(v.local, 0, from).catch(() => null /* benign: no chain value at that count (evicted): my own head's value stands in, which only makes this comparison more cautious */)) ?? head.hash, state: 'refilling' };
      const now = ctx.clock.now();
      const pulls: PeerInfo[] = []; let diverged: PeerInfo | null = null; let anySeen = false; let allSync = true; let inSyncPeers = 0; let unsureHolders = 0; let holder: PeerInfo | null = null;
      for (const p of ctx.peers.values()) {
        const ph = p.heads.get(wk);
        if (!ph || now - ph.at > PEER_FRESH_MS) continue;
        anySeen = true;
        let at: MineAtTheirs = null;
        if (ph.lines <= head.lines) { try { at = await this.#o.store.hashAt(v.local, 0, ph.lines); } catch (e) { if (e instanceof StoreError && e.code === 'evicted') at = 'unknown'; else throw e; } }
        const verdict = compareHeads(mine, { lines: ph.lines, hash: ph.hash, state: ph.state }, at);
        if (ph.state === 'ok' && ph.lines >= head.lines && !holder) holder = p;
        if (verdict.do !== 'in-sync') allSync = false;
        if ((verdict.do === 'pull' || verdict.do === 'diverged') && ph.state === 'ok' && !p.claimSince.has(wk)) p.claimSince.set(wk, now); // the unbacked-claim clock starts when the claim is HEARD
        if (verdict.do === 'in-sync' && ph.state === 'ok' && !ph.echo) inSyncPeers++; // an echoed digest is not evidence (review 2, finding 1)
        if (verdict.do === 'ignore-theirs') unsureHolders++; // a peer that is repairing may hold more than it can vouch for: it proves nothing either way
        if (verdict.do === 'pull') pulls.push(p);
        if (verdict.do === 'diverged' && !diverged) diverged = p;
      }
      // a copy that holds lines no saved writer signature covers (its signed-points file is older than its store) asks a device that holds at least as much for a covering signed point now, instead of waiting
      // for the writer's next append (review 3, finding 4). The batch it gets is checked against the writer's signature like any other, and appends nothing it already holds.
      const d0 = this.#directory.describe(wire);
      if (d0 && !d0.writer.equals(this.#ctx.crypto.self) && holder && !pulls.length && !diverged && !run.pull && repairFrom(head) === null) {
        const vz = await vouchLines(this.#ctx, wire, v.local, d0, head);
        if (vz.unsignable) { this.#ctx.bump('cover-fetch'); await this.want(wire, holder, { haveLines: vz.lines }); }
      }
      if (diverged) {
        run.diverged = `peer ${hex8(diverged.id)} claims a different history at the same point (not backed by a signed batch from it)`;
        // ask the WRITER (or the divergent peer) from line 0 once: signed batches decide what is true, never a count
        if (!run.rewanted.has(diverged.hex)) { run.rewanted.add(diverged.hex); await this.want(wire, diverged, { haveLines: 0 }); }
      } else if (!pulls.length && allSync && anySeen) { run.diverged = null; run.pull = null; run.skip.clear(); run.stall?.cancel(); run.stall = null; }
      // a copy that was recopied (or restarted after being recopied) counts as caught up once at least one fresh peer claim exists and none of them holds more or something else (F1)
      // WHY at least one peer must be level with me AND none unsure (fuzz seed 300584): the only fresh peer being one that was repairing made a recopied writer believe it was caught up, and it began a second history at line 0
      if (inSyncPeers > 0 && unsureHolders === 0 && !pulls.length && !diverged) { run.caughtUp = true; run.retiredRecopy = false; } // a recopy that finished by forking (no batch to clear it) is finished all the same
      // WHY separate: nobody claims more than I hold, so nothing is being pulled, even if some peer's (older) claim is still shorter than mine
      if (!pulls.length && !diverged && run.pull) { run.pull = null; run.skip.clear(); run.stall?.cancel(); run.stall = null; }
      if (pulls.length) {
        let cand = pulls.filter((p) => !run.skip.has(p.hex));
        if (!cand.length) { run.skip.clear(); cand = pulls; }
        // prefer the writer (its lines are signed on demand and it has everything), then the longest
        cand.sort((a, b) => Number(b.id.equals(v.desc.writer)) - Number(a.id.equals(v.desc.writer)) || (b.heads.get(wk)?.lines ?? 0) - (a.heads.get(wk)?.lines ?? 0));
        const busy = run.pull && now - run.pull.at < (this.#o.stallMs ?? DEFAULT_STALL_MS) && cand.some((p) => p.hex === run.pull?.peer) && run.pull.haveLines === (from ?? head.lines);
        if (!busy) await this.want(wire, cand[0]);
      } else if (run.refill && v.desc.writer.equals(ctx.crypto.self)) await this.writerRefill(wire, v.local, run);
      await this.adoptWaitingChildren(wire);
    } catch (e) {
      if (e instanceof StoreError && e.code === 'damaged') { await this.queue(wire, () => retireAndRecopy(ctx, wire, 'store-damaged')); return; }
      run.stuck = e instanceof StoreError ? e.code : 'reconsider-failed';
      reportFailure({ what: 'compare chat copies with the other devices', cause: e, where: 'mesh.replicator' });
    }
  }
  /** Children waiting for this version as their parent: one adoption in flight per child (F6). */
  private async adoptWaitingChildren(wire: Buffer): Promise<void> {
    for (const w of this.#directory.list()) {
      const d = this.#directory.describe(w);
      if (d?.parent?.equals(wire) && !this.#adopting.has(w.toString('hex')) && !(await this.#ctx.ids.current(w).then((c) => c.registered, () => true))) { this.#adopting.add(w.toString('hex')); void this.adopt(w).finally(() => this.#adopting.delete(w.toString('hex'))); }
    }
  }
  /** I am the writer and my copy lost lines no peer has: only my own chat file can supply them (an adapter); otherwise say so, loudly. */
  private async writerRefill(wire: Buffer, local: Buffer, run: VRun): Promise<void> {
    const r = run.refill as { from: number; end: number };
    if (!this.#ctx.sourceRefill) { run.stuck = 'refill-no-source'; return; }
    const lines = await this.#ctx.sourceRefill(wire, r.from, r.end);
    if (!lines) { run.stuck = 'refill-no-source'; return; }
    const res = await this.queue(wire, () => this.#o.store.append(local, 0, r.from, lines));
    if (res !== 'ok') { run.stuck = 'refill-rejected'; return; }
    run.caughtUp = true; // the writer's own chat file is the authority on its own lines
    await this.queue(wire, () => checkRepair(this.#ctx, wire));
  }

  // ------------------------------------------------------------------ for the rest of the app (adapters, the control log, the service)
  /** The writer announces a new version (a chat's first, or a takeover's child) and registers it. */
  async createVersion(d: Omit<VersionDescriptor, 'writer'>): Promise<void> {
    const dir = this.#directory as InterimDirectory;
    this.#ctx.runOf(d.version).evidence = true; // a version this device is creating now has no lost tail to find
    if (!dir.announce) throw new Error('this directory does not take announcements');
    const intro = await dir.announce({ ...d, writer: this.#ctx.crypto.self });
    await this.adopt(d.version);
    this.#ctx.sendLive(KIND_INTRO, introBodyOf(intro));
  }
  /** THE WRITER'S GATE, part 1: may this process append at all yet? (review 3, findings 1 and 2; design decision of the lead.)
   *  A writer restored from an old backup cannot know locally that it is behind, so this gate is best-effort and SIMPLE. It opens once EVERY roster device that is currently reachable (heard from since start, and
   *  within REACH_MS) has sent its heads COMPLETELY (every page); or when the set has no other device; or, when nobody is reachable, after WRITER_ALONE_MS. One device's answer says nothing about another reachable
   *  one, and an equal summary digest is never an answer. It is PURE (a status read never changes it); `tryLatch` latches it for the life of the process (it never expires), and the backstop for what no gate can
   *  see is the lossless self-fork (selffork.ts). */
  private gateOpen(): boolean {
    const devs = this.#o.devices();
    if (devs.length === 0) return true;
    const now = this.#ctx.clock.now();
    const reachable = devs.flatMap((d) => { const p = this.#ctx.peers.get(d.toString('hex')); return p && p.lastSeen >= this.#startedAt && now - p.lastSeen <= REACH_MS ? [p] : []; });
    if (reachable.length === 0) return now - this.#startedAt >= WRITER_ALONE_MS;
    return reachable.every((p) => p.headsComplete !== null && p.headsComplete >= this.#startedAt);
  }
  private tryLatch(): void {
    if (this.#gate || !this.gateOpen()) return;
    this.#gate = true;
    this.#ctx.bump(this.#o.devices().length === 0 ? 'gate-open-alone-set' : [...this.#ctx.peers.values()].some((p) => p.lastSeen >= this.#startedAt) ? 'gate-open-heads' : 'writing-alone');
  }
  /** Look at the gate now and then until it opens (a timer, not a status read: nothing else would notice that WRITER_ALONE_MS has passed). */
  private armGate(): void {
    if (this.#gate || this.#stopped) return;
    this.tryLatch();
    if (this.#gate) return;
    this.#gateTimer = this.#ctx.clock.setTimeout(() => this.armGate(), 1_000);
  }
  /** Ask every roster device for its COMPLETE heads (at most every 2 s). Called at start and on every refusal, so no refusal stays permanent while the others are healthy. */
  private askHeads(): void {
    const now = this.#ctx.clock.now();
    if (this.#stopped || now - this.#askedAt < 2_000) return;
    this.#askedAt = now;
    void this.sendHeads(null, true).catch((e: unknown) => reportFailure({ what: 'ask the other devices for their heads', cause: e, where: 'mesh.replicator' }));
  }
  /** Save the writer's record of its highest head to both places. A failed save keeps the head pending (retried) and is reported by the caller as `durable-not-recorded`. */
  private async saveOwnHead(wire: Buffer, lines: number, hash: string): Promise<boolean> {
    const r = await this.#own.save(wire, { lines, hash });
    for (const f of r.failed) reportFailure({ what: `save the writer's own record of its highest head (${f.where})`, cause: f.cause, where: 'mesh.replicator' });
    const run = this.#ctx.runOf(wire);
    if (r.ok === 2) { run.ownPending = null; return true; }
    run.ownPending = { lines, hash };
    return false;
  }
  private async retryOwnPending(wire: Buffer): Promise<void> {
    const p = this.#ctx.runOf(wire).ownPending;
    if (p) await this.saveOwnHead(wire, p.lines, p.hash);
  }
  /** THE WRITER'S GATE, part 2: may this version take a new line right now? Returns null, or the NAMED reason it may not (and the device concerned, if one). The same answer feeds `appendLocal` (as an error) and
   *  `status` (so a refusing writer never reads `in-sync`). Best-effort and simple by design (review 3): a checksummed own record and a witness copy catch PARTIAL rollbacks; a peer's claim of more lines holds an
   *  append only while it could still be backed; the process-wide gate (`gateOpen`) covers a start. Every refusal re-asks the peers for heads, so none is permanent while the others are healthy. A whole-profile
   *  restore is invisible here by nature; the self-fork (selffork.ts) turns that into a second version instead of lost lines. */
  private async writerGate(wire: Buffer, v: { local: Buffer; incarnation: number }, head: Head, run: VRun, opts: { heal: boolean }): Promise<{ reason: string; device?: string } | null> {
    if (run.fault) return { reason: `faulted-${run.fault}` };
    if (repairFrom(head) !== null) return { reason: 'refilling' };
    const ev = await this.#own.read(wire, opts.heal);
    if (ev.healed) this.#ctx.bump('own-record-healed');
    run.ownNote = ev.fallback; // counted and named in status while the writer runs on the store head plus the peer gate
    if (ev.fallback && opts.heal) this.#ctx.bump(`writer-${ev.fallback}`);
    const eff = ev.effective;
    if (eff) {
      if (head.lines < eff.lines) return { reason: 'behind-own-signed-head' };
      for (const rec of ev.lower ? [eff, ev.lower] : [eff]) {
        let mine: string | null = null;
        try { mine = await this.#o.store.hashAt(v.local, 0, rec.lines); } catch (e) { if (!(e instanceof StoreError && e.code === 'evicted')) throw e; mine = rec.hash; /* evicted: the chain value was lost with the index, cannot be compared here */ }
        if (mine !== rec.hash) return { reason: 'diverged-from-own-signed-head' };
      }
    } else if (v.incarnation > 0 && !run.caughtUp) return { reason: 'recopy-not-confirmed' }; // no usable record of its own: only a level peer can say it is not behind
    const wk = wire.toString('hex'); const now = this.#ctx.clock.now();
    for (const p of this.#ctx.peers.values()) {
      const h = p.heads.get(wk);
      if (!h || now - h.at > PEER_FRESH_MS || h.state !== 'ok' || h.echo) continue;
      const against = h.lines > head.lines || (h.lines === head.lines && h.hash !== head.hash);
      if (!against) continue;
      // a claim holds appends only while it could still be backed: the clock starts at the first such claim and is reset ONLY by a batch from that device, never by the device changing its claim (finding 6)
      let since = p.claimSince.get(wk);
      if (since === undefined) { since = now; if (opts.heal) p.claimSince.set(wk, now); }
      if (now - since > CLAIM_UNBACKED_MS) { if (opts.heal) this.#ctx.bump('claim-discounted'); run.discounted = hex8(p.id); continue; }
      return { reason: h.lines > head.lines ? 'behind-peer-holds-more' : 'diverged-from-peer', device: hex8(p.id) };
    }
    if (!run.evidence && !this.#gate && !this.gateOpen()) return { reason: 'waiting-for-peers' };
    return null;
  }

  /** Adapter entry point: append lines to a version this device is the writer of. Refuses otherwise (invariant 7). The new lines are pushed to every device.
   *  `expected` is REQUIRED (review 3, finding 7): the head the caller last saw (lines and chain value). A retry after a failure that left the lines durable cannot append them twice: if the store already holds
   *  exactly these lines on top of that head the answer is `already-saved`, and any other head is refused as `writer-head-moved`. Results: `saved`; `already-saved`; `durable-not-recorded` (the lines are in the
   *  store but the writer's own record of its highest head could not be written to both places; nothing is announced until it can be, and the next call retries). */
  async appendLocal(wire: Buffer, lines: Buffer[], expected: { lines: number; hash: string }): Promise<{ lines: number; hash: string; result: 'saved' | 'already-saved' | 'durable-not-recorded' }> {
    // a line the wire cannot carry is refused BEFORE anything is written (review 1, F5): the store takes 512 MiB, a peer parses 64 MiB; a line only I could ever read is a quiet loss
    for (const l of lines) if (l.length > MAX_LINE_BYTES) throw new Error('line-too-large');
    const out = await this.queue(wire, async () => {
      const desc = this.#directory.describe(wire);
      if (!desc) throw new Error('unknown version');
      if (!desc.writer.equals(this.#ctx.crypto.self)) throw new Error('not-the-writer');
      const run = this.#ctx.runOf(wire);
      // (a conflicting announcement does not stop the version's own writer: first-wins kept ITS announcement, and a paired device must not be able to freeze the writer by contradicting it)
      // a version that is announced but cannot be opened yet (a takeover's child while its parent copy is still being repaired) refuses by NAME; the caller tries again later
      const v = await this.localOf(wire);
      if (!v) throw new Error('version-not-ready');
      const head = await this.#o.store.head(v.local);
      if (run.ownPending) { await this.retryOwnPending(wire); if (run.ownPending) throw new Error('writer-own-record-not-saved'); void Promise.resolve().then(() => pushNew(this.#ctx, wire)).catch((e: unknown) => reportFailure({ what: 'push new chat lines to the other devices', cause: e, where: 'mesh.replicator' })); }
      this.tryLatch();
      const g = await this.writerGate(wire, v, head, run, { heal: true });
      if (g) { if (g.reason !== 'refilling') this.askHeads(); throw new Error(g.reason === 'refilling' ? 'refilling' : `writer-${g.reason}`); }
      if (head.lines !== expected.lines || head.hash !== expected.hash) {
        // the lines may already be there (an earlier call made them durable and then failed before answering): the same bytes, at exactly this place, on exactly that head
        let same = false;
        if (head.lines === expected.lines + lines.length && (await this.#o.store.hashAt(v.local, 0, expected.lines).catch(() => null /* benign: a chain value that is gone cannot match; refused below */)) === expected.hash) {
          const got = await this.#o.store.read(v.local, 0, expected.lines, head.lines);
          same = got !== 'evicted' && got.length === lines.length && got.every((l, i) => l.equals(lines[i]));
        }
        if (!same) throw new Error('writer-head-moved');
        const recorded = await this.saveOwnHead(wire, head.lines, head.hash);
        return { lines: head.lines, hash: head.hash, result: recorded ? 'already-saved' as const : 'durable-not-recorded' as const };
      }
      const res = await this.#o.store.append(v.local, 0, head.lines, lines);
      if (res !== 'ok') throw new Error(`append answered ${res}`);
      if (run.pushedThrough === null) run.pushedThrough = head.lines;
      const h = await this.#o.store.head(v.local);
      run.lastHead = { lines: h.lines, incarnation: v.incarnation };
      const recorded = await this.saveOwnHead(wire, h.lines, h.hash); // AFTER the store has the lines and BEFORE anything is signed or pushed from them
      return { lines: h.lines, hash: h.hash, result: recorded ? 'saved' as const : 'durable-not-recorded' as const };
    });
    // WHY a microtask: calls made in the same turn become one batch. Nothing is pushed while the record is not saved (the next append, or the scrub tick, retries and then pushes).
    if (out.result !== 'durable-not-recorded') void Promise.resolve().then(() => pushNew(this.#ctx, wire)).catch((e: unknown) => reportFailure({ what: 'push new chat lines to the other devices', cause: e, where: 'mesh.replicator' }));
    return out;
  }

  /** Where a version stands, in one named state with a reason. Sticky faults and blocked work come first and need no store call (a hung store must not hang the answer). */
  async status(wire: Buffer): Promise<VersionStatus> {
    // a store call that never answers must not make the answer itself hang (F8): the store half is raced against the same real-time ceiling as a queued step
    let timer: ReturnType<typeof setTimeout> | undefined;
    const blocked = new Promise<VersionStatus>((resolve) => { timer = setTimeout(() => resolve({ state: 'stuck', reason: 'store-call-blocked', lines: this.#ctx.runOf(wire).lastHead.lines, incarnation: this.#ctx.runOf(wire).lastHead.incarnation }), Math.min(this.#o.stepLimitMs ?? QUEUE_STEP_LIMIT_MS, 10_000)); timer.unref?.(); });
    try { return await Promise.race([this.statusNow(wire), blocked]); } finally { clearTimeout(timer); }
  }
  private async statusNow(wire: Buffer): Promise<VersionStatus> {
    const ctx = this.#ctx;
    if (!this.#directory.describe(wire)) return { state: 'unknown', reason: null, lines: 0, incarnation: 0 };
    const run = ctx.runOf(wire);
    const early = (state: VersionStatus['state'], reason: string): VersionStatus => ({ state, reason, lines: run.lastHead.lines, incarnation: run.lastHead.incarnation });
    const conflict = this.#directory.conflict?.(wire);
    if (conflict) return early('faulted', 'directory-conflict');
    // a copy contradicted by writer-signed lines of another history is KEPT and says what it waits for (the writer's self-fork announcement resolves it, selffork.ts); never a calm label
    if (run.fault === 'writer-signed-two-histories' || run.fault === 'unsigned-lines-contradicted') return early('diverged', `writer-two-histories (${run.fault}), waiting for the writer`);
    if (run.fault) return early('faulted', run.fault);
    if (run.stuck) return early('stuck', run.stuck);
    const cur = await ctx.ids.current(wire).catch(() => null /* benign: a version the store cannot open yet is reported below as having no lines; the state then comes from the other fields */);
    let lines = 0; let refilling = false;
    if (cur?.registered) { try { const h = await this.#o.store.head(cur.local); lines = h.lines; refilling = repairFrom(h) !== null; run.lastHead = { lines: h.lines, incarnation: cur.incarnation }; /* kept so a named early state (fault, stuck) shows the last TRUE count, not 0 (review 2, finding 7) */ } catch (e) { if (!(e instanceof StoreError)) throw e; } }
    const mk = (state: VersionStatus['state'], reason: string | null = null): VersionStatus => ({ state, reason, lines, incarnation: cur?.incarnation ?? 0 });
    if (run.diverged) return mk('diverged', run.diverged);
    if (refilling || run.refill) return mk('refilling');
    if (run.retiredRecopy) return mk('retired-recopy');
    // the writer's own record says it signed more lines than this copy holds (review 1 / fuzz 505206): never `in-sync`, whatever the peers claim (they may have lost the lines too)
    const desc = this.#directory.describe(wire);
    if (desc && desc.writer.equals(ctx.crypto.self) && cur?.registered) {
      // the same answer `appendLocal` would give, so a writer that is refusing never reads in-sync (review 3, finding 5)
      if (ctx.runOf(wire).ownPending) return mk('stuck', 'own-record-not-saved');
      const h3 = await this.#o.store.head(cur.local).catch(() => null /* benign: no head, the lines count above stands */);
      if (h3) {
        const g = await this.writerGate(wire, { local: cur.local, incarnation: cur.incarnation }, h3, run, { heal: false });
        if (g) {
          if (g.reason === 'waiting-for-peers') return mk('comparing', 'writer-waiting-for-peers');
          if (g.reason === 'behind-own-signed-head') return mk('refilling', 'behind-own-signed-head');
          if (g.reason === 'diverged-from-own-signed-head') return mk('diverged', 'diverged-from-own-signed-head');
          if (g.reason === 'behind-peer-holds-more') return mk('pulling', `peer-claims-more ${g.device}`);
          if (g.reason === 'diverged-from-peer') return mk('pulling', `peer-claims-another-history ${g.device}`);
          if (g.reason === 'recopy-not-confirmed') return mk('retired-recopy', 'not-confirmed-by-a-level-peer');
        }
      }
    }
    if (desc && !desc.writer.equals(ctx.crypto.self) && cur?.registered) {
      // holding lines no writer signature covers is said plainly, not shown as a calm picture (review 2, finding 3)
      const h2 = await this.#o.store.head(cur.local).catch(() => null /* benign: no head means no lines to speak of */);
      if (h2 && (await vouchLines(ctx, wire, cur.local, desc, h2)).unsignable) return mk('comparing', 'holds-lines-without-signature');
    }
    if (run.pull) {
      // every device that claims more lines has answered "unavailable" more than once: nothing will arrive without something changing (review 2, finding 3)
      const cands = [...ctx.peers.values()].filter((p) => { const h = p.heads.get(wire.toString('hex')); return h && h.lines > lines && ctx.clock.now() - h.at <= PEER_FRESH_MS; });
      if (desc && desc.writer.equals(ctx.crypto.self) && run.discounted) return mk('pulling', `peer-claim-discounted ${run.discounted}`);
      if (cands.length > 0 && run.unavailableRounds >= 2 * cands.length && cands.every((p) => run.unavailable.has(p.hex))) return mk('stuck', 'no-peer-can-serve');
      return mk('pulling', run.skip.size > 0 ? 'peers-not-answering' : null);
    }
    if ([...ctx.sessions.values()].some((s) => s.wire.equals(wire))) return mk('serving', run.serveWait ? 'waiting-for-read-memory' : null);
    // no copy is registered at the current incarnation (the announcement is known but the store has not been set up for it yet): nothing can be in sync with anything
    if (!cur?.registered) {
      // name the cause (review 3, finding 11): a takeover child waits for its parent copy; anything else waits for the store to set the copy up
      const par = desc?.parent ?? null; const pc = par ? await ctx.ids.current(par).catch(() => null /* benign: unknown parent state is reported as waiting for it */) : null;
      return mk('comparing', par && !pc?.registered ? `waiting-for-parent-version ${hex8(par)}` : 'waiting-for-the-store-to-set-the-copy-up');
    }
    const wk = wire.toString('hex'); const now = ctx.clock.now();
    const known = [...ctx.peers.values()].flatMap((p) => { const h = p.heads.get(wk); return h ? [h] : []; });
    if (known.length === 0) return mk('comparing');
    // F7: `in-sync` is only claimed from FRESH claims, none of which says the peer is repairing or cannot be compared with my chain
    const fresh = known.filter((h) => now - h.at <= PEER_FRESH_MS);
    if (fresh.length === 0) return mk('stale', 'no peer has said anything recently');
    if (fresh.some((h) => h.state !== 'ok')) return mk('peer-repairing');
    for (const h of fresh) {
      if (h.lines <= lines && cur?.registered) {
        try { await this.#o.store.hashAt(cur.local, 0, h.lines); } catch (e) { if (e instanceof StoreError && e.code === 'evicted') return mk('uncomparable', 'my chain value at a peer\'s count was evicted'); throw e; }
      }
    }
    // in sync = I hold everything any fresh claim names (a peer that claims fewer is behind me, which is its status to name, not mine)
    return fresh.every((h) => h.lines <= lines) ? mk('in-sync', run.ownNote ? `own-records-rebuilt-from-store (${run.ownNote})` : null) : mk('comparing');
  }

  /** Signed statements by other devices that they hold the first `lines` lines of `wire`, in the shape of an eviction proof's acks.
   *  EXACT GUARANTEE (review 2, finding 6). An ack is a statement signed by that device ("I hold the first `lines` lines, chain value `hash`"), and it is checked to lie on MY chain. It is listed only while
   *  that device's OWN heads (a separate message; an ack never refreshes them) are fresh, `ok`, at least as many lines, and the same chain value where the counts are equal. `round` says WHEN it held them:
   *  round n > 0: it answers my solicit number n, so it held them at a time no earlier than that device received that solicit (it signed the round); round 0: sent after its own append, so only "at some time
   *  no later than `receivedAt`" (my clock). It is NOT proof the lines are still readable now, and another device of the set can sign anything for itself. WHAT EVICTION MUST ADD: require acks with round > 0
   *  from a solicit sent after the decision to evict began (`solicitAcks`, then wait), plus a readable check of the holder (a fresh pull of a sample line); round 0 acks never suffice. */
  peerAcks(wire: Buffer): PeerAck[] {
    const wk = wire.toString('hex'); const out: PeerAck[] = []; const now = this.#ctx.clock.now();
    for (const p of this.#ctx.peers.values()) {
      const a = p.acks.get(wk); const h = p.heads.get(wk);
      if (!a) continue;
      // freshness basis, stated exactly: an ack that answers one of MY solicit rounds is fresh by itself (it was signed after that device received the solicit, and it reached me within the window);
      // an unsolicited one (round 0) is fresh only while that device's own heads are fresh. The device's heads, when newer than the ack, may only CONTRADICT it (state, fewer lines, another chain value).
      const solicited = a.round > 0 && now - a.at <= PEER_FRESH_MS;
      if (!solicited && (!h || now - h.at > PEER_FRESH_MS)) continue;
      if (h && (solicited ? h.at >= a.at : true)) {
        if (h.state !== 'ok' || h.lines < a.lines || (h.lines === a.lines && h.hash !== a.hash)) continue;
      }
      out.push({ holder: p.hex, version: wk, lines: a.lines, hash: a.hash, signature: a.sig.toString('hex'), round: a.round, receivedAt: a.at });
    }
    return out;
  }
  /** Ask every peer to confirm what it holds of `wire` (each answers with a signed ack of its head when it is level with me). Answers arrive through the normal ack path. */
  async solicitAcks(wire: Buffer): Promise<void> {
    // one round for all peers: the same number goes to each, and an answer is credited only when it names it
    // a random 48-bit round per solicit: it needs no persistence, so a round can never repeat across a restart or a folder rollback (review 3, finding 9)
    const round = randomBytes(6).readUIntBE(0, 6) + 1;
    for (const p of this.#ctx.peers.values()) await this.want(wire, p, { solicit: true, round });
  }
  /** Seam S9 (design): make sure the bodies of this version are present. NOT BUILT: restoring evicted bodies belongs to the storage policy; this only says whether they are readable. */
  async ensureBody(wire: Buffer): Promise<'present' | 'evicted'> {
    const v = await this.localOf(wire);
    if (!v) throw new Error('unknown version');
    const h = await this.#o.store.head(v.local);
    if (h.lines === 0) return 'present';
    return (await this.#o.store.read(v.local, 0, h.lines - 1, h.lines)) === 'evicted' ? 'evicted' : 'present';
  }
  /** What this device tells its peers it holds, per version (the point it can vouch for while repairing). */
  advertised(): Promise<HeadEntry[]> { return this.myEntries(); }
  /** What each peer last said about a version (claims, not proof), for status and tests. */
  peerView(wire: Buffer): Array<{ peer: string; lines: number; hash: string; state: AdvertisedState }> {
    const wk = wire.toString('hex');
    return [...this.#ctx.peers.values()].flatMap((p) => { const h = p.heads.get(wk); return h ? [{ peer: p.hex, lines: h.lines, hash: h.hash, state: h.state }] : []; });
  }
  /** THE SEAM FOR READERS. The store tells damage apart only when something reads it (`read` throws `corrupt`; head().damagedFromLine can stay null past the scrub mark). A screen, an adapter or
   *  anything else that gets `corrupt` from the store for a version calls this, and the replicator scrubs, sets the repair going and asks a peer for the lines. */
  async reportCorrupt(wire: Buffer): Promise<void> {
    await this.queue(wire, async () => { const v = await this.localOf(wire); if (v) await onCorruptRead(this.#ctx, wire, v.local); });
    await this.reconsider(wire);
  }
  /** The store's id for the current incarnation of a version (for the rig's read and verify routes). */
  async localId(wire: Buffer): Promise<Buffer> { const v = await this.localOf(wire); if (!v) throw new Error('unknown version'); return v.local; }
  /** Version ids (wire) this device knows. */
  versions(): Buffer[] { return this.#directory.list(); }
  /** For tests: the nak a peer would get (exposed so a hostile-peer test can drive the real path). */
  nakFor(peer: Buffer, wire: Buffer): void { sendNak(this.#ctx, this.peerOf(peer), wire, 0, 'unavailable'); }
  /** For tests and the rig: ask one peer for a version right now. */
  async askNow(wire: Buffer, peer: Buffer): Promise<void> { await this.want(wire, this.peerOf(peer)); }
}

function digestOf(entries: HeadEntry[]): Buffer {
  const h = createHash('sha256').update('youcoded-mesh/v1/replicator/sum\0');
  for (const e of entries) { const n = Buffer.alloc(8); n.writeBigUInt64BE(BigInt(e.lines)); h.update(Buffer.from([e.version.length])).update(e.version).update(n).update(e.hash).update(e.state); }
  return h.digest();
}
