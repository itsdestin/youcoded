// Crash tests: the store must reopen correctly after a kill at ANY write, rename or fsync boundary.
//
// How: every disk-changing call of the store goes through the Fs interface (fsio.ts). For each scenario
// we first count its operations N, then for every k in 1..N run it on a fresh folder with a shim that
// "kills the process" at the k-th operation (the operation does not happen, or, for writes, only half
// of its bytes land), optionally also cutting unsynced data away (power loss). Then a NEW store is
// opened on the folder with the real file system and the invariants are checked, and the interrupted work
// is simply redone to prove it converges.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatStore, type EvictionProof, type StoreOptions } from './store';
import { FaultFs, InjectedCrash } from './fault-fs';
import { ccConversation, cc } from './fixtures';
import { CHAT, V, refChains, tmpRoot, listFiles } from './testkit';
import { analyseLine, initialReplyState, replyEndStep } from './classify';

type Variant = { tear: boolean; powerLoss: boolean };
const VARIANTS: Variant[] = [{ tear: false, powerLoss: false }, { tear: true, powerLoss: false }, { tear: true, powerLoss: true }];

/** Reply ends the pure tracker finds in the first n lines (the reference for the stored index). */
function refReplyEnds(lines: Buffer[], n: number): { confirmed: number[]; pending: number | null } {
  let rs = initialReplyState(); const confirmed: number[] = [];
  for (let i = 0; i < n; i++) { const o = replyEndStep('claude-code', rs, analyseLine('claude-code', lines[i]), i); rs = o.rs; confirmed.push(...o.confirmed); }
  return { confirmed, pending: rs.cand ? rs.cand.n : null };
}

interface Scenario {
  name: string;
  /** Build the state before the kill with the real file system. */
  setup?: (root: string) => Promise<void>;
  /** The work that gets killed. `progress` records what was acknowledged (resolved) before the kill. */
  run: (s: ChatStore, progress: { acked: number }) => Promise<void>;
  /** After the kill: open with the real fs and check invariants. */
  check: (root: string, progress: { acked: number }, crashedAt: number) => Promise<void>;
  storeOpts?: StoreOptions;
}

async function sweep(sc: Scenario): Promise<{ ops: number; runs: number }> {
  // count the operations of one clean run
  const count = await tmpRoot('crash-count-');
  let total = 0;
  try {
    await sc.setup?.(count.dir);
    const ffs = new FaultFs(0);
    const s = await ChatStore.open(count.dir, { fs: ffs, ...sc.storeOpts });
    await sc.run(s, { acked: 0 });
    total = ffs.ops;
    await s.close();
  } finally { await count.cleanup(); }
  expect(total).toBeGreaterThan(0);
  let runs = 0;
  for (const v of VARIANTS) {
    for (let k = 1; k <= total; k++) {
      const t = await tmpRoot('crash-run-');
      try {
        await sc.setup?.(t.dir);
        const ffs = new FaultFs(k, v);
        const progress = { acked: 0 };
        let crashed = false;
        try {
          const s = await ChatStore.open(t.dir, { fs: ffs, ...sc.storeOpts });
          await sc.run(s, progress);
        } catch (e) {
          if (!(e instanceof InjectedCrash)) throw e;
          crashed = true;
        }
        expect(crashed, `op ${k} of ${total} should have been reached`).toBe(true);
        await ffs.applyPowerLoss();
        // the killed process is gone, so its lock is stale: in-process the owner would still look alive, so mark it dead
        const lockPath = path.join(t.dir, 'LOCK');
        if (fs.existsSync(lockPath)) fs.writeFileSync(lockPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(lockPath, 'utf8')), pid: 2147483646, start: 'dead' }));
        try { await sc.check(t.dir, progress, k); }
        catch (e) { (e as Error).message = `[${sc.name} kill at op ${k}/${total} tear=${v.tear} powerLoss=${v.powerLoss}] ` + (e as Error).message; throw e; }
        runs++;
      } finally { await t.cleanup(); }
    }
  }
  if (process.env.MESH_CRASH_LOG) fs.appendFileSync(process.env.MESH_CRASH_LOG, `${sc.name}: ${total} operations, ${runs} kill runs\n`);
  return { ops: total, runs };
}

const conv = ccConversation().lines;
const REF = refChains(conv);

async function plainSetup(root: string, withLines = 0): Promise<void> {
  const s = await ChatStore.open(root);
  await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' });
  if (withLines) await s.append(V(1), 0, 0, conv.slice(0, withLines));
  await s.close();
}

/** Common checks for a version that should hold a prefix of `conv`. */
async function expectPrefixState(s: ChatStore, minLines: number): Promise<number> {
  const head = await s.head(V(1));
  expect(head.lines).toBeGreaterThanOrEqual(minLines);
  expect(head.lines).toBeLessThanOrEqual(conv.length);
  expect(head.hash).toBe(REF.raw[head.lines]);
  // C1: no kill point may ever look like damage, and nothing acknowledged is moved aside
  expect(fs.existsSync(path.join(s.root, 'versions', V(1).toString('hex'), 'damaged.json'))).toBe(false);
  expect(fs.existsSync(path.join(s.root, 'aside')) ? fs.readdirSync(path.join(s.root, 'aside')) : []).toEqual([]);
  const rep = await s.verify(V(1));
  expect(rep, JSON.stringify(rep)).toMatchObject({ ok: true });
  expect(await s.replyEnds(V(1))).toEqual(refReplyEnds(conv, head.lines));
  if (head.lines) {
    const got = await s.read(V(1), 0, 0, head.lines) as Buffer[];
    expect(Buffer.concat(got).equals(Buffer.concat(conv.slice(0, head.lines)))).toBe(true);
  }
  return head.lines;
}

describe('kill at every disk operation', () => {
  it('registering a version and appending batches (with chunk roll-over)', async () => {
    const r = await sweep({
      name: 'append',
      storeOpts: { chunkBytes: 600 },
      run: async (s, p) => {
        await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' });
        let at = 0;
        for (const n of [4, 5, 5, conv.length - 14]) { await s.append(V(1), 0, at, conv.slice(at, at + n)); at += n; p.acked = at; }
      },
      check: async (root, p) => {
        const s = await ChatStore.open(root, { chunkBytes: 600 });
        await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' }); // safe whether or not it finished
        const lines = await expectPrefixState(s, p.acked);
        expect(lines).toBeGreaterThanOrEqual(p.acked);
        // redo everything from line 0: converges to the full chain
        expect(await s.append(V(1), 0, 0, conv)).toBe('ok');
        expect((await s.head(V(1))).hash).toBe(REF.raw[conv.length]);
        expect((await s.verify(V(1))).ok).toBe(true);
        expect(await s.replyEnds(V(1))).toEqual(refReplyEnds(conv, conv.length));
        await s.close();
      },
    });
  }, 120_000);

  it('parked appends and the gap filling', async () => {
    const r = await sweep({
      name: 'parked',
      setup: (root) => plainSetup(root),
      run: async (s, p) => {
        await s.append(V(1), 0, 10, conv.slice(10, 14)); p.acked = 0;
        await s.append(V(1), 0, 14, conv.slice(14));
        await s.append(V(1), 0, 0, conv.slice(0, 10)); p.acked = conv.length;
      },
      check: async (root, p) => {
        const s = await ChatStore.open(root);
        await expectPrefixState(s, p.acked);
        // the caller re-sends the same three pieces (any order): converges, nothing parked is lost or duplicated
        await s.append(V(1), 0, 14, conv.slice(14)); await s.append(V(1), 0, 10, conv.slice(10, 14)); await s.append(V(1), 0, 0, conv.slice(0, 10));
        expect((await s.head(V(1))).hash).toBe(REF.raw[conv.length]);
        expect((await listFiles(root)).filter((f) => f.endsWith('.park'))).toEqual([]);
        await s.close();
      },
    });
  }, 120_000);

  it('setAsideTail: the tail is never lost, whichever step is cut', async () => {
    const takeover = '11'.repeat(32);
    const FROM = 9;
    const r = await sweep({
      name: 'setAsideTail',
      setup: (root) => plainSetup(root, conv.length),
      run: async (s) => { await s.setAsideTail(takeover, V(1), FROM); },
      check: async (root) => {
        const s = await ChatStore.open(root);
        const tail = await s.tail(takeover);
        const head = await s.head(V(1));
        // either nothing happened, or the tail is complete; and in every case every line is somewhere
        if (!tail) expect(head.lines).toBe(conv.length);
        else {
          expect(tail.fromLine).toBe(FROM);
          expect(Buffer.concat(tail.lines).equals(Buffer.concat(conv.slice(FROM)))).toBe(true);
          expect([FROM, conv.length]).toContain(head.lines);
        }
        expect((await s.verify(V(1))).ok).toBe(true);
        // redo: completes
        await s.setAsideTail(takeover, V(1), FROM);
        expect((await s.head(V(1))).lines).toBe(FROM);
        expect((await s.head(V(1))).hash).toBe(REF.raw[FROM]);
        expect(Buffer.concat((await s.tail(takeover))!.lines).equals(Buffer.concat(conv.slice(FROM)))).toBe(true);
        expect(await s.append(V(1), 0, FROM, [cc.user('new host')])).toBe('ok');
        expect((await s.verify(V(1))).ok).toBe(true);
        await s.close();
      },
    });
  }, 120_000);

  it('setAsideDamaged: every byte is either still in the version or in aside/, never gone', async () => {
    let origIndex = Buffer.alloc(0);
    const r = await sweep({
      name: 'setAsideDamaged',
      setup: async (root) => { await plainSetup(root, conv.length); origIndex = fs.readFileSync(path.join(root, 'versions', V(1).toString('hex'), 'index.bin')); },
      run: async (s) => { await s.setAsideDamaged(V(1)); },
      check: async (root) => {
        const s = await ChatStore.open(root);
        const head = await s.head(V(1)); // load() completes an interrupted move
        const asideDirs = fs.existsSync(path.join(root, 'aside')) ? fs.readdirSync(path.join(root, 'aside')) : [];
        if (head.lines === conv.length) expect(await s.verify(V(1))).toMatchObject({ ok: true });
        else {
          expect(head.lines).toBe(0);
          expect(asideDirs.length).toBe(1);
          const files = fs.readdirSync(path.join(root, 'aside', asideDirs[0]));
          expect(files).toContain('index.bin');
          expect(files.some((f) => f.startsWith('body-'))).toBe(true);
          const bodyBytes = files.filter((f) => f.startsWith('body-')).reduce((n, f) => n + fs.statSync(path.join(root, 'aside', asideDirs[0], f)).size, 0);
          expect(bodyBytes).toBe(Buffer.concat(conv).length);
          // H2: the aside copy's INDEX is complete too, byte for byte (it used to be overwritten by the fresh empty one)
          expect(fs.readFileSync(path.join(root, 'aside', asideDirs[0], 'index.bin')).equals(origIndex)).toBe(true);
        }
        await s.setAsideDamaged(V(1)); // redo is safe
        expect((await s.head(V(1))).lines).toBe(0);
        expect(await s.append(V(1), 0, 0, conv)).toBe('ok');
        await s.close();
      },
    });
  }, 120_000);

  it('evictBody and restoreBody: chain values are never lost; a cut eviction is finished or undone', async () => {
    const THROUGH = 12;
    const vh = V(1).toString('hex');
    const proof = (): EvictionProof => ({ kind: 'holders-confirmed', version: vh, through: THROUGH, hash: REF.raw[THROUGH], acks: [{ holder: 'dev-a', version: vh, lines: THROUGH, hash: REF.raw[THROUGH], signature: 'sig' }] });
    const accept: StoreOptions = { chunkBytes: 500, proofVerifier: () => true };
    const evictSweep = await sweep({
      name: 'evict',
      storeOpts: accept,
      setup: async (root) => { const s = await ChatStore.open(root, accept); await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' }); await s.append(V(1), 0, 0, conv.slice(0, 7)); await s.append(V(1), 0, 7, conv.slice(7)); await s.close(); },
      run: async (s) => { await s.evictBody(V(1), proof()); },
      check: async (root) => {
        const s = await ChatStore.open(root, accept);
        const head = await s.head(V(1));
        expect(head.lines).toBe(conv.length); expect(head.hash).toBe(REF.raw[conv.length]);
        expect([0, THROUGH]).toContain(head.evictedLines);
        for (const n of [0, 3, THROUGH, conv.length]) expect(await s.hashAt(V(1), 0, n)).toBe(REF.raw[n]);
        expect((await s.verify(V(1))).ok).toBe(true);
        const kept = await s.read(V(1), 0, THROUGH, conv.length) as Buffer[];
        expect(Buffer.concat(kept).equals(Buffer.concat(conv.slice(THROUGH)))).toBe(true);
        await s.evictBody(V(1), proof());
        expect((await s.head(V(1))).evictedLines).toBe(THROUGH);
        expect((await s.restoreBody(V(1), conv)).restoredLines).toBe(THROUGH);
        expect(Buffer.concat(await s.read(V(1), 0, 0, conv.length) as Buffer[]).equals(Buffer.concat(conv))).toBe(true);
        await s.close();
      },
    });
    const restoreSweep = await sweep({
      name: 'restore',
      storeOpts: accept,
      setup: async (root) => { const s = await ChatStore.open(root, accept); await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' }); await s.append(V(1), 0, 0, conv); await s.evictBody(V(1), proof()); await s.close(); },
      run: async (s) => { await s.restoreBody(V(1), conv); },
      check: async (root) => {
        const s = await ChatStore.open(root, accept);
        const head = await s.head(V(1));
        expect([0, THROUGH]).toContain(head.evictedLines);
        expect(head.hash).toBe(REF.raw[conv.length]);
        if (head.evictedLines === 0) expect(Buffer.concat(await s.read(V(1), 0, 0, conv.length) as Buffer[]).equals(Buffer.concat(conv))).toBe(true);
        else expect(await s.read(V(1), 0, 0, 2)).toBe('evicted');
        expect((await s.verify(V(1))).ok).toBe(true);
        await s.restoreBody(V(1), conv);
        expect(Buffer.concat(await s.read(V(1), 0, 0, conv.length) as Buffer[]).equals(Buffer.concat(conv))).toBe(true);
        await s.close();
      },
    });
  }, 240_000);

  it('control log appends and parked entries', async () => {
    const id = (n: number) => createHash('sha256').update('opaque' + n).digest('hex'); // an entry id is the SHA-256 of its body
    const entries = [1, 2, 3, 4].map((n) => ({ id: id(n), chat: CHAT, seen: n > 1 ? [id(n - 1)] : [], body: Buffer.from('opaque' + n) }));
    const order = [entries[2], entries[3], entries[0], entries[1]]; // out of causal order on purpose
    const r = await sweep({
      name: 'control',
      setup: (root) => plainSetup(root),
      run: async (s, p) => { for (const e of order) { await s.appendControl(e); p.acked++; } },
      check: async (root) => {
        const s = await ChatStore.open(root);
        const log = (await s.controlLog(CHAT)).map((e) => e.id);
        // the stored log is always a causal prefix: 1, then 2, ...
        expect(log).toEqual([1, 2, 3, 4].slice(0, log.length).map(id));
        for (const e of order) await s.appendControl(e); // re-send everything
        const full = await s.controlLog(CHAT);
        expect(full.map((e) => e.id)).toEqual([1, 2, 3, 4].map(id));
        expect(Buffer.from(full[1].body).toString()).toBe('opaque2');
        expect(await s.parkedControl(CHAT)).toEqual([]);
        await s.close();
      },
    });
  }, 120_000);

  it('putExtra: absent or complete, never half', async () => {
    const bytes = Buffer.from('synthetic extra body');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const r = await sweep({
      name: 'extra',
      setup: (root) => plainSetup(root),
      run: async (s) => { await s.putExtra(hash, bytes); },
      check: async (root) => {
        const s = await ChatStore.open(root);
        const got = await s.readExtra(hash);
        if (got) expect(got.equals(bytes)).toBe(true);
        expect(await s.putExtra(hash, bytes)).toMatch(/stored|present/);
        expect((await s.readExtra(hash))!.equals(bytes)).toBe(true);
        await s.close();
      },
    });
  }, 60_000);
});
