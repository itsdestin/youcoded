// Repair, retirement, forks, a full disk, and frames that are lost, doubled or late: the replicator must end correct or loud.
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repWorld, wireId, lineSet, line, CHAT, type World } from './replicator-world';
import { chatGroup } from '../../src/main/mesh/replicator/ctx';
import { incarnationId } from '../../src/main/mesh/replicator/idmap';
import { FaultFs } from '../../src/main/mesh/store/fault-fs';
import { chainStep, deriveForkId } from '../../src/main/mesh/store';
import { headMessage, introBodyOf, introMessage, KIND_INTRO, KIND_LINES, linesBody } from '../../src/main/mesh/replicator/wire';
import { signWith } from '../../src/main/mesh/crypto/identity';

let w: World | null = null;
afterEach(async () => { await w?.stopAll(); w = null; });
const vdir = (world: World, n: string, v: Buffer): string => nodePath.join(world.dirs[n], 'store', 'versions', incarnationId(v, 0).toString('hex'));
const allSame = async (world: World, v: Buffer, names: string[]): Promise<void> => {
  const bytes = await Promise.all(names.map((n) => world.readAll(n, v)));
  for (const b of bytes) expect(b).toEqual(bytes[0]);
  const heads = await Promise.all(names.map((n) => world.heads(n, v)));
  for (const h of heads) expect(h).toEqual(heads[0]);
};

describe('a copy that was rolled back or damaged', () => {
  it('a folder put back to an earlier state is refilled from a peer, and the report clears only when the store says so (guard: clear on store evidence)', async () => {
    w = await repWorld(['A', 'B']);
    const world = w; const V = wireId('rb');
    await world.create('A', V);
    await world.devs.A.rep.appendLocal(V, lineSet(12));
    await vi.waitFor(async () => expect((await world.heads('B', V)).lines).toBe(12));
    await world.settle();
    await world.devs.B.store.close(); world.devs.B.rep.stop(); world.devs.B.link.stop();
    const snap = nodePath.join(world.dirs.B, 'snap'); fs.cpSync(vdir(world, 'B', V), snap, { recursive: true });
    await world.restart('B');
    await world.devs.A.rep.appendLocal(V, lineSet(18, 'later', 12));
    await vi.waitFor(async () => expect((await world.heads('B', V)).lines).toBe(30));
    await world.settle();
    world.devs.B.rep.stop(); world.devs.B.link.stop(); await world.devs.B.store.close();
    fs.rmSync(vdir(world, 'B', V), { recursive: true }); fs.cpSync(snap, vdir(world, 'B', V), { recursive: true });
    world.devs.A.carrier.setOnline(false);
    const b = await world.restart('B');
    expect((await b.store.head(await world.local('B', V))).rolledBack).toEqual({ from: 12, had: 30 });
    expect((await b.rep.status(V)).state).toBe('refilling');
    world.devs.A.carrier.setOnline(true);
    await vi.waitFor(async () => expect((await b.store.head(await world.local('B', V))).lines).toBe(30), { timeout: 30_000 });
    await world.settle();
    const h = await b.store.head(await world.local('B', V));
    expect(h.rolledBack).toBeNull(); expect(h.damagedFromLine).toBeNull();
    await allSame(world, V, ['A', 'B']);
    expect((await b.rep.status(V)).state).toBe('in-sync');
  });
  it('a rotted line is advertised as the point the copy can vouch for, not its full head, and a resend heals it (guard: advertise only the vouched point)', async () => {
    w = await repWorld(['A', 'B']);
    const world = w; const V = wireId('rot');
    await world.create('A', V);
    await world.devs.A.rep.appendLocal(V, lineSet(20));
    await vi.waitFor(async () => expect((await world.heads('B', V)).lines).toBe(20));
    await world.settle();
    world.devs.B.rep.stop(); world.devs.B.link.stop(); await world.devs.B.store.close();
    const body = nodePath.join(vdir(world, 'B', V), 'body-0000000000000000.bin');
    const raw = fs.readFileSync(body); const lineLen = lineSet(1, 'm', 0)[0].length; raw[lineLen * 5 + 10] ^= 0xff; fs.writeFileSync(body, raw);
    world.devs.A.carrier.setOnline(false);
    const b = await world.restart('B');
    expect((await b.store.scrubStep(await world.local('B', V), { maxBytes: 1 << 20 })).damagedFromLine).toBe(5);
    await b.rep.hello();
    const adv = (await b.rep.advertised()).find((e) => e.version.equals(V));
    expect(adv).toMatchObject({ lines: 5, state: 'refilling' }); // NOT 20
    world.devs.A.carrier.setOnline(true);
    await vi.waitFor(async () => expect((await b.store.head(await world.local('B', V))).damagedFromLine).toBeNull(), { timeout: 30_000 });
    await world.settle();
    await allSame(world, V, ['A', 'B']);
    expect((await b.store.verify(await world.local('B', V))).ok).toBe(true);
  });
});

describe('two rotted lines', () => {
  it('a second rotted line BELOW the one the store named first is not declared healed (guard: a refill clears only when the whole version reads back)', async () => {
    w = await repWorld(['A', 'B']);
    const world = w; const V = wireId('rot2');
    await world.create('A', V);
    await world.devs.A.rep.appendLocal(V, lineSet(10));
    await vi.waitFor(async () => expect((await world.heads('B', V)).lines).toBe(10));
    await world.settle();
    world.devs.A.carrier.setOnline(false);
    const body = nodePath.join(vdir(world, 'B', V), 'body-0000000000000000.bin');
    const lineLen = lineSet(1, 'm', 0)[0].length;
    let b = world.devs.B;
    for (const at of [lineLen * 4 + 10, 12]) { // the first rot is in line 4, then another in line 0 (below it), both while the writer is away
      b.rep.stop(); b.link.stop(); await b.store.close();
      const raw = fs.readFileSync(body); raw[at] ^= 0xff; fs.writeFileSync(body, raw);
      b = await world.restart('B', { graceful: true });
      const hd = await b.store.head(await world.local('B', V));
      await b.store.read(await world.local('B', V), 0, 0, hd.lines).catch(async (e: { code?: string }) => { if (e?.code === 'corrupt') await b.rep.reportCorrupt(V); });
    }
    world.devs.A.carrier.setOnline(true);
    await world.elapse(120_000, 10_000);
    await vi.waitFor(async () => expect((await b.store.head(await world.local('B', V))).damagedFromLine).toBeNull(), { timeout: 30_000 });
    expect(await world.readAll('B', V)).toEqual(await world.readAll('A', V)); // every line reads back, including line 0
    expect((await b.store.verify(await world.local('B', V))).ok).toBe(true);
  });
});

describe('a copy that differs from the writer\'s', () => {
  it('lines signed by the writer that contradict my copy set it aside (kept) and recopy under a NEW id; the old id is never used again (guard: retired id is never reused)', async () => {
    w = await repWorld(['A', 'B']);
    const world = w; const V = wireId('rt');
    await world.create('A', V);
    await world.settle();
    // B's copy of the version holds other lines than the writer will sign
    await world.devs.B.store.append(await world.local('B', V), 0, 0, lineSet(6, 'other'));
    const good = lineSet(8, 'real');
    await world.devs.A.rep.appendLocal(V, good);
    await vi.waitFor(async () => expect(world.devs.B.rep.counters()['retired-recopy']).toBe(1));
    await vi.waitFor(async () => expect(await world.readAll('B', V)).toEqual(good));
    await world.settle();
    const local = (await world.localOf('B', V)) as Buffer;
    expect(local.equals(V)).toBe(false);
    await expect(world.devs.B.store.head(incarnationId(V, 0))).rejects.toMatchObject({ code: 'damaged' }); // the old id stays retired
    expect(fs.readdirSync(nodePath.join(world.dirs.B, 'store', 'aside')).length).toBeGreaterThan(0); // and its bytes are kept
    // a restart does not bring it back
    const b = await world.restart('B');
    await world.settle();
    expect(((await world.localOf('B', V)) as Buffer).equals(local)).toBe(true);
    expect((await b.rep.localId(V)).equals(local)).toBe(true); // the REPLICATOR also still uses the new incarnation, not the retired id
    expect(await world.readAll('B', V)).toEqual(good);
    expect((await b.rep.status(V)).state).toBe('in-sync');
  });
});

describe('a full disk', () => {
  it('B refuses to acknowledge when the disk is full, says so by name, and catches up exactly once space returns (LT-15)', async () => {
    const ffs = new FaultFs(0, { enospcFrom: 1_000_000, tear: true });
    w = await repWorld(['A', 'B'], { fsFor: (n) => (n === 'B' ? ffs : undefined) });
    const world = w; const V = wireId('df');
    await world.create('A', V);
    await world.devs.A.rep.appendLocal(V, lineSet(4));
    await vi.waitFor(async () => expect((await world.heads('B', V)).lines).toBe(4));
    await world.settle();
    (ffs as unknown as { opts: { enospcFrom: number } }).opts.enospcFrom = ffs.allocs + 1; // the disk fills now
    const before = world.devs.A.rep.peerAcks(V).find((a) => a.holder === world.ids.B.deviceId.toString('hex'));
    await world.devs.A.rep.appendLocal(V, lineSet(5, 'full', 4));
    await vi.waitFor(async () => expect((await world.devs.B.rep.status(V)).reason).toBe('disk-full'));
    await world.settle();
    expect((await world.devs.B.rep.status(V)).state).toBe('stuck');
    expect((await world.heads('B', V)).lines).toBe(4);
    expect(world.devs.A.rep.peerAcks(V).find((a) => a.holder === world.ids.B.deviceId.toString('hex'))?.lines).toBe(before?.lines); // no ack for what was not stored
    expect(world.devs.A.rep.counters()['nak-disk-full']).toBeGreaterThanOrEqual(1);
    (ffs as unknown as { opts: { enospcFrom?: number } }).opts.enospcFrom = undefined; // space freed
    await world.elapse(60_000);
    await vi.waitFor(async () => expect((await world.heads('B', V)).lines).toBe(9));
    await world.settle();
    await allSame(world, V, ['A', 'B']);
  });
});

describe('takeovers: forked versions', () => {
  async function takeover(world: World, parent: Buffer, at: number, token: string, by: string): Promise<Buffer> {
    const hash = (await world.devs[by].store.hashAt(await world.local(by, parent), 0, at)) as string;
    const child = deriveForkId(parent, at, hash, token);
    await world.devs[by].rep.createVersion({ version: child, chatId: CHAT, runtime: 'claude-code', parent, forkLine: at, forkHash: Buffer.from(hash, 'hex'), token });
    return child;
  }
  it('a child made by a takeover is forked locally on every device that holds the parent (no bytes of the first part travel), then continues from the new writer', async () => {
    w = await repWorld(['A', 'B', 'C']);
    const world = w; const V = wireId('fk');
    await world.create('A', V);
    await world.devs.A.rep.appendLocal(V, lineSet(10));
    await vi.waitFor(async () => { for (const n of ['B', 'C']) expect((await world.heads(n, V)).lines).toBe(10); });
    await world.settle();
    const sentBefore = world.hub.stored.length;
    const child = await takeover(world, V, 10, 'entry-1', 'B');
    await world.devs.B.rep.appendLocal(child, lineSet(5, 'b', 10));
    await vi.waitFor(async () => { for (const n of ['A', 'C']) expect((await world.heads(n, child)).lines).toBe(15); });
    await world.settle();
    await allSame(world, child, ['A', 'B', 'C']);
    expect((await world.readAll('A', child)).slice(0, 10)).toEqual(await world.readAll('A', V));
    expect(world.devs.A.rep.counters()['fork-local']).toBe(1);
    expect(world.devs.C.rep.counters()['fork-local']).toBe(1);
    expect(world.hub.stored.length - sentBefore).toBeLessThan(6); // only the new lines (and little else) crossed the relay, not the 10 shared ones again
    expect((await world.heads('A', V)).lines).toBe(10); // the parent is untouched
    await expect(world.devs.A.rep.appendLocal(child, lineSet(1))).rejects.toThrow('not-the-writer'); // lines of the child come from its named writer only
  });
  it('a device in the middle of copying the parent gets the parent to the fork line first, then the child', async () => {
    w = await repWorld(['A', 'B', 'C']);
    const world = w; const V = wireId('fm');
    await world.create('A', V);
    await world.devs.A.rep.appendLocal(V, lineSet(4));
    await vi.waitFor(async () => { for (const n of ['B', 'C']) expect((await world.heads(n, V)).lines).toBe(4); });
    await world.settle();
    world.devs.C.carrier.setOnline(false);
    await world.devs.A.rep.appendLocal(V, lineSet(6, 'more', 4));
    await vi.waitFor(async () => expect((await world.heads('B', V)).lines).toBe(10));
    const child = await takeover(world, V, 10, 'entry-2', 'B');
    await world.devs.B.rep.appendLocal(child, lineSet(5, 'b', 10));
    await world.settle();
    world.hub.releaseThrough(chatGroup(world.setId, CHAT), 1_000_000); // C finds nothing waiting at the relay: only its peers can help
    world.devs.C.carrier.setOnline(true);
    await vi.waitFor(async () => expect((await world.heads('C', child)).lines).toBe(15), { timeout: 30_000 });
    await world.settle();
    await allSame(world, child, ['A', 'B', 'C']);
    await allSame(world, V, ['A', 'B', 'C']);
  });
  it('two devices that announce the same child id with different writers: the first announcement stands, the other writer\'s lines are rejected, and the conflict is named', async () => {
    w = await repWorld(['A', 'B', 'C']);
    const world = w; const V = wireId('fc');
    await world.create('A', V);
    await world.devs.A.rep.appendLocal(V, lineSet(6));
    await vi.waitFor(async () => { for (const n of ['B', 'C']) expect((await world.heads(n, V)).lines).toBe(6); });
    await world.settle();
    const child = await takeover(world, V, 6, 'same-entry', 'A');
    await world.settle();
    // the same takeover claimed by a second device: B signs its own announcement of the same child id and sends it
    const hash = Buffer.from((await world.devs.B.store.hashAt(await world.local('B', V), 0, 6)) as string, 'hex');
    const claim = { version: child, chatId: CHAT, runtime: 'claude-code' as const, parent: V, forkLine: 6, forkHash: hash, token: 'same-entry', writer: world.ids.B.deviceId };
    world.devs.B.link.sendLive({ group: 'rep.live', kind: KIND_INTRO, body: introBodyOf({ ...claim, sig: signWith(world.ids.B, introMessage(claim)) }) });
    await vi.waitFor(async () => expect((await world.devs.C.rep.status(child)).reason).toBe('directory-conflict'));
    await world.settle();
    const aLines = lineSet(3, 'from-a', 6);
    await world.devs.A.rep.appendLocal(child, aLines);
    const forged = lineSet(3, 'from-b', 6);
    const h0 = Buffer.from((await world.devs.B.store.hashAt(await world.local('B', V), 0, 6)) as string, 'hex');
    const fh = forged.reduce((h, l) => chainStep(h, l), h0);
    await world.devs.B.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, body: linesBody({ version: child, from: 6, lines: forged, head: { lines: 9, hash: fh, sig: signWith(world.ids.B, headMessage(child, 9, fh)) } }) });
    await vi.waitFor(async () => expect((await world.heads('C', child)).lines).toBe(9));
    await world.settle();
    expect((await world.readAll('C', child)).slice(6)).toEqual(aLines);
    expect(world.devs.C.rep.counters()['bad-head-signature']).toBeGreaterThanOrEqual(1);
  });
});

describe('frames that are lost, doubled, late or out of order', () => {
  it('under heavy loss, duplication and delay both devices still end with identical lines once the noise stops', async () => {
    w = await repWorld(['A', 'B', 'C'], { discoveryMs: 30_000, stallMs: 10_000 });
    const world = w; const V = wireId('noise');
    await world.create('A', V);
    let seed = 12345; const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    world.hub.holdFilter = () => { const r = rnd(); return r < 0.2 ? 'drop' : r < 0.35 ? 'dup' : 'store'; };
    for (const n of ['A', 'B', 'C']) world.devs[n].carrier.passFilter = () => { const r = rnd(); return r < 0.2 ? 'drop' : r < 0.3 ? 'dup' : r < 0.6 ? Math.floor(rnd() * 25) : 'deliver'; };
    for (let i = 0; i < 12; i++) { await world.devs.A.rep.appendLocal(V, lineSet(3, `n${i}`, i * 3)); await world.clock.advance(2_000); }
    world.hub.holdFilter = null;
    for (const n of ['A', 'B', 'C']) world.devs[n].carrier.passFilter = null;
    await world.elapse(180_000, 10_000);
    await vi.waitFor(async () => { for (const n of ['B', 'C']) expect((await world.heads(n, V)).lines).toBe(36); }, { timeout: 30_000 });
    await world.settle();
    await allSame(world, V, ['A', 'B', 'C']);
    for (const n of ['A', 'B', 'C']) expect(await world.devs[n].store.parkedList((await world.localOf(n, V)) as Buffer)).toEqual([]);
  });
});
export { line };
