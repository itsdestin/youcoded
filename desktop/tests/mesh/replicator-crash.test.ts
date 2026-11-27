// Kill the process at every file operation of receiving, serving, forking and retiring, then reopen and check the two promises that matter:
//  1. what is on disk is a true prefix of the writer's history (never a different one), and never SHORTER than a line this device acknowledged;
//  2. the work simply resumes: after the restart every device ends with identical lines.
// Method of store/crash.test.ts: count the operations of one clean run, then for each k run again with a file system that dies at the k-th (the write does not happen, or only
// half of it lands). The normal suite samples every SAMPLE-th operation; MESH_REPLICATOR_CRASH_FULL=1 runs every one.
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repWorld, wireId, lineSet, CHAT, type World } from './replicator-world';
import { chatGroup } from '../../src/main/mesh/replicator/ctx';
import { FaultFs } from '../../src/main/mesh/store/fault-fs';
import { deriveForkId } from '../../src/main/mesh/store';
import { incarnationId } from '../../src/main/mesh/replicator/idmap';

const FULL = process.env.MESH_REPLICATOR_CRASH_FULL === '1';
const SAMPLE = FULL ? 1 : 9;
let w: World | null = null;
afterEach(async () => { await w?.stopAll(); w = null; });

/** `diverges`: the device deliberately STARTS with lines the writer never signed (the retire scenario), so "a true prefix of the writer's history" is only promised once it has been repaired. */
interface Scenario { /** devices left cut off after the kill until `after` has run */ keepOffline?: string[]; /** runs after the owner restarted and ran for a minute (the devices in `keepOffline` are still away) */ after?: (world: World) => Promise<void>; diverges?: boolean; name: string; names: string[]; owner: string; versions: Buffer[]; /** the first file operation (counted from the end of setup) at which a kill is meaningful for this scenario; set by `run` through its second argument */ fromOp?: number; run: (world: World, startKills: () => void) => Promise<void> }

/** `k` counts from the first operation AFTER the device was set up (`base`): a kill inside ChatStore.open is the store's own crash test's business. */
async function once(sc: Scenario, k: number, tear: boolean, base = 0): Promise<{ ops: number; base: number }> {
  const ffs = new FaultFs(k === 0 ? 0 : base + k, { tear });
  const world = await repWorld(sc.names, { fsFor: (n) => (n === sc.owner ? ffs : undefined), discoveryMs: 20_000, stallMs: 8_000 });
  w = world;
  // A kill makes every later file operation of the dead device throw. A store read that was already floating somewhere inside that device then rejects with nobody waiting (an unhandled rejection that is the
  // kill itself, not a finding): mark the dead device's head reads as handled; every caller that DOES wait still gets the rejection.
  { const st = world.devs[sc.owner].store; const orig = st.head.bind(st); st.head = ((v: Buffer) => { const p = orig(v); p.catch(() => undefined /* benign (test): the simulated kill */); return p; }) as typeof st.head; }
  // a killed process stops everything it was doing: the moment the simulated kill fires, the device's replicator and link stop too (nothing keeps running against a dead disk)
  const killWatch = setInterval(() => { if ((ffs as unknown as { crashed: boolean }).crashed) { clearInterval(killWatch); world.devs[sc.owner].rep.stop(); world.devs[sc.owner].link.stop(); } }, 1);
  const setupOps = ffs.ops;
  await sc.run(world, () => { sc.fromOp = ffs.ops - setupOps; }).catch(() => undefined /* benign (test): the owner dies mid-run by design; what matters is checked below */);
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
  // a device the scenario had cut off when the owner was killed is reachable again (the owner's restart is the only thing under test)
  for (const n of sc.names) if (!sc.keepOffline?.includes(n)) world.devs[n].carrier.setOnline(true);
  // 2. start it and let everything resume
  await dev.rep.start();
  await world.elapse(60_000, 10_000);
  if (sc.after) { await sc.after(world); for (const n of sc.names) world.devs[n].carrier.setOnline(true); await world.elapse(60_000, 10_000); }
  for (const v of sc.versions) {
    // a writer killed before its own announcement or its copy was ever saved has nothing of that version to check (the chat was never told "saved")
    if (!(await world.localOf(sc.owner, v))) {
      // the killed device has no copy of it: fine only if nobody has one (a version that was never made); a version that exists elsewhere but never reached the restarted device is a convergence failure
      const others = await Promise.all(sc.names.filter((n) => n !== sc.owner).map((n) => world.localOf(n, v)));
      if (others.every((x) => x === null)) continue;
      throw new Error(`${sc.name} k=${k} tear=${tear}: version ${v.toString('hex').slice(0, 6)} exists on another device but the restarted device never got it`);
    }
    await vi.waitFor(async () => { const hs = await Promise.all(sc.names.map((n) => world.heads(n, v))); for (const x of hs) expect(x, `${sc.name} k=${k} tear=${tear}`).toEqual(hs[0]); }, { timeout: 30_000 });
    const bytes = await Promise.all(sc.names.map((n) => world.readAll(n, v)));
    for (const b of bytes) expect(b).toEqual(bytes[0]);
    const local = (await world.localOf(sc.owner, v)) as Buffer;
    expect((await dev.store.verify(local)).ok).toBe(true);
  }
  clearInterval(killWatch);
  await world.stopAll(); w = null;
  return { ops, base: setupOps };
}

async function sweep(sc: Scenario): Promise<void> {
  const clean = await once(sc, 0, false);
  expect(clean.ops).toBeGreaterThan(5);
  let runs = 0;
  for (let k = Math.max(1, sc.fromOp ?? 1) + (SAMPLE > 1 ? 3 : 0); k <= clean.ops; k += SAMPLE) for (const tear of [false, true]) { await once(sc, k, tear, clean.base); runs++; }
  expect(runs).toBeGreaterThan(5);
}

const V = wireId('crash');
describe('a kill at any file operation', () => {
  it('while RECEIVING lines (the store and the signed-head file): a true prefix, nothing acknowledged is lost, and it resumes', async () => {
    await sweep({ name: 'receive', names: ['A', 'B'], owner: 'B', versions: [V], run: async (world) => {
      await world.create('A', V);
      await world.append('A', V, lineSet(4)); await world.append('A', V, lineSet(4, 'x', 4));
      await world.settle();
    } });
  }, 900_000);
  it('while SERVING (a non-writer holding signed points answers a third device when the writer is away)', async () => {
    await sweep({ name: 'serve', names: ['A', 'B', 'C'], owner: 'C', versions: [V], run: async (world) => {
      await world.create('A', V);
      await world.settle();
      world.devs.B.carrier.setOnline(false);
      await world.append('A', V, lineSet(6));
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
      await world.append('A', V, lineSet(6));
      await world.settle();
      const hash = (await world.devs.B.store.hashAt(await world.local('B', V), 0, 6)) as string;
      child = deriveForkId(V, 6, hash, 'crash-entry');
      await world.devs.B.rep.createVersion({ version: child, chatId: CHAT, runtime: 'claude-code', parent: V, forkLine: 6, forkHash: Buffer.from(hash, 'hex'), token: 'crash-entry' });
      await world.append('B', child, lineSet(3, 'b', 6));
      await world.settle();
    } };
    // the child id depends only on the (deterministic) parent chain, so it can be named before the run: compute it once from a clean A
    const probe = await repWorld(['A']); const pv = wireId('crash');
    await probe.create('A', pv); await probe.append('A', pv, lineSet(6));
    child = deriveForkId(pv, 6, (await probe.devs.A.store.hashAt(await probe.local('A', pv), 0, 6)) as string, 'crash-entry');
    await probe.stopAll();
    sc.versions = [V, child];
    await sweep(sc);
  }, 900_000);
  it('while RETIRING a damaged copy and recopying it under a new id', async () => {
    // (review 2, finding 5: this used to append FOREIGN lines to B's store. Lines no writer signature covers are now kept under a named fault, never set aside on a guess, so the retire path is driven by what really
    // happens: B holds the writer's lines, a byte rots, B finds it, sets the copy aside and recopies.)
    await sweep({ diverges: true, name: 'retire', names: ['A', 'B'], owner: 'B', versions: [V], run: async (world) => {
      await world.create('A', V);
      await world.append('A', V, lineSet(5, 'real'));
      await world.settle();
      { const dir = nodePath.join(world.dirs.B, 'store', 'versions', incarnationId(V, 0).toString('hex')); const f = fs.existsSync(dir) ? fs.readdirSync(dir).find((x) => /^body-.*\.bin$/.test(x)) : undefined; if (f) { const pp = nodePath.join(dir, f); const raw = fs.readFileSync(pp); if (raw.length) { raw[Math.floor(raw.length / 2)] ^= 0xff; fs.writeFileSync(pp, raw); } } }
      await world.devs.B.rep.reportCorrupt(V).catch(() => undefined /* benign (test): the kill may land inside this call */);
      await world.append('A', V, lineSet(2, 'more', 5));
      await world.settle();
    } });
  }, 900_000);
  it('while the WRITER moves its newer lines into a second version (the self-fork) and the peer resolves', async () => {
    // B holds one history signed by A; A, cut off from B, signs another for the same positions; when they meet, A moves its lines to a second version. A is killed at every file operation of that, and B's side is
    // swept by the other scenarios' restarts. After the restart both versions must be complete and equal on both devices.
    const versions: Buffer[] = [V];
    await sweep({ diverges: true, name: 'selffork', names: ['A', 'B'], owner: 'A', versions, run: async (world) => {
      versions.splice(1); // each run starts with only the chat itself
      await world.create('A', V); await world.settle();
      const { selfForkToken } = await import('../../src/main/mesh/replicator/selffork');
      const { splitHistories } = await import('./selffork-helpers');
      await splitHistories(world, V, (id) => versions.push(id), selfForkToken);
    } });
  }, 1_800_000);
  it('while the PEER resolves a self-fork (the peer is the killed device: the second version, then setting its own copy aside and refilling)', async () => {
    const versions: Buffer[] = [V];
    await sweep({ diverges: true, name: 'selffork-peer', names: ['A', 'B'], owner: 'B', versions, run: async (world, startKills) => {
      versions.splice(1);
      await world.create('A', V); await world.settle();
      const { selfForkToken } = await import('../../src/main/mesh/replicator/selffork');
      const { headMessage, linesBody, KIND_LINES } = await import('../../src/main/mesh/replicator/wire');
      const { chainStep, defaultChainSeeds, deriveForkId } = await import('../../src/main/mesh/store');
      const { signWith } = await import('../../src/main/mesh/crypto/identity');
      // B takes a history that A signed (A's replicator is stopped meanwhile, so it cannot pull it from B)
      world.devs.A.rep.stop();
      const y = lineSet(5, 'yy'); const ch = y.reduce((h, l) => chainStep(h, l), defaultChainSeeds({ chatId: CHAT, version: new Uint8Array(), segment: 0 }).raw);
      await world.devs.A.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, to: world.ids.B.deviceId, body: linesBody({ version: V, from: 0, lines: y, head: { lines: 5, hash: ch, sig: signWith(world.ids.A, headMessage(V, 5, ch)) } }) });
      await world.settle();
      // (kills start HERE: a kill while B is still taking in the history the writer signed earlier is a different fault, a lost copy of lines nobody else holds, and is outside what this sweep studies)
      startKills();
      world.devs.B.carrier.setOnline(false);
      await world.restart('A'); await world.elapse(8_000, 1_000, true);
      await world.append('A', V, lineSet(5, 'xx'));
      const local = await world.local('A', V); const h0 = (await world.devs.A.store.hashAt(local, 0, 0)) as string; const hd = await world.devs.A.store.head(local);
      versions.push(deriveForkId(V, 0, h0, selfForkToken(world.ids.A.deviceId, CHAT, hd.hash.slice(0, 8))));
      world.devs.B.carrier.setOnline(true);
      await world.elapse(120_000, 10_000, true);
    } });
  }, 1_800_000);
  it('at every file operation of the FIRST append of a chat with the peer away: the restarted writer needs no peer to go on, and everything agrees once the peer is back', async () => {
    const versions: Buffer[] = [V];
    await sweep({ name: 'first-append', names: ['A', 'B'], owner: 'A', versions, keepOffline: ['B'], run: async (world) => {
      world.devs.B.carrier.setOnline(false);
      await world.create('A', V); await world.elapse(8_000, 1_000, true);
      await world.append('A', V, lineSet(3, 'first'));
    }, after: async (world) => {
      await world.elapse(8_000, 1_000, true);
      const local = await world.localOf('A', V);
      if (local) { const h = await world.devs.A.store.head(local); await world.devs.A.rep.appendLocal(V, lineSet(1, 'again', h.lines), { lines: h.lines, hash: h.hash }); } // with B still away
    } });
  }, 1_800_000);
});
