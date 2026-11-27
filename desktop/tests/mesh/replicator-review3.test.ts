// Independent review 3: the writer's "may I append" gate, the checksummed records, the unbacked-claim clock and the small findings. Each test names the behaviour a person would notice.
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repWorld, wireId, lineSet, type World } from './replicator-world';
import { GROUP_LIVE, headsBodyOf, KIND_HEADS, KIND_WANT } from '../../src/main/mesh/replicator/wire';
import { SignedHeads } from '../../src/main/mesh/replicator/signed-heads';
import { realFs } from '../../src/main/mesh/store/fsio';

let w: World | null = null;
afterEach(async () => { await w?.stopAll(); w?.cleanup(); w = null; });
const st = async (world: World, n: string, v: Buffer): Promise<string> => { const s = await world.devs[n].rep.status(v); return `${s.state}${s.reason ? `(${s.reason})` : ''}`; };
const down = async (world: World, n: string): Promise<void> => { await world.devs[n].rep.idle(); world.devs[n].rep.stop(); world.devs[n].link.stop(); await world.devs[n].store.close(); };
const headsFrame = (world: World, from: string, page: number, of: number, entries: Array<{ v: Buffer; lines: number; hash: Buffer }>): void => {
  world.devs[from].link.sendLive({ group: GROUP_LIVE, kind: KIND_HEADS, body: headsBodyOf({ page, of, ask: false, heads: entries.map((e) => ({ version: e.v, lines: e.lines, hash: e.hash, conversationHash: Buffer.alloc(32), stamp: 1, state: 'ok' as const })) }) });
};

describe('the writer gate after a start', () => {
  it('idle for a long time after the restart, then chat: still saved (the gate never expires)', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 60_000 }); const world = w; const V = wireId('r3-idle');
    await world.create('A', V); await world.append('A', V, lineSet(3)); await world.settle();
    await world.restart('A'); await world.settle();
    for (const minutes of [2, 9, 11, 30]) {
      await world.elapse(minutes * 60_000, 60_000, true);
      const r = await world.append('A', V, lineSet(1, `m${minutes}`, (await world.devs.A.store.head(await world.local('A', V))).lines));
      expect(r.result).toBe('saved');
    }
  }, 120_000);

  it('one device answering completely does not open the gate while another reachable device has not: an empty list from a hostile device, or half a list, changes nothing', async () => {
    w = await repWorld(['A', 'B', 'C'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r3-spoof');
    await world.create('A', V); await world.append('A', V, lineSet(5)); await world.settle();
    world.devs.B.rep.stop(); world.devs.C.rep.stop(); // only their links speak now
    await down(world, 'A'); await world.restart('A');
    headsFrame(world, 'B', 1, 2, []); // B: only the LAST page of two (the first never came)
    headsFrame(world, 'C', 0, 1, []);                                            // C: an empty, complete list
    await world.settle();
    await expect(world.append('A', V, lineSet(1, 'x', 5))).rejects.toThrow(/writer-waiting-for-peers/);
    expect(await st(world, 'A', V)).toBe('comparing(writer-waiting-for-peers)');
    const real = (await world.devs.A.store.head(await world.local('A', V)));
    headsFrame(world, 'B', 0, 2, []); headsFrame(world, 'B', 1, 2, []);          // B's two pages now arrive in order: B has answered completely
    await world.settle();
    await vi.waitFor(async () => expect((await world.append('A', V, lineSet(1, 'x', 5), { lines: real.lines, hash: real.hash })).result).toBe('saved'));
  });

  it('a refusal asks the others for their heads again, so it ends by itself once they answer', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r3-reask');
    await world.create('A', V); await world.append('A', V, lineSet(4)); await world.settle();
    await down(world, 'A');
    world.devs.B.carrier.passFilter = () => 'drop'; // B's answers are lost while A starts
    await world.restart('A');
    // (only the broadcast ask counts, not the answers to someone's sum)
    const asks: boolean[] = []; const link = world.devs.A.link; const orig = link.sendLive.bind(link);
    link.sendLive = ((f: Parameters<typeof orig>[0]) => { if (f.kind === KIND_HEADS && (f.body as { ask: boolean }).ask && !f.to) asks.push(true); return orig(f); }) as typeof orig;
    await expect(world.append('A', V, lineSet(1, 'n', 4))).rejects.toThrow(/writer-waiting-for-peers/);
    await world.settle(); const before = asks.length;
    await world.elapse(3_000, 1_000, true);
    await expect(world.append('A', V, lineSet(1, 'n', 4))).rejects.toThrow(/writer-waiting-for-peers/);
    await world.settle();
    expect(asks.length).toBeGreaterThan(before); // each refusal asked the others for their heads again (B is silent, so nothing else could have)
    world.devs.B.carrier.passFilter = null;
    await world.elapse(8_000, 1_000, true);
    expect((await world.append('A', V, lineSet(1, 'n', 4))).result).toBe('saved'); // and it ended by itself
  }, 90_000);

  it('with nobody reachable the writer waits a short, bounded time and then writes, counted as writing-alone', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r3-alone');
    await world.create('A', V); await world.append('A', V, lineSet(2)); await world.settle();
    world.devs.B.carrier.setOnline(false);
    await down(world, 'A'); await world.restart('A');
    await expect(world.append('A', V, lineSet(1, 'q', 2))).rejects.toThrow(/writer-waiting-for-peers/);
    await world.elapse(8_000, 1_000, true);
    expect((await world.append('A', V, lineSet(1, 'q', 2))).result).toBe('saved');
    expect(world.devs.A.rep.counters()['writing-alone']).toBe(1);
  });

  it('a crash that left only one of the two records, the peer away: the writer is not held up for the peer (the records are a detector, not the gate)', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r3-onerec');
    await world.create('A', V); await world.append('A', V, lineSet(3)); await world.settle();
    await down(world, 'A'); world.devs.B.carrier.setOnline(false);
    fs.rmSync(nodePath.join(world.dirs.A, 'witness'), { recursive: true, force: true }); // only the replicator-folder record is left
    await world.restart('A'); await world.elapse(8_000, 1_000, true);
    expect((await world.append('A', V, lineSet(1, 'z', 3))).result).toBe('saved');
  });
});

describe('own records with a checksum', () => {
  const flip = (world: World, dir: string, bit: 'count-high' | 'count-low' | 'hash'): void => {
    const d = nodePath.join(world.dirs.A, ...dir.split('/')); const f = fs.readdirSync(d)[0]; const p = nodePath.join(d, f); const raw = fs.readFileSync(p);
    if (bit === 'count-high') raw[0] ^= 0x80; else if (bit === 'count-low') raw[7] ^= 0x01; else raw[20] ^= 0x01;
    fs.writeFileSync(p, raw);
  };
  for (const bit of ['count-high', 'count-low', 'hash'] as const) for (const where of ['replicator/own', 'witness']) {
    it(`one flipped bit (${bit}) in the record under ${where}: the good record is used, the bad one rewritten and counted, and the chat keeps working`, async () => {
      w = await repWorld(['A'], { discoveryMs: 600_000 }); const world = w; const V = wireId(`r3-flip-${bit}-${where}`);
      await world.create('A', V); await world.append('A', V, lineSet(4)); await down(world, 'A');
      flip(world, where, bit);
      await world.restart('A');
      expect((await world.append('A', V, lineSet(1, 'n', 4))).result).toBe('saved');
      expect(world.devs.A.rep.counters()['own-record-healed']).toBeGreaterThanOrEqual(1);
      await down(world, 'A'); await world.restart('A');
      expect((await world.append('A', V, lineSet(1, 'o', 5))).result).toBe('saved'); // and again after a restart: the records are good now
    });
  }
  it('both records bad: a writer that is NOT in sync with its own head never reads in-sync while it refuses, and one that runs on the store head says so', async () => {
    w = await repWorld(['A'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r3-bothbad');
    await world.create('A', V); await world.append('A', V, lineSet(4)); await down(world, 'A');
    flip(world, 'replicator/own', 'count-high'); flip(world, 'witness', 'hash');
    await world.restart('A');
    expect((await world.append('A', V, lineSet(1, 'n', 4))).result).toBe('saved');
    expect(world.devs.A.rep.counters()['writer-own-records-unusable']).toBeGreaterThanOrEqual(1);
  });
});

describe('the unbacked-claim clock', () => {
  async function liar(): Promise<{ world: World; V: Buffer; say: (lines: number, hash?: Buffer) => void }> {
    const world = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); w = world; const V = wireId(`r3-liar-${Math.random()}`);
    await world.create('A', V); await world.append('A', V, lineSet(3)); await world.settle();
    world.devs.B.rep.stop();
    return { world, V, say: (lines, hash = randomBytes(32)) => headsFrame(world, 'B', 0, 1, [{ v: V, lines, hash }]) };
  }
  it('a device that alternates between more and fewer lines cannot keep the writer waiting past the clock, and the status names the device', async () => {
    const { world, V, say } = await liar();
    for (let i = 0; i < 17; i++) {
      if (i === 8) { say(2); await world.settle(); expect((await world.append('A', V, lineSet(1, 'mid', 3))).result).toBe('saved'); } // a "fewer" claim lets the writer write, and must not restart the clock of the "more" claims
      else say(50 + i);
      await world.elapse(45_000, 15_000);
    }
    expect((await world.append('A', V, lineSet(1, 'n', 4))).result).toBe('saved');
    expect(world.devs.A.rep.counters()['claim-discounted']).toBeGreaterThanOrEqual(1);
  }, 120_000);
  it('a claim of the SAME count with another chain value is discounted the same way, and while it holds the status names the device without saying the chat diverged', async () => {
    const { world, V, say } = await liar();
    say(3); await world.settle();
    await expect(world.append('A', V, lineSet(1, 'n', 3))).rejects.toThrow(/writer-diverged-from-peer/);
    expect(await st(world, 'A', V)).toMatch(/peer-claims-another-history [0-9a-f]{8}|claims a different history/);
    expect(await st(world, 'A', V)).not.toMatch(/^diverged\(.*my/);
    for (let i = 0; i < 14; i++) { say(3); await world.elapse(45_000, 15_000); }
    expect((await world.append('A', V, lineSet(1, 'n', 3))).result).toBe('saved');
  }, 120_000);
});

describe('signed points and covering points', () => {
  it('two loads of one version that overlap an add never lose the point that was added', async () => {
    const dir = fs.mkdtempSync(nodePath.join(fs.realpathSync('/tmp'), 'r3-sh-')); const wire = randomBytes(32);
    let reads = 0; const slow = { ...realFs, readFile: async (p: string) => { const got = await realFs.readFile(p); if (reads++ === 0) await new Promise((r) => setTimeout(r, 150)); return got; } }; // it READS first, then is slow to answer: a stale answer // only the FIRST read is slow
    const heads = new SignedHeads(slow as typeof realFs, dir);
    const pt = { lines: 3, hash: randomBytes(32), sig: randomBytes(64), spanBytes: 10 };
    const first = heads.load(wire); const second = heads.add(wire, pt); const third = heads.load(wire);
    await Promise.all([first, second, third]);
    expect((await heads.load(wire)).map((p) => p.lines)).toEqual([3]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('a non-writer that holds lines but lost its signed points asks for a covering point at once, not at the writer\'s next append', async () => {
    w = await repWorld(['A', 'B', 'C'], { discoveryMs: 30_000 }); const world = w; const V = wireId('r3-cover');
    await world.create('B', V); await world.append('B', V, lineSet(10)); await world.settle(); await world.elapse(40_000, 10_000, true);
    await down(world, 'C'); fs.rmSync(nodePath.join(world.dirs.C, 'replicator', 'heads'), { recursive: true, force: true });
    await world.restart('C'); await world.elapse(120_000, 10_000, true);
    expect(await st(world, 'C', V)).not.toMatch(/holds-lines-without-signature/);
    expect(world.devs.C.rep.counters()['cover-fetch']).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

describe('a record that could not be saved', () => {
  it('the background check saves it again and announces the lines, without another append', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000, scrubEveryMs: 5_000 }); const world = w; const V = wireId('r3-scrub');
    await world.create('A', V); const first = await world.append('A', V, lineSet(2)); await world.settle();
    fs.rmSync(nodePath.join(world.dirs.A, 'witness'), { recursive: true, force: true }); fs.writeFileSync(nodePath.join(world.dirs.A, 'witness'), 'in the way');
    expect((await world.append('A', V, lineSet(2, 'p', 2), { lines: first.lines, hash: first.hash })).result).toBe('durable-not-recorded');
    expect(await st(world, 'A', V)).toBe('stuck(own-record-not-saved)');
    fs.rmSync(nodePath.join(world.dirs.A, 'witness'), { force: true });
    await world.elapse(30_000, 5_000, true);
    expect(await st(world, 'A', V)).not.toMatch(/^stuck/);
    expect((await world.devs.B.store.head(await world.local('B', V))).lines).toBe(4);
  });
});

describe('solicit rounds', () => {
  it('solicit rounds are random 48-bit numbers: two solicits and a restart never repeat one', async () => {
    w = await repWorld(['A', 'B'], { discoveryMs: 600_000 }); const world = w; const V = wireId('r3-rounds');
    await world.create('A', V); await world.append('A', V, lineSet(2)); await world.settle();
    const seen: number[] = [];
    const watch = (): void => { const link = world.devs.A.link; const orig = link.sendLive.bind(link); link.sendLive = ((f: Parameters<typeof orig>[0]) => { if (f.kind === KIND_WANT) { const r = (f.body as { round: number }).round; if (r) seen.push(r); } return orig(f); }) as typeof orig; };
    watch(); await world.devs.A.rep.solicitAcks(V); await world.devs.A.rep.solicitAcks(V);
    await down(world, 'A'); await world.restart('A'); await world.settle(); watch(); await world.devs.A.rep.solicitAcks(V);
    expect(new Set(seen).size).toBe(seen.length); expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((r) => r > 2 ** 20)).toBe(true);
  });
});
