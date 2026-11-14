// MeshService: starts the device layer (key store, roster log, relay client, link, pairing) and exposes the operations
// a screen or the test rig drives. Constructed ONLY by boot-hook.ts after config.ts said "on"; nothing here runs, creates
// a file or opens a socket otherwise.
//
// WHAT "IN A SET" MEANS: this device has keys, a set id, at least one set secret AND a non-empty roster log. Until then
// it only holds its identity (made on first enable) and waits for createSet() or a pairing.
//
// WHAT IS NOT HERE (later parts, listed so nobody assumes): the chat store and replicator (nothing replicates chats yet),
// the decide rules (who may add or remove whom: today any member's roster entries that VERIFY are accepted), the cut-off
// for what a removed device signed before it knew, the pairing meeting point on the relay, real unlock prompts, and a
// durable outbox. Frames carry only roster entries, removal bundles and (test mode) notes.
import path from 'path';
import { toHex } from './crypto/bytes';
import { openSecret, sealSecretTo } from './crypto/keygen';
import { newSetSecret } from './crypto/keys';
import { setIdFor, type DeviceIdentity } from './crypto/identity';
import { makeGenesisEntry, makeRemoveEntry, makeRenameEntry, seenForNextEntry, type SignedEntry } from './crypto/roster';
import { MeshCryptoError } from './crypto/errors';
import type { OpenedFrame } from './crypto/frames';
import { relayCarrier } from './carrier-relay';
import { Link } from './link';
import { MeshKeyStore, type MeshKeys, type SecretSealer } from './keystore';
import { adoptPairing, PairingHost, PairingJoiner } from './pair-flow';
import { RelayClient } from './relay-client';
import { RosterStore } from './roster-store';
import { ensureDir } from './fs-durable';
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
}

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
}

const MAX_PARKED = 64;

export class MeshService {
  readonly dir: string;
  readonly keys: MeshKeyStore;
  readonly roster: RosterStore;
  #k!: MeshKeys;
  #relay: RelayClient | null = null;
  #link: Link | null = null;
  #host: PairingHost | null = null;
  #joiner: { j: PairingJoiner; identity: DeviceIdentity } | null = null;
  #parked: SignedEntry[] = [];
  readonly inbox: InboxItem[] = [];
  #offline = false;
  #removed = false;
  #stopped = false;
  constructor(readonly o: MeshServiceOptions) {
    this.dir = path.join(o.userData, 'mesh');
    this.keys = new MeshKeyStore(this.dir, o.sealer);
    this.roster = new RosterStore(this.dir);
  }

  /** Create the folder, load (or, on first enable, create) the identity, load the roster, and go live if already in a set. */
  async start(): Promise<void> {
    await ensureDir(this.dir);
    this.#k = await this.keys.loadOrCreate();
    await this.roster.load();
    if (this.inSet()) await this.activate();
    this.o.log('started', { inSet: this.inSet(), keystore: this.keys.kind });
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#link?.stop();
    this.#relay?.stop();
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
      this.#relay.on('version-refused', () => this.o.log('relay-version-refused'));
    }
    const carrier = this.#relay ? relayCarrier(this.#relay) : null;
    if (!carrier) return; // no relay configured: identity and roster work, nothing connects
    this.#link = new Link({
      identity: this.id, setId, carrier, meshDir: this.dir,
      secrets: () => this.#k.secrets,
      signKeyFor: (d) => this.roster.signKeyFor(d),
      // The receiver save number lives in the sealed key file (see link.ts for why and where it falls short).
      counter: { get: () => this.#k.receiverSaves, set: async (n) => { this.#k = await this.keys.update((k) => { k.receiverSaves = Math.max(k.receiverSaves, n); }); } },
      onFrame: (f) => this.onFrame(f),
      log: this.o.log,
    });
    await this.#link.start(this.o.testMode ? [GROUP_ROSTER, GROUP_TEST_NOTE] : [GROUP_ROSTER]);
    if (!this.#offline) this.#relay?.start();
  }

  // ---------------------------------------------------------------- incoming frames
  private async onFrame(f: OpenedFrame & { group: string; seq: number }): Promise<void> {
    if (f.header.kind === KIND_ROSTER && f.group === GROUP_ROSTER) {
      for (const e of parseRosterBody(f.body)) await this.takeRosterEntry(e);
      return;
    }
    if (f.header.kind === KIND_REMOVAL && f.group === GROUP_ROSTER) {
      const b = parseRemovalBody(f.body);
      for (const e of b.entries) await this.takeRosterEntry(e);
      const mine = b.sealed.get(toHex(this.id.deviceId));
      if (mine && this.#k.setId) {
        // The next generation's secret, sealed to this device by the sender (HPKE binds sender and recipient ids).
        const secret = openSecret(this.id.agreeSecret, mine, this.#k.setId, b.gen, f.header.from, this.id.deviceId);
        this.#k = await this.keys.update((k) => { k.secrets.set(b.gen, secret); });
        this.#link?.retryPending();
      }
      return;
    }
    if (f.header.kind === KIND_NOTE && f.group === GROUP_TEST_NOTE && this.o.testMode) {
      this.inbox.push({ from: toHex(f.header.from), counter: f.header.counter, text: parseNoteBody(f.body) });
    }
    // Any other kind is ignored: this layer does not know it.
  }

  /** Append a roster entry; one that does not fit YET (its signer or predecessor has not arrived) is parked and retried. */
  private async takeRosterEntry(e: SignedEntry): Promise<void> {
    try {
      const r = await this.roster.append(e);
      if (r === 'appended') await this.retryParked();
    } catch (err) {
      if (!(err instanceof MeshCryptoError)) throw err;
      if (this.#parked.length < MAX_PARKED && !this.#parked.some((p) => p.id.equals(e.id))) this.#parked.push(e);
      this.o.log('roster-entry-parked', { code: err.code });
    }
    this.#link?.retryPending();
  }
  private async retryParked(): Promise<void> {
    let progress = true;
    while (progress && this.#parked.length) {
      progress = false;
      for (const p of [...this.#parked]) {
        try {
          await this.roster.append(p);
          this.#parked = this.#parked.filter((x) => x !== p);
          progress = true;
        } catch { /* still does not fit */ }
      }
    }
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

  /** Host: start a typed-code invite. The code is returned to be SHOWN; it is not logged. */
  openPairing(room?: Buffer): { room: string; code: string } {
    if (!this.inSet()) throw new Error('not in a set');
    this.#host = new PairingHost({
      identity: this.id, setId: this.#k.setId as Buffer, secrets: () => this.#k.secrets, roster: this.roster, now: this.o.now,
      // The relay must know the newcomer's public key before the newcomer can sign in.
      admitAtRelay: async (signKeyHex) => {
        if (!this.#relay) return;
        const r = await this.#relay.rosterAdd(signKeyHex);
        if (r !== 'ok') throw new Error('relay refused the new device');
      },
      afterAdded: async (entry) => { await this.publishRoster([entry]); },
    });
    const o = this.#host.open(room);
    return { room: o.room.toString('hex'), code: o.code };
  }
  pairingPrompt(): { conn: string; name: string; platform: string; fingerprint: string; sas: string } | null {
    const p = this.#host?.prompt;
    return p ? { conn: p.conn, ...p.info } : null;
  }
  hostPairingMessage(conn: string, bytes: Buffer): Buffer[] {
    return this.#host ? this.#host.onMessage(conn, bytes) : [];
  }
  hostPairingDecide(conn: string, approved: boolean): Promise<Buffer[]> {
    return this.#host ? this.#host.decide(conn, approved) : Promise.resolve([]);
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

  private async publishRoster(entries: SignedEntry[]): Promise<void> {
    if (!this.#link) return;
    await this.#link.sendDurable({ group: GROUP_ROSTER, kind: KIND_ROSTER, body: rosterBody(entries) });
  }

  /** Test mode only: send a note to every device in the set. */
  async sendNote(text: string, to?: string): Promise<{ counter: number }> {
    if (!this.o.testMode) throw new Error('notes exist only in test mode');
    if (this.#removed) throw new Error('removed from the set');
    if (!this.#link) throw new Error('not connected to a set');
    return this.#link.sendDurable({ group: GROUP_TEST_NOTE, kind: KIND_NOTE, body: noteBody(text), to: to ? Buffer.from(to, 'hex') : undefined });
  }

  /**
   * Remove a device: the signed `remove` entry and the NEXT generation's secret (sealed separately to each remaining
   * device) travel as ONE frame under the old generation; only then does this device switch to the new generation and
   * ask the relay to drop the removed device (which closes its connection at once).
   */
  async removeDevice(targetHex: string): Promise<void> {
    if (!this.#link || !this.#k.setId) throw new Error('not in a set');
    const target = Buffer.from(targetHex, 'hex');
    const remaining = this.roster.activeDevices().filter((d) => !d.deviceId.equals(target) && !d.deviceId.equals(this.id.deviceId));
    const gen = Math.max(...this.#k.secrets.keys()) + 1;
    const secret = newSetSecret();
    const sealed = new Map<string, Buffer>();
    for (const d of remaining) sealed.set(toHex(d.deviceId), sealSecretTo(d.agreeKey, this.#k.setId, gen, secret, this.id.deviceId, d.deviceId));
    const entry = makeRemoveEntry(this.id, target, seenForNextEntry(this.roster.entries, this.id.deviceId), this.now());
    await this.roster.append(entry);
    // Sent under the CURRENT (old) generation, which every remaining device holds.
    await this.#link.sendDurable({ group: GROUP_ROSTER, kind: KIND_REMOVAL, body: removalBody({ entries: [entry], gen, sealed }) });
    this.#k = await this.keys.update((k) => { k.secrets.set(gen, secret); });
    const r = await this.#relay?.rosterRemove(targetHex);
    if (r && r !== 'ok') this.o.log('relay-remove-refused', { reason: r });
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
      await this.roster.append(makeRenameEntry(this.id, `${this.o.deviceName}-${i}`, seenForNextEntry(this.roster.entries, this.id.deviceId), this.now()));
      done++;
    }
    return done;
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
      parkedRoster: this.#parked.length,
    };
  }
}
