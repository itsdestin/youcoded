// Review round 7 (docs/active/reviews/2026-11-23-mesh-store-code-review-7.md): F1 (two older files put back together were quietly accepted), F2 (a quarantine kept the parks, so they drained onto a
// recopied different history), F3 (a lost tail AND its markers, or a lost tails/ folder, let a retry write an empty tail), F5 (rejected parks: a reason, a cheap signal, and the cap never drops a park).
// Synthetic data only; temp folders only. Every test states what a person would see: a quiet wrong answer is the failure, a loud one (quarantine, typed error, flag) is fine.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChatStore } from './store';
import { V, CHAT, tmpRoot } from './testkit';
import { nl } from './fixtures';
import { readHw } from './highwater';
import { realFs } from './fsio';

const mk = (tag: string, n: number) => Array.from({ length: n }, (_, i) => nl({ type: 'user', uuid: `${tag}${i}`, message: { role: 'user', content: `${tag} ${'x'.repeat(30)} ${i}` } }));
const A = mk('A', 80); const B = mk('B', 80);
const opts = { chunkBytes: 100000, proofVerifier: () => true };
const keyOf = (v: Buffer) => v.toString('hex');
const vdir = (root: string) => path.join(root, 'versions', keyOf(V(1)));
const TID = 'aabbccdd0011';
async function open(root: string, o: object = opts): Promise<ChatStore> {
  const s = await ChatStore.open(root, o);
  await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' });
  return s;
}
const truth = (cut: number, n: number): Buffer[] => [...A.slice(0, cut), ...B.slice(cut, n)];
/** What a reader sees: 'quarantined' (typed damaged/corrupt on open or head), 'flagged' (served but head says damaged), 'correct', or 'WRONG' (a quiet wrong answer: the failure). */
async function outcome(root: string, want: Buffer[]): Promise<'quarantined' | 'flagged' | 'correct' | 'WRONG'> {
  let s: ChatStore | null = null;
  try {
    s = await open(root);
    const h = await s.head(V(1));
    if (h.damagedFromLine !== null) return 'flagged';
    if (h.lines !== want.length) return 'WRONG';
    for (let i = 0; i < want.length; i++) { const r = await s.read(V(1), 0, i, i + 1); if (r === 'evicted' || !r[0].equals(want[i])) return 'WRONG'; }
    return 'correct';
  } catch (e: any) { return e?.code === 'damaged' || e?.code === 'corrupt' ? 'quarantined' : 'WRONG'; }
  finally { if (s) await s.close().catch(() => undefined); }
}
const FILES: Record<string, (n: string) => boolean> = { index: (n) => n === 'index.bin', ck: (n) => n === 'checkpoint.bin', body: (n) => /^body-/.test(n) };

/** 20 lines of history A, a copy of the folder, a takeover at line 10, 6 lines of history B; returns the older copy. */
async function build(root: string, snap: string, extra = 0): Promise<void> {
  let s = await open(root);
  await s.append(V(1), 0, 0, A.slice(0, 20)); await s.close();
  fs.cpSync(root, snap, { recursive: true });
  s = await open(root);
  await s.setAsideTail(TID, V(1), 10);
  await s.append(V(1), 0, 10, B.slice(10, 16 + extra)); await s.close();
}
function putBack(root: string, snap: string, kinds: string[]): void {
  const sv = path.join(snap, 'versions', keyOf(V(1)));
  for (const n of fs.readdirSync(sv)) if (kinds.some((k) => FILES[k](n))) fs.copyFileSync(path.join(sv, n), path.join(vdir(root), n));
  for (const n of ['LOCK']) fs.rmSync(path.join(root, n), { force: true });
}

describe('F1 two older files put back together are never served quietly', () => {
  for (const [name, kinds] of [['index + body', ['index', 'body']], ['checkpoint + body', ['ck', 'body']]] as [string, string[]][]) {
    it(`older ${name} after a takeover: loud (never the old history's lines with no flag)`, async () => {
      const t = await tmpRoot('r7-f1-'); const snap = t.dir + '-snap';
      await build(t.dir, snap, name === 'checkpoint + body' ? 10 : 0);
      putBack(t.dir, snap, kinds);
      const o = await outcome(t.dir, truth(10, name === 'checkpoint + body' ? 26 : 16));
      expect(['quarantined', 'flagged']).toContain(o);
      fs.rmSync(snap, { recursive: true, force: true }); await t.cleanup();
    });
  }
  it('older checkpoint + body with the index NEWER AND EQUAL IN COUNT (the old check only looked past the checkpoint): loud', async () => {
    const t = await tmpRoot('r7-f1e-'); const snap = t.dir + '-snap';
    await build(t.dir, snap, 4);                      // head 20 = the old head, but lines 10..19 are history B
    putBack(t.dir, snap, ['ck', 'body']);
    expect(['quarantined', 'flagged']).toContain(await outcome(t.dir, truth(10, 20)));
    fs.rmSync(snap, { recursive: true, force: true }); await t.cleanup();
  });
  it('a LONE older index or a LONE older checkpoint is still repaired from the files that agree: correct lines, no flag', async () => {
    for (const kinds of [['index'], ['ck']]) {
      const t = await tmpRoot('r7-f1l-'); const snap = t.dir + '-snap';
      await build(t.dir, snap, 10);                  // head 26: the older checkpoint's count (20) is below it, so the index is strictly ahead of it
      putBack(t.dir, snap, kinds);
      expect(await outcome(t.dir, truth(10, 26)), kinds.join()).toBe('correct');
      fs.rmSync(snap, { recursive: true, force: true }); await t.cleanup();
    }
  });
  it('a takeover with the SAME lines afterwards, then a rotted index: rebuilt, no false alarm (the guard only fires when a file was overridden)', async () => {
    const t = await tmpRoot('r7-f1s-');
    let s = await open(t.dir); await s.append(V(1), 0, 0, A.slice(0, 20)); await s.setAsideTail(TID, V(1), 10); await s.append(V(1), 0, 10, A.slice(10, 20)); await s.close();
    const ip = path.join(vdir(t.dir), 'index.bin'); const b = fs.readFileSync(ip); b[b.length - 50] ^= 1; fs.writeFileSync(ip, b);
    expect(await outcome(t.dir, A.slice(0, 20))).toBe('correct');
    await t.cleanup();
  });
});

describe('F2 a quarantine is a history change: parks made before it never drain onto a recopy', () => {
  it('setAsideDamaged with a park waiting, then a peer recopies a DIFFERENT history up to the park: the park is not applied and is kept with the reason', async () => {
    const t = await tmpRoot('r7-f2-');
    const s = await open(t.dir);
    await s.append(V(1), 0, 0, A.slice(0, 10)); await s.append(V(1), 0, 12, A.slice(12, 14));
    await s.setAsideDamaged(V(1));
    await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' }).catch(() => undefined);
    expect(await s.append(V(1), 0, 0, B.slice(0, 12))).toBe('ok');
    const h = await s.head(V(1));
    expect(h.lines).toBe(12);
    for (let i = 0; i < 12; i++) expect(((await s.read(V(1), 0, i, i + 1)) as Buffer[])[0].equals(B[i])).toBe(true);
    const rej = await s.rejectedList(V(1));
    expect(rej.length).toBe(1); expect(rej[0].reason).toBe('quarantine'); expect(rej[0].fromLine).toBe(12);
    expect(h.rejectedParks).toBe(1);
    await s.close(); await t.cleanup();
  });
  it('a QUARANTINE found by the store itself (nothing vouches for the body) does the same', async () => {
    const t = await tmpRoot('r7-f2q-');
    let s = await open(t.dir);
    await s.append(V(1), 0, 0, A.slice(0, 10)); await s.append(V(1), 0, 12, A.slice(12, 14)); await s.close();
    fs.rmSync(path.join(vdir(t.dir), 'index.bin')); fs.rmSync(path.join(vdir(t.dir), 'checkpoint.bin'));
    s = await ChatStore.open(t.dir, opts); await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' }).catch(() => undefined);
    await expect(s.head(V(1))).rejects.toMatchObject({ code: 'damaged' });
    await s.setAsideDamaged(V(1));
    expect(await s.append(V(1), 0, 0, B.slice(0, 12))).toBe('ok');
    expect((await s.head(V(1))).lines).toBe(12);
    expect((await s.rejectedList(V(1))).map((r) => r.reason)).toEqual(['quarantine']);
    await s.close(); await t.cleanup();
  });
});

describe('F3 a takeover is recorded outside tails/, so losing tails/ is reported and never answered with an empty tail', () => {
  const lose = (root: string, how: 'dir' | 'tail+begun' | 'all3') => {
    const td = path.join(vdir(root), 'tails');
    if (how === 'dir') fs.rmSync(td, { recursive: true, force: true });
    else for (const e of fs.readdirSync(td)) if (how === 'all3' || !e.endsWith('.done')) fs.rmSync(path.join(td, e));
  };
  for (const how of ['dir', 'tail+begun', 'all3'] as const) {
    it(`${how} lost after the cut: a retry says corrupt, no empty tail appears, a NEW takeover is refused too, head states the loss`, async () => {
      const t = await tmpRoot('r7-f3-');
      let s = await open(t.dir);
      await s.append(V(1), 0, 0, A.slice(0, 40)); await s.setAsideTail(TID, V(1), 20); await s.close();
      lose(t.dir, how);
      s = await open(t.dir);
      // with a surviving `.done` marker tails/ still shows the takeover (the old marker rule reports it); with none, the high-water count is what shows the loss
      expect((await s.head(V(1))).lostTakeovers).toBe(how === 'tail+begun' ? 0 : 1);
      await expect(s.setAsideTail(TID, V(1), 20)).rejects.toMatchObject({ code: 'corrupt' });
      if (how !== 'tail+begun') await expect(s.setAsideTail('bbccddee0011', V(1), 30)).rejects.toMatchObject({ code: 'corrupt' });
      expect(fs.existsSync(path.join(vdir(t.dir), 'tails', `${TID}.tail`))).toBe(false);
      expect((await readHw(realFs, t.dir, keyOf(V(1)))).st.value?.takeovers).toBe(1);
      await s.close(); await t.cleanup();
    });
  }
  it('no loss: lostTakeovers is 0 and takeovers still work', async () => {
    const t = await tmpRoot('r7-f3n-');
    const s = await open(t.dir);
    await s.append(V(1), 0, 0, A.slice(0, 40)); await s.setAsideTail(TID, V(1), 20); await s.setAsideTail('bbccddee0011', V(1), 15);
    expect((await s.head(V(1))).lostTakeovers).toBe(0);
    await s.close(); await t.cleanup();
  });
});

describe('F5 rejected parks carry a reason and a count, and the rejected/ cap never drops a park', () => {
  it('a takeover rejects the old park with the reason `takeover`; head() counts it', async () => {
    const t = await tmpRoot('r7-f5-');
    const s = await open(t.dir);
    await s.append(V(1), 0, 0, A.slice(0, 40)); await s.append(V(1), 0, 50, A.slice(50, 53));
    expect((await s.head(V(1))).rejectedParks).toBe(0);
    await s.setAsideTail(TID, V(1), 20);
    const rej = await s.rejectedList(V(1));
    expect(rej).toHaveLength(1);
    expect(rej[0]).toMatchObject({ fromLine: 50, lines: 3, reason: 'takeover' });
    expect((await s.head(V(1))).rejectedParks).toBe(1);
    await s.close(); await t.cleanup();
  });
  it('a park that contradicts the head is rejected with the reason `conflict`', async () => {
    const t = await tmpRoot('r7-f5c-');
    const s = await open(t.dir);
    await s.append(V(1), 0, 0, A.slice(0, 10)); await s.append(V(1), 0, 12, A.slice(12, 14));
    await s.append(V(1), 0, 10, B.slice(10, 14));       // the head passes the park's position with other lines: the park is not a prefix
    expect((await s.rejectedList(V(1))).map((r) => r.reason)).toEqual(['conflict']);
    await s.close(); await t.cleanup();
  });
  it('rejected/ full: park() refuses the new park with a typed error and overwrites NOTHING', async () => {
    const t = await tmpRoot('r7-f5f-');
    const s = await open(t.dir, { ...opts, maxRejectedBytes: 1 });
    await s.append(V(1), 0, 0, A.slice(0, 10)); await s.append(V(1), 0, 20, A.slice(20, 23));
    const pf = path.join(vdir(t.dir), 'parked'); const [name] = fs.readdirSync(pf);
    const b = fs.readFileSync(path.join(pf, name)); b[b.length - 9] ^= 1; fs.writeFileSync(path.join(pf, name), b);   // the parked copy rots; the same lines are sent again
    await expect(s.append(V(1), 0, 20, A.slice(20, 23))).rejects.toMatchObject({ code: 'limit' });
    expect(fs.readFileSync(path.join(pf, name)).equals(b)).toBe(true);        // the rotted copy is still there: nothing was overwritten or dropped
    await s.close(); await t.cleanup();
  });
});

describe('a takeover that is still pending when older files return finishes its cut (found by the round-7 fuzz once pair faults and evictions ran)', () => {
  it('older index + bodies holding only a PREFIX of the saved tail (the version is shorter than the tail): the retry still cuts at the takeover point instead of calling the cut done', async () => {
    const t = await tmpRoot('r7-pend-'); const snap = t.dir + '-snap';
    let s = await open(t.dir);
    await s.append(V(1), 0, 0, A.slice(0, 20)); await s.close();
    fs.cpSync(t.dir, snap, { recursive: true });                                  // the older state: 20 lines of A
    s = await open(t.dir);
    await s.append(V(1), 0, 20, A.slice(20, 50)); await s.setAsideTail(TID, V(1), 10); await s.close();   // cut at 10; the tail holds A10..49
    fs.rmSync(path.join(vdir(t.dir), 'tails', `${TID}.done`));                    // the takeover is still pending (its last marker not written yet)
    putBack(t.dir, snap, ['index', 'body']);                                      // the older index and bodies come back: 20 lines of A
    s = await open(t.dir);
    expect((await s.setAsideTail(TID, V(1), 10)).lines).toBe(40);
    expect((await s.head(V(1))).lines).toBe(10);                                  // not 20: lines 10..19 belong to the history that was replaced
    expect(await s.append(V(1), 0, 10, B.slice(10, 25))).toBe('ok');
    for (let i = 0; i < 25; i++) expect(((await s.read(V(1), 0, i, i + 1)) as Buffer[])[0].equals(truth(10, 25)[i]), `line ${i}`).toBe(true);
    await s.close(); fs.rmSync(snap, { recursive: true, force: true }); await t.cleanup();
  });
});

describe('the checkpoint carries the history it was written in, and an index ahead of it is not trusted blindly', () => {
  it('older checkpoint + older bodies with a NEWER, SHORTER index (found by the fuzz): the old history is not served; the version is loud or holds only the shared prefix', async () => {
    const t = await tmpRoot('r7-hist-'); const snap = t.dir + '-snap';
    let s = await open(t.dir);
    await s.append(V(1), 0, 0, A.slice(0, 40)); await s.close();
    fs.cpSync(t.dir, snap, { recursive: true });                                  // 40 lines of A
    s = await open(t.dir);
    await s.setAsideTail(TID, V(1), 10); await s.append(V(1), 0, 10, B.slice(10, 20)); await s.close();   // the index now has 20 records
    putBack(t.dir, snap, ['ck', 'body']);                                         // the checkpoint says 40, the bodies hold 40 lines of A, the index says 20
    let s2: ChatStore | null = null; let verdict = 'unset';
    try {
      s2 = await open(t.dir); const h = await s2.head(V(1));
      const served: Buffer[] = []; for (let i = 0; i < h.lines; i++) served.push(((await s2.read(V(1), 0, i, i + 1)) as Buffer[])[0]);
      const right = served.every((b, i) => b.equals(truth(10, 20)[i]));
      verdict = right ? (h.lines <= 20 ? 'prefix-ok' : 'WRONG-LONG') : (h.damagedFromLine !== null ? 'flagged' : 'WRONG');
    } catch (e: any) { verdict = e?.code === 'damaged' || e?.code === 'corrupt' ? 'quarantined' : 'WRONG-' + e?.code; }
    finally { if (s2) await s2.close().catch(() => undefined); }
    expect(['prefix-ok', 'flagged', 'quarantined']).toContain(verdict);
    fs.rmSync(snap, { recursive: true, force: true }); await t.cleanup();
  });
  it('older index + bodies after a FINISHED takeover, checkpoint lowered at the cut and agreeing there (it looks like a crash-ahead index): refused, never caught up to', async () => {
    const t = await tmpRoot('r7-lag-'); const snap = t.dir + '-snap';
    let s = await open(t.dir);
    await s.append(V(1), 0, 0, A.slice(0, 40)); await s.close();
    fs.cpSync(t.dir, snap, { recursive: true });
    s = await open(t.dir);
    await s.setAsideTail(TID, V(1), 10); await s.close();                         // cut at 10; the checkpoint says 10
    putBack(t.dir, snap, ['index', 'body']);                                      // 40 lines of A come back
    expect(['quarantined', 'flagged']).toContain(await outcome(t.dir, truth(10, 10)));
    fs.rmSync(snap, { recursive: true, force: true }); await t.cleanup();
  });
  it('a crash-ahead index (lines written since the checkpoint, NOT on any tail) is still caught up to, after a takeover', async () => {
    const t = await tmpRoot('r7-lag2-'); const snap = t.dir + '-snap';
    let s = await open(t.dir);
    await s.append(V(1), 0, 0, A.slice(0, 40)); await s.setAsideTail(TID, V(1), 10); await s.append(V(1), 0, 10, B.slice(10, 30)); await s.close();
    fs.cpSync(t.dir, snap, { recursive: true });                                   // the checkpoint says 30 lines, in the current history
    s = await open(t.dir); await s.append(V(1), 0, 30, B.slice(30, 45)); await s.close();
    putBack(t.dir, snap, ['ck']);                                                  // as if the crash came between the index write and the checkpoint write of the last append
    expect(await outcome(t.dir, truth(10, 45))).toBe('correct');
    fs.rmSync(snap, { recursive: true, force: true }); await t.cleanup();
  });
});
