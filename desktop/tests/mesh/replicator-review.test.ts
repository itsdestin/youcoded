// Independent review 1 (2026-11-26), every finding as a test that fails on the code the review found and passes on the fixed one.
// F1 writer history, F2 acks, F3 ids, F4 directory, F5 big lines, F6 bounds against a paired hostile device, F7 status, F8 blocked store, F9 scrub at rest.
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { repWorld, wireId, lineSet, line, CHAT, type World } from './replicator-world';
import { chatGroup } from '../../src/main/mesh/replicator/ctx';
import { incarnationId } from '../../src/main/mesh/replicator/idmap';
import { InterimDirectory } from '../../src/main/mesh/replicator/directory';
import { headMessage, headsBodyOf, introBodyOf, introMessage, KIND_HEADS, KIND_INTRO, KIND_LINES, KIND_NAK, KIND_SUM, KIND_WANT, linesBody, nakBodyOf, sumBody, wantBodyOf, PART_BYTES } from '../../src/main/mesh/replicator/wire';
import { chainStep, defaultChainSeeds } from '../../src/main/mesh/store';
import { signWith } from '../../src/main/mesh/crypto/identity';
import { realFs } from '../../src/main/mesh/store/fsio';
import { tmp } from './helpers';

let w: World | null = null;
afterEach(async () => { await w?.stopAll(); w?.cleanup(); w = null; });

const st = async (world: World, n: string, v: Buffer): Promise<string> => { const s = await world.devs[n].rep.status(v); return `${s.state}${s.reason ? `(${s.reason})` : ''}`; };
const headOf = async (world: World, n: string, v: Buffer) => { const l = (await world.localOf(n, v)) as Buffer; return world.devs[n].store.head(l); };
const seedOf = (chat: string): Buffer => defaultChainSeeds({ chatId: chat, version: new Uint8Array(), segment: 0 }).raw;
const chainOver = (chat: string, ls: Buffer[]): Buffer => ls.reduce((h, l) => chainStep(h, l), seedOf(chat));
/** A hostile paired device: on the roster, with a real link, but its replicator is silent. */
async function withHostile(names: string[], o: Parameters<typeof repWorld>[1] = {}): Promise<World> {
  const world = await repWorld([...names, 'M'], o); w = world;
  world.devs.M.rep.stop();
  return world;
}
const sendLive = (world: World, kind: string, body: unknown, to?: string): boolean => world.devs.M.link.sendLive({ group: 'rep.live', kind, body: body as never, ...(to ? { to: world.ids[to].deviceId } : {}) });
const intro = (world: World, who: string, v: Buffer, chat: string): unknown => { const b = { version: v, chatId: chat, runtime: 'claude-code' as const, parent: null, forkLine: null, forkHash: null, token: null, writer: world.ids[who].deviceId }; return introBodyOf({ ...b, sig: signWith(world.ids[who], introMessage(b)) }); };

describe('F1 the writer cannot replace its own history, and takes its own lines back', () => {
  it('a writer whose copy was set aside refuses appendLocal by name, takes its own signed lines back from a peer, and only then appends; no peer ever sets anything aside', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 20_000 }); const world = w; const V = wireId('f1a');
    await world.create('A', V);
    const six = lineSet(6); await world.devs.A.rep.appendLocal(V, six);
    await vi.waitFor(async () => expect((await headOf(world, 'B', V)).lines).toBe(6)); await world.settle();
    const la = (await world.localOf('A', V)) as Buffer;
    world.devs.A.carrier.passFilter = () => 'drop'; // A cannot hear its peers yet
    await world.devs.A.store.setAsideDamaged(la);
    await world.devs.A.rep.reportCorrupt(V);
    await expect(world.devs.A.rep.appendLocal(V, lineSet(1, 'new', 6))).rejects.toThrow(/writer-/); // a fresh incarnation that has not been refilled
    world.devs.A.carrier.passFilter = null;
    await world.elapse(120_000, 10_000);
    expect(await world.readAll('A', V)).toEqual(six); // its own signed lines came back
    expect(await st(world, 'A', V)).toBe('in-sync');
    await world.devs.A.rep.appendLocal(V, lineSet(2, 'next', 6));
    await vi.waitFor(async () => expect((await headOf(world, 'B', V)).lines).toBe(8));
    await world.settle();
    expect((await world.readAll('B', V)).slice(0, 6)).toEqual(six);
    expect(((await world.localOf('B', V)) as Buffer).equals(incarnationId(V, 0))).toBe(true); // B never set its copy aside
    expect(world.devs.B.rep.counters()['retired-recopy'] ?? 0).toBe(0);
  });
  it('a writer that restarted after its copy was set aside, with nobody to compare with yet, refuses appendLocal by name until a peer has confirmed it holds nothing more', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 20_000 }); const world = w; const V = wireId('f1f');
    await world.create('A', V); const six = lineSet(6); await world.devs.A.rep.appendLocal(V, six);
    await vi.waitFor(async () => expect((await headOf(world, 'B', V)).lines).toBe(6)); await world.settle();
    world.devs.B.carrier.setOnline(false);
    await world.devs.A.store.setAsideDamaged((await world.localOf('A', V)) as Buffer);
    await world.restart('A'); // a new process: it remembers no peer claim at all
    await expect(world.devs.A.rep.appendLocal(V, lineSet(1, 'new', 6))).rejects.toThrow(/writer-recopy-not-confirmed/);
    world.devs.B.carrier.setOnline(true);
    await world.elapse(120_000, 10_000);
    expect(await world.readAll('A', V)).toEqual(six);
    await world.devs.A.rep.appendLocal(V, lineSet(1, 'new', 6));
  });
  it('a writer whose whole store folder was put back refuses appendLocal while a peer holds more of its chain, recovers its lines, and then appends', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 20_000, stallMs: 10_000 }); const world = w; const V = wireId('f1b');
    await world.create('A', V);
    await world.devs.A.rep.appendLocal(V, lineSet(3)); await world.settle();
    await world.devs.A.rep.idle(); world.devs.A.rep.stop(); world.devs.A.link.stop(); await world.devs.A.store.close();
    const snap = nodePath.join(world.dirs.A, 'snap'); fs.cpSync(nodePath.join(world.dirs.A, 'store'), snap, { recursive: true });
    await world.restart('A'); await world.devs.A.rep.appendLocal(V, lineSet(3, 't', 3)); await world.settle();
    const six = await world.readAll('A', V);
    await world.devs.A.rep.idle(); world.devs.A.rep.stop(); world.devs.A.link.stop(); await world.devs.A.store.close();
    fs.rmSync(nodePath.join(world.dirs.A, 'store'), { recursive: true, force: true }); fs.cpSync(snap, nodePath.join(world.dirs.A, 'store'), { recursive: true });
    await world.restart('A');
    await world.elapse(60_000, 10_000); // peers have spoken: A now KNOWS it is behind
    expect(await world.readAll('A', V)).toEqual(six);
    await world.devs.A.rep.appendLocal(V, lineSet(2, 'after', 6));
    await world.elapse(60_000, 10_000);
    expect((await world.readAll('B', V)).slice(0, 6)).toEqual(six);
    expect((await headOf(world, 'B', V)).lines).toBe(8);
    expect(world.devs.B.rep.counters()['retired-recopy'] ?? 0).toBe(0);
  });
  it('appendLocal refuses by name while any fresh peer claim names more lines of my version than I hold (without any store report)', async () => {
    w = await withHostile(['A'], { discoveryMs: 600_000 }); const world = w; const V = wireId('f1c');
    await world.create('A', V); await world.devs.A.rep.appendLocal(V, lineSet(4)); await world.settle();
    sendLive(world, KIND_HEADS, headsBodyOf({ page: 0, of: 1, ask: false, heads: [{ version: V, lines: 9, hash: randomBytes(32), conversationHash: Buffer.alloc(32), stamp: 3, state: 'ok' }] }), 'A');
    await vi.waitFor(() => expect(world.devs.A.rep.peerView(V).some((p) => p.lines === 9)).toBe(true));
    await expect(world.devs.A.rep.appendLocal(V, lineSet(1, 'x', 4))).rejects.toThrow(/writer-behind/);
  });
  it('a writer-signed batch that contradicts lines a peer holds under an EARLIER writer signature is a writer fault: the peer keeps its copy, names the state, offers it, and the state survives later appends and a restart', async () => {
    w = await withHostile(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('f1d');
    await world.create('A', V);
    await world.devs.A.rep.appendLocal(V, lineSet(6));
    await vi.waitFor(async () => expect((await headOf(world, 'B', V)).lines).toBe(6)); await world.settle();
    const keep = await world.readAll('B', V);
    // the writer's key signs ANOTHER history for the same version id (a fork of itself); M carries it
    const other = lineSet(5, 'FORK', 0); const ch = chainOver(CHAT, other);
    await world.devs.M.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, to: world.ids.B.deviceId, body: linesBody({ version: V, from: 0, lines: other, head: { lines: 5, hash: ch, sig: signWith(world.ids.A, headMessage(V, 5, ch)) } }) });
    await vi.waitFor(async () => expect(await st(world, 'B', V)).toBe('faulted(writer-signed-two-histories)'));
    expect(await world.readAll('B', V)).toEqual(keep);
    expect(world.devs.B.rep.counters()['retired-recopy'] ?? 0).toBe(0);
    await world.devs.A.rep.appendLocal(V, lineSet(2, 'more', 6)); await world.elapse(30_000, 10_000);
    expect(await st(world, 'B', V)).toBe('faulted(writer-signed-two-histories)'); // not cleared by the next append
    expect(await world.readAll('B', V)).toEqual(keep);
    await world.restart('B'); await world.settle();
    expect(await st(world, 'B', V)).toBe('faulted(writer-signed-two-histories)'); // nor by a restart
  });
  it('a copy never endorsed by a writer signature that the writer contradicts is still set aside and recopied (damaged or foreign bytes are not a writer fault)', async () => {
    w = await repWorld(['A', 'B']); const world = w; const V = wireId('f1e');
    await world.create('A', V); await world.settle();
    const lb = (await world.localOf('B', V)) as Buffer;
    await world.devs.B.store.append(lb, 0, 0, lineSet(4, 'unsigned'));
    const good = lineSet(6, 'real'); await world.devs.A.rep.appendLocal(V, good);
    await vi.waitFor(async () => expect(await world.readAll('B', V)).toEqual(good));
    expect(world.devs.B.rep.counters()['retired-recopy']).toBe(1);
  });
});

describe('F2 an ack is a statement about a copy that still exists', () => {
  const ackOf = (world: World, holder: string, v: Buffer) => world.devs.A.rep.peerAcks(v).find((a) => a.holder === world.ids[holder].deviceId.toString('hex'));
  it('when the holder retires its copy and tells its peers at once, the ack disappears at once (not at the next hello)', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('f2a');
    await world.create('A', V); await world.devs.A.rep.appendLocal(V, lineSet(5));
    await vi.waitFor(() => expect(ackOf(world, 'B', V)?.lines).toBe(5)); await world.settle();
    world.hub.holdFilter = () => 'drop'; // B cannot refill, so only B SAYING what it holds can retract the ack
    await world.devs.B.store.setAsideDamaged((await world.localOf('B', V)) as Buffer);
    await world.devs.B.rep.reportCorrupt(V);
    await vi.waitFor(() => expect(ackOf(world, 'B', V)?.lines ?? 0).not.toBe(5));
  });
  it('a hello does not wipe acks: a quiet in-sync system still lists them, and after a restart they can be asked for again', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 20_000 }); const world = w; const V = wireId('f2b');
    await world.create('A', V); await world.devs.A.rep.appendLocal(V, lineSet(5));
    await vi.waitFor(() => expect(ackOf(world, 'B', V)?.lines).toBe(5));
    await world.elapse(100_000, 10_000);
    expect(ackOf(world, 'B', V)?.lines).toBe(5);
    await world.restart('A'); // A forgets everything in memory
    await world.elapse(30_000, 10_000);
    await world.devs.A.rep.solicitAcks(V); await world.settle();
    expect(ackOf(world, 'B', V)?.lines).toBe(5);
  });
  it('a holder whose folder was put back loses its ack as soon as it says what it now holds', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 20_000 }); const world = w; const V = wireId('f2c');
    await world.create('A', V); await world.devs.A.rep.appendLocal(V, lineSet(3)); await world.settle();
    await world.devs.B.rep.idle(); world.devs.B.rep.stop(); world.devs.B.link.stop(); await world.devs.B.store.close();
    const snap = nodePath.join(world.dirs.B, 'snap'); fs.cpSync(nodePath.join(world.dirs.B, 'store'), snap, { recursive: true });
    await world.restart('B'); await world.devs.A.rep.appendLocal(V, lineSet(3, 'x', 3));
    await vi.waitFor(() => expect(ackOf(world, 'B', V)?.lines).toBe(6)); await world.settle();
    world.devs.A.carrier.setOnline(false);
    await world.devs.B.rep.idle(); world.devs.B.rep.stop(); world.devs.B.link.stop(); await world.devs.B.store.close();
    fs.rmSync(nodePath.join(world.dirs.B, 'store'), { recursive: true, force: true }); fs.cpSync(snap, nodePath.join(world.dirs.B, 'store'), { recursive: true });
    await world.restart('B');
    world.hub.holdFilter = () => 'drop'; // nothing can be refilled yet: B can only SAY what it now holds
    world.devs.A.carrier.setOnline(true);
    await vi.waitFor(() => expect(ackOf(world, 'B', V)?.lines ?? 0).toBeLessThan(6), { timeout: 30_000 });
    world.hub.holdFilter = null;
    await world.elapse(120_000, 10_000);
    expect(ackOf(world, 'B', V)?.lines).toBe(6); // refilled: the ack is back, and it is true again
  });
});

describe('F2 listing rules', () => {
  const ackOf = (world: World, holder: string, v: Buffer) => world.devs.A.rep.peerAcks(v).find((a) => a.holder === world.ids[holder].deviceId.toString('hex'));
  it('an ack is not listed when the holder\'s own heads show another chain value at the same count, nor when its heads are stale', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('f2d');
    await world.create('A', V); await world.devs.A.rep.appendLocal(V, lineSet(5));
    await vi.waitFor(() => expect(ackOf(world, 'B', V)?.lines).toBe(5)); await world.settle();
    world.devs.B.rep.stop(); // B's replicator goes quiet (its link still speaks), so nothing re-confirms the ack behind this test's back
    world.devs.B.link.sendLive({ group: 'rep.live', kind: KIND_HEADS, body: headsBodyOf({ page: 0, of: 1, ask: false, heads: [{ version: V, lines: 5, hash: randomBytes(32), conversationHash: Buffer.alloc(32), stamp: 3, state: 'ok' }] }) });
    await vi.waitFor(() => expect(ackOf(world, 'B', V)).toBeUndefined());
    const real = Buffer.from((await headOf(world, 'A', V)).hash, 'hex');
    world.devs.B.link.sendLive({ group: 'rep.live', kind: KIND_HEADS, body: headsBodyOf({ page: 0, of: 1, ask: false, heads: [{ version: V, lines: 5, hash: real, conversationHash: Buffer.alloc(32), stamp: 3, state: 'ok' }] }) });
    await vi.waitFor(() => expect(ackOf(world, 'B', V)?.lines).toBe(5));
    world.devs.B.carrier.setOnline(false);
    await world.clock.advance(11 * 60_000);
    expect(ackOf(world, 'B', V)).toBeUndefined();
  });
});

describe('F3 wire ids and store ids are different spaces', () => {
  it('incarnation 0 is not the wire id, and no incarnation of one version equals another version\'s wire id or incarnation', () => {
    const a = wireId('f3a'); const b = wireId('f3b');
    expect(incarnationId(a, 0).equals(a)).toBe(false);
    const all = new Set<string>();
    for (const v of [a, b]) for (let n = 0; n <= 4; n++) all.add(incarnationId(v, n).toString('hex'));
    expect(all.size).toBe(10);
    expect(all.has(a.toString('hex')) || all.has(b.toString('hex'))).toBe(false);
  });
  it('a hostile device that announces a version whose id is the victim\'s NEXT incarnation id gets nothing written into the victim\'s copy', async () => {
    w = await withHostile(['A', 'B'], { discoveryMs: 600_000, stallMs: 600_000 }); const world = w; const W1 = wireId('f3c');
    await world.create('A', W1); await world.devs.A.rep.appendLocal(W1, lineSet(5));
    await vi.waitFor(async () => expect((await headOf(world, 'B', W1)).lines).toBe(5)); await world.settle();
    const W2 = incarnationId(W1, 1);
    sendLive(world, KIND_INTRO, intro(world, 'M', W2, 'c-m'), 'B'); await world.settle();
    const ml = lineSet(2, 'M-OWN'); const ch = chainOver('c-m', ml);
    await world.devs.M.link.sendDurable({ group: chatGroup(world.setId, 'c-m'), kind: KIND_LINES, line: true, to: world.ids.B.deviceId, body: linesBody({ version: W2, from: 0, lines: ml, head: { lines: 2, hash: ch, sig: signWith(world.ids.M, headMessage(W2, 2, ch)) } }) }); await world.settle();
    world.devs.A.carrier.passFilter = () => 'drop'; world.devs.B.carrier.passFilter = () => 'drop';
    await world.devs.B.store.setAsideDamaged((await world.localOf('B', W1)) as Buffer);
    await world.devs.B.rep.reportCorrupt(W1); await world.settle();
    const lid = await world.devs.B.rep.localId(W1);
    const h = await world.devs.B.store.head(lid);
    if (h.lines) expect(((await world.devs.B.store.read(lid, 0, 0, 1)) as Buffer[])[0].equals(ml[0])).toBe(false); // M's line is never in W1's copy
    expect(lid.equals(await world.devs.B.rep.localId(W2))).toBe(false);
  });
  it('a folder that already exists under the derived id but belongs to another chat is not used, and the version says so by name', async () => {
    w = await repWorld(['A', 'B'], { autoStart: false }); const world = w; const V = wireId('f3d');
    await world.devs.A.rep.start(); await world.create('A', V, { chatId: 'real-chat' });
    await world.devs.B.store.registerVersion(incarnationId(V, 0), { chatId: 'some-other-chat', runtime: 'claude-code' }); // squatter
    await world.devs.B.rep.start();
    await world.devs.A.rep.appendLocal(V, lineSet(2));
    await vi.waitFor(async () => expect(await st(world, 'B', V)).toMatch(/^stuck\(folder-belongs-to-another-version\)/));
    expect((await world.devs.B.store.head(incarnationId(V, 0))).lines).toBe(0);
  });
  it('forged lines, forged naks and a flood of intros from a paired non-writer never retire anybody\'s copy', async () => {
    w = await withHostile(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('f3e');
    await world.create('A', V); await world.devs.A.rep.appendLocal(V, lineSet(4));
    await vi.waitFor(async () => expect((await headOf(world, 'B', V)).lines).toBe(4)); await world.settle();
    for (let i = 0; i < 40; i++) sendLive(world, KIND_NAK, nakBodyOf({ version: V, at: 2, why: 'not-a-prefix', hashAtYourCount: randomBytes(32) }), 'B');
    const fl = lineSet(2, 'forged'); const ch = chainOver(CHAT, fl);
    for (let i = 0; i < 10; i++) await world.devs.M.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, to: world.ids.B.deviceId, body: linesBody({ version: V, from: 2, lines: fl, head: { lines: 4, hash: ch, sig: signWith(world.ids.M, headMessage(V, 4, ch)) } }) });
    await world.elapse(60_000, 10_000);
    expect(((await world.localOf('B', V)) as Buffer).equals(incarnationId(V, 0))).toBe(true);
    expect(world.devs.B.rep.counters()['retired-recopy'] ?? 0).toBe(0);
  });
});

describe('F4 the interim directory decides first-wins at once and remembers a conflict', () => {
  it('two announcements handled in the same turn: the first one wins, the second is a conflict, whatever the timing', async () => {
    const A = (await repWorld(['A', 'B'], { autoStart: false })); w = A;
    const dirB = new InterimDirectory(realFs, tmp('dir-'), { self: A.ids.B.deviceId, sign: (m) => signWith(A.ids.B, m), knows: () => true, verify: () => true });
    const V = wireId('f4a');
    const mk = (who: string) => { const b = { version: V, chatId: 'c', runtime: 'claude-code' as const, parent: null, forkLine: null, forkHash: null, token: null, writer: A.ids[who].deviceId }; return { ...b, sig: signWith(A.ids[who], introMessage(b)) }; };
    const results = await Promise.all([dirB.accept(mk('A')), dirB.accept(mk('B'))]);
    expect(results).toEqual(['new', 'conflict']);
    expect(dirB.describe(V)?.writer.equals(A.ids.A.deviceId)).toBe(true);
  });
  it('the conflict lives in the directory: it survives later appends and a restart, and the status names it', async () => {
    w = await withHostile(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('f4b');
    await world.create('A', V); await world.settle();
    sendLive(world, KIND_INTRO, intro(world, 'M', V, CHAT), 'B');
    await vi.waitFor(async () => expect(await st(world, 'B', V)).toBe('faulted(directory-conflict)'));
    await world.devs.A.rep.appendLocal(V, lineSet(3));
    await vi.waitFor(async () => expect((await headOf(world, 'B', V)).lines).toBe(3));
    expect(await st(world, 'B', V)).toBe('faulted(directory-conflict)');
    await world.restart('B'); await world.settle();
    expect(await st(world, 'B', V)).toBe('faulted(directory-conflict)');
  });
  it('a paired device that sends its own announcement together with the real one cannot capture the version id', async () => {
    w = await withHostile(['A', 'B'], { discoveryMs: 600_000 }); const world = w;
    for (let t = 0; t < 4; t++) {
      const V = wireId(`f4c-${t}`);
      sendLive(world, KIND_INTRO, intro(world, 'M', V, 'c'), 'B'); sendLive(world, KIND_INTRO, intro(world, 'A', V, 'c'), 'B');
      await world.settle();
      expect(world.devs.B.rep.describe(V)?.writer.equals(world.ids.M.deviceId)).toBe(true); // first in wins (decided before any wait), and it is the same every time
    }
  });
});

describe('F5 lines over the old read budget', () => {
  it('appendLocal refuses a line over the wire cap by name', async () => {
    w = await repWorld(['A', 'B']); const world = w; const V = wireId('f5a');
    await world.create('A', V);
    const huge = Buffer.concat([Buffer.from('{"type":"user","message":{"content":"'), Buffer.alloc(65 * 1024 * 1024, 0x61), Buffer.from('"}}\n')]);
    await expect(world.devs.A.rep.appendLocal(V, [huge])).rejects.toThrow(/line-too-large/);
    expect((await headOf(world, 'A', V)).lines).toBe(0);
  }, 120_000);
  it('a 17 MiB line catches up through want (the device was away, the relay forgot), and the stall has a name while it works', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 30_000, stallMs: 10_000 }); const world = w; const V = wireId('f5b');
    await world.create('A', V); await world.devs.A.rep.appendLocal(V, lineSet(2)); await world.settle();
    world.devs.B.carrier.setOnline(false);
    const big = Buffer.concat([Buffer.from('{"type":"user","message":{"content":"'), Buffer.alloc(17 * 1024 * 1024, 0x63), Buffer.from('"}}\n')]);
    await world.devs.A.rep.appendLocal(V, [big, ...lineSet(1, 'tail', 3)]); await world.settle(60_000);
    world.hub.releaseThrough(chatGroup(world.setId, CHAT), 1_000_000);
    world.devs.B.carrier.setOnline(true);
    await vi.waitFor(async () => { await world.clock.advance(5_000); expect((await headOf(world, 'B', V)).lines).toBe(4); }, { timeout: 280_000, interval: 500 });
    expect(world.devs.A.rep.counters()['serve-read-budget-wait'] ?? 0).toBeGreaterThanOrEqual(0);
    expect((await world.readAll('B', V))[2].equals(big)).toBe(true);
  }, 300_000);
});

describe('F6 a paired hostile device cannot make a device do unbounded work', () => {
  it('one heads frame naming 2000 unknown versions costs a bounded number of intro requests and keeps a bounded number of entries', async () => {
    w = await withHostile(['A'], { discoveryMs: 600_000 }); const world = w;
    const before = world.devs.A.carrier.passed;
    const entries = (r: number) => Array.from({ length: 2000 }, (_, i) => ({ version: wireId(`flood-${r}-${i}`), lines: 5, hash: Buffer.alloc(32, 1), conversationHash: Buffer.alloc(32), stamp: 0, state: 'ok' as const }));
    for (let r = 0; r < 6; r++) { sendLive(world, KIND_HEADS, headsBodyOf({ page: 0, of: 1, ask: false, heads: entries(r) }), 'A'); await world.settle(); }
    expect(world.devs.A.carrier.passed - before).toBeLessThanOrEqual(80);
    const s = world.devs.A.rep.stateSizes();
    expect(s.peerHeads).toBeLessThanOrEqual(100);
    expect(s.introAsked).toBeLessThanOrEqual(100);
    expect(s.runs).toBeLessThanOrEqual(5);
    expect(s.queues).toBeLessThanOrEqual(5);
  });
  it('a stream of tiny sum frames asking for an answer is answered at a bounded rate (store.head is not called per frame)', async () => {
    w = await withHostile(['A'], { discoveryMs: 600_000 }); const world = w;
    for (let i = 0; i < 40; i++) await world.create('A', wireId(`sum-${i}`), { chatId: `chat-${i}` });
    await world.settle();
    let calls = 0; const orig = world.devs.A.store.head.bind(world.devs.A.store);
    (world.devs.A.store as unknown as { head: unknown }).head = (...a: Parameters<typeof orig>) => { calls++; return orig(...a); };
    for (let i = 0; i < 150; i++) sendLive(world, KIND_SUM, sumBody({ count: 0, digest: randomBytes(32), ask: true }), 'A');
    await world.settle();
    expect(calls).toBeLessThanOrEqual(40 * 2 * 12); // a burst of answers then none: 150 frames would cost 12,000 head reads, this costs under 1,000
  });
  it('naks, acks and wants naming versions nobody announced create no per-version state', async () => {
    w = await withHostile(['A'], { discoveryMs: 600_000 }); const world = w;
    for (let i = 0; i < 300; i++) {
      const v = wireId(`ghost-${i}`);
      sendLive(world, KIND_NAK, nakBodyOf({ version: v, at: 0, why: 'unavailable', hashAtYourCount: null }), 'A');
      sendLive(world, KIND_WANT, wantBodyOf({ version: v, haveLines: 0, haveHash: Buffer.alloc(32), through: null, intro: false }), 'A');
    }
    await world.settle();
    const s = world.devs.A.rep.stateSizes();
    expect(s.runs).toBe(0); expect(s.queues).toBe(0);
  });
  it('one peer pinning a huge declared line cannot block a real large line, and an abandoned reassembly is released by a timer', async () => {
    w = await withHostile(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('f6d');
    await world.create('A', V); const ls = lineSet(3); await world.devs.A.rep.appendLocal(V, ls); await world.settle();
    const hash = Buffer.from((await headOf(world, 'A', V)).hash, 'hex');
    const head = { lines: 3, hash, sig: signWith(world.ids.A, headMessage(V, 3, hash)) }; // a genuine, replayed head
    const of = 128; const total = of * PART_BYTES - 10;
    await world.devs.M.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, to: world.ids.B.deviceId, body: linesBody({ version: V, from: 2, lines: [Buffer.alloc(PART_BYTES, 1)], head, part: { index: 0, of, totalBytes: total } }) }); await world.settle();
    const big = Buffer.concat([Buffer.from('{"type":"user","message":{"content":"'), Buffer.alloc(3 * 1024 * 1024, 0x61), Buffer.from('"}}\n')]);
    await world.devs.A.rep.appendLocal(V, [big]);
    await vi.waitFor(async () => expect((await headOf(world, 'B', V)).lines).toBe(4), { timeout: 60_000 });
    await world.clock.advance(120_000); await world.settle();
    expect(world.devs.B.rep.stateSizes().reassemblyBytes).toBe(0);
  }, 120_000);
});

describe('F6 parts out of order', () => {
  it('parts that arrive out of order never complete a line and never flip the version to diverged (the ordering check is the only defence here)', async () => {
    w = await withHostile(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('f6p');
    await world.create('A', V); await world.devs.A.rep.appendLocal(V, lineSet(3)); await world.settle();
    const hash = Buffer.from((await headOf(world, 'A', V)).hash, 'hex');
    const head = { lines: 3, hash, sig: signWith(world.ids.A, headMessage(V, 3, hash)) };
    const total = 2 * PART_BYTES + 10; const sizes = [PART_BYTES, PART_BYTES, 10];
    for (const idx of [0, 2, 1]) await world.devs.M.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, to: world.ids.B.deviceId, body: linesBody({ version: V, from: 2, lines: [Buffer.alloc(sizes[idx], 7)], head, part: { index: idx, of: 3, totalBytes: total } }) });
    await world.settle();
    expect(world.devs.B.rep.counters()['part-out-of-order'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(world.devs.B.rep.counters()['chain-mismatch'] ?? 0).toBe(0);
    expect(await st(world, 'B', V)).not.toMatch(/^diverged/);
  });
});

describe('F6/F8 a child waiting for its parent is not adopted again for every message', () => {
  it('two hundred naks about the parent cause a bounded number of adoptions of the waiting child (the unbounded backlog behind review seed 3040)', async () => {
    w = await withHostile(['A', 'B'], { discoveryMs: 600_000, stallMs: 600_000 }); const world = w; const V = wireId('f6e');
    await world.create('A', V); await world.devs.A.rep.appendLocal(V, lineSet(4)); await world.settle();
    // B knows the version but holds none of it (the relay drops what A sends), so a child forked at line 4 has to wait for its parent
    world.hub.holdFilter = () => 'drop';
    await world.devs.A.rep.appendLocal(V, lineSet(1, 'x', 4)); await world.settle();
    const hash = (await headOf(world, 'A', V)); void hash;
    const forkHash = Buffer.from((await world.devs.A.store.hashAt(await world.local('A', V), 0, 5)) as string, 'hex');
    const token = 'wait'; const child = (await import('../../src/main/mesh/store')).deriveForkId(V, 5, forkHash.toString('hex'), token);
    await world.devs.A.rep.createVersion({ version: child, chatId: CHAT, runtime: 'claude-code', parent: V, forkLine: 5, forkHash, token }); // B holds 4 lines of the parent: the child must wait for line 5
    await world.settle();
    let syncs = 0; const link = world.devs.B.link as unknown as { sync: (g: string) => Promise<void> }; const orig = link.sync.bind(link);
    link.sync = (g: string) => { syncs++; return orig(g); };
    for (let i = 0; i < 200; i++) sendLive(world, KIND_NAK, nakBodyOf({ version: V, at: 0, why: 'unavailable', hashAtYourCount: null }), 'B');
    await world.settle();
    expect(world.devs.B.rep.counters()['fork-local'] ?? 0).toBe(0); // it really was waiting
    expect(syncs).toBeLessThanOrEqual(20);
    expect(world.devs.B.rep.stateSizes().queues).toBe(0);
  });
});

describe('F7 status never says in-sync when it cannot know', () => {
  it('a peer that says it is repairing, and a peer whose claims are too old, each get their own named state', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('f7');
    await world.create('A', V); await world.devs.A.rep.appendLocal(V, lineSet(4));
    await vi.waitFor(async () => expect(await st(world, 'A', V)).toBe('in-sync')); await world.settle();
    const bHash = Buffer.from((await headOf(world, 'B', V)).hash, 'hex');
    world.devs.B.link.sendLive({ group: 'rep.live', kind: KIND_HEADS, body: headsBodyOf({ page: 0, of: 1, ask: false, heads: [{ version: V, lines: 2, hash: bHash, conversationHash: Buffer.alloc(32), stamp: 3, state: 'refilling' }] }) });
    await vi.waitFor(async () => expect(await st(world, 'A', V)).toBe('peer-repairing'));
    world.devs.B.link.sendLive({ group: 'rep.live', kind: KIND_HEADS, body: headsBodyOf({ page: 0, of: 1, ask: false, heads: [{ version: V, lines: 4, hash: bHash, conversationHash: Buffer.alloc(32), stamp: 3, state: 'ok' }] }) });
    await vi.waitFor(async () => expect(await st(world, 'A', V)).toBe('in-sync'));
    world.devs.B.carrier.setOnline(false);
    await world.clock.advance(11 * 60_000);
    await vi.waitFor(async () => expect(await st(world, 'A', V)).toMatch(/^stale/));
  });
});

describe('F8 a store call that never answers ends in a named state', () => {
  it('a version whose store call hangs is reported stuck(store-call-blocked), and other versions keep working', async () => {
    w = await repWorld(['A'], { discoveryMs: 600_000, stepLimitMs: 300 } as never); const world = w; const V = wireId('f8a'); const U = wireId('f8b');
    await world.create('A', V); await world.create('A', U); await world.settle();
    const lv = (await world.localOf('A', V)) as Buffer;
    const orig = world.devs.A.store.head.bind(world.devs.A.store);
    (world.devs.A.store as unknown as { head: unknown }).head = (id: Buffer, ...r: unknown[]) => (id.equals(lv) ? new Promise(() => undefined) : (orig as (...x: unknown[]) => Promise<unknown>)(id, ...r));
    void world.devs.A.rep.appendLocal(V, lineSet(1)).catch(() => undefined);
    await vi.waitFor(async () => expect(await st(world, 'A', V)).toBe('stuck(store-call-blocked)'));
    await world.devs.A.rep.appendLocal(U, lineSet(2)); // another version is not held up
    expect((await headOf(world, 'A', U)).lines).toBe(2);
    // and the SAME version's queue moved on: once the store answers again, the next step on it runs (it would wait behind the hung one forever without the ceiling)
    (world.devs.A.store as unknown as { head: unknown }).head = orig;
    await world.devs.A.rep.appendLocal(V, lineSet(1, 'again'));
    expect((await headOf(world, 'A', V)).lines).toBeGreaterThanOrEqual(1);
  });
});

describe('F9 rot at rest is found by the replicator itself', () => {
  it('a rotted line nobody reads is found by the background scrub and healed from a peer', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000, scrubEveryMs: 30_000 } as never); const world = w; const V = wireId('f9');
    await world.create('A', V); await world.devs.A.rep.appendLocal(V, lineSet(8));
    await vi.waitFor(async () => expect((await headOf(world, 'B', V)).lines).toBe(8)); await world.settle();
    await world.restart('B'); await world.elapse(60_000, 30_000); // the store's own scrub-on-open has now passed over everything
    // the file rots WHILE the store is open and nobody reads it: the store's scrub mark is already past it
    const body = nodePath.join(world.dirs.B, 'store', 'versions', (incarnationId(V, 0)).toString('hex'), 'body-0000000000000000.bin');
    const raw = fs.readFileSync(body); raw[lineSet(1)[0].length * 3 + 12] ^= 0xff; fs.writeFileSync(body, raw);
    // nobody reads B's copy; only time passes
    await world.elapse(10 * 60_000, 30_000);
    expect(await world.readAll('B', V)).toEqual(await world.readAll('A', V));
    expect((await world.devs.B.store.verify((await world.localOf('B', V)) as Buffer)).ok).toBe(true);
  });
});
export { line };
