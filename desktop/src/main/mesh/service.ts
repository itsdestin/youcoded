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
import { makeGenesisEntry, makeRemoveEntry, makeRenameEntry, seenForNextEntry, type SignedEntry } from './crypto/roster';
import { MeshCryptoError } from './crypto/errors';
import type { OpenedFrame } from './crypto/frames';
import { relayCarrier } from './carrier-relay';
import { Link } from './link';
import { MeshKeyStore, type MeshKeys, type SecretSealer } from './keystore';
import { MeetingClient } from './meeting-client';
import { generateCode } from './crypto/pairing';
import { adoptPairing, MEETING_PART_LENGTH, newTypedCode, PairingHost, PairingJoiner, parseTypedCode } from './pair-flow';
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
  /** How many doorbells the relay has rung on this device (each makes the link fetch). The rig asserts catch-up is bell-driven. */
  doorbells: number;
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
  /** The meeting this device opened as host, and the guest connection (relay `gen`) the host is currently talking to. */
  #hostMeeting: { client: MeetingClient; gen: number; timer: NodeJS.Timeout } | null = null;
  #joinMeeting: MeetingClient | null = null;
  #joinState: { stage: string; sas?: string; done: boolean; failed?: string } = { stage: 'none', done: false };
  #parked: SignedEntry[] = [];
  readonly inbox: InboxItem[] = [];
  #offline = false;
  #doorbells = 0;
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

  private makeHost(): PairingHost {
    return new PairingHost({
      identity: this.id, setId: this.#k.setId as Buffer, secrets: () => this.#k.secrets, roster: this.roster, now: this.o.now,
      // The relay must know the newcomer's public key before the newcomer can sign in: a statement signed by THIS device.
      admitAtRelay: async (_signKeyHex, entry) => {
        if (!this.#relay) return;
        const r = await this.putAtRelay(entry);
        if (r !== 'ok') throw new Error('relay refused the new device');
      },
      afterAdded: async (entry) => { await this.publishRoster([entry]); },
    });
  }

  /** Tell the relay about a roster entry THIS device just signed (an `add` or a `remove`). Returns 'ok' or the relay's reason.
   *  WHY a statement (finding 8): the relay verifies a signature by a current member and the entry's stated ancestry. It sees
   *  the new device's public key and the entry's id, never its name. */
  private async putAtRelay(entry: SignedEntry): Promise<string> {
    if (!this.#relay || !this.#k.setId) return 'ok';
    const body = entry.body as { signKey?: Uint8Array; target?: Uint8Array };
    const kind = entry.kind === 'add' ? 'add' : entry.kind === 'remove' ? 'remove' : null;
    if (!kind) return 'ok'; // renames are not put at the relay (it never needs them)
    const target = kind === 'add' ? deviceIdFor(body.signKey as Uint8Array) : Buffer.from(body.target as Uint8Array);
    const targetKey = kind === 'add' ? Buffer.from(body.signKey as Uint8Array) : null;
    const { sig } = signRosterStatement(this.id, { kind, room: this.#k.setId, target, targetKey, entry: entry.id, seen: entry.seen, at: entry.at });
    const r = await this.#relay.rosterPut({
      kind, signer: toHex(this.id.deviceId), target: toHex(target), ...(targetKey ? { targetKey: toHex(targetKey) } : {}),
      entry: toHex(entry.id), seen: entry.seen.map((x) => toHex(x)), at: entry.at, sig: sig.toString('hex'),
    });
    return r === 'duplicate' ? 'ok' : r; // the relay already holds this exact entry
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
    const r = await this.putAtRelay(entry);
    if (r !== 'ok') this.o.log('relay-remove-refused', { reason: r });
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
      doorbells: this.#doorbells,
    };
  }
}
