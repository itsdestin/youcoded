// The replicator's small parts: the head comparison table, budgets, the incarnation map, the signed-head file (under crashes, rot and a full disk)
// and the interim directory.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { randomBytes } from 'node:crypto';
import { compareHeads, type HeadView } from './compare';
import { ByteBudget, RateLimiter, MAX_HOLDS_PER_SECOND } from './budget';
import { IdMap, incarnationId, MAX_INCARNATIONS, type Probe } from './idmap';
import { SignedHeads, RECORD_BYTES, THIN_AT, UNKNOWN_SPAN, type Point } from './signed-heads';
import { LegacyDirectory } from '../../../../tests/mesh/legacy-directory';
import { InterimDirectory, type ReplicatorCrypto } from './directory';
import { introMessage, type IntroBody } from './wire';
import { FaultFs, InjectedCrash } from '../store/fault-fs';
import { realFs } from '../store/fsio';
import { deriveForkId } from '../store/fork';
import { tmpRoot } from '../store/testkit';
import { generateIdentity, signWith, verifySig, deviceIdFor } from '../crypto/identity';

const H = (n: number): string => n.toString(16).padStart(64, '0');
const view = (lines: number, h: number, state: HeadView['state'] = 'ok'): HeadView => ({ lines, hash: H(h), state });

describe('compareHeads: every row of the table', () => {
  it('equal count and value is in sync; equal count with another value is diverged, never settled by anything else', () => {
    expect(compareHeads(view(5, 1), view(5, 1), H(1))).toEqual({ do: 'in-sync' });
    expect(compareHeads(view(5, 1), view(5, 2), H(2))).toEqual({ do: 'diverged' });
  });
  it('a longer peer is pulled from (the server checks the prefix); a longer peer is never called the winner', () => {
    expect(compareHeads(view(5, 1), view(9, 2), null)).toEqual({ do: 'pull' });
  });
  it('a shorter peer that is a prefix of me waits for its own want; a shorter one that is not a prefix is diverged', () => {
    expect(compareHeads(view(9, 1), view(5, 2), H(2))).toEqual({ do: 'wait-for-want' });
    expect(compareHeads(view(9, 1), view(5, 2), H(3))).toEqual({ do: 'diverged' });
  });
  it('my chain value at their count evicted: cannot compare, said by name; a missing value for a shorter peer is loud', () => {
    expect(compareHeads(view(9, 1), view(5, 2), 'unknown')).toEqual({ do: 'cannot-compare' });
    expect(compareHeads(view(9, 1), view(5, 2), null)).toEqual({ do: 'diverged' });
  });
  it('a refilling or damaged peer is ignored whatever its head says, and is told apart when it needs me', () => {
    expect(compareHeads(view(9, 1), view(9, 1, 'refilling'), H(1))).toEqual({ do: 'ignore-theirs', theyNeedMe: false });
    expect(compareHeads(view(9, 1), view(4, 7, 'damaged'), H(2))).toEqual({ do: 'ignore-theirs', theyNeedMe: true });
    expect(compareHeads(view(9, 1), view(20, 7, 'refilling'), null)).toMatchObject({ do: 'ignore-theirs' });
  });
  it('when I am refilling I only pull what lies beyond the point I can vouch for', () => {
    expect(compareHeads(view(3, 1, 'refilling'), view(9, 2), null)).toEqual({ do: 'pull' });
    expect(compareHeads(view(3, 1, 'refilling'), view(3, 1), H(1))).toEqual({ do: 'in-sync' });
  });
});

describe('budgets', () => {
  it('a byte budget is all-or-nothing and refuses to be overdrawn or over-repaid', () => {
    const b = new ByteBudget(100);
    expect(b.take(60)).toBe(true); expect(b.take(41)).toBe(false); expect(b.used).toBe(60);
    b.give(60); expect(b.used).toBe(0);
    expect(() => b.give(1)).toThrow(); expect(() => b.take(-1)).toThrow();
  });
  it('the rate limiter allows a burst then one per interval on the given clock', () => {
    let t = 0; const r = new RateLimiter(MAX_HOLDS_PER_SECOND, () => t);
    for (let i = 0; i < MAX_HOLDS_PER_SECOND; i++) expect(r.take()).toBe(true);
    expect(r.take()).toBe(false);
    expect(r.retryInMs).toBeGreaterThan(0);
    t += r.retryInMs; expect(r.take()).toBe(true);
    t += 10_000; for (let i = 0; i < MAX_HOLDS_PER_SECOND; i++) expect(r.take()).toBe(true); expect(r.take()).toBe(false); // never more than a burst
  });
});

describe('the incarnation map', () => {
  const wire = Buffer.from('aa010001', 'hex');
  it('every incarnation, the first too, is a different, stable, 32-byte id and none is the wire id', () => {
    expect(incarnationId(wire, 0).equals(wire)).toBe(false);
    expect(incarnationId(wire, 0).length).toBe(32);
    const a = incarnationId(wire, 1); const b = incarnationId(wire, 2);
    expect(a.length).toBe(32); expect(a.equals(b)).toBe(false); expect(a.equals(incarnationId(wire, 1))).toBe(true);
    expect(() => incarnationId(wire, MAX_INCARNATIONS + 1)).toThrow();
  });
  it('the current id is the lowest one that is not retired, and a retired id is never given out again', async () => {
    const retired = new Set<string>();
    const probe: Probe = async (l) => (retired.has(l.toString('hex')) ? 'retired' : 'absent');
    const m = new IdMap(probe);
    expect((await m.current(wire)).incarnation).toBe(0);
    retired.add(incarnationId(wire, 0).toString('hex')); m.retired(wire, 0);
    const second = await m.current(wire);
    expect(second.incarnation).toBe(1);
    // even a fresh map over the same store (a restart) skips what is retired
    expect((await new IdMap(probe).current(wire)).incarnation).toBe(1);
    // and a probe that wrongly forgets 0 is not believed once this map has moved up
    retired.clear(); retired.add(second.local.toString('hex'));
    expect((await m.current(wire)).incarnation).toBe(2);
  });
  it('on a fresh map the current incarnation is the HIGHEST live one before the first absent one, not the lowest not-retired one', async () => {
    const state = new Map<string, 'live' | 'retired'>([[incarnationId(wire, 0).toString('hex'), 'retired'], [incarnationId(wire, 1).toString('hex'), 'live'], [incarnationId(wire, 2).toString('hex'), 'live']]);
    const probe: Probe = async (l) => state.get(l.toString('hex')) ?? 'absent';
    const cur = await new IdMap(probe).current(wire);
    expect(cur).toMatchObject({ incarnation: 2, registered: true });
  });
  it('a version retired more often than the limit stops loudly', async () => {
    const m = new IdMap(async () => 'retired');
    await expect(m.current(wire)).rejects.toThrow(/too many/);
  });
});

describe('signed heads on disk', () => {
  const wire = Buffer.from('bb010001', 'hex');
  const pt = (lines: number, span = 10): Point => ({ lines, hash: randomBytes(32), sig: randomBytes(64), spanBytes: span });
  it('points are kept in order, found by "next above", and a repeat or a conflicting value is told apart', async () => {
    const t = await tmpRoot('rep-sh-');
    try {
      const sh = new SignedHeads(realFs, t.dir);
      const a = pt(5); const b = pt(9);
      expect(await sh.add(wire, b)).toBe('added'); expect(await sh.add(wire, a)).toBe('added');
      expect(await sh.add(wire, a)).toBe('known');
      expect(await sh.add(wire, { ...a, hash: randomBytes(32) })).toBe('conflict');
      expect((await sh.nextAfter(wire, 0))?.lines).toBe(5); expect((await sh.nextAfter(wire, 5))?.lines).toBe(9); expect(await sh.nextAfter(wire, 9)).toBeNull();
      expect((await sh.newest(wire))?.lines).toBe(9);
      // a new process sees the same
      const again = new SignedHeads(realFs, t.dir);
      expect((await again.load(wire)).map((p) => p.lines)).toEqual([5, 9]);
    } finally { await t.cleanup(); }
  });
  it('a rotted record is skipped and counted and every other record is still served; a torn tail is replaced by the next append', async () => {
    const t = await tmpRoot('rep-sh-');
    try {
      const sh = new SignedHeads(realFs, t.dir);
      for (const n of [1, 2, 3]) await sh.add(wire, pt(n));
      const file = nodePath.join(t.dir, 'heads', `${wire.toString('hex')}.sh`);
      const raw = fs.readFileSync(file); raw[RECORD_BYTES + 50] ^= 1; fs.writeFileSync(file, Buffer.concat([raw, Buffer.alloc(40, 1)])); // rot in record 2, torn tail
      const again = new SignedHeads(realFs, t.dir);
      expect((await again.load(wire)).map((p) => p.lines)).toEqual([1, 3]);
      expect(again.skipped).toBe(1);
      expect(await again.add(wire, pt(4))).toBe('added');
      expect(fs.statSync(file).size % RECORD_BYTES).toBe(0);
      expect((await new SignedHeads(realFs, t.dir).load(wire)).map((p) => p.lines)).toEqual([1, 3, 4]);
    } finally { await t.cleanup(); }
  });
  it('after thinning the newest point and a point every 32 lines remain, so no batch span can outgrow the budget', async () => {
    const t = await tmpRoot('rep-sh-');
    try {
      const sh = new SignedHeads(realFs, t.dir);
      for (let n = 1; n <= THIN_AT + 20; n++) await sh.add(wire, pt(n, 100));
      const pts = await sh.load(wire);
      expect(pts.length).toBeLessThan(THIN_AT / 2);
      expect(pts[pts.length - 1].lines).toBe(THIN_AT + 20);
      let prev = 0; for (const p of pts) { expect(p.lines - prev).toBeLessThanOrEqual(33); prev = p.lines; }
      expect((await new SignedHeads(realFs, t.dir).load(wire)).map((p) => p.lines)).toEqual(pts.map((p) => p.lines));
    } finally { await t.cleanup(); }
  });
  it('a span of unknown size is never merged away', async () => {
    const t = await tmpRoot('rep-sh-');
    try {
      const sh = new SignedHeads(realFs, t.dir);
      for (let n = 1; n <= THIN_AT + 5; n++) await sh.add(wire, pt(n, n === 100 ? UNKNOWN_SPAN : 1));
      expect((await sh.load(wire)).some((p) => p.lines === 100)).toBe(true);
    } finally { await t.cleanup(); }
  });
  it('a kill at every file operation of an add leaves a file whose points are all genuine, and the add can be repeated', async () => {
    let ops = 0;
    { const t = await tmpRoot('rep-sh-'); try { const f = new FaultFs(0); const sh = new SignedHeads(f, t.dir); await sh.add(wire, pt(1)); await sh.add(wire, pt(2)); ops = f.ops; } finally { await t.cleanup(); } }
    expect(ops).toBeGreaterThan(4);
    for (const tear of [false, true]) for (let k = 1; k <= ops; k++) {
      const t = await tmpRoot('rep-sh-');
      try {
        const good = [pt(1), pt(2)];
        const f = new FaultFs(k, { tear });
        try { const sh = new SignedHeads(f, t.dir); for (const p of good) await sh.add(wire, p); } catch (e) { if (!(e instanceof InjectedCrash)) throw e; }
        const after = new SignedHeads(realFs, t.dir);
        const held = await after.load(wire);
        for (const p of held) expect(good.some((g) => g.lines === p.lines && g.hash.equals(p.hash)), `kill at op ${k}`).toBe(true); // nothing invented
        for (const g of good) await after.add(wire, g); // redo converges
        expect((await after.load(wire)).map((p) => p.lines).sort()).toEqual([1, 2]);
        expect((await new SignedHeads(realFs, t.dir).load(wire)).length).toBe(2);
      } finally { await t.cleanup(); }
    }
  });
  it('a full disk fails the add loudly and keeps what was there', async () => {
    const t = await tmpRoot('rep-sh-');
    try {
      await new SignedHeads(realFs, t.dir).add(wire, pt(1));
      const sh = new SignedHeads(new FaultFs(0, { enospcFrom: 1, tear: true }), t.dir);
      await expect(sh.add(wire, pt(2))).rejects.toMatchObject({ code: 'ENOSPC' });
      expect((await new SignedHeads(realFs, t.dir).load(wire)).map((p) => p.lines)).toEqual([1]);
    } finally { await t.cleanup(); }
  });
});

describe('the interim directory', () => {
  function crypto(me = generateIdentity(), known: Array<ReturnType<typeof generateIdentity>> = []): ReplicatorCrypto {
    const all = [me, ...known];
    return { self: me.deviceId, sign: (m) => signWith(me, m), knows: (d) => all.some((x) => x.deviceId.equals(d)), verify: (d, m, s) => { const x = all.find((y) => y.deviceId.equals(d)); return !!x && verifySig(x.signKey, m, s); } };
  }
  const desc = (writer: Buffer, over: Partial<IntroBody> = {}): Omit<IntroBody, 'sig'> => ({ version: Buffer.from('cc010001', 'hex'), chatId: 'chat-1', runtime: 'claude-code', parent: null, forkLine: null, forkHash: null, token: null, writer, ...over });
  it('the writer announces, another device accepts it once, and a changed copy of the same version is a conflict', async () => {
    const A = generateIdentity(); const B = generateIdentity();
    const ta = await tmpRoot('rep-dir-'); const tb = await tmpRoot('rep-dir-');
    try {
      const da = new LegacyDirectory(realFs, ta.dir, crypto(A, [B]), { setId: Buffer.alloc(32) }); const db = new LegacyDirectory(realFs, tb.dir, crypto(B, [A]), { setId: Buffer.alloc(32) });
      const intro = await da.announce(desc(A.deviceId));
      let changes = 0; db.onChange(() => changes++);
      expect(await db.accept(intro)).toBe('new'); expect(await db.accept(intro)).toBe('known'); expect(changes).toBe(1);
      expect(db.describe(intro.version)?.writer.equals(A.deviceId)).toBe(true);
      const other = await new LegacyDirectory(realFs, (await tmpRoot('rep-dir-')).dir, crypto(A, [B]), { setId: Buffer.alloc(32) }).announce(desc(A.deviceId, { chatId: 'chat-2' }));
      expect(await db.accept(other)).toBe('conflict');
      expect(db.describe(intro.version)?.chatId).toBe('chat-1');
      // restart: what was accepted is still known, and what was refused is not
      const db2 = new LegacyDirectory(realFs, tb.dir, crypto(B, [A]), { setId: Buffer.alloc(32) }); await db2.load();
      expect(db2.describe(intro.version)?.chatId).toBe('chat-1');
    } finally { await ta.cleanup(); await tb.cleanup(); }
  });
  it('a forged signature, an unknown writer and a child whose id does not match its fork are each refused by name', async () => {
    const A = generateIdentity(); const B = generateIdentity(); const X = generateIdentity();
    const t = await tmpRoot('rep-dir-');
    try {
      const db = new LegacyDirectory(realFs, t.dir, crypto(B, [A]), { setId: Buffer.alloc(32) });
      const good = { ...desc(A.deviceId), sig: signWith(A, introMessage(desc(A.deviceId))) };
      expect(await db.accept({ ...good, sig: Buffer.alloc(64, 1) })).toBe('bad-signature');
      expect(await db.accept({ ...good, writer: X.deviceId, sig: signWith(X, introMessage(desc(X.deviceId))) })).toBe('unknown-writer');
      const parent = Buffer.from('dd010001', 'hex'); const forkHash = Buffer.alloc(32, 4);
      const child = desc(A.deviceId, { version: Buffer.from('ee010001', 'hex'), parent, forkLine: 3, forkHash, token: 'entry-1' });
      expect(await db.accept({ ...child, sig: signWith(A, introMessage(child)) })).toBe('bad-fork-id');
      const right = { ...child, version: deriveForkId(parent, 3, forkHash.toString('hex'), 'entry-1') };
      expect(await db.accept({ ...right, sig: signWith(A, introMessage(right)) })).toBe('new');
      expect(db.list().length).toBe(1);
      expect(deviceIdFor(A.signKey).equals(A.deviceId)).toBe(true);
    } finally { await t.cleanup(); }
  });
});
