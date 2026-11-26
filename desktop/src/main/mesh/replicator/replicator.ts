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
// ============================================================================================================================================================================
//
// HOW IT WORKS, in one paragraph. Every device says what it holds (`rep.sum`, then `rep.heads` when the summaries differ). The device that is BEHIND asks the device that is ahead
// (`rep.want`: "I hold N lines, chain value H"); the answer is a stream of `rep.lines` batches, each ending at a point the writer signed, which the receiver verifies, appends and
// acknowledges. The writer also pushes each new line to everyone as soon as it is appended, on the durable lane, so a device that is offline finds it waiting. The receiver drives:
// a lost frame is simply asked for again.
import { createHash } from 'node:crypto';
import { StoreError } from '../store';
import { MAX_LINE_BYTES } from './wire';
import { mkdirDurable, writeFileAtomic } from '../store/fsio';
import * as nodePath from 'node:path';
import type { ChatStore, Head } from '../store';
import { unhex } from '../store/chain';
import { realFs, type Fs } from '../store/fsio';
import { FrameReject, type LinkFrame } from '../link';
import { reportFailure } from '../../report-failure';
import { ByteBudget, INTRO_PERIOD_MS, MAX_HOLDS_PER_SECOND, MAX_INTRO_ASKS_PER_PERIOD, MAX_PEER_HEADS, QUEUE_STEP_LIMIT_MS, RateLimiter, READ_BUFFER_BUDGET_BYTES, REASSEMBLY_BUDGET_BYTES } from './budget';
import { compareHeads, type HeadView, type MineAtTheirs } from './compare';
import { chatGroup, hex8, realClock, repairFrom, type Clock, type PeerAck, type PeerInfo, type RepCtx, type ReplicatorLink, type SourceRefill, type VersionStatus, type VRun } from './ctx';
import { InterimDirectory, type ReplicatorCrypto, type VersionDescriptor, type VersionDirectory } from './directory';
import { setupVersion } from './forks';
import { IdMap, type Probe } from './idmap';
import { askIntro, dropReassembly, receiveLines, sendNak } from './receive';
import { checkRepair, onCorruptRead, retireAndRecopy } from './repair';
import { onAck, onWant, pushNew } from './serve';
import { SignedHeads } from './signed-heads';
import { GROUP_LIVE, headsBodyOf, introBodyOf, KIND_ACK, KIND_HEADS, KIND_INTRO, KIND_LINES, KIND_NAK, KIND_SUM, KIND_WANT, parseAckBody, parseHeadsBody, parseIntroBody, parseLinesBody, parseNakBody, parseSumBody, parseWantBody, REPLICATOR_KINDS, sumBody, wantBodyOf, type AdvertisedState, type HeadEntry, type NakBody, type HeadsBody } from './wire';

const HEADS_PER_PAGE = 500;
const DEFAULT_DISCOVERY_MS = 60_000;
const DEFAULT_STALL_MS = 20_000;
const PUSH_RATE_PER_SECOND = 40;
/** A peer whose last word is older than this is not chosen as a source (its heads may be long out of date). */
const PEER_FRESH_MS = 10 * 60_000;
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
  clock?: Clock;
  directory?: VersionDirectory;
  sourceRefill?: SourceRefill;
  discoveryMs?: number;
  stallMs?: number;
  /** How often the replicator scrubs one slice of one version (review 1, F9); 0 turns it off. Default 30 s. */
  scrubEveryMs?: number;
  /** A queued step that has not finished after this many REAL milliseconds is given up as `stuck(store-call-blocked)` (default 120 s). Real time on purpose: it measures a call that never answers, not virtual time. */
  stepLimitMs?: number;
}

const newRun = (): VRun => ({ stuck: null, diverged: null, retiredRecopy: false, refill: null, pull: null, seenRejected: 0, lastHead: { lines: 0, incarnation: 0 }, recopies: 0, rewanted: new Set(), lastSigned: new Map(), stall: null, pushedThrough: null, pushing: false, skip: new Set(), fault: null, caughtUp: false, serveWait: false, incarnationSeen: null });

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

  private constructor(o: ReplicatorOptions, directory: VersionDirectory, savedFaults: Map<string, string>) {
    for (const [k, v] of savedFaults) this.#savedFaults.set(k, v);
    this.#o = o;
    this.#directory = directory;
    const clock = o.clock ?? realClock;
    const fs = o.fs ?? realFs;
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
    if (!directory) { const d = new InterimDirectory(o.fs ?? realFs, o.dir, o.crypto); await d.load(); directory = d; }
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
      fn().then((v) => { if (!done) { done = true; timer.cancel(); resolve(v); } }, (e: unknown) => { if (!done) { done = true; timer.cancel(); reject(e); } });
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
    if (!p) { p = { hex: k, id, lastSeen: this.#ctx.clock.now(), heads: new Map(), acks: new Map(), introAsks: 0, introPeriodStart: this.#ctx.clock.now(), answers: new RateLimiter(0.5, () => this.#ctx.clock.now(), 6) }; this.#ctx.peers.set(k, p); }
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
    this.#directory.onChange((wire) => { void this.adopt(wire).catch((e: unknown) => reportFailure({ what: 'start copying a new chat version', cause: e, where: 'mesh.replicator' })); });
    this.hello();
    this.armScrub();
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
    });
  }
  stop(): void {
    this.#stopped = true;
    this.#discovery?.cancel();
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
    if (digestOf(entries).equals(digest)) {
      // the digest covers every (version, count, chain value, state): equal means this peer holds exactly what I hold, for every version
      this.#ctx.bump('sum-equal');
      const now = this.#ctx.clock.now();
      for (const e of entries) {
        const k = e.version.toString('hex');
        peer.heads.set(k, { lines: e.lines, hash: e.hash.toString('hex'), state: e.state, at: now });
        // a version still marked diverged or pulling is looked at again now that this peer holds exactly what I hold (a stale or forged claim no longer stands)
        const r = this.#ctx.runs.get(k);
        if (r && (r.diverged || r.pull)) void this.reconsider(e.version);
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
      peer.heads.set(k, { lines: e.lines, hash: e.hash.toString('hex'), state: e.state, at: now });
      await this.reconsider(e.version);
    }
  }
  private async onIntro(peer: PeerInfo, body: ReturnType<typeof parseIntroBody>): Promise<void> {
    const r = await (this.#directory as InterimDirectory).accept?.(body);
    if (r === undefined) return; // a directory that does not take announcements (the control log) ignores them
    if (r === 'new') { await this.adopt(body.version); return; }
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
    run.skip.add(peer.hex);
    await this.reconsider(n.version);
  }

  // ------------------------------------------------------------------ comparing and asking
  private async want(wire: Buffer, peer: PeerInfo, opts: { haveLines?: number; through?: number | null; solicit?: boolean } = {}): Promise<void> {
    const v = await this.localOf(wire);
    if (!v) return;
    const run = this.#ctx.runOf(wire);
    const head = await this.#o.store.head(v.local);
    let have = opts.haveLines ?? (repairFrom(head) ?? head.lines);
    let hash: string | null = null;
    try { hash = await this.#o.store.hashAt(v.local, 0, have); } catch (e) { if (!(e instanceof StoreError && e.code === 'evicted')) throw e; }
    if (hash === null) { have = 0; hash = await this.#o.store.hashAt(v.local, 0, 0); } // a chain value I cannot give is replaced by the public start
    this.#ctx.sendLive(KIND_WANT, wantBodyOf({ version: wire, haveLines: have, haveHash: unhex(hash as string), through: opts.through ?? null, intro: false }), peer.id);
    if (opts.solicit) return; // asking a peer to confirm what it holds is not a pull
    run.pull = { peer: peer.hex, haveLines: have, at: this.#ctx.clock.now() };
    run.stall?.cancel();
    run.stall = this.#ctx.clock.setTimeout(() => { void this.stalled(wire, have); }, this.#o.stallMs ?? DEFAULT_STALL_MS);
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
    try {
      const v = await this.localOf(wire);
      if (!v) return;
      const wk = wire.toString('hex');
      const head = await this.#o.store.head(v.local);
      const from = repairFrom(head);
      const mine: HeadView = from === null ? { lines: head.lines, hash: head.hash, state: 'ok' } : { lines: from, hash: (await this.#o.store.hashAt(v.local, 0, from).catch(() => null /* benign: no chain value at that count (evicted): my own head's value stands in, which only makes this comparison more cautious */)) ?? head.hash, state: 'refilling' };
      const now = ctx.clock.now();
      const pulls: PeerInfo[] = []; let diverged: PeerInfo | null = null; let anySeen = false; let allSync = true; let inSyncPeers = 0; let unsureHolders = 0;
      for (const p of ctx.peers.values()) {
        const ph = p.heads.get(wk);
        if (!ph || now - ph.at > PEER_FRESH_MS) continue;
        anySeen = true;
        let at: MineAtTheirs = null;
        if (ph.lines <= head.lines) { try { at = await this.#o.store.hashAt(v.local, 0, ph.lines); } catch (e) { if (e instanceof StoreError && e.code === 'evicted') at = 'unknown'; else throw e; } }
        const verdict = compareHeads(mine, { lines: ph.lines, hash: ph.hash, state: ph.state }, at);
        if (verdict.do !== 'in-sync') allSync = false;
        if (verdict.do === 'in-sync' && ph.state === 'ok') inSyncPeers++;
        if (verdict.do === 'ignore-theirs') unsureHolders++; // a peer that is repairing may hold more than it can vouch for: it proves nothing either way
        if (verdict.do === 'pull') pulls.push(p);
        if (verdict.do === 'diverged' && !diverged) diverged = p;
      }
      if (diverged) {
        run.diverged = `peer ${hex8(diverged.id)} holds a different history at the same point`;
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
    if (!dir.announce) throw new Error('this directory does not take announcements');
    const intro = await dir.announce({ ...d, writer: this.#ctx.crypto.self });
    await this.adopt(d.version);
    this.#ctx.sendLive(KIND_INTRO, introBodyOf(intro));
  }
  /** Adapter entry point: append lines to a version this device is the writer of. Refuses otherwise (invariant 7). The new lines are pushed to every device. */
  async appendLocal(wire: Buffer, lines: Buffer[]): Promise<{ lines: number; hash: string }> {
    // a line the wire cannot carry is refused BEFORE anything is written (review 1, F5): the store takes 512 MiB, a peer parses 64 MiB; a line only I could ever read is a quiet loss
    for (const l of lines) if (l.length > MAX_LINE_BYTES) throw new Error('line-too-large');
    const out = await this.queue(wire, async () => {
      const desc = this.#directory.describe(wire);
      if (!desc) throw new Error('unknown version');
      if (!desc.writer.equals(this.#ctx.crypto.self)) throw new Error('not-the-writer');
      const run = this.#ctx.runOf(wire);
      // (a conflicting announcement does not stop the version's own writer: first-wins kept ITS announcement, and a paired device must not be able to freeze the writer by contradicting it)
      if (run.fault) throw new Error(`writer-faulted-${run.fault}`);
      // a version that is announced but cannot be opened yet (a takeover's child while its parent copy is still being repaired) refuses by NAME; the caller tries again later
      const v = await this.localOf(wire);
      if (!v) throw new Error('version-not-ready');
      const head = await this.#o.store.head(v.local);
      if (repairFrom(head) !== null) throw new Error('refilling');
      // WRITER-SIDE (review 1, F1): the writer appends only while it is provably at its own latest signed head. A fresh incarnation that has not been refilled, or any fresh peer claim of more lines
      // of this version (or of the same count with another chain value), means this device lost lines it signed; a new line now would start a second history at the same position. Loud refusal.
      if (v.incarnation > 0 && !run.caughtUp) throw new Error('writer-recopy-not-confirmed');
      const wk = wire.toString('hex'); const now = this.#ctx.clock.now();
      for (const p of this.#ctx.peers.values()) {
        const h = p.heads.get(wk);
        if (!h || now - h.at > PEER_FRESH_MS || h.state !== 'ok') continue;
        if (h.lines > head.lines) throw new Error('writer-behind-peer-holds-more');
        if (h.lines === head.lines && h.hash !== head.hash) throw new Error('writer-diverged-from-peer');
      }
      const res = await this.#o.store.append(v.local, 0, head.lines, lines);
      if (res !== 'ok') throw new Error(`append answered ${res}`);
      if (run.pushedThrough === null) run.pushedThrough = head.lines;
      const h = await this.#o.store.head(v.local);
      return { lines: h.lines, hash: h.hash };
    });
    // WHY a microtask: calls made in the same turn become one batch
    void Promise.resolve().then(() => pushNew(this.#ctx, wire)).catch((e: unknown) => reportFailure({ what: 'push new chat lines to the other devices', cause: e, where: 'mesh.replicator' }));
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
    if (run.fault) return early('faulted', run.fault);
    if (run.stuck) return early('stuck', run.stuck);
    const cur = await ctx.ids.current(wire).catch(() => null /* benign: a version the store cannot open yet is reported below as having no lines; the state then comes from the other fields */);
    let lines = 0; let refilling = false;
    if (cur?.registered) { try { const h = await this.#o.store.head(cur.local); lines = h.lines; refilling = repairFrom(h) !== null; } catch (e) { if (!(e instanceof StoreError)) throw e; } }
    const mk = (state: VersionStatus['state'], reason: string | null = null): VersionStatus => ({ state, reason, lines, incarnation: cur?.incarnation ?? 0 });
    if (run.diverged) return mk('diverged', run.diverged);
    if (refilling || run.refill) return mk('refilling');
    if (run.retiredRecopy) return mk('retired-recopy');
    if (run.pull) return mk('pulling', run.skip.size > 0 ? 'peers-not-answering' : null);
    if ([...ctx.sessions.values()].some((s) => s.wire.equals(wire))) return mk('serving', run.serveWait ? 'waiting-for-read-memory' : null);
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
    return fresh.every((h) => h.lines <= lines) ? mk('in-sync') : mk('comparing');
  }

  /** Signed statements by other devices that they hold the first `lines` lines of `wire`, in the shape of an eviction proof's acks.
   *  CONTRACT (review 1, F2): an ack is listed only while that device's own latest heads agree with it (fresh, `ok`, at least as many lines, and the same chain value where the counts are equal), so a
   *  listed ack means "this device held exactly those lines at a time no earlier than its last heads". It is a statement SIGNED BY THAT DEVICE: another device of the set can sign anything for itself. */
  peerAcks(wire: Buffer): PeerAck[] {
    const wk = wire.toString('hex'); const out: PeerAck[] = []; const now = this.#ctx.clock.now();
    for (const p of this.#ctx.peers.values()) {
      const a = p.acks.get(wk); const h = p.heads.get(wk);
      if (!a || !h || h.state !== 'ok' || now - h.at > PEER_FRESH_MS) continue;
      if (h.lines < a.lines || (h.lines === a.lines && h.hash !== a.hash)) continue;
      out.push({ holder: p.hex, version: wk, lines: a.lines, hash: a.hash, signature: a.sig.toString('hex') });
    }
    return out;
  }
  /** Ask every peer to confirm what it holds of `wire` (each answers with a signed ack of its head when it is level with me). Answers arrive through the normal ack path. */
  async solicitAcks(wire: Buffer): Promise<void> {
    for (const p of this.#ctx.peers.values()) await this.want(wire, p, { solicit: true });
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
