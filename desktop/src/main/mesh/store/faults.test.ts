// Faults in ANY file the store writes (class fix, see inventory.ts): a damaged, truncated, zero-length or missing file, alone or
// next to a crash, must never delete, hide or alter an acknowledged line. Every test names the behaviour it protects.
// Synthetic data only, temp folders only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChatStore } from './store';
import { REC, HDR, recPos } from './records';
import { cc } from './fixtures';
import { CHAT, V, openWith, refChains, tmpRoot } from './testkit';
import { FaultFs, InjectedCrash } from './fault-fs';
import { readCheckpoint, CHECKPOINT_SLOT } from './checkpoint';
import { realFs } from './fsio';
import { versionTag } from './chain';
import { acquireLock } from './lock';
import { encodeSide } from './sidefile';

let t: Awaited<ReturnType<typeof tmpRoot>>;
beforeEach(async () => { t = await tmpRoot('faults-'); });
afterEach(async () => { await t.cleanup(); });

const vhex = V(1).toString('hex');
const vdir = (root: string = t.dir) => path.join(root, 'versions', vhex);
const rows = (n: number, tag = 'r'): Buffer[] => Array.from({ length: n }, (_, i) => cc.user(`${tag} ${i} ${'z'.repeat(20)}`));
const rejects = async (p: Promise<unknown>, code: string) => { await expect(p).rejects.toMatchObject({ name: 'StoreError', code }); };
const lineStart = (L: Buffer[], n: number) => L.slice(0, n).reduce((a, l) => a + l.length, 0);
const body0 = () => path.join(vdir(), 'body-0000000000000000.bin');
const flipAt = (file: string, pos: number, mask = 0x01): void => { const b = fs.readFileSync(file); b[pos] ^= mask; fs.writeFileSync(file, b); };
const verifierOpts = { proofVerifier: () => true };
async function build(root: string, L: Buffer[], o: { chunkBytes?: number; evict?: number } = {}): Promise<void> {
  const s = await openWith(root, V(1), { chunkBytes: o.chunkBytes, ...verifierOpts });
  for (let i = 0; i < L.length; i += 7) await s.append(V(1), 0, i, L.slice(i, i + 7));
  if (o.evict) {
    const h = (await s.hashAt(V(1), 0, o.evict))!;
    await s.evictBody(V(1), { kind: 'holders-confirmed', version: vhex, through: o.evict, hash: h, acks: [{ holder: 'p', version: vhex, lines: o.evict, hash: h, signature: 's' }] });
  }
  await s.close();
}
/** Everything the store must still be able to say about lines [from, L.length): served byte for byte, head a true prefix, verify ok. */
async function expectWhole(root: string, L: Buffer[], from = 0, o: { allowEvicted?: boolean } = {}): Promise<ChatStore> {
  const s = await ChatStore.open(root, verifierOpts);
  const head = await s.head(V(1));
  expect(head.lines).toBe(L.length); expect(head.hash).toBe(refChains(L).raw[L.length]); expect(head.damagedFromLine).toBeNull();
  for (let i = from; i < L.length; i++) {
    const got = await s.read(V(1), 0, i, i + 1);
    if (got === 'evicted') { expect(o.allowEvicted).toBe(true); continue; }
    expect(got[0].equals(L[i])).toBe(true);
  }
  expect((await s.verify(V(1))).ok).toBe(true);
  return s;
}
const deadLock = (root: string) => { const lp = path.join(root, 'LOCK'); if (fs.existsSync(lp)) fs.writeFileSync(lp, JSON.stringify({ ...JSON.parse(fs.readFileSync(lp, 'utf8')), pid: 2147483646, start: 'dead' })); };

// ----------------------------------------------------------------------------------------------------------------------------
describe('evicted.json is never trusted to delete anything', () => {
  const L = rows(60);
  it('one flipped bit anywhere in evicted.json: no un-evicted body chunk is removed and every un-evicted line is served', async () => {
    await build(t.dir, L, { chunkBytes: 1500, evict: 20 });
    const ev = path.join(vdir(), 'evicted.json');
    const original = fs.readFileSync(ev);
    const chunks = fs.readdirSync(vdir()).filter((n) => n.startsWith('body-'));
    for (let pos = 0; pos < original.length; pos++) {
      for (const mask of [0x01, 0x04, 0x80]) {
        fs.writeFileSync(ev, original); flipAt(ev, pos, mask);
        const s = await expectWhole(t.dir, L, 20, { allowEvicted: true });
        await s.close();
        expect(fs.readdirSync(vdir()).filter((n) => n.startsWith('body-'))).toEqual(chunks);
      }
    }
  });
  it('evicted.json truncated, zero-length, deleted or garbage: nothing is deleted and every line that still has a body is served', async () => {
    await build(t.dir, L, { chunkBytes: 1500, evict: 20 });
    const ev = path.join(vdir(), 'evicted.json'); const original = fs.readFileSync(ev);
    const chunks = fs.readdirSync(vdir()).filter((n) => n.startsWith('body-'));
    for (const damage of [() => fs.truncateSync(ev, 10), () => fs.truncateSync(ev, 0), () => fs.unlinkSync(ev), () => fs.writeFileSync(ev, '{"lines":9999,"bytes":999999999}')]) {
      fs.writeFileSync(ev, original); damage();
      const s = await expectWhole(t.dir, L, 20, { allowEvicted: true });
      await s.close();
      expect(fs.readdirSync(vdir()).filter((n) => n.startsWith('body-'))).toEqual(chunks);
    }
  });
  it('an evicted.json with a VALID checksum whose numbers the index does not support deletes nothing', async () => {
    await build(t.dir, L, { chunkBytes: 1500, evict: 20 });
    const chunks = fs.readdirSync(vdir()).filter((n) => n.startsWith('body-'));
    const ev = path.join(vdir(), 'evicted.json');
    for (const forged of [{ lines: 40, bytes: 99999 }, { lines: 20, bytes: 1 }, { lines: 59, bytes: 4000 }, { lines: 5, bytes: 123456789 }]) {
      fs.writeFileSync(ev, encodeSide({ ...forged, holders: ['x'] }));
      const s = await expectWhole(t.dir, L, 20, { allowEvicted: true }); await s.close();
      expect(fs.readdirSync(vdir()).filter((n) => n.startsWith('body-'))).toEqual(chunks);
    }
  });
  it('a rotted index record of an evicted line is reported as damaged with every kept byte still under the root', async () => {
    await build(t.dir, L, { chunkBytes: 1500, evict: 20 });
    flipAt(path.join(vdir(), 'index.bin'), recPos(5) + 3);
    const s = await ChatStore.open(t.dir, verifierOpts);
    await rejects(s.head(V(1)), 'damaged');
    await s.close();
    const kept = fs.readdirSync(path.join(t.dir, 'aside')).flatMap((d) => fs.readdirSync(path.join(t.dir, 'aside', d)));
    expect(kept.filter((n) => n.startsWith('body-')).length).toBeGreaterThan(0);
  });
});

describe('side files: any one fault leaves every acknowledged line served', () => {
  const L = rows(60);
  const sideFiles = ['meta.json', 'meta.copy', 'summary.json', 'scrub.json', 'checkpoint.bin', 'evicted.json'];
  const faults: [string, (f: string) => void][] = [
    ['flipped byte', (f) => { const b = fs.readFileSync(f); b[Math.floor(b.length / 2)] ^= 0x10; fs.writeFileSync(f, b); }],
    ['flipped first byte', (f) => flipAt(f, 0)],
    ['flipped last byte', (f) => flipAt(f, fs.statSync(f).size - 1)],
    ['truncated', (f) => fs.truncateSync(f, Math.max(1, fs.statSync(f).size - 3))],
    ['zero length', (f) => fs.truncateSync(f, 0)],
    ['deleted', (f) => fs.unlinkSync(f)],
  ];
  for (const name of sideFiles) for (const [what, apply] of faults) {
    it(`${name} ${what}`, async () => {
      await build(t.dir, L, { chunkBytes: 1500, evict: 10 });
      const s0 = await ChatStore.open(t.dir, verifierOpts); await s0.scrubStep(V(1), { maxBytes: 4096 }); await s0.close();
      const f = path.join(vdir(), name);
      if (!fs.existsSync(f)) return;                                   // a file this store does not write in this state
      apply(f);
      const s = await expectWhole(t.dir, L, 10, { allowEvicted: true });
      await s.append(V(1), 0, 60, rows(3, 'more'));                    // writing keeps working too
      await s.close();
    });
  }
  it('FORMAT damaged or emptied: the store opens, the bad file is kept next to the new one', async () => {
    await build(t.dir, L);
    for (const damage of [() => flipAt(path.join(t.dir, 'FORMAT'), 3), () => fs.truncateSync(path.join(t.dir, 'FORMAT'), 0), () => fs.writeFileSync(path.join(t.dir, 'FORMAT'), 'x')]) {
      damage();
      const s = await expectWhole(t.dir, L); await s.close();
    }
    expect(fs.readdirSync(t.dir).filter((n) => n.startsWith('FORMAT.bad-')).length).toBeGreaterThan(0);
  });
  it('FORMAT removed: the store opens and writes it again', async () => {
    await build(t.dir, L);
    fs.unlinkSync(path.join(t.dir, 'FORMAT'));
    const s = await expectWhole(t.dir, L); await s.close();
    expect(fs.existsSync(path.join(t.dir, 'FORMAT'))).toBe(true);
  });
  it('index header: any one flipped byte of the 16 still serves every line and keeps the old index', async () => {
    await build(t.dir, L);
    const ix = path.join(vdir(), 'index.bin'); const original = fs.readFileSync(ix);
    for (let pos = 0; pos < HDR; pos++) {
      fs.writeFileSync(ix, original); flipAt(ix, pos);
      const s = await expectWhole(t.dir, L); await s.close();
    }
  });
  it('meta.json and its copy both damaged: the version reports corrupt and nothing is touched', async () => {
    await build(t.dir, L);
    const before = fs.readFileSync(body0());
    flipAt(path.join(vdir(), 'meta.json'), 10); flipAt(path.join(vdir(), 'meta.copy'), 10);
    const s = await ChatStore.open(t.dir);
    await rejects(s.head(V(1)), 'corrupt');
    await s.close();
    expect(fs.readFileSync(body0()).equals(before)).toBe(true);
  });
});

describe('a rotted body line is the only thing reported, not everything after it', () => {
  const L = rows(100);
  it('bad index header plus one rotted body byte: lines after the rotted one are served, only that line is damaged, a resend heals it', async () => {
    await build(t.dir, L);
    flipAt(path.join(vdir(), 'index.bin'), 2);
    flipAt(body0(), lineStart(L, 10) + 5);
    const s = await ChatStore.open(t.dir);
    const head = await s.head(V(1));
    expect(head.lines).toBe(100); expect(head.hash).toBe(refChains(L).raw[100]); expect(head.damagedFromLine).toBe(10);
    expect(head.conversationChainStale).toBe(false); expect(head.conversationHash).toBe(refChains(L).conv);   // a bad header is not a classifier change
    for (let i = 11; i < 100; i++) expect(((await s.read(V(1), 0, i, i + 1)) as Buffer[])[0].equals(L[i])).toBe(true);
    await rejects(s.read(V(1), 0, 10, 11), 'corrupt');
    expect(await s.append(V(1), 0, 10, L.slice(10, 12))).toBe('ok');
    expect((await s.head(V(1))).damagedFromLine).toBeNull();
    expect((await s.verify(V(1))).ok).toBe(true);
    await s.close();
    expect(fs.existsSync(path.join(vdir(), 'torn'))).toBe(false);          // nothing was cut away, so nothing needs a way back
  });
  it('a missing index record in the middle plus a rotted byte elsewhere: every verifiable line is still served', async () => {
    await build(t.dir, L);
    flipAt(path.join(vdir(), 'index.bin'), recPos(40) + 7);                 // record 40 fails its checksum
    flipAt(body0(), lineStart(L, 70) + 5);                                   // line 70 rotted
    const s = await ChatStore.open(t.dir);
    const head = await s.head(V(1));
    expect(head.lines).toBe(100); expect(head.hash).toBe(refChains(L).raw[100]);
    for (let i = 0; i < 100; i++) { if (i === 70) continue; expect(((await s.read(V(1), 0, i, i + 1)) as Buffer[])[0].equals(L[i])).toBe(true); }
    await rejects(s.read(V(1), 0, 70, 71), 'corrupt');
    await s.close();
  });
});

describe('a crash plus rot in the batch being written never forks the head', () => {
  const L = rows(60);
  it('every crash point of an append, with a rotted byte in the new lines: the head is a true prefix and a correct resend attaches', async () => {
    let rotCases = 0;
    for (let failAt = 1; failAt <= 45; failAt++) {
      const root = path.join(t.dir, `c${failAt}`); fs.mkdirSync(root);
      await build(root, L.slice(0, 30));
      const ffs = new FaultFs(failAt, { tear: true });
      try {
        const s = await ChatStore.open(root, { fs: ffs });
        await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' });
        await s.append(V(1), 0, 30, L.slice(30, 50));
      } catch (e) { if (!(e instanceof InjectedCrash)) throw e; }
      deadLock(root);
      const b0 = path.join(vdir(root), 'body-0000000000000000.bin');
      const start = lineStart(L, 30);
      if (fs.statSync(b0).size > start + 40) { flipAt(b0, start + 25); rotCases++; }
      const s = await ChatStore.open(root);
      const head = await s.head(V(1));
      expect(head.hash, `crash at op ${failAt}`).toBe(refChains(L).raw[head.lines]);
      expect(head.lines).toBeGreaterThanOrEqual(30);
      expect(await s.append(V(1), 0, 30, L.slice(30, 50)), `resend after crash at op ${failAt}`).toBe('ok');
      expect((await s.head(V(1))).hash).toBe(refChains(L).raw[50]);
      for (let i = 0; i < 50; i++) expect(((await s.read(V(1), 0, i, i + 1)) as Buffer[])[0].equals(L[i]), `line ${i} after crash at op ${failAt}`).toBe(true);
      await s.close();
    }
    expect(rotCases).toBeGreaterThan(5);
  });
  it('every acknowledged append is already in the checkpoint: nothing acknowledged ever waits for one', async () => {
    const s = await openWith(t.dir, V(1));
    for (let i = 0; i < 70; i++) await s.append(V(1), 0, i, [L[i % 60]].map((x, k) => cc.user(`line ${i} ${k}`)));
    // no close: a kill -9 here
    const ck = (await readCheckpoint(realFs, vdir()))!;
    expect(ck.count).toBe(70);
    await s.close();
  });
  it('index lost and the newest line rotted: refused as damaged, never served as verified', async () => {
    const s = await openWith(t.dir, V(1));
    for (let i = 0; i < 60; i++) await s.append(V(1), 0, i, [L[i]]);
    deadLockAfterKill(t.dir);
    fs.unlinkSync(path.join(vdir(), 'index.bin'));
    flipAt(body0(), lineStart(L, 59) + 5);
    const s2 = await ChatStore.open(t.dir);
    await rejects(s2.head(V(1)), 'damaged');
    await s2.close();
    void s;
  });
  it('index cut mid-record plus a rotted last line: never served as verified', async () => {
    const s = await openWith(t.dir, V(1));
    for (let i = 0; i < 60; i++) await s.append(V(1), 0, i, [L[i]]);
    deadLockAfterKill(t.dir);
    fs.truncateSync(path.join(vdir(), 'index.bin'), recPos(40) + 50);
    flipAt(body0(), lineStart(L, 58) + 5);
    const s2 = await ChatStore.open(t.dir);
    const res = await s2.head(V(1)).then((h) => ({ h }), (e) => ({ e }));
    if ('h' in res) {
      expect(res.h.hash).toBe(refChains(L).raw[res.h.lines]);
      for (let i = 0; i < res.h.lines; i++) { const got = await s2.read(V(1), 0, i, i + 1).then((x) => x, () => null); if (got !== null) expect((got as Buffer[])[0].equals(L[i])).toBe(true); }
    } else expect(res.e).toMatchObject({ code: 'damaged' });
    await s2.close();
  });
});
function deadLockAfterKill(root: string): void { deadLock(root); }

describe('a flipped partial.json still reports that lines were set aside', () => {
  const L = rows(50);
  it('lines the index lost and the checkpoint cannot verify are reported damaged from the head, even with partial.json flipped', async () => {
    const s = await openWith(t.dir, V(1));
    for (let i = 0; i < 50; i++) await s.append(V(1), 0, i, [L[i]]);
    deadLockAfterKill(t.dir);
    fs.truncateSync(path.join(vdir(), 'index.bin'), recPos(40));          // 10 records lost
    flipAt(body0(), lineStart(L, 45) + 5);                                  // and a rotted byte among them
    const s2 = await ChatStore.open(t.dir);
    const head = await s2.head(V(1));
    expect(head.lines).toBe(40); expect(head.hash).toBe(refChains(L).raw[40]); expect(head.damagedFromLine).toBe(40);
    await s2.close();
    const pj = path.join(vdir(), 'partial.json');
    expect(fs.existsSync(pj)).toBe(true);
    flipAt(pj, 5);
    const s3 = await ChatStore.open(t.dir);
    expect((await s3.head(V(1))).damagedFromLine).not.toBeNull();
    // a peer's correct resend of the missing lines attaches and heals
    expect(await s3.append(V(1), 0, 40, L.slice(40))).toBe('ok');
    expect((await s3.head(V(1))).damagedFromLine).toBeNull();
    expect((await s3.head(V(1))).hash).toBe(refChains(L).raw[50]);
    await s3.close();
    expect(fs.existsSync(pj)).toBe(false);                                  // the marker goes once the lines are back
  });
  it('index tail rotted and no checkpoint: the lines after it are kept and reported damaged from the head, never adopted from their own bytes', async () => {
    const s = await openWith(t.dir, V(1));
    for (let i = 0; i < 50; i++) await s.append(V(1), 0, i, [L[i]]);
    deadLockAfterKill(t.dir);
    fs.unlinkSync(path.join(vdir(), 'checkpoint.bin'));
    flipAt(path.join(vdir(), 'index.bin'), recPos(49) + 9);              // the newest record rotted
    const s2 = await ChatStore.open(t.dir);
    const head = await s2.head(V(1));
    expect(head.lines).toBe(49); expect(head.hash).toBe(refChains(L).raw[49]); expect(head.damagedFromLine).toBe(49);
    const kept = fs.readdirSync(path.join(vdir(), 'torn')).filter((n) => n.endsWith('-body')).map((n) => fs.readFileSync(path.join(vdir(), 'torn', n)));
    expect(kept.some((b) => b.equals(L[49]))).toBe(true);
    expect(await s2.append(V(1), 0, 49, L.slice(49))).toBe('ok');
    expect((await s2.head(V(1))).hash).toBe(refChains(L).raw[50]);
    await s2.close();
  });
});

describe('control log tails', () => {
  const entry = (i: number) => { const body = Buffer.from(`ctl ${i} ${'q'.repeat(40)}`); return { id: require('node:crypto').createHash('sha256').update(body).digest('hex'), chat: CHAT, seen: [] as string[], body }; };
  it('a zero-filled tail (size persisted, data not) is not permanent damage: earlier entries are served, appends work, the bytes are kept', async () => {
    const s = await openWith(t.dir); for (let i = 0; i < 3; i++) await s.appendControl(entry(i)); await s.close();
    const dirs = fs.readdirSync(path.join(t.dir, 'control')); const log = path.join(t.dir, 'control', dirs[0], 'log.bin');
    fs.appendFileSync(log, Buffer.alloc(4096));
    const s2 = await ChatStore.open(t.dir);
    expect((await s2.controlLog(CHAT)).length).toBe(3);
    expect(await s2.controlDamage(CHAT)).toEqual([]);
    expect(await s2.appendControl(entry(9))).toBe('ok');
    await s2.close();
    const s3 = await ChatStore.open(t.dir);
    expect((await s3.controlLog(CHAT)).length).toBe(4); expect(await s3.controlDamage(CHAT)).toEqual([]);
    await s3.close();
  });
  it('a last record whose header is whole but whose payload is all zeros is a torn write, not damage', async () => {
    const s = await openWith(t.dir); let anchorAfter2 = Buffer.alloc(0);
    for (let i = 0; i < 3; i++) { await s.appendControl(entry(i)); if (i === 1) anchorAfter2 = fs.readFileSync(path.join(t.dir, 'control', fs.readdirSync(path.join(t.dir, 'control'))[0], 'anchor.json')); }
    await s.close();
    const dirs = fs.readdirSync(path.join(t.dir, 'control')); const log = path.join(t.dir, 'control', dirs[0], 'log.bin');
    const b = fs.readFileSync(log); const lastStart = b.length - (16 + 34 + 4 + CHAT.length + entry(2).body.length + 32 * 0);
    b.fill(0, lastStart + 16); fs.writeFileSync(log, b);
    // a REAL torn write is a crash before the append was acknowledged, so the independent record (anchor.json) never counted it: put the record back as it was after entry 2
    fs.writeFileSync(path.join(path.dirname(log), 'anchor.json'), anchorAfter2);
    const s2 = await ChatStore.open(t.dir);
    expect((await s2.controlLog(CHAT)).length).toBe(2); expect(await s2.controlDamage(CHAT)).toEqual([]);
    await s2.close();
  });
});

describe('a full keep-area or a full disk never makes a healthy version unreadable', () => {
  const L = rows(30);
  it('torn/ at its file cap: reads keep working and new writes are refused with a typed error, nothing is deleted', async () => {
    const s = await openWith(t.dir, V(1)); await s.append(V(1), 0, 0, L); await s.close();
    const td = path.join(vdir(), 'torn'); fs.mkdirSync(td);
    for (let i = 1; i <= 4096; i++) fs.writeFileSync(path.join(td, `${String(i).padStart(6, '0')}-body`), 'x');
    fs.appendFileSync(body0(), Buffer.from('{"never":"acknowledged"}\n'));   // a crash left a line the index never covered
    const s2 = await ChatStore.open(t.dir);
    expect((await s2.head(V(1))).lines).toBe(30);
    expect(((await s2.read(V(1), 0, 29, 30)) as Buffer[])[0].equals(L[29])).toBe(true);
    await rejects(s2.append(V(1), 0, 30, rows(1, 'n')), 'limit');
    expect(fs.readdirSync(td).length).toBe(4096);
    expect(fs.readFileSync(body0()).toString().endsWith('{"never":"acknowledged"}\n')).toBe(true);
    await s2.close();
  });
  it('a torn index tail read while the disk is full: head and reads work, the next write is refused as disk-full and works once space returns', async () => {
    const s = await openWith(t.dir, V(1)); await s.append(V(1), 0, 0, L); await s.close();
    fs.appendFileSync(path.join(vdir(), 'index.bin'), Buffer.alloc(50, 7));   // half a record
    const full = new FaultFs(0, { enospcFrom: 1 });
    const s2 = await ChatStore.open(t.dir, { fs: full });
    expect((await s2.head(V(1))).lines).toBe(30);
    expect(((await s2.read(V(1), 0, 5, 6)) as Buffer[])[0].equals(L[5])).toBe(true);
    await rejects(s2.append(V(1), 0, 30, rows(1, 'n')), 'disk-full');
    await s2.close();
    const s3 = await ChatStore.open(t.dir);
    expect(await s3.append(V(1), 0, 30, rows(2, 'n'))).toBe('ok');
    await s3.close();
  });
  it('surplus body bytes found while the disk is full: reads work, a write is refused as disk-full', async () => {
    const s = await openWith(t.dir, V(1)); await s.append(V(1), 0, 0, L); await s.close();
    fs.appendFileSync(body0(), Buffer.from('{"surplus":1}\n'));
    const s2 = await ChatStore.open(t.dir, { fs: new FaultFs(0, { enospcFrom: 1 }) });
    expect((await s2.head(V(1))).lines).toBe(30);
    await rejects(s2.append(V(1), 0, 30, rows(1, 'n')), 'disk-full');
    await s2.close();
  });
  it('a control log with a torn tail read while the disk is full still serves its entries', async () => {
    const body = Buffer.from('ctl-1'); const id = require('node:crypto').createHash('sha256').update(body).digest('hex');
    const s = await openWith(t.dir); await s.appendControl({ id, chat: CHAT, seen: [], body }); await s.close();
    const dirs = fs.readdirSync(path.join(t.dir, 'control')); fs.appendFileSync(path.join(t.dir, 'control', dirs[0], 'log.bin'), Buffer.from('YCL1'));
    const s2 = await ChatStore.open(t.dir, { fs: new FaultFs(0, { enospcFrom: 1 }) });
    expect((await s2.controlLog(CHAT)).length).toBe(1);
    await s2.close();
  });
});

describe('reads on a full disk never fail', () => {
  it('a set-aside interrupted at any disk operation: the next read on a full disk is served or reported damaged, never disk-full, and everything is kept', async () => {
    const L = rows(20);
    for (let n = 1; n <= 24; n++) {
      const root = path.join(t.dir, `r${n}`); fs.mkdirSync(root);
      await build(root, L);
      try { const s = await ChatStore.open(root, { fs: new FaultFs(0, { enospcFrom: n }) }); await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' }); await s.setAsideDamaged(V(1)); await s.close(); } catch { /* the full disk refused it somewhere */ }
      deadLock(root);
      const s2 = await ChatStore.open(root, { fs: new FaultFs(0, { enospcFrom: 1 }) }).catch((e) => e);
      if (s2 instanceof Error) { expect(s2.message, `open after a refusal at allocation ${n}`).not.toMatch(/disk-full/); continue; }
      const head: any = await s2.head(V(1)).then((h: unknown) => h, (e: unknown) => e);
      if (head instanceof Error) expect(head, `head after a refusal at allocation ${n}`).toMatchObject({ code: 'damaged' }); else if (head.lines > 0) expect(((await s2.read(V(1), 0, 0, 1)) as Buffer[])[0].equals(L[0])).toBe(true);
      await s2.close();
      const kept = fs.readdirSync(path.join(root, 'aside')).flatMap((d) => fs.readdirSync(path.join(root, 'aside', d)));
      const all = fs.readFileSync(path.join(vdir(root), 'body-0000000000000000.bin'), { flag: 'a+' }).length + kept.length;
      expect(all, `bytes kept after a refusal at allocation ${n}`).toBeGreaterThan(0);
    }
  });
  it('a version that must be quarantined while the disk is full is reported damaged at every disk operation, and nothing is lost', async () => {
    const L = rows(20);
    for (let n = 1; n <= 30; n++) {
      const root = path.join(t.dir, `q${n}`); fs.mkdirSync(root);
      await build(root, L, { chunkBytes: 1 });                         // one chunk file per append (three of them)
      // a version nothing can repair: no index, and a middle chunk file gone (two faults; a quarantine is only ever reached through a rebuild that cannot succeed)
      fs.unlinkSync(path.join(vdir(root), 'index.bin')); fs.unlinkSync(path.join(vdir(root), fs.readdirSync(vdir(root)).filter((f) => f.startsWith('body-')).sort()[1]));
      const s = await ChatStore.open(root, { fs: new FaultFs(0, { enospcFrom: n }) });
      await expect(s.head(V(1)), `quarantine with the disk full from allocation ${n}`).rejects.toMatchObject({ code: 'damaged' });
      await s.close(); deadLock(root);
      const s2 = await ChatStore.open(root);
      await expect(s2.head(V(1))).rejects.toMatchObject({ code: 'damaged' });
      await s2.close();
      const holders = [path.join(vdir(root), 'body-0000000000000000.bin'), ...(fs.existsSync(path.join(root, 'aside')) ? fs.readdirSync(path.join(root, 'aside')).map((d) => path.join(root, 'aside', d, 'body-0000000000000000.bin')) : [])];
      expect(holders.some((f) => fs.existsSync(f) && fs.readFileSync(f).includes(L[3])), `bytes kept after allocation ${n}`).toBe(true);
    }
  });
  it('a quarantine whose damaged marker was not written yet (interrupted) is still reported damaged when read on a full disk', async () => {
    const L = rows(20); await build(t.dir, L, { chunkBytes: 1 });
    fs.unlinkSync(path.join(vdir(), 'index.bin')); fs.unlinkSync(path.join(vdir(), fs.readdirSync(vdir()).filter((f) => f.startsWith('body-')).sort()[1]));   // a version nothing can repair: quarantine
    const s = await ChatStore.open(t.dir); await expect(s.head(V(1))).rejects.toMatchObject({ code: 'damaged' }); await s.close();
    const name = fs.readdirSync(path.join(t.dir, 'aside'))[0];
    fs.unlinkSync(path.join(vdir(), 'damaged.json'));                                   // the kill came before the marker
    fs.unlinkSync(path.join(t.dir, 'aside', name, 'COMPLETE'));                          // (the COMPLETE mark is written after the marker, so it was not there either)
    fs.writeFileSync(path.join(vdir(), 'aside.intent'), encodeSide({ asideName: name, reason: 'interrupted', version: vhex }));
    const s2 = await ChatStore.open(t.dir, { fs: new FaultFs(0, { enospcFrom: 1 }) });
    await expect(s2.head(V(1))).rejects.toMatchObject({ code: 'damaged' });
    await s2.close();
    const s3 = await ChatStore.open(t.dir);
    await expect(s3.head(V(1))).rejects.toMatchObject({ code: 'damaged' });             // and with space the marker is written
    expect(fs.existsSync(path.join(vdir(), 'damaged.json'))).toBe(true);
    await s3.close();
  });
  it('a parked append that can now be applied is not applied while the disk is full, and the read still works', async () => {
    const L = rows(13);
    const s = await openWith(t.dir, V(1)); await s.append(V(1), 0, 0, L.slice(0, 10)); await s.close();
    const { frameLines } = await import('./records');
    fs.mkdirSync(path.join(vdir(), 'parked'), { recursive: true });
    fs.writeFileSync(path.join(vdir(), 'parked', `${'10'.padStart(16, '0')}-${'a'.repeat(16)}.park`), Buffer.concat([versionTag(vhex), frameLines(L.slice(10, 13))]));
    const s2 = await ChatStore.open(t.dir, { fs: new FaultFs(0, { enospcFrom: 1 }) });
    expect((await s2.head(V(1))).lines).toBe(10);
    await s2.close();
    const s3 = await ChatStore.open(t.dir);
    expect((await s3.head(V(1))).lines).toBe(13);
    await s3.close();
  });
  it('a parked control entry that can now be applied is not applied while the disk is full, and the log is still served', async () => {
    const { createHash } = await import('node:crypto');
    const mk = (n: number, seen: string[] = []) => { const body = Buffer.from('c' + n); return { id: createHash('sha256').update(body).digest('hex'), chat: CHAT, seen, body }; };
    const e1 = mk(1); const e2 = mk(2, [e1.id]);
    const other = path.join(t.dir, 'other'); fs.mkdirSync(other);
    const b = await openWith(other); await b.appendControl(e2); await b.close();   // e2 parks there (its cause is missing)
    const parked = fs.readdirSync(path.join(other, 'control')).flatMap((d) => fs.readdirSync(path.join(other, 'control', d, 'parked')).map((n) => path.join(other, 'control', d, 'parked', n)))[0];
    const a = await openWith(t.dir); await a.appendControl(e1); await a.close();
    const dirA = path.join(t.dir, 'control', createHash('sha256').update(CHAT).digest('hex'));
    fs.mkdirSync(path.join(dirA, 'parked'), { recursive: true }); fs.copyFileSync(parked, path.join(dirA, 'parked', path.basename(parked)));
    const a2 = await ChatStore.open(t.dir, { fs: new FaultFs(0, { enospcFrom: 1 }) });
    expect((await a2.controlLog(CHAT)).map((e) => e.id)).toEqual([e1.id]);
    await a2.close();
    const a3 = await ChatStore.open(t.dir);
    expect((await a3.controlLog(CHAT)).map((e) => e.id)).toEqual([e1.id, e2.id]);
    await a3.close();
  });
});

describe('close and the lock', () => {
  it('a close that fails while writing still releases the lock, so the same process can open the store again', async () => {
    const L = rows(40);
    // count the disk operations of the appends and of the close in a dry run
    fs.mkdirSync(path.join(t.dir, 'dry'));
    const dry = new FaultFs(1_000_000); const s0 = await openWith(path.join(t.dir, 'dry'), V(1), { fs: dry });
    for (let i = 0; i < 40; i++) await s0.append(V(1), 0, i, [L[i]]);
    const beforeClose = dry.ops; await s0.close();
    expect(dry.ops).toBeGreaterThan(beforeClose);                            // closing writes something (the summary), so it can fail
    const root = path.join(t.dir, 'real'); fs.mkdirSync(root);
    const ffs = new FaultFs(beforeClose + 1);
    const s = await openWith(root, V(1), { fs: ffs });
    for (let i = 0; i < 40; i++) await s.append(V(1), 0, i, [L[i]]);
    await expect(s.close()).rejects.toBeInstanceOf(InjectedCrash);
    const again = await ChatStore.open(root);                                // used to answer store-locked until the process restarted
    expect((await again.head(V(1))).lines).toBe(40);
    await again.close();
  });
  it('a takeover that finds the lock already changed hands refuses instead of stealing it', async () => {
    const lp = path.join(t.dir, 'LOCK');
    fs.writeFileSync(lp, JSON.stringify({ pid: 2147483646, start: 'dead', host: require('node:os').hostname(), token: 'old', boot: null, pidns: null }));
    await rejects(acquireLock(t.dir, { hooks: { beforeRecheck: async () => { fs.writeFileSync(lp, JSON.stringify({ pid: process.pid, start: null, host: 'h', token: 'someone-else', boot: null, pidns: null })); } } }), 'store-locked');
    expect(JSON.parse(fs.readFileSync(lp, 'utf8')).token).toBe('someone-else');
  });
});

describe('a second copy that was found damaged is repaired when the version loads', () => {
  const L = rows(40);
  it('a checkpoint fault found at open is repaired, so a later index cut at a record boundary loses nothing', async () => {
    const s = await openWith(t.dir, V(1)); for (let i = 0; i < 40; i++) await s.append(V(1), 0, i, [L[i]]); await s.close();
    fs.truncateSync(path.join(vdir(), 'checkpoint.bin'), 23);                 // both slots gone
    const s2 = await ChatStore.open(t.dir); expect((await s2.head(V(1))).lines).toBe(40); await s2.close();
    expect((await readCheckpoint(realFs, vdir()))!.count).toBe(40);           // repaired by the open above
    fs.truncateSync(path.join(vdir(), 'index.bin'), recPos(30));              // a second, separate fault: 10 whole records gone
    const s3 = await expectWhole(t.dir, L); await s3.close();
  });
  it('a damaged slot is repaired at open and the other slot is not the only evidence any more', async () => {
    const s = await openWith(t.dir, V(1)); for (let i = 0; i < 40; i++) await s.append(V(1), 0, i, [L[i]]); await s.close();
    flipAt(path.join(vdir(), 'checkpoint.bin'), 20 + CHECKPOINT_SLOT);
    const s2 = await ChatStore.open(t.dir); await s2.head(V(1)); await s2.close();
    const b = fs.readFileSync(path.join(vdir(), 'checkpoint.bin')); expect(b.length).toBe(2 * CHECKPOINT_SLOT);
    flipAt(path.join(vdir(), 'checkpoint.bin'), 20);                          // now the OTHER slot
    expect((await readCheckpoint(realFs, vdir()))!.count).toBe(40);
  });
  it('a cut lowers both checkpoint slots, so a flip in the newest slot never brings back a higher statement', async () => {
    const s = await openWith(t.dir, V(1)); for (let i = 0; i < 40; i++) await s.append(V(1), 0, i, [L[i]]);
    await s.setAsideTail('abcdef012345', V(1), 25); await s.close();
    for (const pos of [20, 20 + 96]) {
      const c = fs.readFileSync(path.join(vdir(), 'checkpoint.bin'));
      flipAt(path.join(vdir(), 'checkpoint.bin'), pos);
      const s2 = await ChatStore.open(t.dir); expect((await s2.head(V(1))).lines).toBe(25); await s2.close();
      fs.writeFileSync(path.join(vdir(), 'checkpoint.bin'), c);
    }
  });
  it('a stale-chain marker deleted while the checkpoint stamp still says stale is written again', async () => {
    const accept = { proofVerifier: () => true };
    await build(t.dir, rows(30), { evict: 10 });
    const o = { ...accept, replyEnd: { apiErrorsEndReplies: false } };
    const s = await ChatStore.open(t.dir, o); expect((await s.head(V(1))).conversationChainStale).toBe(true); await s.close();
    fs.unlinkSync(path.join(vdir(), 'stale-conv.json'));
    const s2 = await ChatStore.open(t.dir, o); expect((await s2.head(V(1))).conversationChainStale).toBe(true); await s2.close();
    expect(fs.existsSync(path.join(vdir(), 'stale-conv.json'))).toBe(true);
  });
});

describe('summary.json is checksummed: a flipped letter in the title is never shown', () => {
  it('a flipped byte inside the saved title makes the store recompute the summary from the chat', async () => {
    const lines = [cc.title('Synthetic title ABC'), ...rows(5)];
    await build(t.dir, lines);
    const sp = path.join(vdir(), 'summary.json'); const b = fs.readFileSync(sp);
    const at = b.indexOf('ABC'); expect(at).toBeGreaterThan(0); b[at] ^= 0x01; fs.writeFileSync(sp, b);
    const s = await ChatStore.open(t.dir);
    expect((await s.summary(V(1))).title).toBe('Synthetic title ABC');
    await s.close();
  });
});

describe('kept copies are never overwritten or merged', () => {
  it('after an aside folder is lost, a new set-aside never reuses the name of one that still exists', async () => {
    const L = rows(10); await build(t.dir, L);
    const s = await ChatStore.open(t.dir);
    await s.setAsideDamaged(V(1)); await s.append(V(1), 0, 0, L); await s.setAsideDamaged(V(1)); await s.append(V(1), 0, 0, L);
    const names = fs.readdirSync(path.join(t.dir, 'aside')).sort(); expect(names.length).toBe(2);
    const keepIdx = fs.readFileSync(path.join(t.dir, 'aside', names[1], 'index.bin'));
    fs.rmSync(path.join(t.dir, 'aside', names[0]), { recursive: true });
    await s.setAsideDamaged(V(1));
    const after = fs.readdirSync(path.join(t.dir, 'aside')).sort();
    expect(after.length).toBe(2);
    expect(fs.readFileSync(path.join(t.dir, 'aside', names[1], 'index.bin')).equals(keepIdx)).toBe(true);
    await s.close();
  });
  it('a healed line never reuses the name of a kept copy that still exists', async () => {
    const L = rows(12); await build(t.dir, L);
    const s = await ChatStore.open(t.dir);
    const hd = path.join(vdir(), 'healed');
    for (let round = 0; round < 3; round++) {
      flipAt(body0(), lineStart(L, 5) + 4 + round);
      await s.append(V(1), 0, 5, L.slice(5, 6));
      if (round === 1) fs.unlinkSync(path.join(hd, 'line-5-1.bin'));
    }
    const kept = fs.readdirSync(hd).sort(); expect(kept.length).toBe(2);
    await s.close();
  });
  it('a parked append whose file rotted is replaced from the resend and the damaged copy is kept', async () => {
    const L = rows(20);
    const s = await openWith(t.dir, V(1)); await s.append(V(1), 0, 0, L.slice(0, 10));
    expect(await s.append(V(1), 0, 14, L.slice(14, 17))).toBe('parked');
    const pf = path.join(vdir(), 'parked', fs.readdirSync(path.join(vdir(), 'parked'))[0]);
    flipAt(pf, 9);
    expect(await s.append(V(1), 0, 14, L.slice(14, 17))).toBe('parked');
    expect((await s.parkedList(V(1))).length).toBe(1);
    await s.append(V(1), 0, 10, L.slice(10, 14));
    expect((await s.head(V(1))).lines).toBe(17);
    expect((await s.rejectedList(V(1))).length + fs.readdirSync(path.join(vdir(), 'rejected')).length).toBeGreaterThan(0);
    await s.close();
  });
});

describe('a full keep-area never wedges a rebuild', () => {
  it('index records lost and a rotted byte among them with torn/ at its cap: the version is quarantined intact (typed damaged), not left unreadable', async () => {
    const L = rows(50);
    const s = await openWith(t.dir, V(1));
    for (let i = 0; i < 50; i++) await s.append(V(1), 0, i, [L[i]]);
    deadLockAfterKill(t.dir);
    fs.truncateSync(path.join(vdir(), 'index.bin'), recPos(40));
    flipAt(body0(), lineStart(L, 45) + 5);
    const td = path.join(vdir(), 'torn'); fs.mkdirSync(td, { recursive: true });
    for (let i = 1; i <= 4096; i++) fs.writeFileSync(path.join(td, `${String(i).padStart(6, '0')}-body`), 'x');
    const s2 = await ChatStore.open(t.dir);
    await rejects(s2.head(V(1)), 'damaged');
    await s2.close();
    expect(fs.readdirSync(path.join(t.dir, 'aside')).length).toBe(1);
  });
});

describe('clearing a damaged marker', () => {
  it('is refused when the quarantined copy it names is not there, and the marker is kept', async () => {
    const L = rows(30); await build(t.dir, L);
    fs.unlinkSync(path.join(vdir(), 'index.bin')); fs.unlinkSync(path.join(vdir(), 'checkpoint.bin'));
    const s = await ChatStore.open(t.dir);
    await rejects(s.head(V(1)), 'damaged');                                    // nothing vouches: quarantined
    const aside = fs.readdirSync(path.join(t.dir, 'aside'))[0];
    fs.renameSync(path.join(t.dir, 'aside', aside), path.join(t.dir, 'elsewhere'));
    await rejects(s.setAsideDamaged(V(1)), 'corrupt');
    expect(fs.existsSync(path.join(vdir(), 'damaged.json'))).toBe(true);
    await s.close();
  });
});

describe('format and the scrub pointer', () => {
  it('a store written by a different format number (valid checksum) refuses to open and is not touched', async () => {
    const s = await openWith(t.dir, V(1)); await s.close();
    const body = 'youcoded-mesh-store 2'; const { crc32 } = await import('./chain');
    const line = `${body} ${crc32(Buffer.from(body)).toString(16).padStart(8, '0')}\n`;
    fs.writeFileSync(path.join(t.dir, 'FORMAT'), line);
    await rejects(ChatStore.open(t.dir), 'corrupt');
    expect(fs.readFileSync(path.join(t.dir, 'FORMAT'), 'utf8')).toBe(line);
    expect(fs.readdirSync(t.dir).filter((n) => n.startsWith('FORMAT.bad'))).toEqual([]);
  });
  it('the rotted line found by a rebuild is still reported after a close and a reopen, even when the scrub on open is short', async () => {
    const L = rows(600); await build(t.dir, L);
    flipAt(path.join(vdir(), 'index.bin'), 2); flipAt(body0(), lineStart(L, 300) + 5);
    const s = await ChatStore.open(t.dir, { scrubOnOpenBytes: 0 }); await s.head(V(1)); await s.close();      // the rebuild runs here; no scrub has looked at the bodies yet
    // a scrub of one batch from line 0 would stop at line 255: only a pointer left at line 300 finds it
    const s2 = await ChatStore.open(t.dir, { scrubOnOpenBytes: 100 }); expect((await s2.head(V(1))).damagedFromLine).toBe(300); await s2.close();
  });
});

void REC;
