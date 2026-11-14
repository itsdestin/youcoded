// The relay client against a stand-in relay: sign-in, version refusal, removal, reconnect with backoff and jitter,
// send/ack/fetch, and "no frame body in any log".
import { afterEach, describe, expect, it } from 'vitest';
import { generateIdentity, setIdFor } from '../../src/main/mesh/crypto/identity';
import { RelayClient } from '../../src/main/mesh/relay-client';
import { FakeRelay } from './fake-relay';

const relays: FakeRelay[] = [];
const clients: RelayClient[] = [];
afterEach(async () => {
  while (clients.length) clients.pop()!.stop();
  while (relays.length) await relays.pop()!.close();
});
const relay = async (): Promise<FakeRelay> => { const r = await new FakeRelay().ready(); relays.push(r); return r; };
const when = (c: RelayClient, state: string, ms = 4000): Promise<void> =>
  new Promise((res, rej) => {
    if (c.state === state) return res();
    const t = setTimeout(() => rej(new Error(`never reached ${state}, stuck at ${c.state}`)), ms);
    c.on('state', (s) => { if (s === state) { clearTimeout(t); res(); } });
  });
const mk = (r: FakeRelay, id = generateIdentity(), extra: Partial<ConstructorParameters<typeof RelayClient>[0]> = {}) => {
  const logs: string[] = [];
  const c = new RelayClient({ url: r.url, setId: setIdFor(id.signKey), identity: id, createSet: true, baseDelayMs: 10, maxDelayMs: 80, random: () => 0.5, log: (e, f) => logs.push(e + ' ' + JSON.stringify(f ?? {})), ...extra });
  clients.push(c);
  return { c, id, logs };
};

describe('sign-in', () => {
  it('answers the signed challenge and becomes ready; the first device creates the room', async () => {
    const r = await relay();
    const { c, id } = mk(r);
    c.start();
    await when(c, 'ready');
    expect(r.rooms.size).toBe(1);
    expect([...r.rooms.values()][0].roster.has(id.deviceId.toString('hex'))).toBe(true);
  });
  it('a device the relay does not know yet keeps retrying with backoff and gets in once it is added', async () => {
    const r = await relay();
    const first = mk(r);
    first.c.start();
    await when(first.c, 'ready');
    const stranger = generateIdentity();
    const second = new RelayClient({ url: r.url, setId: setIdFor(first.id.signKey), identity: stranger, baseDelayMs: 10, maxDelayMs: 40, random: () => 0.5 });
    clients.push(second);
    const delays: number[] = [];
    second.on('backoff', (d: number) => delays.push(d));
    second.start();
    await new Promise((res) => setTimeout(res, 150));
    expect(delays.length).toBeGreaterThanOrEqual(3);
    expect(second.state).not.toBe('ready');
    expect(await first.c.rosterAdd(stranger.signKey.toString('hex'))).toBe('ok');
    await when(second, 'ready');
    expect(second.reconnectAttempts).toBe(0); // reset by success
  });
  it('refuses to sign when the relay names a different host than the one dialled (a relay forwarding another relay\'s challenge)', async () => {
    const r = await relay();
    r.audOverride = 'evil.example';
    const { c } = mk(r);
    c.start();
    await new Promise((res) => setTimeout(res, 200));
    expect(c.state).not.toBe('ready');
    expect([...r.rooms.values()].every((room) => room.roster.size === 0)).toBe(true); // nothing was ever signed
  });
});

describe('refusals that must NOT be retried', () => {
  it('a version the relay refuses stops the client and says so (no hammering)', async () => {
    const r = await relay();
    const { c } = mk(r, undefined, { protocolVersion: 99 });
    let said = false;
    c.on('version-refused', () => { said = true; });
    c.start();
    await when(c, 'refused-version');
    const connects = r.connects;
    await new Promise((res) => setTimeout(res, 150));
    expect(said).toBe(true);
    expect(r.connects).toBe(connects);
  });
  it('removal closes the connection for good and later calls fail', async () => {
    const r = await relay();
    const a = mk(r);
    a.c.start();
    await when(a.c, 'ready');
    const b = generateIdentity();
    const bc = new RelayClient({ url: r.url, setId: setIdFor(a.id.signKey), identity: b, baseDelayMs: 10, random: () => 0.5 });
    clients.push(bc);
    expect(await a.c.rosterAdd(b.signKey.toString('hex'))).toBe('ok');
    bc.start();
    await when(bc, 'ready');
    let removed = false;
    bc.on('removed', () => { removed = true; });
    expect(await a.c.rosterRemove(b.deviceId.toString('hex'))).toBe('ok');
    await when(bc, 'removed');
    expect(removed).toBe(true);
    await expect(bc.hold({ group: 'g', session: '0'.repeat(32), n: 1, frame: Buffer.from('x') })).rejects.toThrow();
    const connects = r.connects;
    await new Promise((res) => setTimeout(res, 100));
    expect(r.connects).toBe(connects);
  });
});

describe('reconnect', () => {
  it('after a network cut it reconnects by itself with growing, jittered delays', async () => {
    const r = await relay();
    const { c } = mk(r, undefined, { baseDelayMs: 20, maxDelayMs: 1000, random: () => 1 });
    const delays: number[] = [];
    c.on('backoff', (d: number) => delays.push(d));
    c.start();
    await when(c, 'ready');
    r.cutAll();
    await when(c, 'backoff');
    await when(c, 'ready');
    expect(delays.length).toBeGreaterThanOrEqual(1);
    expect(c.reconnectAttempts).toBe(0);
  });
  it('delay doubles up to the cap, always inside [cap/2, cap] (equal jitter)', async () => {
    const r = await relay();
    await r.close();
    relays.pop();
    for (const rnd of [0, 1]) {
      const id = generateIdentity();
      const c = new RelayClient({ url: r.url, setId: setIdFor(id.signKey), identity: id, baseDelayMs: 10, maxDelayMs: 100, random: () => rnd });
      clients.push(c);
      const delays: number[] = [];
      c.on('backoff', (d: number) => delays.push(d));
      c.start();
      await new Promise((res) => setTimeout(res, 400));
      c.stop();
      const caps = [10, 20, 40, 80, 100, 100];
      delays.slice(0, 5).forEach((d, i) => { expect(d).toBeGreaterThanOrEqual(caps[i] / 2); expect(d).toBeLessThanOrEqual(caps[i]); });
      expect(delays.length).toBeGreaterThanOrEqual(3);
    }
  });
  it('requests in flight when the connection drops are rejected, not left hanging', async () => {
    const r = await relay();
    const { c } = mk(r);
    c.start();
    await when(c, 'ready');
    const p = c.fetchAfter('g', 0).catch((e: Error) => e.message);
    r.cutAll();
    const out = await Promise.race([p, new Promise((res) => setTimeout(() => res('hung'), 1500))]);
    expect(out).not.toBe('hung');
  });
});

describe('send, acknowledge, fetch, catch up', () => {
  it('hold is acknowledged with a sequence; a repeat of the same number is a duplicate; fetch returns frames after a cursor', async () => {
    const r = await relay();
    const { c } = mk(r);
    c.start();
    await when(c, 'ready');
    const session = 'ab'.repeat(16);
    const one = await c.hold({ group: 'g1', session, n: 1, frame: Buffer.from('frame-one') });
    const two = await c.hold({ group: 'g1', session, n: 2, frame: Buffer.from('frame-two') });
    expect(one).toMatchObject({ op: 'stored', seq: 1 });
    expect(two).toMatchObject({ op: 'stored', seq: 2 });
    expect(await c.hold({ group: 'g1', session, n: 2, frame: Buffer.from('frame-two') })).toEqual({ op: 'duplicate' });
    const all = await c.fetchAfter('g1', 0);
    expect(all.frames.map((f) => [f.seq, f.bytes.toString()])).toEqual([[1, 'frame-one'], [2, 'frame-two']]);
    const rest = await c.fetchAfter('g1', 1);
    expect(rest.frames.map((f) => f.seq)).toEqual([2]);
    expect((await c.fetchAfter('nothing-here', 0)).frames).toEqual([]);
    await c.received('g1', 2);
  });
  it('a live ring from another device reaches the listener', async () => {
    const r = await relay();
    const a = mk(r);
    a.c.start();
    await when(a.c, 'ready');
    const b = generateIdentity();
    const bc = new RelayClient({ url: r.url, setId: setIdFor(a.id.signKey), identity: b });
    clients.push(bc);
    await a.c.rosterAdd(b.signKey.toString('hex'));
    bc.start();
    await when(bc, 'ready');
    const got = new Promise<string>((res) => bc.on('pass', (m: { group: string }) => res(m.group)));
    a.c.ring('chat.x');
    expect(await got).toBe('chat.x');
  });
});

describe('logging', () => {
  it('logs event names, codes and an 8-character room prefix only: no frame body, signature, key or full id', async () => {
    const r = await relay();
    const { c, logs, id } = mk(r);
    c.start();
    await when(c, 'ready');
    const secret = 'TOP-SECRET-FRAME-BODY';
    await c.hold({ group: 'g', session: '0f'.repeat(16), n: 1, frame: Buffer.from(secret) });
    r.cutAll();
    await when(c, 'backoff');
    await when(c, 'ready');
    const text = logs.join('\n');
    expect(text.length).toBeGreaterThan(0);
    for (const bad of [secret, Buffer.from(secret).toString('hex'), Buffer.from(secret).toString('base64'), id.deviceId.toString('hex'), id.signKey.toString('hex'), setIdFor(id.signKey).toString('hex')]) expect(text).not.toContain(bad);
  });
});
