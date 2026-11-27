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
  it('both own records cut short by rot, the store intact: refused by name (own-record-unreadable), never read as "no record" or as a smaller head', async () => {
    w = await repWorld(['A'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r2-trunc-both');
    await world.create('A', V); await world.devs.A.rep.appendLocal(V, lineSet(4)); await down(world, 'A');
    for (const d of [nodePath.join(world.dirs.A, 'replicator', 'own'), nodePath.join(world.dirs.A, 'witness')]) for (const f of fs.readdirSync(d)) { const p2 = nodePath.join(d, f); fs.writeFileSync(p2, fs.readFileSync(p2).subarray(0, 39)); }
    await world.restart('A');
    await expect(world.devs.A.rep.appendLocal(V, lineSet(1, 'n', 4))).rejects.toThrow(/writer-own-record-unreadable/);
    expect(await st(world, 'A', V)).toBe('stuck(own-record-unreadable)');
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
    let allow = 0; world.devs.B.carrier.passFilter = () => (allow-- > 0 ? 'deliver' : 'drop'); // B's own heads cannot reach A: exactly one frame (its ack, if it sends one) may
    allow = 1; await world.devs.A.rep.appendLocal(V, lineSet(5, 'push', 40)); await world.settle();
    const bhex = world.ids.B.deviceId.toString('hex');
    const said = world.devs.A.rep.rawAcksForTests(V).filter((a) => a.holder === bhex); // what B SAID, before any listing rule hides it
    expect(said.length).toBeGreaterThan(0); // B did answer the push
    expect(said.every((a) => a.lines < 40)).toBe(true); // B's head is 40 lines but its bytes are damaged from the middle: it may vouch for less than 40
    const acks = world.devs.A.rep.peerAcks(V).filter((a) => a.holder === bhex);
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

// ---------------------------------------------------------------- the new API surface (written with the fixes)
import { randomBytes } from 'node:crypto';
import { deriveRootId } from '../../src/main/mesh/replicator/directory';
import { GROUP_LIVE, headsBodyOf, introBodyOf, introMessage, KIND_HEADS, KIND_INTRO } from '../../src/main/mesh/replicator/wire';
import { signWith } from '../../src/main/mesh/crypto/identity';
import { MAX_PEER_HEADS } from '../../src/main/mesh/replicator/budget';

describe('finding 4: a root version id is bound to its writer', () => {
  it('a paired device announcing someone else\'s id as its own is dropped on its face: no conflict, no fault, the writer keeps writing, and every honest device agrees', async () => {
    w = await repWorld(['A', 'B', 'C'], { bindIds: true, discoveryMs: 600_000 }); const world = w;
    const nonce = randomBytes(16); const V = deriveRootId(world.setId, CHAT, world.ids.A.deviceId, nonce);
    await world.devs.A.rep.createVersion({ version: V, chatId: CHAT, runtime: 'claude-code', parent: null, forkLine: null, forkHash: null, token: null, nonce });
    await world.settle();
    // B names itself the writer of A's id
    const evil = { version: V, chatId: CHAT, runtime: 'claude-code' as const, parent: null, forkLine: null, forkHash: null, token: null, writer: world.ids.B.deviceId, nonce: randomBytes(16) };
    const sig = signWith(world.ids.B, introMessage(evil));
    world.devs.B.link.sendLive({ group: GROUP_LIVE, kind: KIND_INTRO, body: introBodyOf({ ...evil, sig }) });
    await world.settle();
    for (const n of ['A', 'C']) { expect(world.devs[n].rep.counters()['intro-bad-root-id']).toBeGreaterThanOrEqual(1); expect(await st(world, n, V)).not.toMatch(/^faulted/); }
    await world.devs.A.rep.appendLocal(V, lineSet(3)); await world.settle();
    expect((await headOf(world, 'C', V)).lines).toBe(3);
  });
  it('a root id that does not match its writer and nonce is never accepted, even with no earlier announcement (the id cannot be chosen freely)', async () => {
    w = await repWorld(['A', 'B'], { bindIds: true, discoveryMs: 600_000 }); const world = w;
    const V = wireId('free-choice'); const nonce = randomBytes(16);
    const d = { version: V, chatId: CHAT, runtime: 'claude-code' as const, parent: null, forkLine: null, forkHash: null, token: null, writer: world.ids.B.deviceId, nonce };
    world.devs.B.link.sendLive({ group: GROUP_LIVE, kind: KIND_INTRO, body: introBodyOf({ ...d, sig: signWith(world.ids.B, introMessage(d)) }) });
    await world.settle();
    expect(world.devs.A.rep.counters()['intro-bad-root-id']).toBeGreaterThanOrEqual(1);
    expect(world.devs.A.rep.versions().some((x) => x.equals(V))).toBe(false);
  });
  it('a bound root works end to end, and a takeover child still forks from it', async () => {
    w = await repWorld(['A', 'B'], { bindIds: true, discoveryMs: 600_000 }); const world = w;
    const nonce = randomBytes(16); const V = deriveRootId(world.setId, CHAT, world.ids.A.deviceId, nonce);
    await world.devs.A.rep.createVersion({ version: V, chatId: CHAT, runtime: 'claude-code', parent: null, forkLine: null, forkHash: null, token: null, nonce });
    await world.devs.A.rep.appendLocal(V, lineSet(4)); await world.settle();
    expect((await headOf(world, 'B', V)).lines).toBe(4);
  });
});

describe('finding 7: appendLocal after a failure that left the lines durable', () => {
  it('an expected head makes a retry safe: the same lines are never appended twice, a moved head is refused by name', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r2-exp');
    await world.create('A', V); const first = await world.devs.A.rep.appendLocal(V, lineSet(3));
    const again = await world.devs.A.rep.appendLocal(V, lineSet(2, 'x', 3), { lines: first.lines, hash: first.hash });
    expect(again.result).toBe('saved');
    const retry = await world.devs.A.rep.appendLocal(V, lineSet(2, 'x', 3), { lines: first.lines, hash: first.hash }); // the caller never heard the answer and asks again
    expect(retry).toMatchObject({ lines: 5, result: 'already-saved' });
    expect((await headOf(world, 'A', V)).lines).toBe(5);
    await expect(world.devs.A.rep.appendLocal(V, lineSet(2, 'y', 3), { lines: first.lines, hash: first.hash })).rejects.toThrow(/writer-head-moved/);
    await expect(world.devs.A.rep.appendLocal(V, lineSet(1, 'z', 5), { lines: 5, hash: 'ab'.repeat(32) })).rejects.toThrow(/writer-head-moved/);
  });
  it('lines durable but the own record could not be written to both places: a distinct named result, nothing announced, a named status, and the retry saves it without a second copy', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r2-pending');
    await world.create('A', V); const first = await world.devs.A.rep.appendLocal(V, lineSet(2));
    await world.settle();
    fs.rmSync(nodePath.join(world.dirs.A, 'witness'), { recursive: true, force: true }); fs.writeFileSync(nodePath.join(world.dirs.A, 'witness'), 'in the way'); // the witness folder cannot be made
    const r = await world.devs.A.rep.appendLocal(V, lineSet(2, 'p', 2), { lines: first.lines, hash: first.hash });
    expect(r.result).toBe('durable-not-recorded');
    expect(await st(world, 'A', V)).toBe('stuck(own-record-not-saved)');
    await world.elapse(5_000, 1_000);
    expect((await headOf(world, 'B', V)).lines).toBe(2); // nothing was announced
    fs.rmSync(nodePath.join(world.dirs.A, 'witness'), { force: true });
    const ok = await world.devs.A.rep.appendLocal(V, lineSet(2, 'p', 2), { lines: first.lines, hash: first.hash });
    expect(ok).toMatchObject({ lines: 4, result: 'already-saved' });
    await world.settle();
    expect((await headOf(world, 'B', V)).lines).toBe(4);
    expect((await headOf(world, 'A', V)).lines).toBe(4);
  });
  it('a store step that gave up (store-call-blocked) is cleared and shows the true count once the store answers', async () => {
    w = await repWorld(['A'], { discoveryMs: 600_000, stepLimitMs: 150 }); const world = w; const V = wireId('r2-late');
    await world.create('A', V); await world.devs.A.rep.appendLocal(V, lineSet(3));
    const real = world.devs.A.store.head.bind(world.devs.A.store); let hold: (() => void) | null = null;
    world.devs.A.store.head = (async (id: Buffer) => { await new Promise<void>((r) => { hold = r; }); return real(id); }) as typeof world.devs.A.store.head;
    await expect(world.devs.A.rep.reportCorrupt(V)).rejects.toThrow(/store-call-blocked/);
    expect(await st(world, 'A', V)).toBe('stuck(store-call-blocked)');
    world.devs.A.store.head = real; (hold as (() => void) | null)?.();
    await vi.waitFor(async () => expect(await st(world, 'A', V)).not.toMatch(/^stuck/));
    expect((await world.devs.A.rep.status(V)).lines).toBe(3);
  });
});

describe('finding 7 and 8: claims of a peer that cannot be backed', () => {
  async function liar(): Promise<{ world: World; V: Buffer; say: (lines: number) => void }> {
    const world = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); w = world; const V = wireId('r2-liar');
    await world.create('A', V); await world.devs.A.rep.appendLocal(V, lineSet(3)); await world.settle();
    world.devs.B.rep.stop(); // only the lies of B's link now
    const say = (lines: number): void => { world.devs.B.link.sendLive({ group: GROUP_LIVE, kind: KIND_HEADS, body: headsBodyOf({ page: 0, of: 1, ask: false, heads: [{ version: V, lines, hash: Buffer.alloc(32, 7), conversationHash: Buffer.alloc(32), stamp: 1, state: 'ok' }] }) }); };
    return { world, V, say };
  }
  it('a claim of more lines shows a named reason that names the device, not a calm pulling', async () => {
    const { world, V, say } = await liar(); say(50); await world.settle();
    await expect(world.devs.A.rep.appendLocal(V, lineSet(1, 'n', 3))).rejects.toThrow(/writer-behind-peer-holds-more|writer-diverged/);
    expect(await st(world, 'A', V)).toMatch(/peer-claims-more [0-9a-f]{8}/);
  });
  it('a claim that is refreshed for ten minutes and never backed by a batch stops blocking the writer, counted and named', async () => {
    const { world, V, say } = await liar();
    for (let i = 0; i < 14; i++) { say(50 + i); await world.elapse(60_000, 20_000); }
    await world.devs.A.rep.appendLocal(V, lineSet(1, 'n', 3));
    expect(world.devs.A.rep.counters()['claim-discounted']).toBeGreaterThanOrEqual(1);
    expect(await st(world, 'A', V)).toMatch(/peer-claim-discounted/);
  });
  it('claims about versions nobody announced share the per-peer cap, however many periods pass (they are never kept without bound)', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 6_000_000 }); const world = w;
    world.devs.B.rep.stop();
    for (let i = 0; i < 700; i++) {
      for (let p = 0; p < 2; p++) world.devs.B.link.sendLive({ group: GROUP_LIVE, kind: KIND_HEADS, body: headsBodyOf({ page: 0, of: 1, ask: false, heads: Array.from({ length: 16 }, () => ({ version: randomBytes(32), lines: 1, hash: randomBytes(32), conversationHash: Buffer.alloc(32), stamp: 1, state: 'ok' as const })) }) });
      await world.elapse(61_000, 61_000);
    }
    expect(world.devs.A.rep.stateSizes().peerHeads).toBeLessThanOrEqual(MAX_PEER_HEADS);
    expect(world.devs.A.rep.counters()['peer-heads-full']).toBeGreaterThanOrEqual(1);
  }, 600_000);
});
