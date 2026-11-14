// A small stand-in for the Mesh relay, for unit tests ONLY (the rig test runs the real Worker code instead).
// It speaks the same wire (shared/mesh-protocol.ts) and enforces the rules the client depends on: signed challenge
// (verified with the crypto library's RelayAuthVerifier), roster membership, per-sender numbering, held frames per group,
// fetch-after, pass, doorbell, signed roster puts (signature and signer only; the Worker tests own the ancestry rules) with
// close 4003, and a plain two-party meeting point. It is NOT a model of limits, hibernation or storage caps.
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import { RelayAuthVerifier, rosterStatementMessage, signRosterStatement } from '../../src/main/mesh/crypto/relay-auth';
import { verifySig, type DeviceIdentity } from '../../src/main/mesh/crypto/identity';
import type { RelayClient } from '../../src/main/mesh/relay-client';
import { randomBytes } from 'crypto';
import { deviceIdFor, setIdFor } from '../../src/main/mesh/crypto/identity';
import {
  CLOSE_AUTH_FAILED, CLOSE_DEVICE_REMOVED, CLOSE_VERSION_REFUSED, MESH_MAX_VERSION_FOR_TESTS,
  packMessage, unpackMessage,
} from './relay-consts';

interface Conn { ws: WebSocket; dev: string | null; room: string; verifier: RelayAuthVerifier; nonceHex: string }

export class FakeRelay {
  readonly wss: WebSocketServer;
  port = 0;
  readonly rooms = new Map<string, { roster: Map<string, { signKey: Buffer; removed: boolean }>; groups: Map<string, Array<{ seq: number; bytes: Buffer }>>; lastN: Map<string, number>; entries: Map<string, string[]>; intro: Map<string, string> }>();
  /** Test knob: answer every roster-put with this refusal (null = behave). A transient reason ('roster-rate-limited') is retried by the app. */
  rosterPutRefusal: string | null = null;
  /** Every roster statement accepted, in order: kind and the (hex) entry id. */
  readonly accepted: Array<{ kind: string; entry: string; seen: string[] }> = [];
  readonly conns = new Set<Conn>();
  /** Every raw payload ever stored (for "the relay cannot read it" checks). */
  readonly stored: Buffer[] = [];
  /** Every hold, with whether the sender marked it a chat line (`line`), as the relay's retention rule reads it. */
  readonly holds: Array<{ g: string; line: boolean }> = [];
  connects = 0;
  /** Meeting points opened by a member (id -> sockets). */
  readonly meetings = new Map<string, { ticket: string; host: WebSocket | null; guest: WebSocket | null; gens: number }>();
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
    if (!r) { r = { roster: new Map(), groups: new Map(), lastN: new Map(), entries: new Map(), intro: new Map() }; this.rooms.set(id, r); }
    return r;
  }
  private send(c: Conn, header: object, payload?: Uint8Array): void {
    if (c.ws.readyState === 1) c.ws.send(Buffer.from(packMessage(header, payload)));
  }
  private onMeeting(ws: WebSocket, id: string): void {
    const mt = this.meetings.get(id);
    if (!mt) { ws.close(4010, 'no such meeting'); return; }
    let role: 'host' | 'guest' | null = null;
    let gen = 0;
    const out = (to: WebSocket | null, header: object, payload?: Uint8Array): void => { if (to && to.readyState === 1) to.send(Buffer.from(packMessage(header, payload))); };
    ws.on('message', (data: Buffer, isBinary) => {
      if (!isBinary) return;
      const u = unpackMessage(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      if (!u.ok) return void ws.close(4006, 'malformed');
      const h = u.header as Record<string, any>;
      if (h.op === 'meet-join') {
        if (h.role === 'host' && h.ticket === mt.ticket) { role = 'host'; mt.host = ws; out(ws, { op: 'meet-joined', role, gen: 0, peer: !!mt.guest }); }
        else if (h.role === 'guest' && !mt.guest) { role = 'guest'; gen = ++mt.gens; mt.guest = ws; out(ws, { op: 'meet-joined', role, gen, peer: !!mt.host }); out(mt.host, { op: 'meet-peer', state: 'on', gen }); }
        else { out(ws, { op: 'refused', reason: 'busy' }); ws.close(4011, 'refused'); }
      } else if (h.op === 'meet-relay' && role) {
        const peer = role === 'host' ? mt.guest : mt.host;
        out(peer, { op: 'meet-relay', from: role, gen: role === 'guest' ? gen : mt.gens, n: h.n }, Buffer.from(u.payload));
      } else if (h.op === 'meet-close') {
        for (const w of [mt.host, mt.guest]) { out(w, { op: 'meet-ended', why: 'closed' }); w?.close(4010, 'closed'); }
        this.meetings.delete(id);
      }
    });
    ws.on('close', () => { if (role === 'guest') { mt.guest = null; out(mt.host, { op: 'meet-peer', state: 'off', gen }); } else if (role === 'host') this.meetings.delete(id); });
  }
  private onConnection(ws: WebSocket, url: string, host: string): void {
    const mm = /^\/mesh\/meet\/([0-9a-f]{64})\?v=1$/.exec(url);
    if (mm) return this.onMeeting(ws, mm[1]);
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
      this.send(c, { op: 'auth-result', r: 'ok', created: false, devices: [...room.roster.keys()] });
      for (const o of this.conns) if (o !== c && o.dev && o.room === c.room && o.dev !== c.dev) this.send(o, { op: 'presence-change', device: c.dev, state: 'on' });
      return;
    }
    const row = room.roster.get(c.dev);
    if (!row || row.removed) return c.ws.close(CLOSE_DEVICE_REMOVED, 'removed');
    switch (h.op) {
      case 'hold': {
        if (h.from !== c.dev) return this.send(c, { op: 'refused', ...id, reason: 'forged-sender' });
        const key = `${c.dev}/${h.session}`;
        if (h.n <= (room.lastN.get(key) ?? 0)) return this.send(c, { op: 'duplicate', ...id, g: h.g, n: h.n });
        room.lastN.set(key, h.n);
        this.holds.push({ g: h.g, line: h.line === true });
        const list = room.groups.get(h.g) ?? [];
        const seq = list.length + 1;
        list.push({ seq, bytes: payload, w: c.dev });
        room.groups.set(h.g, list);
        this.stored.push(payload);
        for (const o of this.conns) if (o !== c && o.dev && o.room === c.room) this.send(o, { op: 'doorbell', g: h.g, seq });
        return this.send(c, { op: 'stored', ...id, g: h.g, seq, fill: 'ok' });
      }
      case 'fetch-after': {
        const list = (room.groups.get(h.g) ?? []).filter((f) => f.seq > h.seq);
        for (const f of list) this.send(c, { op: 'frame', ...id, g: h.g, seq: f.seq, w: f.w ?? null }, f.bytes);
        return this.send(c, { op: 'frames-end', ...id, g: h.g, more: false, last: list.at(-1)?.seq ?? h.seq, empty: list.length === 0 });
      }
      case 'received': return this.send(c, { op: 'ok', ...id });
      case 'presence': return this.send(c, { op: 'presence-result', ...id, devices: [...new Set([...this.conns].filter((o) => o.dev && o.room === c.room).map((o) => o.dev as string))] });
      case 'pass':
        for (const o of this.conns) if (o !== c && o.dev && (h.to === 'all' || h.to === o.dev)) this.send(o, { op: 'pass', from: c.dev, g: h.g }, payload);
        return;
      case 'roster-put': {
        const signer = room.roster.get(h.signer);
        if (!signer || signer.removed) return this.send(c, { op: 'refused', ...id, reason: signer ? 'signer-removed' : 'not-a-member' });
        const st = { kind: h.kind, room: Buffer.from(c.room, 'hex'), signer: Buffer.from(h.signer, 'hex'), target: Buffer.from(h.target, 'hex'), targetKey: h.targetKey ? Buffer.from(h.targetKey, 'hex') : null, entry: Buffer.from(h.entry, 'hex'), seen: (h.seen as string[]).map((x) => Buffer.from(x, 'hex')), at: h.at };
        if (!verifySig(signer.signKey, rosterStatementMessage(st), Buffer.from(h.sig, 'hex'))) return this.send(c, { op: 'refused', ...id, reason: 'bad-signature' });
        if (this.rosterPutRefusal) return this.send(c, { op: 'refused', ...id, reason: this.rosterPutRefusal });
        // The relay's ANCESTRY rule, as the Worker applies it (relay-room.ts rosterPut): the first statement names the creator's genesis
        // entry alone; every later one must reach the signer's own introduction through statements the relay has accepted. This is what a
        // rename the relay never heard of used to break, so the stand-in must enforce it too or the unit tests could not catch that.
        const seenHex = h.seen as string[];
        if (room.entries.size === 0) {
          if (seenHex.length !== 1 || [...room.roster.values()].filter((r) => !r.removed).length !== 1) return this.send(c, { op: 'refused', ...id, reason: 'bad-ancestry' });
          room.entries.set(seenHex[0], []);
          room.intro.set(h.signer, seenHex[0]);
        } else {
          const intro = room.intro.get(h.signer);
          const visited = new Set<string>();
          const stack = [...seenHex];
          while (stack.length) { const x = stack.pop() as string; if (visited.has(x)) continue; visited.add(x); for (const y of room.entries.get(x) ?? []) stack.push(y); }
          if (!intro || !visited.has(intro)) return this.send(c, { op: 'refused', ...id, reason: 'bad-ancestry' });
        }
        if (room.entries.has(h.entry)) return this.send(c, { op: 'refused', ...id, reason: 'duplicate' });
        const accept = (): void => { room.entries.set(h.entry, seenHex); this.accepted.push({ kind: h.kind, entry: h.entry, seen: seenHex }); };
        if (h.kind === 'rename') { accept(); return this.send(c, { op: 'ok', ...id }); }
        if (h.kind === 'add') {
          const key = Buffer.from(h.targetKey, 'hex');
          if (deviceIdFor(key).toString('hex') !== h.target) return this.send(c, { op: 'refused', ...id, reason: 'bad-header' });
          const had = room.roster.get(h.target);
          if (had) return this.send(c, { op: 'refused', ...id, reason: had.removed ? 'banned' : 'already-member' });
          room.roster.set(h.target, { signKey: key, removed: false });
          room.intro.set(h.target, h.entry);
          accept();
          return this.send(c, { op: 'ok', ...id, dev: h.target });
        }
        const t = room.roster.get(h.target);
        if (!t || t.removed) return this.send(c, { op: 'refused', ...id, reason: 'not-found' });
        t.removed = true;
        accept();
        for (const o of this.conns) if (o.dev === h.target) o.ws.close(CLOSE_DEVICE_REMOVED, 'device removed');
        return this.send(c, { op: 'ok', ...id });
      }
      case 'meet-open': {
        const ticket = randomBytes(16).toString('hex');
        this.meetings.set(h.m, { ticket, host: null, guest: null, gens: 0 });
        return this.send(c, { op: 'meet-opened', ...id, m: h.m, ticket, ttlMs: 300000 });
      }
      default: return this.send(c, { op: 'refused', ...id, reason: 'unknown-op' });
    }
  }
}

/** Introduction entry per (room, device) for the helper below: a creator's is the first `seen` it used (its genesis), an added device's is the add. */
const introFor = new Map<string, Buffer>();
/** A signed roster put from `signer` (a member) about `target`, built the way service.ts builds it (ancestry = the signer's own introduction);
 *  the fake checks signature, signer and ancestry. */
export async function putRoster(c: RelayClient, signer: DeviceIdentity, room: Buffer, kind: 'add' | 'remove' | 'rename', target: DeviceIdentity, seenIn?: Buffer[]): Promise<string> {
  const entry = randomBytes(32);
  const k = (d: DeviceIdentity): string => `${room.toString('hex')}/${d.deviceId.toString('hex')}`;
  const seen = seenIn ?? [introFor.get(k(signer)) ?? randomBytes(32)];
  if (!introFor.has(k(signer))) introFor.set(k(signer), seen[0]);
  const at = Date.now();
  const targetKey = kind === 'add' ? target.signKey : null;
  const { sig } = signRosterStatement(signer, { kind, room, target: kind === 'rename' ? signer.deviceId : target.deviceId, targetKey, entry, seen, at });
  const r = await c.rosterPut({ kind, signer: signer.deviceId.toString('hex'), target: (kind === 'rename' ? signer : target).deviceId.toString('hex'), ...(targetKey ? { targetKey: targetKey.toString('hex') } : {}), entry: entry.toString('hex'), seen: seen.map((x) => x.toString('hex')), at, sig: sig.toString('hex') });
  if (r === 'ok' && kind === 'add') introFor.set(k(target), entry);
  return r;
}
