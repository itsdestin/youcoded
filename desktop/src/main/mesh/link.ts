// Link layer (design 5.2, seam S3): "send a sealed frame to the device set / receive verified frames", over a
// Carrier. The relay client is the first carrier (carrier-relay.ts); carrier-memory.ts is the test one.
//
// SENDING (durable lane). sendDurable() seals one frame and hands it to the carrier; its promise resolves only when
// the carrier says it STORED the frame. Frames are kept in order and retried until acknowledged. A frame is sealed
// at the moment it is first tried and the SAME bytes are retried afterwards: the relay numbers frames per sender
// session and refuses a number it has seen, so re-sealing a retry would burn counters out of order. A retry the relay
// calls "duplicate" counts as acknowledged (it already holds those exact bytes).
//   Not durable across a crash: the outbox is in memory. The replicator (a later part) keeps its own durable queue.
//
// RECEIVING. A carrier "ring" (live doorbell) or a (re)connect makes the link fetch each followed group after its
// cursor. Every frame goes through FrameReceiver.open, which authenticates, decrypts and verifies the signature.
// Outcomes: delivered once; repeats ignored; a frame that cannot be checked YET (unknown signer or generation: the
// roster or secret has not arrived) pauses that group until retryPending() is called, never skipped; anything else
// that fails is dropped with only its error code logged. Frames this device sent are skipped.
//
// RECEIVER STATE AND THE SAVE COUNTER (frames.ts contract). After a batch, the link writes the receiver's replay
// state (exportState) and the group cursors to link-state.bin (durable), THEN records the state's save number in the
// sealed key file (keys.bin), THEN tells the carrier "received". Why two files: if ONLY link-state.bin is restored
// from an older backup, its save number is lower than the one in keys.bin and importState refuses it (stale-state),
// and the link says so ('rolled-back') and re-reads from the start; handlers must be idempotent. The counter is NOT
// protected when BOTH files roll back together (a whole-profile restore): nothing inside the profile can detect that;
// only a store outside the profile can (OS keychain entry, Android Keystore-side preference). That is the seam
// `CounterStore` below; today it is implemented by keys.bin.
//
// LOGGING: event names, group names, close codes, counts. Never frame bytes, keys or bodies.
import path from 'path';
import { asBytes, asMap, asUint, decode, encode, onlyKeys, type CborValue } from './crypto/cbor';
import { MeshCryptoError } from './crypto/errors';
import { FrameReceiver, FrameSender, peekHeader, type OpenedFrame } from './crypto/frames';
import type { DeviceIdentity } from './crypto/identity';
import { readFileIfExists, writeFileDurable } from './fs-durable';

/** What the link needs from a path to the other devices. */
export interface Carrier {
  readonly connected: boolean;
  /** Store a sealed frame durably. `n` is the sender's strictly rising number (counter + 1). */
  hold(group: string, session: string, n: number, frame: Uint8Array): Promise<'stored' | 'duplicate'>;
  fetchAfter(group: string, seq: number): Promise<{ frames: Array<{ seq: number; bytes: Buffer }>; more: boolean; gap?: { through: number } }>;
  /** "I have handled everything in `group` through `seq`." Best effort. */
  received(group: string, seq: number): Promise<void>;
  /** Live doorbell to the other devices: "there is something new in `group`". Never stored. */
  ring(group: string): void;
  onRing(cb: (group: string) => void): void;
  onConnected(cb: () => void): void;
}

/** Where the receiver save number lives (see the header). keys.bin implements it today. */
export interface CounterStore {
  get(): number;
  set(n: number): Promise<void>;
}

export interface LinkOptions {
  identity: DeviceIdentity;
  setId: Buffer;
  carrier: Carrier;
  /** Directory for link-state.bin (the mesh folder). */
  meshDir: string;
  secrets: () => Map<number, Buffer>;
  signKeyFor: (deviceId: Buffer) => Buffer | undefined;
  counter: CounterStore;
  onFrame: (f: OpenedFrame & { group: string; seq: number }) => void | Promise<void>;
  log?: (event: string, fields?: Record<string, string | number>) => void;
  onEvent?: (event: 'rolled-back' | 'gap', info: { group: string }) => void;
}

interface Outgoing { group: string; kind: string; body: CborValue; to?: Buffer; resolve: (r: { counter: number }) => void; reject: (e: Error) => void; sealed?: { wire: Buffer; counter: number } }

const PAUSING = new Set(['unknown-signer', 'unknown-generation']);
const STATE_VERSION = 1;

export class Link {
  readonly #o: LinkOptions;
  readonly #sender: FrameSender;
  readonly #receiver: FrameReceiver;
  readonly #cursors = new Map<string, number>();
  readonly #paused = new Set<string>();
  readonly #syncing = new Map<string, Promise<void>>();
  readonly #again = new Set<string>();
  /** Frames that opened fine but whose handler failed. WHY kept: open() records the counter at once, so reopening the same
   *  wire bytes would be refused as a replay and the frame would be lost; the retry uses this copy instead. */
  readonly #failedOpen = new Map<string, OpenedFrame>();
  #outbox: Outgoing[] = [];
  #flushing = false;
  #stopped = false;
  constructor(o: LinkOptions) {
    this.#o = o;
    // A fresh random session on EVERY process start, never saved (frames.ts nonce contract).
    this.#sender = new FrameSender({ identity: o.identity, setId: o.setId, padding: 'buckets' });
    this.#receiver = new FrameReceiver({
      setId: o.setId,
      selfDeviceId: o.identity.deviceId,
      secretFor: (g) => this.#o.secrets().get(g),
      signKeyFor: (id) => this.#o.signKeyFor(id),
    });
  }
  private log(event: string, f?: Record<string, string | number>): void {
    this.#o.log?.(event, f);
  }
  get sessionHex(): string {
    return this.#sender.session.toString('hex');
  }

  /** Load saved receiver state and cursors, then start listening. Call once. */
  async start(groups: string[]): Promise<void> {
    await this.loadState();
    for (const g of groups) if (!this.#cursors.has(g)) this.#cursors.set(g, 0);
    this.#o.carrier.onRing((g) => { if (this.#cursors.has(g)) void this.sync(g); });
    this.#o.carrier.onConnected(() => { void this.flush(); void this.syncAll(); });
    if (this.#o.carrier.connected) { void this.flush(); void this.syncAll(); }
  }
  stop(): void {
    this.#stopped = true;
    for (const o of this.#outbox) o.reject(new Error('stopped'));
    this.#outbox = [];
  }
  follow(group: string): void {
    if (!this.#cursors.has(group)) this.#cursors.set(group, 0);
  }

  // ---------------------------------------------------------------- sending
  sendDurable(a: { group: string; kind: string; body: CborValue; to?: Buffer }): Promise<{ counter: number }> {
    return new Promise((resolve, reject) => {
      this.#outbox.push({ ...a, resolve, reject });
      void this.flush();
    });
  }
  private currentGen(): number {
    let g = -1;
    for (const k of this.#o.secrets().keys()) g = Math.max(g, k);
    if (g < 0) throw new MeshCryptoError('unknown-generation', 'no set secret');
    return g;
  }
  /** Send the outbox in order. Stops at the first frame the carrier cannot take right now and resumes on reconnect. */
  private async flush(): Promise<void> {
    if (this.#flushing || this.#stopped) return;
    this.#flushing = true;
    try {
      while (this.#outbox.length && this.#o.carrier.connected && !this.#stopped) {
        const head = this.#outbox[0];
        try {
          if (!head.sealed) {
            const gen = this.currentGen();
            const secret = this.#o.secrets().get(gen) as Buffer;
            const wire = this.#sender.seal({ secret, gen, group: head.group, kind: head.kind, body: head.body, to: head.to ?? null });
            head.sealed = { wire, counter: this.#sender.framesSealed - 1 };
          }
          const r = await this.#o.carrier.hold(head.group, this.sessionHex, head.sealed.counter + 1, head.sealed.wire);
          if (r === 'stored') this.#o.carrier.ring(head.group);
          this.#outbox.shift();
          head.resolve({ counter: head.sealed.counter });
        } catch (e) {
          if (e instanceof MeshCryptoError) { this.#outbox.shift(); head.reject(e); continue; } // cannot seal: not retryable
          this.log('send-retry'); // carrier trouble (offline, timeout): keep the same sealed bytes and try again
          // A reconnect also triggers a flush; the timer covers a hiccup on a connection that stays up.
          const t = setTimeout(() => { void this.flush(); }, 2000);
          t.unref?.();
          return;
        }
      }
    } finally {
      this.#flushing = false;
    }
  }

  // ---------------------------------------------------------------- receiving
  async syncAll(): Promise<void> {
    await Promise.all([...this.#cursors.keys()].map((g) => this.sync(g)));
  }
  /** Call after the roster or a set secret changed: groups paused on "unknown signer/generation" try again. */
  retryPending(): void {
    for (const g of [...this.#paused]) { this.#paused.delete(g); void this.sync(g); }
  }
  /** Resolves when this group is caught up (or paused/offline). Overlapping calls are coalesced and re-run once. */
  sync(group: string): Promise<void> {
    const running = this.#syncing.get(group);
    if (running) { this.#again.add(group); return running; }
    const p = (async () => {
      do {
        this.#again.delete(group);
        try { await this.syncOnce(group); } catch { this.log('sync-error', { group }); }
      } while (this.#again.has(group) && !this.#stopped);
    })().finally(() => this.#syncing.delete(group));
    this.#syncing.set(group, p);
    return p;
  }
  private async syncOnce(group: string): Promise<void> {
    if (!this.#o.carrier.connected || this.#stopped) return;
    for (;;) {
      const cursor = this.#cursors.get(group) ?? 0;
      const res = await this.#o.carrier.fetchAfter(group, cursor);
      if (res.gap) {
        // The relay released frames this device had not collected (it was away more than the relay's keep time).
        // Skip to the gap's end; the replicator (later) repairs content from other devices.
        this.#cursors.set(group, Math.max(cursor, res.gap.through));
        this.log('gap', { group, through: res.gap.through });
        this.#o.onEvent?.('gap', { group });
        continue;
      }
      let last = cursor;
      let blocked = false;
      for (const f of res.frames) {
        const verdict = await this.handle(group, f.seq, f.bytes);
        if (verdict === 'pause') { blocked = true; this.#paused.add(group); break; }
        last = f.seq;
      }
      if (last !== cursor) {
        this.#cursors.set(group, last);
        // While a frame is waiting on its handler, the receiver's table already counts it as seen: saving now could make a
        // crash lose it. Skip the save AND the acknowledgement; the next clean batch writes both.
        if (this.#failedOpen.size === 0) {
          await this.persist(); // durable BEFORE the acknowledgement below
          await this.#o.carrier.received(group, last).catch(() => undefined);
        }
      }
      if (blocked || !res.more || res.frames.length === 0) return;
    }
  }
  private async handle(group: string, seq: number, wire: Buffer): Promise<'done' | 'pause'> {
    try {
      if (peekHeader(wire).from.equals(this.#o.identity.deviceId)) return 'done'; // my own frame coming back
      const key = `${group}:${seq}`;
      const opened = this.#failedOpen.get(key) ?? this.#receiver.open(wire);
      try {
        await this.#o.onFrame({ ...opened, group, seq });
      } catch {
        this.log('handler-failed', { group });
        this.#failedOpen.set(key, opened);
        return 'pause'; // not processed: do not advance past it
      }
      this.#failedOpen.delete(key);
      return 'done';
    } catch (e) {
      const code = e instanceof MeshCryptoError ? e.code : 'error';
      if (PAUSING.has(code)) { this.log('frame-waiting', { group, code }); return 'pause'; }
      if (code !== 'replay' && code !== 'out-of-window') this.log('frame-dropped', { group, code });
      return 'done';
    }
  }

  // ---------------------------------------------------------------- state
  private get stateFile(): string {
    return path.join(this.#o.meshDir, 'link-state.bin');
  }
  async persist(): Promise<void> {
    const bytes = this.#receiver.exportState();
    const cursors: { [g: string]: CborValue } = {};
    for (const [g, c] of this.#cursors) cursors[g] = c;
    await writeFileDurable(this.stateFile, encode({ v: STATE_VERSION, receiver: bytes, cursors }));
    await this.#o.counter.set(this.#receiver.saveCounter); // second file, second place: see the header
  }
  private async loadState(): Promise<void> {
    const raw = await readFileIfExists(this.stateFile);
    if (!raw) return;
    let receiverBytes: Buffer;
    try {
      const m = asMap(decode(raw), 'link state');
      onlyKeys(m, ['v', 'receiver', 'cursors'], 'link state');
      if (asUint(m.v, 'v') !== STATE_VERSION) return;
      receiverBytes = asBytes(m.receiver, 'receiver');
      for (const [g, c] of Object.entries(asMap(m.cursors, 'cursors'))) this.#cursors.set(g, asUint(c, 'cursor'));
    } catch {
      this.log('state-unreadable'); // a damaged file means "re-read everything"; replay refusal still protects what is known
      this.#cursors.clear();
      return;
    }
    const min = this.#o.counter.get();
    try {
      this.#receiver.importState(receiverBytes, { minSaveCounter: min });
    } catch (e) {
      if (!(e instanceof MeshCryptoError) || e.code !== 'stale-state') { this.log('state-unreadable'); this.#cursors.clear(); return; }
      // An OLDER state file than the one this device last wrote: restored from a backup, or rolled back. Frames applied
      // since it was saved would be accepted again. Keep what it knows, raise our counter past the recorded one, read
      // every group from the start, and tell the caller (handlers must be idempotent).
      this.#receiver.importState(receiverBytes);
      while (this.#receiver.saveCounter <= min) this.#receiver.exportState();
      for (const g of this.#cursors.keys()) this.#cursors.set(g, 0);
      this.log('rolled-back');
      this.#o.onEvent?.('rolled-back', { group: '' });
    }
  }
}
