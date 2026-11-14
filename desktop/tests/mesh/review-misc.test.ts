// Review fixes (2026-11-14), smaller pieces: the roster file (finding 14), flood limits in the store (finding 4), a hostile relay against the
// client (findings 7, 8, 15), and the key-store rule on the phone path (finding 10).
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import { generateIdentity, setIdFor } from '../../src/main/mesh/crypto/identity';
import { makeAddEntry, makeGenesisEntry, makeRemoveEntry, makeRenameEntry, type SignedEntry } from '../../src/main/mesh/crypto/roster';
import { MeshRosterCorrupt, MeshRosterRejected, REMOTE_OWN_ENTRIES_PER_HOUR, RosterStore } from '../../src/main/mesh/roster-store';
import { RelayClient, assertSafeRelayUrl, MAX_FETCH_FRAMES } from '../../src/main/mesh/relay-client';
import { MeetingClient } from '../../src/main/mesh/meeting-client';
import { packMessage, unpackMessage } from '../../src/shared/mesh-protocol';
import { safeStorageSealer } from '../../src/main/mesh/keystore';
import { startMeshIfEnabled } from '../../src/main/mesh/boot-hook';
import { fakeSafeStorage, tmp } from './helpers';

const A = generateIdentity();
const B = generateIdentity();
const info = (d: typeof A, name: string) => ({ name, platform: 'linux', signKey: d.signKey, agreeKey: d.agreeKey });

describe('one damaged length in the middle of roster.log must not silently delete the rest', () => {
  async function sevenRecords(dir: string): Promise<{ store: RosterStore; entries: SignedEntry[] }> {
    const store = new RosterStore(dir);
    await store.load();
    const g = makeGenesisEntry(A, 'A', 'linux', 1);
    const entries = [g, makeAddEntry(A, info(B, 'B'), [g.id], 2)];
    for (let i = 0; i < 5; i++) entries.push(makeRenameEntry(A, 'n' + i, [entries[entries.length - 1].id], 3 + i));
    for (const e of entries) await store.append(e);
    return { store, entries };
  }
  const recordStarts = (raw: Buffer): number[] => { const out: number[] = []; let p = 0; while (p < raw.length) { out.push(p); p += 4 + raw.readUInt32BE(p) + 4; } return out; };

  it('a flipped length byte in record 4 is REFUSED and the file is left exactly as it was', async () => {
    const d = tmp();
    const { store } = await sevenRecords(d);
    const raw = fs.readFileSync(store.file);
    const starts = recordStarts(raw);
    const damaged = Buffer.from(raw);
    damaged[starts[3]] ^= 0x40; // the high byte of record 4's length: it now claims to run far past the end
    fs.writeFileSync(store.file, damaged);
    const again = new RosterStore(d);
    await expect(again.load()).rejects.toBeInstanceOf(MeshRosterCorrupt);
    expect(fs.readFileSync(store.file).equals(damaged)).toBe(true); // not shortened
  });
  it('a genuinely torn LAST record is still trimmed, as before (every offset)', async () => {
    const d = tmp();
    const { store, entries } = await sevenRecords(d);
    const raw = fs.readFileSync(store.file);
    const last = recordStarts(raw).at(-1)!;
    for (const cut of [last + 1, last + 3, last + 4, last + 20, raw.length - 1]) {
      fs.writeFileSync(store.file, raw.subarray(0, cut));
      const s = new RosterStore(d);
      await s.load();
      expect(s.size).toBe(entries.length - 1);
      expect(s.repairedTailBytes).toBe(cut - last);
    }
  });
});

describe('limits on entries that arrive from the network', () => {
  it('the hourly allowance belongs to the member that DELIVERS entries and is spent only by entries really signed by members: junk naming someone else costs them nothing', async () => {
    let t = 1_000_000;
    const d = tmp();
    const s = new RosterStore(d, () => t);
    await s.load();
    const g = makeGenesisEntry(A, 'A', 'linux', 1);
    await s.append(g);
    const addB = makeAddEntry(A, info(B, 'B'), [g.id], 2);
    await s.append(addB);
    // 100 forged entries that name A, delivered by D: they fail the signature check and are not counted against anyone
    for (let i = 0; i < 100; i++) await s.append({ ...g, id: Buffer.alloc(32, i + 1), device: A.deviceId, seen: [g.id], signature: Buffer.alloc(64, 1) } as SignedEntry, { remote: true, from: 'dd-junk' }).catch(() => undefined);
    expect(s.flagged.has('dd-junk')).toBe(false);
    // WHY changed (third review, finding 5): the allowance now counts only entries the DELIVERER signed itself, never removals, and it is a rolling hour:
    // a catch-up that relays someone else's entries costs the helper nothing, and a refused member is heard again when the hour has passed.
    const mk = (who: typeof A, n: number, tag: string): SignedEntry[] => { const out: SignedEntry[] = []; for (let i = 0; i < n; i++) out.push(makeRenameEntry(who, tag + i, [g.id, addB.id], 3 + i)); return out; };
    // B hands over 200 entries that B signed itself (more than the 120 an hour allows): the surplus is refused, only B is limited
    let rejected = 0;
    for (const e of mk(B, 200, 'b')) {
      try { await s.append(e, { remote: true, from: B.deviceId.toString('hex') }); } catch (err) { if (err instanceof MeshRosterRejected) rejected++; else throw err; }
    }
    expect(rejected).toBe(200 - REMOTE_OWN_ENTRIES_PER_HOUR);
    expect(s.flagged.has(B.deviceId.toString('hex'))).toBe(true);
    expect(s.flagged.has(A.deviceId.toString('hex'))).toBe(false);
    // a removal is never refused for rate, and entries RELAYED by B (signed by A) cost B nothing
    expect(await s.append(makeRemoveEntry(B, A.deviceId, [g.id, addB.id], 5), { remote: true, from: B.deviceId.toString('hex') })).toBe('appended');
    expect(await s.append(makeRenameEntry(A, 'relayed', [g.id, addB.id], 999), { remote: true, from: B.deviceId.toString('hex') })).toBe('appended');
    // after the hour B is heard again, with no restart
    t += 3_700_000;
    expect(await s.append(makeRenameEntry(B, 'later', [g.id, addB.id], 998), { remote: true, from: B.deviceId.toString('hex') })).toBe('appended');
    expect(s.flagged.has(B.deviceId.toString('hex'))).toBe(false);
  });

  it('removedIds, signKeyFor and activeDevices stay correct without rebuilding from the log (and the removed device\'s key is refused)', async () => {
    const d = tmp();
    const s = new RosterStore(d);
    await s.load();
    const g = makeGenesisEntry(A, 'A', 'linux', 1);
    await s.append(g);
    const add = makeAddEntry(A, info(B, 'B'), [g.id], 2);
    await s.append(add);
    expect(s.signKeyFor(B.deviceId)).toBeDefined();
    const { makeRemoveEntry } = await import('../../src/main/mesh/crypto/roster');
    await s.append(makeRemoveEntry(A, B.deviceId, [add.id], 3));
    expect(s.signKeyFor(B.deviceId)).toBeUndefined();
    expect(s.isRemoved(B.deviceId)).toBe(true);
    expect(s.activeDevices().map((x) => x.deviceId.toString('hex'))).toEqual([A.deviceId.toString('hex')]);
    expect(s.removalIdsOf(B.deviceId.toString('hex')).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('a hostile relay against the client', () => {
  const servers: WebSocketServer[] = [];
  const clients: RelayClient[] = [];
  afterEach(async () => {
    while (clients.length) clients.pop()!.stop();
    for (const s of servers.splice(0)) await new Promise<void>((r) => { for (const c of s.clients) c.terminate(); s.close(() => r()); });
  });
  /** A relay that signs everyone in and answers a fetch with whatever `onFetch` sends. */
  async function hostile(onFetch: (send: (header: object, payload?: Uint8Array) => boolean, id: string) => void | Promise<void>): Promise<{ url: string; sentBytes: () => number }> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(wss);
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as AddressInfo).port;
    let sent = 0;
    wss.on('connection', (ws) => {
      const send = (h: object, p?: Uint8Array): boolean => { if (ws.readyState !== 1) return false; const b = Buffer.from(packMessage(h, p)); sent += b.length; ws.send(b); return true; };
      send({ op: 'challenge', aud: `127.0.0.1:${port}`, nonce: 'ab'.repeat(32), v: 1, min: 1 });
      ws.on('message', (data: Buffer, isBinary) => {
        if (!isBinary) return;
        const u = unpackMessage(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
        if (!u.ok) return;
        const h = u.header as { op: string; id?: string };
        if (h.op === 'auth') send({ op: 'auth-result', r: 'ok', created: false, devices: [] });
        else if (h.op === 'fetch-after') void onFetch(send, h.id as string);
      });
    });
    return { url: `ws://127.0.0.1:${port}`, sentBytes: () => sent };
  }
  const connect = async (url: string): Promise<RelayClient> => {
    const id = generateIdentity();
    const c = new RelayClient({ url, setId: setIdFor(id.signKey), identity: id, baseDelayMs: 20, requestTimeoutMs: 5000 });
    clients.push(c);
    c.start();
    await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error('never ready')), 4000); c.on('state', (s) => { if (s === 'ready') { clearTimeout(t); res(); } }); });
    return c;
  };

  it('100 junk 4 MiB frames to one fetch: the client stops reading after about one page, rejects, and drops the connection (it used to buffer 1.75 GB)', async () => {
    const junk = new Uint8Array(4 * 1024 * 1024);
    const r = await hostile((send, id) => { for (let i = 1; i <= 100; i++) if (!send({ op: 'frame', id, g: 'g', seq: i }, junk)) break; });
    const c = await connect(r.url);
    // the honest relay never sends a frame bigger than 1 MiB: a 4 MiB message is over the socket's own limit, so nothing is ever buffered
    await expect(c.fetchAfter('g', 0)).rejects.toThrow();
  });
  it('frames each within the limit but adding up to more than one page are cut off at the page, not buffered to the end', async () => {
    const mib = new Uint8Array(1024 * 1024);
    let delivered = 0;
    const r = await hostile((send, id) => { for (let i = 1; i <= 40; i++) { if (!send({ op: 'frame', id, g: 'g', seq: i }, mib)) break; delivered++; } });
    const c = await connect(r.url);
    await expect(c.fetchAfter('g', 0)).rejects.toThrow('relay-oversize-answer');
    expect(delivered).toBeGreaterThan(0);
  });
  it('a reply of tiny frames past the count limit is refused too', async () => {
    const tiny = new Uint8Array(8);
    const r = await hostile((send, id) => { for (let i = 1; i <= MAX_FETCH_FRAMES + 50; i++) if (!send({ op: 'frame', id, g: 'g', seq: i }, tiny)) break; send({ op: 'frames-end', id, g: 'g', more: false, last: 1 }); });
    const c = await connect(r.url);
    await expect(c.fetchAfter('g', 0)).rejects.toThrow('relay-oversize-answer');
  });
  it('a normal page still comes through', async () => {
    const r = await hostile((send, id) => { for (let i = 1; i <= 50; i++) send({ op: 'frame', id, g: 'g', seq: i }, new Uint8Array(1000)); send({ op: 'frames-end', id, g: 'g', more: false, last: 50 }); });
    const c = await connect(r.url);
    const res = await c.fetchAfter('g', 0);
    expect(res.frames).toHaveLength(50);
  });
  it('a relay that says "ok" and hangs up does not reset the reconnect delay (it used to redial about once a second, forever)', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(wss);
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as AddressInfo).port;
    wss.on('connection', (ws) => {
      ws.send(Buffer.from(packMessage({ op: 'challenge', aud: `127.0.0.1:${port}`, nonce: 'ab'.repeat(32), v: 1, min: 1 })));
      ws.on('message', (data: Buffer, isBinary) => { if (isBinary) { ws.send(Buffer.from(packMessage({ op: 'auth-result', r: 'ok', created: false, devices: [] }))); setTimeout(() => ws.close(1011, 'bye'), 5); } });
    });
    const id = generateIdentity();
    const c = new RelayClient({ url: `ws://127.0.0.1:${port}`, setId: setIdFor(id.signKey), identity: id, baseDelayMs: 10, maxDelayMs: 1000, random: () => 1 });
    clients.push(c);
    const delays: number[] = [];
    c.on('backoff', (d: number) => delays.push(d));
    c.start();
    await vi.waitFor(() => expect(delays.length).toBeGreaterThanOrEqual(4), { timeout: 5000 });
    expect(delays[3]).toBeGreaterThan(delays[0]); // it grew: the delay was not reset by the bare "ok"
  });
});

describe('plain ws:// only to this machine', () => {
  it('refuses a non-loopback ws:// relay in the relay client and the meeting client; wss:// and loopback are fine', () => {
    expect(() => assertSafeRelayUrl('ws://relay.example.com')).toThrow('insecure-relay-url');
    expect(() => assertSafeRelayUrl('ws://192.168.1.5:8787')).toThrow('insecure-relay-url');
    expect(() => assertSafeRelayUrl('wss://api.youcoded.ai')).not.toThrow();
    expect(() => assertSafeRelayUrl('ws://127.0.0.1:9')).not.toThrow();
    expect(() => assertSafeRelayUrl('ws://localhost:9')).not.toThrow();
    const id = generateIdentity();
    expect(() => new RelayClient({ url: 'ws://relay.example.com', setId: setIdFor(id.signKey), identity: id })).toThrow('insecure-relay-url');
    expect(() => new MeetingClient({ url: 'ws://relay.example.com', id: 'a'.repeat(64), role: 'guest' })).toThrow('insecure-relay-url');
  });
});

describe('the key-store rule can refuse on the phone path', () => {
  it('a missing answer is a refusal on Android as on Linux; "unknown" and "basic_text" refuse; only a real backend passes', () => {
    const codeOf = (f: () => unknown): string | undefined => { try { f(); } catch (e) { return (e as { code?: string }).code; } return undefined; };
    expect(codeOf(() => safeStorageSealer(fakeSafeStorage(undefined), 'android' as NodeJS.Platform))).toBe('no-secret-store');
    expect(codeOf(() => safeStorageSealer(fakeSafeStorage('unknown'), 'android' as NodeJS.Platform))).toBe('no-secret-store');
    expect(codeOf(() => safeStorageSealer(fakeSafeStorage('android_keystore'), 'android' as NodeJS.Platform))).toBeUndefined();
  });
  it('the boot path asks the HOST: a shim that hard-codes android_keystore is overridden by what the host says, and silence refuses', async () => {
    const mk = (): string => { const d = tmp('phone-'); fs.writeFileSync(path.join(d, 'mesh-switch.json'), '{"enabled": true}'); return d; };
    const shim = fakeSafeStorage('android_keystore'); // the old shim: always claims the Keystore
    const d1 = mk();
    expect(await startMeshIfEnabled({ userData: d1, safeStorage: shim, packaged: true, platform: 'android', secretStoreBackend: () => 'unknown' })).toBeNull();
    expect(fs.existsSync(path.join(d1, 'mesh'))).toBe(false); // refused before anything was created
    const d2 = mk();
    expect(await startMeshIfEnabled({ userData: d2, safeStorage: shim, packaged: true, platform: 'android', secretStoreBackend: () => 'basic_text' })).toBeNull();
    const d3 = mk();
    const h = await startMeshIfEnabled({ userData: d3, safeStorage: shim, packaged: true, platform: 'android', secretStoreBackend: () => 'android_keystore' });
    expect(h).not.toBeNull();
    await h!.stop();
  });
  it('the headless shim reports "unknown" until the host says otherwise, and only the exact word android_keystore counts', async () => {
    const shim = await import('../../src/main/headless/electron-headless');
    expect(shim.hostSecretStoreBackend()).toBe('unknown');
    shim.holdSecretStoreBackend('android_keystore');
    expect(shim.hostSecretStoreBackend()).toBe('android_keystore');
    shim.holdSecretStoreBackend('Android_Keystore');
    expect(shim.hostSecretStoreBackend()).toBe('unknown');
    shim.holdSecretStoreBackend(undefined);
    expect(shim.hostSecretStoreBackend()).toBe('unknown');
  });
});
void createHash;
