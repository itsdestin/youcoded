// Independent review 2 (2026-11-26): every repro that can be written against the reviewed API is here first, and fails on dac35c342.
// (The tests of the NEW API surface, such as expected-head appends and rooted ids, are added further down this file with the fixes.)
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repWorld, wireId, lineSet, CHAT, type World } from './replicator-world';

let w: World | null = null;
afterEach(async () => { await w?.stopAll(); w?.cleanup(); w = null; });

const st = async (world: World, n: string, v: Buffer): Promise<string> => { const s = await world.devs[n].rep.status(v); return `${s.state}${s.reason ? `(${s.reason})` : ''}`; };
const headOf = async (world: World, n: string, v: Buffer) => world.devs[n].store.head(await world.local(n, v));
/** Copy folders of one device (`store`, `replicator`, `witness`) aside, and put them back later. */
const snap = (world: World, n: string, ks: string[], to: string): void => { fs.rmSync(to, { recursive: true, force: true }); fs.mkdirSync(to, { recursive: true }); for (const k of ks) if (fs.existsSync(nodePath.join(world.dirs[n], k))) fs.cpSync(nodePath.join(world.dirs[n], k), nodePath.join(to, k), { recursive: true }); };
const restore = (world: World, n: string, ks: string[], from: string): void => {
  for (const k of ks) { fs.rmSync(nodePath.join(world.dirs[n], k), { recursive: true, force: true }); if (fs.existsSync(nodePath.join(from, k))) fs.cpSync(nodePath.join(from, k), nodePath.join(world.dirs[n], k), { recursive: true }); }
  const lp = nodePath.join(world.dirs[n], 'store', 'LOCK'); if (fs.existsSync(lp)) fs.writeFileSync(lp, JSON.stringify({ ...JSON.parse(fs.readFileSync(lp, 'utf8')), pid: 2147483646, start: 'dead' }));
};
const down = async (world: World, n: string): Promise<void> => { await world.devs[n].rep.idle(); world.devs[n].rep.stop(); world.devs[n].link.stop(); await world.devs[n].store.close(); };

/** A writes 5, backs up its folders, writes 5 more (B holds 10), then A goes down and `what` is put back from the backup; B is unreachable while A comes back and appends at once. */
async function restoredWriter(what: string[], tweak?: (world: World) => void): Promise<{ world: World; V: Buffer; result: string }> {
  const world = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); w = world;
  const V = wireId(`r2-${what.join('+')}-${Math.random()}`);
  await world.create('A', V); await world.devs.A.rep.appendLocal(V, lineSet(5, 'old')); await world.settle();
  snap(world, 'A', ['store', 'replicator', 'witness'], nodePath.join(world.dirs.A, '..', `bk-${nodePath.basename(world.dirs.A)}`));
  await world.devs.A.rep.appendLocal(V, lineSet(5, 'mid', 5)); await world.settle();
  await down(world, 'A');
  restore(world, 'A', what, nodePath.join(world.dirs.A, '..', `bk-${nodePath.basename(world.dirs.A)}`)); tweak?.(world);
  world.devs.B.carrier.passFilter = () => 'drop';
  await world.restart('A', { graceful: false });
  const result = await world.devs.A.rep.appendLocal(V, lineSet(1, 'NEW', 5)).then((x) => `accepted ${x.lines}`, (e) => `refused ${String(e)}`);
  world.devs.B.carrier.passFilter = null;
  return { world, V, result };
}

describe('F1: the writer never says "saved" for an append past a lost tail', () => {
  it('store AND replicator folder both put back (a restore of the mesh data), the peer unreachable: refused by name, nothing forks', async () => {
    const { world, V, result } = await restoredWriter(['store', 'replicator']);
    expect(result).toMatch(/refused .*writer-behind-own-signed-head/);
    await world.elapse(120_000, 10_000);
    expect((await headOf(world, 'B', V)).lines).toBe(10);
    expect(await st(world, 'A', V)).not.toMatch(/^faulted/);
    expect(await st(world, 'B', V)).not.toMatch(/^faulted/);
  });
  it('the own record cut short by rot while the store is rolled back: refused by name, never read as "no record"', async () => {
    const { result } = await restoredWriter(['store'], (world) => { const d = nodePath.join(world.dirs.A, 'replicator', 'own'); for (const f of fs.readdirSync(d)) { const p = nodePath.join(d, f); fs.writeFileSync(p, fs.readFileSync(p).subarray(0, 39)); } });
    expect(result).toMatch(/refused .*writer-/);
  });
  it('everything on the writer put back (store, replicator and witness) while a peer is reachable: the first seconds are a named wait, then a named refusal, then the lines come back and writing resumes', async () => {
    const world = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); w = world; const V = wireId('r2-whole');
    await world.create('A', V); await world.devs.A.rep.appendLocal(V, lineSet(5, 'old')); await world.settle();
    const bk = nodePath.join(world.dirs.A, '..', 'bk-whole'); snap(world, 'A', ['store', 'replicator', 'witness'], bk);
    const ten = [...lineSet(5, 'old'), ...lineSet(5, 'mid', 5)]; void ten;
    await world.devs.A.rep.appendLocal(V, lineSet(5, 'mid', 5)); await world.settle();
    const keep = await world.readAll('B', V);
    await down(world, 'A'); restore(world, 'A', ['store', 'replicator', 'witness'], bk);
    await world.restart('A', { graceful: false });
    const first = await world.devs.A.rep.appendLocal(V, lineSet(1, 'NEW', 5)).then(() => 'accepted', (e) => String(e));
    expect(first).toMatch(/writer-waiting-for-peers|writer-behind/);
    await world.settle();
    await world.elapse(60_000, 10_000);
    expect(await world.readAll('A', V)).toEqual(keep); // the lines came back from the peer first
    await world.devs.A.rep.appendLocal(V, lineSet(1, 'NEW', 10));
    await world.elapse(30_000, 10_000);
    expect((await headOf(world, 'B', V)).lines).toBe(11);
    expect(await st(world, 'B', V)).not.toMatch(/^faulted/);
  });
});

describe('F2: a device that knows its copy is damaged acknowledges only what it can vouch for', () => {
  it('B rotted at line 20, then the writer pushes 5 lines: A never lists B as holding 45 lines and never calls it in-sync at 45', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000, stallMs: 600_000 }); const world = w; const V = wireId('r2-ack');
    await world.create('A', V); await world.devs.A.rep.appendLocal(V, lineSet(40, 'base')); await world.settle();
    const bl = await world.local('B', V);
    await down(world, 'B');
    const body = nodePath.join(world.dirs.B, 'store', 'versions', bl.toString('hex'), 'body-0000000000000000.bin');
    const raw = fs.readFileSync(body); raw[Math.floor(raw.length / 2)] ^= 0xff; fs.writeFileSync(body, raw);
    await world.restart('B');
    await world.devs.B.rep.reportCorrupt(V);
    world.devs.B.carrier.passFilter = () => 'drop'; // B's own heads cannot reach A: only an ack (if any) could tell A anything
    await world.devs.A.rep.appendLocal(V, lineSet(5, 'push', 40)); await world.settle();
    const acks = world.devs.A.rep.peerAcks(V).filter((a) => a.holder === world.ids.B.deviceId.toString('hex'));
    expect(acks.every((a) => a.lines < 45)).toBe(true);
    expect(await st(world, 'A', V)).not.toBe('in-sync');
  });
});

describe('F3: lines a device holds but cannot sign for are recoverable and never a calm picture', () => {
  it('the writer and C lose lines 15..22, A holds them but its signed points are older: the writer takes its own lines back from A', async () => {
    w = await repWorld(['A', 'B', 'C'], { discoveryMs: 30_000 }); const world = w; const V = wireId('r2-strand');
    await world.create('B', V); await world.devs.B.rep.appendLocal(V, lineSet(15, 'a')); await world.settle(); await world.elapse(40_000, 10_000);
    for (const n of ['A', 'B', 'C']) snap(world, n, ['store', 'replicator', 'witness'], nodePath.join(world.dirs[n], '..', `bk-${nodePath.basename(world.dirs[n])}`));
    await world.devs.B.rep.appendLocal(V, lineSet(7, 'b', 15)); await world.settle(); await world.elapse(40_000, 10_000);
    const all = await world.readAll('A', V);
    for (const n of ['A', 'B', 'C']) await down(world, n);
    const bk = (n: string): string => nodePath.join(world.dirs[n], '..', `bk-${nodePath.basename(world.dirs[n])}`);
    restore(world, 'A', ['replicator'], bk('A'));
    restore(world, 'B', ['store'], bk('B'));
    restore(world, 'C', ['store', 'replicator'], bk('C'));
    for (const n of ['A', 'B', 'C']) await world.restart(n, { graceful: false });
    await world.elapse(400_000, 10_000);
    expect(await world.readAll('B', V)).toEqual(all);
    expect(await world.readAll('C', V)).toEqual(all);
  });
  it('a puller whose only candidate keeps answering "unavailable" ends in stuck(no-peer-can-serve), not in a calm comparing', async () => {
    w = await repWorld(['A', 'B', 'C'], { discoveryMs: 30_000, stallMs: 5_000 }); const world = w; const V = wireId('r2-stuck');
    await world.create('B', V); await world.devs.B.rep.appendLocal(V, lineSet(6)); await world.settle(); await world.elapse(40_000, 10_000);
    const bkA = nodePath.join(world.dirs.A, '..', 'bk-stuckA'); snap(world, 'A', ['replicator'], nodePath.join(bkA));
    await world.devs.B.rep.appendLocal(V, lineSet(4, 'b', 6)); await world.settle(); await world.elapse(40_000, 10_000);
    // C forgets everything; A keeps the lines but loses its newer signed points; the writer B is gone: A is the only device C can ask
    await down(world, 'A'); await down(world, 'C'); await down(world, 'B');
    restore(world, 'A', ['replicator'], bkA);
    fs.rmSync(nodePath.join(world.dirs.C, 'store'), { recursive: true, force: true }); fs.rmSync(nodePath.join(world.dirs.C, 'replicator'), { recursive: true, force: true });
    await world.restart('A', { graceful: false }); await world.restart('C', { graceful: false });
    world.devs.B.carrier.setOnline(false);
    await world.elapse(300_000, 10_000);
    await vi.waitFor(async () => expect(await st(world, 'C', V)).toBe('stuck(no-peer-can-serve)'));
  });
});

describe('F1(d): a replicator folder older than the store never lets a peer replace an endorsed copy', () => {
  it('B keeps its endorsed 6 lines (and names the fault) when its replicator folder is put back and a contradicting writer-signed history arrives', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r2-endorse');
    await world.create('A', V); await world.settle();
    const bk = nodePath.join(world.dirs.B, '..', 'bk-endorse'); snap(world, 'B', ['replicator'], bk);
    await world.devs.A.rep.appendLocal(V, lineSet(6, 'old')); await world.settle();
    const keep = await world.readAll('B', V);
    await down(world, 'B'); restore(world, 'B', ['replicator'], bk); await world.restart('B', { graceful: false });
    // the writer's key signs another history for the same id (it forked itself); delivered to B straight away
    const { headMessage, linesBody, KIND_LINES } = await import('../../src/main/mesh/replicator/wire');
    const { chainStep, defaultChainSeeds } = await import('../../src/main/mesh/store');
    const { signWith } = await import('../../src/main/mesh/crypto/identity');
    const { chatGroup } = await import('../../src/main/mesh/replicator/ctx');
    const other = lineSet(7, 'FORK'); const seed = defaultChainSeeds({ chatId: CHAT, version: new Uint8Array(), segment: 0 }).raw;
    const ch = other.reduce((h, l) => chainStep(h, l), seed);
    await world.devs.A.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, to: world.ids.B.deviceId, body: linesBody({ version: V, from: 0, lines: other, head: { lines: 7, hash: ch, sig: signWith(world.ids.A, headMessage(V, 7, ch)) } }) });
    await world.elapse(30_000, 10_000);
    expect(await world.readAll('B', V)).toEqual(keep);
    expect(await st(world, 'B', V)).toMatch(/^faulted/);
  });
});
