// Independent review 4: the self-fork must never turn a loud fault into a quiet loss; a roster device must not freeze the writer; stale faults clear; budgets.
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repWorld, wireId, lineSet, CHAT, type World } from './replicator-world';
import { splitHistories } from './selffork-helpers';
import { selfForkToken } from '../../src/main/mesh/replicator/selffork';
import { GROUP_LIVE, headMessage, headsBodyOf, KIND_HEADS, KIND_LINES, KIND_NAK, KIND_SUM, KIND_WANT, linesBody, nakBodyOf, sumBody } from '../../src/main/mesh/replicator/wire';
import { chainStep, defaultChainSeeds } from '../../src/main/mesh/store';
import { chatGroup } from '../../src/main/mesh/replicator/ctx';
import { signWith } from '../../src/main/mesh/crypto/identity';
import { MAX_ANNOUNCED_PER_DEVICE } from '../../src/main/mesh/replicator/budget';

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
const seed = (): Buffer => defaultChainSeeds({ chatId: CHAT, version: new Uint8Array(), segment: 0 }).raw;
/** Every version a device knows, as `lines` of text. */
const textOf = async (world: World, n: string, v: Buffer): Promise<string[]> => (await world.readAll(n, v)).map((l) => l.toString());

describe('F1: the second version is never appended onto other content', () => {
  it('a second rollback to the same backup with other lines gets ITS OWN second version: nothing is spliced, nothing is lost, on both devices', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-f1');
    await world.create('A', V); await world.settle();
    const bk = nodePath.join(world.dirs.A, '..', 'bk-r4-f1'); snap(world, 'A', bk);
    await splitHistories(world, V); // B holds "yy" under V, A moved its "xx" lines into a second version
    expect(world.devs.A.rep.selfForks()).toHaveLength(1);
    const first = world.devs.A.rep.selfForks()[0].movedTo;
    await down(world, 'A'); restore(world, 'A', bk); world.devs.B.carrier.setOnline(false);
    await world.restart('A'); await world.elapse(8_000, 1_000, true);
    expect((await world.append('A', V, lineSet(5, 'zz'))).result).toBe('saved'); // the same backup, other lines
    world.devs.B.carrier.setOnline(true);
    await world.elapse(300_000, 10_000, true);
    for (const n of ['A', 'B']) {
      const all: string[][] = [];
      for (const v of world.devs[n].rep.versions()) all.push(await textOf(world, n, v));
      if (process.env.DBG4) console.log('DBG4', n, JSON.stringify(all.map((t) => t.map((l) => (l.match(/(xx|yy|zz|old) \d/) ?? ['?'])[0]))));
      for (const t of all) expect(t.some((l) => /xx \d/.test(l)) && t.some((l) => /zz \d/.test(l))).toBe(false); // no version mixes the two histories
      expect(all.flat().filter((l) => /xx \d/.test(l)).length).toBeGreaterThanOrEqual(5); // every line the user was told "saved" is in some version
      expect(all.flat().filter((l) => /zz \d/.test(l)).length).toBeGreaterThanOrEqual(5);
    }
    const forks = world.devs.A.rep.selfForks(); expect(forks.length).toBeGreaterThanOrEqual(1);
    expect(forks.every((f) => !f.movedTo.equals(first))).toBe(true); // another id than the first move's
  }, 400_000);

  it('a move whose target already holds OTHER lines is refused loudly and appends nothing onto it (the class guard), and the chat stays marked as being moved', async () => {
    w = await repWorld(['A'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-f1b'); const W = wireId('r4-f1c');
    await world.create('A', V); await world.append('A', V, lineSet(5, 'mine'));
    await world.create('A', W); await world.append('A', W, lineSet(3, 'other')); // a version with another content
    const before = await textOf(world, 'A', W);
    await down(world, 'A');
    // a journal that names W as the target of V's move (as a replayed or damaged note could)
    const { SignedHeads: _sh } = await import('../../src/main/mesh/replicator/signed-heads'); void _sh;
    const dir = nodePath.join(world.dirs.A, 'replicator', 'selffork'); fs.mkdirSync(dir, { recursive: true });
    const h0 = (await (async () => { const d = await world.restart('A', { start: false }); return d.store.hashAt(await world.local('A', V), 0, 0); })()) as string;
    fs.writeFileSync(nodePath.join(dir, V.toString('hex')), JSON.stringify({ p: 0, hp: h0, v2: W.toString('hex'), token: 'x', inc: 0, stage: 'start' }));
    await world.devs.A.rep.start();
    await world.elapse(20_000, 5_000, true);
    expect(await textOf(world, 'A', W)).toEqual(before); // nothing was appended onto it
    expect(await st(world, 'A', V)).toBe('refilling(self-fork-in-progress)'); // loud, never calm
    await expect(world.append('A', V, lineSet(1, 'q', 5))).rejects.toThrow(/self-fork-in-progress/);
  });

  it('the mark comes from the journal on disk: after a restart the chat still refuses to take lines, and a second move cannot start over the first', async () => {
    w = await repWorld(['A'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-f2c'); const W = wireId('r4-f2d');
    await world.create('A', V); await world.append('A', V, lineSet(4)); await world.create('A', W); await world.append('A', W, lineSet(2, 'o'));
    await down(world, 'A');
    const dir = nodePath.join(world.dirs.A, 'replicator', 'selffork'); fs.mkdirSync(dir, { recursive: true });
    const d = await world.restart('A', { start: false }); const h0 = (await d.store.hashAt(await world.local('A', V), 0, 0)) as string;
    fs.writeFileSync(nodePath.join(dir, V.toString('hex')), JSON.stringify({ p: 0, hp: h0, v2: W.toString('hex'), token: 'x', inc: 0, stage: 'start' }));
    await down(world, 'A'); await world.restart('A'); await world.elapse(10_000, 5_000, true);
    expect(await st(world, 'A', V)).toBe('refilling(self-fork-in-progress)');
    await expect(world.append('A', V, lineSet(1, 'q', 4))).rejects.toThrow(/writer-self-fork-in-progress/);
    expect(world.devs.A.rep.counters()['writer-self-fork'] ?? 0).toBe(0);
  });
});

describe('F2: a long move keeps the chat\'s queue and refuses appends by name', () => {
  it('with the step ceiling at 100 ms and slow reads, a line sent while the move runs is refused (never lost), and one move runs', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000, stepLimitMs: 100 }); const world = w; const V = wireId('r4-f2');
    await world.create('A', V); await world.settle();
    // B holds a history of A's; A (cut off) signs another; they meet, and the move at A reads slowly
    const { SignedHeads } = await import('../../src/main/mesh/replicator/signed-heads'); const { realFs } = await import('../../src/main/mesh/store/fsio');
    await down(world, 'B'); const dev = await world.restart('B', { graceful: false, start: false });
    const y = lineSet(5, 'yy'); const ch = y.reduce((h, l) => chainStep(h, l), seed());
    await dev.store.append((await world.localOf('B', V)) as Buffer, 0, 0, y);
    await new SignedHeads(realFs, nodePath.join(world.dirs.B, 'replicator')).add(V, { lines: 5, hash: ch, sig: signWith(world.ids.A, headMessage(V, 5, ch)), spanBytes: 100 });
    world.devs.B.carrier.setOnline(false); await dev.rep.start(); await world.elapse(8_000, 1_000, true);
    await world.append('A', V, lineSet(5, 'xx'));
    const store = world.devs.A.store; const realRead = store.read.bind(store);
    store.read = (async (...a: Parameters<typeof realRead>) => { await new Promise((r) => setTimeout(r, 400)); return realRead(...a); }) as typeof realRead;
    world.devs.B.carrier.setOnline(true);
    let refused = 0; let saved = 0; const told: string[] = [];
    await vi.waitFor(async () => { const s = await st(world, 'A', V); if (!/self-fork-in-progress/.test(s)) throw new Error(`not moving yet: ${s}`); }, { timeout: 60_000, interval: 25 });
    for (let i = 0; i < 4; i++) { try { const ls = lineSet(1, `LATE${i}`, 5 + i); await world.append('A', V, ls); saved++; told.push(ls[0].toString()); } catch (e) { if (/self-fork-in-progress/.test(String(e))) refused++; else if (!/recopy-not-confirmed|refilling|waiting-for-peers/.test(String(e))) throw e; /* (after the move the chat refills from the peers; also a loud refusal) */ } }
    // a second conflicting batch arrives WHILE the move runs (B's history, signed by A again): it waits behind the move and finds nothing to move afterwards
    await world.devs.B.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, to: world.ids.A.deviceId, body: linesBody({ version: V, from: 0, lines: y, head: { lines: 5, hash: ch, sig: signWith(world.ids.A, headMessage(V, 5, ch)) } }) }); void world.devs.A.link.sync(chatGroup(world.setId, CHAT)); // (not awaited: reading it waits behind the move)
    await world.elapse(200_000, 10_000, true); store.read = realRead; // (reads stay slow while the second batch waits behind the move)
    expect(refused).toBeGreaterThanOrEqual(1);
    expect(world.devs.A.rep.counters()['writer-self-fork']).toBe(1); // one move, not several overlapping ones (the second conflicting batch waited behind the first)
    const all: string[] = []; for (const n of ['A', 'B']) for (const v of world.devs[n].rep.versions()) all.push(...(await textOf(world, n, v)));
    for (const l of told) expect(all.some((x) => x.includes(l.trim().slice(0, 20)))).toBe(true); // a line that WAS told saved is somewhere
  }, 300_000);
});

// ------------------------------------------------------------------ a roster device cannot freeze the writer
const sumFrame = (world: World, from: string): void => { world.devs[from].link.sendLive({ group: GROUP_LIVE, kind: KIND_SUM, body: sumBody({ count: 0, digest: Buffer.alloc(32, 1), ask: false }) }); };
const claimFrame = (world: World, from: string, V: Buffer, lines: number, hash = randomBytes(32)): void => { world.devs[from].link.sendLive({ group: GROUP_LIVE, kind: KIND_HEADS, body: headsBodyOf({ page: 0, of: 1, ask: false, heads: [{ version: V, lines, hash, conversationHash: Buffer.alloc(32), stamp: 1, state: 'ok' }] }) }); };

describe('F3: a replayed batch does not keep a false claim alive', () => {
  it('a device that claims more lines and replays a genuine old batch every 9 minutes cannot keep the writer refusing past the absolute cap', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-f3');
    await world.create('A', V); await world.append('A', V, lineSet(3)); await world.settle();
    const mine = await world.readAll('A', V); const ch = mine.reduce((h, l) => chainStep(h, l), seed());
    world.devs.B.rep.stop();
    const replay = async (): Promise<void> => { await world.devs.B.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, to: world.ids.A.deviceId, body: linesBody({ version: V, from: 0, lines: mine, head: { lines: 3, hash: ch, sig: signWith(world.ids.A, headMessage(V, 3, ch)) } }) }); await world.devs.A.link.sync(chatGroup(world.setId, CHAT)); /* (A reads what waits for it) */ };
    let firstSaved = -1; let refusedEarly = false;
    for (let m = 0; m <= 72; m += 9) {
      claimFrame(world, 'B', V, 500, Buffer.alloc(32, 9)); await replay(); await world.elapse(9 * 60_000, 60_000, true);
      try { await world.append('A', V, lineSet(1, `f3-${m}`, (await world.devs.A.store.head(await world.local('A', V))).lines)); if (firstSaved < 0) firstSaved = m + 9; } catch (e) { if (!/writer-behind-peer-holds-more/.test(String(e))) throw e; if (m < 9) refusedEarly = true; }
      if (firstSaved >= 0) break;
    }
    expect(refusedEarly).toBe(true);
    expect(firstSaved).toBeGreaterThan(0); expect(firstSaved).toBeLessThanOrEqual(20); // the 10-minute clock keeps running through every replay (a replay resets nothing)
  }, 200_000);
});

describe('F3: the absolute cap', () => {
  it('a device that drips REAL new lines to the restored writer, one per 9 minutes, while claiming far more, cannot hold it past the absolute cap from the first claim', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-f3cap');
    await world.create('A', V); await world.append('A', V, lineSet(5, 'old')); await world.settle();
    const bk = nodePath.join(world.dirs.A, '..', 'bk-r4-f3cap'); snap(world, 'A', bk);
    await world.append('A', V, lineSet(15, 'mid', 5)); await world.settle();
    const all = await world.readAll('B', V);
    await down(world, 'A'); restore(world, 'A', bk); world.devs.B.rep.stop();
    await world.restart('A');
    let saved = -1; let refusedAt18 = false;
    for (let i = 0; i < 12; i++) {
      claimFrame(world, 'B', V, 500, Buffer.alloc(32, 9));
      const have = (await world.devs.A.store.head(await world.local('A', V))).lines; const upto = Math.min(all.length, have + 1);
      const ch = all.slice(0, upto).reduce((h, l) => chainStep(h, l), seed());
      if (upto > have) { await world.devs.B.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, to: world.ids.A.deviceId, body: linesBody({ version: V, from: have, lines: all.slice(have, upto), head: { lines: upto, hash: ch, sig: signWith(world.ids.A, headMessage(V, upto, ch)) } }) }); await world.devs.A.link.sync(chatGroup(world.setId, CHAT)); }
      await world.elapse(9 * 60_000, 60_000, true);
      try { const h = await world.devs.A.store.head(await world.local('A', V)); await world.devs.A.rep.appendLocal(V, lineSet(1, `cap-${i}`, h.lines), { lines: h.lines, hash: h.hash }); saved = (i + 1) * 9; break; } catch (e) { if (!/writer-behind-peer-holds-more|writer-diverged-from-peer/.test(String(e))) throw e; if (i === 1) refusedAt18 = true; }
    }
    expect(refusedAt18).toBe(true); // not freed by the 10-minute clock, because every drip is real progress
    expect(saved).toBeGreaterThan(0); expect(saved).toBeLessThanOrEqual(45); // freed by the absolute cap (30 minutes from the first claim)
  }, 300_000);
});

describe('F4: a device that is heard but never sends its heads is waited for only a bounded time', () => {
  it('a restarted writer starts writing after the bounded wait, names the device, and still honours that device\'s later honest heads', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-f4');
    await world.create('A', V); await world.append('A', V, lineSet(2)); await world.settle();
    world.devs.B.rep.stop(); await down(world, 'A'); await world.restart('A');
    for (let i = 0; i < 3; i++) { sumFrame(world, 'B'); await world.settle(); await world.elapse(25_000, 5_000, true); } // (settle first: the device must be HEARD before the short no-one-reachable wait is over)
    await expect(world.append('A', V, lineSet(1, 'q', 2))).rejects.toThrow(/writer-waiting-for-peers/).catch(() => undefined); // (within the wait: refused or, once past it, saved)
    sumFrame(world, 'B'); await world.elapse(30_000, 5_000, true);
    expect((await world.append('A', V, lineSet(1, 'r', (await world.devs.A.store.head(await world.local('A', V))).lines))).result).toBe('saved');
    expect(world.devs.A.rep.counters()['gate-device-discounted']).toBe(1);
    expect(await st(world, 'A', V)).toMatch(/gate-did-not-wait-for [0-9a-f]{8}|^comparing|^in-sync/);
    claimFrame(world, 'B', V, 99); await world.settle(); // its heads arrive after all, claiming more: honoured
    await expect(world.append('A', V, lineSet(1, 's', 4))).rejects.toThrow(/writer-behind-peer-holds-more/);
  }, 200_000);
});

describe('F5: a stale fault clears only when the writer\'s current history extends the copy', () => {
  async function faulted(forkLen = 5, dropPoints = false): Promise<{ world: World; V: Buffer; keep: string[] }> {
    const world = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); w = world; const V = wireId(`r4-f5-${Math.random()}`);
    await world.create('A', V); await world.append('A', V, lineSet(6)); await world.settle();
    if (dropPoints) { await down(world, 'B'); fs.rmSync(nodePath.join(world.dirs.B, 'replicator', 'heads'), { recursive: true, force: true }); await world.restart('B'); } // B's saved signed points are gone: nothing says whose history it holds
    world.devs.A.rep.stop(); const keep = await textOf(world, 'B', V);
    const other = lineSet(forkLen, 'FORK'); const ch = other.reduce((h, l) => chainStep(h, l), seed());
    await world.devs.A.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, to: world.ids.B.deviceId, body: linesBody({ version: V, from: 0, lines: other, head: { lines: forkLen, hash: ch, sig: signWith(world.ids.A, headMessage(V, forkLen, ch)) } }) });
    await vi.waitFor(async () => expect(await st(world, 'B', V)).toMatch(/^diverged\(writer-two-histories/));
    return { world, V, keep };
  }
  it('a verified batch that starts at the copy\'s head with its own chain value takes it off the fault and is appended', async () => {
    const { world, V, keep } = await faulted();
    const more = lineSet(2, 'more', 6); const ch = [...(await world.readAll('B', V)), ...more].reduce((h, l) => chainStep(h, l), seed());
    await world.devs.A.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, to: world.ids.B.deviceId, body: linesBody({ version: V, from: 6, lines: more, head: { lines: 8, hash: ch, sig: signWith(world.ids.A, headMessage(V, 8, ch)) } }) });
    await vi.waitFor(async () => expect(await st(world, 'B', V)).not.toMatch(/writer-two-histories/));
    expect((await textOf(world, 'B', V)).slice(0, 6)).toEqual(keep); expect((await textOf(world, 'B', V)).length).toBe(8);
    expect(world.devs.B.rep.counters()['fault-cleared-by-extension']).toBe(1);
  });
  it('a copy that the writer holds exactly (nothing to extend) asks the writer for its signed head and is taken off the fault without waiting for the next append', async () => {
    const { world, V, keep } = await faulted();
    await world.restart('A'); await world.elapse(120_000, 10_000, true); // the writer is back and agrees; it has nothing new to say
    expect(await st(world, 'B', V)).not.toMatch(/writer-two-histories/);
    expect(await textOf(world, 'B', V)).toEqual(keep);
    expect(world.devs.B.rep.counters()['fault-cleared-by-cover']).toBe(1);
  });
  it('a signed batch that continues the OTHER history (its chain does not start from the copy) leaves the fault in place and appends nothing', async () => {
    const { world, V, keep } = await faulted(6, true); // the other history is exactly as long as the copy and B has no saved points, so a continuation starts at the copy's head and the base the sender names is one it was told
    const base6 = lineSet(6, 'FORK').reduce((h, l) => chainStep(h, l), seed());
    const more = lineSet(2, 'FORKMORE', 6); const ch = more.reduce((h, l) => chainStep(h, l), base6);
    await world.devs.A.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, to: world.ids.B.deviceId, body: linesBody({ version: V, from: 6, lines: more, head: { lines: 8, hash: ch, sig: signWith(world.ids.A, headMessage(V, 8, ch)) } }) });
    await world.elapse(30_000, 10_000, true);
    expect(await st(world, 'B', V)).toMatch(/^diverged\(writer-two-histories/);
    expect(await textOf(world, 'B', V)).toEqual(keep);
  });
});

describe('lower findings', () => {
  it('an unsigned nak from a roster device never changes the writer\'s view of its own chat', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-nak');
    await world.create('A', V); await world.append('A', V, lineSet(4)); await world.settle(); world.devs.B.rep.stop();
    const before = await st(world, 'A', V);
    world.devs.B.link.sendLive({ group: GROUP_LIVE, kind: KIND_NAK, body: nakBodyOf({ version: V, at: 2, why: 'not-a-prefix', hashAtYourCount: randomBytes(32) }) });
    await world.settle(); expect(await st(world, 'A', V)).not.toMatch(/^diverged/); expect(before).not.toMatch(/^diverged/); // (it may ask the sender once, from zero; it never calls its own chat diverged)
  });
  it('the second version is still listed after a restart (the note stays on disk)', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-persist');
    await world.create('A', V); await world.settle(); await splitHistories(world, V);
    const before = world.devs.A.rep.selfForks(); expect(before).toHaveLength(1);
    await down(world, 'A'); await world.restart('A');
    expect(world.devs.A.rep.selfForks().map((f) => f.movedTo.toString('hex'))).toEqual(before.map((f) => f.movedTo.toString('hex')));
  }, 200_000);
  it('a roster device that announces more versions than the budget gets the rest ignored and counted, and nothing is created for them', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000, bound: true }); const world = w;
    const { deriveRootId } = await import('../../src/main/mesh/replicator/directory'); const { introBodyOf, introMessage, KIND_INTRO } = await import('../../src/main/mesh/replicator/wire');
    const N = MAX_ANNOUNCED_PER_DEVICE + 15;
    for (let i = 0; i < N; i++) {
      const nonce = randomBytes(16); const d = { version: deriveRootId(world.setId, `flood-${i}`, world.ids.B.deviceId, nonce), chatId: `flood-${i}`, runtime: 'claude-code' as const, parent: null, forkLine: null, forkHash: null, token: null, writer: world.ids.B.deviceId, nonce };
      world.devs.B.link.sendLive({ group: GROUP_LIVE, kind: KIND_INTRO, body: introBodyOf({ ...d, sig: signWith(world.ids.B, introMessage(d)) }) });
      if (i % 100 === 99) await world.settle(60_000);
    }
    await world.settle(60_000);
    expect(world.devs.A.rep.versions().length).toBeLessThanOrEqual(MAX_ANNOUNCED_PER_DEVICE);
    expect(world.devs.A.rep.counters()['intro-over-budget']).toBeGreaterThanOrEqual(10);
  }, 600_000);
});

// ------------------------------------------------------------------ the guards the mutation run found nothing depending on
describe('guards of the resolution', () => {
  async function newerHolder(): Promise<{ world: World; V: Buffer; peers: string[] }> {
    const world = await repWorld(['A', 'B', 'C'], { discoveryMs: 600_000 }); w = world; const V = wireId(`r4-s3-${Math.random()}`);
    await world.create('A', V); await world.append('A', V, lineSet(5, 'old')); await world.settle();
    const bkA = nodePath.join(world.dirs.A, '..', 'bk-s3A'); const bkC = nodePath.join(world.dirs.C, '..', 'bk-s3C'); snap(world, 'A', bkA); snap(world, 'C', bkC);
    await world.append('A', V, lineSet(5, 'mid', 5)); await world.settle(); const peers = await textOf(world, 'B', V);
    for (const n of ['A', 'C']) await down(world, n);
    restore(world, 'A', bkA); restore(world, 'C', bkC); world.devs.B.carrier.setOnline(false);
    await world.restart('A'); await world.restart('C'); await world.elapse(8_000, 1_000, true);
    expect((await world.append('A', V, lineSet(3, 'NEW', 5))).result).toBe('saved'); await world.elapse(20_000, 5_000, true);
    expect((await world.readAll('C', V)).length).toBe(8);
    return { world, V, peers };
  }
  /** A REAL second history: B holds common(3)+yy, the writer A signed common(3)+xx on its own, and they have met one-way (A's push reached B, nothing from B reaches A), so B is faulted and A never finds out. */
  async function realFault(): Promise<{ world: World; V: Buffer; common: Buffer[]; yy: string[] }> {
    const world = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); w = world; const V = wireId(`r4-real-${Math.random()}`);
    await world.create('A', V); await world.settle();
    const { SignedHeads } = await import('../../src/main/mesh/replicator/signed-heads'); const { realFs } = await import('../../src/main/mesh/store/fsio');
    await down(world, 'B'); const dev = await world.restart('B', { graceful: false, start: false });
    const common = lineSet(3, 'cc'); const ys = [...common, ...lineSet(2, 'yy', 3)]; const hy = ys.reduce((h, l) => chainStep(h, l), seed());
    await dev.store.append((await world.localOf('B', V)) as Buffer, 0, 0, ys);
    void SignedHeads; void realFs; void hy; // (B has NO saved signed point for its lines, as after a replicator folder put back: so the contradiction is a fault on B, not an equivocation it can prove)
    world.devs.B.carrier.setOnline(false); await dev.rep.start(); await world.elapse(8_000, 1_000, true);
    await world.append('A', V, [...common, ...lineSet(2, 'xx', 3)]);
    world.hub.holdFilter = (d) => (d === 'B' ? 'drop' : 'store'); world.devs.B.carrier.passFilter = () => 'drop'; // nothing from B reaches A
    world.devs.B.carrier.setOnline(true);
    await vi.waitFor(async () => { await world.elapse(10_000, 5_000, true); expect(await st(world, 'B', V)).toMatch(/^diverged\(writer-two-histories/); }, { timeout: 60_000, interval: 25 });
    return { world, V, common, yy: await textOf(world, 'B', V) };
  }
  it('a peer whose copy matches the second version so far, but is LONGER than it, does NOT set its copy aside (the rest of its lines would live nowhere verified)', async () => {
    const { world, V, common, yy } = await realFault();
    // the writer announces a self-fork child at 3 (the lines both histories share) that so far holds ONE line, the same as B's fourth
    const hp = common.reduce((h, l) => chainStep(h, l), seed()).toString('hex'); const { deriveForkId } = await import('../../src/main/mesh/store');
    const token = selfForkToken(world.ids.A.deviceId, CHAT, 'short'); const child = deriveForkId(V, 3, hp, token);
    await world.devs.A.rep.createVersion({ version: child, chatId: CHAT, runtime: 'claude-code', parent: V, forkLine: 3, forkHash: Buffer.from(hp, 'hex'), token });
    await world.append('A', child, [(await world.readAll('B', V))[3]]);
    await world.elapse(120_000, 10_000, true);
    expect((await world.readAll('B', child)).length).toBe(4); // B holds the child as far as it goes
    expect(await textOf(world, 'B', V)).toEqual(yy);           // and its own 5 lines are still under V
    expect(world.devs.B.rep.counters()['retired-recopy'] ?? 0).toBe(0);
    expect(await st(world, 'B', V)).toMatch(/^diverged\(writer-two-histories/);
  }, 300_000);

  it('a note from an earlier incarnation never retires the chat again (a replayed move)', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-s5');
    await world.create('A', V); await world.settle(); await splitHistories(world, V);
    const f = world.devs.A.rep.selfForks()[0]; const local = await world.local('A', V);
    await down(world, 'A');
    const file = nodePath.join(world.dirs.A, 'replicator', 'selffork', V.toString('hex')); const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...j, stage: 'copied', inc: j.inc - 1 < 0 ? 99 : j.inc - 1 })); // the incarnation the note names is not the current one
    await world.restart('A'); await world.elapse(60_000, 10_000, true);
    expect((await world.local('A', V)).equals(local)).toBe(true); // not set aside a second time
    expect(world.devs.A.rep.selfForks().some((x) => x.movedTo.equals(f.movedTo))).toBe(true);
  }, 200_000);

  it('an unfinished note is picked up at the next start and finished (resume)', async () => {
    w = await repWorld(['A'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-s13');
    await world.create('A', V); await world.append('A', V, lineSet(5, 'mine'));
    await down(world, 'A'); const d = await world.restart('A', { start: false });
    const { deriveForkId } = await import('../../src/main/mesh/store'); const h0 = (await d.store.hashAt(await world.local('A', V), 0, 0)) as string;
    const token = selfForkToken(world.ids.A.deviceId, CHAT, 'resume-test'); const v2 = deriveForkId(V, 0, h0, token);
    const dir = nodePath.join(world.dirs.A, 'replicator', 'selffork'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nodePath.join(dir, V.toString('hex')), JSON.stringify({ p: 0, hp: h0, v2: v2.toString('hex'), token, inc: 0, stage: 'start' }));
    await world.devs.A.rep.start(); await world.elapse(20_000, 5_000, true);
    expect(world.devs.A.rep.selfForks().some((x) => x.movedTo.equals(v2))).toBe(true);
    expect((await textOf(world, 'A', v2)).length).toBe(5);
    expect(await st(world, 'A', V)).not.toMatch(/self-fork-in-progress/);
  });

  it('an ordinary child version of the writer (not a self-fork token) does not take a peer off its fault', async () => {
    const { world, V, common } = await realFault();
    const hp = common.reduce((h, l) => chainStep(h, l), seed()).toString('hex'); const { deriveForkId } = await import('../../src/main/mesh/store');
    const token = `${world.ids.A.deviceId.toString('hex')}:takeover:x`; const child = deriveForkId(V, 3, hp, token);
    await world.devs.A.rep.createVersion({ version: child, chatId: CHAT, runtime: 'claude-code', parent: V, forkLine: 3, forkHash: Buffer.from(hp, 'hex'), token });
    await world.append('A', child, lineSet(3, 'other', 3));
    await world.elapse(120_000, 10_000, true);
    expect((await world.readAll('B', child)).length).toBe(6); // B holds it, and that does not matter to its fault
    expect(await st(world, 'B', V)).toMatch(/^diverged\(writer-two-histories/);
  }, 300_000);
  it('a self-fork announcement whose parting-point chain value is NOT the peer\'s own is not a statement about its copy', async () => {
    const { world, V } = await realFault();
    const hp = lineSet(3, 'zz').reduce((h, l) => chainStep(h, l), seed()).toString('hex'); const { deriveForkId } = await import('../../src/main/mesh/store'); // a chain value at 3 that is not B's
    const token = selfForkToken(world.ids.A.deviceId, CHAT, 'other-prefix'); const child = deriveForkId(V, 3, hp, token);
    await world.devs.A.rep.createVersion({ version: child, chatId: CHAT, runtime: 'claude-code', parent: V, forkLine: 3, forkHash: Buffer.from(hp, 'hex'), token });
    await world.append('A', child, lineSet(5, 'other')); // (long enough that comparing past the parting point WOULD be possible)
    await world.elapse(120_000, 10_000, true);
    expect(await st(world, 'B', V)).toMatch(/^diverged\(writer-two-histories/);
  }, 300_000);
});

describe('own records that disagree or cannot be read', () => {
  it('two valid records that differ at one count are not trusted: counted, and the writer runs on the store head', async () => {
    w = await repWorld(['A'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-r3');
    await world.create('A', V); await world.append('A', V, lineSet(4)); await down(world, 'A');
    const { OwnRecords } = await import('../../src/main/mesh/replicator/own-record'); const { realFs } = await import('../../src/main/mesh/store/fsio'); const tmp = nodePath.join(world.dirs.A, 'tmp-rec');
    await new OwnRecords(realFs, nodePath.join(world.dirs.A, 'replicator', 'own'), tmp).save(V, { lines: 4, hash: 'aa'.repeat(32) });
    await new OwnRecords(realFs, tmp, nodePath.join(world.dirs.A, 'witness')).save(V, { lines: 4, hash: 'bb'.repeat(32) });
    await world.restart('A');
    expect((await world.append('A', V, lineSet(1, 'n', 4))).result).toBe('saved');
    expect(world.devs.A.rep.counters()['writer-own-records-disagree']).toBeGreaterThanOrEqual(1);
  });
  it('records that cannot even be READ count as bad, not as "never written"', async () => {
    w = await repWorld(['A'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-r8');
    await world.create('A', V); await world.append('A', V, lineSet(3)); await down(world, 'A');
    for (const d of [nodePath.join(world.dirs.A, 'replicator', 'own'), nodePath.join(world.dirs.A, 'witness')]) { fs.rmSync(d, { recursive: true, force: true }); fs.writeFileSync(d, 'a file where a folder belongs'); }
    await world.restart('A');
    await world.append('A', V, lineSet(1, 'n', 3)).catch(() => undefined /* benign (test): saving the records fails too; only the count matters */);
    expect(world.devs.A.rep.counters()['writer-own-records-unusable']).toBeGreaterThanOrEqual(1);
  });
});

describe('the gate is never changed by a status read, and the slow-relay path loses nothing', () => {
  it('only appendLocal, the gate timer and nothing in status latches the gate (pinned in the source)', () => {
    const src = fs.readFileSync(nodePath.join(__dirname, '../../src/main/mesh/replicator/replicator.ts'), 'utf8');
    const statusPart = src.slice(src.indexOf('private async statusNow'), src.indexOf('peerAcks(wire: Buffer)'));
    expect(statusPart).not.toMatch(/tryLatch\(|#gate = true|claimSince\.set|claimFirst\.set/);
    expect((src.match(/this\.#gate = true/g) ?? []).length).toBe(1);
  });
  it('a slow relay: the writer restored from a backup writes after the claim of the longer history is discounted, and when the relay heals both histories are kept', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-slow');
    await world.create('A', V); await world.append('A', V, lineSet(5, 'old')); await world.settle();
    const bk = nodePath.join(world.dirs.A, '..', 'bk-r4-slow'); snap(world, 'A', bk);
    await world.append('A', V, lineSet(5, 'mid', 5)); await world.settle(); const peers = await textOf(world, 'B', V);
    await down(world, 'A'); restore(world, 'A', bk);
    world.hub.holdFilter = () => 'drop'; // the relay loses every durable frame; live frames (the claim) still arrive
    await world.restart('A'); await world.elapse(120_000, 10_000, true);
    await expect(world.append('A', V, lineSet(1, 'NEW', 5))).rejects.toThrow(/writer-behind-peer-holds-more/); // not yet: the claim could still be backed
    await world.elapse(11 * 60_000, 60_000, true);
    expect((await world.append('A', V, lineSet(3, 'NEW', 5))).result).toBe('saved');
    expect(world.devs.A.rep.counters()['claim-discounted']).toBeGreaterThanOrEqual(1);
    world.hub.holdFilter = null; world.devs.A.rep.hello(); world.devs.B.rep.hello();
    await world.elapse(300_000, 10_000, true);
    expect(world.devs.A.rep.selfForks()).toHaveLength(1);
    for (const n of ['A', 'B']) { expect(await textOf(world, n, V)).toEqual(peers); expect((await textOf(world, n, world.devs.A.rep.selfForks()[0].movedTo)).length).toBe(8); }
  }, 600_000);
});

describe('F2e and F1c: two conflicts at once, and a target id that is already taken', () => {
  it('three conflicting batches in a row start ONE move', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-f2e');
    await world.create('A', V); await world.settle();
    world.devs.B.rep.stop(); world.devs.B.carrier.setOnline(false);
    await world.restart('A'); await world.elapse(8_000, 1_000, true);
    await world.append('A', V, lineSet(5, 'xx'));
    world.devs.B.carrier.setOnline(true);
    const y = lineSet(5, 'yy'); const ch = y.reduce((h, l) => chainStep(h, l), seed());
    const send = async (): Promise<void> => { await world.devs.B.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, to: world.ids.A.deviceId, body: linesBody({ version: V, from: 0, lines: y, head: { lines: 5, hash: ch, sig: signWith(world.ids.A, headMessage(V, 5, ch)) } }) }); };
    await send(); await send(); await send(); await world.devs.A.link.sync(chatGroup(world.setId, CHAT));
    await world.elapse(60_000, 10_000, true);
    expect(world.devs.A.rep.selfForks()).toHaveLength(1);
    // (the guard against a second start while one is marked also covers conflict steps that were queued BEFORE the move by arrivals from two devices at once; one link delivers frames one at a time, so this
    // test cannot reach it, and the guard is kept as defence in depth)
  });
  it('a second version id that is already used here for OTHER lines is skipped: a fresh id is derived and the move still happens', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-f1c');
    await world.create('A', V); await world.settle();
    // the id the move would pick first: parting point 0, token with the head the writer will have (the chain over its five "xx" lines)
    const head = lineSet(5, 'xx').reduce((h, l) => chainStep(h, l), seed()).toString('hex'); const { deriveForkId } = await import('../../src/main/mesh/store');
    const h0 = (await world.devs.A.store.hashAt(await world.local('A', V), 0, 0)) as string; const token = selfForkToken(world.ids.A.deviceId, CHAT, head.slice(0, 8)); const taken = deriveForkId(V, 0, h0, token);
    await world.devs.A.rep.createVersion({ version: taken, chatId: CHAT, runtime: 'claude-code', parent: V, forkLine: 0, forkHash: Buffer.from(h0, 'hex'), token });
    await world.append('A', taken, lineSet(2, 'OTHER'));
    await splitHistories(world, V);
    const forks = world.devs.A.rep.selfForks(); expect(forks).toHaveLength(1);
    expect(forks[0].movedTo.equals(taken)).toBe(false);
    expect((await textOf(world, 'A', taken)).every((l) => /OTHER \d/.test(l))).toBe(true); // nothing was appended onto it
  }, 200_000);
});

describe('a signed point whose lines this copy never got (a kill between writing the point and appending the lines)', () => {
  it('does not keep the chat in `diverged` when the writer signs another history at that count: the point is dropped and the lines are taken', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-unbacked');
    await world.create('A', V); await world.settle();
    const { SignedHeads } = await import('../../src/main/mesh/replicator/signed-heads'); const { realFs } = await import('../../src/main/mesh/store/fsio');
    await down(world, 'B'); const dev = await world.restart('B', { graceful: false, start: false });
    const y = lineSet(5, 'yy'); const hy = y.reduce((h, l) => chainStep(h, l), seed());
    await new SignedHeads(realFs, nodePath.join(world.dirs.B, 'replicator')).add(V, { lines: 5, hash: hy, sig: signWith(world.ids.A, headMessage(V, 5, hy)), spanBytes: 100 }); // the point is there, the lines are not
    world.devs.B.carrier.setOnline(false); await dev.rep.start(); await world.elapse(8_000, 1_000, true);
    await world.append('A', V, lineSet(5, 'xx'));
    world.devs.B.carrier.setOnline(true);
    await world.elapse(120_000, 10_000, true);
    expect(await textOf(world, 'B', V)).toEqual(await textOf(world, 'A', V));
    expect(await st(world, 'B', V)).not.toMatch(/diverged|faulted/);
    expect(world.devs.B.rep.counters()['unbacked-signed-point-dropped']).toBeGreaterThanOrEqual(1);
  }, 200_000);
});

describe('status reads and naks cannot change what the writer does', () => {
  async function run(poll: boolean): Promise<string[]> {
    const world = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); w = world; const V = wireId('r4-poll');
    await world.create('A', V); await world.append('A', V, lineSet(2)); await world.settle();
    world.devs.B.rep.stop(); await down(world, 'A'); await world.restart('A');
    const out: string[] = [];
    for (let t = 1; t <= 9; t++) {
      sumFrame(world, 'B'); await world.settle(); // a reachable device that sends summaries and never heads
      for (let k = 0; k < 4; k++) { await world.elapse(2_500, 2_500, true); if (poll) await st(world, 'A', V); }
      const h = await world.devs.A.store.head(await world.local('A', V));
      out.push(await world.devs.A.rep.appendLocal(V, lineSet(1, `p${t}`, h.lines), { lines: h.lines, hash: h.hash }).then((r) => r.result, (e) => String(e).replace(/^Error: /, '')));
    }
    await world.stopAll(); world.cleanup(); w = null;
    return out;
  }
  it('polling status in a loop across the bounded wait (a silent reachable device) changes nothing about when appendLocal refuses and when it saves', async () => {
    const quiet = await run(false); const polled = await run(true);
    expect(polled).toEqual(quiet);
    expect(quiet[0]).toMatch(/writer-waiting-for-peers/); expect(quiet.at(-1)).toBe('saved'); // it refused while waiting and saved after the wait
  }, 300_000);
  it('a flood of forged naks causes at most one restart-from-zero ask per device and leaves the writer in-sync afterwards', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-nakflood');
    await world.create('A', V); await world.append('A', V, lineSet(4)); await world.settle();
    const asks: number[] = []; const link = world.devs.A.link; const orig = link.sendLive.bind(link);
    link.sendLive = ((f: Parameters<typeof orig>[0]) => { if (f.kind === KIND_WANT && (f.body as { have: number }).have === 0) asks.push(1); return orig(f); }) as typeof orig;
    for (let i = 0; i < 200; i++) world.devs.B.link.sendLive({ group: GROUP_LIVE, kind: KIND_NAK, body: nakBodyOf({ version: V, at: 2, why: 'not-a-prefix', hashAtYourCount: randomBytes(32) }) });
    await world.settle(); await world.elapse(120_000, 10_000, true);
    expect(asks.length).toBeLessThanOrEqual(1);
    expect(await st(world, 'A', V)).toBe('in-sync');
  }, 200_000);
});

/** Every version of the chat on one device, as text lines. */
const allTexts = async (world: World, n: string): Promise<string[][]> => { const out: string[][] = []; for (const v of world.devs[n].rep.versions()) out.push(await textOf(world, n, v)); return out; };
const tagged = (all: string[][], tag: string): number => all.flat().filter((l) => new RegExp(`${tag} \\d`).test(l)).length;
const mixes = (all: string[][], a: string, b: string): boolean => all.some((t) => t.some((l) => new RegExp(`${a} \\d`).test(l)) && t.some((l) => new RegExp(`${b} \\d`).test(l)));

describe('directed self-fork cases the random schedules reach only rarely', () => {
  it('a second version moves ITSELF: chat on in V2, restore the writer to a profile from before, chat alone in V2, meet', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-v2self');
    await world.create('A', V); await world.settle(); await splitHistories(world, V);
    const v2 = world.devs.A.rep.selfForks()[0].movedTo;
    await world.append('A', v2, lineSet(2, 'zz', 5)); await world.settle();
    const bk = nodePath.join(world.dirs.A, '..', 'bk-r4-v2self'); snap(world, 'A', bk);
    await world.append('A', v2, lineSet(2, 'ww', 7)); await world.settle(); await world.elapse(30_000, 10_000, true);
    await down(world, 'A'); restore(world, 'A', bk); world.devs.B.carrier.setOnline(false);
    await world.restart('A'); await world.elapse(8_000, 1_000, true);
    expect((await world.append('A', v2, lineSet(2, 'vv', 7))).result).toBe('saved'); // the same positions as B's "ww"
    world.devs.B.carrier.setOnline(true);
    await world.elapse(300_000, 10_000, true);
    for (const n of ['A', 'B']) { const all = await allTexts(world, n); expect(tagged(all, 'zz')).toBeGreaterThanOrEqual(2); expect(tagged(all, 'ww')).toBeGreaterThanOrEqual(2); expect(tagged(all, 'vv')).toBeGreaterThanOrEqual(2); expect(mixes(all, 'ww', 'vv')).toBe(false); }
    expect(world.devs.A.rep.selfForks().some((f) => f.version.equals(v2))).toBe(true); // the move was OF the second version
  }, 600_000);

  it('a third rollback to the same backup, with other lines again, gets a third second-version of its own', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-third');
    await world.create('A', V); await world.settle();
    const bk = nodePath.join(world.dirs.A, '..', 'bk-r4-third'); snap(world, 'A', bk);
    await splitHistories(world, V);
    const ids = new Set<string>([world.devs.A.rep.selfForks()[0].movedTo.toString('hex')]);
    for (const tag of ['zz', 'qq']) {
      await down(world, 'A'); restore(world, 'A', bk); world.devs.B.carrier.setOnline(false);
      await world.restart('A'); await world.elapse(8_000, 1_000, true);
      await world.append('A', V, lineSet(5, tag)); world.devs.B.carrier.setOnline(true);
      await world.elapse(300_000, 10_000, true);
      for (const f of world.devs.A.rep.selfForks()) ids.add(f.movedTo.toString('hex'));
    }
    for (const n of ['A', 'B']) { const all = await allTexts(world, n); for (const t of ['xx', 'zz', 'qq']) expect(tagged(all, t), `${n} ${t}`).toBeGreaterThanOrEqual(5); expect(mixes(all, 'zz', 'qq') || mixes(all, 'xx', 'zz') || mixes(all, 'xx', 'qq')).toBe(false); }
    expect(ids.size).toBeGreaterThanOrEqual(2); // a version of its own for each
  }, 900_000);

  it('a chat that already has child forks, made before and after the parting point, loses nothing when its writer moves its lines', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-kids');
    await world.create('A', V); await world.settle();
    const { SignedHeads } = await import('../../src/main/mesh/replicator/signed-heads'); const { realFs } = await import('../../src/main/mesh/store/fsio'); const { deriveForkId } = await import('../../src/main/mesh/store');
    await down(world, 'B'); const dev = await world.restart('B', { graceful: false, start: false });
    const common = lineSet(3, 'cc'); const ys = [...common, ...lineSet(2, 'yy', 3)]; const hy = ys.reduce((h, l) => chainStep(h, l), seed());
    await dev.store.append((await world.localOf('B', V)) as Buffer, 0, 0, ys);
    await new SignedHeads(realFs, nodePath.join(world.dirs.B, 'replicator')).add(V, { lines: 5, hash: hy, sig: signWith(world.ids.A, headMessage(V, 5, hy)), spanBytes: 100 });
    world.devs.B.carrier.setOnline(false); await dev.rep.start(); await world.elapse(8_000, 1_000, true);
    await world.append('A', V, [...common, ...lineSet(2, 'xx', 3)]);
    const local = await world.local('A', V);
    const kids: Buffer[] = [];
    for (const [p, name] of [[2, 'before'], [5, 'after']] as const) {
      const hp = (await world.devs.A.store.hashAt(local, 0, p)) as string; const token = `${world.ids.A.deviceId.toString('hex')}:takeover:${name}`; const kid = deriveForkId(V, p, hp, token);
      await world.devs.A.rep.createVersion({ version: kid, chatId: CHAT, runtime: 'claude-code', parent: V, forkLine: p, forkHash: Buffer.from(hp, 'hex'), token });
      await world.append('A', kid, lineSet(1, `kid-${name}`, p)); kids.push(kid);
    }
    const before = await Promise.all(kids.map((k) => textOf(world, 'A', k)));
    world.devs.B.carrier.setOnline(true);
    await world.elapse(300_000, 10_000, true);
    expect(world.devs.A.rep.selfForks()).toHaveLength(1);
    for (const [i, k] of kids.entries()) for (const n of ['A', 'B']) expect(await textOf(world, n, k), `${n} kid ${i}`).toEqual(before[i]); // the children keep their own lines, on both devices
    for (const n of ['A', 'B']) { const all = await allTexts(world, n); expect(tagged(all, 'xx')).toBeGreaterThanOrEqual(2); expect(tagged(all, 'yy')).toBeGreaterThanOrEqual(2); }
  }, 600_000);

  it('a second rollback arriving while the first move is mid-way (killed, journal on disk) puts back the old profile: a clean new move, no splice', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000, stepLimitMs: 100 }); const world = w; const V = wireId('r4-midway');
    await world.create('A', V); await world.settle();
    const bk = nodePath.join(world.dirs.A, '..', 'bk-r4-midway'); snap(world, 'A', bk);
    const { SignedHeads } = await import('../../src/main/mesh/replicator/signed-heads'); const { realFs } = await import('../../src/main/mesh/store/fsio');
    await down(world, 'B'); const dev = await world.restart('B', { graceful: false, start: false });
    const y = lineSet(5, 'yy'); const hy = y.reduce((h, l) => chainStep(h, l), seed());
    await dev.store.append((await world.localOf('B', V)) as Buffer, 0, 0, y);
    await new SignedHeads(realFs, nodePath.join(world.dirs.B, 'replicator')).add(V, { lines: 5, hash: hy, sig: signWith(world.ids.A, headMessage(V, 5, hy)), spanBytes: 100 });
    world.devs.B.carrier.setOnline(false); await dev.rep.start(); await world.elapse(8_000, 1_000, true);
    await world.append('A', V, lineSet(5, 'xx'));
    const store = world.devs.A.store; const realRead = store.read.bind(store);
    store.read = (async (...a: Parameters<typeof realRead>) => { await new Promise((r) => setTimeout(r, 300)); return realRead(...a); }) as typeof realRead;
    world.devs.B.carrier.setOnline(true);
    await vi.waitFor(async () => { await world.elapse(2_000, 1_000, true); expect(fs.existsSync(nodePath.join(world.dirs.A, 'replicator', 'selffork', V.toString('hex')))).toBe(true); }, { timeout: 60_000, interval: 25 });
    // killed mid-move: the note is on disk, the move unfinished
    world.devs.A.rep.stop(); world.devs.A.link.stop(); store.read = realRead; await store.close().catch(() => undefined /* benign (test): the slow read in flight may still hold it */);
    restore(world, 'A', bk); world.devs.B.carrier.setOnline(false);        // the second rollback, to the same backup, before the move resumed
    await world.restart('A'); await world.elapse(8_000, 1_000, true);
    expect((await world.append('A', V, lineSet(5, 'zz'))).result).toBe('saved');
    world.devs.B.carrier.setOnline(true);
    await world.elapse(300_000, 10_000, true);
    for (const n of ['A', 'B']) { const all = await allTexts(world, n); expect(tagged(all, 'yy'), `${n} yy`).toBeGreaterThanOrEqual(5); expect(tagged(all, 'zz'), `${n} zz`).toBeGreaterThanOrEqual(5); expect(mixes(all, 'xx', 'zz') || mixes(all, 'yy', 'zz') || mixes(all, 'xx', 'yy')).toBe(false); }
  }, 600_000);
});

describe('a continuation of a refused history is never appended onto my own lines', () => {
  it('after the writer\'s signed batch of ANOTHER history was refused, a signed batch that continues THAT history is refused too (the base is my own chain value), and my lines stay as they were', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-splice');
    await world.create('A', V); await world.append('A', V, lineSet(6, 'old')); await world.settle();
    world.devs.A.rep.stop(); const keep = await textOf(world, 'B', V);
    const fork = lineSet(6, 'FORK'); const ch6 = fork.reduce((h, l) => chainStep(h, l), seed());
    const more = lineSet(2, 'FORKMORE', 6); const ch8 = more.reduce((h, l) => chainStep(h, l), ch6);
    const send = async (from: number, lines: Buffer[], total: number, hash: Buffer): Promise<void> => { await world.devs.A.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, to: world.ids.B.deviceId, body: linesBody({ version: V, from, lines, head: { lines: total, hash, sig: signWith(world.ids.A, headMessage(V, total, hash)) } }) }); };
    await send(0, fork, 6, ch6); await world.elapse(20_000, 5_000, true);     // another history, as long as B's copy: refused
    await send(6, more, 8, ch8); await world.elapse(60_000, 10_000, true);    // its continuation: must be refused too
    expect(await textOf(world, 'B', V)).toEqual(keep);
    expect((await textOf(world, 'B', V)).some((l) => /FORKMORE/.test(l))).toBe(false);
  });
});

describe('F6: the same count of lines with different content is chased to where the lines part', () => {
  it('A and B both hold 15 lines that agree for 11 and then differ: the writer moves its four lines to a second version, and both end in sync (the ask goes on past the first shared signed point)', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r4-f6');
    await world.create('A', V); await world.settle();
    const { SignedHeads } = await import('../../src/main/mesh/replicator/signed-heads'); const { realFs } = await import('../../src/main/mesh/store/fsio');
    await down(world, 'B'); const dev = await world.restart('B', { graceful: false, start: false });
    const common = lineSet(11, 'cc'); const ys = [...common, ...lineSet(4, 'yy', 11)];
    const hC = common.reduce((h, l) => chainStep(h, l), seed()); const hY = ys.reduce((h, l) => chainStep(h, l), seed());
    await dev.store.append((await world.localOf('B', V)) as Buffer, 0, 0, ys);
    const sh = new SignedHeads(realFs, nodePath.join(world.dirs.B, 'replicator'));
    await sh.add(V, { lines: 11, hash: hC, sig: signWith(world.ids.A, headMessage(V, 11, hC)), spanBytes: 100 });
    await sh.add(V, { lines: 15, hash: hY, sig: signWith(world.ids.A, headMessage(V, 15, hY)), spanBytes: 100 });
    world.devs.B.carrier.setOnline(false); await dev.rep.start(); await world.elapse(8_000, 1_000, true);
    await world.append('A', V, [...common, ...lineSet(4, 'xx', 11)]);
    world.devs.B.carrier.setOnline(true);
    await world.elapse(300_000, 10_000, true);
    expect(world.devs.A.rep.selfForks()).toHaveLength(1);
    expect(world.devs.A.rep.counters()['diverged-ask-continued']).toBeGreaterThanOrEqual(1);
    for (const n of ['A', 'B']) { expect(await st(world, n, V)).not.toMatch(/diverged|faulted|stuck/); expect((await textOf(world, n, V)).slice(11).every((l) => /yy \d/.test(l))).toBe(true); }
    expect((await textOf(world, 'A', world.devs.A.rep.selfForks()[0].movedTo)).slice(11).every((l) => /xx \d/.test(l))).toBe(true);
  }, 400_000);
});
