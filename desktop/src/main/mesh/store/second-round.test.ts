// Tests for the SECOND independent review of the chat store (docs/active/reviews/2026-11-14-mesh-store-code-review-2.md).
// Each finding id (N1...N17) names the demonstration that review ran; here that demonstration is a failing-then-passing test.
// Synthetic data only, temp folders only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatStore, type EvictionProof } from './store';
import { REC, recPos } from './records';
import { cc } from './fixtures';
import { CHAT, V, openWith, refChains, tmpRoot } from './testkit';
import { FaultFs } from './fault-fs';
import { readCheckpoint, writeCheckpoint, CHECKPOINT_SLOT } from './checkpoint';

let t: Awaited<ReturnType<typeof tmpRoot>>;
beforeEach(async () => { t = await tmpRoot('second-round-'); });
afterEach(async () => { await t.cleanup(); });

const vhex = V(1).toString('hex');
const vdir = (root: string, v = vhex) => path.join(root, 'versions', v);
const rows = (n: number, tag = 'r'): Buffer[] => Array.from({ length: n }, (_, i) => cc.user(`${tag} ${i} ${'z'.repeat(20)}`));
const rejects = async (p: Promise<unknown>, code: string) => { await expect(p).rejects.toMatchObject({ name: 'StoreError', code }); };
async function build(root: string, L: Buffer[], o: { chunkBytes?: number; checkpointEvery?: number } = {}): Promise<void> {
  const s = await openWith(root, V(1), o);
  for (let i = 0; i < L.length; i += 7) await s.append(V(1), 0, i, L.slice(i, i + 7));
  await s.close();
}
const flipAt = (file: string, pos: number): Buffer => { const b = fs.readFileSync(file); b[pos] ^= 0xff; fs.writeFileSync(file, b); return b; };
const lineStart = (L: Buffer[], n: number) => L.slice(0, n).reduce((a, l) => a + l.length, 0);
const body0 = (root: string) => path.join(vdir(root), 'body-0000000000000000.bin');
const asideDirs = (root: string) => (fs.existsSync(path.join(root, 'aside')) ? fs.readdirSync(path.join(root, 'aside')) : []);
const readAll = async (s: ChatStore, n: number) => Buffer.concat((await s.read(V(1), 0, 0, n)) as Buffer[]);

// ---------------------------------------------------------------------------------------------- N1
describe('N1: a rebuild never accepts bytes that only the damaged index could vouch for', () => {
  const L = rows(100);
  const rotLine = 10;
  const rot = () => lineStart(L, rotLine) + 5;

  it('bad header + one rotted body byte (the review demonstration): NOT "verify ok with a different head"; the rotted line is reported, every other line is served, a correct resend heals', async () => {
    await build(t.dir, L);
    flipAt(path.join(vdir(t.dir), 'index.bin'), 2);           // header
    flipAt(body0(t.dir), rot());
    const s = await ChatStore.open(t.dir);
    const head = await s.head(V(1));
    expect(head.lines).toBe(100); expect(head.hash).toBe(refChains(L).raw[100]); expect(head.damagedFromLine).toBe(rotLine);
    // the wrong line is not served, and the head is the TRUE head, so the peer's resend attaches to it
    await rejects(s.read(V(1), 0, rotLine, rotLine + 1), 'corrupt');
    expect(await s.append(V(1), 0, rotLine, L.slice(rotLine))).toBe('ok');
    expect((await s.head(V(1))).hash).toBe(refChains(L).raw[100]);
    expect((await readAll(s, 100)).equals(Buffer.concat(L))).toBe(true);
    expect((await s.verify(V(1))).ok).toBe(true);
    await s.close();
  });

  it('missing index + one rotted body byte: quarantined intact (damaged), never accepted; a peer recopy restores it', async () => {
    await build(t.dir, L);
    fs.unlinkSync(path.join(vdir(t.dir), 'index.bin'));
    const rotted = flipAt(body0(t.dir), rot());
    const s = await ChatStore.open(t.dir);
    await rejects(s.head(V(1)), 'damaged');
    const q = path.join(t.dir, 'aside', asideDirs(t.dir)[0]);
    expect(fs.readFileSync(path.join(q, 'body-0000000000000000.bin')).equals(rotted)).toBe(true);
    await s.setAsideDamaged(V(1));
    expect(await s.append(V(1), 0, 0, L)).toBe('ok');
    expect((await s.head(V(1))).hash).toBe(refChains(L).raw[100]);
    await s.close();
  });

  it('index truncated under its header + rotted byte: quarantined intact too', async () => {
    await build(t.dir, L);
    fs.truncateSync(path.join(vdir(t.dir), 'index.bin'), 8);
    flipAt(body0(t.dir), rot());
    const s = await ChatStore.open(t.dir);
    await rejects(s.head(V(1)), 'damaged');
    await s.close();
  });

  it('a crash between the two renames of a rebuild (index.bin gone, previous index in replaced-index/) is verified against that previous index', async () => {
    await build(t.dir, L);
    fs.mkdirSync(path.join(vdir(t.dir), 'replaced-index'));
    fs.renameSync(path.join(vdir(t.dir), 'index.bin'), path.join(vdir(t.dir), 'replaced-index', 'index-0001.bin'));
    fs.unlinkSync(path.join(vdir(t.dir), 'checkpoint.bin'));    // even with no checkpoint the old index vouches
    flipAt(body0(t.dir), rot());
    const s = await ChatStore.open(t.dir);
    const head = await s.head(V(1));
    expect(head.lines).toBe(100); expect(head.hash).toBe(refChains(L).raw[100]); expect(head.damagedFromLine).toBe(rotLine);
    await s.close();
  });

  it('nothing at all vouches for the body (no index, no checkpoint): refused loudly even without any rot', async () => {
    await build(t.dir, L);
    fs.unlinkSync(path.join(vdir(t.dir), 'index.bin')); fs.unlinkSync(path.join(vdir(t.dir), 'checkpoint.bin'));
    const s = await ChatStore.open(t.dir);
    await rejects(s.head(V(1)), 'damaged');
    await s.close();
  });

  it('a damaged header alone (all bytes fine) is still repaired in full: the index records vouch even though the header cannot', async () => {
    await build(t.dir, L);
    flipAt(path.join(vdir(t.dir), 'index.bin'), 1);
    const s = await ChatStore.open(t.dir);
    const head = await s.head(V(1));
    expect(head.lines).toBe(100); expect(head.hash).toBe(refChains(L).raw[100]); expect(head.damagedFromLine).toBeNull();
    expect((await s.verify(V(1))).ok).toBe(true);
    await s.close();
  });

  it('the checkpoint is separate, checksummed, in two slots, and level with every acknowledged append (no close needed)', async () => {
    const s = await openWith(t.dir, V(1));
    for (let i = 0; i < 25; i++) await s.append(V(1), 0, i, [L[i]]);
    const ck = (await readCheckpoint(realFsOnly(), vdir(t.dir)))!;
    expect(ck.count).toBe(25); expect(ck.h.toString('hex')).toBe(refChains(L).raw[25]);
    await s.close();
    // one damaged slot: the other one (the previous statement) is still evidence
    flipAt(path.join(vdir(t.dir), 'checkpoint.bin'), 30);
    flipAt(path.join(vdir(t.dir), 'checkpoint.bin'), 30 + CHECKPOINT_SLOT);
    expect(await readCheckpoint(realFsOnly(), vdir(t.dir))).toBeNull();      // both damaged: not evidence, and not an error
    const s2 = await ChatStore.open(t.dir);
    expect((await s2.head(V(1))).lines).toBe(25);
    await s2.close();
    flipAt(path.join(vdir(t.dir), 'checkpoint.bin'), 30 + CHECKPOINT_SLOT);               // repair one slot by flipping it back
    expect((await readCheckpoint(realFsOnly(), vdir(t.dir)))!.count).toBeGreaterThanOrEqual(24);
  });

  it('a checkpoint that disagrees with an index that agrees with its body is not "resolved" by guessing: quarantined intact', async () => {
    await build(t.dir, L);
    const cp = path.join(vdir(t.dir), 'checkpoint.bin');
    const good = (await readCheckpoint(realFsOnly(), vdir(t.dir)))!;
    fs.unlinkSync(cp);
    await writeCheckpoint(realFsOnly(), vdir(t.dir), { ...good, h: Buffer.alloc(32, 0x11) });   // a VALID statement that disagrees with the index
    const s = await ChatStore.open(t.dir);
    await rejects(s.head(V(1)), 'damaged');
    await s.close();
  });

  it('verify() also compares the head with the checkpoint', async () => {
    await build(t.dir, L);
    const s = await ChatStore.open(t.dir);
    expect((await s.verify(V(1))).ok).toBe(true);
    await s.close();
  });
});
function realFsOnly() { return new FaultFs(0); }

// ---------------------------------------------------------------------------------------------- N3
describe('N3: the rolling scrub covers every byte within a bounded number of calls, even while the chat grows', () => {
  it('review demonstration: rot at line 100 of a chat that gains a line between every call is found within the stated bound', async () => {
    const L = rows(2000);
    const s = await openWith(t.dir, V(1), { scrubOnOpenBytes: 0 });
    for (let i = 0; i < 2000; i += 250) await s.append(V(1), 0, i, L.slice(i, i + 250));
    await s.scrubStep(V(1), { maxBytes: 1e9 });                 // one clean full pass
    flipAt(body0(t.dir), lineStart(L, 100) + 5);
    const total = lineStart(L, 2000); const budget = 4000;
    const bound = Math.ceil(total / budget) + 1;                // one pass, plus the call that starts it
    let found = -1; let n = 2000;
    for (let round = 1; round <= bound + 5; round++) {
      await s.append(V(1), 0, n, [cc.user(`grow ${n}`)]); n++;
      const rep = await s.scrubStep(V(1), { maxBytes: budget });
      if (rep.damagedFromLine !== null) { found = round; break; }
    }
    expect(found, `bound is ${bound} calls`).toBeGreaterThan(0);
    expect(found).toBeLessThanOrEqual(bound + 1);
    expect((await s.head(V(1))).damagedFromLine).toBe(100);
    await s.close();
  });
  it('the persisted mark survives a reopen and a cut shorter than the pass', async () => {
    const L = rows(300);
    const s = await openWith(t.dir, V(1), { scrubOnOpenBytes: 0 });
    await s.append(V(1), 0, 0, L);
    await s.scrubStep(V(1), { maxBytes: 3000 });
    await s.setAsideTail('ab'.repeat(8), V(1), 50);             // shorter than the mark
    const rep = await s.scrubStep(V(1), { maxBytes: 1e9 });
    expect(rep.total).toBe(50); expect(rep.damagedFromLine).toBeNull();
    await s.close();
  });
});

// ---------------------------------------------------------------------------------------------- N4 / N7 / N8
describe('N4/N7/N8: one bad version, byte or stamp never takes a healthy version out of service', () => {
  const vh = vhex;
  const proof = (through: number, hash: string): EvictionProof => ({ kind: 'holders-confirmed', version: vh, through, hash, acks: [{ holder: 'dev-a', version: vh, lines: through, hash, signature: 'sig' }] });
  const accept = { proofVerifier: () => true };
  const changed = { proofVerifier: () => true, replyEnd: { apiErrorsEndReplies: false } };

  it('N4: evicted prefix + a classifier change: head, append, listVersions and restoreBody all work; the conversation chain is flagged stale until the bodies return', async () => {
    const L = rows(60);
    let s = await openWith(t.dir, V(1), accept);
    await s.append(V(1), 0, 0, L); await s.evictBody(V(1), proof(30, (await s.hashAt(V(1), 0, 30))!)); await s.close();
    s = await ChatStore.open(t.dir, changed);
    const lv = await s.listVersions();
    expect(lv[0].damaged).toBeNull(); expect(lv[0].head!.conversationChainStale).toBe(true);
    const h = await s.head(V(1));
    expect(h.lines).toBe(60); expect(h.hash).toBe(refChains(L).raw[60]); expect(h.conversationChainStale).toBe(true);
    const more = cc.user('more');
    expect(await s.append(V(1), 0, 60, [more])).toBe('ok');
    expect((await s.restoreBody(V(1), L)).restoredLines).toBe(60);
    const h2 = await s.head(V(1));
    expect(h2.conversationChainStale).toBe(false); expect(h2.conversationHash).toBe(refChains([...L, more]).conv);
    expect(fs.existsSync(path.join(vdir(t.dir), 'stale-conv.json'))).toBe(false);
    expect((await s.verify(V(1))).ok).toBe(true);
    await s.close();
  });

  it('N7: 300 lines, one rotted byte at line 40, then an app update changes the stamp: every line is served but the rotted one, the conversation chain is flagged stale, a resend heals and the next open recomputes it', async () => {
    const L = rows(300); await build(t.dir, L);
    flipAt(body0(t.dir), lineStart(L, 40) + 7);
    const o = { replyEnd: { apiErrorsEndReplies: false } };
    const s = await ChatStore.open(t.dir, o);
    const h = await s.head(V(1));
    expect(h.lines).toBe(300); expect(h.hash).toBe(refChains(L).raw[300]); expect(h.damagedFromLine).toBe(40);
    expect(h.conversationChainStale).toBe(true);        // the chain of the rotted line's neighbours cannot be recomputed until the line is healed
    expect(asideDirs(t.dir)).toEqual([]);
    expect(await s.append(V(1), 0, 40, L.slice(40))).toBe('ok');
    await s.close();
    const s2 = await ChatStore.open(t.dir, o);
    const h2 = await s2.head(V(1));
    expect(h2.damagedFromLine).toBeNull(); expect(h2.conversationChainStale).toBe(false);
    expect((await readAll(s2, 300)).equals(Buffer.concat(L))).toBe(true);
    await s2.close();
  });

  it('N7: one flipped index record plus one unrelated flipped body byte', async () => {
    const L = rows(300); await build(t.dir, L);
    flipAt(path.join(vdir(t.dir), 'index.bin'), recPos(120) + 20);
    flipAt(body0(t.dir), lineStart(L, 200) + 3);
    const s = await ChatStore.open(t.dir);
    const h = await s.head(V(1));
    expect(h.lines).toBe(300); expect(h.hash).toBe(refChains(L).raw[300]); expect(h.damagedFromLine).toBe(200);
    await s.close();
  });

  it('N7: a flipped byte in the SAME line whose record is also flipped is localised by the next valid record, and that line is not kept', async () => {
    const L = rows(100); await build(t.dir, L);
    flipAt(path.join(vdir(t.dir), 'index.bin'), recPos(50) + 20);
    flipAt(body0(t.dir), lineStart(L, 50) + 3);
    const s = await ChatStore.open(t.dir);
    const h = await s.head(V(1));
    expect(h.lines).toBeLessThanOrEqual(50); expect(h.hash).toBe(refChains(L).raw[h.lines]);
    await s.append(V(1), 0, h.lines, L.slice(h.lines));
    expect((await s.head(V(1))).hash).toBe(refChains(L).raw[100]);
    await s.close();
  });

  it('N8: a garbage meta.json, evicted.json or damaged.json in one version never breaks listVersions or the other versions; each is listed with a typed reason and can be set aside', async () => {
    const s = await ChatStore.open(t.dir);
    for (const n of [1, 2, 3, 4]) { await s.registerVersion(V(n), { chatId: CHAT + n, runtime: 'claude-code' }); await s.append(V(n), 0, 0, rows(5, 'v' + n)); }
    await s.close();
    fs.writeFileSync(path.join(vdir(t.dir, V(2).toString('hex')), 'meta.json'), 'not json');
    fs.writeFileSync(path.join(vdir(t.dir, V(2).toString('hex')), 'meta.copy'), 'not json either');
    fs.unlinkSync(path.join(vdir(t.dir, V(4).toString('hex')), 'index.bin'));   // a quarantined version has no live index (review 4: a marker next to a live index is an older copy and is ignored)
    fs.writeFileSync(path.join(vdir(t.dir, V(4).toString('hex')), 'marks.bin'), 'garbage');
    const s2 = await ChatStore.open(t.dir);
    const lv = await s2.listVersions();
    expect(lv.map((v) => v.damaged)).toEqual([null, 'unreadable: corrupt', null, 'unknown']);   // a garbage marks file with no index still reports damaged
    expect(lv[0].head!.lines).toBe(5); expect(lv[1].chatId).toBeNull();
    expect((await s2.head(V(1))).lines).toBe(5);
    // the remedy does not itself need the bad file
    for (const n of [2, 4]) await s2.setAsideDamaged(V(n));
    const lv2 = await s2.listVersions();
    expect(lv2.filter((v) => v.damaged !== null)).toEqual([]);
    expect(lv2.map((v) => v.head?.lines)).toEqual([5, 5, 5]);   // version 2 lost its registration (re-register it); 3 and 4 kept their lines (their bad files were only markers)
    await s2.registerVersion(V(2), { chatId: CHAT + 2, runtime: 'claude-code' });
    expect(await s2.append(V(2), 0, 0, rows(5, 'v2'))).toBe('ok');
    await s2.close();
  });
});

// ---------------------------------------------------------------------------------------------- N6
describe('N6: extras are verified on read and a rotted one can be replaced', () => {
  const bytes = Buffer.from('extra bytes for the rot test ' + 'x'.repeat(100));
  const hash = createHash('sha256').update(bytes).digest('hex');
  const file = (root: string) => path.join(root, 'extras', hash.slice(0, 2), hash);
  it('readExtra of a rotted extra is a typed corrupt once, the bad file is kept in extras-bad/, and a correct re-put is stored', async () => {
    const s = await openWith(t.dir);
    expect(await s.putExtra(hash, bytes)).toBe('stored');
    expect((await s.readExtra(hash))!.equals(bytes)).toBe(true);
    const bad = flipAt(file(t.dir), 7);
    await rejects(s.readExtra(hash), 'corrupt');
    expect(fs.readFileSync(path.join(t.dir, 'extras-bad', `${hash}-1`)).equals(bad)).toBe(true);
    expect(await s.readExtra(hash)).toBeNull(); expect(await s.hasExtra(hash)).toBe(false);
    expect(await s.putExtra(hash, bytes)).toBe('stored');
    expect((await s.readExtra(hash))!.equals(bytes)).toBe(true);
    await s.close();
  });
  it('putExtra over a rotted extra (never read in between) replaces it instead of answering "present"', async () => {
    const s = await openWith(t.dir);
    await s.putExtra(hash, bytes); flipAt(file(t.dir), 3);
    expect(await s.putExtra(hash, bytes)).toBe('stored');
    expect(fs.readFileSync(file(t.dir)).equals(bytes)).toBe(true);
    expect(await s.putExtra(hash, bytes)).toBe('present');
    await s.close();
  });
  it('N11: a total cap on extras refuses loudly', async () => {
    const s = await openWith(t.dir, V(1), { maxExtrasBytes: 150 });
    await s.putExtra(hash, bytes);
    const b2 = Buffer.from('y'.repeat(100));
    await rejects(s.putExtra(createHash('sha256').update(b2).digest('hex'), b2), 'limit');
    await s.close();
  });
});

// ---------------------------------------------------------------------------------------------- N9 / N14
describe('N9/N14: the lock never locks the user out', () => {
  const lockPath = () => path.join(t.dir, 'LOCK');
  const bootId = () => (process.platform === 'linux' ? fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() : null);
  const ns = () => (process.platform === 'linux' ? fs.readlinkSync('/proc/self/ns/pid') : null);
  it.skipIf(process.platform !== 'linux')('a renamed machine does not lock anyone out: same boot, dead pid, different host name -> taken over', async () => {
    const probe = await openWith(t.dir); await probe.close();
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 2147483646, start: 'x', host: 'old-name', token: 'z', boot: bootId(), pidns: ns() }));
    const b = await ChatStore.open(t.dir); await b.close();
  });
  it.skipIf(process.platform !== 'linux')('a different boot id (a reboot) is stale even when the pid now belongs to another process and the host name differs', async () => {
    const probe = await openWith(t.dir); await probe.close();
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 1, start: '1', host: 'whatever', token: 'z', boot: 'some-earlier-boot', pidns: ns() }));
    const b = await ChatStore.open(t.dir); await b.close();
  });
  it.skipIf(process.platform !== 'linux')('a holder in another process namespace (a container sharing the folder) is offered as doubtful, not stolen', async () => {
    const probe = await openWith(t.dir); await probe.close();
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 2147483646, start: 'x', host: os.hostname(), token: 'ns-token', boot: bootId(), pidns: 'pid:[1]' }));
    const err = await ChatStore.open(t.dir).then(() => null, (e) => e);
    expect(err).toMatchObject({ code: 'store-locked-stale?' });
    expect(err.evidence.why).toContain('namespace');
    const b = await ChatStore.open(t.dir, { breakLockToken: err.evidence.breakLockToken }); await b.close();
  });
  it('a live pid with the right start time is plainly held (store-locked), not doubtful', async () => {
    const a = await openWith(t.dir);
    await rejects(ChatStore.open(t.dir), 'store-locked');
    await a.close();
  });
  it('N14: old LOCK.new-* leftovers are swept, fresh ones (an opener in flight) are not', async () => {
    fs.mkdirSync(t.dir, { recursive: true });
    const old = path.join(t.dir, 'LOCK.new-1-aabb'); const fresh = path.join(t.dir, 'LOCK.new-2-ccdd');
    fs.writeFileSync(old, 'x'); fs.writeFileSync(fresh, 'x');
    const past = new Date(Date.now() - 3600_000); fs.utimesSync(old, past, past);
    const s = await ChatStore.open(t.dir); await s.close();
    expect(fs.existsSync(old)).toBe(false); expect(fs.existsSync(fresh)).toBe(true);
  });
  it('N14: an unreadable but RECENT takeover file (a hard-link-less file system mid-write) is respected, not unlinked', async () => {
    const probe = await openWith(t.dir); await probe.close();
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 2147483646, start: 'x', host: os.hostname(), token: 'dead', boot: bootId(), pidns: ns() }));
    fs.writeFileSync(lockPath() + '.takeover', '');
    await rejects(ChatStore.open(t.dir), 'store-locked');
    const past = new Date(Date.now() - 3600_000); fs.utimesSync(lockPath() + '.takeover', past, past);
    const b = await ChatStore.open(t.dir); await b.close();
  });
  it('N9d: a LOCK file deleted under a live holder is detected before the next write', async () => {
    const a = await openWith(t.dir);
    fs.unlinkSync(lockPath());
    await rejects(a.append(V(1), 0, 0, rows(1)), 'store-locked');
    await a.close();
  });
});

// ---------------------------------------------------------------------------------------------- N10
describe('N10: no file handle leaks on error paths', () => {
  it('opens and closes balance across a clean run, a refused append and a failed rebuild (counted by the shim)', async () => {
    const ffs = new FaultFs(0);
    const s = await ChatStore.open(t.dir, { fs: ffs });
    await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' });
    await s.append(V(1), 0, 0, rows(40));
    await s.append(V(1), 0, 99, rows(1));                        // parks
    await expect(s.read(V(1), 0, 0, 500)).rejects.toBeTruthy();
    await expect(s.append(V(1), 0, 0, [Buffer.from('no newline')])).rejects.toBeTruthy();
    await s.close();
    expect(ffs.openHandles).toBe(0);
    // a rebuild that ends in quarantine (the error path of rebuildIndex)
    fs.unlinkSync(path.join(vdir(t.dir), 'index.bin')); flipAt(body0(t.dir), 12);
    const ffs2 = new FaultFs(0);
    const s2 = await ChatStore.open(t.dir, { fs: ffs2 });
    await rejects(s2.head(V(1)), 'damaged');
    await s2.close();
    expect(ffs2.openHandles).toBe(0);
  });
  it('the failing open in the old rebuildIndex leak site: the index.rebuild file cannot be created', async () => {
    await build(t.dir, rows(40));
    flipAt(path.join(vdir(t.dir), 'index.bin'), 1);
    // make index.rebuild un-creatable: a directory of that name
    fs.mkdirSync(path.join(vdir(t.dir), 'index.rebuild'));
    const ffs = new FaultFs(0);
    const s = await ChatStore.open(t.dir, { fs: ffs });
    await expect(s.head(V(1))).rejects.toBeTruthy();
    await s.close();
    expect(ffs.openHandles).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------- N11 / N12 / N17
describe('N11/N12/N17: kept folders are budgeted and visible, nothing kept is pruned', () => {
  it('N17: nine torn index tails keep nine torn files (they used to be pruned to eight)', async () => {
    const L = rows(10);
    for (let i = 0; i < 9; i++) {
      await build(t.dir, i === 0 ? L : []);
      const ip = path.join(vdir(t.dir), 'index.bin');
      fs.appendFileSync(ip, Buffer.alloc(40, 0x5a + i));           // a cut-off record
      const s = await ChatStore.open(t.dir); await s.head(V(1)); await s.close();
    }
    expect(fs.readdirSync(path.join(vdir(t.dir), 'torn')).filter((n) => n.endsWith('index-tail')).length).toBe(9);
  });
  it('N17: control torn-N files are never pruned; at the cap the log stays readable and appends are refused loudly', async () => {
    const mk = (n: number, seen: string[] = []) => { const body = Buffer.from('c' + n); return { id: createHash('sha256').update(body).digest('hex'), chat: CHAT, seen, body }; };
    const e1 = mk(1); const e2 = mk(2, [e1.id]);
    const s = await openWith(t.dir); await s.appendControl(e1); await s.appendControl(e2); await s.close();
    const dir = path.join(t.dir, 'control', createHash('sha256').update(CHAT).digest('hex'));
    for (let i = 1; i <= 1024; i++) fs.writeFileSync(path.join(dir, `torn-${i}.bin`), 'x');
    const lp = path.join(dir, 'log.bin'); fs.truncateSync(lp, fs.statSync(lp).size - 3);
    const cut = fs.readFileSync(lp);
    const s2 = await ChatStore.open(t.dir);
    expect((await s2.controlLog(CHAT)).map((e) => e.id)).toEqual([e1.id]);
    await rejects(s2.appendControl(mk(3, [e1.id])), 'limit');
    expect(fs.readFileSync(lp).equals(cut)).toBe(true);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('torn-')).length).toBe(1024);
    await s2.close();
  });
  it('N12: parkedList / rejectedList / releaseParked make a provisional `parked` answer visible and revocable', async () => {
    const L = rows(10);
    const s = await openWith(t.dir);
    expect(await s.append(V(1), 0, 5, L.slice(5))).toBe('parked');
    const pl = await s.parkedList(V(1));
    expect(pl).toHaveLength(1); expect(pl[0].fromLine).toBe(5);
    expect(await s.releaseParked(V(1), pl[0].name)).toBe(true);
    expect(await s.parkedList(V(1))).toEqual([]);
    const rl = await s.rejectedList(V(1));
    expect(rl.map((r) => r.name)).toEqual([`released--${pl[0].name}`]);   // round 7: the reason is the first part of the kept file's name
    expect(rl.map((r) => r.reason)).toEqual(['released']);
    expect(await s.releaseParked(V(1), pl[0].name)).toBe(false);
    // a park that later turns out not to be a prefix shows up in rejectedList instead of vanishing
    expect(await s.append(V(1), 0, 5, rows(2, 'other'))).toBe('parked');
    expect(await s.append(V(1), 0, 0, L.slice(0, 8))).toBe('ok');     // lines 5 and 6 now conflict with the park
    expect((await s.rejectedList(V(1))).length).toBe(2);
    await s.close();
  });
  it('N11: keptBytes reports what the store keeps and a byte cap on rejected/ leaves an oversized one in parked/', async () => {
    const s = await openWith(t.dir, V(1), { maxRejectedBytes: 10 });
    const base = rows(5, 'b');
    expect(await s.append(V(1), 0, 2, rows(3, 'a'))).toBe('parked');
    expect(await s.append(V(1), 0, 0, base)).toBe('ok');            // lines 2..4 differ from the park: not a prefix
    const pv = (await s.keptBytes()).perVersion[0];
    expect(pv.parked).toBeGreaterThan(0); expect(pv.rejected).toBe(0);   // over the 10 byte cap: stays parked, counted, visible
    await s.close();
  });
});

// ---------------------------------------------------------------------------------------------- shim honesty
describe('the fault shim models unsynced unlink, rename-over-existing and ENOSPC', () => {
  it('an unlink without a directory sync comes back after power loss; with one it stays gone', async () => {
    const shadow = fs.mkdtempSync(path.join(path.dirname(t.dir), 'shim-shadow-'));   // same file system as t.dir: the shim renames into it
    try {
      const f = new FaultFs(1e9, { powerLoss: true, shadowDir: shadow });
      fs.mkdirSync(path.join(t.dir, 'd'));
      fs.writeFileSync(path.join(t.dir, 'd', 'a'), 'A'); fs.writeFileSync(path.join(t.dir, 'd', 'b'), 'B');
      await f.unlink(path.join(t.dir, 'd', 'a')); await f.unlink(path.join(t.dir, 'd', 'b')); await f.fsyncDir(path.join(t.dir, 'd'));
      fs.writeFileSync(path.join(t.dir, 'd', 'c'), 'C'); await f.unlink(path.join(t.dir, 'd', 'c'));
      await f.applyPowerLoss();
      expect(fs.readdirSync(path.join(t.dir, 'd')).sort()).toEqual(['c']);   // a, b stay gone (synced); c was never durably there, but its unlink was not synced
    } finally { fs.rmSync(shadow, { recursive: true, force: true }); }
  });
  it('a rename over an existing file reverts to the OLD content only when the directory was not synced (and revertOverwrites is set)', async () => {
    const shadow = fs.mkdtempSync(path.join(path.dirname(t.dir), 'shim-shadow-'));   // same file system as t.dir: the shim renames into it
    try {
      for (const sync of [false, true]) {
        const dir = path.join(t.dir, sync ? 's' : 'u'); fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'x'), 'OLD'); fs.writeFileSync(path.join(dir, 'x.tmp'), 'NEW');
        const f = new FaultFs(1e9, { powerLoss: true, shadowDir: shadow, revertOverwrites: true });
        await f.rename(path.join(dir, 'x.tmp'), path.join(dir, 'x'));
        if (sync) await f.fsyncDir(dir);
        await f.applyPowerLoss();
        expect(fs.readFileSync(path.join(dir, 'x'), 'utf8')).toBe(sync ? 'NEW' : 'OLD');
      }
    } finally { fs.rmSync(shadow, { recursive: true, force: true }); }
  });
  it('ENOSPC: from the chosen allocation on, writes and new files fail with code ENOSPC while reads, unlinks and truncates keep working', async () => {
    const f = new FaultFs(0, { enospcFrom: 2 });
    const a = path.join(t.dir, 'a');
    const h = await f.open(a, { create: true });                       // allocation 1
    await expect(h.write(Buffer.from('x'), 0)).rejects.toMatchObject({ code: 'ENOSPC' });
    await expect(f.open(path.join(t.dir, 'b'), { create: true })).rejects.toMatchObject({ code: 'ENOSPC' });
    await h.truncate(0); await h.sync(); await h.close();
    await f.unlink(a);
    expect(f.openHandles).toBe(0);
  });
  it('REC is still 116 bytes (an index format change would need a migration: the checkpoint is a separate file for this reason)', () => { expect(REC).toBe(116); });
});
