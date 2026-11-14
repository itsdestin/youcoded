// Relay client: one WebSocket to the Mesh relay, speaking shared/mesh-protocol.ts (the Worker's wire types).
//
// WHAT IT DOES: dial `<relay>/mesh/relay/<room>?v=1`, answer the relay's challenge with a signature (the key never
// leaves the device), keep the connection alive, reconnect with exponential backoff and jitter, and offer promise
// based send/ack/fetch calls. It never reads frame contents: a frame is opaque bytes here (link.ts seals and opens).
//
// DECISIONS
//  * Version refusal (close 4005 or a `version-refused` message) STOPS reconnecting and says so: retrying an
//    update-needed refusal would only hammer the relay (design 5.11, threat model L-8).
//  * Removal (close 4003) and set erasure (4004) also stop for good; the caller decides what the user sees.
//  * Any other close, including a failed sign-in (a device the relay has not heard of yet, for example one that
//    was just paired), retries with backoff. Equal jitter: half the delay is fixed, half random, so a crowd of
//    devices after a relay restart does not reconnect in lockstep and no device waits near zero.
//  * The relay's per-sender numbering needs n >= 1 and strictly rising per (device, session); callers pass the
//    sealed frame counter + 1 (link.ts).
//  * LOGGING: only event names, close codes and an 8-character room prefix. Never frame bytes, keys, signatures,
//    full ids or the pairing code (pinned by relay-client.test.ts and the folder-wide no-secret-logging test).
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { answerRelayChallenge } from './crypto/relay-auth';
import type { DeviceIdentity } from './crypto/identity';
import {
  CLOSE_DEVICE_REMOVED, CLOSE_SET_ERASED, CLOSE_VERSION_REFUSED, MESH_PROTOCOL_VERSION,
  packMessage, unpackMessage, type MeshServerMessage,
} from '../../shared/mesh-protocol';

export type RelayState = 'idle' | 'connecting' | 'authenticating' | 'ready' | 'backoff' | 'stopped' | 'refused-version' | 'removed' | 'erased';
type LogFields = Record<string, string | number | boolean>;

export interface RelayClientOptions {
  /** `ws://127.0.0.1:1234` or `wss://host` (no path). The host (with port) is what the signed challenge names. */
  url: string;
  setId: Buffer;
  identity: DeviceIdentity;
  /** First device of a new set only: also present the public key so the relay can create the room. */
  createSet?: boolean;
  log?: (event: string, fields?: LogFields) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 0..1; injected so tests are deterministic. */
  random?: () => number;
  requestTimeoutMs?: number;
  keepaliveMs?: number;
  /** TEST SEAM: dial with another protocol version to prove the refusal path. */
  protocolVersion?: number;
}

export interface HoldArgs { group: string; session: string; n: number; frame: Uint8Array; line?: boolean }
export type HoldResult = { op: 'stored'; seq: number; fill: string } | { op: 'duplicate' } | { op: 'over-limit'; why: string } | { op: 'refused'; reason: string };
export interface FetchResult { frames: Array<{ seq: number; bytes: Buffer }>; more: boolean; last?: number; gap?: { through: number }; empty?: boolean }

interface Pending { resolve: (m: { header: Record<string, unknown>; payload: Uint8Array }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; frames?: Array<{ seq: number; bytes: Buffer }> }

const toArrayBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export class RelayClient extends EventEmitter {
  #state: RelayState = 'idle';
  #ws: WebSocket | null = null;
  #attempt = 0;
  #timer: NodeJS.Timeout | null = null;
  #keepalive: NodeJS.Timeout | null = null;
  #lastRx = 0;
  #seq = 0;
  #pending = new Map<string, Pending>();
  readonly #room: string;
  readonly #host: string;
  readonly #o: RelayClientOptions;
  /** Result of the most recent sign-in, for diagnostics ("not-on-roster" while a pairing finishes, and so on). */
  lastAuthResult = '';
  constructor(o: RelayClientOptions) {
    super();
    this.#o = o;
    this.#room = o.setId.toString('hex');
    this.#host = new URL(o.url).host;
  }
  get state(): RelayState {
    return this.#state;
  }
  get reconnectAttempts(): number {
    return this.#attempt;
  }
  private log(event: string, f: LogFields = {}): void {
    this.#o.log?.(event, { room: this.#room.slice(0, 8), ...f });
  }
  private setState(s: RelayState): void {
    if (this.#state === s) return;
    this.#state = s;
    this.emit('state', s);
  }

  start(): void {
    if (this.#state !== 'idle' && this.#state !== 'stopped') return;
    this.#attempt = 0;
    this.connect();
  }
  /** Close and stay closed (until start() again). */
  stop(): void {
    this.clearTimers();
    this.#state = 'stopped';
    this.emit('state', 'stopped');
    const ws = this.#ws;
    this.#ws = null;
    this.failAll(new Error('stopped'));
    try { ws?.close(1000, 'stopping'); } catch { /* already closed */ }
  }

  private clearTimers(): void {
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#keepalive) clearInterval(this.#keepalive);
    this.#timer = this.#keepalive = null;
  }
  private failAll(e: Error): void {
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(e); }
    this.#pending.clear();
  }

  private connect(): void {
    this.setState('connecting');
    const v = this.#o.protocolVersion ?? MESH_PROTOCOL_VERSION;
    const ws = new WebSocket(`${this.#o.url.replace(/\/$/, '')}/mesh/relay/${this.#room}?v=${v}`, { maxPayload: 8 * 1024 * 1024 });
    this.#ws = ws;
    this.#lastRx = Date.now();
    ws.on('open', () => { this.setState('authenticating'); this.log('connected'); });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (this.#ws !== ws) return;
      this.#lastRx = Date.now();
      if (!isBinary) return; // the platform's free "pong"; only binary messages are protocol
      this.onMessage(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    });
    ws.on('close', (code: number) => { if (this.#ws === ws) this.onClose(code); });
    ws.on('error', () => { /* a 'close' follows; nothing useful and nothing safe to log here */ });
    const ms = this.#o.keepaliveMs ?? 20_000;
    this.#keepalive = setInterval(() => {
      if (this.#ws !== ws) return;
      if (Date.now() - this.#lastRx > ms * 3) { this.log('silent-socket'); ws.terminate(); return; }
      try { ws.send('ping'); } catch { /* closing */ }
    }, ms);
    this.#keepalive.unref?.();
  }

  private onClose(code: number): void {
    this.clearTimers();
    this.#ws = null;
    this.failAll(new Error('connection closed'));
    this.log('closed', { code });
    if (code === CLOSE_VERSION_REFUSED) { this.setState('refused-version'); this.emit('version-refused'); return; }
    if (code === CLOSE_DEVICE_REMOVED) { this.setState('removed'); this.emit('removed'); return; }
    if (code === CLOSE_SET_ERASED) { this.setState('erased'); this.emit('erased'); return; }
    if (this.#state === 'stopped') return;
    this.scheduleReconnect();
  }
  private scheduleReconnect(): void {
    const base = this.#o.baseDelayMs ?? 1000;
    const cap = Math.min(this.#o.maxDelayMs ?? 30_000, base * 2 ** Math.min(this.#attempt, 16));
    const delay = Math.floor(cap * (0.5 + 0.5 * (this.#o.random ?? Math.random)()));
    this.#attempt++;
    this.setState('backoff');
    this.emit('backoff', delay);
    this.#timer = setTimeout(() => { this.#timer = null; if (this.#state === 'backoff') this.connect(); }, delay);
    this.#timer.unref?.();
  }

  private send(header: object, payload?: Uint8Array): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) throw new Error('not-connected');
    this.#ws.send(packMessage(header, payload));
  }

  private onMessage(buf: Buffer): void {
    const m = unpackMessage(toArrayBuffer(buf));
    if (!m.ok) return; // the relay is trusted for liveness only; junk is ignored
    const h = m.header as MeshServerMessage & { id?: string };
    if (h.op === 'challenge') return this.answerChallenge(h.aud, h.nonce);
    if (h.op === 'version-refused') { this.log('version-refused'); return; } // the close (4005) that follows does the work
    if (h.op === 'auth-result') {
      this.lastAuthResult = h.r;
      if (h.r === 'ok') { this.#attempt = 0; this.setState('ready'); this.log('ready'); this.emit('ready', { created: h.created === true, devices: h.devices ?? [] }); }
      else this.log('auth-refused', { result: h.r });
      return;
    }
    if (h.id && this.#pending.has(h.id)) {
      const p = this.#pending.get(h.id) as Pending;
      if (h.op === 'frame') { (p.frames ??= []).push({ seq: h.seq as number, bytes: Buffer.from(m.payload) }); return; }
      clearTimeout(p.timer);
      this.#pending.delete(h.id);
      return p.resolve({ header: h as unknown as Record<string, unknown>, payload: Buffer.from(m.payload) });
    }
    // Unsolicited pushes.
    if (h.op === 'pass') this.emit('pass', { from: h.from, group: h.g, payload: Buffer.from(m.payload) });
    else if (h.op === 'roster-changed') this.emit('roster-changed', { change: h.change, dev: h.dev });
    else if (h.op === 'released') this.emit('released', { group: h.g, throughSeq: h.throughSeq });
    else if (h.op === 'presence-change') this.emit('presence-change', { device: h.device, state: h.state });
  }

  private answerChallenge(aud: string, nonceHex: string): void {
    try {
      // answerRelayChallenge throws if the relay names a host other than the one we dialled (a relay forwarding
      // another relay's challenge to harvest a signature): then we hang up without signing anything.
      const r = answerRelayChallenge(this.#o.identity, this.#host, this.#o.setId, { aud, nonce: Buffer.from(nonceHex, 'hex') });
      this.send({ op: 'auth', v: this.#o.protocolVersion ?? MESH_PROTOCOL_VERSION, dev: r.dev.toString('hex'), sig: r.sig.toString('hex'), ...(this.#o.createSet ? { signKey: this.#o.identity.signKey.toString('hex') } : {}) });
    } catch {
      this.log('challenge-refused');
      this.#ws?.close(1008, 'relay mismatch');
    }
  }

  private request(header: Record<string, unknown>, payload?: Uint8Array, collectFrames = false): Promise<{ header: Record<string, unknown>; payload: Uint8Array; frames?: Array<{ seq: number; bytes: Buffer }> }> {
    if (this.#state !== 'ready') return Promise.reject(new Error('not-connected'));
    const id = `r${++this.#seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error('timeout')); }, this.#o.requestTimeoutMs ?? 15_000);
      const p: Pending = { resolve: (m) => resolve({ ...m, frames: p.frames }), reject, timer };
      if (collectFrames) p.frames = [];
      this.#pending.set(id, p);
      try { this.send({ ...header, id }, payload); } catch (e) { clearTimeout(timer); this.#pending.delete(id); reject(e as Error); }
    });
  }

  /** Store a sealed frame. `stored` means the relay holds it; the relay's own `duplicate` means "already had it". */
  async hold(a: HoldArgs): Promise<HoldResult> {
    const r = await this.request({ op: 'hold', g: a.group, from: this.#o.identity.deviceId.toString('hex'), session: a.session, n: a.n, ...(a.line ? { line: true } : {}) }, a.frame);
    const h = r.header;
    if (h.op === 'stored') return { op: 'stored', seq: h.seq as number, fill: String(h.fill) };
    if (h.op === 'duplicate') return { op: 'duplicate' };
    if (h.op === 'over-limit') return { op: 'over-limit', why: String(h.why) };
    return { op: 'refused', reason: String(h.reason ?? h.op) };
  }
  async fetchAfter(group: string, seq: number): Promise<FetchResult> {
    const r = await this.request({ op: 'fetch-after', g: group, seq }, undefined, true);
    const h = r.header;
    if (h.op === 'gap') return { frames: [], more: false, gap: { through: h.through as number } };
    if (h.op === 'frames-end') return { frames: r.frames ?? [], more: h.more === true, last: h.last as number | undefined, empty: h.empty === true };
    throw new Error(`fetch refused: ${String(h.reason ?? h.op)}`);
  }
  /** Tell the relay this device has handled everything in `group` up to `through` (lets it drop held frames). */
  async received(group: string, through: number): Promise<void> {
    await this.request({ op: 'received', g: group, through });
  }
  /** Live "doorbell" to every other connected device: a one-byte pass, never stored. Receivers fetch. */
  ring(group: string): void {
    try { this.send({ op: 'pass', g: group, to: 'all' }, Uint8Array.of(1)); } catch { /* offline: they will fetch on connect */ }
  }
  async rosterAdd(signKeyHex: string): Promise<string> {
    const r = await this.request({ op: 'roster-add', signKey: signKeyHex });
    return r.header.op === 'ok' ? 'ok' : String(r.header.reason ?? r.header.op);
  }
  async rosterRemove(devHex: string): Promise<string> {
    const r = await this.request({ op: 'roster-remove', dev: devHex });
    return r.header.op === 'ok' ? 'ok' : String(r.header.reason ?? r.header.op);
  }
  async presence(): Promise<string[]> {
    const r = await this.request({ op: 'presence' });
    return (r.header.devices as string[]) ?? [];
  }
}
