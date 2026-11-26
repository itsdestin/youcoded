// Kill the process at every file operation of receiving, serving, forking and retiring, then reopen and check the two promises that matter:
//  1. what is on disk is a true prefix of the writer's history (never a different one), and never SHORTER than a line this device acknowledged;
//  2. the work simply resumes: after the restart every device ends with identical lines.
// Method of store/crash.test.ts: count the operations of one clean run, then for each k run again with a file system that dies at the k-th (the write does not happen, or only
// half of it lands). The normal suite samples every SAMPLE-th operation; MESH_REPLICATOR_CRASH_FULL=1 runs every one.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repWorld, wireId, lineSet, CHAT, type World } from './replicator-world';
import { chatGroup } from '../../src/main/mesh/replicator/ctx';
import { FaultFs } from '../../src/main/mesh/store/fault-fs';
import { deriveForkId } from '../../src/main/mesh/store';

const FULL = process.env.MESH_REPLICATOR_CRASH_FULL === '1';
const SAMPLE = FULL ? 1 : 9;
let w: World | null = null;
afterEach(async () => { await w?.stopAll(); w = null; });

/** `diverges`: the device deliberately STARTS with lines the writer never signed (the retire scenario), so "a true prefix of the writer's history" is only promised once it has been repaired. */
interface Scenario { diverges?: boolean; name: string; names: string[]; owner: string; versions: Buffer[]; run: (world: World) => Promise<void> }

/** `k` counts from the first operation AFTER the device was set up (`base`): a kill inside ChatStore.open is the store's own crash test's business. */
async function once(sc: Scenario, k: number, tear: boolean, base = 0): Promise<{ ops: number; base: number }> {
  const ffs = new FaultFs(k === 0 ? 0 : base + k, { tear });
  const world = await repWorld(sc.names, { fsFor: (n) => (n === sc.owner ? ffs : undefined), discoveryMs: 20_000, stallMs: 8_000 });
  w = world;
  const setupOps = ffs.ops;
  await sc.run(world).catch(() => undefined /* benign (test): the owner dies mid-run by design; what matters is checked below */);
  const ops = ffs.ops - setupOps;
  // 1. restart the dead device over its folder with the real file system, WITHOUT starting it, and look at what it holds
  const dev = await world.restart(sc.owner, { graceful: false, start: false });
  const truth = world.devs.A;
  for (const v of sc.versions) {
    const local = await world.localOf(sc.owner, v);
    if (!local) continue; // died before it ever registered the version
    const h = await dev.store.head(local);
    const tl = (await world.localOf('A', v)) as Buffer;
    if (h.lines > 0 && sc.owner !== 'A' && !sc.diverges) expect(h.hash, `${sc.name} k=${k} tear=${tear}: head is a true prefix`).toBe(await truth.store.hashAt(tl, 0, h.lines).catch(() => null));
    if (sc.owner !== 'A') {
      const ack = truth.rep.peerAcks(v).find((a) => a.holder === world.ids[sc.owner].deviceId.toString('hex'));
      if (ack) expect(h.lines, `${sc.name} k=${k}: acknowledged lines are on disk`).toBeGreaterThanOrEqual(ack.lines);
    }
  }
  // 2. start it and let everything resume
  await dev.rep.start();
  await world.elapse(60_000, 10_000);
  for (const v of sc.versions) {
    await vi.waitFor(async () => { const hs = await Promise.all(sc.names.map((n) => world.heads(n, v))); for (const x of hs) expect(x, `${sc.name} k=${k} tear=${tear}`).toEqual(hs[0]); }, { timeout: 30_000 });
    const bytes = await Promise.all(sc.names.map((n) => world.readAll(n, v)));
    for (const b of bytes) expect(b).toEqual(bytes[0]);
    const local = (await world.localOf(sc.owner, v)) as Buffer;
    expect((await dev.store.verify(local)).ok).toBe(true);
  }
  await world.stopAll(); w = null;
  return { ops, base: setupOps };
}

async function sweep(sc: Scenario): Promise<void> {
  const clean = await once(sc, 0, false);
  expect(clean.ops).toBeGreaterThan(5);
  let runs = 0;
  for (let k = 1 + (SAMPLE > 1 ? 3 : 0); k <= clean.ops; k += SAMPLE) for (const tear of [false, true]) { await once(sc, k, tear, clean.base); runs++; }
  expect(runs).toBeGreaterThan(5);
}

const V = wireId('crash');
describe('a kill at any file operation', () => {
  it('while RECEIVING lines (the store and the signed-head file): a true prefix, nothing acknowledged is lost, and it resumes', async () => {
    await sweep({ name: 'receive', names: ['A', 'B'], owner: 'B', versions: [V], run: async (world) => {
      await world.create('A', V);
      await world.devs.A.rep.appendLocal(V, lineSet(4)); await world.devs.A.rep.appendLocal(V, lineSet(4, 'x', 4));
      await world.settle();
    } });
  }, 900_000);
  it('while SERVING (a non-writer holding signed points answers a third device when the writer is away)', async () => {
    await sweep({ name: 'serve', names: ['A', 'B', 'C'], owner: 'C', versions: [V], run: async (world) => {
      await world.create('A', V);
      await world.settle();
      world.devs.B.carrier.setOnline(false);
      await world.devs.A.rep.appendLocal(V, lineSet(6));
      await world.settle();
      world.hub.releaseThrough(chatGroup(world.setId, CHAT), 1_000_000);
      world.devs.A.carrier.setOnline(false);
      world.devs.B.carrier.setOnline(true);
      await world.elapse(30_000, 10_000);
      world.devs.A.carrier.setOnline(true);
    } });
  }, 900_000);
  it('while FORKING a takeover (the child is made from the parent on this device)', async () => {
    let child: Buffer = Buffer.alloc(0);
    const sc: Scenario = { name: 'fork', names: ['A', 'B', 'C'], owner: 'C', versions: [V], run: async (world) => {
      await world.create('A', V);
      await world.devs.A.rep.appendLocal(V, lineSet(6));
      await world.settle();
      const hash = (await world.devs.B.store.hashAt(V, 0, 6)) as string;
      child = deriveForkId(V, 6, hash, 'crash-entry');
      await world.devs.B.rep.createVersion({ version: child, chatId: CHAT, runtime: 'claude-code', parent: V, forkLine: 6, forkHash: Buffer.from(hash, 'hex'), token: 'crash-entry' });
      await world.devs.B.rep.appendLocal(child, lineSet(3, 'b', 6));
      await world.settle();
    } };
    // the child id depends only on the (deterministic) parent chain, so it can be named before the run: compute it once from a clean A
    const probe = await repWorld(['A']); const pv = wireId('crash');
    await probe.create('A', pv); await probe.devs.A.rep.appendLocal(pv, lineSet(6));
    child = deriveForkId(pv, 6, (await probe.devs.A.store.hashAt(pv, 0, 6)) as string, 'crash-entry');
    await probe.stopAll();
    sc.versions = [V, child];
    await sweep(sc);
  }, 900_000);
  it('while RETIRING a copy that contradicts the writer and recopying it under a new id', async () => {
    await sweep({ diverges: true, name: 'retire', names: ['A', 'B'], owner: 'B', versions: [V], run: async (world) => {
      await world.create('A', V);
      await world.settle();
      await world.devs.B.store.append(V, 0, 0, lineSet(5, 'other')).catch(() => undefined /* benign (test): the kill may land inside this very call; the writer's lines below must still be written */);
      await world.devs.A.rep.appendLocal(V, lineSet(7, 'real'));
      await world.settle();
    } });
  }, 900_000);
});
