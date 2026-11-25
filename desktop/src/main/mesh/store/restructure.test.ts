// The restructure (docs/active/reviews/2026-11-24-mesh-store-code-review-8.md, Job B): a version folder is append-only in history, a takeover is a FORK into a new folder, a damaged version is
// RETIRED. Every scenario of reviews 6, 7 and 8 is ported here as "impossible or loud": the assertion is never "this one proof fired" but "no line is ever served that is not the truth".
// Synthetic data only; temp folders only.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatStore, deriveForkId } from './store';
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
const P = V(1); const C = V(2);
async function open(root: string, o: object = opts, fsx?: FaultFs): Promise<ChatStore> {
  const s = await ChatStore.open(root, { ...o, ...(fsx ? { fs: fsx } : {}) });
  await s.registerVersion(P, { chatId: CHAT, runtime: 'claude-code' });
  return s;
}
/** Every file of a folder as name -> sha256, for "the old version is not touched at all". scrub.json and summary.json are left out: they are progress hints that ANY load of a version may rewrite (they hold no line and no chain value). */
function digest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (!/^(scrub|summary)\.json$/.test(e.name)) out[path.relative(dir, p)] = createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } };
  walk(dir); return out;
}
type Outcome = 'correct' | 'flagged' | 'typed' | 'WRONG';
/** What a reader sees of version `v`: 'correct' (all `want` lines served, nothing flagged), 'flagged' (head reports damage / rollback, or fewer lines than want but reported), 'typed' (a typed error), 'WRONG' (a quiet wrong or quietly missing line: the failure). */
async function outcome(root: string, v: Buffer, want: Buffer[]): Promise<Outcome> {
  let s: ChatStore | null = null;
  try {
    s = await ChatStore.open(root, opts);
    const h = await s.head(v);
    // every line the store is willing to serve must be the truth; a line it refuses must be refused with a typed error
    let refused = false;
    for (let i = 0; i < h.lines; i++) {
      try { const r = await s.read(v, 0, i, i + 1); if (r === 'evicted' || i >= want.length || !r[0].equals(want[i])) return 'WRONG'; } catch (e: any) { if (e?.code !== 'corrupt') return 'WRONG'; refused = true; }
    }
    if (h.damagedFromLine !== null || h.rolledBack !== null || refused) return 'flagged';
    return h.lines === want.length ? 'correct' : 'WRONG';
  } catch (e: any) { return e?.code === 'damaged' || e?.code === 'corrupt' || e?.code === 'unknown-version' ? 'typed' : 'WRONG'; }
  finally { if (s) await s.close().catch(() => undefined); }
}
const unlock = (root: string): void => fs.rmSync(path.join(root, 'LOCK'), { force: true });

describe('forkVersion: a takeover builds a NEW folder and leaves the old one untouched', () => {
  it('copies lines [0, N) byte for byte, keeps the chain, and the new host continues; the old version keeps its own ending', async () => {
    const t = await tmpRoot('fork-');
    const s = await open(t.dir, { ...opts, chunkBytes: 900 });
    await s.append(P, 0, 0, A.slice(0, 30)); await s.close();
    const before = digest(vdir(t.dir));
    const s2 = await open(t.dir, { ...opts, chunkBytes: 900 });
    expect(await s2.forkVersion(P, 12, C)).toEqual({ lines: 12, created: true });
    expect(await s2.head(C)).toMatchObject({ lines: 12, hash: (await s2.head(P) && (await s2.hashAt(P, 0, 12))), damagedFromLine: null });
    expect(await s2.read(C, 0, 0, 12)).toEqual(A.slice(0, 12));
    expect((await s2.listVersions()).find((v) => v.version.equals(C))?.parent?.equals(P)).toBe(true);
    expect(await s2.append(C, 0, 12, B.slice(12, 30))).toBe('ok');
    expect(await s2.read(C, 0, 0, 30)).toEqual([...A.slice(0, 12), ...B.slice(12, 30)]);
    expect(await s2.read(P, 0, 0, 30)).toEqual(A.slice(0, 30));                               // the kept other ending
    await s2.close();
    expect(digest(vdir(t.dir))).toEqual(before);                                              // not one byte of the parent changed
    expect(await outcome(t.dir, C, [...A.slice(0, 12), ...B.slice(12, 30)])).toBe('correct');
    await t.cleanup();
  });
  it('the same continuation gives the same head hash on both versions (a fork is just a copy of the prefix)', async () => {
    const t = await tmpRoot('fork-same-');
    const s = await open(t.dir);
    await s.append(P, 0, 0, A.slice(0, 20));
    await s.forkVersion(P, 8, C); await s.append(C, 0, 8, A.slice(8, 20));
    expect((await s.head(C)).hash).toBe((await s.head(P)).hash);
    expect((await s.head(C)).conversationHash).toBe((await s.head(P)).conversationHash);
    await s.close(); await t.cleanup();
  });
  it('fork at 0 and at the head both work; many chunk files are copied', async () => {
    const t = await tmpRoot('fork-edge-');
    const s = await open(t.dir, { ...opts, chunkBytes: 400 });
    await s.append(P, 0, 0, A.slice(0, 25));
    await s.forkVersion(P, 0, V(3)); expect((await s.head(V(3))).lines).toBe(0);
    expect(await s.append(V(3), 0, 0, B.slice(0, 3))).toBe('ok');
    await s.forkVersion(P, 25, C); expect(await s.read(C, 0, 0, 25)).toEqual(A.slice(0, 25));
    expect(fs.readdirSync(vdir(t.dir, C)).filter((n) => n.startsWith('body-')).length).toBeGreaterThan(3);
    expect((await s.verify(C)).ok).toBe(true);
    await s.close(); await t.cleanup();
  });
  it('is idempotent; answers created:false even after the child grew; refuses an id used for another prefix or parent', async () => {
    const t = await tmpRoot('fork-idem-');
    const s = await open(t.dir);
    await s.append(P, 0, 0, A.slice(0, 20));
    await s.forkVersion(P, 10, C); await s.append(C, 0, 10, B.slice(10, 15));
    expect(await s.forkVersion(P, 10, C)).toEqual({ lines: 10, created: false });
    await expect(s.forkVersion(P, 11, C)).rejects.toMatchObject({ code: 'version-conflict' });   // same id, another cut point
    await s.registerVersion(V(3), { chatId: CHAT, runtime: 'claude-code' });
    await expect(s.forkVersion(V(3), 0, C)).rejects.toMatchObject({ code: 'version-conflict' });  // same id, another parent
    await expect(s.forkVersion(P, 3, P)).rejects.toMatchObject({ code: 'bad-argument' });
    await expect(s.forkVersion(P, 21, V(4))).rejects.toMatchObject({ code: 'bad-argument' });
    await s.close(); await t.cleanup();
  });
  it('refuses to copy from a parent that has evicted lines, or that is damaged below the cut', async () => {
    const t = await tmpRoot('fork-refuse-');
    const s = await open(t.dir);
    await s.append(P, 0, 0, A.slice(0, 20));
    const h = (await s.hashAt(P, 0, 5))!;
    await s.evictBody(P, { kind: 'holders-confirmed', version: keyOf(P), through: 5, hash: h, acks: [{ holder: 'p', version: keyOf(P), lines: 5, hash: h, signature: 's' }] } as any);
    await expect(s.forkVersion(P, 10, C)).rejects.toMatchObject({ code: 'evicted' });
    await s.restoreBody(P, A.slice(0, 5));
    const f = path.join(vdir(t.dir), 'body-0000000000000000.bin'); const b = fs.readFileSync(f); b[A[0].length * 3 + 5] ^= 0x40; fs.writeFileSync(f, b);   // rot in line 3
    await expect(s.forkVersion(P, 10, C)).rejects.toMatchObject({ code: 'corrupt' });
    expect(fs.existsSync(vdir(t.dir, C))).toBe(false);                                         // nothing half-made is visible
    expect(await s.forkVersion(P, 3, V(4))).toEqual({ lines: 3, created: true });                // the part below the rot is fine
    await s.close(); await t.cleanup();
  });
  it('deriveForkId: every device derives the same id for the same takeover, another takeover gets another', () => {
    const a = deriveForkId(P, 10, 'ab'.repeat(32), 'entry-1');
    expect(a).toEqual(deriveForkId(P, 10, 'ab'.repeat(32), 'entry-1'));
    expect(a.length).toBe(32);
    for (const other of [deriveForkId(V(9), 10, 'ab'.repeat(32), 'entry-1'), deriveForkId(P, 11, 'ab'.repeat(32), 'entry-1'), deriveForkId(P, 10, 'cd'.repeat(32), 'entry-1'), deriveForkId(P, 10, 'ab'.repeat(32), 'entry-2')]) expect(other.equals(a)).toBe(false);
  });
});

describe('forkVersion crash table: a crash at EVERY disk operation leaves nothing or a complete child, never a half-built one, and never touches the parent', () => {
  it('kill, torn write and power loss at each operation; the retry always ends complete', async () => {
    const setup = async (root: string) => { const s = await open(root, { ...opts, chunkBytes: 600 }); await s.append(P, 0, 0, A.slice(0, 30)); await s.close(); };
    const probe = await tmpRoot('fork-count-'); await setup(probe.dir);
    const pf = new FaultFs(0); const ps = await open(probe.dir, { ...opts, chunkBytes: 600 }, pf); const openOps = pf.ops; await ps.forkVersion(P, 20, C); const total = pf.ops; await ps.close(); await probe.cleanup();
    expect(total - openOps).toBeGreaterThan(10);
    let sawNone = 0; let sawComplete = 0;
    for (const variant of [{ tear: false, powerLoss: false }, { tear: true, powerLoss: true }]) {
      // the counter counts from the shim's creation, so it also covers the operations of open(); k below `openOps` crashes there, which must be harmless too
      for (let k = openOps - 2; k <= total + 12; k++) {
        const t = await tmpRoot('fork-crash-'); await setup(t.dir);
        const parentBefore = digest(vdir(t.dir));
        const shadow = fs.mkdtempSync(path.join(path.dirname(t.dir), 'shadow-'));
        const f2 = new FaultFs(k, { ...variant, shadowDir: shadow }); let crashed = false;
        try { const s = await open(t.dir, { ...opts, chunkBytes: 600 }, f2); await s.forkVersion(P, 20, C); }
        catch (e) { if (!(e instanceof InjectedCrash)) throw e; crashed = true; }
        await f2.applyPowerLoss();
        const where = `kill at op ${k} ${JSON.stringify(variant)} crashed=${crashed}`;
        unlock(t.dir);
        const s2 = await open(t.dir, { ...opts, chunkBytes: 600 });
        const listed = (await s2.listVersions()).filter((v) => v.version.equals(C));
        if (listed.length === 0) sawNone++; else { sawComplete++; expect(listed[0].damaged, where).toBeNull(); expect(listed[0].head!.lines, where).toBe(20); }
        // a plain crash never produces a flag or an error on either version
        expect((await s2.head(P)).damagedFromLine, where).toBeNull();
        expect((await s2.forkVersion(P, 20, C)).lines, where).toBe(20);                       // the retry (idempotent)
        expect(await s2.read(C, 0, 0, 20), where).toEqual(A.slice(0, 20));
        expect((await s2.head(C)).damagedFromLine, where).toBeNull();
        expect(await s2.append(C, 0, 20, B.slice(20, 25)), where).toBe('ok');
        await s2.close();
        expect(digest(vdir(t.dir)), where).toEqual(parentBefore);                              // the parent is byte-identical
        fs.rmSync(shadow, { recursive: true, force: true }); await t.cleanup();
      }
    }
    expect(sawNone).toBeGreaterThan(0); expect(sawComplete).toBeGreaterThan(0);                // both outcomes of the crash table really occurred
  }, 300_000);
});

describe('a damaged version is RETIRED: its id is never refilled, and files put back change nothing (review 8 F4, review 7 F2)', () => {
  const FILES = ['index.bin', 'checkpoint.bin', 'marks.bin', 'summary.json', 'scrub.json'];
  async function retiredFixture(how: 'asked' | 'found'): Promise<{ t: Awaited<ReturnType<typeof tmpRoot>>; pre: string }> {
    const t = await tmpRoot('retire-');
    let s = await open(t.dir);
    await s.append(P, 0, 0, A.slice(0, 20)); await s.append(P, 0, 50, A.slice(50, 53));           // 20 lines and a park waiting
    await s.close();
    const pre = path.join(path.dirname(t.dir), path.basename(t.dir) + '-pre'); fs.cpSync(vdir(t.dir), pre, { recursive: true });
    s = await open(t.dir);
    if (how === 'asked') { await s.setAsideDamaged(P); }
    else {
      await s.close();
      fs.truncateSync(path.join(vdir(t.dir), 'index.bin'), 5); fs.unlinkSync(path.join(vdir(t.dir), 'checkpoint.bin'));
      s = await ChatStore.open(t.dir, opts);
      await expect(s.head(P)).rejects.toMatchObject({ code: 'damaged' });
    }
    await s.close();
    return { t, pre };
  }
  for (const how of ['asked', 'found'] as const) {
    it(`after a set-aside ${how}: nothing is served, appended or registered under that id, and the aside copy is kept`, async () => {
      const { t, pre } = await retiredFixture(how);
      const s = await ChatStore.open(t.dir, opts);
      await expect(s.head(P)).rejects.toMatchObject({ code: 'damaged' });
      await expect(s.append(P, 0, 0, A.slice(0, 3))).rejects.toMatchObject({ code: 'damaged' });
      await expect(s.registerVersion(P, { chatId: CHAT, runtime: 'claude-code' })).rejects.toMatchObject({ code: 'damaged' });
      await expect(s.forkVersion(P, 0, C)).rejects.toMatchObject({ code: 'damaged' });
      expect((await s.listVersions()).find((v) => v.version.equals(P))?.damaged).toMatch(/-q?1$/);
      expect((await s.setAsideDamaged(P)).asideName).toMatch(/-q?1$/);                               // idempotent: the same answer, nothing new
      expect(fs.readdirSync(path.join(t.dir, 'aside')).length).toBe(1);
      await s.close(); fs.rmSync(pre, { recursive: true }); await t.cleanup();
    });
    it(`after a set-aside ${how}: the PRE-quarantine files put back (any one, any pair, all of them) change nothing: still retired (review 8 F4)`, async () => {
      for (const subset of [[], [0], [1], [2], [3], [0, 1], [0, 3], [1, 3], [0, 1, 2], [0, 1, 2, 3, 4]]) {
        const { t, pre } = await retiredFixture(how);
        for (const i of subset) if (fs.existsSync(path.join(pre, FILES[i]))) fs.copyFileSync(path.join(pre, FILES[i]), path.join(vdir(t.dir), FILES[i]));
        if (subset.length > 2) for (const n of fs.readdirSync(pre)) if (/^body-/.test(n)) fs.copyFileSync(path.join(pre, n), path.join(vdir(t.dir), n));   // the bodies too: the whole pre-quarantine state
        expect(await outcome(t.dir, P, A.slice(0, 20)), `${how} ${subset}`).toBe('typed');
        fs.rmSync(pre, { recursive: true }); await t.cleanup();
      }
    });
    it(`after a set-aside ${how}: losing the aside folder alone, or retired.json alone, still leaves the id retired (two witnesses)`, async () => {
      const a = await retiredFixture(how);
      fs.rmSync(path.join(a.t.dir, 'aside'), { recursive: true });
      expect(await outcome(a.t.dir, P, A.slice(0, 20))).toBe('typed');
      const sa = await ChatStore.open(a.t.dir, opts);                                                  // retired.json alone still says so: never an empty, refillable version
      await expect(sa.append(P, 0, 0, A.slice(0, 3))).rejects.toMatchObject({ code: 'damaged' });
      await expect(sa.head(P)).rejects.toMatchObject({ code: 'damaged' });
      await sa.close();
      fs.rmSync(a.pre, { recursive: true }); await a.t.cleanup();
      const b = await retiredFixture(how);
      fs.rmSync(path.join(vdir(b.t.dir), 'retired.json'));
      expect(await outcome(b.t.dir, P, A.slice(0, 20))).toBe('typed');
      fs.rmSync(b.pre, { recursive: true }); await b.t.cleanup();
    });
    it(`after a set-aside ${how}: a retention job that removes the aside folder AND the retired version folder cannot bring the id back (store-root record, review 9 F3)`, async () => {
      const { t, pre } = await retiredFixture(how);
      fs.rmSync(path.join(t.dir, 'aside'), { recursive: true }); fs.rmSync(vdir(t.dir), { recursive: true });
      const s = await ChatStore.open(t.dir, opts);
      await expect(s.registerVersion(P, { chatId: CHAT, runtime: 'claude-code' })).rejects.toMatchObject({ code: 'damaged' });   // not a fresh empty version under the old id
      await expect(s.append(P, 0, 0, A.slice(0, 3))).rejects.toMatchObject({ code: 'damaged' });
      await s.close(); fs.rmSync(pre, { recursive: true }); await t.cleanup();
    });
    it(`after a set-aside ${how}: a park that waited for the old id never reaches the recopy under the NEW id (review 7 F2)`, async () => {
      const { t, pre } = await retiredFixture(how);
      const s = await ChatStore.open(t.dir, opts);
      await s.registerVersion(C, { chatId: CHAT, runtime: 'claude-code' });
      expect(await s.append(C, 0, 0, B.slice(0, 50))).toBe('ok');                                    // a DIFFERENT history up to the old park's position
      expect(await s.append(C, 0, 50, B.slice(50, 53))).toBe('ok');
      expect(await s.read(C, 0, 0, 53)).toEqual(B.slice(0, 53));
      expect(await s.parkedList(C)).toEqual([]);
      expect(fs.existsSync(path.join(vdir(t.dir), 'parked'))).toBe(true);                             // the old park is kept where it was, never read again
      await s.close(); fs.rmSync(pre, { recursive: true }); await t.cleanup();
    });
  }
  it('a crash at EVERY disk operation of a set-aside: the id is retired or it is whole; never half-moved and served', async () => {
    const setup = async (root: string) => { const s = await open(root, { ...opts, chunkBytes: 500 }); await s.append(P, 0, 0, A.slice(0, 25)); await s.close(); };
    const probe = await tmpRoot('retire-count-'); await setup(probe.dir);
    const pf = new FaultFs(0); const ps = await open(probe.dir, { ...opts, chunkBytes: 500 }, pf); const openOps = pf.ops; await ps.setAsideDamaged(P); const total = pf.ops; await ps.close(); await probe.cleanup();
    let retired = 0; let whole = 0;
    for (const variant of [{ tear: false, powerLoss: false }, { tear: true, powerLoss: true }]) {
      for (let k = openOps - 2; k <= total + 10; k++) {
        const t = await tmpRoot('retire-crash-'); await setup(t.dir);
        const shadow = fs.mkdtempSync(path.join(path.dirname(t.dir), 'shadow-')); const f2 = new FaultFs(k, { ...variant, shadowDir: shadow });
        try { const s = await open(t.dir, { ...opts, chunkBytes: 500 }, f2); await s.setAsideDamaged(P); } catch (e) { if (!(e instanceof InjectedCrash)) throw e; }
        await f2.applyPowerLoss(); unlock(t.dir);
        const o = await outcome(t.dir, P, A.slice(0, 25));
        expect(['correct', 'typed'], `op ${k} ${JSON.stringify(variant)}: ${o}`).toContain(o);
        if (o === 'typed') retired++; else whole++;
        // whichever it is, asking again always ends retired
        const s2 = await ChatStore.open(t.dir, opts); await s2.setAsideDamaged(P); await s2.close();
        expect(await outcome(t.dir, P, A.slice(0, 25))).toBe('typed');
        fs.rmSync(shadow, { recursive: true, force: true }); await t.cleanup();
      }
    }
    expect(retired).toBeGreaterThan(0); expect(whole).toBeGreaterThan(0);
  }, 300_000);
});

describe('parks belong to ONE version id', () => {
  it('a park waiting for the parent stays with the parent through a fork, and drains into the parent only', async () => {
    const t = await tmpRoot('park-fork-');
    const s = await open(t.dir);
    await s.append(P, 0, 0, A.slice(0, 20)); await s.append(P, 0, 25, A.slice(25, 28));
    await s.forkVersion(P, 20, C);
    expect(await s.append(C, 0, 20, B.slice(20, 30))).toBe('ok');                                      // the new host passes the park's position with other lines
    expect(await s.parkedList(C)).toEqual([]); expect((await s.head(C)).rejectedParks).toBe(0);
    expect(await s.append(P, 0, 20, A.slice(20, 25))).toBe('ok');                                      // the old version's gap fills: its own park drains
    expect((await s.head(P)).lines).toBe(28);
    expect(await s.read(P, 0, 0, 28)).toEqual(A.slice(0, 28));
    expect(await s.read(C, 0, 0, 30)).toEqual([...A.slice(0, 20), ...B.slice(20, 30)]);
    await s.close(); await t.cleanup();
  });
  it('a park that contradicts the head is rejected with the reason `conflict`; head() counts it', async () => {
    const t = await tmpRoot('park-conflict-');
    const s = await open(t.dir);
    await s.append(P, 0, 0, A.slice(0, 10)); await s.append(P, 0, 12, A.slice(12, 14));
    expect((await s.head(P)).rejectedParks).toBe(0);
    await s.append(P, 0, 10, B.slice(10, 14));
    expect((await s.rejectedList(P)).map((r) => r.reason)).toEqual(['conflict']);
    expect((await s.head(P)).rejectedParks).toBe(1);
    await s.close(); await t.cleanup();
  });
  it('rejected/ full: park() refuses the new park with a typed error and overwrites NOTHING', async () => {
    const t = await tmpRoot('park-full-');
    const s = await open(t.dir, { ...opts, maxRejectedBytes: 1 });
    await s.append(P, 0, 0, A.slice(0, 10)); await s.append(P, 0, 20, A.slice(20, 23));
    const pf = path.join(vdir(t.dir), 'parked'); const [name] = fs.readdirSync(pf);
    const b = fs.readFileSync(path.join(pf, name)); b[b.length - 9] ^= 1; fs.writeFileSync(path.join(pf, name), b);   // the parked copy rots; the same lines are sent again
    await expect(s.append(P, 0, 20, A.slice(20, 23))).rejects.toMatchObject({ code: 'limit' });
    expect(fs.readFileSync(path.join(pf, name)).equals(b)).toBe(true);
    await s.close(); await t.cleanup();
  });
  it('a park put under another park\'s name, or sealed for another version, is rejected as damaged, never applied', async () => {
    const t = await tmpRoot('park-swap-');
    const s = await open(t.dir);
    await s.registerVersion(C, { chatId: CHAT, runtime: 'claude-code' });
    await s.append(P, 0, 5, A.slice(5, 8)); await s.append(C, 0, 5, B.slice(5, 8));
    const pf = path.join(vdir(t.dir), 'parked'); const cf = path.join(vdir(t.dir, C), 'parked');
    fs.copyFileSync(path.join(cf, fs.readdirSync(cf)[0]), path.join(pf, fs.readdirSync(pf)[0]));      // C's park overwrites P's park of the same name
    await s.close();
    const s2 = await ChatStore.open(t.dir, opts);
    expect(await s2.append(P, 0, 0, A.slice(0, 5))).toBe('ok');
    expect((await s2.head(P)).lines).toBe(5);                                                          // the foreign park did NOT drain
    expect((await s2.rejectedList(P)).map((r) => r.reason)).toEqual(['damaged']);
    await s2.close(); await t.cleanup();
  });
});

describe('older copies of a version\'s files are PREFIX-STATES: never different lines (reviews 6, 7, 8)', () => {
  const FILESETS: Record<string, string[]> = { index: ['index.bin'], checkpoint: ['checkpoint.bin'], body: ['body'], 'index+checkpoint': ['index.bin', 'checkpoint.bin'], 'index+body': ['index.bin', 'body'], 'checkpoint+body': ['checkpoint.bin', 'body'], 'index+checkpoint+body': ['index.bin', 'checkpoint.bin', 'body'] };
  const pick = (names: string[], kinds: string[]) => names.filter((n) => kinds.some((k) => (k === 'body' ? /^body-/.test(n) : n === k)));
  for (const [label, kinds] of Object.entries(FILESETS)) {
    it(`after a takeover: older ${label} of the CHILD put back (child 12 -> 20 lines): every line served is true, a shorter head is reported`, async () => {
      const t = await tmpRoot('older-');
      let s = await open(t.dir); await s.append(P, 0, 0, A.slice(0, 10)); await s.forkVersion(P, 10, C); await s.append(C, 0, 10, B.slice(10, 12)); await s.close();
      const snap = path.join(path.dirname(t.dir), path.basename(t.dir) + '-snap'); fs.cpSync(vdir(t.dir, C), snap, { recursive: true });
      s = await ChatStore.open(t.dir, opts); await s.append(C, 0, 12, B.slice(12, 20)); await s.close();
      for (const n of pick(fs.readdirSync(snap), kinds)) fs.copyFileSync(path.join(snap, n), path.join(vdir(t.dir, C), n));
      const o = await outcome(t.dir, C, [...A.slice(0, 10), ...B.slice(10, 20)]);
      expect(['correct', 'flagged', 'typed'], label).toContain(o);                                     // never WRONG
      fs.rmSync(snap, { recursive: true }); await t.cleanup();
    });
    it(`a takeover while older ${label} of the PARENT come back (the reviewer's 29/35 case): the parent reports a rollback, the child is untouched`, async () => {
      const t = await tmpRoot('older-parent-');
      let s = await open(t.dir); await s.append(P, 0, 0, A.slice(0, 29)); await s.close();
      const snap = path.join(path.dirname(t.dir), path.basename(t.dir) + '-snap'); fs.cpSync(vdir(t.dir), snap, { recursive: true });
      s = await ChatStore.open(t.dir, opts); await s.append(P, 0, 29, A.slice(29, 35)); await s.forkVersion(P, 23, C); await s.append(C, 0, 23, B.slice(23, 27)); await s.close();
      for (const n of pick(fs.readdirSync(snap), kinds)) fs.copyFileSync(path.join(snap, n), path.join(vdir(t.dir), n));
      expect(['correct', 'flagged', 'typed'], label).toContain(await outcome(t.dir, P, A.slice(0, 35)));
      expect(await outcome(t.dir, C, [...A.slice(0, 23), ...B.slice(23, 27)]), label).toBe('correct');
      fs.rmSync(snap, { recursive: true }); await t.cleanup();
    });
  }
  it('the whole version folder put back (the high-water record outside it is NOT put back): reported as rolled back, no wrong line', async () => {
    const t = await tmpRoot('older-whole-');
    let s = await open(t.dir); await s.append(P, 0, 0, A.slice(0, 15)); await s.close();
    const snap = path.join(path.dirname(t.dir), path.basename(t.dir) + '-snap'); fs.cpSync(vdir(t.dir), snap, { recursive: true });
    s = await ChatStore.open(t.dir, opts); await s.append(P, 0, 15, A.slice(15, 30)); await s.close();
    fs.rmSync(vdir(t.dir), { recursive: true }); fs.cpSync(snap, vdir(t.dir), { recursive: true });
    expect(await outcome(t.dir, P, A.slice(0, 30))).toBe('flagged');
    fs.rmSync(snap, { recursive: true }); await t.cleanup();
  });
  it('the loss of ANY single file of a forked child or its parent is never a quiet wrong line', async () => {
    const t = await tmpRoot('lose-');
    let s = await open(t.dir, { ...opts, chunkBytes: 700 }); await s.append(P, 0, 0, A.slice(0, 20)); await s.forkVersion(P, 12, C); await s.append(C, 0, 12, B.slice(12, 20)); await s.close();
    const base = path.join(path.dirname(t.dir), path.basename(t.dir) + '-base'); fs.cpSync(t.dir, base, { recursive: true });
    const walk = (d: string, out: string[] = []): string[] => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; };
    for (const file of walk(path.join(base, 'versions'))) {
      fs.rmSync(t.dir, { recursive: true }); fs.cpSync(base, t.dir, { recursive: true });
      fs.rmSync(path.join(t.dir, path.relative(base, file)));
      for (const [v, want] of [[P, A.slice(0, 20)], [C, [...A.slice(0, 12), ...B.slice(12, 20)]]] as [Buffer, Buffer[]][]) expect(['correct', 'flagged', 'typed'], `${path.relative(base, file)} ${v.toString('hex')}`).toContain(await outcome(t.dir, v, want));
    }
    fs.rmSync(base, { recursive: true }); await t.cleanup();
  });
});

describe('read() never serves a line the store reports as suspect (review 8 F3)', () => {
  it('once the scrub flags a rotted line, a read that includes it throws `corrupt`; lines after it are still served, each checked against its own chain value', async () => {
    const t = await tmpRoot('suspect-');
    const s = await open(t.dir);
    await s.append(P, 0, 0, A.slice(0, 20)); await s.close();
    const f = path.join(vdir(t.dir), 'body-0000000000000000.bin'); const b = fs.readFileSync(f); b[A[0].length * 4 + 7] ^= 0x40; fs.writeFileSync(f, b);   // rot in line 4
    const s2 = await ChatStore.open(t.dir, opts);
    await s2.scrubStep(P);
    expect((await s2.head(P)).damagedFromLine).toBe(4);
    expect(await s2.read(P, 0, 0, 4)).toEqual(A.slice(0, 4));                                          // below the damage: served
    await expect(s2.read(P, 0, 4, 5)).rejects.toMatchObject({ code: 'corrupt' });                      // the flagged line itself
    await expect(s2.read(P, 0, 0, 20)).rejects.toMatchObject({ code: 'corrupt' });                     // a range that includes it
    expect(await s2.read(P, 0, 10, 11)).toEqual(A.slice(10, 11));                                      // later lines are chain-checked one by one and are the truth
    fs.writeFileSync(f, fs.readFileSync(f).map((x, i) => (i === A[0].length * 4 + 7 ? x ^ 0x40 : x)));  // the byte is repaired behind the store's back: the line verifies again, but the store still reports it
    expect((await s2.head(P)).damagedFromLine).toBe(4);
    await expect(s2.read(P, 0, 4, 5)).rejects.toMatchObject({ code: 'corrupt' });                      // what the head reports is never served, whatever the bytes say
    await s2.append(P, 0, 0, A.slice(0, 8));                                                           // a correct resend heals it
    expect((await s2.head(P)).damagedFromLine).toBeNull();
    expect(await s2.read(P, 0, 0, 20)).toEqual(A.slice(0, 20));
    await s2.close(); await t.cleanup();
  });
});

describe('the high-water record (unchanged by the restructure)', () => {
  it('review 9 window: the record is raised at the end of EVERY acknowledged append call (the unreported rollback window is only the call in flight)', async () => {
    const t = await tmpRoot('hw-b3-');
    const s = await open(t.dir);
    const L = mk('h', 40);
    expect(HW_EVERY).toBe(1);
    for (let i = 0; i < 30; i++) { await s.append(P, 0, i, [L[i]]); expect((await readHw(realFs, t.dir, keyOf(P))).st.value?.count, `after call ${i}`).toBe(i + 1); }
    await s.append(P, 0, 30, L.slice(30, 37));                                                      // one call of several lines: recorded at its END
    expect((await readHw(realFs, t.dir, keyOf(P))).st.value?.count).toBe(37);
    // the points the record keeps stay SPREAD over the history (not just the last few), so a head far behind is compared with a point near it
    for (let i = 37; i < 70; i++) await s.append(P, 0, i, [A[i]]);
    const ladder = (await readHw(realFs, t.dir, keyOf(P))).st.value!.ladder.map((x) => x[0]);
    expect(ladder.length).toBeLessThanOrEqual(12); expect(ladder[0]).toBe(0); expect(ladder[ladder.length - 1]).toBe(70);
    expect(ladder.filter((n) => n > 0 && n < 35).length, `points ${ladder}`).toBeGreaterThan(0);
    await s.close(); await t.cleanup();
    // so an older folder put back is REPORTED even when it is only ONE acknowledged call behind
    const t2 = await tmpRoot('hw-b3b-'); let s2 = await open(t2.dir);
    await s2.append(P, 0, 0, A.slice(0, 10)); await s2.close();
    const snap = path.join(path.dirname(t2.dir), path.basename(t2.dir) + '-snap'); fs.cpSync(vdir(t2.dir), snap, { recursive: true });
    s2 = await ChatStore.open(t2.dir, opts); await s2.append(P, 0, 10, A.slice(10, 11));             // ONE more line, never closed cleanly
    fs.rmSync(path.join(t2.dir, 'LOCK'), { force: true });
    fs.rmSync(vdir(t2.dir), { recursive: true }); fs.cpSync(snap, vdir(t2.dir), { recursive: true }); fs.rmSync(snap, { recursive: true });
    const s3 = await ChatStore.open(t2.dir, opts);
    expect((await s3.head(P)).rolledBack).toEqual({ from: 10, had: 11 }); await s3.close();
    await t2.cleanup();
  });
  it('M7: a rolled-back head does not overwrite the record it was compared with; the report stays across a reopen', async () => {
    const t = await tmpRoot('hw-m7-');
    const L = mk('m', 30);
    const evict = async (s: ChatStore, through: number) => { const h = (await s.hashAt(P, 0, through))!; return s.evictBody(P, { kind: 'holders-confirmed', version: keyOf(P), through, hash: h, acks: [{ holder: 'p', version: keyOf(P), lines: through, hash: h, signature: 's' }] } as any); };
    let s = await open(t.dir, { chunkBytes: 700, proofVerifier: () => true });
    await s.append(P, 0, 0, L.slice(0, 12)); await s.close();
    const snap = path.join(t.dir, '..', path.basename(t.dir) + '-snap'); fs.cpSync(vdir(t.dir), snap, { recursive: true });
    s = await open(t.dir, { chunkBytes: 700, proofVerifier: () => true });
    await s.append(P, 0, 12, L.slice(12)); await evict(s, 25); await s.close();
    expect((await readHw(realFs, t.dir, keyOf(P))).st.value).toMatchObject({ count: 30, evLines: 25 });
    fs.rmSync(vdir(t.dir), { recursive: true }); fs.cpSync(snap, vdir(t.dir), { recursive: true });
    s = await open(t.dir, { chunkBytes: 700, proofVerifier: () => true });
    expect((await s.head(P)).rolledBack).toEqual({ from: 12, had: 30 });
    await evict(s, 5);
    const v = (await readHw(realFs, t.dir, keyOf(P))).st.value;
    expect(v?.count).toBe(30); expect(v?.evLines).toBe(25);
    await s.close();
    s = await open(t.dir, { chunkBytes: 700, proofVerifier: () => true });
    expect((await s.head(P)).rolledBack).toEqual({ from: 12, had: 30 });
    await s.close(); fs.rmSync(snap, { recursive: true }); await t.cleanup();
  });
});

describe('a stopped fork leaves only an invisible work folder, cleared at the next open', () => {
  it('leftover files in forks/<child> are never listed or served, are removed at open, and a retry still builds the child', async () => {
    const t = await tmpRoot('fork-left-');
    let s = await open(t.dir); await s.append(P, 0, 0, A.slice(0, 12)); await s.close();
    const work = path.join(t.dir, 'forks', keyOf(C)); fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'index.bin'), Buffer.from('half built')); fs.writeFileSync(path.join(work, 'body-0000000000000000.bin'), Buffer.from('junk'));
    s = await open(t.dir);
    expect(fs.readdirSync(work)).toEqual([]);                                                       // swept at open
    expect((await s.listVersions()).some((v) => v.version.equals(C))).toBe(false);                   // never shown
    await expect(s.head(C)).rejects.toMatchObject({ code: 'unknown-version' });
    expect(await s.forkVersion(P, 12, C)).toEqual({ lines: 12, created: true });
    expect(await s.read(C, 0, 0, 12)).toEqual(A.slice(0, 12));
    await s.close(); await t.cleanup();
  });
});

describe('review 9 F1: a park never supplies a line at a position that was ever acknowledged', () => {
  /** probe7 of review 9: true lines 0..9, a park of OTHER lines at 12..14, a snapshot of the folder, true lines 10..39 acknowledged, the snapshot put back (the high-water record says 40). */
  async function rolledBackWithConflictPark(t: Awaited<ReturnType<typeof tmpRoot>>): Promise<void> {
    const Y = mk('Y', 3);
    let s = await open(t.dir);
    await s.append(P, 0, 0, A.slice(0, 10)); await s.append(P, 0, 12, Y); await s.close();
    const snap = path.join(path.dirname(t.dir), path.basename(t.dir) + '-snap'); fs.cpSync(vdir(t.dir), snap, { recursive: true });
    s = await ChatStore.open(t.dir, opts); await s.append(P, 0, 10, A.slice(10, 40)); await s.close();
    fs.rmSync(vdir(t.dir), { recursive: true }); fs.cpSync(snap, vdir(t.dir), { recursive: true }); fs.rmSync(snap, { recursive: true });
  }
  it('the park is NOT applied while the head is below the recorded head; a resend of the true lines is accepted; no line is ever wrong', async () => {
    const t = await tmpRoot('f1-');
    await rolledBackWithConflictPark(t);
    const s = await ChatStore.open(t.dir, opts);
    expect((await s.head(P)).rolledBack).toEqual({ from: 10, had: 40 });
    expect(await s.append(P, 0, 10, A.slice(10, 12))).toBe('ok');                                  // the head reaches the park's start: the park must wait
    expect((await s.head(P)).lines).toBe(12);
    expect(await s.append(P, 0, 12, A.slice(12, 40))).toBe('ok');                                  // the true lines are accepted (the old store answered not-a-prefix forever)
    expect((await s.head(P))).toMatchObject({ lines: 40, rolledBack: null, damagedFromLine: null });
    expect(await s.read(P, 0, 0, 40)).toEqual(A.slice(0, 40));
    await s.close(); await t.cleanup();
  });
  it('while the rollback is reported EVERY line from its start is refused, not only the first (refilled lines are unproven until the recorded head is reached)', async () => {
    const t = await tmpRoot('f1-read-');
    await rolledBackWithConflictPark(t);
    const s = await ChatStore.open(t.dir, opts);
    await s.append(P, 0, 10, A.slice(10, 20));
    expect(await s.read(P, 0, 0, 10)).toEqual(A.slice(0, 10));                                     // below the rollback point: served
    for (const [a, b] of [[10, 11], [15, 16], [12, 20], [0, 20]]) await expect(s.read(P, 0, a, b)).rejects.toMatchObject({ code: 'corrupt' });
    await s.append(P, 0, 20, A.slice(20, 40));
    expect(await s.read(P, 0, 0, 40)).toEqual(A.slice(0, 40));                                     // the recorded head is reached with the recorded chain value: all served again
    await s.close(); await t.cleanup();
  });
  it('lines that refill the rolled-back range with DIFFERENT content are caught at the recorded head: the version is retired, never served', async () => {
    const t = await tmpRoot('f1-diff-');
    await rolledBackWithConflictPark(t);
    const s = await ChatStore.open(t.dir, opts);
    await expect(s.append(P, 0, 10, B.slice(10, 40))).rejects.toMatchObject({ code: 'damaged' });
    await expect(s.head(P)).rejects.toMatchObject({ code: 'damaged' });
    expect(fs.readdirSync(path.join(t.dir, 'aside')).length).toBe(1);                              // kept, not deleted
    await s.close(); await t.cleanup();
  });
  it('the same holds for lines a rebuild set aside (the partial marker): a park cannot fill them, and the old chain value is checked when the head gets back', async () => {
    const t = await tmpRoot('f1-partial-');
    let s = await open(t.dir, { ...opts, chunkBytes: 700 }); await s.append(P, 0, 0, A.slice(0, 30)); await s.close();
    // the index and bodies come back SHORTER than the checkpoint (an older pair put back): the rebuild reports lines 12..29 as set aside
    const v = vdir(t.dir); const cut = A.slice(0, 12).reduce((n, l) => n + l.length, 0);
    fs.truncateSync(path.join(v, 'index.bin'), 36 + 116 * 12);
    for (const n of fs.readdirSync(v)) { const m = /^body-([0-9a-f]{16})\.bin$/.exec(n); if (!m) continue; const at = parseInt(m[1], 16); if (at >= cut) fs.unlinkSync(path.join(v, n)); else if (fs.statSync(path.join(v, n)).size > cut - at) fs.truncateSync(path.join(v, n), cut - at); }
    fs.rmSync(path.join(t.dir, 'highwater'), { recursive: true, force: true });                     // so only the partial marker knows
    s = await ChatStore.open(t.dir, { ...opts, chunkBytes: 700 }); await s.registerVersion(P, { chatId: CHAT, runtime: 'claude-code' });
    expect((await s.head(P)).damagedFromLine).toBe(12);
    await s.append(P, 0, 14, mk('Z', 3));                                                          // a park at 14 with other lines
    expect(await s.append(P, 0, 12, A.slice(12, 14))).toBe('ok');                                  // the head reaches the park's start: it must wait
    await expect(s.read(P, 0, 13, 14)).rejects.toMatchObject({ code: 'corrupt' });
    await expect(s.append(P, 0, 14, B.slice(14, 30))).rejects.toMatchObject({ code: 'damaged' });  // other lines at the acknowledged positions: caught where the old chain value is known
    await s.close(); await t.cleanup();
  });
});

describe('review 9 F5: lines whose bodies are on disk are not reported evicted because an older checkpoint remembers an eviction a restore had undone', () => {
  const ev = async (s: ChatStore, through: number): Promise<void> => { const h = (await s.hashAt(P, 0, through))!; await s.evictBody(P, { kind: 'holders-confirmed', version: keyOf(P), through, hash: h, acks: [{ holder: 'p', version: keyOf(P), lines: through, hash: h, signature: 's' }] } as any); };
  for (const lose of ['nothing']) {
    // (with the high-water record ALSO lost nothing says the restore happened, and a chat in one chunk file looks exactly like a genuine eviction: two faults, not promised)
    it(`older checkpoint after evict then restore (${lose} lost as well): the present lines are served`, async () => {
      const t = await tmpRoot('f5-');
      let s = await open(t.dir, { ...opts, chunkBytes: 700 }); await s.append(P, 0, 0, A.slice(0, 40)); await ev(s, 25);
      const ck = path.join(vdir(t.dir), 'checkpoint.bin'); const old = fs.readFileSync(ck);
      await s.restoreBody(P, A.slice(0, 25)); expect((await s.head(P)).evictedLines).toBe(0); await s.close();
      fs.writeFileSync(ck, old);                                                                     // the older statement: 25 lines evicted
      if (lose === 'the high-water record') fs.rmSync(path.join(t.dir, 'highwater'), { recursive: true, force: true });
      s = await ChatStore.open(t.dir, { ...opts, chunkBytes: 700 }); await s.registerVersion(P, { chatId: CHAT, runtime: 'claude-code' });
      const h = await s.head(P);
      expect(h.evictedLines).toBe(0);                                                                // the bodies are here: nothing is evicted
      expect(await s.read(P, 0, 0, 40)).toEqual(A.slice(0, 40));
      await s.close(); await t.cleanup();
    });
  }
});

describe('review 9 F5, as the fuzz finds it: older index+checkpoint put back after a restore', () => {
  it('the older pair says 11 lines evicted, the restored bodies are on disk and the record outside the folder says none: nothing is reported evicted', async () => {
    const t = await tmpRoot('f5b-');
    let s = await open(t.dir, { ...opts, chunkBytes: 700 }); await s.append(P, 0, 0, A.slice(0, 40));
    const h = (await s.hashAt(P, 0, 11))!; await s.evictBody(P, { kind: 'holders-confirmed', version: keyOf(P), through: 11, hash: h, acks: [{ holder: 'p', version: keyOf(P), lines: 11, hash: h, signature: 's' }] } as any);
    await s.close();
    const v = vdir(t.dir); const old = { ix: fs.readFileSync(path.join(v, 'index.bin')), ck: fs.readFileSync(path.join(v, 'checkpoint.bin')) };
    s = await ChatStore.open(t.dir, { ...opts, chunkBytes: 700 }); await s.restoreBody(P, A.slice(0, 11)); await s.append(P, 0, 40, A.slice(40, 60)); await s.close();
    fs.writeFileSync(path.join(v, 'index.bin'), old.ix); fs.writeFileSync(path.join(v, 'checkpoint.bin'), old.ck);
    s = await ChatStore.open(t.dir, { ...opts, chunkBytes: 700 }); await s.registerVersion(P, { chatId: CHAT, runtime: 'claude-code' });
    const hd = await s.head(P);
    expect(hd.evictedLines).toBe(0);
    await s.close(); await t.cleanup();
  });
});

describe('review 9 F5, the cause the fuzz found: a restore on a rolled-back head states "nothing evicted" in the record too', () => {
  it('older index+checkpoint (eviction in force) put back, restore while the rollback is reported, the same older pair put back again: the lines are served, not evicted', async () => {
    const t = await tmpRoot('f5c-');
    const v = vdir(t.dir); const o = { ...opts, chunkBytes: 700 };
    let s = await open(t.dir, o); await s.append(P, 0, 0, A.slice(0, 20));
    const h = (await s.hashAt(P, 0, 11))!; await s.evictBody(P, { kind: 'holders-confirmed', version: keyOf(P), through: 11, hash: h, acks: [{ holder: 'p', version: keyOf(P), lines: 11, hash: h, signature: 's' }] } as any); await s.close();
    const old = { ix: fs.readFileSync(path.join(v, 'index.bin')), ck: fs.readFileSync(path.join(v, 'checkpoint.bin')) };     // 20 lines, 11 evicted
    s = await ChatStore.open(t.dir, o); await s.append(P, 0, 20, A.slice(20, 40)); await s.close();                        // the record now says 40 lines, 11 evicted
    fs.writeFileSync(path.join(v, 'index.bin'), old.ix); fs.writeFileSync(path.join(v, 'checkpoint.bin'), old.ck);        // the older pair: the head is behind the record
    s = await ChatStore.open(t.dir, o); expect((await s.head(P)).rolledBack).not.toBeNull(); expect((await s.head(P)).evictedLines).toBe(11);
    await s.restoreBody(P, A.slice(0, 11)); expect((await s.head(P)).evictedLines).toBe(0); await s.close();            // restored while the rollback is reported
    expect((await readHw(realFs, t.dir, keyOf(P))).st.value).toMatchObject({ count: 40, evLines: 0 });                    // and the record outside the folder says so too
    fs.writeFileSync(path.join(v, 'index.bin'), old.ix); fs.writeFileSync(path.join(v, 'checkpoint.bin'), old.ck);        // the older statement again: it still records the eviction
    s = await ChatStore.open(t.dir, o);
    expect((await s.head(P)).evictedLines).toBe(0);
    await s.close(); await t.cleanup();
  });
});

describe('the store-root retirement folder', () => {
  it('a half-written record (a temp file) in retired/ is swept at open, and the id keeps its answer', async () => {
    const t = await tmpRoot('retired-tmp-');
    let s = await open(t.dir); await s.append(P, 0, 0, A.slice(0, 5)); await s.setAsideDamaged(P); await s.close();
    const tmp = path.join(t.dir, 'retired', `${keyOf(P)}.ret.tmp-1-1`); fs.writeFileSync(tmp, Buffer.from('half'));
    s = await ChatStore.open(t.dir, opts);
    expect(fs.existsSync(tmp)).toBe(false);
    await expect(s.head(P)).rejects.toMatchObject({ code: 'damaged' });
    await s.close(); await t.cleanup();
  });
});
