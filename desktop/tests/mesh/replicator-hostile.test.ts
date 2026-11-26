// A paired device that lies, forges or replays, and frames that are lost, doubled or late: the replicator must end loud or correct, never quietly wrong.
// Each test names the guard it exists for; "mutation guards" in the build report lists what happens when that guard is removed.
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { repWorld, wireId, lineSet, line, CHAT, type World } from './replicator-world';
import { chatGroup } from '../../src/main/mesh/replicator/ctx';
import { incarnationId } from '../../src/main/mesh/replicator/idmap';
import { SignedHeads } from '../../src/main/mesh/replicator/signed-heads';
import { ackBodyOf, ackMessage, headMessage, headsBodyOf, KIND_ACK, KIND_HEADS, KIND_LINES, KIND_NAK, linesBody, nakBodyOf } from '../../src/main/mesh/replicator/wire';
import { chainStep, defaultChainSeeds } from '../../src/main/mesh/store';
import { signWith } from '../../src/main/mesh/crypto/identity';
import { realFs } from '../../src/main/mesh/store/fsio';

let w: World | null = null;
afterEach(async () => { await w?.stopAll(); w = null; });

const seedOf = (): Buffer => defaultChainSeeds({ chatId: CHAT, version: new Uint8Array(), segment: 0 }).raw;
async function trio(): Promise<{ world: World; V: Buffer }> {
  const world = await repWorld(['A', 'B', 'C']);
  w = world;
  const V = wireId('h');
  await world.create('A', V);
  await world.devs.A.rep.appendLocal(V, lineSet(10));
  await vi.waitFor(async () => { for (const n of ['B', 'C']) expect((await world.heads(n, V)).lines).toBe(10); });
  await world.settle();
  return { world, V };
}
const chainOver = (base: Buffer, ls: Buffer[]): Buffer => ls.reduce((h, l) => chainStep(h, l), base);
async function unchanged(world: World, n: string, V: Buffer, lines: number): Promise<void> {
  const local = (await world.localOf(n, V)) as Buffer;
  expect(local.equals(incarnationId(V, 0))).toBe(true); // still the first incarnation: nothing was set aside
  const h = await world.devs[n].store.head(local);
  expect(h.lines).toBe(lines);
  expect((await world.devs[n].store.verify(local)).ok).toBe(true);
  expect(await world.devs[n].store.parkedList(local)).toEqual([]); // no peer line was ever parked
}

describe('a paired device that is not the writer cannot put lines into my chat', () => {
  it('lines carrying the lying device\'s own signature are rejected by name and change nothing (guard: signature before append)', async () => {
    const { world, V } = await trio();
    const forged = [line('forged', 0)];
    const hash = chainOver((await world.devs.B.store.head(await world.local('B', V)).then((h) => Buffer.from(h.hash, 'hex'))), forged);
    const head = { lines: 11, hash, sig: signWith(world.ids.C, headMessage(V, 11, hash)) }; // signed by C, not by the writer A
    await world.devs.C.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, body: linesBody({ version: V, from: 10, lines: forged, head }) });
    await vi.waitFor(() => expect(world.devs.B.rep.counters()['bad-head-signature']).toBeGreaterThanOrEqual(1));
    await world.settle();
    await unchanged(world, 'B', V, 10);
    await unchanged(world, 'A', V, 10);
  });
  it('a genuine signed head stuck onto other lines fails the chain check and changes nothing (guard: chain before append)', async () => {
    const { world, V } = await trio();
    const pt = await new SignedHeads(realFs, nodePath.join(world.dirs.C, 'replicator')).newest(V);
    expect(pt).not.toBeNull();
    const p = pt as NonNullable<typeof pt>;
    const swapped = [line('not what the writer signed', 0)];
    await world.devs.C.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, body: linesBody({ version: V, from: p.lines - 1, lines: swapped, head: { lines: p.lines, hash: p.hash, sig: p.sig } }) });
    await vi.waitFor(() => expect(world.devs.B.rep.counters()['chain-mismatch']).toBeGreaterThanOrEqual(1));
    await world.settle();
    await unchanged(world, 'B', V, 10);
  });
  it('a batch that starts past my head is dropped and asked for again, and nothing is ever parked (guard: no parking of peer lines)', async () => {
    w = await repWorld(['A', 'B']);
    const world = w; const V = wireId('p');
    await world.create('A', V);
    await world.devs.A.rep.appendLocal(V, lineSet(5));
    await vi.waitFor(async () => expect((await world.heads('B', V)).lines).toBe(5));
    let drop = true;
    world.hub.holdFilter = (_d, g) => (drop && g === chatGroup(world.setId, CHAT) ? 'drop' : 'store');
    await world.devs.A.rep.appendLocal(V, lineSet(3, 'lost', 5));
    await world.settle();
    drop = false;
    await world.devs.A.rep.appendLocal(V, lineSet(3, 'late', 8));
    await vi.waitFor(async () => expect((await world.heads('B', V)).lines).toBe(11));
    await world.settle();
    expect(world.devs.B.rep.counters()['lines-ahead-dropped']).toBeGreaterThanOrEqual(1);
    await unchanged(world, 'B', V, 11);
    expect(await world.readAll('B', V)).toEqual(await world.readAll('A', V));
  });
});

describe('a paired device that lies about what it holds', () => {
  it('claiming far more lines schedules a request and proves nothing: my copy is untouched and my status says I am still asking (guard: a claim is not proof)', async () => {
    const { world, V } = await trio();
    world.devs.C.link.sendLive({ group: 'rep.live', kind: KIND_HEADS, body: headsBodyOf({ page: 0, of: 1, ask: false, heads: [{ version: V, lines: 1000, hash: randomBytes(32), conversationHash: randomBytes(32), stamp: 1, state: 'ok' }] }) });
    await vi.waitFor(async () => expect((await world.devs.B.rep.status(V)).state).toBe('pulling'));
    await world.settle();
    await unchanged(world, 'B', V, 10);
    expect((await world.devs.B.rep.status(V)).state).not.toBe('in-sync');
  });
  it('the same count with another chain value is called diverged by name, never settled by length, and my copy is untouched (guard: no longest-wins)', async () => {
    const { world, V } = await trio();
    world.devs.C.link.sendLive({ group: 'rep.live', kind: KIND_HEADS, body: headsBodyOf({ page: 0, of: 1, ask: false, heads: [{ version: V, lines: 10, hash: randomBytes(32), conversationHash: randomBytes(32), stamp: 1, state: 'ok' }] }) });
    world.devs.C.rep.stop(); // the liar says its piece and then never answers a question (a real one would refute itself by serving the writer's signed lines)
    await vi.waitFor(async () => expect((await world.devs.B.rep.status(V)).state).toBe('diverged'));
    await world.settle();
    expect((await world.devs.B.rep.status(V)).state).toBe('diverged');
    await unchanged(world, 'B', V, 10);
  });
  it('a forged `not-a-prefix` from a peer never sets a copy aside: it only makes me ask again from the start, where signed batches decide (guard: nak is unsigned)', async () => {
    const { world, V } = await trio();
    world.devs.C.link.sendLive({ group: 'rep.live', kind: KIND_NAK, body: nakBodyOf({ version: V, at: 10, why: 'not-a-prefix', hashAtYourCount: randomBytes(32) }) });
    await vi.waitFor(() => expect(world.devs.B.rep.counters()['nak-not-a-prefix']).toBe(1));
    await world.settle();
    await unchanged(world, 'B', V, 10);
    expect(world.devs.B.rep.counters()['retired-recopy'] ?? 0).toBe(0);
  });
});

describe('acknowledgements', () => {
  it('an ack for lines the peer cannot prove on MY chain is not credited, even when its signature is good (guard: ack checked against hashAt)', async () => {
    const { world, V } = await trio();
    const bad = randomBytes(32);
    world.devs.C.link.sendLive({ group: 'rep.live', kind: KIND_ACK, body: ackBodyOf({ version: V, lines: 10, hash: bad, sig: signWith(world.ids.C, ackMessage(world.ids.C.deviceId, V, 10, bad)) }) });
    await vi.waitFor(() => expect(world.devs.A.rep.counters()['ack-not-on-my-chain']).toBe(1));
    await world.settle();
    expect(world.devs.A.rep.peerAcks(V).some((a) => a.holder === world.ids.C.deviceId.toString('hex') && a.hash === bad.toString('hex'))).toBe(false);
  });
  it('an ack with a signature that is not the sender\'s is ignored (guard: ack signature)', async () => {
    const { world, V } = await trio();
    const h = Buffer.from((await world.devs.A.store.head(await world.local('A', V))).hash, 'hex');
    world.devs.C.link.sendLive({ group: 'rep.live', kind: KIND_ACK, body: ackBodyOf({ version: V, lines: 10, hash: h, sig: signWith(world.ids.B, ackMessage(world.ids.C.deviceId, V, 10, h)) }) });
    await vi.waitFor(() => expect(world.devs.A.rep.counters()['ack-bad-signature']).toBe(1));
  });
  it('acks may fall as well as rise: a peer that now acknowledges fewer lines is credited with fewer (guard: no max())', async () => {
    const { world, V } = await trio();
    const cHex = world.ids.C.deviceId.toString('hex');
    const before = world.devs.A.rep.peerAcks(V).find((a) => a.holder === cHex);
    expect(before?.lines).toBe(10);
    const h5 = Buffer.from((await world.devs.A.store.hashAt(await world.local('A', V), 0, 5)) as string, 'hex');
    world.devs.C.link.sendLive({ group: 'rep.live', kind: KIND_ACK, body: ackBodyOf({ version: V, lines: 5, hash: h5, sig: signWith(world.ids.C, ackMessage(world.ids.C.deviceId, V, 5, h5)) }) });
    await vi.waitFor(() => expect(world.devs.A.rep.peerAcks(V).find((a) => a.holder === cHex)?.lines).toBe(5));
  });
  it('"the relay stored it" is not an acknowledgement: with B away, A holds no ack from B however many frames the relay keeps (guard: relay store != ack)', async () => {
    w = await repWorld(['A', 'B']);
    const world = w; const V = wireId('r');
    await world.create('A', V);
    await world.settle();
    world.devs.B.carrier.setOnline(false);
    await world.devs.A.rep.appendLocal(V, lineSet(4));
    await world.settle();
    expect(world.hub.stored.length).toBeGreaterThan(0);
    expect(world.devs.A.rep.peerAcks(V)).toEqual([]);
  });
});

describe('a copy that cannot vouch for what it holds', () => {
  it('a device with no signed points of the writer does not serve lines past a signature: it answers unavailable and the asker gets nothing (guard: never serve beyond a signed head)', async () => {
    w = await repWorld(['A', 'B', 'C']);
    const world = w; const V = wireId('s');
    await world.create('A', V);
    await world.settle();
    world.devs.B.carrier.setOnline(false);
    await world.devs.A.rep.appendLocal(V, lineSet(8));
    await vi.waitFor(async () => expect((await world.heads('C', V)).lines).toBe(8));
    await world.settle();
    // C keeps the lines but loses its record of the writer's signed heads; A goes away; B returns and can only ask C
    const { rmSync } = await import('node:fs');
    rmSync(nodePath.join(world.dirs.C, 'replicator', 'heads'), { recursive: true, force: true });
    world.hub.releaseThrough(chatGroup(world.setId, CHAT), 1_000_000); // the relay no longer holds what B missed, so B can only ask a device
    await world.restart('C');
    world.devs.A.carrier.setOnline(false);
    world.devs.B.carrier.setOnline(true);
    await vi.waitFor(() => expect(world.devs.B.rep.counters()['nak-unavailable']).toBeGreaterThanOrEqual(1));
    await world.settle();
    expect((await world.heads('B', V)).lines).toBe(0);
    expect(await world.readAll('B', V)).toEqual([]);
  });
});
