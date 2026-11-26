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
// ONE FRAME CAN NEVER FREEZE A GROUP (review finding 2). Every frame ends in exactly one of: applied; skipped as a repeat; REJECTED
// (counted by reason with only the sender's 8-character id prefix, never content: `rejections()`); or WAITING. A waiting frame is
// one that cannot be judged yet (unknown signer or generation, or a handler that says "not yet": FrameWait). Waiting frames are
// kept, bounded PER SENDER (one sender can only ever push out its own, N4) and expiring, in link-state.bin, and the read position moves past them, so a frame that never becomes
// judgeable costs one slot for a day and blocks nothing. A handler that throws something else (a disk error) is retried a few
// times and then the frame is rejected.
//
// THE READ POSITION IS NOT THE RELAY'S TO SET (review finding 7). The relay supplies sequence numbers and the `gap` marker, and a
// hostile one can lie. The COMMITTED position (saved, acknowledged to the relay) only moves past a frame this device actually
// verified or parked; a rejected or repeated frame moves a session-only soft position, so junk can be skipped without being able to
// poison the saved number. A frame further than MAX_POSITION_JUMP ahead is still read (an honest relay can have released a long run, N9) but neither it nor a gap that far can move the SAVED position, and junk that far ahead cannot move even the session position. Reconnecting forgets
// the soft position. resetReadPosition() is the operator's way back to the start (replay protection keeps duplicates out).
//
// LOGGING: event names, group names, close codes, counts. Never frame bytes, keys or bodies.
import path from 'path';
import { asArray, asBytes, asMap, asText, asUint, decode, encode, onlyKeys, type CborValue } from './crypto/cbor';
import { MeshCryptoError } from './crypto/errors';
import { FrameReceiver, FrameSender, peekHeader, type OpenedFrame } from './crypto/frames';
import type { DeviceIdentity } from './crypto/identity';
import { readFileIfExists, writeFileDurable } from './fs-durable';
import { reportFailure } from '../report-failure';

/** What the link needs from a path to the other devices. */
export interface Carrier {
  readonly connected: boolean;
  /** Store a sealed frame durably. `n` is the sender's strictly rising number (counter + 1). */
  /** `line` marks a chat line (the relay keeps those 30 days and may release them under pressure); omitted means control data
   *  (roster, removal bundles), which the relay holds until every device acknowledged it (review finding 5). */
  hold(group: string, session: string, n: number, frame: Uint8Array, line?: boolean): Promise<'stored' | 'duplicate'>;
  fetchAfter(group: string, seq: number): Promise<{ frames: Array<{ seq: number; bytes: Buffer; writer?: string | null }>; more: boolean; gap?: { through: number } }>;
  /** "I have handled everything in `group` through `seq`." Best effort. */
  received(group: string, seq: number): Promise<void>;
  /** Live doorbell to the other devices: "there is something new in `group`". Never stored. */
  ring(group: string): void;
  onRing(cb: (group: string) => void): void;
  onConnected(cb: () => void): void;
}

/** Where the receiver save number lives (see the header). keys.bin implements it today. */
interface CounterStore {
  get(): number;
  set(n: number): Promise<void>;
}

/** What a handler is given: the verified facts of one frame (a subset of OpenedFrame, so a deferred frame can be saved and replayed). */
export interface LinkFrame {
  group: string;
  seq: number;
  header: { kind: string; from: Buffer; counter: number };
  body: CborValue;
}
/** A handler throws this to say "I cannot act on this frame yet" (its roster entry or predecessor has not arrived): it is kept and
 *  retried after retryPending(), and expires. */
export class FrameWait extends Error {
  constructor(readonly why: string) { super(`frame waits: ${why}`); this.name = 'FrameWait'; }
}
/** A handler throws this to refuse a verified frame for good (bad content from a member): counted, never retried. */
export class FrameReject extends Error {
  constructor(readonly why: string) { super(`frame rejected: ${why}`); this.name = 'FrameReject'; }
}
export interface Rejection { group: string; seq: number; from: string; reason: string }

/** A relay answer may move the read position at most this far in one step; further is a hostile or broken relay. */
const MAX_POSITION_JUMP = 100_000;
/** Waiting frames kept (count, bytes) and for how long. */
const MAX_WAITING = 64;
const MAX_WAITING_BYTES = 8 * 1024 * 1024;
/** WHY per sender (review N4): frames that cannot be judged yet are parked BEFORE anything is authenticated, so anyone could fill a shared
 *  list. Each claimed sender now has its own allowance and overflow only ever pushes out that sender's OWN oldest frame. */
const MAX_WAITING_PER_SENDER = 16;
const MAX_WAITING_BYTES_PER_SENDER = 1024 * 1024;
const WAIT_EXPIRY_MS = 24 * 3_600_000;
const MAX_HANDLER_TRIES = 3;
const RECENT_REJECTIONS = 50;

export interface LinkOptions {
  identity: DeviceIdentity;
  setId: Buffer;
  carrier: Carrier;
  /** Directory for link-state.bin (the mesh folder). */
  meshDir: string;
  secrets: () => Map<number, Buffer>;
  /** Which generation label a new frame of this kind is sealed under; null = none is usable yet (nothing is sealed, the frame waits).
   *  Omitted: the highest label held. WHY (review N3, N12): the service names the secret made for exactly the removals it knows. */
  sealLabel?: (group: string, kind: string, wide?: boolean) => number | null;
  signKeyFor: (deviceId: Buffer) => Buffer | undefined;
  counter: CounterStore;
  onFrame: (f: LinkFrame) => void | Promise<void>;
  /** Is this device known AND removed? Only used to NAME a rejection ("signer-removed"); it never accepts anything. */
  isRemoved?: (deviceId: Buffer) => boolean;
  now?: () => number;
  log?: (event: string, fields?: Record<string, string | number>) => void;
  onEvent?: (event: 'rolled-back' | 'gap' | 'rejected' | 'waiting', info: { group: string }) => void;
}

type Waiting =
  | { kind: 'wire'; group: string; seq: number; since: number; wire: Buffer; writer: string | null }
  | { kind: 'opened'; group: string; seq: number; since: number; fkind: string; from: Buffer; counter: number; body: CborValue };
const waitingBytes = (w: Waiting): number => (w.kind === 'wire' ? w.wire.length : encode(w.body).length + 64);

class NoSecretYet extends Error {}
interface Outgoing { group: string; kind: string; body: CborValue; to?: Buffer; line?: boolean; wide?: boolean; optional?: boolean; resolve: (r: { counter: number }) => void; reject: (e: Error) => void; sealed?: { wire: Buffer; counter: number } }

const WAITABLE = new Set(['unknown-signer', 'unknown-generation']);
// Normal traffic, not an attack: repeats, and frames addressed to another device.
const QUIET = new Set(['replay', 'out-of-window', 'not-addressed-to-me']);
const STATE_VERSION = 1;

export class Link {
  readonly #o: LinkOptions;
  readonly #sender: FrameSender;
  readonly #receiver: FrameReceiver;
  /** COMMITTED read positions (saved, acknowledged). */
  readonly #cursors = new Map<string, number>();
  /** Session-only position, never behind the committed one (see the header). */
  readonly #soft = new Map<string, number>();
  #waiting: Waiting[] = [];
  readonly #rejectCounts = new Map<string, number>();
  readonly #recent: Rejection[] = [];
  readonly #syncing = new Map<string, Promise<void>>();
  readonly #again = new Set<string>();
  /** Frames that opened fine but whose handler failed. WHY kept: open() records the counter at once, so reopening the same
   *  wire bytes would be refused as a replay and the frame would be lost; the retry uses this copy instead. */
  readonly #failedOpen = new Map<string, { opened: OpenedFrame; tries: number }>();
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
    // WHY the soft position is forgotten on every (re)connect: a lying relay must not leave a position behind that an honest one then inherits.
    this.#o.carrier.onConnected(() => { this.#soft.clear(); void this.flush(); void this.syncAll(); });
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
  sendDurable(a: { group: string; kind: string; body: CborValue; to?: Buffer; line?: boolean; wide?: boolean; optional?: boolean }): Promise<{ counter: number }> {
    return new Promise((resolve, reject) => {
      this.#outbox.push({ ...a, resolve, reject });
      void this.flush();
    });
  }
  /** Call when a generation arrived or the roster changed: frames that were waiting for a usable secret are sealed and sent. */
  kick(): void {
    void this.flush();
  }
  private currentGen(head?: Outgoing): number {
    if (this.#o.sealLabel && head) {
      const l = this.#o.sealLabel(head.group, head.kind, head.wide === true);
      if (l === null) throw new NoSecretYet();
      if (!this.#o.secrets().has(l)) throw new NoSecretYet();
      return l;
    }
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
            const gen = this.currentGen(head);
            const secret = this.#o.secrets().get(gen) as Buffer;
            const wire = this.#sender.seal({ secret, gen, group: head.group, kind: head.kind, body: head.body, to: head.to ?? null });
            head.sealed = { wire, counter: this.#sender.framesSealed - 1 };
          }
          const r = await this.#o.carrier.hold(head.group, this.sessionHex, head.sealed.counter + 1, head.sealed.wire, head.line === true);
          if (r === 'stored') this.#o.carrier.ring(head.group);
          this.#outbox.shift();
          head.resolve({ counter: head.sealed.counter });
        } catch (e) {
          if (e instanceof NoSecretYet) {
            // an OPTIONAL frame (a repeatable control frame) is dropped instead of blocking everything behind it; the rest wait for kick()
            if (head.optional) { this.#outbox.shift(); head.reject(new Error('no-usable-secret')); continue; }
            return; // no usable secret yet: kick() resumes when one arrives
          }
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
  /** Call after the roster or a set secret changed: waiting frames are judged again. */
  retryPending(): void {
    if (this.#waiting.length === 0) return;
    for (const g of this.#cursors.keys()) void this.sync(g);
  }
  /** Frames waiting to be judged, and every rejection so far by reason (never content). */
  get waitingCount(): number {
    return this.#waiting.length;
  }
  rejections(): { counts: Record<string, number>; recent: Rejection[] } {
    return { counts: Object.fromEntries(this.#rejectCounts), recent: [...this.#recent] };
  }
  /** Operator reset: read every group again from the start. Replay protection keeps already-applied frames out. */
  async resetReadPosition(): Promise<void> {
    for (const g of this.#cursors.keys()) this.#cursors.set(g, 0);
    this.#soft.clear();
    await this.persist();
    void this.syncAll();
  }
  /** Resolves when this group is caught up (or offline). Overlapping calls are coalesced and re-run once. */
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
  private now(): number {
    return (this.#o.now ?? Date.now)();
  }
  private position(group: string): number {
    return Math.max(this.#soft.get(group) ?? 0, this.#cursors.get(group) ?? 0);
  }
  private async syncOnce(group: string): Promise<void> {
    if (this.#stopped) return;
    await this.drainWaiting(group); // needs no connection: the frames are already here
    if (!this.#o.carrier.connected) return;
    for (;;) {
      const cursor = this.position(group);
      const res = await this.#o.carrier.fetchAfter(group, cursor);
      if (res.gap) {
        // The relay released frames this device had not collected (it was away more than the relay's keep time).
        // WHY the jump is bounded and only soft (finding 7): `through` is the relay's word; 9e15 once froze a device for good.
        const through = res.gap.through;
        // A far jump is not refused (an honest relay can have released a long run): it only moves the SESSION position, never the saved one (review N9).
        if (!Number.isSafeInteger(through) || through <= cursor) { this.hostile(group, 'bad-gap'); return; }
        this.#soft.set(group, through);
        this.log('gap', { group, through });
        this.#o.onEvent?.('gap', { group });
        continue;
      }
      let prev = cursor;
      for (const f of res.frames) {
        if (!Number.isSafeInteger(f.seq) || f.seq <= prev) { this.hostile(group, 'bad-seq'); return; }
        prev = f.seq;
      }
      let committed = this.#cursors.get(group) ?? 0;
      let blocked = false;
      for (const f of res.frames) {
        const verdict = await this.handle(group, f.seq, f.bytes, f.writer ?? null);
        if (verdict === 'blocked') { blocked = true; break; }
        // A frame far past the position that did NOT verify (a lying relay's junk) must not drag even the session position along.
        const far = f.seq - (this.#cursors.get(group) ?? 0) > MAX_POSITION_JUMP;
        if (!(far && verdict === 'soft')) this.#soft.set(group, f.seq);
        // Only frames this device verified (or parked, which it now holds) move the committed position.
        // WHY the bound on SAVING (review 7 kept, N9 fixed): a verified frame far ahead is delivered but cannot drag the saved position past what
        // a lying relay could have invented; the next connection reads it again and replay protection keeps it from being applied twice.
        if ((verdict === 'verified' || verdict === 'waited') && f.seq - (this.#cursors.get(group) ?? 0) <= MAX_POSITION_JUMP) committed = Math.max(committed, f.seq);
      }
      const advanced = committed !== (this.#cursors.get(group) ?? 0);
      if (advanced || this.#dirty) {
        this.#cursors.set(group, committed);
        // While a frame is waiting on its handler, the receiver's table already counts it as seen: saving now could make a
        // crash lose it. Skip the save AND the acknowledgement; the next clean batch writes both.
        if (this.#failedOpen.size === 0) {
          await this.persist(); // durable BEFORE the acknowledgement below
          if (advanced) await this.#o.carrier.received(group, committed).catch((cause) => reportFailure({ what: 'acknowledge received frames to the relay (they will be offered again)', cause, where: 'mesh.link' }));
        }
      }
      if (blocked) {
        const t = setTimeout(() => { void this.sync(group); }, 2000);
        t.unref?.();
        return;
      }
      if (!res.more || res.frames.length === 0) return;
    }
  }
  #dirty = false;
  /** The relay answered with a position no honest relay could: forget the soft position and say so. */
  private hostile(group: string, why: string): void {
    this.#soft.delete(group);
    this.bump(`relay-${why}`);
    this.log('relay-bad-position', { group, why });
  }
  private bump(reason: string): void {
    this.#rejectCounts.set(reason, (this.#rejectCounts.get(reason) ?? 0) + 1);
    this.#dirty = true;
  }
  private reject(group: string, seq: number, from: string, reason: string): void {
    this.bump(reason);
    this.#recent.push({ group, seq, from, reason });
    if (this.#recent.length > RECENT_REJECTIONS) this.#recent.shift();
    this.log('frame-rejected', { group, reason, from });
    this.#o.onEvent?.('rejected', { group });
  }
  /** WHY the relay's stamp and not the frame's own header (third review, finding 9): the sender named in an unopened frame is a claim anybody can write, so
   *  17 junk frames naming a victim pushed the victim's real waiting frames out. The waiting allowance is charged to the device the relay says WROTE the
   *  frame (it stamped it from that connection's authenticated identity); a frame with no stamp shares one 'unstamped' allowance. An opened frame's
   *  sender is verified by its signature, so that is used for those. */
  private senderOf(w: Waiting): string {
    return w.kind === 'wire' ? (w.writer ? w.writer.slice(0, 8) : 'unstamped') : w.from.toString('hex').slice(0, 8);
  }
  private park(w: Waiting): void {
    this.#waiting.push(w);
    this.#dirty = true;
    const who = this.senderOf(w);
    const evict = (victim: Waiting): void => {
      this.#waiting = this.#waiting.filter((x) => x !== victim);
      this.reject(victim.group, victim.seq, this.senderOf(victim), 'wait-overflow');
    };
    // 1. one sender over ITS allowance loses its own oldest
    for (;;) {
      const mine = this.#waiting.filter((x) => this.senderOf(x) === who);
      if (mine.length <= MAX_WAITING_PER_SENDER && mine.reduce((n, x) => n + waitingBytes(x), 0) <= MAX_WAITING_BYTES_PER_SENDER) break;
      evict(mine[0]);
    }
    // 2. the whole list over its bound: the sender holding the most loses its oldest (a sender within a small share is never the victim)
    for (;;) {
      const bytes = this.#waiting.reduce((n, x) => n + waitingBytes(x), 0);
      if (this.#waiting.length <= MAX_WAITING && bytes <= MAX_WAITING_BYTES) break;
      const counts = new Map<string, number>();
      for (const x of this.#waiting) counts.set(this.senderOf(x), (counts.get(this.senderOf(x)) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      evict(this.#waiting.find((x) => this.senderOf(x) === top) as Waiting);
    }
    this.log('frame-waiting', { group: w.group });
    // WHY (third review, finding 7): control frames are now sealed under the secret that excludes removed devices, so a device that is behind sees the
    // other members' frames as waiting (secret not held yet). It says so at once (the service answers with its heads) instead of waiting for its next periodic announcement.
    this.#o.onEvent?.('waiting', { group: w.group });
  }
  /** Judge every waiting frame of `group` again (each once). Frames that now verify are delivered; the rest stay or expire. */
  private async drainWaiting(group: string): Promise<void> {
    const mine = this.#waiting.filter((w) => w.group === group);
    if (mine.length === 0) return;
    for (const w of mine) {
      const idx = this.#waiting.indexOf(w);
      if (idx < 0) continue;
      const fromPrefix = w.kind === 'wire' ? this.prefixOf(w.wire) : w.from.toString('hex').slice(0, 8);
      if (this.now() - w.since > WAIT_EXPIRY_MS) { this.removeWaiting(w); this.reject(w.group, w.seq, fromPrefix, 'wait-expired'); continue; }
      if (w.kind === 'wire') {
        const out = this.tryOpen(w.group, w.seq, w.wire);
        if (out === 'waiting') continue;
        this.removeWaiting(w);
        if (out === 'rejected' || out === 'quiet') continue; // tryOpen counted a rejection; quiet is a repeat
        await this.deliverLinkFrame({ group: w.group, seq: w.seq, header: { kind: out.opened.header.kind, from: out.opened.header.from, counter: out.opened.header.counter }, body: out.opened.body as CborValue }, w.since);
      } else {
        this.removeWaiting(w);
        await this.deliverLinkFrame({ group: w.group, seq: w.seq, header: { kind: w.fkind, from: w.from, counter: w.counter }, body: w.body }, w.since);
      }
    }
    if (this.#dirty && this.#failedOpen.size === 0) await this.persist();
  }
  private removeWaiting(w: Waiting): void {
    this.#waiting = this.#waiting.filter((x) => x !== w);
    this.#dirty = true;
  }
  private prefixOf(wire: Uint8Array): string {
    try { return peekHeader(wire).from.toString('hex').slice(0, 8); } catch { return 'unknown'; }
  }
  /** Open a frame. 'waiting' when it cannot be judged yet, 'rejected' (already counted) when it is refused, 'quiet' for traffic that is simply not for us / a repeat. */
  private tryOpen(group: string, seq: number, wire: Buffer): 'waiting' | 'rejected' | 'quiet' | { opened: OpenedFrame } {
    try {
      return { opened: this.#receiver.open(wire) };
    } catch (e) {
      const code = e instanceof MeshCryptoError ? e.code : 'error';
      if (QUIET.has(code)) return 'quiet';
      const from = this.prefixOf(wire);
      if (code === 'unknown-signer') {
        let removed = false;
        try { removed = this.#o.isRemoved?.(peekHeader(wire).from) === true; } catch { /* benign: bytes that are not a frame header cannot name a removed device; the frame goes on to the normal checks */ }
        // A removed device's leftover frame can never become judgeable: waiting for it would only fill a slot.
        if (removed) { this.reject(group, seq, from, 'signer-removed'); return 'rejected'; }
      }
      if (WAITABLE.has(code)) return 'waiting';
      this.reject(group, seq, from, code);
      return 'rejected';
    }
  }
  private async handle(group: string, seq: number, wire: Buffer, writer: string | null): Promise<'verified' | 'waited' | 'soft' | 'blocked'> {
    const key = `${group}:${seq}`;
    const prior = this.#failedOpen.get(key);
    let opened: OpenedFrame;
    if (prior) opened = prior.opened;
    else {
      const out = this.tryOpen(group, seq, wire);
      if (out === 'waiting') {
        this.park({ kind: 'wire', group, seq, since: this.now(), wire, writer });
        return 'waited';
      }
      if (out === 'rejected' || out === 'quiet') return 'soft';
      opened = out.opened;
    }
    return this.deliver(group, seq, opened);
  }
  private async deliver(group: string, seq: number, opened: OpenedFrame): Promise<'verified' | 'waited' | 'soft' | 'blocked'> {
    // My own frame coming back: it verified (so it is genuine), and there is nothing to apply.
    if (opened.header.from.equals(this.#o.identity.deviceId)) return 'verified';
    const f: LinkFrame = { group, seq, header: { kind: opened.header.kind, from: opened.header.from, counter: opened.header.counter }, body: opened.body as CborValue };
    return this.deliverLinkFrame(f, this.now(), `${group}:${seq}`, opened);
  }
  /** `opened` is given for a frame fresh off the wire (so a transient handler failure can retry it in place); a frame replayed from the
   *  waiting list has no such handle and goes back to the waiting list instead. */
  private async deliverLinkFrame(f: LinkFrame, since: number, key?: string, opened?: OpenedFrame): Promise<'verified' | 'waited' | 'soft' | 'blocked'> {
    const fromPrefix = f.header.from.toString('hex').slice(0, 8);
    const rewait = (): 'waited' => {
      this.park({ kind: 'opened', group: f.group, seq: f.seq, since, fkind: f.header.kind, from: f.header.from, counter: f.header.counter, body: f.body });
      return 'waited';
    };
    try {
      await this.#o.onFrame(f);
    } catch (e) {
      if (e instanceof FrameWait) {
        if (key) this.#failedOpen.delete(key);
        return rewait();
      }
      if (e instanceof FrameReject || e instanceof MeshCryptoError) {
        if (key) this.#failedOpen.delete(key);
        this.reject(f.group, f.seq, fromPrefix, e instanceof FrameReject ? e.why : `bad-${(e as MeshCryptoError).code}`);
        return 'verified'; // authenticated, just refused
      }
      // Anything else (a disk error): retry a few times, then give the frame up instead of freezing the group.
      if (!opened || !key) return rewait();
      const tries = (this.#failedOpen.get(key)?.tries ?? 0) + 1;
      if (tries >= MAX_HANDLER_TRIES) {
        this.#failedOpen.delete(key);
        this.reject(f.group, f.seq, fromPrefix, 'handler-failed');
        return 'verified';
      }
      this.log('handler-failed', { group: f.group });
      this.#failedOpen.set(key, { opened, tries });
      return 'blocked';
    }
    if (key) this.#failedOpen.delete(key);
    return 'verified';
  }

  // ---------------------------------------------------------------- state
  private get stateFile(): string {
    return path.join(this.#o.meshDir, 'link-state.bin');
  }
  async persist(): Promise<void> {
    const bytes = this.#receiver.exportState();
    const cursors: { [g: string]: CborValue } = {};
    for (const [g, c] of this.#cursors) cursors[g] = c;
    const waiting: CborValue[] = this.#waiting.map((w) => (w.kind === 'wire'
      ? { k: 'w', g: w.group, q: w.seq, t: w.since, b: w.wire, ...(w.writer ? { wr: w.writer } : {}) }
      : { k: 'o', g: w.group, q: w.seq, t: w.since, fk: w.fkind, f: w.from, c: w.counter, b: encode(w.body) }));
    const rej: { [k: string]: CborValue } = {};
    for (const [k, n] of this.#rejectCounts) rej[k] = n;
    this.#dirty = false;
    await writeFileDurable(this.stateFile, encode({ v: STATE_VERSION, receiver: bytes, cursors, waiting, rej }));
    await this.#o.counter.set(this.#receiver.saveCounter); // second file, second place: see the header
  }
  private async loadState(): Promise<void> {
    const raw = await readFileIfExists(this.stateFile);
    if (!raw) return;
    let receiverBytes: Buffer;
    try {
      const m = asMap(decode(raw), 'link state');
      onlyKeys(m, ['v', 'receiver', 'cursors', 'waiting', 'rej'], 'link state');
      if (asUint(m.v, 'v') !== STATE_VERSION) return;
      receiverBytes = asBytes(m.receiver, 'receiver');
      for (const [g, c] of Object.entries(asMap(m.cursors, 'cursors'))) this.#cursors.set(g, asUint(c, 'cursor'));
      if (m.waiting !== undefined) {
        for (const raw of asArray(m.waiting, 'waiting', MAX_WAITING)) {
          const w = asMap(raw, 'waiting entry');
          const base = { group: asText(w.g, 'g', 100), seq: asUint(w.q, 'q'), since: asUint(w.t, 't') };
          if (asText(w.k, 'k', 1) === 'w') this.#waiting.push({ kind: 'wire', ...base, wire: asBytes(w.b, 'wire'), writer: w.wr === undefined ? null : asText(w.wr, 'wr', 32) });
          else this.#waiting.push({ kind: 'opened', ...base, fkind: asText(w.fk, 'fk', 64), from: asBytes(w.f, 'from', 16), counter: asUint(w.c, 'c'), body: decode(asBytes(w.b, 'body')) });
        }
      }
      if (m.rej !== undefined) for (const [k, n] of Object.entries(asMap(m.rej, 'rej'))) this.#rejectCounts.set(k, asUint(n, 'rej count'));
    } catch {
      this.log('state-unreadable'); // a damaged file means "re-read everything"; replay refusal still protects what is known
      this.#cursors.clear();
      this.#waiting = [];
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
      this.#soft.clear();
      this.log('rolled-back');
      this.#o.onEvent?.('rolled-back', { group: '' });
    }
  }
}
