// A small stand-in for the Mesh relay, for unit tests ONLY (the rig test runs the real Worker code instead).
// It speaks the same wire (shared/mesh-protocol.ts) and enforces the rules the client depends on: signed challenge
// (verified with the crypto library's RelayAuthVerifier), roster membership, per-sender numbering, held frames per group,
// fetch-after, pass, roster add/remove with close 4003. It is NOT a model of limits, hibernation or storage caps.
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import { RelayAuthVerifier } from '../../src/main/mesh/crypto/relay-auth';
import { deviceIdFor, setIdFor } from '../../src/main/mesh/crypto/identity';
import {
  CLOSE_AUTH_FAILED, CLOSE_DEVICE_REMOVED, CLOSE_VERSION_REFUSED, MESH_MAX_VERSION_FOR_TESTS,
  packMessage, unpackMessage,
} from './relay-consts';

interface Conn { ws: WebSocket; dev: string | null; room: string; verifier: RelayAuthVerifier; nonceHex: string }

export class FakeRelay {
  readonly wss: WebSocketServer;
  port = 0;
  readonly rooms = new Map<string, { roster: Map<string, { signKey: Buffer; removed: boolean }>; groups: Map<string, Array<{ seq: number; bytes: Buffer }>>; lastN: Map<string, number> }>();
  readonly conns = new Set<Conn>();
  /** Every raw payload ever stored (for "the relay cannot read it" checks). */
  readonly stored: Buffer[] = [];
  connects = 0;
  /** Test knob: refuse the next N authentications with close 4002 (a device the relay has not been told about yet). */
  failAuth = 0;
  /** Test knob: the host name the relay claims in its challenge (to prove the client refuses a mismatch). */
  audOverride: string | null = null;
  constructor() {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req.url ?? '', req.headers.host ?? ''));
  }
  async ready(): Promise<this> {
    await new Promise<void>((r) => this.wss.once('listening', () => r()));
    this.port = (this.wss.address() as AddressInfo).port;
    return this;
  }
  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }
  async close(): Promise<void> {
    for (const c of this.conns) c.ws.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
  /** Drop every connection without a close code (a network cut). */
  cutAll(): void {
    for (const c of this.conns) c.ws.terminate();
  }

  private room(id: string) {
    let r = this.rooms.get(id);
    if (!r) { r = { roster: new Map(), groups: new Map(), lastN: new Map() }; this.rooms.set(id, r); }
    return r;
  }
  private send(c: Conn, header: object, payload?: Uint8Array): void {
    if (c.ws.readyState === 1) c.ws.send(Buffer.from(packMessage(header, payload)));
  }
  private onConnection(ws: WebSocket, url: string, host: string): void {
    const m = /^\/mesh\/relay\/([0-9a-f]{64})\?v=(\d+)$/.exec(url);
    if (!m) { ws.close(CLOSE_AUTH_FAILED, 'bad path'); return; }
    if (Number(m[2]) > MESH_MAX_VERSION_FOR_TESTS || Number(m[2]) < 1) { ws.close(CLOSE_VERSION_REFUSED, 'version'); return; }
    this.connects++;
    const room = this.room(m[1]);
    const verifier = new RelayAuthVerifier(this.audOverride ?? host, (_r, dev) => room.roster.get(dev.toString('hex'))?.signKey);
    const ch = verifier.challenge();
    const c: Conn = { ws, dev: null, room: m[1], verifier, nonceHex: ch.nonce.toString('hex') };
    this.conns.add(c);
    ws.on('close', () => this.conns.delete(c));
    this.send(c, { op: 'challenge', aud: ch.aud, nonce: c.nonceHex, v: 1, min: 1 });
    ws.on('message', (data: Buffer, isBinary) => {
      if (!isBinary) { if (data.toString() === 'ping') ws.send('pong'); return; }
      const u = unpackMessage(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      if (!u.ok) { ws.close(4006, 'malformed'); return; }
      this.handle(c, u.header as Record<string, unknown> & { op: string; id?: string }, Buffer.from(u.payload));
    });
  }
  private handle(c: Conn, h: Record<string, any>, payload: Buffer): void {
    const room = this.room(c.room);
    const id = h.id ? { id: h.id } : {};
    if (c.dev === null) {
      if (h.op !== 'auth') return c.ws.close(4001, 'auth first');
      if (this.failAuth > 0) { this.failAuth--; return c.ws.close(CLOSE_AUTH_FAILED, 'refused'); }
      if (room.roster.size === 0 && typeof h.signKey === 'string') {
        const key = Buffer.from(h.signKey, 'hex');
        if (setIdFor(key).toString('hex') === c.room && deviceIdFor(key).toString('hex') === h.dev) room.roster.set(h.dev, { signKey: key, removed: false });
      }
      const row = room.roster.get(h.dev);
      if (row?.removed) { this.send(c, { op: 'auth-result', r: 'removed' }); return c.ws.close(CLOSE_DEVICE_REMOVED, 'removed'); }
      const v = c.verifier.verify({ room: Buffer.from(c.room, 'hex'), nonce: Buffer.from(c.nonceHex, 'hex'), dev: Buffer.from(h.dev, 'hex'), sig: Buffer.from(h.sig, 'hex') });
      if (!v.ok) return c.ws.close(CLOSE_AUTH_FAILED, 'refused');
      c.dev = h.dev;
      return this.send(c, { op: 'auth-result', r: 'ok', created: false, devices: [...room.roster.keys()] });
    }
    const row = room.roster.get(c.dev);
    if (!row || row.removed) return c.ws.close(CLOSE_DEVICE_REMOVED, 'removed');
    switch (h.op) {
      case 'hold': {
        if (h.from !== c.dev) return this.send(c, { op: 'refused', ...id, reason: 'forged-sender' });
        const key = `${c.dev}/${h.session}`;
        if (h.n <= (room.lastN.get(key) ?? 0)) return this.send(c, { op: 'duplicate', ...id, g: h.g, n: h.n });
        room.lastN.set(key, h.n);
        const list = room.groups.get(h.g) ?? [];
        const seq = list.length + 1;
        list.push({ seq, bytes: payload });
        room.groups.set(h.g, list);
        this.stored.push(payload);
        return this.send(c, { op: 'stored', ...id, g: h.g, seq, fill: 'ok' });
      }
      case 'fetch-after': {
        const list = (room.groups.get(h.g) ?? []).filter((f) => f.seq > h.seq);
        for (const f of list) this.send(c, { op: 'frame', ...id, g: h.g, seq: f.seq }, f.bytes);
        return this.send(c, { op: 'frames-end', ...id, g: h.g, more: false, last: list.at(-1)?.seq ?? h.seq, empty: list.length === 0 });
      }
      case 'received': return this.send(c, { op: 'ok', ...id });
      case 'pass':
        for (const o of this.conns) if (o !== c && o.dev && (h.to === 'all' || h.to === o.dev)) this.send(o, { op: 'pass', from: c.dev, g: h.g }, payload);
        return;
      case 'roster-add': {
        const key = Buffer.from(h.signKey, 'hex');
        const dev = deviceIdFor(key).toString('hex');
        if (room.roster.has(dev)) return this.send(c, { op: 'refused', ...id, reason: 'already-member' });
        room.roster.set(dev, { signKey: key, removed: false });
        return this.send(c, { op: 'ok', ...id, dev });
      }
      case 'roster-remove': {
        const t = room.roster.get(h.dev);
        if (!t || t.removed) return this.send(c, { op: 'refused', ...id, reason: 'not-found' });
        t.removed = true;
        for (const o of this.conns) if (o.dev === h.dev) o.ws.close(CLOSE_DEVICE_REMOVED, 'device removed');
        return this.send(c, { op: 'ok', ...id });
      }
      default: return this.send(c, { op: 'refused', ...id, reason: 'unknown-op' });
    }
  }
}
