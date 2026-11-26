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
import type { ChatStore, Head } from '../store';
import { unhex } from '../store/chain';
import { realFs, type Fs } from '../store/fsio';
import { FrameReject, type LinkFrame } from '../link';
import { reportFailure } from '../../report-failure';
import { ByteBudget, MAX_HOLDS_PER_SECOND, RateLimiter, READ_BUFFER_BUDGET_BYTES, REASSEMBLY_BUDGET_BYTES } from './budget';
import { compareHeads, type HeadView, type MineAtTheirs } from './compare';
import { chatGroup, hex8, realClock, repairFrom, type Clock, type PeerAck, type PeerInfo, type RepCtx, type ReplicatorLink, type SourceRefill, type VersionStatus, type VRun } from './ctx';
import { InterimDirectory, type ReplicatorCrypto, type VersionDescriptor, type VersionDirectory } from './directory';
import { setupVersion } from './forks';
import { IdMap, type Probe } from './idmap';
import { askIntro, dropReassembly, receiveLines, sendNak } from './receive';
import { checkRepair, retireAndRecopy } from './repair';
import { onAck, onWant, pushNew } from './serve';
import { SignedHeads } from './signed-heads';
import { headsBodyOf, introBodyOf, KIND_ACK, KIND_HEADS, KIND_INTRO, KIND_LINES, KIND_NAK, KIND_SUM, KIND_WANT, parseAckBody, parseHeadsBody, parseIntroBody, parseLinesBody, parseNakBody, parseSumBody, parseWantBody, REPLICATOR_KINDS, sumBody, wantBodyOf, type AdvertisedState, type HeadEntry, type NakBody, type HeadsBody } from './wire';

const HEADS_PER_PAGE = 500;
const DEFAULT_DISCOVERY_MS = 60_000;
const DEFAULT_STALL_MS = 20_000;
const PUSH_RATE_PER_SECOND = 40;
/** A peer whose last word is older than this is not chosen as a source (its heads may be long out of date). */
const PEER_FRESH_MS = 10 * 60_000;

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
}

const newRun = (): VRun => ({ stuck: null, diverged: null, retiredRecopy: false, refill: null, pull: null, seenRejected: 0, lastHead: { lines: 0, incarnation: 0 }, recopies: 0, rewanted: new Set(), lastSigned: new Map(), stall: null, pushedThrough: null, pushing: false, skip: new Set() });

export class Replicator {
  readonly #o: ReplicatorOptions;
  readonly #ctx: RepCtx;
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #introAsked = new Set<string>();
  readonly #directory: VersionDirectory;
  #discovery: { cancel(): void } | null = null;
  #stopped = false;

  private constructor(o: ReplicatorOptions, directory: VersionDirectory) {
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
      runOf: (wire) => { const k = wire.toString('hex'); let r = self.#ctx.runs.get(k); if (!r) { r = newRun(); self.#ctx.runs.set(k, r); } return r; },
      localOf: (wire) => self.localOf(wire),
      bump: (c) => { self.#ctx.counters.set(c, (self.#ctx.counters.get(c) ?? 0) + 1); },
      sendLive: (kind, body, to) => o.link.sendLive({ group: 'rep.live', kind, body, ...(to ? { to } : {}) }),
      want: (wire, peer, opts) => self.want(wire, peer, opts),
      reconsider: (wire) => self.reconsider(wire),
      advertise: () => { void self.broadcastHeads().catch((e: unknown) => reportFailure({ what: 'tell the other devices what this device holds', cause: e, where: 'mesh.replicator' })); },
    };
  }

  /** Make a replicator over `o`. Reads nothing from disk except the saved announcements (a missing folder is an empty one). */
  static async create(o: ReplicatorOptions): Promise<Replicator> {
    let directory = o.directory;
    if (!directory) { const d = new InterimDirectory(o.fs ?? realFs, o.dir, o.crypto); await d.load(); directory = d; }
    return new Replicator(o, directory);
  }

  // ------------------------------------------------------------------ plumbing
  private queue<T>(wire: Buffer, fn: () => Promise<T>): Promise<T> {
    const k = wire.toString('hex');
    const next = (this.#queues.get(k) ?? Promise.resolve()).catch(() => undefined /* benign: the previous step's failure was reported where it happened; it must not stop the next */).then(fn);
    this.#queues.set(k, next.catch(() => undefined /* benign: same; the caller of `next` sees the real failure */));
    return next;
  }
  /** Resolves when no work is queued (for tests and orderly shutdown). */
  async idle(): Promise<void> {
    for (let i = 0; i < 50; i++) { const q = [...this.#queues.values()]; await Promise.all(q); if ([...this.#queues.values()].every((p, j) => p === q[j]) && this.#queues.size === q.length) return; }
  }
  /** Counters by name (never content), for tests and status. */
  counters(): Record<string, number> { return Object.fromEntries(this.#ctx.counters); }
  private peerOf(id: Buffer): PeerInfo {
    const k = id.toString('hex');
    let p = this.#ctx.peers.get(k);
    if (!p) { p = { hex: k, id, lastSeen: this.#ctx.clock.now(), heads: new Map(), acks: new Map() }; this.#ctx.peers.set(k, p); }
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
  }
  stop(): void {
    this.#stopped = true;
    this.#discovery?.cancel();
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
    this.#ctx.sessions.clear(); // WHY: "reconnect: drop all sessions and in-memory acks"; the receiver re-asks
    for (const p of this.#ctx.peers.values()) p.acks.clear();
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
      const cur = await this.#ctx.ids.current(wire).catch(() => null);
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
  private async sendHeads(to: PeerInfo | null, ask: boolean): Promise<void> {
    const entries = await this.myEntries();
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
      switch (f.header.kind) {
        case KIND_SUM: { const sb = parseSumBody(f.body); await this.onSum(peer, sb.digest, sb.ask); return; }
        case KIND_HEADS: await this.onHeads(peer, parseHeadsBody(f.body)); return;
        case KIND_WANT: await onWant(this.#ctx, peer, parseWantBody(f.body)); return;
        case KIND_ACK: await onAck(this.#ctx, peer, parseAckBody(f.body)); return;
        case KIND_NAK: await this.onNak(peer, parseNakBody(f.body)); return;
        case KIND_INTRO: await this.onIntro(peer, parseIntroBody(f.body)); return;
      }
    } catch (e) {
      if (e instanceof FrameReject || (e as { name?: string }).name === 'MeshCryptoError') throw e; // named by the link
      this.#ctx.bump('handler-error');
      reportFailure({ what: 'handle a message from another device', cause: e, where: 'mesh.replicator' });
    }
  }

  private async onSum(peer: PeerInfo, digest: Buffer, ask: boolean): Promise<void> {
    const entries = await this.myEntries();
    if (ask) this.#ctx.sendLive(KIND_SUM, sumBody({ count: entries.length, digest: digestOf(entries), ask: false }), peer.id); // answer a hello with mine, once
    if (digestOf(entries).equals(digest)) {
      // the digest covers every (version, count, chain value, state): equal means this peer holds exactly what I hold, for every version
      this.#ctx.bump('sum-equal');
      const now = this.#ctx.clock.now();
      for (const e of entries) peer.heads.set(e.version.toString('hex'), { lines: e.lines, hash: e.hash.toString('hex'), state: e.state, at: now });
      return;
    }
    await this.sendHeads(peer, true); // the summaries differ: say what I hold and ask for theirs
  }
  private async onHeads(peer: PeerInfo, b: HeadsBody): Promise<void> {
    if (b.ask) await this.sendHeads(peer, false);
    const now = this.#ctx.clock.now();
    for (const e of b.heads) {
      const k = e.version.toString('hex');
      // a peer that now says fewer lines than it acknowledged has rolled back: its ack no longer counts (acks may fall)
      const ack = peer.acks.get(k);
      if (ack && (e.lines < ack.lines || e.state !== 'ok')) peer.acks.delete(k);
      peer.heads.set(k, { lines: e.lines, hash: e.hash.toString('hex'), state: e.state, at: now });
      if (!this.#directory.describe(e.version)) {
        const ik = `${peer.hex}/${k}`;
        if (!this.#introAsked.has(ik)) { this.#introAsked.add(ik); askIntro(this.#ctx, peer, e.version); }
        continue;
      }
      await this.reconsider(e.version);
    }
  }
  private async onIntro(peer: PeerInfo, body: ReturnType<typeof parseIntroBody>): Promise<void> {
    const r = await (this.#directory as InterimDirectory).accept?.(body);
    if (r === undefined) return; // a directory that does not take announcements (the control log) ignores them
    if (r === 'new') { await this.adopt(body.version); return; }
    if (r === 'known') return;
    if (r === 'unknown-writer') { this.#ctx.bump('intro-unknown-writer'); return; } // the roster has not arrived yet; the next heads ask again
    if (r === 'conflict') { this.#ctx.runOf(body.version).stuck = 'directory-conflict'; reportFailure({ what: 'accept a version announcement (it contradicts the one already held)', where: 'mesh.replicator' }); return; }
    this.#ctx.bump(`intro-${r}`);
    throw new FrameReject(`intro-${r}`);
  }
  private async onNak(peer: PeerInfo, n: NakBody): Promise<void> {
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
  private async want(wire: Buffer, peer: PeerInfo, opts: { haveLines?: number; through?: number | null } = {}): Promise<void> {
    const v = await this.localOf(wire);
    if (!v) return;
    const run = this.#ctx.runOf(wire);
    const head = await this.#o.store.head(v.local);
    let have = opts.haveLines ?? (repairFrom(head) ?? head.lines);
    let hash: string | null = null;
    try { hash = await this.#o.store.hashAt(v.local, 0, have); } catch (e) { if (!(e instanceof StoreError && e.code === 'evicted')) throw e; }
    if (hash === null) { have = 0; hash = await this.#o.store.hashAt(v.local, 0, 0); } // a chain value I cannot give is replaced by the public start
    this.#ctx.sendLive(KIND_WANT, wantBodyOf({ version: wire, haveLines: have, haveHash: unhex(hash as string), through: opts.through ?? null, intro: false }), peer.id);
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
      const mine: HeadView = from === null ? { lines: head.lines, hash: head.hash, state: 'ok' } : { lines: from, hash: (await this.#o.store.hashAt(v.local, 0, from).catch(() => null)) ?? head.hash, state: 'refilling' };
      const now = ctx.clock.now();
      const pulls: PeerInfo[] = []; let diverged: PeerInfo | null = null; let anySeen = false; let allSync = true;
      for (const p of ctx.peers.values()) {
        const ph = p.heads.get(wk);
        if (!ph || now - ph.at > PEER_FRESH_MS) continue;
        anySeen = true;
        let at: MineAtTheirs = null;
        if (ph.lines <= head.lines) { try { at = await this.#o.store.hashAt(v.local, 0, ph.lines); } catch (e) { if (e instanceof StoreError && e.code === 'evicted') at = 'unknown'; else throw e; } }
        const verdict = compareHeads(mine, { lines: ph.lines, hash: ph.hash, state: ph.state }, at);
        if (verdict.do !== 'in-sync') allSync = false;
        if (verdict.do === 'pull') pulls.push(p);
        if (verdict.do === 'diverged' && !diverged) diverged = p;
      }
      if (diverged) {
        run.diverged = `peer ${hex8(diverged.id)} holds a different history at the same point`;
        // ask the WRITER (or the divergent peer) from line 0 once: signed batches decide what is true, never a count
        if (!run.rewanted.has(diverged.hex)) { run.rewanted.add(diverged.hex); await this.want(wire, diverged, { haveLines: 0 }); }
      } else if (!pulls.length && allSync && anySeen) { run.diverged = null; run.pull = null; run.skip.clear(); run.stall?.cancel(); run.stall = null; }
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
      // children waiting for this version as their parent
      for (const w of this.#directory.list()) {
        const d = this.#directory.describe(w);
        if (d?.parent?.equals(wire) && !(await ctx.ids.current(w).then((c) => c.registered, () => true))) void this.adopt(w);
      }
    } catch (e) {
      if (e instanceof StoreError && e.code === 'damaged') { await this.queue(wire, () => retireAndRecopy(ctx, wire, 'store-damaged')); return; }
      run.stuck = e instanceof StoreError ? e.code : 'reconsider-failed';
      reportFailure({ what: 'compare chat copies with the other devices', cause: e, where: 'mesh.replicator' });
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
    const out = await this.queue(wire, async () => {
      const v = await this.localOf(wire);
      if (!v) throw new Error('unknown version');
      if (!v.desc.writer.equals(this.#ctx.crypto.self)) throw new Error('not-the-writer');
      const head = await this.#o.store.head(v.local);
      if (repairFrom(head) !== null) throw new Error('refilling');
      const res = await this.#o.store.append(v.local, 0, head.lines, lines);
      if (res !== 'ok') throw new Error(`append answered ${res}`);
      const run = this.#ctx.runOf(wire);
      if (run.pushedThrough === null) run.pushedThrough = head.lines;
      const h = await this.#o.store.head(v.local);
      return { lines: h.lines, hash: h.hash };
    });
    // WHY a microtask: calls made in the same turn become one batch
    void Promise.resolve().then(() => pushNew(this.#ctx, wire)).catch((e: unknown) => reportFailure({ what: 'push new chat lines to the other devices', cause: e, where: 'mesh.replicator' }));
    return out;
  }

  /** Where a version stands, in one named state with a reason. */
  async status(wire: Buffer): Promise<VersionStatus> {
    const ctx = this.#ctx; const run = ctx.runOf(wire);
    const cur = await ctx.ids.current(wire).catch(() => null);
    let lines = 0; let refilling = false;
    if (cur?.registered) { try { const h = await this.#o.store.head(cur.local); lines = h.lines; refilling = repairFrom(h) !== null; } catch (e) { if (!(e instanceof StoreError)) throw e; } }
    const mk = (state: VersionStatus['state'], reason: string | null = null): VersionStatus => ({ state, reason, lines, incarnation: cur?.incarnation ?? 0 });
    if (!this.#directory.describe(wire)) return mk('unknown');
    if (run.stuck) return mk('stuck', run.stuck);
    if (run.diverged) return mk('diverged', run.diverged);
    if (refilling || run.refill) return mk('refilling');
    if (run.retiredRecopy) return mk('retired-recopy');
    if (run.pull) return mk('pulling');
    if ([...ctx.sessions.values()].some((s) => s.wire.equals(wire))) return mk('serving');
    const wk = wire.toString('hex');
    const known = [...ctx.peers.values()].filter((p) => p.heads.has(wk));
    if (known.length === 0) return mk('comparing');
    // in sync = I hold everything any peer has claimed (a peer that claims fewer is behind me, which is its status to name, not mine)
    return known.every((p) => { const h = p.heads.get(wk); return h && h.lines <= lines; }) ? mk('in-sync') : mk('comparing');
  }

  /** Signed statements by other devices that they hold the first `lines` lines of `wire`, in the shape of an eviction proof's acks. Peers that are repairing are left out. */
  peerAcks(wire: Buffer): PeerAck[] {
    const wk = wire.toString('hex'); const out: PeerAck[] = [];
    for (const p of this.#ctx.peers.values()) {
      const a = p.acks.get(wk); const h = p.heads.get(wk);
      if (!a || (h && h.state !== 'ok')) continue;
      out.push({ holder: p.hex, version: wk, lines: a.lines, hash: a.hash, signature: a.sig.toString('hex') });
    }
    return out;
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
