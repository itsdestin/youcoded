// Review round 6 (docs/active/reviews/2026-11-23-mesh-store-code-review-6.md): B1 (a parked append crossing a takeover), B2 (a set-aside tail whose loss could go unreported),
// B3 (the stated high-water limit), M7 (the high-water guard nothing tested). Synthetic data only; temp folders only.
//
// The class these close: "a file that is valid, in the right place, but belongs to ANOTHER HISTORY" (a park from the old host's line of history) and "a protecting marker that is written
// too late" (the tail's marker came after the cut, so a crash in between left the only copy of the cut lines unprotected). Both tests below walk EVERY disk operation of a takeover
// with a crash injected at each one, instead of naming the one unlucky spot the reviewer found.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChatStore } from './store';
import { V, CHAT, tmpRoot } from './testkit';
import { nl } from './fixtures';
import { FaultFs, InjectedCrash } from './fault-fs';
import { HW_EVERY, readHw } from './highwater';
import { realFs } from './fsio';

const mk = (tag: string, n: number) => Array.from({ length: n }, (_, i) => nl({ type: 'user', uuid: `${tag}${i}`, message: { role: 'user', content: `${tag} ${'x'.repeat(30)} ${i}` } }));
const A = mk('A', 80); const B = mk('B', 80);
const opts = { chunkBytes: 100000, proofVerifier: () => true };
const keyOf = (v: Buffer) => v.toString('hex');
const vdir = (root: string, v: Buffer = V(1)) => path.join(root, 'versions', keyOf(v));
const TID = 'aabbccdd0011';
async function open(root: string, o: object = opts, fsx?: FaultFs): Promise<ChatStore> {
  const s = await ChatStore.open(root, { ...o, ...(fsx ? { fs: fsx } : {}) });
  await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' });
  return s;
}
/** One char per line: '.' equals want[i], 'a' equals the OLD history's line (the bug), '!' typed corrupt, 'X' other wrong bytes, '-' not stored. */
async function view(s: ChatStore, want: Buffer[]): Promise<string> {
  const out: string[] = [];
  for (let i = 0; i < want.length; i++) {
    try { const r = await s.read(V(1), 0, i, i + 1); out.push(r === 'evicted' ? 'E' : r[0].equals(want[i]) ? '.' : r[0].equals(A[i]) ? 'a' : 'X'); }
    catch (e: any) { out.push(e?.code === 'corrupt' ? '!' : '-'); }
  }
  return out.join('');
}
const truth = (cut: number, n: number): Buffer[] => [...A.slice(0, cut), ...B.slice(cut, n)];   // the new host's history: A up to the cut, then B
const tailsDir = (root: string) => path.join(vdir(root), 'tails');
const parkNames = (root: string) => { try { return fs.readdirSync(path.join(vdir(root), 'parked')).sort(); } catch { return []; } };
const rejectedNames = (root: string) => { try { return fs.readdirSync(path.join(vdir(root), 'rejected')).sort(); } catch { return []; } };

describe('B1 a parked append belongs to the history it was parked against', () => {
  it('the reviewer\'s probe: park A50..53, takeover at 20, the new host reaches line 50: the park is NOT applied, the true continuation is accepted, the park stays findable', async () => {
    const t = await tmpRoot('r6-b1-');
    const s = await open(t.dir);
    expect(await s.append(V(1), 0, 0, A.slice(0, 40))).toBe('ok');
    await s.append(V(1), 0, 50, A.slice(50, 53));                     // parked: the head is 40
    expect(parkNames(t.dir).length).toBe(1);
    expect((await s.setAsideTail(TID, V(1), 20)).lines).toBe(20);
    expect(await s.append(V(1), 0, 20, B.slice(20, 50))).toBe('ok');
    expect(await s.append(V(1), 0, 50, B.slice(50, 60))).toBe('ok');   // used to be 'not-a-prefix'
    const h = await s.head(V(1));
    expect(h.lines).toBe(60); expect(h.damagedFromLine).toBeNull();
    expect(await view(s, truth(20, 60))).toBe('.'.repeat(60));
    expect(parkNames(t.dir)).toEqual([]);
    expect(rejectedNames(t.dir).length).toBe(1);                      // nothing acknowledged is dropped: the old host's park is kept
    expect((await s.rejectedList(V(1))).length).toBe(1);
    await s.close(); await t.cleanup();
  });
  it('a takeover that cuts NOTHING still starts a new history: a park from before it is not applied', async () => {
    const t = await tmpRoot('r6-b1b-');
    const s = await open(t.dir);
    await s.append(V(1), 0, 0, A.slice(0, 40));
    await s.append(V(1), 0, 50, A.slice(50, 53));
    expect((await s.setAsideTail(TID, V(1), 40)).lines).toBe(0);      // the new host takes over exactly at the head: no cut
    expect(await s.append(V(1), 0, 40, B.slice(40, 50))).toBe('ok');
    expect(await s.append(V(1), 0, 50, B.slice(50, 60))).toBe('ok');
    expect(await view(s, truth(40, 60))).toBe('.'.repeat(60));
    await s.close(); await t.cleanup();
  });
  it('a stale park put back after the cleanup (the cleanup step skipped by a crash) is still refused on read: the park is bound to the history, not to the cleanup', async () => {
    const t = await tmpRoot('r6-b1c-');
    const s = await open(t.dir);
    await s.append(V(1), 0, 0, A.slice(0, 40));
    await s.append(V(1), 0, 50, A.slice(50, 53));
    const [name] = parkNames(t.dir); const copy = fs.readFileSync(path.join(vdir(t.dir), 'parked', name));
    await s.setAsideTail(TID, V(1), 20);
    fs.mkdirSync(path.join(vdir(t.dir), 'parked'), { recursive: true });
    fs.writeFileSync(path.join(vdir(t.dir), 'parked', name), copy);   // as if the move to rejected/ never happened
    await s.close();
    const s2 = await open(t.dir);
    expect(await s2.append(V(1), 0, 20, B.slice(20, 50))).toBe('ok');
    expect(await s2.append(V(1), 0, 50, B.slice(50, 60))).toBe('ok');
    expect(await view(s2, truth(20, 60))).toBe('.'.repeat(60));
    expect(rejectedNames(t.dir).length).toBe(2);                      // the first copy (moved at the cut) and the put-back copy (refused on read): both kept
    await s2.close(); await t.cleanup();
  });
  it('a park made AFTER the takeover (new history) still drains normally', async () => {
    const t = await tmpRoot('r6-b1d-');
    const s = await open(t.dir);
    await s.append(V(1), 0, 0, A.slice(0, 40));
    await s.setAsideTail(TID, V(1), 20);
    await s.append(V(1), 0, 30, B.slice(30, 35));                     // parked under the new history
    expect(await s.append(V(1), 0, 20, B.slice(20, 30))).toBe('ok');
    expect((await s.head(V(1))).lines).toBe(35);
    expect(await view(s, truth(20, 35))).toBe('.'.repeat(35));
    await s.close(); await t.cleanup();
  });
  it('a crash at EVERY disk operation of a takeover (kill, torn write, power loss): after the retry the old park never reaches the new history', async () => {
    const setup = async (root: string) => { const s = await open(root); await s.append(V(1), 0, 0, A.slice(0, 40)); await s.append(V(1), 0, 50, A.slice(50, 53)); await s.close(); };
    const probe = await tmpRoot('r6-b1e-count-'); await setup(probe.dir);
    const pf = new FaultFs(0); const ps = await open(probe.dir, opts, pf); const before = pf.ops; await ps.setAsideTail(TID, V(1), 20); const total = pf.ops - before; await ps.close(); await probe.cleanup();
    expect(total).toBeGreaterThan(5);
    for (const variant of [{ tear: false, powerLoss: false }, { tear: true, powerLoss: true }]) {
      for (let k = 1; k <= total + 12; k++) {
        const t = await tmpRoot('r6-b1e-'); await setup(t.dir);
        const shadow = fs.mkdtempSync(path.join(path.dirname(t.dir), 'shadow-'));
        const ffs = new FaultFs(0); let crashed = false;
        const ff = new FaultFs(k + 0, { ...variant, shadowDir: shadow });
        try {
          const s = await open(t.dir, opts, ff);
          const base = ff.ops; void base; await s.setAsideTail(TID, V(1), 20);
        } catch (e) { if (!(e instanceof InjectedCrash)) throw e; crashed = true; }
        void ffs; await ff.applyPowerLoss();
        const lock = path.join(t.dir, 'LOCK'); if (fs.existsSync(lock)) fs.writeFileSync(lock, JSON.stringify({ ...JSON.parse(fs.readFileSync(lock, 'utf8')), pid: 2147483646, start: 'dead' }));
        const where = `kill at op ${k} ${JSON.stringify(variant)} crashed=${crashed}`;
        const s2 = await open(t.dir);
        expect((await s2.setAsideTail(TID, V(1), 20)).lines, where).toBe(20);   // the caller retries until it is answered
        expect(await s2.append(V(1), 0, 20, B.slice(20, 50)), where).toBe('ok');
        expect(await s2.append(V(1), 0, 50, B.slice(50, 60)), where).toBe('ok');
        expect(await view(s2, truth(20, 60)), where).toBe('.'.repeat(60));
        expect((await s2.head(V(1))).damagedFromLine, where).toBeNull();
        const tl = await s2.tail(TID, V(1)); expect(tl!.lines.length, where).toBe(20);
        await s2.close(); fs.rmSync(shadow, { recursive: true, force: true }); await t.cleanup();
      }
    }
  }, 300_000);
});

describe('B2 a set-aside tail is protected from BEFORE the cut: its loss is always reported, a retry never writes an empty tail over a lost one', () => {
  it('the reviewer\'s probe: a crash between the cut and the marker, a retry, then the tail file is lost: tail() and every retry say `corrupt`, nothing is written over the evidence', async () => {
    const t = await tmpRoot('r6-b2-');
    let s = await open(t.dir);
    await s.append(V(1), 0, 0, A.slice(0, 40)); await s.setAsideTail(TID, V(1), 20); await s.close();
    fs.rmSync(path.join(tailsDir(t.dir), `${TID}.done`));              // the crash between the cut and the marker
    s = await open(t.dir);
    expect((await s.setAsideTail(TID, V(1), 20)).lines).toBe(20);
    expect(fs.existsSync(path.join(tailsDir(t.dir), `${TID}.done`))).toBe(true);   // the retry closes the window instead of leaving it open
    await s.close();
    fs.rmSync(path.join(tailsDir(t.dir), `${TID}.tail`));              // the one lost file
    s = await open(t.dir);
    await expect(s.tail(TID, V(1))).rejects.toMatchObject({ code: 'corrupt' });
    await expect(s.setAsideTail(TID, V(1), 20)).rejects.toMatchObject({ code: 'corrupt' });
    await expect(s.setAsideTail(TID, V(1), 20)).rejects.toMatchObject({ code: 'corrupt' });   // and again: still no empty tail
    expect(fs.existsSync(path.join(tailsDir(t.dir), `${TID}.tail`))).toBe(false);
    await s.close(); await t.cleanup();
  });
  it('a crash at EVERY disk operation, then the tail file lost, then retries: the tail is complete or its loss is reported; never a success with a short tail', async () => {
    const setup = async (root: string) => { const s = await open(root); await s.append(V(1), 0, 0, A.slice(0, 40)); await s.close(); };
    const probe = await tmpRoot('r6-b2c-'); await setup(probe.dir);
    const pf = new FaultFs(0); const ps = await open(probe.dir, opts, pf); const before = pf.ops; await ps.setAsideTail(TID, V(1), 20); const total = pf.ops - before; await ps.close(); await probe.cleanup();
    let reported = 0; let completed = 0;
    for (const lose of [false, true]) {
      for (const variant of [{ tear: false, powerLoss: false }, { tear: true, powerLoss: true }]) {
        for (let k = 1; k <= total + 12; k++) {
          const t = await tmpRoot('r6-b2d-'); await setup(t.dir);
          const shadow = fs.mkdtempSync(path.join(path.dirname(t.dir), 'shadow-'));
          const ff = new FaultFs(k, { ...variant, shadowDir: shadow });
          try { const s = await open(t.dir, opts, ff); await s.setAsideTail(TID, V(1), 20); } catch (e) { if (!(e instanceof InjectedCrash)) throw e; }
          await ff.applyPowerLoss();
          const lock = path.join(t.dir, 'LOCK'); if (fs.existsSync(lock)) fs.writeFileSync(lock, JSON.stringify({ ...JSON.parse(fs.readFileSync(lock, 'utf8')), pid: 2147483646, start: 'dead' }));
          const tp = path.join(tailsDir(t.dir), `${TID}.tail`);
          if (lose && fs.existsSync(tp)) fs.rmSync(tp);                   // one lost file after the crash
          const where = `kill at op ${k} ${JSON.stringify(variant)} lose=${lose}`;
          const s2 = await open(t.dir);
          for (let attempt = 0; attempt < 3; attempt++) {
            let ok: { lines: number } | null = null;
            try { ok = await s2.setAsideTail(TID, V(1), 20); } catch (e: any) { expect(e?.code, where).toBe('corrupt'); }
            if (ok) {
              // success is only allowed with a COMPLETE tail
              const tl = await s2.tail(TID, V(1)); expect(tl, where).not.toBeNull();
              expect(tl!.lines.length, where).toBe(20); for (let i = 0; i < 20; i++) expect(tl!.lines[i].equals(A[20 + i]), where).toBe(true);
              expect((await s2.head(V(1))).lines, where).toBe(20);
              if (attempt === 0) completed++;
            } else {
              // a loss is reported by tail() too, and the version still holds what it held (nothing more was cut)
              await expect(s2.tail(TID, V(1)), where).rejects.toMatchObject({ code: 'corrupt' });
              expect(fs.existsSync(tp), where).toBe(false);
              if (attempt === 0) reported++;
            }
          }
          await s2.close(); fs.rmSync(shadow, { recursive: true, force: true }); await t.cleanup();
        }
      }
    }
    expect(completed).toBeGreaterThan(0); expect(reported).toBeGreaterThan(0);   // both outcomes are really exercised
  }, 300_000);
});

describe('B3 the high-water mark is raised at HW_EVERY lines; the stated limit is exactly that', () => {
  it('one line at a time: line 255 past the record is NOT recorded, line 256 is (so up to 255 acknowledged lines can be rolled back unreported)', async () => {
    const t = await tmpRoot('r6-b3-');
    const s = await open(t.dir);
    const L = mk('h', HW_EVERY + 1);
    for (let i = 0; i < HW_EVERY - 1; i++) await s.append(V(1), 0, i, [L[i]]);
    expect((await readHw(realFs, t.dir, keyOf(V(1)))).st.value).toBeNull();                       // 255 lines acknowledged, nothing recorded
    await s.append(V(1), 0, HW_EVERY - 1, [L[HW_EVERY - 1]]);
    expect((await readHw(realFs, t.dir, keyOf(V(1)))).st.value?.count).toBe(HW_EVERY);             // the 256th raises it
    await s.close(); await t.cleanup();
  });
  it('one big call is recorded at its END, so after an acknowledged call the record is never more than 255 lines behind', async () => {
    const t = await tmpRoot('r6-b3b-');
    const s = await open(t.dir);
    await s.append(V(1), 0, 0, mk('g', 3 * HW_EVERY + 7));
    expect((await readHw(realFs, t.dir, keyOf(V(1)))).st.value?.count).toBe(3 * HW_EVERY + 7);
    await s.close(); await t.cleanup();
  });
});

describe('M7 a rolled-back head must not overwrite the high-water record it was compared with', () => {
  it('after a folder is put back and the old head is evicted, the record still states the NEWER head and its eviction state; the report stays across a reopen', async () => {
    const t = await tmpRoot('r6-m7-');
    const L = mk('m', 30);
    const evict = async (s: ChatStore, through: number) => { const h = (await s.hashAt(V(1), 0, through))!; return s.evictBody(V(1), { kind: 'holders-confirmed', version: keyOf(V(1)), through, hash: h, acks: [{ holder: 'p', version: keyOf(V(1)), lines: through, hash: h, signature: 's' }] } as any); };
    let s = await open(t.dir, { chunkBytes: 700, proofVerifier: () => true });
    await s.append(V(1), 0, 0, L.slice(0, 12)); await s.close();
    const snap = path.join(t.dir, '..', path.basename(t.dir) + '-snap'); fs.cpSync(vdir(t.dir), snap, { recursive: true });
    s = await open(t.dir, { chunkBytes: 700, proofVerifier: () => true });
    await s.append(V(1), 0, 12, L.slice(12)); await evict(s, 25); await s.close();                 // the record now says: 30 lines, 25 evicted
    expect((await readHw(realFs, t.dir, keyOf(V(1)))).st.value).toMatchObject({ count: 30, evLines: 25 });
    fs.rmSync(vdir(t.dir), { recursive: true }); fs.cpSync(snap, vdir(t.dir), { recursive: true });  // the folder as it was at 12 lines
    s = await open(t.dir, { chunkBytes: 700, proofVerifier: () => true });
    expect((await s.head(V(1))).rolledBack).toEqual({ from: 12, had: 30 });
    await evict(s, 5);                                                                               // an eviction on the rolled-back head writes the record (forced)
    const v = (await readHw(realFs, t.dir, keyOf(V(1)))).st.value;
    expect(v?.count).toBe(30); expect(v?.evLines).toBe(25);                                          // not lowered to the rolled-back folder's own 5
    await s.close();
    s = await open(t.dir, { chunkBytes: 700, proofVerifier: () => true });
    expect((await s.head(V(1))).rolledBack).toEqual({ from: 12, had: 30 });                          // still reported
    await s.close(); fs.rmSync(snap, { recursive: true }); await t.cleanup();
  });
});
