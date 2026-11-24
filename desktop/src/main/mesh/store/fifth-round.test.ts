// Review round 5 (docs/active/reviews/2026-11-14-mesh-store-code-review-5.md): findings F1-F5, one named test each, plus the envelope's own checks.
//
// The class these close, for the last time: "a file that does not state what it is". Parked appends carried their position only in the file NAME, set-aside tails did not say which takeover
// they belong to, a whole chat folder put back was invisible, and one lost index.bin after an eviction hid every kept line. Synthetic data only; temp folders only.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChatStore } from './store';
import { V, CHAT, tmpRoot } from './testkit';
import { nl } from './fixtures';
import { sealEnv, openEnv } from './envelope';
import { frameLines } from './records';
import { HW_EVERY, hwPath } from './highwater';
import { readCheckpoint, readCheckpointState, writeCheckpoint, CHECKPOINT_SLOT } from './checkpoint';
import { crc32 } from './chain';
import { realFs } from './fsio';
import { parkId } from './parked';
import { GENESIS_EPOCH } from './tails';

const mk = (tag: string, n: number) => Array.from({ length: n }, (_, i) => nl({ type: 'user', uuid: `${tag}${i}`, message: { role: 'user', content: `${tag} ${'x'.repeat(40)} ${i}` } }));
const opts = { chunkBytes: 700, proofVerifier: () => true };
const keyOf = (v: Buffer) => v.toString('hex');
const vdir = (root: string, v: Buffer = V(1)) => path.join(root, 'versions', keyOf(v));
const reg = (s: ChatStore, v: Buffer = V(1), chat = CHAT) => s.registerVersion(v, { chatId: chat, runtime: 'claude-code' });
async function open(root: string, o = opts, v: Buffer = V(1)): Promise<ChatStore> { const s = await ChatStore.open(root, o); await reg(s, v); return s; }
async function evict(s: ChatStore, through: number, v: Buffer = V(1)) {
  const h = (await s.hashAt(v, 0, through))!;
  return s.evictBody(v, { kind: 'holders-confirmed', version: keyOf(v), through, hash: h, acks: [{ holder: 'p', version: keyOf(v), lines: through, hash: h, signature: 's' }] } as any);
}
/** One char per line: '.' served identical, 'E' evicted, '!' typed corrupt, 'X' WRONG BYTES (never allowed), '?' untyped error. */
async function readAll(s: ChatStore, ls: Buffer[], v: Buffer = V(1)): Promise<string> {
  const out: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    try { const r = await s.read(v, 0, i, i + 1); out.push(r === 'evicted' ? 'E' : r[0].equals(ls[i]) ? '.' : 'X'); } catch (e: any) { out.push(e?.code === 'corrupt' ? '!' : e?.code === 'bad-argument' ? '-' : '?'); }
  }
  return out.join('');
}
const parkFiles = (root: string) => fs.readdirSync(path.join(vdir(root), 'parked')).sort();

describe('the envelope', () => {
  const id = { role: 'park', version: 'aa', id: '0000000000000008-0123456789abcdef', fresh: 3 };
  const env = sealEnv(id, Buffer.from('payload'));
  it('opens when every field is what the caller expects', () => {
    const r = openEnv(env, { role: 'park', version: 'aa', id: id.id });
    expect(r.kind).toBe('ok'); if (r.kind === 'ok') { expect(r.payload.toString()).toBe('payload'); expect(r.fresh).toBe(3); }
  });
  it('a valid file of another ROLE is foreign, not believed', () => { expect(openEnv(env, { role: 'tail', version: 'aa' }).kind).toBe('foreign'); });
  it('a valid file of another VERSION is foreign', () => { expect(openEnv(env, { role: 'park', version: 'bb' }).kind).toBe('foreign'); });
  it('a valid file with another ID (position, takeover) is foreign', () => { expect(openEnv(env, { role: 'park', version: 'aa', id: '0000000000000009-0123456789abcdef' }).kind).toBe('foreign'); });
  it('the freshness counter is returned for the slot readers (slotfile.ts) to compare', () => { const r = openEnv(sealEnv({ ...id, fresh: 9 }, Buffer.from('x')), { role: 'park', version: 'aa' }); expect(r.kind === 'ok' && r.fresh).toBe(9); });
  it('a flipped bit anywhere, a cut and an extension are bad (never ok, never foreign)', () => {
    for (let i = 0; i < env.length; i++) { const b = Buffer.from(env); b[i] ^= 0x04; expect(openEnv(b, { role: 'park', version: 'aa' }).kind).toBe('bad'); }
    expect(openEnv(env.subarray(0, env.length - 1), { role: 'park', version: 'aa' }).kind).toBe('bad');
    expect(openEnv(Buffer.concat([env, Buffer.from([0])]), { role: 'park', version: 'aa' }).kind).toBe('bad');
    expect(openEnv(null, { role: 'park', version: 'aa' }).kind).toBe('absent');
  });
});

describe('F1 a parked file is bound to its own position and lines', () => {
  async function setup() {
    const t = await tmpRoot('r5-f1-');
    let s = await open(t.dir);
    const base = mk('base', 5), A = mk('AAAA', 3), B = mk('BBBB', 2), fill = mk('fill', 3);
    await s.append(V(1), 0, 0, base);
    expect(await s.append(V(1), 0, 8, A)).toBe('parked'); expect(await s.append(V(1), 0, 12, B)).toBe('parked');
    await s.close();
    const pd = path.join(vdir(t.dir), 'parked'); const names = parkFiles(t.dir);
    return { t, s, base, A, B, fill, pd, names, pa: path.join(pd, names[0]), pb: path.join(pd, names[1]) };
  }
  it('two parks swapped (each keeps a valid checksum): neither is applied, the head stays, the true lines are still wanted', async () => {
    const x = await setup();
    const ba = fs.readFileSync(x.pa), bb = fs.readFileSync(x.pb); fs.writeFileSync(x.pa, bb); fs.writeFileSync(x.pb, ba);
    const s = await open(x.t.dir);
    expect(await s.append(V(1), 0, 5, x.fill)).toBe('ok');
    const h = await s.head(V(1));
    expect(h.lines).toBe(8);                                   // the old store answered 10 and put B's first line at line 8
    expect(h.damagedFromLine).toBeNull();
    expect((await s.rejectedList(V(1))).length).toBe(1);       // the misplaced park is KEPT, not deleted
    // the caller resends what is still wanted: the true lines land at their true places
    await s.append(V(1), 0, 8, x.A); await s.append(V(1), 0, 11, mk('gap', 1)); await s.append(V(1), 0, 12, x.B);
    const all = await readAll(s, [...x.base, ...x.fill, ...x.A, ...mk('gap', 1), ...x.B]);
    expect(all).toBe('.'.repeat(5) + '.'.repeat(3) + '.'.repeat(3) + '.' + '..');
    await s.close(); await x.t.cleanup();
  });
  it('one park overwritten with a copy of the other: the copy is rejected when its place is reached, never applied at the wrong place', async () => {
    const x = await setup();
    fs.writeFileSync(x.pb, fs.readFileSync(x.pa));             // the line-12 park now holds the line-8 park's lines
    const s = await open(x.t.dir);
    await s.append(V(1), 0, 5, x.fill);                         // lines 5-7: the line-8 park applies (it is genuine), head 11
    await s.append(V(1), 0, 11, mk('gap', 1));                  // head 12: the file named 12 is reached
    const h = await s.head(V(1));
    expect(h.lines).toBe(12);                                   // the old store answered 15 with A's lines at 12-14
    expect((await s.rejectedList(V(1))).length).toBe(1);
    await s.close(); await x.t.cleanup();
  });
  it('a park whose id matches its name but whose lines are others (a forged hash) is rejected: the line hash is checked against the lines', async () => {
    const x = await setup();
    const forged = sealEnv({ role: 'park', version: keyOf(V(1)), id: parkId(x.names[0], GENESIS_EPOCH) }, frameLines(x.B));   // sealed with A's name, holding B's lines
    fs.writeFileSync(x.pa, forged);
    const s = await open(x.t.dir);
    await s.append(V(1), 0, 5, x.fill);
    expect((await s.head(V(1))).lines).toBe(8);
    expect((await s.rejectedList(V(1))).length).toBe(1);
    await s.close(); await x.t.cleanup();
  });
  it('a park sealed for ANOTHER version or as ANOTHER kind is rejected, never applied', async () => {
    const x = await setup();
    fs.writeFileSync(x.pa, sealEnv({ role: 'park', version: keyOf(V(2)), id: parkId(x.names[0], GENESIS_EPOCH) }, frameLines(x.A)));
    fs.writeFileSync(x.pb, sealEnv({ role: 'tail', version: keyOf(V(1)), id: parkId(x.names[1], GENESIS_EPOCH) }, frameLines(x.B)));
    const s = await open(x.t.dir);
    await s.append(V(1), 0, 5, x.fill); await s.append(V(1), 0, 8, mk('Q', 4));
    const h = await s.head(V(1));
    expect(h.lines).toBe(12);
    await s.append(V(1), 0, 12, mk('R', 1));                    // reaching the second one
    expect((await s.rejectedList(V(1))).length).toBe(2);
    await s.close(); await x.t.cleanup();
  });
});

describe('F2 a set-aside tail is bound to its takeover id', () => {
  async function setup() {
    const t = await tmpRoot('r5-f2-');
    const s = await open(t.dir, { ...opts, chunkBytes: 100000 });
    await s.append(V(1), 0, 0, mk('L', 8));
    await s.setAsideTail('aaaaaaaaaaaa', V(1), 6);            // tail A = lines 6,7
    await s.append(V(1), 0, 6, mk('M', 4));
    await s.setAsideTail('bbbbbbbbbbbb', V(1), 3);            // tail B = lines 3..9
    await s.close();
    return { t, td: path.join(vdir(t.dir), 'tails') };
  }
  it('another tail of the SAME version copied over this id reads as corrupt, never as this tail', async () => {
    const { t, td } = await setup();
    fs.copyFileSync(path.join(td, 'bbbbbbbbbbbb.tail'), path.join(td, 'aaaaaaaaaaaa.tail'));
    const s = await open(t.dir, { ...opts, chunkBytes: 100000 });
    await expect(s.tail('aaaaaaaaaaaa', V(1))).rejects.toMatchObject({ code: 'corrupt' });   // the old store returned B's seven lines
    await expect(s.setAsideTail('aaaaaaaaaaaa', V(1), 6)).rejects.toMatchObject({ code: 'corrupt' });
    const b = await s.tail('bbbbbbbbbbbb', V(1)); expect(b!.fromLine).toBe(3);
    await s.close(); await t.cleanup();
  });
  it('a tail of ANOTHER version copied in is not returned for this version, and a scan across versions skips it', async () => {
    const { t, td } = await setup();
    const s0 = await open(t.dir, { ...opts, chunkBytes: 100000 }, V(2)); await s0.append(V(2), 0, 0, mk('Z', 5)); await s0.setAsideTail('cccccccccccc', V(2), 2); await s0.close();
    fs.copyFileSync(path.join(vdir(t.dir, V(2)), 'tails', 'cccccccccccc.tail'), path.join(td, 'cccccccccccc.tail'));   // V(2)'s tail filed under V(1) too
    const s = await open(t.dir, { ...opts, chunkBytes: 100000 });
    await expect(s.tail('cccccccccccc', V(1))).rejects.toMatchObject({ code: 'corrupt' });
    const got = await s.tail('cccccccccccc'); expect(got && Buffer.from(got.version).equals(V(2))).toBe(true);   // found under its own version
    await s.close(); await t.cleanup();
  });
});

describe('F4 one lost or damaged index.bin after an eviction never hides the kept lines', () => {
  const L = mk('k', 21);
  async function setup() {
    const t = await tmpRoot('r5-f4-');
    const s = await open(t.dir);
    for (let i = 0; i < 21; i += 3) await s.append(V(1), 0, i, L.slice(i, i + 3));
    await evict(s, 12); await s.close();
    return { t, ix: path.join(vdir(t.dir), 'index.bin') };
  }
  const damages: [string, (ix: string) => void][] = [
    ['deleted', (ix) => fs.unlinkSync(ix)],
    ['cut to its header', (ix) => fs.truncateSync(ix, 36)],
    ['zeroed', (ix) => fs.writeFileSync(ix, Buffer.alloc(fs.statSync(ix).size))],
    ['a record in the evicted prefix rotted', (ix) => { const b = fs.readFileSync(ix); b[36 + 116 * 5 + 7] ^= 0x01; fs.writeFileSync(ix, b); }],
    ['replaced by another version\'s index', () => undefined],
  ];
  for (const [name, dmg] of damages) {
    it(`index.bin ${name}: every intact kept line is served, nothing is quarantined, appends continue`, async () => {
      const { t, ix } = await setup();
      if (name.startsWith('replaced')) {
        const s0 = await open(t.dir, opts, V(2)); const o = mk('other', 21); for (let i = 0; i < 21; i += 3) await s0.append(V(2), 0, i, o.slice(i, i + 3)); await s0.close();
        fs.copyFileSync(path.join(vdir(t.dir, V(2)), 'index.bin'), ix);
      } else dmg(ix);
      const s = await open(t.dir);
      const h = await s.head(V(1));                          // the old store threw `damaged` here and moved everything to aside/
      expect(h.lines).toBe(21);
      expect(h.evictedLines).toBe(12);
      expect(await readAll(s, L)).toBe('E'.repeat(12) + '.'.repeat(9));
      expect(fs.existsSync(path.join(t.dir, 'aside')) ? fs.readdirSync(path.join(t.dir, 'aside')).length : 0).toBe(0);
      expect(await s.hashAt(V(1), 0, 12)).not.toBeNull();     // the boundary survives in the checkpoint
      await s.append(V(1), 0, 21, mk('more', 2));
      expect((await s.head(V(1))).lines).toBe(23);
      expect((await s.verify(V(1))).ok).toBe(true);
      await s.close();
      const s2 = await open(t.dir);                           // and it stays healthy after another open
      expect(await readAll(s2, L)).toBe('E'.repeat(12) + '.'.repeat(9));
      await s2.close(); await t.cleanup();
    });
  }
  it('restoreBody after the loss brings the evicted lines back and the index is whole again', async () => {
    const { t, ix } = await setup(); fs.unlinkSync(ix);
    const s = await open(t.dir);
    expect((await s.restoreBody(V(1), L)).restoredLines).toBe(21);
    expect(await readAll(s, L)).toBe('.'.repeat(21));
    await s.close();
    const s2 = await open(t.dir);
    expect((await s2.head(V(1))).evictedLines).toBe(0);
    expect(await readAll(s2, L)).toBe('.'.repeat(21));
    expect(await s2.hashAt(V(1), 0, 5)).not.toBeNull();
    expect((await s2.verify(V(1))).ok).toBe(true);
    await s2.close(); await t.cleanup();
  });
});

describe('F5 an older checkpoint after a later eviction', () => {
  const L = mk('f', 30);
  async function setup() {
    const t = await tmpRoot('r5-f5-');
    const s = await open(t.dir);
    for (let i = 0; i < 30; i += 3) await s.append(V(1), 0, i, L.slice(i, i + 3));
    await evict(s, 19);
    const older = fs.readFileSync(path.join(vdir(t.dir), 'checkpoint.bin'));
    await evict(s, 27); await s.close();
    fs.writeFileSync(path.join(vdir(t.dir), 'checkpoint.bin'), older);          // the checkpoint says 19 again
    return { t };
  }
  it('lines 19-26 read as evicted (not damaged) where the high-water record proves it', async () => {
    const { t } = await setup();
    const s = await open(t.dir);
    const h = await s.head(V(1));
    expect(h.evictedLines).toBe(27);
    expect(h.damagedFromLine).toBeNull();
    expect(await readAll(s, L)).toBe('E'.repeat(27) + '.'.repeat(3));
    await s.close(); await t.cleanup();
  });
  it('without that proof the lines read as damaged, and ONE restoreBody call restores everything it was given', async () => {
    const { t } = await setup();
    fs.rmSync(path.join(t.dir, 'highwater'), { recursive: true });
    const s = await open(t.dir);
    expect((await readAll(s, L)).slice(19, 27)).toBe('!'.repeat(8));
    expect((await s.restoreBody(V(1), L)).restoredLines).toBe(30);                // the old store restored 19 and needed a second call
    expect(await readAll(s, L)).toBe('.'.repeat(30));
    expect((await s.head(V(1))).damagedFromLine).toBeNull();
    await s.close(); await t.cleanup();
  });
});

describe('F3 a whole chat folder put back is reported, never silent, nothing is deleted', () => {
  const copyDir = (a: string, b: string) => fs.cpSync(a, b, { recursive: true });
  async function setup() {
    const t = await tmpRoot('r5-f3-');
    const s = await open(t.dir);
    const L = mk('r', 30);
    await s.append(V(1), 0, 0, L.slice(0, 12)); await s.close();
    const snap = path.join(t.dir, '..', path.basename(t.dir) + '-snap'); copyDir(vdir(t.dir), snap);          // the backup: an hour ago
    const s2 = await open(t.dir); await s2.append(V(1), 0, 12, L.slice(12)); await s2.close();              // later work, 30 lines
    return { t, L, snap };
  }
  it('the folder restored as it was: the head is behind, and that is REPORTED with both numbers; nothing is deleted or cut', async () => {
    const { t, L, snap } = await setup();
    fs.rmSync(vdir(t.dir), { recursive: true }); copyDir(snap, vdir(t.dir));
    const before = fs.readdirSync(vdir(t.dir)).sort();
    const s = await open(t.dir);
    const h = await s.head(V(1));
    expect(h.lines).toBe(12);
    expect(h.rolledBack).toEqual({ from: 12, had: 30 });
    expect(h.damagedFromLine).toBe(12);                       // the existing damage channel: lines from 12 on are wanted
    expect(await readAll(s, L.slice(0, 12))).toBe('.'.repeat(12));
    for (const n of before) expect(fs.existsSync(path.join(vdir(t.dir), n)), n).toBe(true);                // nothing deleted (an open may add its scrub mark)
    expect(fs.existsSync(path.join(vdir(t.dir), 'torn'))).toBe(false); expect(fs.existsSync(path.join(vdir(t.dir), 'rejected'))).toBe(false);
    // the refetch fills the gap and the report ends
    await s.append(V(1), 0, 12, L.slice(12));
    const h2 = await s.head(V(1));
    expect(h2.lines).toBe(30); expect(h2.rolledBack).toBeNull(); expect(h2.damagedFromLine).toBeNull();
    await s.close(); fs.rmSync(snap, { recursive: true }); await t.cleanup();
  });
  it('a missing, damaged, foreign or older high-water record is harmless: it can only under-report', async () => {
    const { t, L, snap } = await setup();
    fs.rmSync(vdir(t.dir), { recursive: true }); copyDir(snap, vdir(t.dir));
    const hw = hwPath(t.dir, keyOf(V(1)));
    const good = fs.readFileSync(hw);
    for (const damage of [() => fs.unlinkSync(hw), () => fs.writeFileSync(hw, Buffer.alloc(2048)), () => fs.truncateSync(hw, 100)]) {
      fs.writeFileSync(hw, good); damage();
      const s = await open(t.dir);
      const h = await s.head(V(1));
      expect(h.lines).toBe(12); expect(h.rolledBack).toBeNull(); expect(h.damagedFromLine).toBeNull();
      expect(await readAll(s, L.slice(0, 12))).toBe('.'.repeat(12));
      await s.close();
    }
    fs.rmSync(snap, { recursive: true }); await t.cleanup();
  });
  it('another version\'s record put in its place is foreign: no report', async () => {
    const { t, snap } = await setup();
    const s0 = await open(t.dir, opts, V(2)); await s0.append(V(2), 0, 0, mk('o', 40)); await s0.close();
    fs.rmSync(vdir(t.dir), { recursive: true }); copyDir(snap, vdir(t.dir));
    fs.copyFileSync(hwPath(t.dir, keyOf(V(2))), hwPath(t.dir, keyOf(V(1))));
    const s = await open(t.dir);
    expect((await s.head(V(1))).rolledBack).toBeNull();
    await s.close(); fs.rmSync(snap, { recursive: true }); await t.cleanup();
  });
  it('a deliberate cut (setAsideTail) and a deliberate set-aside are never reported as rollbacks', async () => {
    const t = await tmpRoot('r5-f3b-');
    const s = await open(t.dir, { ...opts, chunkBytes: 100000 });
    await s.append(V(1), 0, 0, mk('c', 20)); await s.close();
    const s1 = await open(t.dir, { ...opts, chunkBytes: 100000 });
    await s1.setAsideTail('dddddddddddd', V(1), 10); await s1.close();
    const s2 = await open(t.dir, { ...opts, chunkBytes: 100000 });
    expect((await s2.head(V(1))).rolledBack).toBeNull(); expect((await s2.head(V(1))).lines).toBe(10);
    await s2.setAsideDamaged(V(1)); await s2.close();
    const s3 = await open(t.dir, { ...opts, chunkBytes: 100000 });
    expect((await s3.head(V(1))).rolledBack).toBeNull(); expect((await s3.head(V(1))).lines).toBe(0);
    await s3.close(); await t.cleanup();
  });
  it('the record is raised every HW_EVERY lines and at close, so a rollback of more than that is seen', async () => {
    const t = await tmpRoot('r5-f3c-');
    const s = await open(t.dir, { ...opts, chunkBytes: 1 << 20 });
    await s.append(V(1), 0, 0, mk('h', HW_EVERY - 1));
    expect(fs.existsSync(hwPath(t.dir, keyOf(V(1))))).toBe(false);            // not yet: one write per HW_EVERY lines, not per append
    await s.append(V(1), 0, HW_EVERY - 1, mk('h2', 1));
    expect(fs.existsSync(hwPath(t.dir, keyOf(V(1))))).toBe(true);
    await s.close(); await t.cleanup();
  });
});

describe('the pieces behind F4: every reader copes with an index whose evicted prefix has no records', () => {
  const L = mk('q', 21);
  async function lost() {
    const t = await tmpRoot('r5-f4b-');
    const s = await open(t.dir);
    for (let i = 0; i < 21; i += 3) await s.append(V(1), 0, i, L.slice(i, i + 3));
    await evict(s, 12); await s.close();
    fs.unlinkSync(path.join(vdir(t.dir), 'index.bin'));
    return { t, s: await open(t.dir) };
  }
  it('scrub, summary, reply ends, verify and a full resend from line 0 all work; hashAt inside the lost prefix says evicted; the boundary and the head answer', async () => {
    const { t, s } = await lost();
    expect((await s.scrubStep(V(1), { maxBytes: 1 << 20 })).damagedFromLine).toBeNull();
    expect((await s.summary(V(1))).lines).toBe(21);
    await s.replyEnds(V(1));
    expect((await s.verify(V(1))).ok).toBe(true);
    expect(await s.append(V(1), 0, 0, L)).toBe('ok');                         // a peer resends everything: the lost prefix is skipped, the kept lines are compared, nothing changes
    expect((await s.head(V(1))).lines).toBe(21);
    await expect(s.hashAt(V(1), 0, 5)).rejects.toMatchObject({ code: 'evicted' });
    expect(await s.hashAt(V(1), 0, 12)).not.toBeNull(); expect(await s.hashAt(V(1), 0, 21)).not.toBeNull();
    const seen: number[] = []; try { for await (const b of s.conversationLines(V(1), 0)) for (const x of b) seen.push(x.line); } catch (e: any) { expect(e.code).toBe('evicted'); }
    await s.close(); await t.cleanup();
  });
  it('a second eviction after the loss moves the boundary on and a third open still serves every kept line', async () => {
    const { t, s } = await lost();
    await evict(s, 17); await s.close();
    const s2 = await open(t.dir);
    expect((await s2.head(V(1))).evictedLines).toBe(17);
    expect(await readAll(s2, L)).toBe('E'.repeat(17) + '.'.repeat(4));
    await s2.close(); await t.cleanup();
  });
});

describe('the rebuild believes the checkpoint over an older index of a replaced history', () => {
  it('an older index.bin whose records describe lines a set-aside tail later replaced costs no line', async () => {
    const t = await tmpRoot('r5-old-');
    const A = mk('A', 7), B = mk('B', 48);
    let s = await open(t.dir, { ...opts, chunkBytes: 100000 }); await s.append(V(1), 0, 0, A); await s.close();
    const ix = path.join(vdir(t.dir), 'index.bin'); const old = fs.readFileSync(ix);            // the index of history A (7 lines)
    s = await open(t.dir, { ...opts, chunkBytes: 100000 });
    await s.setAsideTail('aaaaaaaa', V(1), 4); await s.append(V(1), 0, 4, B); await s.close();   // lines 4.. are replaced: history B
    fs.writeFileSync(ix, old);                                                                    // ONE fault: the older index comes back
    s = await open(t.dir, { ...opts, chunkBytes: 100000 });
    const h = await s.head(V(1));
    expect(h.lines).toBe(52); expect(h.damagedFromLine).toBeNull();                              // the old store answered head 7, damaged from 4, and 45 lines unserved
    expect(await readAll(s, [...A.slice(0, 4), ...B])).toBe('.'.repeat(52));
    await s.close(); await t.cleanup();
  });
});

describe('the high-water record names its own points', () => {
  it('a head that falls BETWEEN two recorded points is still reported, using the nearest point below it', async () => {
    const t = await tmpRoot('r5-hw-');
    const L = mk('w', 3 * HW_EVERY + 40);
    let s = await open(t.dir, { ...opts, chunkBytes: 1 << 20 });
    await s.append(V(1), 0, 0, L.slice(0, HW_EVERY + 10)); await s.close();                      // point at HW_EVERY (during the append) and again at close
    const snap = path.join(t.dir, '..', path.basename(t.dir) + '-hwsnap'); fs.cpSync(vdir(t.dir), snap, { recursive: true });
    s = await open(t.dir, { ...opts, chunkBytes: 1 << 20 }); await s.append(V(1), 0, HW_EVERY + 10, L.slice(HW_EVERY + 10)); await s.close();
    fs.rmSync(vdir(t.dir), { recursive: true }); fs.cpSync(snap, vdir(t.dir), { recursive: true });
    s = await open(t.dir, { ...opts, chunkBytes: 1 << 20 });
    const h = await s.head(V(1));
    expect(h.lines).toBe(HW_EVERY + 10); expect(h.rolledBack).toEqual({ from: HW_EVERY + 10, had: L.length });
    await s.close(); fs.rmSync(snap, { recursive: true }); await t.cleanup();
  });
  it('a head behind the record whose nearest recorded point does NOT match the folder (another history) is not called a rollback', async () => {
    const t = await tmpRoot('r5-hw2-');
    let s = await open(t.dir, { ...opts, chunkBytes: 1 << 20 }); await s.append(V(1), 0, 0, mk('p', HW_EVERY)); await s.append(V(1), 0, HW_EVERY, mk('p2', 44)); await s.close();   // points at 0, 256 and 300
    fs.rmSync(vdir(t.dir), { recursive: true });                                                  // the folder is gone, a DIFFERENT 280-line history of the same version is written
    s = await open(t.dir, { ...opts, chunkBytes: 1 << 20 }); await s.append(V(1), 0, 0, mk('other', 280)); await s.close();
    s = await open(t.dir, { ...opts, chunkBytes: 1 << 20 });                                      // (the check runs at open)
    const h = await s.head(V(1));
    expect(h.lines).toBe(280); expect(h.rolledBack).toBeNull();                                  // the point at 256 does not match: not the same history, so no claim
    await s.close(); await t.cleanup();
  });
});

describe('each identity check can be killed on its own (the second layer that also catches the fault does not hide the first)', () => {
  it('a park with the SAME lines at ANOTHER position is rejected by its sealed id alone (the line hash in the name still matches)', async () => {
    const t = await tmpRoot('r5-iso1-');
    const same = mk('SAME', 2);
    let s = await open(t.dir); await s.append(V(1), 0, 0, mk('b', 5)); await s.append(V(1), 0, 8, same); await s.append(V(1), 0, 20, same);   // identical lines, two positions
    await s.close();
    const pd = path.join(vdir(t.dir), 'parked'); const [n8, n20] = parkFiles(t.dir);
    fs.copyFileSync(path.join(pd, n8), path.join(pd, n20));        // the position-20 park now says "position 8" inside, with a valid checksum and a matching line hash
    s = await open(t.dir);
    await s.append(V(1), 0, 5, mk('fill', 3)); await s.append(V(1), 0, 10, mk('g', 10));       // head 20: the file named 20 is reached
    expect((await s.head(V(1))).lines).toBe(20);
    expect((await s.rejectedList(V(1))).length).toBe(1);
    await s.close(); await t.cleanup();
  });
  it('an index of ANOTHER version in an EMPTY version is refused by its header tag alone (the checkpoint says 0 lines and cannot contradict it)', async () => {
    const t = await tmpRoot('r5-iso2-');
    let s = await open(t.dir, opts, V(2)); await s.append(V(2), 0, 0, mk('o', 6)); await s.close();
    s = await open(t.dir); await s.close();                                                   // version 1: registered, no lines
    fs.copyFileSync(path.join(vdir(t.dir, V(2)), 'index.bin'), path.join(vdir(t.dir), 'index.bin'));
    s = await open(t.dir);
    const h = await s.head(V(1));
    expect(h.lines).toBe(0); expect(h.damagedFromLine).toBeNull();
    await s.append(V(1), 0, 0, mk('mine', 3)); expect((await s.head(V(1))).lines).toBe(3);
    await s.close(); await t.cleanup();
  });
  it('a checkpoint statement that contradicts itself (more lines evicted than the head holds) is no evidence: the index and bodies stand on their own and nothing is rebuilt', async () => {
    const t = await tmpRoot('r5-iso3-');
    const L = mk('c', 12);
    let s = await open(t.dir); for (let i = 0; i < 12; i += 3) await s.append(V(1), 0, i, L.slice(i, i + 3)); await s.close();
    const st = await readCheckpointState(realFs, vdir(t.dir)); const cur = st.ck!;
    await writeCheckpoint(realFs, vdir(t.dir), { ...cur, evLines: 20, evBytes: 99999, boundary: { h: cur.h, c: cur.c, convCount: 0, candN: -1, candId: null }, lostRecs: 0 }, st);   // a statement of 20 evicted lines with 12 in the head
    s = await open(t.dir);
    expect((await s.head(V(1))).lines).toBe(12);
    expect(fs.existsSync(path.join(vdir(t.dir), 'replaced-index'))).toBe(false);            // no rebuild: the contradictory slot was simply not believed
    await s.close(); await t.cleanup();
  });
  it('a checkpoint slot whose boundary flag contradicts its eviction count is not believed (checksum fixed up, so only the contradiction can catch it)', async () => {
    const t = await tmpRoot('r5-iso4-');
    const L = mk('d', 21);
    const s = await open(t.dir); for (let i = 0; i < 21; i += 3) await s.append(V(1), 0, i, L.slice(i, i + 3)); await evict(s, 12); await s.close();
    const cp = path.join(vdir(t.dir), 'checkpoint.bin'); const b = fs.readFileSync(cp);
    const st0 = await readCheckpointState(realFs, vdir(t.dir));
    const newest = st0.next === 0 ? 1 : 0;                                                     // `next` is the slot that would be overwritten: the other one is the newest
    const at = newest * CHECKPOINT_SLOT;
    b.writeUInt32BE(0, at + 228);                                                              // the "a boundary is present" flag cleared while 12 lines are evicted
    b.writeUInt32BE(crc32(b, at, at + CHECKPOINT_SLOT - 4), at + CHECKPOINT_SLOT - 4);
    fs.writeFileSync(cp, b);
    const st1 = await readCheckpointState(realFs, vdir(t.dir));
    expect(st1.slotsOk).toBe(1);                                                               // only the other slot is evidence
    await t.cleanup();
  });
  it('a boundary in the checkpoint that disagrees with the index record at the eviction point is repaired by a rebuild (the checkpoint\'s boundary ends up equal to the true chain)', async () => {
    const t = await tmpRoot('r5-iso5-');
    const L = mk('e', 21);
    let s = await open(t.dir); for (let i = 0; i < 21; i += 3) await s.append(V(1), 0, i, L.slice(i, i + 3)); await evict(s, 12);
    const truth = await s.hashAt(V(1), 0, 12); await s.close();
    const st = await readCheckpointState(realFs, vdir(t.dir)); const cur = st.ck!;
    await writeCheckpoint(realFs, vdir(t.dir), { ...cur, boundary: { ...cur.boundary!, h: Buffer.alloc(32, 7) } }, st);     // a VALID statement with a wrong boundary
    s = await open(t.dir);
    expect((await s.head(V(1))).lines).toBe(21);
    await s.close();
    const after = await readCheckpoint(realFs, vdir(t.dir));
    expect(after!.boundary!.h.toString('hex')).toBe(truth);
    await t.cleanup();
  });
});

describe('the rebuild past the checkpoint', () => {
  it('a missing body past the checkpoint ends the rebuild even when an OLDER index copy has a rotted record exactly at the cut and valid ones beyond it', async () => {
    const t = await tmpRoot('r5-cut-');
    const L = mk('z', 24); const o = { ...opts, chunkBytes: 1 << 20 };
    let s = await open(t.dir, o); await s.append(V(1), 0, 0, L); await s.close();
    const ix = path.join(vdir(t.dir), 'index.bin'); const b = fs.readFileSync(ix); b[36 + 116 * 7 + 5] ^= 1; fs.writeFileSync(ix, b);      // a rotted record 7 among valid ones
    s = await open(t.dir, o); await s.head(V(1)); await s.setAsideTail('cccccccc', V(1), 7); await s.close();                          // the rebuild kept the old index in replaced-index/; the cut is at line 7
    const s2 = await open(t.dir, o, V(2)); await s2.append(V(2), 0, 0, mk('o', 30)); await s2.close();
    fs.copyFileSync(path.join(vdir(t.dir, V(2)), 'index.bin'), ix);                                                                    // ONE fault: another version's index
    s = await open(t.dir, o);
    const h = await s.head(V(1));                                                                                                     // found by fuzz seed 9708: this used to quarantine the version
    expect(h.lines).toBe(7); expect(h.damagedFromLine).toBeNull();
    expect(await readAll(s, L.slice(0, 7))).toBe('.'.repeat(7));
    await s.close(); await t.cleanup();
  });
});

describe('an older, SHORTER index after the whole index was lost once', () => {
  it('an index with fewer records than the stand-in position the checkpoint names is re-derived, not walked (found by fuzz seed 27188: an untyped RangeError)', async () => {
    const t = await tmpRoot('r5-short-');
    const L = mk('y', 21);
    let s = await open(t.dir); await s.append(V(1), 0, 0, L.slice(0, 6)); await s.close();
    const ix = path.join(vdir(t.dir), 'index.bin'); const old = fs.readFileSync(ix);              // 6 records
    s = await open(t.dir); for (let i = 6; i < 21; i += 3) await s.append(V(1), 0, i, L.slice(i, i + 3)); await evict(s, 12); await s.close();
    fs.unlinkSync(ix); s = await open(t.dir); await s.head(V(1)); await s.close();                // the index is lost once: the stand-in at slot 11, lostRecs 12
    fs.writeFileSync(ix, old);                                                                    // and an OLDER, shorter index (6 records) comes back
    s = await open(t.dir);
    expect((await s.head(V(1))).lines).toBe(21);
    expect(await readAll(s, L)).toBe('E'.repeat(12) + '.'.repeat(9));
    await s.close(); await t.cleanup();
  });
});

