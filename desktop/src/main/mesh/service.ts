// MeshService: starts the device layer (key store, roster log, relay client, link, pairing) and exposes the operations
// a screen or the test rig drives. Constructed ONLY by boot-hook.ts after config.ts said "on"; nothing here runs, creates
// a file or opens a socket otherwise.
//
// WHAT "IN A SET" MEANS: this device has keys, a set id, at least one set secret AND a non-empty roster log. Until then
// it only holds its identity (made on first enable) and waits for createSet() or a pairing.
//
// WHAT IS NOT HERE (later parts, listed so nobody assumes): the chat store and replicator (nothing replicates chats yet), who MAY add or
// remove whom (today ANY member may remove ANY other, the first device included: a deliberate reading of "all devices are equal" that the
// product owner still has to confirm; pinned by a test), real unlock prompts, and a durable outbox for frames (the roster needs none: see below).
//
// CONVERGENCE (second-round review). The roster is a pure function of the set of signed entries a device holds (crypto/roster.ts) and the
// shared secret follows it (crypto/generation.ts); every decision about entries and secrets lives in device-core.ts, which the convergence
// fuzz (tests/mesh/convergence-fuzz.test.ts) drives unchanged. This file only connects it to files, the relay and the screen.
//  * A device's roster entries are durable in roster.log the moment they are made. Nothing else has to survive a crash: the heads every device
//    repeats let any member that holds an entry another lacks send it, and entries that arrive before what they rest on are parked and asked for.
//  * A REMOVAL: the signed `remove` entry is written to the log, queued for the relay (relay-sync.json) and published. The next shared secret is
//    made by whoever's turn it is (members ranked by id, the next rank takes over after genTakeoverMs without one), sealed to every member and
//    sent in a bundle; any holder re-seals the same secret to a member that lacks it. removeDevice() answers 'done' when the relay accepted the
//    entry AND this device holds the new secret; otherwise 'pending' and it finishes in the background. Until a secret for the removals this
//    device knows of is held, nothing new is sealed (notes wait), so a removed device never reads anything sent after the removal is known.
//  * A device that sees itself removed goes quiet (no secrets, no hello, no notes) but keeps reading and asking: the removal may be voided.
//  * PAIRING (host): the relay is told first, the log written second, so a refusal leaves the host untouched. The new device signs a first entry
//    of its own when it joins; until then it is "pending" (status().pendingDevices). NOTHING removes a pending device by itself (the old 15-minute
//    rollback removed good devices, review N8).
//  * RECEIVING a generation bundle: see device-core.ts acceptBundle.
// PAIRING OVER THE RELAY. openPairingViaRelay() / joinWithCode() run the pairing exchange through the relay's meeting point
// (meeting-client.ts). The older openPairing() / joinStart() / hostPairingMessage() / joinMessage() surface stays as the DIRECT
// test carrier (unit tests and the rig's hostile-pipe case move the bytes themselves).
// ROSTER CHANGES AT THE RELAY are signed statements (putAtRelay), not plain add/remove messages.
import path from 'path';
import { toHex, utf8 } from './crypto/bytes';
import { meetingIdFor, signRosterStatement } from './crypto/relay-auth';
import { newSetSecret } from './crypto/keys';
import { encodeStatement, signStatement } from './crypto/generation';
import { DeviceCore, GenBook, type Out } from './device-core';
import { deviceIdFor, setIdFor, type DeviceIdentity } from './crypto/identity';
import { makeGenesisEntry, makeRemoveEntry, makeRenameEntry, parseEntry, encodeEntry, seenForNextEntry, type SignedEntry } from './crypto/roster';
import { MeshCryptoError } from './crypto/errors';
import { relayCarrier } from './carrier-relay';
import { FrameReject, FrameWait, Link, type LinkFrame } from './link';
import { MeshKeyStore, type MeshKeys, type SecretSealer } from './keystore';
import { RelaySyncState } from './relay-sync';
import { MeetingClient } from './meeting-client';
import { generateCode } from './crypto/pairing';
import { adoptPairing, MEETING_PART_LENGTH, newTypedCode, PairingHost, PairingJoiner, parseTypedCode } from './pair-flow';
import { RelayClient } from './relay-client';
import { RosterStore } from './roster-store';
import { ensureDir, readFileIfExists, writeFileDurable } from './fs-durable';
import { generateIdentity } from './crypto/identity';
import { GROUP_ROSTER, GROUP_TEST_NOTE, KIND_NOTE, KIND_ROSTER, noteBody, parseNoteBody, rosterBody } from './wire';
import { reportFailure } from '../report-failure';

type MeshLog = (event: string, fields?: Record<string, string | number | boolean>) => void;
export interface MeshServiceOptions {
  userData: string;
  sealer: SecretSealer;
  testMode: boolean;
  /** `ws://host:port` of the relay, or undefined: no relay, no network. */
  relayUrl?: string;
  deviceName: string;
  platform: string;
  log: MeshLog;
  now?: () => number;
  /** Relay timing, shrunk by the rig (design 5.2: "the rig must be able to shrink" timers). */
  relayBaseDelayMs?: number;
  /** Kept for old callers; no longer used. A pairing is never undone by a timer (review N8): an unconfirmed device stays listed as pending. */
  pairConfirmMs?: number;
  /** Each rank in the member order waits this much longer before making the next shared secret itself (default 15 s). */
  genTakeoverMs?: number;
  /** How often this device repeats its roster heads so a dropped frame heals (default 30 s). */
  headsEveryMs?: number;
  /** removeDevice() waits this long for the relay before answering 'pending' (default 10 s). */
  removeWaitMs?: number;
  /** First retry delay for the relay queue (doubles up to 30 s; default 2 s). */
  relayRetryMs?: number;
}
export type RemovalOutcome = 'done' | 'pending';

export interface InboxItem { from: string; counter: number; text: string }
export interface MeshStatus {
  deviceId: string;
  inSet: boolean;
  keystore: string;
  relay: string;
  rosterCount: number;
  rosterIds: string[];
  /** Short ids of devices that are on the roster and not removed. */
  activeDevices: string[];
  removedDevices: string[];
  generations: number[];
  /** The generation new frames are sealed under, or null while none is held for the removals this device knows of. */
  currentGeneration: number | null;
  /** Devices on the roster that have not signed an entry of their own yet (pairing not finished). */
  pendingDevices: string[];
  parkedEntries: number;
  inbox: number;
  repairedTailBytes: number;
  parkedRoster: number;
  /** Frames this device refused, by reason (never content), and the latest few with the sender's 8-character id prefix. */
  rejections: { counts: Record<string, number>; recent: Array<{ group: string; seq: number; from: string; reason: string }> };
  /** Frames waiting to be judged (their signer, secret or roster entry has not arrived). */
  waitingFrames: number;
  /** Devices whose removal is recorded here but not yet accepted by the relay ("removal pending"). */
  removalsPending: string[];
  /** Own roster changes the relay has not accepted yet, and refusals it gave, by reason. */
  relayPending: number;
  relayRefusals: Record<string, number>;
  /** Members judged to be flooding the roster (entries ignored), roster entries refused by reason, and entries still allowed in the log. */
  flaggedDevices: string[];
  rosterRejected: Record<string, number>;
  rosterHeadroom: number;
  /** Pairings this device hosted whose new device has not been seen on the relay yet. */
  unconfirmedJoins: string[];
  rosterGaps: number;
  /** How many doorbells the relay has rung on this device (each makes the link fetch). The rig asserts catch-up is bell-driven. */
  doorbells: number;
}

// WHY these relay answers are retried and the rest are not: a rate limit or a network trouble passes, a refusal such as `banned` or
// `bad-ancestry` never will, and retrying it forever would only hide it.
const TRANSIENT = new Set(['roster-rate-limited', 'rate-limited', 'too-fast', 'relay-busy']);
const ADD_PATIENCE = new Set(['already-member']);

export class MeshService {
  readonly dir: string;
  readonly keys: MeshKeyStore;
  readonly roster: RosterStore;
  #k!: MeshKeys;
  #relay: RelayClient | null = null;
  #link: Link | null = null;
  #host: PairingHost | null = null;
  #joiner: { j: PairingJoiner; identity: DeviceIdentity } | null = null;
  /** The meeting this device opened as host, and the guest connection (relay `gen`) the host is currently talking to. */
  #hostMeeting: { client: MeetingClient; gen: number; timer: NodeJS.Timeout } | null = null;
  #joinMeeting: MeetingClient | null = null;
  #joinState: { stage: string; sas?: string; done: boolean; failed?: string } = { stage: 'none', done: false };
  readonly #sync: RelaySyncState;
  #draining = false;
  #drainAgain = false;
  #retryTimer: NodeJS.Timeout | null = null;
  #retryAttempt = 0;
  readonly #settled = new Map<string, 'ok' | 'refused'>();
  readonly #waiters = new Map<string, Array<(r: 'ok' | 'refused') => void>>();
  readonly #refusals = new Map<string, number>();
  readonly #rosterRejected = new Map<string, number>();
  #core: DeviceCore | null = null;
  readonly #book = new GenBook();
  #planTimer: NodeJS.Timeout | null = null;
  #headsTimer: NodeJS.Timeout | null = null;
  #afterChain: Promise<unknown> = Promise.resolve();
  #opChain: Promise<unknown> = Promise.resolve();
  #rosterGaps = 0;
  readonly inbox: InboxItem[] = [];
  #offline = false;
  #doorbells = 0;
  #removed = false;
  #stopped = false;
  constructor(readonly o: MeshServiceOptions) {
    this.dir = path.join(o.userData, 'mesh');
    this.keys = new MeshKeyStore(this.dir, o.sealer);
    this.roster = new RosterStore(this.dir, o.now);
    this.#sync = new RelaySyncState(this.dir);
  }

  /** Create the folder, load (or, on first enable, create) the identity, load the roster, and go live if already in a set. */
  async start(): Promise<void> {
    await ensureDir(this.dir);
    this.#k = await this.keys.loadOrCreate();
    await this.roster.load();
    await this.#sync.load();
    if (this.inSet()) await this.activate();
    this.o.log('started', { inSet: this.inSet(), keystore: this.keys.kind });
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    if (this.#planTimer) clearTimeout(this.#planTimer);
    if (this.#headsTimer) clearInterval(this.#headsTimer);
    this.#link?.stop();
    this.#relay?.stop();
    this.closeHostMeeting();
    this.#joinMeeting?.close();
  }

  inSet(): boolean {
    return !!this.#k.setId && this.#k.secrets.size > 0 && this.roster.size > 0;
  }
  private get id(): DeviceIdentity {
    return this.#k.identity;
  }
  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  // ---------------------------------------------------------------- going live
  private async activate(): Promise<void> {
    if (this.#link || this.#stopped) return;
    const setId = this.#k.setId as Buffer;
    if (this.o.relayUrl) {
      const isGenesis = this.roster.entries[0] && this.roster.entries[0].device.equals(this.id.deviceId);
      this.#relay = new RelayClient({
        url: this.o.relayUrl, setId, identity: this.id, createSet: !!isGenesis, log: this.o.log,
        baseDelayMs: this.o.relayBaseDelayMs,
      });
      // A removed device learns it here: nothing more is sent, and the screen (later) says so.
      // WHY the link is stopped too: its queued frames would otherwise wait forever for a connection that will never return.
      this.#relay.on('removed', () => { this.#removed = true; this.#link?.stop(); this.o.log('removed-from-set'); });
      this.#relay.on('doorbell', () => { this.#doorbells++; });
      this.#relay.on('version-refused', () => this.o.log('relay-version-refused'));
      // The relay is reachable (again): the queue of roster changes it still owes is worked off, and devices seen online confirm pairings.
      // WHY `presence()` and not the `devices` list in the sign-in answer: that list is the whole roster, online or not, so it proves nothing about a
      // pairing; the presence answer is who is connected right now.
      this.#relay.on('ready', () => { this.#retryAttempt = 0; void this.drainRelay(); void this.confirmOnline(); void this.afterChange(true); });
      this.#relay.on('presence-change', (p: { device: string; state: string }) => { if (p.state === 'on') this.confirmJoin(p.device); });
    }
    // The device-layer decisions (parked entries, which secret is current, who makes the next one) live in DeviceCore; see device-core.ts.
    this.#core = new DeviceCore({ identity: this.id, setId, roster: this.roster, book: this.#book, takeoverMs: this.o.genTakeoverMs ?? 15_000 });
    this.#core.adoptWelcome(this.#k.secrets, this.#k.stmts ?? new Map());
    this.#book.dirty = false;
    const carrier = this.#relay ? relayCarrier(this.#relay) : null;
    if (!carrier) return; // no relay configured: identity and roster work, nothing connects
    this.#link = new Link({
      identity: this.id, setId, carrier, meshDir: this.dir,
      secrets: () => this.#book.secrets(),
      // WHY (review N3, N12): notes are sealed only under the secret made for exactly the removals this device knows of, and not at all
      // until one is held. Control traffic (roster entries, bundles, heads, requests) uses the FIRST secret, which every device ever paired holds,
      // so it is always readable, including by a device that has just been removed by another (mutual removals must still exchange entries).
      // Third review, finding 7: only `wide` frames (removal bundles, removal entries, the removal-proof answer to a removed device) use the first secret that
      // removed devices still hold; every other control frame uses the secret made for the removals this device knows of, which excludes them.
      sealLabel: (group, _kind, wide) => (group === GROUP_ROSTER && wide ? (this.#core?.oldestLabel() ?? null) : (this.#core?.currentLabel() ?? null)),
      signKeyFor: (d) => this.roster.knownSignKeyFor(d),
      isRemoved: (d) => this.roster.isRemoved(d),
      now: this.o.now,
      // The receiver save number lives in the sealed key file (see link.ts for why and where it falls short).
      counter: { get: () => this.#k.receiverSaves, set: async (n) => { this.#k = await this.keys.update((k) => { k.receiverSaves = Math.max(k.receiverSaves, n); }); } },
      onFrame: (f) => this.onFrame(f),
      onEvent: (e, info) => {
        if (e === 'gap' && info.group === GROUP_ROSTER) { this.#rosterGaps++; void this.afterChange(true); }
        // a device that is behind announces its heads at once (at most every 5 s), so the others answer with the proof of what it missed
        if (e === 'waiting' && info.group === GROUP_ROSTER && this.now() - this.#lastWaitingHeads >= 5_000) { this.#lastWaitingHeads = this.now(); void this.afterChange(true); }
      },
      log: this.o.log,
    });
    await this.#link.start(this.o.testMode ? [GROUP_ROSTER, GROUP_TEST_NOTE] : [GROUP_ROSTER]);
    if (!this.#offline) this.#relay?.start();
    // Heads are repeated now and then so that a frame the relay dropped, or an entry that never left its author, still reaches everyone.
    this.#headsTimer = setInterval(() => { void this.afterChange(true); }, this.o.headsEveryMs ?? 30_000);
    this.#headsTimer.unref?.();
    // Whatever a previous run left half done is finished now (a killed backend between the steps of a pairing).
    void this.resume().catch(() => this.o.log('resume-failed'));
    void this.afterChange(false);
  }

  /** Everything that follows a change to the roster or the secrets, one at a time: save new secrets, wake waiting frames, and send what
   *  DeviceCore says to send (hello, a new secret when it is our turn, requests, heads when `announce`). */
  private afterChange(announce: boolean): Promise<void> {
    const run = async (): Promise<void> => {
      const core = this.#core;
      if (!core || this.#stopped) return;
      // WHY not stopped for good (convergence): a removal this roster shows can later turn out to have no effect (its signer was itself removed
      // at the same moment, see roster.ts VOID), so a device that sees itself removed only goes QUIET (no secrets made, nothing sent of its own,
      // no notes) and still reads and answers roster traffic; it resumes by itself if the removal is voided. A removal by the RELAY is final.
      if (this.#removed) return;
      const r = await core.tick(this.now(), announce);
      await this.persistBook();
      this.emit(r.out);
      if (this.#planTimer) { clearTimeout(this.#planTimer); this.#planTimer = null; }
      if (r.nextAt !== null) {
        this.#planTimer = setTimeout(() => { this.#planTimer = null; void this.afterChange(false); }, Math.max(10, r.nextAt - this.now()));
        this.#planTimer.unref?.();
      }
      this.#link?.retryPending();
      this.#link?.kick();
    };
    const p = this.#afterChain.then(run, run);
    this.#afterChain = p.catch(() => undefined); /* benign: p itself is returned, so its caller gets the failure; this copy only keeps one failed step from blocking the chain */
    return p;
  }
  #lastWaitingHeads = 0;
  private emit(out: Out[]): void {
    // optional: a frame that needs the current secret when none is held yet is dropped, not queued (it would block the bundle that creates that secret); heads and requests repeat
    for (const o of out) void this.#link?.sendDurable({ group: GROUP_ROSTER, kind: o.kind, body: o.body, to: o.to, wide: o.wide === true, optional: o.wide !== true }).catch((cause) => reportFailure({ what: 'send a device-list frame (heads and requests repeat)', cause, where: 'mesh.roster' }));
  }
  private async persistBook(): Promise<void> {
    if (!this.#book.dirty) return;
    this.#book.dirty = false;
    const held = [...this.#book.held];
    this.#k = await this.keys.update((k) => {
      for (const [label, h] of held) {
        k.secrets.set(label, h.secret);
        if (h.stmt) (k.stmts ??= new Map()).set(label, encodeStatement(h.stmt));
      }
    });
  }

  // ---------------------------------------------------------------- incoming frames
  private async onFrame(f: LinkFrame): Promise<void> {
    // A verified frame from a device proves it exists and holds the set secret: a pairing it came out of is complete.
    this.confirmJoin(toHex(f.header.from));
    const core = this.#core;
    if (!core || f.group !== GROUP_ROSTER) {
      if (!this.roster.signKeyFor(f.header.from)) throw new FrameReject('signer-removed');
      if (f.header.kind === KIND_NOTE && f.group === GROUP_TEST_NOTE && this.o.testMode) {
        this.inbox.push({ from: toHex(f.header.from), counter: f.header.counter, text: parseNoteBody(f.body) });
      }
      return; // any other kind is ignored: this layer does not know it
    }
    const r = await core.onMessage(f.header.kind, f.body, f.header.from, this.now());
    this.mirrorCounts();
    // WHY the secrets are saved BEFORE this handler returns: the link saves its read position right after, and a secret received in this
    // frame that was not yet on disk would be lost by a kill in between (nobody would send it again).
    await this.persistBook();
    this.emit(r.out);
    if (r.wait) throw new FrameWait('roster-entry');
    if (r.reject) throw new FrameReject(r.reject);
    if (r.changed) void this.afterChange(false);
  }
  private mirrorCounts(): void {
    if (!this.#core) return;
    for (const [k, n] of Object.entries(this.#core.counts)) this.#rosterRejected.set(k, n);
  }

  // ---------------------------------------------------------------- operations
  /** First device: make the set (genesis entry, generation-1 secret). The relay creates the room when this device first connects. */
  async createSet(): Promise<void> {
    if (this.inSet()) throw new Error('already in a set');
    const genesis = makeGenesisEntry(this.id, this.o.deviceName, this.o.platform, this.now());
    await this.roster.append(genesis);
    const setId = setIdFor(this.id.signKey);
    const secret = newSetSecret();
    const stmt = signStatement(this.id, { set: setId, removed: [], members: [this.id.deviceId], secret });
    this.#k = await this.keys.update((k) => { k.setId = setId; k.secrets = new Map([[stmt.label, secret]]); k.stmts = new Map([[stmt.label, encodeStatement(stmt)]]); });
    await this.activate();
  }

  private makeHost(): PairingHost {
    return new PairingHost({
      identity: this.id, setId: this.#k.setId as Buffer, secrets: () => this.#book.secrets(), stmts: () => new Map([...this.#book.held].filter(([, h]) => h.stmt).map(([l, h]) => [l, encodeStatement(h.stmt as never)])), roster: this.roster, now: this.o.now,
      // The relay must know the newcomer's public key before the newcomer can sign in: a statement signed by THIS device. Runs BEFORE the
      // add is written to our log (pair-flow.ts), so a refusal leaves nothing to undo.
      admitAtRelay: async (_signKeyHex, entry) => {
        if (!this.#relay) return;
        const dev = toHex(deviceIdFor((entry.body as { signKey: Uint8Array }).signKey));
        // The pairing is recorded as UNCONFIRMED before the relay hears of it: a kill from here on is recovered at the next start
        // (finish the add, then roll it back by a removal if the new device never shows up).
        await this.#sync.addJoin({ dev, entry: Buffer.from(encodeEntry(entry)).toString('base64'), at: this.now() });
        let r: string;
        try { r = await this.putAtRelay(entry); } catch { r = 'network'; }
        if (r !== 'ok') {
          await this.#sync.removeJoin(dev); // the relay did not take it: there is nothing to confirm or roll back
          throw new Error('relay refused the new device');
        }
        await this.#sync.noteAccepted(toHex(entry.id));
      },
      // WHY not awaited: the welcome must not wait for the other devices' copy of the roster; the frame is queued and retried by the link.
      afterAdded: (entry) => { void this.publishRoster([entry]).catch((cause) => reportFailure({ what: 'send the updated device list to the other devices (it is offered again with the next change)', cause, where: 'mesh.roster' })); },
    });
  }

  /** The `seen` list a relay statement carries: this entry's signer's own introduction plus the latest of its entries the relay accepted.
   *  WHY not the entry's own `seen` (review finding 1): that names the newest heads, which can be an entry the relay never heard of (a
   *  rename), and the relay's ancestry walk then could not reach the signer's introduction, so every later add and remove was refused. */
  private relaySeen(entry: SignedEntry): Buffer[] {
    const out: Buffer[] = [];
    const intro = this.roster.introductionOf(entry.device);
    if (intro && !intro.id.equals(entry.id)) out.push(intro.id);
    const acked = this.#sync.acked;
    if (acked && !out.some((x) => toHex(x) === acked) && acked !== toHex(entry.id)) out.push(Buffer.from(acked, 'hex'));
    // A creator's very first statement names its own genesis entry (which is the entry itself when the genesis is what is being told).
    if (out.length === 0) out.push(intro?.id ?? (entry.seen[0] as Buffer));
    return out;
  }

  /** Tell the relay about a roster entry THIS device signed (an `add`, a `remove` or a `rename`). Resolves 'ok' or the relay's reason;
   *  throws when the relay cannot be reached. WHY a statement (finding 8): the relay verifies a signature by a current member and the entry's
   *  stated ancestry. It sees the new device's public key and the entry's id, never its name (a rename carries no name at all). */
  private async putAtRelay(entry: SignedEntry): Promise<string> {
    if (!this.#relay || !this.#k.setId) return 'ok';
    const body = entry.body as { signKey?: Uint8Array; target?: Uint8Array };
    const kind = entry.kind === 'add' || entry.kind === 'remove' || entry.kind === 'rename' ? entry.kind : null;
    if (!kind) return 'ok'; // other kinds (none are written yet) are the decide layer's, not the relay's
    const target = kind === 'add' ? deviceIdFor(body.signKey as Uint8Array) : kind === 'remove' ? Buffer.from(body.target as Uint8Array) : this.id.deviceId;
    const targetKey = kind === 'add' ? Buffer.from(body.signKey as Uint8Array) : null;
    const seen = this.relaySeen(entry);
    const { sig } = signRosterStatement(this.id, { kind, room: this.#k.setId, target, targetKey, entry: entry.id, seen, at: entry.at });
    const r = await this.#relay.rosterPut({
      kind, signer: toHex(this.id.deviceId), target: toHex(target), ...(targetKey ? { targetKey: toHex(targetKey) } : {}),
      entry: toHex(entry.id), seen: seen.map((x) => toHex(x)), at: entry.at, sig: sig.toString('hex'),
    });
    return r === 'duplicate' ? 'ok' : r; // the relay already holds this exact entry
  }

  // ---------------------------------------------------------------- the relay queue (finding 1)
  /** Work off the entries the relay still owes an answer on, in log order. Safe to call any time; calls overlap into one run. */
  private async drainRelay(): Promise<void> {
    if (this.#draining) { this.#drainAgain = true; return; }
    this.#draining = true;
    try {
      for (;;) {
        const id = this.#sync.pending[0];
        if (!id) break;
        if (!this.#relay || this.#relay.state !== 'ready' || this.#stopped) break;
        const entry = this.roster.entryById(Buffer.from(id, 'hex'));
        if (!entry) { await this.#sync.settle(id, false); this.settled(id, 'refused'); continue; } // never reached the log: nothing to tell
        let r: string;
        try { r = await this.putAtRelay(entry); } catch { r = 'network'; }
        if (r === 'ok' || (entry.kind === 'add' && ADD_PATIENCE.has(r)) || (entry.kind === 'remove' && r === 'not-found')) {
          // 'not-found' on a removal: the relay already has that device as gone: the outcome we wanted.
          await this.#sync.settle(id, true);
          this.settled(id, 'ok');
          continue;
        }
        if (r === 'network' || TRANSIENT.has(r)) { this.scheduleRelayRetry(); break; }
        // A refusal that will not change (a banned device, a signer the relay does not know): counted and shown, never retried forever.
        this.#refusals.set(r, (this.#refusals.get(r) ?? 0) + 1);
        this.o.log('relay-roster-refused', { reason: r, kind: entry.kind });
        await this.#sync.settle(id, false);
        this.settled(id, 'refused');
      }
    } finally {
      this.#draining = false;
      if (this.#drainAgain) { this.#drainAgain = false; void this.drainRelay(); }
    }
  }
  private scheduleRelayRetry(): void {
    if (this.#retryTimer || this.#stopped) return;
    const delay = Math.min(30_000, (this.o.relayRetryMs ?? 2000) * 2 ** Math.min(this.#retryAttempt++, 5));
    this.#retryTimer = setTimeout(() => { this.#retryTimer = null; void this.drainRelay(); }, delay);
    this.#retryTimer.unref?.();
  }
  private settled(id: string, r: 'ok' | 'refused'): void {
    this.#settled.set(id, r);
    for (const w of this.#waiters.get(id) ?? []) w(r);
    this.#waiters.delete(id);
  }
  /** Resolves when the relay accepted (or finally refused) this entry, or 'pending' after `ms`. */
  private waitForRelay(id: string, ms: number): Promise<'ok' | 'refused' | 'pending'> {
    const done = this.#settled.get(id);
    if (done) return Promise.resolve(done);
    if (!this.#sync.pending.includes(id)) return Promise.resolve('ok');
    return new Promise((resolve) => {
      const t = setTimeout(() => { resolve('pending'); }, ms);
      t.unref?.();
      const list = this.#waiters.get(id) ?? [];
      list.push((r) => { clearTimeout(t); resolve(r); });
      this.#waiters.set(id, list);
    });
  }

  // ---------------------------------------------------------------- pairings that have to be confirmed
  // WHY NO TIMER (review N8): the host used to remove a new device it had not seen online within 15 minutes. If the host's own link was down
  // at that moment, or it restarted, a perfectly good device was removed. Now nothing is ever removed automatically: a device that has not
  // finished joining stays listed as "pending" (status().unconfirmedJoins / pendingDevices) until it signs its first entry; if the pairing
  // really failed, the leftover is removed by hand. A device that never existed holds sealed copies of the secret nobody can open.
  /** Ask the relay who is connected now; every unconfirmed pairing whose device is among them is confirmed. */
  private async confirmOnline(): Promise<boolean> {
    if (!this.#relay || this.#sync.joins.length === 0) return false;
    try {
      const online = await this.#relay.presence();
      for (const d of online) this.confirmJoin(d);
      return true;
    } catch { return false; }
  }
  /** The new device was seen on the relay (or sent a verified frame): the pairing really happened. */
  private confirmJoin(dev: string): void {
    if (!this.#sync.joins.some((j) => j.dev === dev)) return;
    void this.#sync.removeJoin(dev);
  }

  /** After a start: finish what a previous run left half done (a pairing the relay accepted whose add may not have reached the log). */
  private async resume(): Promise<void> {
    for (const j of this.#sync.joins) {
      try {
        const entry = parseEntry(Buffer.from(j.entry, 'base64'));
        if (!this.roster.has(entry.id)) {
          await this.roster.append(entry);
          void this.publishRoster([entry]).catch((cause) => reportFailure({ what: 'send the updated device list to the other devices (it is offered again with the next change)', cause, where: 'mesh.roster' }));
        }
        if (this.roster.confirmedIds().has(j.dev)) await this.#sync.removeJoin(j.dev);
      } catch { await this.#sync.removeJoin(j.dev); }
    }
    void this.drainRelay();
  }

  /** Host, DIRECT test carrier: start a typed-code invite. The code is returned to be SHOWN; it is not logged. */
  openPairing(room?: Buffer): { room: string; code: string } {
    if (!this.inSet()) throw new Error('not in a set');
    this.#host = this.makeHost();
    const o = this.#host.open(room);
    return { room: o.room.toString('hex'), code: o.code };
  }

  /**
   * Host, THROUGH THE RELAY: open a meeting point and return the typed code to show (the meeting part and the secret are
   * independent, see pair-flow.ts). The relay sees only the meeting id. Messages from each guest connection are fed to the
   * pairing host under its own connection name (`g<gen>`), so two strangers never share one exchange.
   */
  async openPairingViaRelay(): Promise<{ code: string; meeting: string }> {
    if (!this.inSet()) throw new Error('not in a set');
    if (!this.#relay || this.#relay.state !== 'ready') throw new Error('relay not connected');
    this.closeHostMeeting();
    const host = this.makeHost();
    // The secret is generated by the crypto library (Existing.openInvite); the meeting part is OURS and separate.
    const meetingPart = generateCode(MEETING_PART_LENGTH);
    const inv = host.open(utf8(meetingPart));
    const id = meetingIdFor(utf8(meetingPart)).toString('hex');
    const { ticket } = await this.#relay.meetOpen(id);
    const client = new MeetingClient({ url: this.o.relayUrl as string, id, role: 'host', ticket, log: this.o.log });
    const lifetime = setTimeout(() => this.closeHostMeeting(), Math.max(1000, inv.invite.expiresAt - this.now()));
    lifetime.unref?.();
    this.#host = host;
    this.#hostMeeting = { client, gen: 0, timer: lifetime };
    client.on('peer', (p: { state: string; gen: number }) => {
      if (p.state === 'on') { if (this.#hostMeeting) this.#hostMeeting.gen = p.gen; }
      else host.dropConnection(`g${p.gen}`);
    });
    client.on('message', (m: { gen: number; bytes: Buffer }) => {
      if (this.#host !== host) return;
      try { for (const out of host.onMessage(`g${m.gen}`, m.bytes)) client.send(out); } catch (cause) { reportFailure({ what: 'handle a pairing message from the meeting (the pairing will not complete; the person can start it again)', cause, where: 'mesh.pairing' }); }
    });
    client.on('closed', () => { if (this.#hostMeeting?.client === client) this.closeHostMeeting(); });
    await client.connect();
    return { code: newTypedCode(inv.code, meetingPart).display, meeting: id };
  }
  private closeHostMeeting(): void {
    const hm = this.#hostMeeting;
    if (!hm) return;
    this.#hostMeeting = null;
    clearTimeout(hm.timer);
    hm.client.close();
  }
  /** Host state the screen (and the rig) reads: what the pairing host has recorded for this invite (event names only). */
  pairingState(): { events: string[] } {
    return { events: [...(this.#host?.events ?? [])] };
  }
  pairingPrompt(): { conn: string; name: string; platform: string; fingerprint: string; sas: string } | null {
    const p = this.#host?.prompt;
    return p ? { conn: p.conn, ...p.info } : null;
  }
  hostPairingMessage(conn: string, bytes: Buffer): Buffer[] {
    return this.#host ? this.#host.onMessage(conn, bytes) : [];
  }
  async hostPairingDecide(conn: string, approved: boolean): Promise<Buffer[]> {
    if (!this.#host) return [];
    const out = await this.#host.decide(conn, approved);
    const hm = this.#hostMeeting;
    if (hm) {
      // Through the relay: send the answer (the welcome, or a refusal) to the guest, then end the meeting a moment later so it
      // is erased at the relay as soon as it has served. A pairing that did not complete still ends the meeting.
      try { for (const m of out) hm.client.send(m); } catch { /* benign: the guest closed the meeting before the answer; the pairing is over either way */ }
      setTimeout(() => { if (this.#hostMeeting === hm) this.closeHostMeeting(); }, 1500).unref?.();
    }
    return out;
  }

  /** Joiner: begin pairing with a typed code. Returns the first message for the pipe. */
  joinStart(invite: { room: Buffer; code: string }): Buffer {
    if (this.inSet()) throw new Error('already in a set');
    this.#joiner = { j: new PairingJoiner(this.id, invite, { name: this.o.deviceName, platform: this.o.platform }), identity: this.id };
    return this.#joiner.j.start();
  }
  /** Joiner: one message in, replies out. On success the pairing is made durable and the device goes live. */
  async joinMessage(bytes: Buffer): Promise<{ out: Buffer[]; stage: string; sas?: string; done: boolean; failed?: string }> {
    const jn = this.#joiner;
    if (!jn) return { out: [], stage: 'none', done: false };
    const out = jn.j.onMessage(bytes);
    const res = jn.j.result;
    if (res && res.ok) {
      await adoptPairing(res, this.keys, this.roster);
      this.#k = (await this.keys.load()) as MeshKeys;
      this.#joiner = null;
      await this.activate();
      return { out, stage: 'done', sas: res.sas, done: true };
    }
    return { out, stage: jn.j.stage, sas: jn.j.sas, done: false, failed: res && !res.ok ? res.why : undefined };
  }

  /**
   * Joiner, THROUGH THE RELAY: type the code, find the meeting, run the exchange. Returns once the meeting is joined; progress
   * (the matching number to show, done, failed) is read from joinStatus(). Throws MeshCryptoError('invalid-code') for a typo.
   */
  async joinWithCode(typed: string): Promise<void> {
    if (this.inSet()) throw new Error('already in a set');
    if (!this.o.relayUrl) throw new Error('no relay configured');
    const { meetingPart, secret } = parseTypedCode(typed);
    await this.freshIdentityForRetry();
    this.#joinMeeting?.close();
    this.#joinState = { stage: 'connecting', done: false };
    const first = this.joinStart({ room: utf8(meetingPart), code: secret });
    const client = new MeetingClient({ url: this.o.relayUrl, id: meetingIdFor(utf8(meetingPart)).toString('hex'), role: 'guest', log: this.o.log });
    this.#joinMeeting = client;
    client.on('message', (m: { bytes: Buffer }) => {
      void (async () => {
        try {
          const r = await this.joinMessage(m.bytes);
          this.#joinState = { stage: r.stage, sas: r.sas, done: r.done, failed: r.failed };
          for (const out of r.out) client.send(out);
          if (r.done || r.failed) client.close();
        } catch {
          this.#joinState = { stage: 'failed', done: false, failed: 'pairing-error' };
          client.close();
        }
      })();
    });
    // The host ending the meeting before we finished means the pairing did not happen.
    const gone = (): void => { if (!this.#joinState.done && !this.#joinState.failed) this.#joinState = { ...this.#joinState, failed: 'meeting-ended' }; };
    client.on('ended', gone);
    client.on('closed', gone);
    await client.connect();
    client.send(first);
  }
  /** WHY (review finding 1): a pairing that failed after the host wrote the add leaves this device's id banned in the set (a device id can
   *  never be added twice). A device that is not in a set owns nothing under its old identity, so a SECOND attempt starts with a new one. */
  private async freshIdentityForRetry(): Promise<void> {
    const marker = path.join(this.dir, 'join-attempted');
    if (await readFileIfExists(marker)) this.#k = await this.keys.update((k) => { k.identity = generateIdentity(); });
    await writeFileDurable(marker, Buffer.alloc(0));
  }
  joinStatus(): { stage: string; sas?: string; done: boolean; failed?: string } {
    return { ...this.#joinState };
  }

  private async publishRoster(entries: SignedEntry[]): Promise<void> {
    if (!this.#link) return;
    // a frame carrying a removal is wide: a removed device (and the other half of a mutual removal) must be able to read it
    const wide = entries.some((e) => e.kind === 'remove');
    await this.#link.sendDurable({ group: GROUP_ROSTER, kind: KIND_ROSTER, body: rosterBody(entries), wide, optional: !wide });
  }

  /** Test mode only: send a note to every device in the set. */
  async sendNote(text: string, to?: string): Promise<{ counter: number }> {
    if (!this.o.testMode) throw new Error('notes exist only in test mode');
    if (this.#removed || this.roster.isRemoved(this.id.deviceId)) throw new Error('removed from the set');
    if (!this.#link) throw new Error('not connected to a set');
    // line: true marks a chat line for the relay (30-day keep, may be released under pressure); roster frames are control data and are not marked.
    return this.#link.sendDurable({ group: GROUP_TEST_NOTE, kind: KIND_NOTE, body: noteBody(text), to: to ? Buffer.from(to, 'hex') : undefined, line: true });
  }

  /** Run roster operations one at a time (two removals at once would race on the generation number and on the log heads). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#opChain.then(fn, fn);
    this.#opChain = p.catch(() => undefined); /* benign: p itself is returned, so its caller gets the failure; this copy only keeps one failed operation from blocking the chain */
    return p;
  }

  /**
   * Remove a device. See the header for the five steps. Answers 'done' when the removal bundle is out, the new generation adopted AND the
   * relay has cut the device off; 'pending' when any of that is still outstanding after `removeWaitMs` (it keeps going in the background and
   * after a restart; `status().removalsPending` lists it). Throws only for what can never work (not in a set, unknown device).
   *
   * POLICY (product owner's decision, not changed here): ANY member may remove ANY other member, the set's first device and itself included.
   * The design says all devices are equal; the cost is that one compromised device can remove the others. tests pin this on purpose.
   */
  removeDevice(targetHex: string): Promise<RemovalOutcome> {
    return this.serial(() => this.removeDeviceNow(targetHex));
  }
  private async removeDeviceNow(targetHex: string): Promise<RemovalOutcome> {
    if (!this.#link || !this.#k.setId || !this.#core) throw new Error('not in a set');
    if (!/^[0-9a-f]{32}$/.test(targetHex)) throw new Error('bad device id');
    const target = Buffer.from(targetHex, 'hex');
    if (!this.roster.activeDevices().some((d) => d.deviceId.equals(target))) throw new Error('not an active device');
    const entry = makeRemoveEntry(this.id, target, seenForNextEntry(this.roster.entries, this.id.deviceId), this.now());
    // Queue for the relay BEFORE the log write (a kill between the two leaves an id with no entry, which the queue drops), then write.
    const id = toHex(entry.id);
    await this.#sync.enqueue(id);
    await this.roster.append(entry);
    this.#settled.delete(id);
    void this.drainRelay();
    // The new shared secret is made by whoever's turn it is (device-core.ts), not necessarily this device: nothing here waits on a bundle
    // being sent, so a removal can no longer block later operations (review N12).
    void this.publishRoster([entry]).catch((cause) => reportFailure({ what: 'send the updated device list to the other devices (it is offered again with the next change)', cause, where: 'mesh.roster' }));
    await this.afterChange(true);
    const wait = this.o.removeWaitMs ?? 10_000;
    const relay = await this.waitForRelay(id, wait);
    const t0 = Date.now();
    while (this.#core.currentLabel() === null && Date.now() - t0 < wait) await new Promise((r) => setTimeout(r, 15));
    return relay === 'ok' && this.#core.currentLabel() !== null ? 'done' : 'pending';
  }

  /** Change this device's own name (a signed `rename` entry; the relay is told it happened but never the name). */
  renameSelf(name: string): Promise<void> {
    return this.serial(async () => {
      if (!this.inSet()) throw new Error('not in a set');
      const entry = makeRenameEntry(this.id, name, seenForNextEntry(this.roster.entries, this.id.deviceId), this.now());
      await this.#sync.enqueue(toHex(entry.id));
      await this.roster.append(entry);
      void this.drainRelay();
      void this.publishRoster([entry]).catch((cause) => reportFailure({ what: 'send the updated device list to the other devices (it is offered again with the next change)', cause, where: 'mesh.roster' }));
      void this.afterChange(true);
    });
  }

  /** Operator action: read every group again from the start (a damaged or poisoned read position). Already-applied frames stay refused as replays. */
  async resetReadPosition(): Promise<void> {
    await this.#link?.resetReadPosition();
  }

  /** Rig only: take this device off the relay (or back on) without stopping the process. */
  setOffline(offline: boolean): void {
    this.#offline = offline;
    if (offline) this.#relay?.stop();
    else this.#relay?.start();
  }

  /** Rig only: append `n` valid roster entries (renames) one by one, each fsynced, to give a kill something to interrupt. */
  async stressAppend(n: number): Promise<number> {
    let done = 0;
    for (let i = 0; i < n; i++) {
      // Appends directly (no relay statement): a stand-in for entries the relay was never told about. The statement of a later add
      // is built from entries the relay knows (relaySeen), which is exactly what this exercises.
      await this.roster.append(makeRenameEntry(this.id, `${this.o.deviceName}-${i}`, seenForNextEntry(this.roster.entries, this.id.deviceId), this.now()));
      done++;
    }
    return done;
  }

  /** Targets of removals recorded here that the relay has not accepted yet, or whose new shared secret is not held yet. */
  private removalsPending(): string[] {
    const out = new Set<string>();
    for (const id of this.#sync.pending) {
      const e = this.roster.entryById(Buffer.from(id, 'hex'));
      if (e?.kind === 'remove') out.add(toHex(Buffer.from((e.body as { target: Uint8Array }).target)));
    }
    return [...out];
  }

  status(): MeshStatus {
    const removed = this.roster.removedIds();
    return {
      deviceId: toHex(this.id.deviceId),
      inSet: this.inSet(),
      keystore: this.keys.kind,
      relay: this.#relay?.state ?? 'none',
      rosterCount: this.roster.size,
      rosterIds: this.roster.entries.map((e) => toHex(e.id).slice(0, 12)),
      activeDevices: this.roster.activeDevices().map((d) => toHex(d.deviceId)),
      removedDevices: [...removed],
      generations: [...this.#book.held.keys()].sort((a, b) => a - b),
      currentGeneration: this.#core?.currentLabel() ?? null,
      pendingDevices: this.roster.activeDevices().map((d) => toHex(d.deviceId)).filter((d) => !this.roster.confirmedIds().has(d)),
      parkedEntries: this.#core?.parked.size ?? 0,
      inbox: this.inbox.length,
      repairedTailBytes: this.roster.repairedTailBytes,
      parkedRoster: this.#link?.waitingCount ?? 0,
      rejections: this.#link?.rejections() ?? { counts: {}, recent: [] },
      waitingFrames: this.#link?.waitingCount ?? 0,
      removalsPending: this.removalsPending(),
      relayPending: this.#sync.pending.length,
      relayRefusals: Object.fromEntries(this.#refusals),
      flaggedDevices: [...this.roster.flagged],
      rosterRejected: Object.fromEntries(this.#rosterRejected),
      rosterHeadroom: this.roster.headroom,
      unconfirmedJoins: this.#sync.joins.map((j) => j.dev),
      rosterGaps: this.#rosterGaps,
      doorbells: this.#doorbells,
    };
  }
}
