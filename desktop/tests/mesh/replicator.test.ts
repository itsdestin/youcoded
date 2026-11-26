// Replicator scenarios over the in-memory world (tests/mesh/replicator-world.ts): real Link, real crypto, real chat store per device.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repWorld, wireId, lineSet, line, CHAT, type World } from './replicator-world';
import { chatGroup } from '../../src/main/mesh/replicator/ctx';

let w: World | null = null;
afterEach(async () => { await w?.stopAll(); w = null; });
const converge = async (world: World, v: Buffer, names: string[]): Promise<void> => {
  await vi.waitFor(async () => { const h = await Promise.all(names.map((n) => world.heads(n, v))); for (const x of h) expect(x).toEqual(h[0]); expect(h[0].lines).toBeGreaterThan(0); });
  await world.settle();
};
const sameBytes = async (world: World, v: Buffer, names: string[]): Promise<void> => {
  const all = await Promise.all(names.map((n) => world.readAll(n, v)));
  for (const a of all) expect(a).toEqual(all[0]);
};

// WHY 300_000 (measured 2026-11-26): seconds alone, but this overran 120 s when the whole suite ran at load 75 on 32 threads. These are
// pure disk-and-CPU loops with no waiting on anything, so the limit only has to catch a hang.
const HANG_ONLY_TIMEOUT_MS = 300_000;
describe('devices that are online', () => {
  it('two devices: lines the writer appends reach the other, byte for byte, with equal heads and verify() ok', async () => {
    w = await repWorld(['A', 'B']);
    const V = wireId(1);
    await w.create('A', V);
    const lines = lineSet(5);
    await w.devs.A.rep.appendLocal(V, lines);
    await converge(w, V, ['A', 'B']);
    expect(await w.readAll('B', V)).toEqual(lines);
    expect((await w.devs.B.rep.status(V)).state).toBe('in-sync');
    const lb = (await w.localOf('B', V)) as Buffer;
    expect((await w.devs.B.store.verify(lb)).ok).toBe(true);
    expect((await w.devs.B.store.head(lb)).conversationHash).toBe((await w.devs.A.store.head((await w.localOf('A', V)) as Buffer)).conversationHash);
  });
  it('three devices: everyone ends with the same lines, and a device that was never told about the chat learns it from its peers', async () => {
    w = await repWorld(['A', 'B', 'C']);
    const V = wireId(2);
    await w.create('A', V);
    for (let i = 0; i < 6; i++) await w.devs.A.rep.appendLocal(V, lineSet(3, 'k', i * 3));
    await converge(w, V, ['A', 'B', 'C']);
    await sameBytes(w, V, ['A', 'B', 'C']);
    expect((await w.heads('C', V)).lines).toBe(18);
  });
  it('only the named writer can append: another device is refused, and nothing changes anywhere', async () => {
    w = await repWorld(['A', 'B']);
    const V = wireId(3);
    await w.create('A', V);
    await w.settle();
    await expect(w.devs.B.rep.appendLocal(V, lineSet(1))).rejects.toThrow('not-the-writer');
    expect((await w.heads('A', V)).lines).toBe(0);
  });
  it('a 5 MiB line crosses in parts and arrives byte for byte between normal lines', async () => {
    w = await repWorld(['A', 'B']);
    const V = wireId(4);
    await w.create('A', V);
    const big = Buffer.from(`${JSON.stringify({ type: 'user', message: { content: 'q'.repeat(5 * 1024 * 1024) } })}\n`);
    const lines = [line('before', 0), big, line('after', 1)];
    await w.devs.A.rep.appendLocal(V, lines);
    await vi.waitFor(async () => expect((await w!.heads('B', V)).lines).toBe(3), { timeout: 60_000 });
    await w.settle();
    expect(await w.readAll('B', V)).toEqual(lines);
    expect(w.devs.B.rep.counters()['part-over-budget'] ?? 0).toBe(0);
  }, HANG_ONLY_TIMEOUT_MS);
});

describe('a device that was away', () => {
  it('B offline for 24 virtual hours while A keeps writing: B catches up exactly, with no duplicates, when it returns', async () => {
    w = await repWorld(['A', 'B']);
    const V = wireId(5);
    await w.create('A', V);
    await w.devs.A.rep.appendLocal(V, lineSet(10));
    await converge(w, V, ['A', 'B']);
    w.devs.B.carrier.setOnline(false);
    for (let h = 0; h < 24; h++) { await w.devs.A.rep.appendLocal(V, lineSet(4, `h${h}`, 10 + h * 4)); await w.clock.advance(3_600_000); }
    await w.settle();
    expect((await w.heads('B', V)).lines).toBe(10);
    w.devs.B.carrier.setOnline(true);
    await vi.waitFor(async () => expect((await w!.heads('B', V)).lines).toBe(106));
    await w.settle();
    await sameBytes(w, V, ['A', 'B']);
    expect(await w.heads('B', V)).toEqual(await w.heads('A', V));
  });
  it('the same, but the relay released the frames B had not collected (a gap): B asks A for the lines instead', async () => {
    w = await repWorld(['A', 'B']);
    const V = wireId(6);
    await w.create('A', V);
    await w.devs.A.rep.appendLocal(V, lineSet(10));
    await converge(w, V, ['A', 'B']);
    w.devs.B.carrier.setOnline(false);
    for (let i = 0; i < 12; i++) await w.devs.A.rep.appendLocal(V, lineSet(3, `g${i}`, 10 + i * 3));
    await w.settle();
    const group = chatGroup(w.setId, CHAT);
    w.hub.releaseThrough(group, 1_000_000); // everything held for B is gone
    await w.clock.advance(3 * 24 * 3_600_000); // WHY three days: the relay keeps frames 30 days, the hub's release is what makes the gap; each virtual minute costs a periodic hello
    w.devs.B.carrier.setOnline(true);
    await vi.waitFor(async () => expect((await w!.heads('B', V)).lines).toBe(46));
    await w.settle();
    await sameBytes(w, V, ['A', 'B']);
  });
});
