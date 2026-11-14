// MeshService: starts the device layer (key store, roster log, relay client, link, pairing) and exposes the operations
// a screen or the test rig drives. Constructed ONLY by boot-hook.ts after config.ts said "on"; nothing here runs, creates
// a file or opens a socket otherwise.
//
// WHAT "IN A SET" MEANS: this device has keys, a set id, at least one set secret AND a non-empty roster log. Until then
// it only holds its identity (made on first enable) and waits for createSet() or a pairing.
//
// WHAT IS NOT HERE (later parts, listed so nobody assumes): the chat store and replicator (nothing replicates chats yet),
// the decide rules (who may add or remove whom: today ANY member may remove ANY other, the first device included, a deliberate
// reading of "all devices are equal" that the product owner still has to confirm; pinned by a test), the cut-off for what a removed
// device signed before it knew, real unlock prompts, and a durable outbox for frames. Frames carry only roster entries, removal
// bundles and (test mode) notes.
//
// A ROSTER CHANGE IS A TWO-STEP WITH A DEFINED OUTCOME AT EVERY FAILURE (review finding 1):
//  * REMOVAL: (1) the next generation's secret is saved in the sealed key file as `pending`, (2) the signed `remove` entry is written to the
//    log and queued for the relay (relay-sync.json), (3) the removal bundle (entry + sealed secrets) is sent under the old generation,
//    (4) the new secret is adopted, (5) the relay accepts the signed statement and cuts the device off. removeDevice() answers 'done' only
//    when 3 to 5 have happened; otherwise 'pending', and the rest is finished in the background and after a restart (resume on start).
//    `status().removalsPending` is the data the future screen reads for "removal pending".
//  * PAIRING (host): the relay is told first, the log written second, so a refusal leaves the host untouched. A pairing whose new device never
//    shows up on the relay within `pairConfirmMs` is rolled back by an ordinary removal, whatever went wrong in between (killed backend, lost
//    welcome, a joiner that gave up).
//  * RECEIVING a removal bundle: a new generation is accepted only as the consequence of a verified removal (see takeRemoval).
//
// PAIRING OVER THE RELAY. openPairingViaRelay() / joinWithCode() run the pairing exchange through the relay's meeting point
// (meeting-client.ts). The older openPairing() / joinStart() / hostPairingMessage() / joinMessage() surface stays as the DIRECT
// test carrier (unit tests and the rig's hostile-pipe case move the bytes themselves).
// ROSTER CHANGES AT THE RELAY are signed statements (putAtRelay), not plain add/remove messages.
import path from 'path';
import { toHex, utf8 } from './crypto/bytes';
import { meetingIdFor, signRosterStatement } from './crypto/relay-auth';
import { openSecret, sealSecretTo } from './crypto/keygen';
import { newSetSecret } from './crypto/keys';
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
import { MeshRosterRejected, RosterStore } from './roster-store';
import { ensureDir, readFileIfExists, writeFileDurable } from './fs-durable';
import { generateIdentity } from './crypto/identity';
import { GROUP_ROSTER, GROUP_TEST_NOTE, KIND_NOTE, KIND_REMOVAL, KIND_ROSTER, noteBody, parseNoteBody, parseRemovalBody, parseRosterBody, removalBody, rosterBody } from './wire';

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
  /** A pairing whose new device is not seen on the relay within this long is rolled back (default 15 minutes). */
  pairConfirmMs?: number;
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
const waitableRosterError = (e: MeshCryptoError): boolean => e.code === 'bad-roster' && /signer not yet|unknown or later|signer's previous entry/.test(e.message);

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
  readonly #joinTimers = new Map<string, NodeJS.Timeout>();
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
    for (const t of this.#joinTimers.values()) clearTimeout(t);
    this.#joinTimers.clear();
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
      this.#relay.on('ready', () => { this.#retryAttempt = 0; void this.drainRelay(); void this.confirmOnline(); });
      this.#relay.on('presence-change', (p: { device: string; state: string }) => { if (p.state === 'on') this.confirmJoin(p.device); });
    }
    const carrier = this.#relay ? relayCarrier(this.#relay) : null;
    if (!carrier) return; // no relay configured: identity and roster work, nothing connects
    this.#link = new Link({
      identity: this.id, setId, carrier, meshDir: this.dir,
      secrets: () => this.#k.secrets,
      signKeyFor: (d) => this.roster.signKeyFor(d),
      isRemoved: (d) => this.roster.isRemoved(d),
      now: this.o.now,
      // The receiver save number lives in the sealed key file (see link.ts for why and where it falls short).
      counter: { get: () => this.#k.receiverSaves, set: async (n) => { this.#k = await this.keys.update((k) => { k.receiverSaves = Math.max(k.receiverSaves, n); }); } },
      onFrame: (f) => this.onFrame(f),
      onEvent: (e, info) => { if (e === 'gap' && info.group === GROUP_ROSTER) this.#rosterGaps++; },
      log: this.o.log,
    });
    await this.#link.start(this.o.testMode ? [GROUP_ROSTER, GROUP_TEST_NOTE] : [GROUP_ROSTER]);
    if (!this.#offline) this.#relay?.start();
    // Whatever a previous run left half done is finished now (a killed backend between the steps of a removal or a pairing).
    void this.resume().catch(() => this.o.log('resume-failed'));
  }

  // ---------------------------------------------------------------- incoming frames
  private async onFrame(f: LinkFrame): Promise<void> {
    // A verified frame from a device proves it exists and holds the set secret: a pairing it came out of is complete.
    this.confirmJoin(toHex(f.header.from));
    if (f.header.kind === KIND_ROSTER && f.group === GROUP_ROSTER) {
      const r = await this.takeRosterEntries(parseRosterBody(f.body));
      if (r.waiting) throw new FrameWait('roster-entry'); // appended entries stay; the frame is judged again when more of the roster arrives
      return;
    }
    if (f.header.kind === KIND_REMOVAL && f.group === GROUP_ROSTER) return await this.takeRemoval(f);
    if (f.header.kind === KIND_NOTE && f.group === GROUP_TEST_NOTE && this.o.testMode) {
      this.inbox.push({ from: toHex(f.header.from), counter: f.header.counter, text: parseNoteBody(f.body) });
    }
    // Any other kind is ignored: this layer does not know it.
  }

  /** Append entries that came from the network. An entry that does not fit YET sets `waiting`; one from a flooding member is refused
   *  and counted (the member is flagged: nothing more from it is examined); one that can never fit is counted and dropped. */
  private async takeRosterEntries(entries: SignedEntry[]): Promise<{ appended: boolean; waiting: boolean }> {
    let appended = false;
    let waiting = false;
    for (const e of entries) {
      try {
        if ((await this.roster.append(e, { remote: true })) === 'appended') appended = true;
      } catch (err) {
        if (err instanceof MeshRosterRejected) {
          this.countRoster(`rejected-${err.why}`);
          this.o.log('roster-entry-rejected', { why: err.why, signer: err.signer.slice(0, 8) });
        } else if (err instanceof MeshCryptoError) {
          if (waitableRosterError(err)) waiting = true;
          else { this.countRoster(`invalid-${err.code}`); this.o.log('roster-entry-invalid', { code: err.code }); }
        } else throw err;
      }
    }
    if (appended) this.#link?.retryPending();
    return { appended, waiting };
  }
  private countRoster(k: string): void {
    this.#rosterRejected.set(k, (this.#rosterRejected.get(k) ?? 0) + 1);
  }

  /**
   * A removal bundle: the signed `remove` entry and the NEXT generation's secret sealed to each remaining device. WHY so many checks
   * (review finding 3): the old code stored whatever generation number and secret any member sent, so one member could overwrite
   * another device's secret and split the set. A secret is now taken only when ALL of these hold:
   *  - the sender is a current member (the link already verified its signature; removed devices are refused there);
   *  - the bundle carries a `remove` entry signed by that sender which is in our roster after we apply the bundle's entries;
   *  - the generation is exactly 1 + the number of removals up to and including that entry, so a removal can justify ONE generation and
   *    an old removal cannot be replayed to mint a new one;
   *  - the sealed secrets are addressed only to devices that are current members, and one is addressed to this device unless this device is
   *    the one being removed;
   *  - this device's own blob opens under ITS OWN agreement key (HPKE binds the sender and this device's id), so a device never accepts a
   *    "secret for device X" that X did not receive through its own key;
   *  - an existing generation is NEVER overwritten (a repeat of the same secret is fine: delivery can repeat).
   * Anything wrong is a FrameReject (counted, the sender's id prefix recorded, never blocks later frames).
   */
  private async takeRemoval(f: LinkFrame): Promise<void> {
    if (!this.#k.setId) return;
    const b = parseRemovalBody(f.body);
    const sender = f.header.from;
    if (!this.roster.signKeyFor(sender)) throw new FrameReject('sender-not-a-member');
    const r = await this.takeRosterEntries(b.entries);
    const justifying = b.entries.find((e) => e.kind === 'remove' && e.device.equals(sender) && this.roster.has(e.id));
    if (!justifying) {
      if (r.waiting) throw new FrameWait('roster-entry');
      throw new FrameReject('removal-without-entry');
    }
    const target = Buffer.from((justifying.body as { target: Uint8Array }).target);
    const expectedGen = 1 + this.roster.removalsUpTo(justifying.id);
    if (b.gen !== expectedGen) throw new FrameReject('generation-not-justified');
    const me = toHex(this.id.deviceId);
    for (const k of b.sealed.keys()) if (!this.roster.verified?.devices.has(k)) throw new FrameReject('sealed-to-unknown-device');
    if (target.equals(this.id.deviceId)) return; // I am the device being removed: there is no secret for me, and nothing to take
    const mine = b.sealed.get(me);
    if (!mine) throw new FrameReject('no-secret-for-me');
    const secret = openSecret(this.id.agreeSecret, mine, this.#k.setId, b.gen, f.header.from, this.id.deviceId);
    const have = this.#k.secrets.get(b.gen);
    if (have) {
      if (have.equals(secret)) return; // the same bundle again
      throw new FrameReject('generation-already-held');
    }
    this.#k = await this.keys.update((k) => { if (!k.secrets.has(b.gen)) k.secrets.set(b.gen, secret); });
    this.#link?.retryPending();
  }

  // ---------------------------------------------------------------- operations
  /** First device: make the set (genesis entry, generation-1 secret). The relay creates the room when this device first connects. */
  async createSet(): Promise<void> {
    if (this.inSet()) throw new Error('already in a set');
    const genesis = makeGenesisEntry(this.id, this.o.deviceName, this.o.platform, this.now());
    await this.roster.append(genesis);
    this.#k = await this.keys.update((k) => { k.setId = setIdFor(this.id.signKey); k.secrets = new Map([[1, newSetSecret()]]); });
    await this.activate();
  }

  private makeHost(): PairingHost {
    return new PairingHost({
      identity: this.id, setId: this.#k.setId as Buffer, secrets: () => this.#k.secrets, roster: this.roster, now: this.o.now,
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
        this.armJoinTimer(dev, this.now());
      },
      // WHY not awaited: the welcome must not wait for the other devices' copy of the roster; the frame is queued and retried by the link.
      afterAdded: (entry) => { void this.publishRoster([entry]).catch(() => undefined); },
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

  // ---------------------------------------------------------------- pairings that have to be confirmed or rolled back
  private armJoinTimer(dev: string, since: number): void {
    if (this.#joinTimers.has(dev) || this.#stopped) return;
    const wait = Math.max(0, since + (this.o.pairConfirmMs ?? 15 * 60_000) - this.now());
    const t = setTimeout(() => { void this.rollBackJoin(dev); }, wait);
    t.unref?.();
    this.#joinTimers.set(dev, t);
  }
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
    const t = this.#joinTimers.get(dev);
    if (t) clearTimeout(t);
    this.#joinTimers.delete(dev);
    void this.#sync.removeJoin(dev);
  }
  /** The new device never showed up: take it out again with an ordinary removal, so no phantom member stays in the set. */
  private async rollBackJoin(dev: string): Promise<void> {
    this.#joinTimers.delete(dev);
    if (!this.#sync.joins.some((j) => j.dev === dev) || this.#stopped) return;
    // One last look before undoing anything: is it connected right now?
    await this.confirmOnline();
    if (!this.#sync.joins.some((j) => j.dev === dev)) return;
    this.o.log('pairing-rolled-back');
    try {
      if (this.roster.activeDevices().some((d) => toHex(d.deviceId) === dev)) await this.removeDevice(dev);
      await this.#sync.removeJoin(dev);
    } catch {
      this.armJoinTimer(dev, this.now()); // could not do it now: try again after another wait
    }
  }

  /** After a start: finish what a previous run left half done (a pairing, a removal, the relay queue). */
  private async resume(): Promise<void> {
    // 1. pairings the relay accepted but whose add may not have reached the log (a kill between the two)
    for (const j of this.#sync.joins) {
      try {
        const entry = parseEntry(Buffer.from(j.entry, 'base64'));
        if (!this.roster.has(entry.id)) {
          await this.roster.append(entry);
          void this.publishRoster([entry]).catch(() => undefined);
        }
        this.armJoinTimer(j.dev, j.at);
      } catch { await this.#sync.removeJoin(j.dev); }
    }
    // 2. a removal that was started (its secret was saved) but not finished
    await this.resumeRemoval();
    // 3. the relay queue
    void this.drainRelay();
  }
  private async resumeRemoval(): Promise<void> {
    const p = this.#k.pending;
    if (!p) return;
    const entry = this.roster.entryById(p.entry);
    if (!entry) {
      // The kill came before the entry reached the log: the removal never happened. The unused secret is simply dropped.
      this.#k = await this.keys.update((k) => { k.pending = null; });
      return;
    }
    await this.finishRemoval(entry, p.gen, p.secret);
  }
  /** Steps 3 and 4 of a removal: send the bundle under the current generation, then adopt the new one. Safe to run again. */
  private async finishRemoval(entry: SignedEntry, gen: number, secret: Buffer): Promise<void> {
    if (!this.#link || !this.#k.setId) return;
    const setId = this.#k.setId;
    const target = toHex(Buffer.from((entry.body as { target: Uint8Array }).target));
    const removed = this.roster.removedIds();
    // Sealed to every device that is still a member now and is not me; the removed one never gets a secret.
    const remaining = this.roster.activeDevices().filter((d) => !removed.has(toHex(d.deviceId)) && toHex(d.deviceId) !== target && !d.deviceId.equals(this.id.deviceId));
    const sealed = new Map<string, Buffer>();
    for (const d of remaining) sealed.set(toHex(d.deviceId), sealSecretTo(d.agreeKey, setId, gen, secret, this.id.deviceId, d.deviceId));
    // Sent under the CURRENT (old) generation, which every remaining device holds. Resolves when the relay stored it.
    await this.#link.sendDurable({ group: GROUP_ROSTER, kind: KIND_REMOVAL, body: removalBody({ entries: [entry], gen, sealed }) });
    this.#k = await this.keys.update((k) => { k.secrets.set(gen, secret); k.pending = null; });
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
      try { for (const out of host.onMessage(`g${m.gen}`, m.bytes)) client.send(out); } catch { /* meeting closed under us */ }
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
      try { for (const m of out) hm.client.send(m); } catch { /* the guest is gone */ }
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
    await this.#link.sendDurable({ group: GROUP_ROSTER, kind: KIND_ROSTER, body: rosterBody(entries) });
  }

  /** Test mode only: send a note to every device in the set. */
  async sendNote(text: string, to?: string): Promise<{ counter: number }> {
    if (!this.o.testMode) throw new Error('notes exist only in test mode');
    if (this.#removed) throw new Error('removed from the set');
    if (!this.#link) throw new Error('not connected to a set');
    // line: true marks a chat line for the relay (30-day keep, may be released under pressure); roster frames are control data and are not marked.
    return this.#link.sendDurable({ group: GROUP_TEST_NOTE, kind: KIND_NOTE, body: noteBody(text), to: to ? Buffer.from(to, 'hex') : undefined, line: true });
  }

  /** Run roster operations one at a time (two removals at once would race on the generation number and on the log heads). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#opChain.then(fn, fn);
    this.#opChain = p.catch(() => undefined);
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
    if (!this.#link || !this.#k.setId) throw new Error('not in a set');
    if (!/^[0-9a-f]{32}$/.test(targetHex)) throw new Error('bad device id');
    const target = Buffer.from(targetHex, 'hex');
    if (!this.roster.activeDevices().some((d) => d.deviceId.equals(target))) throw new Error('not an active device');
    if (this.#k.pending) await this.resumeRemoval(); // finish an earlier removal first: one generation at a time
    const entry = makeRemoveEntry(this.id, target, seenForNextEntry(this.roster.entries, this.id.deviceId), this.now());
    // The generation this removal justifies: 1 + the removals in its causal past, itself included (receivers compute the same with
    // removalsUpTo). The new entry cites every current head, so its past is the whole log: every removal so far, plus itself.
    const gen = 2 + this.roster.removalCount();
    const secret = newSetSecret();
    // Step 1: the new secret is saved first, sealed, so a kill at any later step can be finished instead of forgotten.
    this.#k = await this.keys.update((k) => { k.pending = { gen, secret, entry: entry.id }; });
    // Step 2: queue for the relay BEFORE the log write (a kill between the two leaves an id with no entry, which the queue drops), then write.
    const id = toHex(entry.id);
    await this.#sync.enqueue(id);
    await this.roster.append(entry);
    this.#settled.delete(id);
    void this.drainRelay();
    // Steps 3 and 4 run in the background so an unreachable relay cannot hang the caller.
    const bundle = this.finishRemoval(entry, gen, secret).then(() => 'ok' as const, () => 'failed' as const);
    const wait = this.o.removeWaitMs ?? 10_000;
    const [relay, sent] = await Promise.all([this.waitForRelay(id, wait), Promise.race([bundle, new Promise<'timeout'>((r) => { const t = setTimeout(() => r('timeout'), wait); t.unref?.(); })])]);
    return relay === 'ok' && sent === 'ok' ? 'done' : 'pending';
  }

  /** Change this device's own name (a signed `rename` entry; the relay is told it happened but never the name). */
  renameSelf(name: string): Promise<void> {
    return this.serial(async () => {
      if (!this.inSet()) throw new Error('not in a set');
      const entry = makeRenameEntry(this.id, name, seenForNextEntry(this.roster.entries, this.id.deviceId), this.now());
      await this.#sync.enqueue(toHex(entry.id));
      await this.roster.append(entry);
      void this.drainRelay();
      void this.publishRoster([entry]).catch(() => undefined);
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

  /** Targets of removals recorded here that the relay has not accepted yet, or whose bundle is not out yet. */
  private removalsPending(): string[] {
    const out = new Set<string>();
    for (const id of this.#sync.pending) {
      const e = this.roster.entryById(Buffer.from(id, 'hex'));
      if (e?.kind === 'remove') out.add(toHex(Buffer.from((e.body as { target: Uint8Array }).target)));
    }
    const p = this.#k.pending && this.roster.entryById(this.#k.pending.entry);
    if (p) out.add(toHex(Buffer.from((p.body as { target: Uint8Array }).target)));
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
      generations: [...this.#k.secrets.keys()].sort((a, b) => a - b),
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
