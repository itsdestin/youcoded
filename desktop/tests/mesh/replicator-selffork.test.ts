// The self-fork (src/main/mesh/replicator/selffork.ts): a writer that signed two histories moves its newer lines into a second version; nothing is lost anywhere and nobody waits for a person.
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repWorld, wireId, lineSet, CHAT, type World } from './replicator-world';
import { deriveForkId } from '../../src/main/mesh/store';
import { isSelfForkToken, selfForkToken } from '../../src/main/mesh/replicator/selffork';
import { GROUP_LIVE, introBodyOf, introMessage, KIND_INTRO } from '../../src/main/mesh/replicator/wire';
import { splitHistories } from './selffork-helpers';
import { signWith } from '../../src/main/mesh/crypto/identity';

let w: World | null = null;
afterEach(async () => { await w?.stopAll(); w?.cleanup(); w = null; });
const st = async (world: World, n: string, v: Buffer): Promise<string> => { const s = await world.devs[n].rep.status(v); return `${s.state}${s.reason ? `(${s.reason})` : ''}`; };
const down = async (world: World, n: string): Promise<void> => { await world.devs[n].rep.idle(); world.devs[n].rep.stop(); world.devs[n].link.stop(); await world.devs[n].store.close(); };
const KS = ['store', 'replicator', 'witness'];
const snap = (world: World, n: string, to: string): void => { fs.rmSync(to, { recursive: true, force: true }); fs.mkdirSync(to, { recursive: true }); for (const k of KS) if (fs.existsSync(nodePath.join(world.dirs[n], k))) fs.cpSync(nodePath.join(world.dirs[n], k), nodePath.join(to, k), { recursive: true }); };
const restore = (world: World, n: string, from: string): void => {
  for (const k of KS) { fs.rmSync(nodePath.join(world.dirs[n], k), { recursive: true, force: true }); if (fs.existsSync(nodePath.join(from, k))) fs.cpSync(nodePath.join(from, k), nodePath.join(world.dirs[n], k), { recursive: true }); }
  const lp = nodePath.join(world.dirs[n], 'store', 'LOCK'); if (fs.existsSync(lp)) fs.writeFileSync(lp, JSON.stringify({ ...JSON.parse(fs.readFileSync(lp, 'utf8')), pid: 2147483646, start: 'dead' }));
};
const v2Of = async (world: World, V: Buffer, p: number): Promise<Buffer> => {
  const h = await world.devs.A.store.hashAt(await world.local('A', V), 0, p);
  return deriveForkId(V, p, h as string, selfForkToken(world.ids.A.deviceId, CHAT, 'unused'));
};


describe('a writer restored from a backup that chats before it hears the others', () => {
  it('both histories are kept: the peers\' history stays under the chat, the newer lines move to a second version, every device ends in sync and nothing is lost', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('sf-basic');
    await world.create('A', V); await world.append('A', V, lineSet(5, 'old')); await world.settle();
    const bk = nodePath.join(world.dirs.A, '..', 'bk-sf-basic'); snap(world, 'A', bk);
    await world.append('A', V, lineSet(5, 'mid', 5)); await world.settle();
    const peers = await world.readAll('B', V); // the ten lines the user was told "saved" for
    await down(world, 'A'); restore(world, 'A', bk);
    world.devs.B.carrier.setOnline(false);
    await world.restart('A'); await world.elapse(8_000, 1_000, true);
    const told = await world.append('A', V, lineSet(3, 'NEW', 5)); // the restored writer chats alone
    expect(told.result).toBe('saved');
    world.devs.B.carrier.setOnline(true);
    await world.elapse(180_000, 10_000, true);
    const V2 = await v2Of(world, V, 5).catch(() => null);
    const moved = world.devs.A.rep.selfForks();
    expect(moved).toHaveLength(1); expect(moved[0].from).toBe(5);
    const v2 = moved[0].movedTo; void V2;
    for (const n of ['A', 'B']) {
      expect(await world.readAll(n, V)).toEqual(peers);                       // V is the history the peers hold
      expect(await st(world, n, V)).not.toMatch(/faulted|diverged/);
      expect((await world.readAll(n, v2)).length).toBe(8);                    // V2 = the shared first five + the three newer lines
    }
    expect(await world.readAll('A', v2)).toEqual(await world.readAll('B', v2));
    expect((await world.readAll('A', v2)).slice(5).map(String)).toEqual(lineSet(3, 'NEW', 5).map(String));
    for (const n of ['A', 'B']) expect(['in-sync', 'comparing']).toContain((await world.devs[n].rep.status(V)).state);
    expect(await st(world, 'A', v2)).toMatch(/^in-sync/); expect(await st(world, 'B', v2)).toMatch(/^in-sync/);
    // the writer goes on writing to both
    expect((await world.append('A', V, lineSet(1, 'again', 10))).result).toBe('saved');
    expect((await world.append('A', v2, lineSet(1, 'again2', 8))).result).toBe('saved');
  }, 300_000);

  it('a device that held ONLY the newer lines gives them up under the chat once they live, verified, in the second version', async () => {
    w = await repWorld(['A', 'B', 'C'], { discoveryMs: 600_000 }); const world = w; const V = wireId('sf-three');
    await world.create('A', V); await world.append('A', V, lineSet(5, 'old')); await world.settle();
    const bkA = nodePath.join(world.dirs.A, '..', 'bk-sf3A'); const bkC = nodePath.join(world.dirs.C, '..', 'bk-sf3C'); snap(world, 'A', bkA); snap(world, 'C', bkC);
    await world.append('A', V, lineSet(5, 'mid', 5)); await world.settle();
    const peers = await world.readAll('B', V);
    for (const n of ['A', 'C']) await down(world, n);
    restore(world, 'A', bkA); restore(world, 'C', bkC);
    world.devs.B.carrier.setOnline(false);
    await world.restart('A'); await world.restart('C'); await world.elapse(8_000, 1_000, true);
    expect((await world.append('A', V, lineSet(3, 'NEW', 5))).result).toBe('saved'); // C holds only the first five, so it hears A's newer lines
    await world.elapse(20_000, 5_000, true);
    expect((await world.readAll('C', V)).length).toBe(8);
    world.devs.B.carrier.setOnline(true);
    await world.elapse(300_000, 10_000, true);
    const v2 = world.devs.A.rep.selfForks()[0]?.movedTo; expect(v2).toBeTruthy();
    for (const n of ['A', 'B', 'C']) {
      expect(await world.readAll(n, V)).toEqual(peers);
      expect((await world.readAll(n, v2)).length).toBe(8);
      expect(await st(world, n, V)).not.toMatch(/faulted|diverged/);
    }
  }, 400_000);

  it('a copy that the writer contradicts keeps its lines and a named, not calm, state until the writer says where the other lines went', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('sf-wait');
    await world.create('A', V); await world.append('A', V, lineSet(6)); await world.settle();
    world.devs.A.rep.stop(); // the writer does not come back
    const keep = await world.readAll('B', V);
    const { headMessage, linesBody, KIND_LINES } = await import('../../src/main/mesh/replicator/wire');
    const { chainStep, defaultChainSeeds } = await import('../../src/main/mesh/store');
    const { chatGroup } = await import('../../src/main/mesh/replicator/ctx');
    const other = lineSet(5, 'FORK'); const ch = other.reduce((h, l) => chainStep(h, l), defaultChainSeeds({ chatId: CHAT, version: new Uint8Array(), segment: 0 }).raw);
    await world.devs.A.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, to: world.ids.B.deviceId, body: linesBody({ version: V, from: 0, lines: other, head: { lines: 5, hash: ch, sig: signWith(world.ids.A, headMessage(V, 5, ch)) } }) });
    await vi.waitFor(async () => expect(await st(world, 'B', V)).toMatch(/^diverged\(writer-two-histories/));
    await world.elapse(120_000, 20_000);
    expect(await world.readAll('B', V)).toEqual(keep);
    expect(await st(world, 'B', V)).toMatch(/waiting for the writer/);
  });

  it('a paired device cannot resolve that state with a self-fork look-alike: only the version\'s own writer\'s announcement counts', async () => {
    w = await repWorld(['A', 'B', 'C'], { discoveryMs: 600_000, bound: true }); const world = w;
    const { deriveRootId } = await import('../../src/main/mesh/replicator/directory');
    const nonce = randomBytes(16); const V = deriveRootId(world.setId, CHAT, world.ids.A.deviceId, nonce);
    await world.devs.A.rep.createVersion({ version: V, chatId: CHAT, runtime: 'claude-code', parent: null, forkLine: null, forkHash: null, token: null, nonce });
    await world.append('A', V, lineSet(6)); await world.settle();
    const bHead = await world.devs.B.store.head(await world.local('B', V));
    // B is put into the contradicted state by the real writer's own signature on another history (as in the test above), delivered by A's link
    world.devs.A.rep.stop();
    const { headMessage, linesBody, KIND_LINES } = await import('../../src/main/mesh/replicator/wire');
    const { chainStep, defaultChainSeeds } = await import('../../src/main/mesh/store');
    const { chatGroup } = await import('../../src/main/mesh/replicator/ctx');
    const other = lineSet(5, 'FORK'); const ch = other.reduce((h, l) => chainStep(h, l), defaultChainSeeds({ chatId: CHAT, version: new Uint8Array(), segment: 0 }).raw);
    await world.devs.A.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, to: world.ids.B.deviceId, body: linesBody({ version: V, from: 0, lines: other, head: { lines: 5, hash: ch, sig: signWith(world.ids.A, headMessage(V, 5, ch)) } }) });
    await vi.waitFor(async () => expect(await st(world, 'B', V)).toMatch(/^diverged\(writer-two-histories/));
    // C announces a fork of V at 0 with a self-fork-looking token, signed by C
    const token = selfForkToken(world.ids.C.deviceId, CHAT); const child = deriveForkId(V, 0, (await world.devs.B.store.hashAt(await world.local('B', V), 0, 0)) as string, token);
    const d = { version: child, chatId: CHAT, runtime: 'claude-code' as const, parent: V, forkLine: 0, forkHash: Buffer.from((await world.devs.B.store.hashAt(await world.local('B', V), 0, 0)) as string, 'hex'), token, writer: world.ids.C.deviceId, nonce: null };
    world.devs.C.link.sendLive({ group: GROUP_LIVE, kind: KIND_INTRO, body: introBodyOf({ ...d, sig: signWith(world.ids.C, introMessage(d)) }) });
    // ... and C signs one different line for that child, so that comparing would tell B "you hold the older history" if it believed C
    const { headMessage: hm, linesBody: lb, KIND_LINES: KL } = await import('../../src/main/mesh/replicator/wire');
    const cl = lineSet(1, 'C-own'); const chC = chainStep(defaultChainSeeds({ chatId: CHAT, version: new Uint8Array(), segment: 0 }).raw, cl[0]);
    await world.devs.C.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KL, line: true, to: world.ids.B.deviceId, body: lb({ version: child, from: 0, lines: cl, head: { lines: 1, hash: chC, sig: signWith(world.ids.C, hm(child, 1, chC)) } }) });
    await world.elapse(60_000, 10_000);
    expect(await st(world, 'B', V)).toMatch(/^diverged\(writer-two-histories/); // still waiting for the WRITER
    expect((await world.devs.B.store.head(await world.local('B', V))).lines).toBe(bHead.lines);
  });

  it('a child announced with a token that does not start with its writer is dropped on its face', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000, bound: true }); const world = w;
    const { deriveRootId } = await import('../../src/main/mesh/replicator/directory');
    const nonce = randomBytes(16); const V = deriveRootId(world.setId, CHAT, world.ids.A.deviceId, nonce);
    await world.devs.A.rep.createVersion({ version: V, chatId: CHAT, runtime: 'claude-code', parent: null, forkLine: null, forkHash: null, token: null, nonce });
    await world.append('A', V, lineSet(3)); await world.settle();
    const h0 = (await world.devs.A.store.hashAt(await world.local('A', V), 0, 0)) as string; const token = 'plain-token-without-the-writer';
    const d = { version: deriveForkId(V, 0, h0, token), chatId: CHAT, runtime: 'claude-code' as const, parent: V, forkLine: 0, forkHash: Buffer.from(h0, 'hex'), token, writer: world.ids.A.deviceId, nonce: null };
    world.devs.A.link.sendLive({ group: GROUP_LIVE, kind: KIND_INTRO, body: introBodyOf({ ...d, sig: signWith(world.ids.A, introMessage(d)) }) });
    await world.settle();
    expect(world.devs.B.rep.counters()['intro-bad-token']).toBeGreaterThanOrEqual(1);
  });

  it('the token marks a self-fork only for its own writer and carries a domain word, so it cannot be mistaken for a takeover', () => {
    const a = Buffer.alloc(16, 1); const b = Buffer.alloc(16, 2);
    expect(isSelfForkToken(a, selfForkToken(a, 'chat-1'))).toBe(true);
    expect(isSelfForkToken(b, selfForkToken(a, 'chat-1'))).toBe(false);
    expect(isSelfForkToken(a, `${a.toString('hex')}:takeover:x`)).toBe(false);
    expect(selfForkToken(a, 'chat-1')).not.toBe(selfForkToken(a, 'chat-2'));
  });
});

describe('the same split, made on a stopped device (the shape the crash sweep drives)', () => {
  it('B holds a history A signed, A cut off from B signs another for the same positions: both versions complete and equal on both devices', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('sf-shape');
    await world.create('A', V); await world.settle();
    await splitHistories(world, V);
    const moved = world.devs.A.rep.selfForks(); expect(moved).toHaveLength(1);
    const v2 = moved[0].movedTo;
    for (const n of ['A', 'B']) { expect((await world.readAll(n, V)).length).toBe(5); expect((await world.readAll(n, v2)).length).toBe(5); }
    expect(await world.readAll('A', V)).toEqual(await world.readAll('B', V)); expect(await world.readAll('A', v2)).toEqual(await world.readAll('B', v2));
  }, 200_000);
});
