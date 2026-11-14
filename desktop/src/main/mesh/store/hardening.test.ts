// Tests for the independent review of the chat store (docs/active/reviews/2026-11-14-mesh-store-code-review.md).
// Each finding id (C1, C2, H1...) names the demonstration that review ran; here that demonstration is a test.
// Synthetic data only. Kept apart from store.test.ts so the finding-to-test mapping stays readable.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ChatStore, type EvictionProof, type ProofVerifier } from './store';
import { StoreError } from './errors';
import { REC, recPos } from './records';
import { cc, nl, ccConversation, nativeConversation } from './fixtures';
import { CHAT, V, openWith, refChains, tmpRoot, listFiles } from './testkit';
import { FaultFs } from './fault-fs';
import { encodeSide, decodeSide } from './sidefile';
import { analyseLine, initialReplyState, replyEndStep } from './classify';
import { defaultChainSeeds, hex } from './chain';
import { initAdapterState, poll, isRewritten, type AdapterOptions, type PollBatch, type PollResult } from './adapter';

let t: Awaited<ReturnType<typeof tmpRoot>>;
beforeEach(async () => { t = await tmpRoot('hardening-'); });
afterEach(async () => { await t.cleanup(); });

const vhex = V(1).toString('hex');
const vdir = (root: string) => path.join(root, 'versions', vhex);
const rows = (n: number, tag = 'r'): Buffer[] => Array.from({ length: n }, (_, i) => cc.user(`${tag} ${i} ${'z'.repeat(20)}`));
const rejects = async (p: Promise<unknown>, code: string) => { await expect(p).rejects.toMatchObject({ name: 'StoreError', code }); };
async function build(root: string, L: Buffer[], o: { chunkBytes?: number } = {}): Promise<void> {
  const s = await openWith(root, V(1), o);
  // several batches, so a small chunk size really rolls over (a chunk only rolls between batches)
  for (let i = 0; i < L.length; i += 7) await s.append(V(1), 0, i, L.slice(i, i + 7));
  await s.close();
}
const flip = (file: string, pos: number): Buffer => { const b = fs.readFileSync(file); b[pos] ^= 0xff; fs.writeFileSync(file, b); return b; };
const asideDirs = (root: string) => (fs.existsSync(path.join(root, 'aside')) ? fs.readdirSync(path.join(root, 'aside')) : []);
const readAll = async (s: ChatStore, n: number) => Buffer.concat((await s.read(V(1), 0, 0, n)) as Buffer[]);

// ---------------------------------------------------------------------------------------------- C1
describe('C1: a damaged index never costs acknowledged lines', () => {
  it('one flipped index record is repaired from the body; every line stays; the damaged index is kept', async () => {
    const L = rows(100); await build(t.dir, L);
    const ip = path.join(vdir(t.dir), 'index.bin');
    const damaged = flip(ip, recPos(50) + 20);
    const s = await ChatStore.open(t.dir);
    expect((await s.head(V(1))).lines).toBe(100);
    expect((await s.verify(V(1))).ok).toBe(true);
    expect((await readAll(s, 100)).equals(Buffer.concat(L))).toBe(true);
    const kept = fs.readdirSync(path.join(vdir(t.dir), 'replaced-index'));
    expect(kept.length).toBe(1);
    expect(fs.readFileSync(path.join(vdir(t.dir), 'replaced-index', kept[0])).equals(damaged)).toBe(true);
    await s.close();
  });

  it('a missing index.bin is rebuilt from the bodies, never treated as empty', async () => {
    const L = rows(100); await build(t.dir, L, { chunkBytes: 900 });
    const bodies = fs.readdirSync(vdir(t.dir)).filter((f) => f.startsWith('body-')).sort();
    const sizes = bodies.map((f) => fs.statSync(path.join(vdir(t.dir), f)).size);
    fs.unlinkSync(path.join(vdir(t.dir), 'index.bin'));
    const s = await ChatStore.open(t.dir, { chunkBytes: 900 });
    const head = await s.head(V(1));
    expect(head.lines).toBe(100); expect(head.hash).toBe(refChains(L).raw[100]);
    expect((await s.verify(V(1))).ok).toBe(true);
    expect(fs.readdirSync(vdir(t.dir)).filter((f) => f.startsWith('body-')).sort().map((f) => fs.statSync(path.join(vdir(t.dir), f)).size)).toEqual(sizes);
    await s.close();
  });

  it('record AND body both damaged (N7), in different lines: every verifiable line is served, the rotted one is flagged, the old index is kept, and a correct resend heals it', async () => {
    // WAS (round 1): the whole version was quarantined; (round 2) only the prefix was served. Now nothing verifiable is hidden.
    const L = rows(100); await build(t.dir, L);
    const ip = path.join(vdir(t.dir), 'index.bin'); const bp = path.join(vdir(t.dir), 'body-0000000000000000.bin');
    const dmgIndex = flip(ip, recPos(50) + 20);
    const at70 = L.slice(0, 70).reduce((n, l) => n + l.length, 0) + 5;
    const dmgBody = flip(bp, at70);
    const s = await ChatStore.open(t.dir);
    const head = await s.head(V(1));
    // record 50 is re-derived (and confirmed by the valid record 51); line 70's body disagrees with its valid record
    expect(head.lines).toBe(100); expect(head.hash).toBe(refChains(L).raw[100]); expect(head.damagedFromLine).toBe(70);
    expect(asideDirs(t.dir)).toEqual([]);
    expect(Buffer.concat((await s.read(V(1), 0, 0, 70)) as Buffer[]).equals(Buffer.concat(L.slice(0, 70)))).toBe(true);
    expect(Buffer.concat((await s.read(V(1), 0, 71, 100)) as Buffer[]).equals(Buffer.concat(L.slice(71, 100)))).toBe(true);
    await rejects(s.read(V(1), 0, 70, 71), 'corrupt');
    // nothing is gone: the old index (damaged record included) is kept, and the rotted byte is still in the body
    expect(fs.readFileSync(path.join(vdir(t.dir), 'replaced-index', 'index-0001.bin')).equals(dmgIndex)).toBe(true);
    expect(fs.readFileSync(bp).equals(dmgBody)).toBe(true);
    // a correct resend heals (the lines are chain-checked against the kept prefix), and the flag clears
    expect(await s.append(V(1), 0, 70, L.slice(70))).toBe('ok');
    const healed = await s.head(V(1));
    expect(healed.lines).toBe(100); expect(healed.hash).toBe(refChains(L).raw[100]); expect(healed.damagedFromLine).toBeNull();
    expect((await readAll(s, 100)).equals(Buffer.concat(L))).toBe(true);
    expect((await s.verify(V(1))).ok).toBe(true);
    await s.close();
  });

  it('a missing middle body chunk is "damaged" with the rest kept, not a raw ENOENT', async () => {
    const L = rows(100); await build(t.dir, L, { chunkBytes: 900 });
    const bodies = fs.readdirSync(vdir(t.dir)).filter((f) => f.startsWith('body-')).sort();
    expect(bodies.length).toBeGreaterThan(3);
    fs.unlinkSync(path.join(vdir(t.dir), bodies[2]));
    const s = await ChatStore.open(t.dir, { chunkBytes: 900 });
    await rejects(s.head(V(1)), 'damaged');
    const q = path.join(t.dir, 'aside', asideDirs(t.dir)[0]);
    expect(fs.readdirSync(q).filter((f) => f.startsWith('body-')).length).toBe(bodies.length - 1);
    expect(fs.existsSync(path.join(q, 'index.bin'))).toBe(true);
    await s.close();
  });

  it('a body shorter than its index (acknowledged lines missing) is damaged, not silently trimmed', async () => {
    const L = rows(30); await build(t.dir, L);
    const bp = path.join(vdir(t.dir), 'body-0000000000000000.bin');
    const size = fs.statSync(bp).size;
    fs.truncateSync(bp, size - 5);
    const s = await ChatStore.open(t.dir);
    await rejects(s.head(V(1)), 'damaged');
    const q = path.join(t.dir, 'aside', asideDirs(t.dir)[0]);
    expect(fs.statSync(path.join(q, 'body-0000000000000000.bin')).size).toBe(size - 5);
    expect(fs.statSync(path.join(q, 'index.bin')).size).toBe(recPos(30));
    await s.close();
  });

  it('a torn final index record loses no line: the whole body line is adopted and the cut-off record bytes are kept', async () => {
    const L = rows(40); await build(t.dir, L);
    fs.truncateSync(path.join(vdir(t.dir), 'index.bin'), recPos(39) + 50);
    const s = await ChatStore.open(t.dir);
    // an index write had started, so the body line is whole: it is ADOPTED (head 40), and the cut-off record bytes are kept
    expect((await s.head(V(1))).lines).toBe(40);
    const torn = fs.readdirSync(path.join(vdir(t.dir), 'torn'));
    expect(torn.map((f) => fs.readFileSync(path.join(vdir(t.dir), 'torn', f)).length)).toContain(50);
    expect(await s.append(V(1), 0, 0, L)).toBe('ok');
    expect((await s.verify(V(1))).ok).toBe(true);
    await s.close();
  });

  it('a rotted FINAL record (CRC) is re-derived from its body line, the old record kept aside', async () => {
    const L = rows(40); await build(t.dir, L);
    flip(path.join(vdir(t.dir), 'index.bin'), recPos(39) + 20);
    const s = await ChatStore.open(t.dir);
    expect((await s.head(V(1))).lines).toBe(40);
    expect((await s.verify(V(1))).ok).toBe(true);
    const kept = fs.readdirSync(path.join(vdir(t.dir), 'torn')).map((f) => fs.readFileSync(path.join(vdir(t.dir), 'torn', f)));
    expect(kept.some((b) => b.length === REC)).toBe(true);
    await s.close();
  });

  it('body bytes past the last record with a clean index (an append killed before its index write) are kept aside, never acknowledged', async () => {
    const L = rows(10); await build(t.dir, L);
    fs.appendFileSync(path.join(vdir(t.dir), 'body-0000000000000000.bin'), cc.user('never acknowledged'));
    const s = await ChatStore.open(t.dir);
    expect((await s.head(V(1))).lines).toBe(10);
    const kept = fs.readdirSync(path.join(vdir(t.dir), 'torn')).map((f) => fs.readFileSync(path.join(vdir(t.dir), 'torn', f)));
    expect(kept.some((b) => b.includes('never acknowledged'))).toBe(true);
    expect(await s.append(V(1), 0, 10, rows(2, 'n'))).toBe('ok');
    await s.close();
  });
});

// ---------------------------------------------------------------------------------------------- C2
describe('C2: one writer per store root', () => {
  it('a second open of a held root fails with store-locked; after close it opens', async () => {
    const a = await openWith(t.dir);
    await rejects(ChatStore.open(t.dir), 'store-locked');
    await a.close();
    const b = await ChatStore.open(t.dir);
    await b.close();
  });

  it('the review demonstration (two openers, same position) can no longer lose an acknowledged line', async () => {
    const L = rows(10);
    const a = await openWith(t.dir); await a.append(V(1), 0, 0, L);
    await rejects(ChatStore.open(t.dir), 'store-locked');
    expect(await a.append(V(1), 0, 10, rows(1, 'a'))).toBe('ok');
    await a.close();
    const c = await ChatStore.open(t.dir);
    expect((await c.head(V(1))).lines).toBe(11);
    await c.close();
  });

  it('defence in depth: even with the lock file removed by hand, a stale writer refuses to overwrite a moved index', async () => {
    const A = await openWith(t.dir); await A.append(V(1), 0, 0, rows(10));
    fs.unlinkSync(path.join(t.dir, 'LOCK'));
    const B = await ChatStore.open(t.dir); await B.head(V(1));
    expect(await B.append(V(1), 0, 10, rows(2, 'b'))).toBe('ok');
    // WHY store-locked and not corrupt (N9d): the write is now refused BEFORE it touches a file, because the lock is no longer ours
    await rejects(A.append(V(1), 0, 10, rows(1, 'a')), 'store-locked');
    await B.close();
    const C = await ChatStore.open(t.dir);
    expect((await C.head(V(1))).lines).toBe(12);
    await C.close();
  });

  it('a lock left by a dead process is taken over', async () => {
    const a = await openWith(t.dir); await a.append(V(1), 0, 0, rows(3));
    const lock = JSON.parse(fs.readFileSync(path.join(t.dir, 'LOCK'), 'utf8'));
    await a.close();
    fs.writeFileSync(path.join(t.dir, 'LOCK'), JSON.stringify({ ...lock, pid: 2147483646, start: 'x' }));
    const b = await ChatStore.open(t.dir);
    expect((await b.head(V(1))).lines).toBe(3);
    await b.close();
    expect(fs.existsSync(path.join(t.dir, 'LOCK'))).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('a reused pid (alive, but started at a different time) does not keep a stale lock alive', async () => {
    const a = await openWith(t.dir);
    const lock = JSON.parse(fs.readFileSync(path.join(t.dir, 'LOCK'), 'utf8'));
    expect(typeof lock.start).toBe('string');
    await a.close();
    fs.writeFileSync(path.join(t.dir, 'LOCK'), JSON.stringify({ ...lock, start: String(Number(lock.start) + 12345) }));
    const b = await ChatStore.open(t.dir);
    await b.close();
  });

  it.skipIf(process.platform === 'win32')('a lock held by a live foreign process (real child) is respected, and released when it exits', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const probe = await openWith(t.dir); await probe.close();
      const start = process.platform === 'linux' ? fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8').slice(fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8').lastIndexOf(')') + 2).split(' ')[19] : null;
      const os = await import('node:os');
      fs.writeFileSync(path.join(t.dir, 'LOCK'), JSON.stringify({ pid: child.pid, start, host: os.hostname(), token: 'child' }));
      await rejects(ChatStore.open(t.dir), 'store-locked');
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
      const b = await ChatStore.open(t.dir);
      await b.close();
    } finally { child.kill('SIGKILL'); }
  });

  it('a lock from another machine (shared folder) is never taken over by itself, but offers the evidence so the caller can decide (N9)', async () => {
    const probe = await openWith(t.dir); await probe.close();
    fs.writeFileSync(path.join(t.dir, 'LOCK'), JSON.stringify({ pid: 2147483646, start: 'x', host: 'some-other-computer', token: 'z' }));
    const err = await ChatStore.open(t.dir).then(() => null, (e) => e);
    expect(err).toMatchObject({ name: 'StoreError', code: 'store-locked-stale?' });
    expect(err.evidence).toMatchObject({ pid: 2147483646, host: 'some-other-computer', token: 'z', breakLockToken: 'z' });
    expect(err.evidence.why).toContain('some-other-computer');
    // the caller says "yes, break it" with the token it was shown; a different token breaks nothing
    await rejects(ChatStore.open(t.dir, { breakLockToken: 'not-that-one' }), 'store-locked-stale?');
    const b = await ChatStore.open(t.dir, { breakLockToken: err.evidence.breakLockToken });
    await b.close();
  });
});

// ---------------------------------------------------------------------------------------------- H1
describe('H1: setAsideTail replay never cuts lines appended since', () => {
  const takeover = 'ab'.repeat(32);
  it('a redelivered call after the new host appended returns the original result and leaves the new lines', async () => {
    const L = rows(20);
    const s = await openWith(t.dir); await s.append(V(1), 0, 0, L);
    expect((await s.setAsideTail(takeover, V(1), 10)).lines).toBe(10);
    const fresh = rows(5, 'new');
    expect(await s.append(V(1), 0, 10, fresh)).toBe('ok');
    expect((await s.setAsideTail(takeover, V(1), 10)).lines).toBe(10);
    expect((await s.head(V(1))).lines).toBe(15);
    expect(Buffer.concat((await s.read(V(1), 0, 10, 15)) as Buffer[]).equals(Buffer.concat(fresh))).toBe(true);
    await s.close();
  });
  it('a retry after fromLine was clamped is accepted (it used to throw)', async () => {
    const s = await openWith(t.dir); await s.append(V(1), 0, 0, rows(3));
    expect((await s.setAsideTail(takeover, V(1), 9)).lines).toBe(0);
    expect((await s.setAsideTail(takeover, V(1), 9)).lines).toBe(0);
    expect((await s.head(V(1))).lines).toBe(3);
    await s.close();
  });
  it('a retry whose cut was cut short still finishes the cut (lines beyond are exactly the saved tail)', async () => {
    const L = rows(12);
    const s = await openWith(t.dir); await s.append(V(1), 0, 0, L);
    await s.setAsideTail(takeover, V(1), 4);
    // simulate "tail file durable, cut not done": put the tail lines back and remove the "cut done" marker (N15)
    expect(await s.append(V(1), 0, 4, L.slice(4))).toBe('ok');
    fs.unlinkSync(path.join(vdir(t.dir), 'tails', `${takeover}.done`));
    expect((await s.head(V(1))).lines).toBe(12);
    await s.setAsideTail(takeover, V(1), 4);
    expect((await s.head(V(1))).lines).toBe(4);
    await s.close();
  });
  it('N15: once the cut is recorded as done, byte-identical lines appended later are NOT cut again by a replay', async () => {
    const L = rows(12);
    const s = await openWith(t.dir); await s.append(V(1), 0, 0, L);
    await s.setAsideTail(takeover, V(1), 4);
    expect(await s.append(V(1), 0, 4, L.slice(4))).toBe('ok');         // the new host happens to write the same lines
    expect((await s.setAsideTail(takeover, V(1), 4)).lines).toBe(8);   // redelivered request: the original answer...
    expect((await s.head(V(1))).lines).toBe(12);                       // ...and the lines stay
    await s.close();
  });
});

// ---------------------------------------------------------------------------------------------- H2
describe('H2: set-aside of a damaged copy keeps the aside index at every kill point', () => {
  it('a rerun after the files moved never moves the fresh index over the aside copy (intent removed before the fresh index)', async () => {
    const L = rows(10); await build(t.dir, L);
    const orig = fs.readFileSync(path.join(vdir(t.dir), 'index.bin'));
    // state "moves done, intent still there, fresh header-only index already created": the review's kill point
    const s = await ChatStore.open(t.dir); await s.setAsideDamaged(V(1)); await s.close();
    const name = asideDirs(t.dir)[0];
    fs.writeFileSync(path.join(vdir(t.dir), 'aside.intent'), encodeSide({ asideName: name }));
    const s2 = await ChatStore.open(t.dir);
    expect((await s2.head(V(1))).lines).toBe(0);
    expect(fs.readFileSync(path.join(t.dir, 'aside', name, 'index.bin')).equals(orig)).toBe(true);
    await s2.close();
  });
});

// ---------------------------------------------------------------------------------------------- H3
describe('H3: body bytes are checked against the chain', () => {
  it('a flipped body byte is a typed corrupt on read, flagged in head, and not ok in verify', async () => {
    const L = rows(30); await build(t.dir, L);
    flip(path.join(vdir(t.dir), 'body-0000000000000000.bin'), L.slice(0, 7).reduce((n, l) => n + l.length, 0) + 4);
    const s = await ChatStore.open(t.dir);
    await rejects(s.read(V(1), 0, 5, 9), 'corrupt');
    expect((await s.read(V(1), 0, 10, 20) as Buffer[]).length).toBe(10); // undamaged lines still served
    expect((await s.head(V(1))).damagedFromLine).toBe(7);
    expect(await s.verify(V(1))).toMatchObject({ ok: false, firstBadLine: 7 });
    await s.close();
  });

  it('a correct resend over a damaged body heals it (bad bytes kept aside) instead of answering ok and leaving it', async () => {
    const L = rows(30); await build(t.dir, L);
    const bp = path.join(vdir(t.dir), 'body-0000000000000000.bin');
    const at = L.slice(0, 7).reduce((n, l) => n + l.length, 0);
    flip(bp, at + 4);
    const bad = fs.readFileSync(bp).subarray(at, at + L[7].length);
    const s = await ChatStore.open(t.dir);
    expect(await s.append(V(1), 0, 0, L.slice(0, 12))).toBe('ok');
    expect((await s.verify(V(1))).ok).toBe(true);
    expect((await readAll(s, 30)).equals(Buffer.concat(L))).toBe(true);
    expect((await s.head(V(1))).damagedFromLine).toBeNull();
    const healed = fs.readdirSync(path.join(vdir(t.dir), 'healed')).map((f) => fs.readFileSync(path.join(vdir(t.dir), 'healed', f)));
    expect(healed.some((b) => b.includes(bad))).toBe(true);
    await s.close();
  });

  it('index damage older than 4,096 records is found on open (it used to go unnoticed)', async () => {
    const L = rows(5000); await build(t.dir, L);
    flip(path.join(vdir(t.dir), 'index.bin'), recPos(5) + 20);
    const s = await ChatStore.open(t.dir);
    expect((await s.head(V(1))).lines).toBe(5000);
    expect(fs.readdirSync(path.join(vdir(t.dir), 'replaced-index')).length).toBe(1); // found and repaired
    expect((await s.verify(V(1))).ok).toBe(true);
    await s.close();
  });

  it('scrubStep walks the version with a persisted high-water mark and finds old body damage', async () => {
    const L = rows(400); await build(t.dir, L);
    flip(path.join(vdir(t.dir), 'body-0000000000000000.bin'), L.slice(0, 350).reduce((n, l) => n + l.length, 0) + 4);
    let s = await ChatStore.open(t.dir, { scrubOnOpenBytes: 0 });
    let r = await s.scrubStep(V(1), { maxBytes: 4000 });
    expect(r.verifiedLines).toBeGreaterThan(0); expect(r.verifiedLines).toBeLessThan(400);
    const first = r.verifiedLines;
    await s.close();
    s = await ChatStore.open(t.dir, { scrubOnOpenBytes: 0 }); // the mark survives a restart
    r = await s.scrubStep(V(1), { maxBytes: 4000 });
    expect(r.verifiedLines).toBeGreaterThan(first);
    for (let i = 0; i < 100 && r.damagedFromLine === null; i++) r = await s.scrubStep(V(1), { maxBytes: 4000 });
    expect(r.damagedFromLine).toBe(350);
    await s.close();
  });
});

// ---------------------------------------------------------------------------------------------- H4
describe('H4: an eviction proof cannot be self-asserted', () => {
  const ack = (holder: string, through: number, hash: string, version = vhex) => ({ holder, version, lines: through, hash, signature: 'sig' });
  const proof = (through: number, hash: string, holders = ['dev-a']): EvictionProof => ({ kind: 'holders-confirmed', version: vhex, through, hash, acks: holders.map((h) => ack(h, through, hash)) });

  it('the default store refuses every proof, including a fake holder plus the store\'s own hashAt', async () => {
    const s = await openWith(t.dir); await s.append(V(1), 0, 0, rows(6));
    const own = (await s.hashAt(V(1), 0, 4))!;
    await rejects(s.evictBody(V(1), proof(4, own, ['nobody'])), 'bad-proof');
    expect((await s.head(V(1))).evictedLines).toBe(0);
    await s.close();
  });

  it('a supplied verifier decides; the store also checks the proof is bound to this version, line count and chain value', async () => {
    const seen: string[] = [];
    const verifier: ProofVerifier = (p, ctx) => { seen.push(`${ctx.version.slice(0, 4)}:${ctx.lines}`); return p.acks.every((a) => a.signature === 'sig'); };
    const s = await openWith(t.dir, V(1), { proofVerifier: verifier }); await s.append(V(1), 0, 0, rows(8));
    const h4 = (await s.hashAt(V(1), 0, 4))!; const h5 = (await s.hashAt(V(1), 0, 5))!;
    const good = proof(4, h4);
    for (const bad of [
      { ...good, acks: [ack('dev-a', 4, h4, 'aa')] },                  // ack for another version
      { ...good, acks: [ack('dev-a', 3, h4)] },                         // ack for another line count
      { ...good, acks: [ack('dev-a', 4, h5)] },                         // ack for another chain value
      { ...good, acks: [] },
      { ...good, acks: [ack('a', 4, h4), ack('a', 4, h4)] },            // same holder twice
      { ...good, version: 'aa' },
    ]) await rejects(s.evictBody(V(1), bad as EvictionProof), 'bad-proof');
    expect(seen).toEqual([]);                                           // the verifier is only asked about well-bound proofs
    expect((await s.evictBody(V(1), good)).evictedLines).toBe(4);
    expect(seen).toEqual([`${vhex.slice(0, 4)}:4`]);
    expect((decodeSide(fs.readFileSync(path.join(vdir(t.dir), 'evicted.json'))) as { value: { holders: string[] } }).value.holders).toEqual(['dev-a']);
    await s.close();
  });

  it('a verifier that answers anything but true, or throws, refuses', async () => {
    for (const v of [(() => 1) as unknown as ProofVerifier, (() => 'yes') as unknown as ProofVerifier, (() => { throw new Error('boom'); }) as ProofVerifier, (() => Promise.resolve(false)) as ProofVerifier]) {
      const t2 = await tmpRoot();
      try {
        const s = await openWith(t2.dir, V(1), { proofVerifier: v }); await s.append(V(1), 0, 0, rows(4));
        await rejects(s.evictBody(V(1), proof(3, (await s.hashAt(V(1), 0, 3))!)), 'bad-proof');
        await s.close();
      } finally { await t2.cleanup(); }
    }
  });

  it('eviction refuses to drop a copy whose bytes no longer match the chain', async () => {
    const L = rows(12); await build(t.dir, L);
    flip(path.join(vdir(t.dir), 'body-0000000000000000.bin'), 30);
    const s = await ChatStore.open(t.dir, { proofVerifier: () => true });
    const h = (await s.hashAt(V(1), 0, 6))!;
    await rejects(s.evictBody(V(1), proof(6, h)), 'corrupt');
    await s.close();
  });
});

// ---------------------------------------------------------------------------------------------- M1
describe('M1: adapter detects a same-size edit in the middle of a big file (rolling scrub)', () => {
  const seeds = defaultChainSeeds({ chatId: 'm1', version: new Uint8Array(), segment: 0 });
  const opts: AdapterOptions = { runtime: 'claude-code', seeds, scrubBytesPerPoll: 20_000 };
  const ok = (r: PollResult): PollBatch => { if (isRewritten(r)) throw new Error('rewritten ' + r.rewritten); return r; };
  it('is found within ceil(offset / scrubBytesPerPoll) polls, and a clean file never reports a false alarm', async () => {
    const f = path.join(t.dir, 'chat.jsonl');
    const L = rows(400);
    fs.writeFileSync(f, Buffer.concat(L));
    let r = ok(await poll(f, initAdapterState(seeds), opts));
    const offset = r.state.offset;
    // clean file: many polls, appends in between, all quiet
    for (let i = 0; i < 40; i++) { fs.appendFileSync(f, rows(1, 'a' + i)[0]); r = ok(await poll(f, r.state, opts)); }
    const bound = Math.ceil(r.state.offset / 20_000) + 2;
    // same-size edit in the middle (line 1000 of the review: here line 200), then growth
    const buf = fs.readFileSync(f); const at = L.slice(0, 200).reduce((n, l) => n + l.length, 0) + 30;
    expect(buf[at]).not.toBe(0x41); buf[at] = 0x41; fs.writeFileSync(f, buf);
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    let found = -1;
    for (let i = 1; i <= bound + 2 && found < 0; i++) {
      fs.appendFileSync(f, rows(1, 'b' + i)[0]);
      const x = await poll(f, r.state, opts);
      if (isRewritten(x)) found = i; else r = x;
    }
    expect(found).toBeGreaterThan(0);
    expect(found).toBeLessThanOrEqual(bound);
    expect(offset).toBeGreaterThan(0);
  });
  it('the scrub position is JSON-safe state and does not cost more than its budget per poll', async () => {
    const f = path.join(t.dir, 'chat2.jsonl');
    fs.writeFileSync(f, Buffer.concat(rows(300)));
    const r = ok(await poll(f, initAdapterState(seeds), opts));
    fs.utimesSync(f, new Date(), new Date(Date.now() + 3000));
    const x = ok(await poll(f, JSON.parse(JSON.stringify(r.state)), opts));
    expect(x.state.scrub).not.toBeNull();
    expect(x.state.scrub!.pos).toBeGreaterThan(0);
    expect(x.state.scrub!.pos).toBeLessThan(r.state.offset);
  });
});

// ---------------------------------------------------------------------------------------------- M2
describe('M2: new directories are durable, and the fault shim models un-synced directory entries', () => {
  it('the shim drops a directory (and files in it) whose parent was never fsynced, keeps one that was', async () => {
    const f = new FaultFs(0, { powerLoss: true });
    await f.mkdir(path.join(t.dir, 'kept')); await f.fsyncDir(t.dir);
    await f.mkdir(path.join(t.dir, 'lost'));
    const h = await f.open(path.join(t.dir, 'lost', 'x'), { create: true }); await h.write(Buffer.from('a'), 0); await h.sync(); await h.close();
    await f.applyPowerLoss();
    expect(fs.existsSync(path.join(t.dir, 'kept'))).toBe(true);
    expect(fs.existsSync(path.join(t.dir, 'lost'))).toBe(false);
  });
  it('a created file not followed by fsyncDir is gone after power loss; a rename onto a new name is undone', async () => {
    const f = new FaultFs(0, { powerLoss: true });
    await fs.promises.writeFile(path.join(t.dir, 'old'), 'zz');
    const h = await f.open(path.join(t.dir, 'new'), { create: true }); await h.write(Buffer.from('a'), 0); await h.sync(); await h.close();
    await f.rename(path.join(t.dir, 'old'), path.join(t.dir, 'moved'));
    await f.applyPowerLoss();
    expect(fs.existsSync(path.join(t.dir, 'new'))).toBe(false);
    expect(fs.existsSync(path.join(t.dir, 'old'))).toBe(true); expect(fs.existsSync(path.join(t.dir, 'moved'))).toBe(false);
  });
  it('an unsynced truncate is not zero-extended back by the power-loss step', async () => {
    const p = path.join(t.dir, 'file');
    await fs.promises.writeFile(p, Buffer.alloc(100, 7));
    const f = new FaultFs(0, { powerLoss: true });
    const h = await f.open(p, { create: false }); await h.truncate(40); await h.close();
    await f.applyPowerLoss();
    expect(fs.statSync(p).size).toBeLessThanOrEqual(100);
    expect(fs.readFileSync(p).subarray(0, 40).equals(Buffer.alloc(40, 7))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------- M3
describe('M3: control log', () => {
  const idOf = (body: Buffer) => createHash('sha256').update(body).digest('hex');
  const mk = (n: number, seen: string[] = []) => { const body = Buffer.from('ctl-' + n); return { id: idOf(body), chat: CHAT, seen, body }; };

  const logDir = () => path.join(t.dir, 'control', createHash('sha256').update(CHAT).digest('hex'));
  it('a damaged middle record is skipped, reported, and every later entry is still served (N2); log.bin is never cut', async () => {
    const e1 = mk(1); const e2 = mk(2, [e1.id]); const e3 = mk(3, [e2.id]);
    const s = await openWith(t.dir);
    for (const e of [e1, e2, e3]) await s.appendControl(e);
    await s.close();
    const dir = logDir();
    const before = fs.readFileSync(path.join(dir, 'log.bin'));
    const firstLen = 16 + before.readUInt32BE(4);
    flip(path.join(dir, 'log.bin'), firstLen + 20);               // inside record 2's payload
    const after = fs.readFileSync(path.join(dir, 'log.bin'));
    const s2 = await ChatStore.open(t.dir);
    expect((await s2.controlLog(CHAT)).map((e) => e.id)).toEqual([e1.id, e3.id]);
    const dmg = await s2.controlDamage(CHAT);
    expect(dmg).toHaveLength(1); expect(dmg[0].offset).toBe(firstLen); expect(dmg[0].why).toContain('checksum');
    expect(fs.readFileSync(path.join(dir, 'log.bin')).equals(after)).toBe(true);
    // appends still work, and e2's loss is recoverable: re-appending it (from a peer) is stored again
    expect(await s2.appendControl(mk(4, [e3.id]))).toBe('ok');
    expect(await s2.appendControl(e2)).toBe('ok');
    expect((await s2.controlLog(CHAT)).map((e) => e.id).sort()).toEqual([e1.id, e2.id, e3.id, mk(4).id].sort());
    await s2.close();
    const s3 = await ChatStore.open(t.dir);                      // and it all survives a reopen
    expect((await s3.controlLog(CHAT)).length).toBe(4);
    await s3.close();
  });

  it('N2 review demonstration: one flipped bit in a record LENGTH no longer reads as a torn tail that drops the 7 entries after it', async () => {
    const es: ReturnType<typeof mk>[] = [];
    for (let i = 1; i <= 10; i++) es.push(mk(i, i > 1 ? [es[i - 2].id] : []));
    const s = await openWith(t.dir);
    for (const e of es) await s.appendControl(e);
    await s.close();
    const lp = path.join(logDir(), 'log.bin');
    const b = fs.readFileSync(lp);
    let pos = 0; for (let i = 0; i < 2; i++) pos += 16 + b.readUInt32BE(pos + 4);   // start of record 3
    b[pos + 4 + 1] ^= 0x40;                                      // a bit in its length field
    fs.writeFileSync(lp, b);
    const s2 = await ChatStore.open(t.dir);
    expect((await s2.controlLog(CHAT)).map((e) => e.id)).toEqual(es.filter((_, i) => i !== 2).map((e) => e.id));
    expect((await s2.controlDamage(CHAT)).length).toBe(1);
    expect(fs.readdirSync(logDir()).filter((n) => n.startsWith('torn-'))).toEqual([]);   // nothing was cut away
    expect(fs.readFileSync(lp).equals(b)).toBe(true);
    await s2.close();
  });

  it('a torn FINAL record is cut but its bytes are kept', async () => {
    const e1 = mk(1); const e2 = mk(2, [e1.id]);
    const s = await openWith(t.dir); await s.appendControl(e1); await s.appendControl(e2); await s.close();
    const dir = path.join(t.dir, 'control', createHash('sha256').update(CHAT).digest('hex'));
    const lp = path.join(dir, 'log.bin'); fs.truncateSync(lp, fs.statSync(lp).size - 3);
    const s2 = await ChatStore.open(t.dir);
    expect((await s2.controlLog(CHAT)).map((e) => e.id)).toEqual([e1.id]);
    expect(fs.readdirSync(dir).some((n) => n.startsWith('torn-'))).toBe(true);
    await s2.close();
  });

  it('an entry id that is not the SHA-256 of its body is refused (a forged early body cannot claim a real id)', async () => {
    const s = await openWith(t.dir);
    const real = mk(1);
    await rejects(s.appendControl({ ...real, body: Buffer.from('forged') }), 'bad-argument');
    expect(await s.appendControl(real)).toBe('ok');
    await s.close();
  });

  it('an entry that lists itself in seen is refused; parked entries are capped (typed)', async () => {
    const s = await openWith(t.dir, V(1), { maxParkedControl: 5 });
    const self = mk(1); self.seen = [self.id];
    await rejects(s.appendControl(self), 'bad-argument');
    const missing = idOf(Buffer.from('never arrives'));
    for (let i = 0; i < 5; i++) expect(await s.appendControl(mk(10 + i, [missing]))).toBe('parked');
    await rejects(s.appendControl(mk(99, [missing])), 'parked-full');
    expect(await s.appendControl(mk(10, [missing]))).toBe('parked'); // an already-parked entry again is fine
    await s.close();
  });
});

// ---------------------------------------------------------------------------------------------- M4
describe('M4: parked appends are bounded', () => {
  it('thousands of parks stay fast (no per-park rescan of every parked file) and past the cap are refused loudly', async () => {
    const s = await openWith(t.dir, V(1), { maxParkedFiles: 1500 });
    const cpu0 = process.cpuUsage();
    for (let i = 0; i < 1500; i++) expect(await s.append(V(1), 0, 10 + i, [nl({ type: 'user', i })])).toBe('parked');
    const cpuSecs = (process.cpuUsage(cpu0).user + process.cpuUsage(cpu0).system) / 1e6; // CPU time, not wall clock (test-suite rules); the old per-park rescan took ~28 s for the second thousand
    await rejects(s.append(V(1), 0, 99999, [nl({ type: 'user', i: 'x' })]), 'parked-full');
    expect(cpuSecs).toBeLessThan(25);
    expect(await s.append(V(1), 0, 10, [nl({ type: 'user', i: 0 })])).toBe('parked'); // the same park again
    await s.close();
  }, 60_000);

  it('a line number absurdly far past the head is refused, not parked', async () => {
    const s = await openWith(t.dir);
    await rejects(s.append(V(1), 0, 2 ** 40, [cc.user('x')]), 'bad-argument');
    await s.close();
  });

  it('parked lines still apply in order when the gap fills (file naming holds past 12 digits)', async () => {
    const L = rows(6);
    const s = await openWith(t.dir, V(1), { maxParkGap: 2 ** 41 });
    expect(await s.append(V(1), 0, 3, L.slice(3))).toBe('parked');
    expect(await s.append(V(1), 0, 2 ** 40, [cc.user('far')])).toBe('parked');
    expect(await s.append(V(1), 0, 0, L.slice(0, 3))).toBe('ok');
    expect((await s.head(V(1))).lines).toBe(6);
    await s.close();
  });
});

// ---------------------------------------------------------------------------------------------- M5
describe('M5: classifier stamp', () => {
  it('the stamp is stored with the chain and reported in head()', async () => {
    const s = await openWith(t.dir); await s.append(V(1), 0, 0, rows(3));
    const h = await s.head(V(1));
    expect(h.classifierStamp).toBeGreaterThan(0);
    await s.close();
  });
  it('a store written under a different classifier stamp is detected and re-derived from bodies (old index kept)', async () => {
    const L = ccConversation().lines; await build(t.dir, L);
    const ip = path.join(vdir(t.dir), 'index.bin'); const b = fs.readFileSync(ip);
    const written = b.readUInt32BE(12); expect(written).toBeGreaterThan(0);
    b.writeUInt32BE(written + 2, 12); fs.writeFileSync(ip, b);          // as if an older app version wrote it
    const s = await ChatStore.open(t.dir);
    const h = await s.head(V(1));
    expect(h.classifierStamp).toBe(written);
    expect(h.hash).toBe(refChains(L).raw[L.length]); expect(h.conversationHash).toBe(refChains(L).conv);
    expect(fs.readdirSync(path.join(vdir(t.dir), 'replaced-index')).length).toBe(1);
    expect((await s.verify(V(1))).ok).toBe(true);
    await s.close();
  });
  it('changing the reply-end option changes the stamp (so two settings never silently mix)', async () => {
    const L = ccConversation().lines; await build(t.dir, L);
    const s = await ChatStore.open(t.dir, { replyEnd: { apiErrorsEndReplies: false } });
    const h = await s.head(V(1));
    expect(h.classifierStamp % 2).toBe(0);
    await s.close();
  });
});

// ---------------------------------------------------------------------------------------------- M6
describe('M6: reply ends for assistant lines without a message id', () => {
  const run = (lines: Buffer[]) => {
    let rs = initialReplyState(); const confirmed: number[] = [];
    lines.forEach((l, i) => { const o = replyEndStep('claude-code', rs, analyseLine('claude-code', l), i); rs = o.rs; confirmed.push(...o.confirmed); });
    return { confirmed, pending: rs.cand ? rs.cand.n : null };
  };
  const noId = (stop: string | null) => nl({ type: 'assistant', uuid: 'u-x', message: { model: 'synthetic-model-1', stop_reason: stop, content: [{ type: 'text' }] } });
  it('two consecutive end-of-turn lines with no id are two reply ends', () => {
    expect(run([noId('end_turn'), noId('end_turn')])).toEqual({ confirmed: [0], pending: 1 });
  });
  it('an interrupt marker followed by an id-less assistant line is confirmed', () => {
    expect(run([cc.user('q'), cc.interrupt(), noId('end_turn')])).toEqual({ confirmed: [1], pending: 2 });
  });
  it('an id-less line after an identified one confirms it (and vice versa)', () => {
    expect(run([cc.block('m1', 'end_turn'), noId('end_turn'), cc.block('m2', 'end_turn')])).toEqual({ confirmed: [0, 1], pending: 2 });
  });
  it('the stop-reason list is explicit: pause_turn is not a reply end; max_tokens and refusal are', () => {
    expect(run([cc.block('m1', 'pause_turn'), cc.user('x')])).toEqual({ confirmed: [], pending: null });
    expect(run([cc.block('m1', 'max_tokens'), cc.user('x')]).confirmed).toEqual([0]);
    expect(run([cc.block('m1', 'refusal'), cc.user('x')]).confirmed).toEqual([0]);
    expect(run([cc.block('m1', 'tool_use'), cc.user('x')]).confirmed).toEqual([]);
  });
  it('real-shaped transcript: a message split into blocks with the same id stays ONE reply end', () => {
    expect(run([cc.user('q'), cc.block('m1', 'end_turn', 'thinking'), cc.block('m1', 'end_turn', 'text'), cc.user('q2')]).confirmed).toEqual([2]);
  });
  it('the store agrees with the pure tracker on id-less lines', async () => {
    const L = [noId('end_turn'), noId('end_turn'), cc.user('x')];
    const s = await openWith(t.dir); await s.append(V(1), 0, 0, L);
    expect(await s.replyEnds(V(1))).toEqual({ confirmed: [0, 1], pending: null });
    await s.close();
  });
});

// ---------------------------------------------------------------------------------------------- M7 / lows
describe('M7: more failure cases', () => {
  it('randomised seed: append/reopen/damage-tail rounds always reopen to a verified prefix (seed printed on failure)', async () => {
    const seed = Math.floor(Math.random() * 1e9);
    let a = seed >>> 0; const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    const L = rows(60, 'rand'); const REF = refChains(L);
    try {
      for (let round = 0; round < 8; round++) {
        const s = await ChatStore.open(t.dir); await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' });
        const have = (await s.head(V(1))).lines;
        const n = Math.min(L.length - have, 1 + Math.floor(rnd() * 12));
        expect(await s.append(V(1), 0, have, L.slice(have, have + n))).toBe('ok');
        await s.close();
        const ip = path.join(vdir(t.dir), 'index.bin'); const size = fs.statSync(ip).size;
        if (rnd() < 0.5) fs.truncateSync(ip, size - Math.floor(rnd() * REC));        // tear the last record
      }
      const s = await ChatStore.open(t.dir); const h = await s.head(V(1));
      expect(h.hash).toBe(REF.raw[h.lines]);
      expect((await s.verify(V(1))).ok).toBe(true);
      expect(await s.append(V(1), 0, 0, L)).toBe('ok');
      await s.close();
    } catch (e) { (e as Error).message = `[seed ${seed}] ` + (e as Error).message; throw e; }
  });

  it('a tail replay and the review\'s two-instance, body-flip and deleted-index cases are all covered above', () => { expect(true).toBe(true); });
});

describe('L2/L4/L5/L6/L8/L9', () => {
  it('L2: argument errors reject (never throw synchronously)', async () => {
    const s = await openWith(t.dir);
    let thrown = false; let p: Promise<unknown> | undefined;
    try { p = s.append(V(1), 0, 0, [Buffer.from('no newline')]); } catch { thrown = true; }
    expect(thrown).toBe(false); await rejects(p!, 'bad-line');
    for (const f of [() => s.putExtra('00'.repeat(32), Buffer.from('x')), () => s.hasExtra('../x'), () => s.restoreBody(V(1), [Buffer.from('x')]), () => s.setAsideTail('zz', V(1), 0), () => s.tail('zz'), () => s.evictBody(V(1), undefined as any)]) {
      let sync = false; let q: Promise<unknown> | undefined;
      try { q = f(); } catch { sync = true; }
      expect(sync).toBe(false); await expect(q).rejects.toBeInstanceOf(StoreError);
    }
    await s.close();
  });

  it('L4: reading past the head, or a negative start, is a typed refusal rather than a silent clamp', async () => {
    const s = await openWith(t.dir); await s.append(V(1), 0, 0, rows(5));
    await rejects(s.read(V(1), 0, 3, 50), 'bad-argument');
    await rejects(s.read(V(1), 0, -1, 2), 'bad-argument');
    expect(await s.read(V(1), 0, 5, 5)).toEqual([]);
    await expect((async () => { for await (const _ of s.conversationLines(V(1), -3)) { void _; } })()).rejects.toMatchObject({ code: 'bad-argument' });
    await s.close();
  });

  it('L5: restoreBody verifies the supplied lines even when the first body chunk survived', async () => {
    const L = rows(10);
    const s = await openWith(t.dir, V(1), { proofVerifier: () => true }); await s.append(V(1), 0, 0, L);
    const h = (await s.hashAt(V(1), 0, 4))!;
    await s.evictBody(V(1), { kind: 'holders-confirmed', version: vhex, through: 4, hash: h, acks: [{ holder: 'd', version: vhex, lines: 4, hash: h, signature: 's' }] });
    const wrong = L.map((l, i) => (i === 2 ? cc.user('forged') : l));
    await rejects(s.restoreBody(V(1), wrong), 'bad-argument');
    expect((await s.head(V(1))).evictedLines).toBe(4);
    expect((await s.restoreBody(V(1), L)).restoredLines).toBe(4);
    await s.close();
  });

  it('L6: a tail file with a damaged header is refused as corrupt; tail() can be told which version', async () => {
    const takeover = 'cd'.repeat(32);
    const s = await openWith(t.dir); await s.append(V(1), 0, 0, rows(6)); await s.setAsideTail(takeover, V(1), 2);
    expect((await s.tail(takeover, V(1)))!.fromLine).toBe(2);
    expect(await s.tail(takeover, V(2))).toBeNull();
    const tp = path.join(vdir(t.dir), 'tails', `${takeover}.tail`);
    flip(tp, 14);
    await rejects(s.tail(takeover), 'corrupt');
    await s.close();
  });

  it('L8: one append call above the size cap is refused with a typed error before anything is buffered', async () => {
    const s = await openWith(t.dir, V(1), { maxAppendBytes: 1000 });
    await rejects(s.append(V(1), 0, 0, [cc.user('x'.repeat(2000))]), 'limit');
    expect((await s.head(V(1))).lines).toBe(0);
    await s.close();
  });

  it('L9: extras above the size cap are refused', async () => {
    const s = await openWith(t.dir, V(1), { maxExtraBytes: 10 });
    const b = Buffer.alloc(50, 1);
    await rejects(s.putExtra(createHash('sha256').update(b).digest('hex'), b), 'limit');
    await s.close();
  });
});

describe('L3/L8 adapter', () => {
  const seeds = defaultChainSeeds({ chatId: 'l3', version: new Uint8Array(), segment: 0 });
  const opts: AdapterOptions = { runtime: 'claude-code', seeds };
  it('L3: a file replaced by an identical copy (new inode) continues by default; a rewritten one does not', async () => {
    const f = path.join(t.dir, 'a.jsonl'); const L = rows(5); fs.writeFileSync(f, Buffer.concat(L));
    let r = await poll(f, initAdapterState(seeds), opts); if (isRewritten(r)) throw new Error('x');
    const copy = path.join(t.dir, 'a.copy'); fs.writeFileSync(copy, Buffer.concat(L)); fs.renameSync(copy, f);
    fs.appendFileSync(f, rows(1, 'n')[0]);
    const r2 = await poll(f, r.state, opts);
    expect(isRewritten(r2)).toBe(false);
    const other = path.join(t.dir, 'a.other'); fs.writeFileSync(other, Buffer.concat(rows(8, 'different'))); fs.renameSync(other, f);
    const r3 = await poll(f, (r2 as PollBatch).state, opts);
    expect(isRewritten(r3) && r3.rewritten).toBe('replaced');
  });
  it('L3: a symlink or a named pipe in place of the chat file is refused, never read', async () => {
    const real = path.join(t.dir, 'real.jsonl'); fs.writeFileSync(real, Buffer.concat(rows(2)));
    const link = path.join(t.dir, 'link.jsonl'); fs.symlinkSync(real, link);
    const r = await poll(link, initAdapterState(seeds), opts);
    expect(isRewritten(r) && r.rewritten).toMatch(/^unreadable:/);
    if (process.platform !== 'win32') {
      const fifo = path.join(t.dir, 'pipe.jsonl');
      await new Promise<void>((res, rej) => execFile('mkfifo', [fifo], (e) => (e ? rej(e) : res())));
      const r2 = await poll(fifo, initAdapterState(seeds), opts);
      expect(isRewritten(r2) && r2.rewritten).toMatch(/^unreadable:/);
    }
  });
  it('L8: an unterminated line past maxLineBytes is reported, not held in memory without limit', async () => {
    const f = path.join(t.dir, 'big.jsonl'); fs.writeFileSync(f, Buffer.concat([rows(1)[0], Buffer.alloc(50_000, 0x61)]));
    const r = await poll(f, initAdapterState(seeds), { ...opts, maxLineBytes: 10_000 });
    expect(isRewritten(r) && r.rewritten).toBe('unreadable:line-too-long');
  });
});

describe('durability of acknowledged results under power loss (new directories, tails, extras, control)', () => {
  it('every acknowledged result is still there after a power cut at any later operation', async () => {
    const L = rows(12); const body = Buffer.from('extra'); const eh = createHash('sha256').update(body).digest('hex');
    const idOf = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const c1b = Buffer.from('c1'); const c2b = Buffer.from('c2');
    const run = async (s: ChatStore, p: Record<string, boolean>) => {
      await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' }); p.reg = true;
      expect(await s.append(V(1), 0, 8, L.slice(8))).toBe('parked'); p.parked = true;
      expect(await s.append(V(1), 0, 0, L.slice(0, 5))).toBe('ok'); p.five = true;
      expect((await s.setAsideTail('ee'.repeat(8), V(1), 3)).lines).toBe(2); p.tail = true;
      await s.putExtra(eh, body); p.extra = true;
      expect(await s.appendControl({ id: idOf(c1b), chat: CHAT, seen: [], body: c1b })).toBe('ok'); p.c1 = true;
      expect(await s.appendControl({ id: idOf(c2b), chat: CHAT, seen: [idOf(Buffer.from('later'))], body: c2b })).toBe('parked'); p.c2 = true;
    };
    const count = await tmpRoot(); let total = 0;
    try { const f = new FaultFs(0); const s = await ChatStore.open(count.dir, { fs: f }); await run(s, {}); total = f.ops; await s.close(); } finally { await count.cleanup(); }
    for (let k = 1; k <= total; k++) {
      const r = await tmpRoot();
      try {
        const f = new FaultFs(k, { tear: true, powerLoss: true }); const p: Record<string, boolean> = {};
        try { const s = await ChatStore.open(r.dir, { fs: f }); await run(s, p); } catch { /* the kill */ }
        await f.applyPowerLoss();
        fs.rmSync(path.join(r.dir, 'LOCK'), { force: true });          // the killed process is gone
        const s2 = await ChatStore.open(r.dir);
        const where = `kill at ${k}/${total}`;
        if (p.reg) {
          const h = await s2.head(V(1));
          if (p.five) expect(h.lines, where).toBeGreaterThanOrEqual(3);
          if (p.parked && !p.five) expect((await listFiles(r.dir)).some((x) => x.endsWith('.park')), where).toBe(true);
          if (p.tail) expect(await s2.tail('ee'.repeat(8)), where).not.toBeNull();
        }
        if (p.extra) expect(await s2.hasExtra(eh), where).toBe(true);
        if (p.c1) expect((await s2.controlLog(CHAT)).map((e) => e.id), where).toEqual([idOf(c1b)]);
        if (p.c2) expect((await s2.parkedControl(CHAT)).map((e) => e.id), where).toEqual([idOf(c2b)]);
        await s2.close();
      } finally { await r.cleanup(); }
    }
  }, 120_000);
});

describe('misc', () => {
  it('hex helper and native fixtures still available (guard against test-support drift)', () => {
    expect(hex(Buffer.from([1, 2]))).toBe('0102');
    expect(nativeConversation().lines.length).toBeGreaterThan(0);
  });
});
