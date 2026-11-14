// S2 behaviour tests. Crash, truncation, property and performance tests are in their own files.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatStore } from './store';
import { StoreError } from './errors';
import { ccConversation, cc, nativeConversation, awkward, native } from './fixtures';
import { CHAT, V, openWith, refChains, tmpRoot, listFiles } from './testkit';
import { defaultChainSeeds, type ChainSeedFn } from './chain';

let t: Awaited<ReturnType<typeof tmpRoot>>;
beforeEach(async () => { t = await tmpRoot(); });
afterEach(async () => { await t.cleanup(); });

const rejects = async (p: Promise<unknown>, code: string) => { await expect(p).rejects.toMatchObject({ name: 'StoreError', code }); };

describe('append / head / hashAt / read', () => {
  it('stores lines, matches the independent chains, reads ranges back byte for byte', async () => {
    const { lines } = ccConversation();
    const s = await openWith(t.dir);
    expect(await s.append(V(1), 0, 0, lines)).toBe('ok');
    const ref = refChains(lines);
    const head = await s.head(V(1));
    expect(head).toMatchObject({ lines: lines.length, hash: ref.raw[lines.length], conversationHash: ref.conv, conversationLines: ref.convLines, evictedLines: 0 });
    for (const n of [0, 1, 5, lines.length]) expect(await s.hashAt(V(1), 0, n)).toBe(ref.raw[n]);
    expect(await s.hashAt(V(1), 0, lines.length + 1)).toBeNull();
    const got = await s.read(V(1), 0, 3, 9);
    expect((got as Buffer[]).map((b) => b.toString('hex'))).toEqual(lines.slice(3, 9).map((b) => b.toString('hex')));
    expect(await s.read(V(1), 0, 5, 5)).toEqual([]);
    expect((await s.read(V(1), 0, lines.length - 1, lines.length + 50) as Buffer[]).length).toBe(1);
  });

  it('segment must be 0; version must be registered; lines must be whole lines', async () => {
    const s = await openWith(t.dir);
    await rejects(Promise.resolve().then(() => s.append(V(1), 1, 0, [])), 'bad-argument');
    await rejects(s.head(V(9)), 'unknown-version');
    await rejects(Promise.resolve().then(() => s.append(V(1), 0, 0, [Buffer.from('no newline')])), 'bad-line');
    await rejects(Promise.resolve().then(() => s.append(V(1), 0, 0, [Buffer.from('two\nlines\n')])), 'bad-line');
    await rejects(Promise.resolve().then(() => s.append(V(1), 0, 0, [Buffer.alloc(0)])), 'bad-line');
    expect((await s.head(V(1))).lines).toBe(0); // a rejected call changed nothing
  });

  it('is idempotent: repeating, overlapping and extending calls converge; differing bytes are not-a-prefix', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => cc.user('m' + i));
    const s = await openWith(t.dir);
    expect(await s.append(V(1), 0, 0, lines.slice(0, 6))).toBe('ok');
    expect(await s.append(V(1), 0, 0, lines.slice(0, 6))).toBe('ok');
    expect(await s.append(V(1), 0, 2, lines.slice(2, 10))).toBe('ok'); // overlap + extension
    expect((await s.head(V(1))).hash).toBe(refChains(lines).raw[10]);
    const before = await s.head(V(1));
    const tampered = Buffer.from(lines[4]); tampered[tampered.length - 3] ^= 0x01;
    expect(await s.append(V(1), 0, 3, [lines[3], tampered, lines[5]])).toBe('not-a-prefix');
    expect(await s.append(V(1), 0, 0, [cc.user('different first line')])).toBe('not-a-prefix');
    expect(await s.head(V(1))).toEqual(before);
    expect(await s.append(V(1), 0, 10, [])).toBe('ok');
  });

  it('parks lines that arrive with a gap and applies them when the gap fills; a duplicate park is harmless', async () => {
    const lines = Array.from({ length: 9 }, (_, i) => cc.user('p' + i));
    const s = await openWith(t.dir);
    expect(await s.append(V(1), 0, 6, lines.slice(6, 9))).toBe('parked');
    expect(await s.append(V(1), 0, 6, lines.slice(6, 9))).toBe('parked');
    expect(await s.append(V(1), 0, 3, lines.slice(3, 6))).toBe('parked');
    expect((await s.head(V(1))).lines).toBe(0);
    expect(await s.append(V(1), 0, 0, lines.slice(0, 3))).toBe('ok');
    const head = await s.head(V(1));
    expect(head.lines).toBe(9);
    expect(head.hash).toBe(refChains(lines).raw[9]);
    const parkedLeft = (await listFiles(t.dir)).filter((f) => f.endsWith('.park'));
    expect(parkedLeft).toEqual([]);
  });

  it('a parked append that is NOT a prefix is kept under rejected/, never deleted, and does not block others', async () => {
    const good = Array.from({ length: 4 }, (_, i) => cc.user('g' + i));
    const bad = [cc.user('x1'), cc.user('x2')];
    const s = await openWith(t.dir);
    await s.append(V(1), 0, 2, bad); // parked at line 2
    await s.append(V(1), 0, 0, good.slice(0, 3)); // fills the gap with different line 2
    expect((await s.head(V(1))).lines).toBe(3);
    expect((await listFiles(t.dir)).some((f) => f.includes('rejected') && f.endsWith('.park'))).toBe(true);
    expect(await s.append(V(1), 0, 3, good.slice(3))).toBe('ok');
  });

  it('handles awkward lines (invalid JSON, U+2028/2029, blank, 3 MB) byte for byte', async () => {
    const big = Buffer.from(JSON.stringify({ type: 'user', message: { content: 'y'.repeat(3_000_000) } }) + '\n');
    const lines = [awkward.lineSeparators(), awkward.invalidJson(), awkward.garbage(), awkward.spaced(), awkward.empty(), big, cc.user()];
    const s = await openWith(t.dir);
    await s.append(V(1), 0, 0, lines);
    const back = await s.read(V(1), 0, 0, lines.length) as Buffer[];
    expect(back.map((b) => createHash('sha256').update(b).digest('hex'))).toEqual(lines.map((b) => createHash('sha256').update(b).digest('hex')));
    expect((await s.verify(V(1))).ok).toBe(true);
  });
});

describe('persistence and structure', () => {
  it('survives reopening; chunks roll over and ranges can cross chunk files', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => cc.user('row ' + i + ' ' + 'z'.repeat(300)));
    let s = await openWith(t.dir, V(1), { chunkBytes: 4096 });
    for (let i = 0; i < 200; i += 7) await s.append(V(1), 0, i, lines.slice(i, i + 7));
    await s.close();
    expect(fs.readdirSync(path.join(t.dir, 'versions', V(1).toString('hex'))).filter((f) => f.startsWith('body-')).length).toBeGreaterThan(5);
    s = await ChatStore.open(t.dir, { chunkBytes: 4096 });
    expect((await s.head(V(1))).hash).toBe(refChains(lines).raw[200]);
    const back = await s.read(V(1), 0, 10, 190) as Buffer[];
    expect(Buffer.concat(back).equals(Buffer.concat(lines.slice(10, 190)))).toBe(true);
    expect((await s.verify(V(1))).ok).toBe(true);
    expect((await s.listVersions()).map((v) => v.version.toString('hex'))).toEqual([V(1).toString('hex')]);
  });

  it('registering twice is fine; with other facts it conflicts; two versions are independent', async () => {
    const s = await openWith(t.dir);
    await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' });
    await rejects(s.registerVersion(V(1), { chatId: 'other', runtime: 'claude-code' }), 'version-conflict');
    await s.registerVersion(V(2), { chatId: CHAT, runtime: 'claude-code', parent: V(1) });
    await s.append(V(1), 0, 0, [cc.user('a')]);
    expect((await s.head(V(2))).lines).toBe(0);
    const v = await s.listVersions();
    expect(v.find((x) => x.version.equals(V(2)))!.parent!.equals(V(1))).toBe(true);
  });

  it('version id is opaque and the chain seed is one replaceable function', async () => {
    const lines = [cc.user('a'), cc.user('b')];
    const custom: ChainSeedFn = (ctx) => { const base = defaultChainSeeds({ ...ctx, chatId: 'replaced:' + Buffer.from(ctx.version).toString('hex') }); return base; };
    const s1 = await openWith(t.dir, V(1), { seeds: custom });
    await s1.append(V(1), 0, 0, lines);
    const t2 = await tmpRoot();
    try {
      const s2 = await openWith(t2.dir, V(1));
      await s2.append(V(1), 0, 0, lines);
      expect((await s1.head(V(1))).hash).not.toBe((await s2.head(V(1))).hash); // a different rule gives different chains
      // and the default rule ignores the version id (T12 F6): same chat + lines under another version id: same chain
      const s3 = await openWith(t2.dir, V(77));
      await s3.append(V(77), 0, 0, lines);
      expect((await s3.head(V(77))).hash).toBe((await s2.head(V(1))).hash);
    } finally { await t2.cleanup(); }
  });

  it('two stores fed the same lines byte for byte have identical chains', async () => {
    const { lines } = ccConversation();
    const t2 = await tmpRoot();
    try {
      const a = await openWith(t.dir); const b = await openWith(t2.dir, V(1), { chunkBytes: 700 });
      await a.append(V(1), 0, 0, lines);
      for (const l of lines.map((x, i) => [i, x] as const)) await b.append(V(1), 0, l[0], [l[1]]);
      expect(await a.head(V(1))).toEqual(await b.head(V(1)));
      expect(await a.replyEnds(V(1))).toEqual(await b.replyEnds(V(1)));
    } finally { await t2.cleanup(); }
  });
});

describe('reply ends, summary, conversation reads', () => {
  it('replyEnds follow the lookahead rule and survive reopen; pending is reported', async () => {
    const { lines, confirmed, pending } = ccConversation();
    let s = await openWith(t.dir);
    await s.append(V(1), 0, 0, lines.slice(0, 9));
    await s.append(V(1), 0, 9, lines.slice(9)); // split mid-conversation: tracker state must carry across calls
    expect(await s.replyEnds(V(1))).toEqual({ confirmed, pending });
    await s.close();
    s = await ChatStore.open(t.dir);
    expect(await s.replyEnds(V(1))).toEqual({ confirmed, pending });
    const more = [cc.user('next')];
    await s.append(V(1), 0, lines.length, more); // confirms the pending candidate
    expect(await s.replyEnds(V(1))).toEqual({ confirmed: [...confirmed, pending], pending: null });
  });

  it('native reply ends', async () => {
    const { lines, confirmed } = nativeConversation();
    const s = await openWith(t.dir, V(3), {}, 'native', 'synthetic:native-1');
    await s.append(V(3), 0, 0, lines);
    expect(await s.replyEnds(V(3))).toEqual({ confirmed, pending: null });
    const sum = await s.summary(V(3));
    expect(sum).toMatchObject({ lines: lines.length, conversationLines: lines.length - 2, replyEnds: 2, cwd: '/synthetic/project' });
  });

  it('summary: title, model, folder, counts, arrival time from the injected clock', async () => {
    let now = 1000;
    const lines = [cc.user('hi'), cc.block('m1', 'end_turn', 'text'), cc.title('Synthetic name'), cc.bookkeeping()];
    const s = await openWith(t.dir, V(1), { now: () => now++ });
    await s.append(V(1), 0, 0, lines);
    expect(await s.summary(V(1))).toMatchObject({ lines: 4, conversationLines: 2, title: 'Synthetic name', model: 'synthetic-model-1', cwd: '/synthetic/project', lastAppendMs: expect.any(Number) });
    await s.close();
    const s2 = await ChatStore.open(t.dir);
    expect((await s2.summary(V(1))).title).toBe('Synthetic name');
  });

  it('a summary file that is behind (kill after the index sync) is caught up from flagged lines on open', async () => {
    const s = await openWith(t.dir);
    await s.append(V(1), 0, 0, [cc.user('a'), cc.block('m1', 'end_turn', 'text')]);
    await s.append(V(1), 0, 2, [cc.title('Caught up title'), cc.bookkeeping()]);
    await s.close();
    const sp = path.join(t.dir, 'versions', V(1).toString('hex'), 'summary.json');
    fs.writeFileSync(sp, JSON.stringify({ title: null, model: null, cwd: null, lastAppendMs: null, lines: 0 })); // as if the save never happened
    const s2 = await ChatStore.open(t.dir);
    expect(await s2.summary(V(1))).toMatchObject({ title: 'Caught up title', model: 'synthetic-model-1', cwd: '/synthetic/project' });
  });

  it('conversationLines yields only user/assistant lines with their line numbers, in batches', async () => {
    const { lines } = ccConversation();
    const s = await openWith(t.dir);
    await s.append(V(1), 0, 0, lines);
    const got: number[] = [];
    for await (const batch of s.conversationLines(V(1), 0, 3)) { expect(batch.length).toBeLessThanOrEqual(3); for (const b of batch) { got.push(b.line); expect(b.bytes.equals(lines[b.line])).toBe(true); } }
    const expected = lines.map((l, i) => [l, i] as const).filter(([l]) => /"type":"(user|assistant)"/.test(l.toString())).map(([, i]) => i);
    expect(got).toEqual(expected);
  });
});

describe('set-asides', () => {
  const takeover = 'ab'.repeat(32);
  it('setAsideTail keeps the tail, cuts the version back, tail() returns it, retry is safe, appends continue', async () => {
    const { lines } = ccConversation();
    const s = await openWith(t.dir);
    await s.append(V(1), 0, 0, lines);
    const ref = refChains(lines);
    const res = await s.setAsideTail(takeover, V(1), 8);
    expect(res.lines).toBe(lines.length - 8);
    expect((await s.head(V(1))).hash).toBe(ref.raw[8]);
    const tail = (await s.tail(takeover))!;
    expect(tail.fromLine).toBe(8);
    expect(tail.fromHash).toBe(ref.raw[8]); expect(tail.headHash).toBe(ref.raw[lines.length]);
    expect(Buffer.concat(tail.lines).equals(Buffer.concat(lines.slice(8)))).toBe(true);
    expect(tail.replyEnds.every((n) => n >= 8)).toBe(true);
    expect((await s.setAsideTail(takeover, V(1), 8)).lines).toBe(lines.length - 8); // idempotent
    await rejects(s.setAsideTail(takeover, V(1), 5), 'bad-argument');
    // the new host continues from the cut with different lines
    const newer = [cc.user('new host line')];
    expect(await s.append(V(1), 0, 8, newer)).toBe('ok');
    expect((await s.verify(V(1))).ok).toBe(true);
    expect((await s.replyEnds(V(1))).confirmed.every((n) => n < 8)).toBe(true);
    expect(await s.tail('cd'.repeat(32))).toBeNull();
  });

  it('setAsideTail beyond the head records an empty tail and changes nothing', async () => {
    const s = await openWith(t.dir);
    await s.append(V(1), 0, 0, [cc.user('a')]);
    expect((await s.setAsideTail(takeover, V(1), 5)).lines).toBe(0);
    expect((await s.head(V(1))).lines).toBe(1);
  });

  it('setAsideDamaged moves the files to aside/ (kept), starts the version empty, keeps parked appends', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => cc.user('d' + i));
    const s = await openWith(t.dir);
    await s.append(V(1), 0, 0, lines.slice(0, 3));
    await s.append(V(1), 0, 4, lines.slice(4));
    const { asideName } = await s.setAsideDamaged(V(1));
    expect((await s.head(V(1))).lines).toBe(0);
    expect(fs.readdirSync(path.join(t.dir, 'aside', asideName)).sort()).toContain('index.bin');
    expect(await s.append(V(1), 0, 0, lines.slice(0, 4))).toBe('ok'); // recopy; the parked tail joins
    expect((await s.head(V(1))).lines).toBe(5);
    expect((await s.setAsideDamaged(V(1))).asideName).toBe(`${V(1).toString('hex')}-2`);
  });
});

describe('eviction', () => {
  const proofFor = async (s: ChatStore, through: number) => ({ kind: 'holders-confirmed' as const, holders: ['dev-a'], through, hash: (await s.hashAt(V(1), 0, through))! });

  it('refuses without a well-formed proof, with a stale or foreign hash, or past the head', async () => {
    const lines = Array.from({ length: 6 }, (_, i) => cc.user('e' + i));
    const s = await openWith(t.dir, V(1), { chunkBytes: 64 });
    await s.append(V(1), 0, 0, lines);
    const good = await proofFor(s, 4);
    for (const bad of [undefined, null, {}, { ...good, kind: 'x' }, { ...good, holders: [] }, { ...good, holders: [''] }, { ...good, holders: ['a', 'a'] }, { ...good, through: 0 }, { ...good, hash: 'zz' }, { ...good, hash: 'ab'.repeat(32) }, { ...good, through: 7 }]) {
      await rejects(s.evictBody(V(1), bad as any), 'bad-proof');
    }
    expect((await s.head(V(1))).evictedLines).toBe(0);
    expect(await s.read(V(1), 0, 0, 6)).not.toBe('evicted');
  });

  it('evicts bodies, keeps chain values, serves reads as evicted, still answers hashAt and idempotent appends, restores', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => cc.user('e' + i + 'x'.repeat(40)));
    const s = await openWith(t.dir, V(1), { chunkBytes: 256 });
    await s.append(V(1), 0, 0, lines.slice(0, 12));
    await s.append(V(1), 0, 12, lines.slice(12));
    const ref = refChains(lines);
    const r = await s.evictBody(V(1), await proofFor(s, 15));
    expect(r.evictedLines).toBe(15); expect(r.freedBytes).toBeGreaterThan(0);
    expect(await s.read(V(1), 0, 0, 3)).toBe('evicted');
    expect(await s.read(V(1), 0, 14, 16)).toBe('evicted');
    expect((await s.read(V(1), 0, 15, 20) as Buffer[]).length).toBe(5);
    expect(await s.hashAt(V(1), 0, 7)).toBe(ref.raw[7]);
    expect((await s.head(V(1))).hash).toBe(ref.raw[20]);
    expect(await s.append(V(1), 0, 0, lines.slice(0, 10))).toBe('ok'); // overlap check uses the kept chain values
    expect(await s.append(V(1), 0, 2, [cc.user('tampered')])).toBe('not-a-prefix');
    const extra = cc.user('after eviction');
    expect(await s.append(V(1), 0, 20, [extra])).toBe('ok'); // growing after eviction works
    expect((await s.verify(V(1))).ok).toBe(true);
    // wrong lines are refused and change nothing
    const wrong = lines.slice(0, 15).map((l, i) => (i === 3 ? cc.user('wrong') : l));
    await rejects(s.restoreBody(V(1), wrong), 'bad-argument');
    expect(await s.read(V(1), 0, 0, 2)).toBe('evicted');
    expect((await s.restoreBody(V(1), lines)).restoredLines).toBe(15);
    expect(Buffer.concat(await s.read(V(1), 0, 0, 20) as Buffer[]).equals(Buffer.concat(lines))).toBe(true);
    expect((await s.verify(V(1))).ok).toBe(true);
    // evicted state survives reopen
    await s.evictBody(V(1), await proofFor(s, 21));
    await s.close();
    const s2 = await ChatStore.open(t.dir, { chunkBytes: 256 });
    expect((await s2.head(V(1))).evictedLines).toBe(21);
    expect(await s2.read(V(1), 0, 0, 1)).toBe('evicted');
    expect((await s2.head(V(1))).hash).toBe(refChains([...lines, extra]).raw[21]);
  });

  it('cannot cut a tail out of evicted lines', async () => {
    const lines = Array.from({ length: 6 }, (_, i) => cc.user('c' + i));
    const s = await openWith(t.dir);
    await s.append(V(1), 0, 0, lines);
    await s.evictBody(V(1), await proofFor(s, 6));
    await rejects(s.setAsideTail('ef'.repeat(8), V(1), 2), 'evicted');
  });
});

describe('extras', () => {
  it('stores by content hash, refuses mismatches and bad hashes', async () => {
    const s = await openWith(t.dir);
    const bytes = Buffer.from('synthetic extra bytes');
    const hash = createHash('sha256').update(bytes).digest('hex');
    expect(await s.hasExtra(hash)).toBe(false);
    expect(await s.putExtra(hash, bytes)).toBe('stored');
    expect(await s.putExtra(hash, bytes)).toBe('present');
    expect(await s.hasExtra(hash)).toBe(true);
    expect((await s.readExtra(hash))!.equals(bytes)).toBe(true);
    expect(await s.readExtra('00'.repeat(32))).toBeNull();
    expect(() => s.putExtra('00'.repeat(32), bytes)).toThrow(StoreError);
    expect(() => s.hasExtra('../../etc/passwd')).toThrow(StoreError);
  });
});

describe('control log storage', () => {
  const id = (n: number) => createHash('sha256').update('entry' + n).digest('hex');
  const entry = (n: number, seen: number[] = [], chat = 'synthetic:chat-1') => ({ id: id(n), chat, seen: seen.map(id), body: Buffer.from('opaque-' + n) });

  it('appends in order, reports duplicates, parks entries whose seen ids are missing and applies them later', async () => {
    let s = await openWith(t.dir);
    expect(await s.appendControl(entry(1))).toBe('ok');
    expect(await s.appendControl(entry(1))).toBe('duplicate');
    expect(await s.appendControl(entry(3, [2]))).toBe('parked');
    expect(await s.appendControl(entry(3, [2]))).toBe('parked');
    expect((await s.parkedControl('synthetic:chat-1')).map((e) => e.id)).toEqual([id(3)]);
    expect(await s.appendControl(entry(4, [3]))).toBe('parked');
    expect(await s.appendControl(entry(2, [1]))).toBe('ok'); // unlocks 3 then 4
    const log = await s.controlLog('synthetic:chat-1');
    expect(log.map((e) => e.id)).toEqual([id(1), id(2), id(3), id(4)]);
    expect(Buffer.from(log[2].body).toString()).toBe('opaque-3');
    expect(await s.parkedControl('synthetic:chat-1')).toEqual([]);
    await s.close();
    s = await ChatStore.open(t.dir);
    expect((await s.controlLog('synthetic:chat-1')).map((e) => e.id)).toEqual([id(1), id(2), id(3), id(4)]);
    expect(await s.controlLog('synthetic:other')).toEqual([]);
  });

  it('rejects malformed envelopes', async () => {
    const s = await openWith(t.dir);
    await rejects(s.appendControl({ ...entry(1), id: 'short' }), 'bad-argument');
    await rejects(s.appendControl({ ...entry(1), seen: ['x'] }), 'bad-argument');
    await rejects(s.appendControl({ ...entry(1), chat: '' }), 'bad-argument');
  });
});

describe('never touches anything outside its root', () => {
  it('writes only under the root', async () => {
    const parent = fs.mkdtempSync(path.join(t.dir, 'p-'));
    const root = path.join(parent, 'store');
    fs.writeFileSync(path.join(parent, 'sentinel'), 'x');
    const s = await openWith(root);
    await s.append(V(1), 0, 0, [cc.user('a')]);
    await s.appendControl({ id: 'ab'.repeat(32), chat: 'c', seen: [], body: Buffer.from('b') });
    expect(fs.readdirSync(parent).sort()).toEqual(['sentinel', 'store']);
  });
});
