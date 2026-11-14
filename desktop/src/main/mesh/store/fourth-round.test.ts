// Review round 4 (docs/active/reviews/2026-11-14-mesh-store-code-review-4.md): findings F1-F9, one named test each.
//
// The class these close: a file that is internally VALID but is the WRONG one (an older copy of itself, a copy that belongs to another chat,
// a file that is missing or cut short at a clean boundary). Checksums pass for all of these, so round 3's "bad bytes" invariant never saw them.
// Synthetic data only; temp folders only.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatStore } from './store';
import { V, CHAT, tmpRoot } from './testkit';
import { readCheckpoint } from './checkpoint';
import { realFs, type Fs, type FileLike } from './fsio';
import { nl } from './fixtures';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const line = (i: number, tag = 'a') => nl({ type: 'user', uuid: `${tag}-${i}`, message: { role: 'user', content: `${tag} line ${i} ${'y'.repeat(150)}` } });
const lines = (n: number, tag = 'a') => Array.from({ length: n }, (_, i) => line(i, tag));
const opts = { chunkBytes: 1000, proofVerifier: () => true };
const keyOf = (v: Buffer) => v.toString('hex');
const vdir = (root: string, v: Buffer = V(1)) => path.join(root, 'versions', keyOf(v));
const bodies = (root: string, v: Buffer = V(1)) => fs.readdirSync(vdir(root, v)).filter((f) => f.startsWith('body-')).sort();

async function fresh(n: number, o: { chat?: string; v?: Buffer; tag?: string } = {}) {
  const t = await tmpRoot('r4-');
  const v = o.v ?? V(1); const chat = o.chat ?? CHAT;
  const s = await ChatStore.open(t.dir, opts);
  await s.registerVersion(v, { chatId: chat, runtime: 'claude-code' });
  const ls = lines(n, o.tag ?? 'a');
  for (let i = 0; i < n; i += 3) await s.append(v, 0, i, ls.slice(i, i + 3));
  return { t, s, ls, root: t.dir, v, chat };
}
async function reopen(root: string, v: Buffer = V(1), chat = CHAT) {
  const s = await ChatStore.open(root, opts);
  await s.registerVersion(v, { chatId: chat, runtime: 'claude-code' });
  return s;
}
/** One char per line: '.' served identical, 'E' evicted, '!' typed corrupt, 'X' WRONG BYTES (never allowed). */
async function readAll(s: ChatStore, ls: Buffer[], v: Buffer = V(1)): Promise<string> {
  const out: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    try { const r = await s.read(v, 0, i, i + 1); out.push(r === 'evicted' ? 'E' : r[0].equals(ls[i]) ? '.' : 'X'); } catch (e: any) { out.push(e?.code === 'corrupt' ? '!' : '?'); }
  }
  return out.join('');
}
async function evict(s: ChatStore, through: number, v: Buffer = V(1)) {
  const h = (await s.hashAt(v, 0, through))!;
  return s.evictBody(v, { kind: 'holders-confirmed', version: keyOf(v), through, hash: h, acks: [{ holder: 'p', version: keyOf(v), lines: through, hash: h, signature: 's' }] } as any);
}
const asideCount = (root: string) => fs.readdirSync(path.join(root, 'aside')).length;

describe('F1 an older valid evicted.json never deletes restored bodies', () => {
  it('S1: restore, evict less, put the older marker back: every body file survives and every line is served', async () => {
    const { t, s, ls, root } = await fresh(30);
    await evict(s, 20);
    const e20 = fs.readFileSync(path.join(vdir(root), 'evicted.json'));
    await s.restoreBody(V(1), ls);
    await evict(s, 5);
    const before = bodies(root);
    const headBefore = await s.head(V(1));
    await s.close();
    fs.writeFileSync(path.join(vdir(root), 'evicted.json'), e20);
    const s2 = await reopen(root);
    const h = await s2.head(V(1));
    expect(bodies(root)).toEqual(before);                       // nothing unlinked on the word of an older marker
    expect(h.evictedLines).toBeLessThanOrEqual(headBefore.evictedLines);
    expect(h.damagedFromLine).toBeNull();
    const all = await readAll(s2, ls);
    expect(all.slice(h.evictedLines)).toMatch(/^\.+$/);          // every line that is not evicted is served byte for byte
    await s2.close(); await t.cleanup();
  });
});

describe('F2 the control log has an independent record', () => {
  async function control(mode: 'delete' | 'older' | 'boundary') {
    const t = await tmpRoot('r4c-'); const root = t.dir;
    let s = await ChatStore.open(root, opts);
    const chat = 'chat-c'; const bodies6: Buffer[] = [];
    const dir = path.join(root, 'control', sha(Buffer.from(chat)));
    let snap: Buffer | null = null; let atThree = 0;
    for (let i = 0; i < 6; i++) {
      const body = Buffer.from(`entry-${i}-${'z'.repeat(20)}`); bodies6.push(body);
      expect(await s.appendControl({ id: sha(body), chat, seen: [], body })).toBe('ok');
      if (i === 2) { snap = fs.readFileSync(path.join(dir, 'log.bin')); atThree = snap.length; }
    }
    await s.close();
    const lp = path.join(dir, 'log.bin');
    if (mode === 'delete') fs.rmSync(lp);
    else fs.writeFileSync(lp, mode === 'older' ? snap! : fs.readFileSync(lp).subarray(0, atThree));
    s = await ChatStore.open(root, opts);
    const got = await s.controlLog(chat); const dmg = await s.controlDamage(chat);
    await s.close(); await t.cleanup();
    return { got, dmg, bodies6 };
  }
  for (const mode of ['delete', 'older', 'boundary'] as const) {
    it(`S3 (${mode}): lost acknowledged entries are REPORTED by controlDamage, the rest still served`, async () => {
      const { got, dmg, bodies6 } = await control(mode);
      expect(got.length).toBeLessThan(6);
      expect(dmg.length).toBeGreaterThan(0);
      for (const e of got) expect(bodies6.some((b) => b.equals(Buffer.from(e.body)))).toBe(true);
    });
  }
  it('a control log from ANOTHER chat put in place is not served as this chat', async () => {
    const t = await tmpRoot('r4c2-'); const root = t.dir;
    let s = await ChatStore.open(root, opts);
    const b1 = Buffer.from('mine-' + 'q'.repeat(20)); const b2 = Buffer.from('theirs-' + 'q'.repeat(20));
    await s.appendControl({ id: sha(b1), chat: 'mine', seen: [], body: b1 });
    await s.appendControl({ id: sha(b2), chat: 'other', seen: [], body: b2 });
    await s.close();
    const d = (c: string) => path.join(root, 'control', sha(Buffer.from(c)), 'log.bin');
    fs.copyFileSync(d('other'), d('mine'));
    s = await ChatStore.open(root, opts);
    const got = await s.controlLog('mine'); const dmg = await s.controlDamage('mine');
    expect(got.map((e) => e.id)).not.toContain(sha(b2));
    expect(dmg.length).toBeGreaterThan(0);                       // the entry that was acknowledged is gone from this log: reported
    await s.close(); await t.cleanup();
  });
  it('a deleted extra is reported (typed), never indistinguishable from one never stored', async () => {
    const t = await tmpRoot('r4e-'); const root = t.dir;
    let s = await ChatStore.open(root, opts);
    const b = Buffer.from('extra-bytes-' + 'e'.repeat(40)); const h = sha(b);
    await s.putExtra(h, b); await s.close();
    fs.rmSync(path.join(root, 'extras', h.slice(0, 2), h));
    s = await ChatStore.open(root, opts);
    await expect(s.readExtra(h)).rejects.toMatchObject({ code: 'corrupt' });
    expect(await s.readExtra(sha(Buffer.from('never stored')))).toBeNull();
    await s.putExtra(h, b);                                      // a peer's copy repairs it
    expect((await s.readExtra(h))!.equals(b)).toBe(true);
    await s.close(); await t.cleanup();
  });
});

describe('F3 a missing, short or truncated body chunk hides only the lines it held', () => {
  it('S2b: a deleted middle chunk: every line outside it is served, the rest are reported, nothing is set aside', async () => {
    const { t, s, ls, root } = await fresh(30); await s.close();
    const files = bodies(root); fs.rmSync(path.join(vdir(root), files[2]));
    const s2 = await reopen(root);
    const h = await s2.head(V(1));
    expect(h.lines).toBe(30);
    expect(h.damagedFromLine).not.toBeNull();
    const all = await readAll(s2, ls);
    expect(all).toMatch(/^\.+!+\.+$/);                           // good, a run of reported-damaged lines, good again
    expect(all).not.toMatch(/[X?]/);
    expect(asideCount(root)).toBe(0);
    // a correct resend heals it
    expect(await s2.append(V(1), 0, 0, ls)).toBe('ok');
    expect(await readAll(s2, ls)).toBe('.'.repeat(30));
    expect((await s2.verify(V(1))).ok).toBe(true);
    await s2.close(); await t.cleanup();
  });
  for (const how of ['clean boundary', 'mid line', 'zero length'] as const) {
    it(`a body chunk cut short (${how}): lines before the cut are served, the rest reported, appends keep working, a resend heals`, async () => {
      const { t, s, ls, root } = await fresh(30); await s.close();
      const files = bodies(root); const p = path.join(vdir(root), files[1]);
      const size = fs.statSync(p).size;
      const cut = how === 'zero length' ? 0 : how === 'clean boundary' ? ls[0].length * 2 : ls[0].length * 2 + 17;   // chunk 1 starts at a line boundary
      fs.truncateSync(p, Math.min(cut, size - 1));
      const s2 = await reopen(root);
      const h = await s2.head(V(1));
      expect(h.lines).toBe(30);
      expect(h.damagedFromLine).not.toBeNull();
      const all = await readAll(s2, ls);
      expect(all).not.toMatch(/[X?]/);
      expect(all.indexOf('!')).toBeGreaterThan(0);
      expect(all.slice(0, all.indexOf('!'))).toMatch(/^\.+$/);
      expect(asideCount(root)).toBe(0);
      const more = [...ls, line(30), line(31)];
      expect(await s2.append(V(1), 0, 30, more.slice(30))).toBe('ok');   // a damaged middle never blocks new lines
      expect((await s2.head(V(1))).lines).toBe(32);
      expect(await s2.append(V(1), 0, 0, more)).toBe('ok');             // the resend heals
      expect(await readAll(s2, more)).toBe('.'.repeat(32));
      await s2.close(); await t.cleanup();
    });
  }
  it('the LAST chunk cut short: lines before it served, new appends land, a resend heals', async () => {
    const { t, s, ls, root } = await fresh(30); await s.close();
    const files = bodies(root); const p = path.join(vdir(root), files[files.length - 1]);
    fs.truncateSync(p, ls[0].length + 5);
    const s2 = await reopen(root);
    expect((await s2.head(V(1))).damagedFromLine).not.toBeNull();
    const more = [...ls, line(30)];
    expect(await s2.append(V(1), 0, 30, more.slice(30))).toBe('ok');
    expect((await readAll(s2, more)).slice(-1)).toBe('.');
    expect(await s2.append(V(1), 0, 0, more)).toBe('ok');
    expect(await readAll(s2, more)).toBe('.'.repeat(31));
    await s2.close(); await t.cleanup();
  });
});

describe('F4 a deleted first body chunk is damage, never a deliberate eviction', () => {
  it('S2: nothing was ever evicted, so the head says 0 evicted lines and reads report corrupt', async () => {
    const { t, s, ls, root } = await fresh(30); await s.close();
    fs.rmSync(path.join(vdir(root), bodies(root)[0]));
    const s2 = await reopen(root);
    const h = await s2.head(V(1));
    expect(h.evictedLines).toBe(0);
    expect(h.damagedFromLine).toBe(0);
    const all = await readAll(s2, ls);
    expect(all[0]).toBe('!'); expect(all).not.toContain('E'); expect(all).not.toMatch(/[X?]/);
    expect(all.slice(-5)).toBe('.....');
    expect(await s2.append(V(1), 0, 0, ls)).toBe('ok');          // a peer's resend heals it
    expect(await readAll(s2, ls)).toBe('.'.repeat(30));
    await s2.close(); await t.cleanup();
  });
});

describe('F5 an older evicted.json does not quarantine a healthy chat', () => {
  it('S1b: the marker from before a later eviction is put back: still served, nothing set aside', async () => {
    const { t, s, ls, root } = await fresh(30);
    await evict(s, 8);
    const e8 = fs.readFileSync(path.join(vdir(root), 'evicted.json'));
    await evict(s, 20);
    const before = await s.head(V(1));
    await s.close();
    fs.writeFileSync(path.join(vdir(root), 'evicted.json'), e8);
    const s2 = await reopen(root);
    const h = await s2.head(V(1));
    expect(asideCount(root)).toBe(0);
    expect(h.lines).toBe(30);
    expect(h.evictedLines).toBe(before.evictedLines);            // the CURRENT eviction is still the one in force
    expect((await readAll(s2, ls)).slice(h.evictedLines)).toMatch(/^\.+$/);
    await s2.close(); await t.cleanup();
  });
});

describe('F6 a deleted tail is never replaced by an empty one', () => {
  it('delete the tail file after a done set-aside: tail() and a retry report corrupt, nothing new is written', async () => {
    const { t, s, root } = await fresh(10);
    const id = 'abcdef012345';
    expect((await s.setAsideTail(id, V(1), 6)).lines).toBe(4);
    await s.close();
    const tp = path.join(vdir(root), 'tails', `${id}.tail`);
    fs.rmSync(tp);
    const s2 = await reopen(root);
    await expect(s2.tail(id)).rejects.toMatchObject({ code: 'corrupt' });
    await expect(s2.setAsideTail(id, V(1), 6)).rejects.toMatchObject({ code: 'corrupt' });
    expect(fs.existsSync(tp)).toBe(false);                       // no empty valid tail was written over the evidence
    await s2.close(); await t.cleanup();
  });
});

describe('F7 restoreBody verifies what it restored', () => {
  it('S5: a rotted byte in the partly evicted chunk is repaired and reads back', async () => {
    const { t, s, ls, root } = await fresh(30);
    await evict(s, 5); await s.close();
    const c0 = path.join(vdir(root), bodies(root)[0]);
    const b = fs.readFileSync(c0); b[ls[0].length + ls[1].length + 20] ^= 1; fs.writeFileSync(c0, b);
    const s2 = await reopen(root);
    const r = await s2.restoreBody(V(1), ls);
    expect(r.restoredLines).toBeGreaterThan(0);
    expect(await readAll(s2, ls)).toBe('.'.repeat(30));          // success means the lines read back
    expect((await s2.head(V(1))).damagedFromLine).toBeNull();
    await s2.close(); await t.cleanup();
  });
  it('restoring with chunk files missing in the middle of the evicted region fills them all', async () => {
    const { t, s, ls, root } = await fresh(30);
    await evict(s, 25); await s.close();
    const files = bodies(root);
    expect(files.length).toBeGreaterThan(0);
    const s2 = await reopen(root);
    await s2.restoreBody(V(1), ls);
    expect(await readAll(s2, ls)).toBe('.'.repeat(30));
    expect((await s2.verify(V(1))).ok).toBe(true);
    await s2.close(); await t.cleanup();
  });
});

describe('F8 an index file that belongs to another chat is detected as foreign', () => {
  it('another version\'s index.bin in this one: no body is cut, the head and every line are rebuilt right', async () => {
    const a = await fresh(22, { v: V(1), chat: 'chat-a', tag: 'a' });
    const lb = lines(5, 'b');
    await a.s.registerVersion(V(2), { chatId: 'chat-b', runtime: 'claude-code' });
    await a.s.append(V(2), 0, 0, lb);
    const headA = await a.s.head(V(1));
    await a.s.close();
    const bodyBefore = bodies(a.root).map((f) => fs.statSync(path.join(vdir(a.root), f)).size);
    fs.copyFileSync(path.join(vdir(a.root, V(2)), 'index.bin'), path.join(vdir(a.root), 'index.bin'));
    const s2 = await ChatStore.open(a.root, opts);
    await s2.registerVersion(V(1), { chatId: 'chat-a', runtime: 'claude-code' });
    await s2.registerVersion(V(2), { chatId: 'chat-b', runtime: 'claude-code' });
    const h = await s2.head(V(1));
    expect(h.lines).toBe(headA.lines);
    expect(h.hash).toBe(headA.hash);
    expect(h.damagedFromLine).toBeNull();
    expect(await readAll(s2, a.ls)).toBe('.'.repeat(22));
    expect(bodies(a.root).map((f) => fs.statSync(path.join(vdir(a.root), f)).size)).toEqual(bodyBefore);   // no body was cut
    expect(fs.existsSync(path.join(vdir(a.root), 'torn')) ? fs.readdirSync(path.join(vdir(a.root), 'torn')).filter((n) => n.endsWith('-body')) : []).toEqual([]);
    expect(await readAll(s2, lb, V(2))).toBe('.....');
    await s2.close(); await a.t.cleanup();
  });
});

describe('F9 version id length is limited and documented', () => {
  it('65 bytes is a typed bad-argument; 64 bytes registers, appends and can be set aside and quarantined', async () => {
    const t = await tmpRoot('r4id-'); const s = await ChatStore.open(t.dir, opts);
    await expect(s.registerVersion(Buffer.alloc(65, 7), { chatId: 'c', runtime: 'claude-code' })).rejects.toMatchObject({ code: 'bad-argument' });
    await expect(s.registerVersion(Buffer.alloc(128, 7), { chatId: 'c', runtime: 'claude-code' })).rejects.toMatchObject({ code: 'bad-argument' });
    const id = Buffer.alloc(64, 9);
    await s.registerVersion(id, { chatId: 'c64', runtime: 'claude-code' });
    expect(await s.append(id, 0, 0, lines(3))).toBe('ok');
    // the quarantine name is the longest name the store makes: it must fit
    await expect((s as any).quarantine(id.toString('hex'), 'test')).rejects.toMatchObject({ code: 'damaged' });
    await expect(s.head(id)).rejects.toMatchObject({ code: 'damaged' });
    expect((await s.setAsideDamaged(id)).asideName).toMatch(/-q1$/);
    expect(await s.append(id, 0, 0, lines(3))).toBe('ok');
    expect((await s.setAsideDamaged(id)).asideName).toMatch(/-2$/);   // a plain set-aside takes the next number
    await s.close(); await t.cleanup();
  });
});

describe('what the fuzz of the fourth round found while the fixes were being built', () => {
  it('a second loss in the control log cannot hide behind the first: entries acknowledged after a reported loss are still protected', async () => {
    const t = await tmpRoot('r4c3-'); const root = t.dir; const chat = 'chat-d';
    let s = await ChatStore.open(root, opts);
    const mkc = (i: number) => { const body = Buffer.from(`entry-${i}-${'z'.repeat(20)}`); return { id: sha(body), chat, seen: [] as string[], body }; };
    await s.appendControl(mkc(0)); await s.appendControl(mkc(1)); await s.close();
    const dir = path.join(root, 'control', sha(Buffer.from(chat))); const lp = path.join(dir, 'log.bin');
    const oneEntry = fs.readFileSync(lp).subarray(0, fs.readFileSync(lp).length / 2);
    const b = fs.readFileSync(lp); b[b.length - 6] ^= 1; fs.writeFileSync(lp, b);          // fault 1: the second record rots (reported)
    s = await ChatStore.open(root, opts);
    expect((await s.controlDamage(chat)).length).toBeGreaterThan(0);
    for (let i = 2; i < 5; i++) await s.appendControl(mkc(i));                               // three more are acknowledged while the loss stands
    await s.close();
    fs.writeFileSync(lp, oneEntry);                                                          // fault 2: the log is rolled back to one entry
    s = await ChatStore.open(root, opts);
    expect((await s.controlLog(chat)).length).toBe(1);
    expect((await s.controlDamage(chat)).length).toBeGreaterThan(0);                         // still REPORTED
    await s.close(); await t.cleanup();
  });

  it('a resend of lines that are stored beyond the checkpoint writes the checkpoint before it answers ok', async () => {
    const { t, s, ls, root } = await fresh(12);
    await s.close();
    const cp = path.join(vdir(root), 'checkpoint.bin');
    // an older statement (count 6): what a full disk leaves behind when an append wrote its lines but not its statement
    const s0 = await ChatStore.open(root, opts); await s0.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' });
    const { writeCheckpoint } = await import('./checkpoint');
    const cur = (await readCheckpoint(realFs, vdir(root)))!;
    const h6 = (await s0.hashAt(V(1), 0, 6))!;
    await s0.close();
    await writeCheckpoint(realFs, vdir(root), { ...cur, count: 6, h: Buffer.from(h6, 'hex') });
    // a load on a full disk cannot repair the lag (a read never fails for lack of space)
    let full = true;
    const wrap = (f: FileLike): FileLike => ({ write: (b, p) => (full ? Promise.reject(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })) : f.write(b, p)), read: (p, l) => f.read(p, l), size: () => f.size(), truncate: (l) => f.truncate(l), sync: () => f.sync(), close: () => f.close() });
    const tog: Fs = { ...realFs, open: async (p, o) => { if (full && o.create && !(await realFs.exists(p))) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); return wrap(await realFs.open(p, o)); }, mkdir: async (p) => { if (full) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); return realFs.mkdir(p); } };
    const s1 = await ChatStore.open(root, { ...opts, fs: tog }); await s1.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' });
    expect((await s1.head(V(1))).lines).toBe(12);
    expect((await readCheckpoint(realFs, vdir(root)))!.count).toBe(6);                       // not repaired yet
    full = false;
    expect(await s1.append(V(1), 0, 8, ls.slice(8, 12))).toBe('ok');                        // the resend acknowledges lines 8..11
    expect((await readCheckpoint(realFs, vdir(root)))!.count).toBe(12);                      // so the statement had to be written first
    expect(fs.existsSync(cp)).toBe(true);
    await s1.close(); await t.cleanup();
  });

  it('an older checkpoint taken before a cut (it claims lines the cut removed) does not hide the chat: it is lowered, the claimed lines are reported', async () => {
    const { t, s, root } = await fresh(30);
    const cp = path.join(vdir(root), 'checkpoint.bin');
    const before = fs.readFileSync(cp);
    await s.setAsideTail('abcdef012345', V(1), 12);
    await s.close();
    fs.writeFileSync(cp, before);                                                            // the older statement: 30 lines
    const s2 = await reopen(root);
    const h = await s2.head(V(1));
    expect(h.lines).toBe(12);
    expect(h.damagedFromLine).not.toBeNull();                                                // the lines it vouched for are reported as set aside
    expect(asideCount(root)).toBe(0);
    expect((await s2.tail('abcdef012345'))!.lines.length).toBe(18);                          // and they are kept in the tail file
    await s2.close(); await t.cleanup();
  });

  it('an older checkpoint that records an eviction a restore has since undone does not relabel the restored lines as evicted (they are served)', async () => {
    const { t, s, ls, root } = await fresh(30);
    await evict(s, 20);
    const cp = path.join(vdir(root), 'checkpoint.bin'); const evictedStatement = fs.readFileSync(cp);
    await s.restoreBody(V(1), ls);
    await s.close();
    fs.writeFileSync(cp, evictedStatement);                                                  // the older statement: 20 lines evicted
    const s2 = await reopen(root);
    const h = await s2.head(V(1));
    expect(h.evictedLines).toBe(0);
    expect(await readAll(s2, ls)).toBe('.'.repeat(30));                                      // every body is on disk, so every line is served
    await s2.close(); await t.cleanup();
  });

  it('an older checkpoint that still records an eviction that a restore has since undone does not quarantine the chat', async () => {
    const { t, s, ls, root } = await fresh(30);
    await evict(s, 20);
    const cp = path.join(vdir(root), 'checkpoint.bin'); const evicted = fs.readFileSync(cp);
    await s.restoreBody(V(1), ls);
    await s.setAsideTail('abcdef012345', V(1), 9);
    await s.close();
    fs.writeFileSync(cp, evicted);                                                           // the older statement: 30 lines, 20 of them evicted
    const s2 = await reopen(root);
    const h = await s2.head(V(1));
    expect(h.lines).toBeGreaterThanOrEqual(9);
    expect(asideCount(root)).toBe(0);
    expect((await readAll(s2, ls.slice(0, 9))).slice(0, 9)).toMatch(/^[.E]+$/);
    await s2.close(); await t.cleanup();
  });

  it('a body chunk that is too long (extra bytes past the next chunk) is harmless to a rebuild: the bytes past the next chunk\'s start are never read', async () => {
    const { t, s, ls, root } = await fresh(30);
    await s.close();
    const files = bodies(root); fs.appendFileSync(path.join(vdir(root), files[0]), Buffer.from('trailing junk that is not a line'));
    fs.rmSync(path.join(vdir(root), 'index.bin'));                                            // forces a rebuild from the bodies
    const s2 = await reopen(root);
    expect((await s2.head(V(1))).lines).toBe(30);
    expect(await readAll(s2, ls)).toBe('.'.repeat(30));
    await s2.close(); await t.cleanup();
  });
});
