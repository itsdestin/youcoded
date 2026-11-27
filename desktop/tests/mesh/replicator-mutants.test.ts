// Review 2, item 7: one test for each guard the reviewer's mutation run showed nothing depended on. Each test names its guard; the build report lists what happens when the guard is broken.
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repWorld, wireId, lineSet, CHAT, type World } from './replicator-world';
import { chatGroup } from '../../src/main/mesh/replicator/ctx';
import { SignedHeads } from '../../src/main/mesh/replicator/signed-heads';
import { ackBodyOf, ackMessage, GROUP_LIVE, headMessage, headsBodyOf, KIND_ACK, KIND_HEADS, KIND_LINES, linesBody } from '../../src/main/mesh/replicator/wire';
import { chainStep, defaultChainSeeds } from '../../src/main/mesh/store';
import { signWith } from '../../src/main/mesh/crypto/identity';
import { realFs } from '../../src/main/mesh/store/fsio';

let w: World | null = null;
afterEach(async () => { await w?.stopAll(); w?.cleanup(); w = null; });
const st = async (world: World, n: string, v: Buffer): Promise<string> => { const s = await world.devs[n].rep.status(v); return `${s.state}${s.reason ? `(${s.reason})` : ''}`; };
const down = async (world: World, n: string): Promise<void> => { await world.devs[n].rep.idle(); world.devs[n].rep.stop(); world.devs[n].link.stop(); await world.devs[n].store.close(); };
const claim = (world: World, V: Buffer, lines: number, hash: Buffer): void => { world.devs.B.link.sendLive({ group: GROUP_LIVE, kind: KIND_HEADS, body: headsBodyOf({ page: 0, of: 1, ask: false, heads: [{ version: V, lines, hash, conversationHash: Buffer.alloc(32), stamp: 1, state: 'ok' }] }) }); };

describe('guards the reviewer\'s mutation run found nothing depending on', () => {
  it('want hold-back (alone): the same peer is not asked twice within the gap', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('m-want');
    await world.create('A', V); await world.append('A', V, lineSet(3)); await world.settle();
    const before = world.devs.B.rep.counters()['want-held-back'] ?? 0;
    await world.devs.B.rep.askNow(V, world.ids.A.deviceId); await world.devs.B.rep.askNow(V, world.ids.A.deviceId);
    expect((world.devs.B.rep.counters()['want-held-back'] ?? 0) - before).toBeGreaterThanOrEqual(1);
  });
  it('a saved point that is not on my chain is skipped when I serve (pointsAfter off-chain skip)', async () => {
    w = await repWorld(['A', 'B', 'C'], { discoveryMs: 600_000 }); const world = w; const V = wireId('m-offchain');
    await world.create('A', V); await world.append('A', V, lineSet(6)); await world.settle();
    await down(world, 'B');
    // B's saved points gain one that the writer signed for ANOTHER history at line 3 (a writer that forked itself leaves such points)
    const bogus = randomBytes(32); const heads = new SignedHeads(realFs, nodePath.join(world.dirs.B, 'replicator'));
    await heads.add(V, { lines: 3, hash: bogus, sig: signWith(world.ids.A, headMessage(V, 3, bogus)), spanBytes: 0xffffffff });
    await world.restart('B');
    await down(world, 'A'); await down(world, 'C'); fs.rmSync(nodePath.join(world.dirs.C, 'store'), { recursive: true, force: true }); fs.rmSync(nodePath.join(world.dirs.C, 'replicator'), { recursive: true, force: true });
    await world.restart('C'); await world.elapse(120_000, 10_000);
    expect(await world.readAll('C', V)).toEqual(await world.readAll('B', V));
  });
  it('own record hash check: a store holding OTHER lines at the recorded count is refused by name', async () => {
    w = await repWorld(['A'], { discoveryMs: 600_000 }); const world = w; const V = wireId('m-ownhash');
    await world.create('A', V); await world.append('A', V, lineSet(4, 'real'));
    await down(world, 'A');
    // both records say: 4 lines, ANOTHER chain value (valid checksums)
    const { OwnRecords } = await import('../../src/main/mesh/replicator/own-record');
    await new OwnRecords(realFs, nodePath.join(world.dirs.A, 'replicator', 'own'), nodePath.join(world.dirs.A, 'witness')).save(V, { lines: 4, hash: 'ab'.repeat(32) });
    await world.restart('A');
    await expect(world.append('A', V, lineSet(1, 'n', 4))).rejects.toThrow(/writer-diverged-from-own-signed-head/);
  });
  it('peer same-count-other-hash: a fresh claim of my count with another chain value refuses the append by name', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('m-samecount');
    await world.create('A', V); await world.append('A', V, lineSet(3)); await world.settle();
    world.devs.B.rep.stop(); claim(world, V, 3, randomBytes(32)); await world.settle();
    await expect(world.append('A', V, lineSet(1, 'n', 3))).rejects.toThrow(/writer-diverged-from-peer/);
  });
  it('appendLocal refuses by name while the copy is being repaired (refilling check)', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000, stallMs: 600_000 }); const world = w; const V = wireId('m-refill');
    await world.create('A', V); await world.append('A', V, lineSet(30)); await world.settle();
    const local = (await world.localOf('A', V)) as Buffer; await down(world, 'A');
    const dir = nodePath.join(world.dirs.A, 'store', 'versions', local.toString('hex')); const f = fs.readdirSync(dir).find((x) => /^body-.*\.bin$/.test(x))!; const raw = fs.readFileSync(nodePath.join(dir, f)); raw[Math.floor(raw.length / 2)] ^= 0xff; fs.writeFileSync(nodePath.join(dir, f), raw);
    world.hub.holdFilter = () => 'drop'; world.devs.B.carrier.passFilter = () => 'drop';
    await world.restart('A'); await world.devs.A.rep.reportCorrupt(V);
    await expect(world.append('A', V, lineSet(1, 'n', 30))).rejects.toThrow(/refilling/);
  });
  it('onHeads ack delete: an ack that fell stays gone even when the same device later says it holds the lines again', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('m-ackdel');
    await world.create('A', V); await world.append('A', V, lineSet(5)); await world.settle();
    const hex = world.ids.B.deviceId.toString('hex'); const real = (await world.devs.A.store.head(await world.local('A', V)));
    await world.devs.A.rep.solicitAcks(V); await world.settle();
    expect(world.devs.A.rep.peerAcks(V).some((a) => a.holder === hex)).toBe(true);
    world.devs.B.rep.stop(); claim(world, V, 2, randomBytes(32)); await world.settle(); // it says it holds 2: the 5-line ack falls
    claim(world, V, 5, Buffer.from(real.hash, 'hex')); await world.settle(); // and now says 5 again, with the right chain value
    expect(world.devs.A.rep.peerAcks(V).some((a) => a.holder === hex)).toBe(false);
  });
  it('an ack that names a solicit round I never sent is not credited (round check)', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('m-round');
    await world.create('A', V); await world.append('A', V, lineSet(3)); await world.settle();
    world.devs.B.rep.stop();
    const h = await world.devs.A.store.head(await world.local('A', V)); const raw = Buffer.from(h.hash, 'hex');
    world.devs.B.link.sendLive({ group: GROUP_LIVE, kind: KIND_ACK, body: ackBodyOf({ version: V, lines: 3, hash: raw, round: 77, sig: signWith(world.ids.B, ackMessage(world.ids.B.deviceId, V, 3, raw, 77)) }) });
    await world.settle();
    expect(world.devs.A.rep.counters()['ack-round-unknown']).toBeGreaterThanOrEqual(1);
  });
});
