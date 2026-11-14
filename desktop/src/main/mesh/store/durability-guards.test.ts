// Guards for the places a mutation check (review 4) showed no test would notice if the code were wrong: the acknowledgement being made durable, copies being made
// durable before a cut, a damaged control tail never being cut, second-writer refusals, the lock's "recent and unreadable" wait, a tail being read back before the
// cut, a deferred cut keeping its copy, and kept copies never being overwritten. Each test names the behaviour it protects. Synthetic data, temp folders only.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatStore } from './store';
import { FaultFs } from './fault-fs';
import { realFs, type Fs, type FileLike } from './fsio';
import { readCheckpoint, readCheckpointState } from './checkpoint';
import { CHAT, V, openWith, tmpRoot } from './testkit';
import { cc } from './fixtures';

const rows = (n: number, tag = 'g'): Buffer[] => Array.from({ length: n }, (_, i) => cc.user(`${tag} ${i} ${'z'.repeat(20)}`));
const vdir = (root: string) => path.join(root, 'versions', V(1).toString('hex'));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const enospc = (): Error => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });

describe('the acknowledgement is durable', () => {
  it('after append returns, a power cut that loses every unsynced in-place overwrite still finds the checkpoint at the acknowledged count', async () => {
    const t = await tmpRoot('dg-ck-');
    const ffs = new FaultFs(0, { powerLoss: true, revertInPlace: true });
    const s = await openWith(t.dir, V(1), { fs: ffs });
    const L = rows(6);
    for (let i = 0; i < 6; i += 2) await s.append(V(1), 0, i, L.slice(i, i + 2));
    await ffs.applyPowerLoss();                                  // power is cut right after the last acknowledgement; the store is not closed
    expect((await readCheckpoint(realFs, vdir(t.dir)))!.count).toBe(6);
    await s.close().catch(() => undefined); await t.cleanup();
  });

  it('a copy of cut-off body bytes is durable before the body is cut: power loss right after the cut finds the copy whole', async () => {
    const t = await tmpRoot('dg-torn-');
    const s0 = await openWith(t.dir, V(1)); await s0.append(V(1), 0, 0, rows(5)); await s0.close();
    const body = path.join(vdir(t.dir), 'body-0000000000000000.bin');
    const surplus = Buffer.from('unacknowledged-bytes-' + 'q'.repeat(40) + '\n');
    fs.appendFileSync(body, surplus);
    const ffs = new FaultFs(0, { powerLoss: true, revertInPlace: true });
    const s = await ChatStore.open(t.dir, { fs: ffs });
    await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' });
    expect((await s.head(V(1))).lines).toBe(5);
    await ffs.applyPowerLoss();
    const kept = fs.readdirSync(path.join(vdir(t.dir), 'torn')).filter((n) => n.endsWith('-body'));
    expect(kept.length).toBe(1);
    expect(fs.readFileSync(path.join(vdir(t.dir), 'torn', kept[0])).equals(surplus)).toBe(true);
    await s.close().catch(() => undefined); await t.cleanup();
  });

  it('a damaged checkpoint slot is rewritten when the version loads (both slots valid again, no close needed)', async () => {
    const t = await tmpRoot('dg-slot-');
    const s0 = await openWith(t.dir, V(1)); await s0.append(V(1), 0, 0, rows(4)); await s0.close();
    const cp = path.join(vdir(t.dir), 'checkpoint.bin'); const b = fs.readFileSync(cp); b[30] ^= 0xff; fs.writeFileSync(cp, b);
    expect((await readCheckpointState(realFs, vdir(t.dir))).slotsOk).toBe(1);
    const s = await ChatStore.open(t.dir); await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' }); await s.head(V(1));
    expect((await readCheckpointState(realFs, vdir(t.dir))).slotsOk).toBe(2);
    await s.close(); await t.cleanup();
  });
});

describe('a damaged control log tail is reported and kept, never cut', () => {
  it('a flipped byte in the LAST record (not zeros) is damage: log.bin is unchanged and nothing is moved to torn-N.bin', async () => {
    const t = await tmpRoot('dg-ctl-');
    const s = await ChatStore.open(t.dir);
    const es = [1, 2, 3].map((i) => { const body = Buffer.from(`entry-${i}-${'x'.repeat(20)}`); return { id: sha(body), chat: CHAT, seen: [] as string[], body }; });
    for (const e of es) await s.appendControl(e);
    await s.close();
    const dir = path.join(t.dir, 'control', fs.readdirSync(path.join(t.dir, 'control'))[0]);
    const b = fs.readFileSync(path.join(dir, 'log.bin')); b[b.length - 5] ^= 0x01; fs.writeFileSync(path.join(dir, 'log.bin'), b);
    const s2 = await ChatStore.open(t.dir);
    expect((await s2.controlLog(CHAT)).length).toBe(2);
    expect((await s2.controlDamage(CHAT)).length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(dir, 'log.bin')).equals(b)).toBe(true);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('torn-'))).toEqual([]);
    await s2.close(); await t.cleanup();
  });
});

describe('refusals that keep a second writer from overwriting', () => {
  it('a body file that grew under the store is refused (corrupt), nothing is written over the new bytes', async () => {
    const t = await tmpRoot('dg-w2b-');
    const s = await openWith(t.dir, V(1)); await s.append(V(1), 0, 0, rows(3));
    const body = path.join(vdir(t.dir), 'body-0000000000000000.bin');
    fs.appendFileSync(body, Buffer.from('another-writer\n'));
    const before = fs.readFileSync(body);
    await expect(s.append(V(1), 0, 3, rows(2, 'h'))).rejects.toMatchObject({ code: 'corrupt' });
    expect(fs.readFileSync(body).equals(before)).toBe(true);
    await s.close(); await t.cleanup();
  });
  it('an index file that grew under the store is refused (corrupt), nothing is written over the new bytes', async () => {
    const t = await tmpRoot('dg-w2i-');
    const s = await openWith(t.dir, V(1)); await s.append(V(1), 0, 0, rows(3));
    const ix = path.join(vdir(t.dir), 'index.bin');
    fs.appendFileSync(ix, Buffer.alloc(40, 7));
    const before = fs.readFileSync(ix);
    await expect(s.append(V(1), 0, 3, rows(2, 'h'))).rejects.toMatchObject({ code: 'corrupt' });
    expect(fs.readFileSync(ix).equals(before)).toBe(true);
    await s.close(); await t.cleanup();
  });
});

describe('the lock', () => {
  it('an unreadable lock file that is RECENT is refused (store-locked), not taken over at once', async () => {
    const t = await tmpRoot('dg-lock-');
    fs.writeFileSync(path.join(t.dir, 'LOCK'), 'not a lock body');
    await expect(ChatStore.open(t.dir)).rejects.toMatchObject({ code: 'store-locked' });
    await t.cleanup();
  });
});

describe('set-aside tails and deferred cuts keep their copies', () => {
  it('a tail file that does not read back as written stops the set-aside: nothing is cut', async () => {
    const t = await tmpRoot('dg-tail-');
    const bad: Fs = { ...realFs, rename: async (a, b) => { await realFs.rename(a, b); if (b.endsWith('.tail')) { const x = fs.readFileSync(b); x[x.length - 9] ^= 1; fs.writeFileSync(b, x); } } };
    const s = await openWith(t.dir, V(1), { fs: bad }); await s.append(V(1), 0, 0, rows(8));
    await expect(s.setAsideTail('abcdef012345', V(1), 4)).rejects.toMatchObject({ code: 'corrupt' });
    expect((await s.head(V(1))).lines).toBe(8);
    await s.close(); await t.cleanup();
  });

  it('an index tail whose cut had to wait for free space is copied to torn/ before it is cut', async () => {
    const t = await tmpRoot('dg-defer-');
    const s0 = await openWith(t.dir, V(1)); await s0.append(V(1), 0, 0, rows(5)); await s0.close();
    const ix = path.join(vdir(t.dir), 'index.bin'); const junk = Buffer.alloc(50, 0x5a);
    fs.appendFileSync(ix, junk);                                  // half a record: a torn index write
    let full = true;
    const wrap = (f: FileLike): FileLike => ({ write: (b, p) => (full ? Promise.reject(enospc()) : f.write(b, p)), read: (p, l) => f.read(p, l), size: () => f.size(), truncate: (l) => f.truncate(l), sync: () => f.sync(), close: () => f.close() });
    const tog: Fs = { ...realFs, open: async (p, o) => { if (full && o.create && !(await realFs.exists(p))) throw enospc(); return wrap(await realFs.open(p, o)); }, mkdir: async (p) => { if (full) throw enospc(); return realFs.mkdir(p); } };
    const s = await ChatStore.open(t.dir, { fs: tog });
    await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' });
    expect((await s.head(V(1))).lines).toBe(5);                  // served while the cut waits
    expect(fs.statSync(ix).size).toBeGreaterThan(36 + 5 * 116);
    full = false;
    expect(await s.append(V(1), 0, 5, rows(1, 'n'))).toBe('ok');
    const kept = fs.readdirSync(path.join(vdir(t.dir), 'torn')).filter((n) => n.endsWith('-index-tail'));
    expect(kept.length).toBe(1);
    expect(fs.readFileSync(path.join(vdir(t.dir), 'torn', kept[0])).equals(junk)).toBe(true);
    await s.close(); await t.cleanup();
  });
});

describe('kept copies are never overwritten, even when a directory listing lies', () => {
  /** An Fs whose readdir hides the names matching `hide`: the next-number logic then proposes a name that already exists. */
  const lying = (hide: RegExp): Fs => ({ ...realFs, readdir: async (p) => (await realFs.readdir(p)).filter((n) => !hide.test(n)) });

  it('a second damaged meta copy is kept under a NEW name, the first kept copy survives', async () => {
    const t = await tmpRoot('dg-bad-');
    const s0 = await openWith(t.dir, V(1)); await s0.close();
    const mj = path.join(vdir(t.dir), 'meta.json');
    fs.writeFileSync(mj, 'garbage-one-xxxxxxxx');
    let s = await ChatStore.open(t.dir, { fs: lying(/\.bad-\d+$/) }); await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' }); await s.close();
    fs.writeFileSync(mj, 'garbage-two-yyyyyyyy');
    s = await ChatStore.open(t.dir, { fs: lying(/\.bad-\d+$/) }); await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' }); await s.close();
    const kept = fs.readdirSync(vdir(t.dir)).filter((n) => /^meta\.json\.bad-\d+$/.test(n)).map((n) => fs.readFileSync(path.join(vdir(t.dir), n), 'utf8')).sort();
    expect(kept).toEqual(['garbage-one-xxxxxxxx', 'garbage-two-yyyyyyyy']);
    await t.cleanup();
  });

  it('a second set of cut-off body bytes is kept under a NEW torn name, the first kept copy survives', async () => {
    const t = await tmpRoot('dg-torn2-');
    const s0 = await openWith(t.dir, V(1)); await s0.append(V(1), 0, 0, rows(4)); await s0.close();
    const body = path.join(vdir(t.dir), 'body-0000000000000000.bin');
    for (const c of ['A', 'B']) {
      fs.appendFileSync(body, Buffer.from(c.repeat(30) + '\n'));
      const s = await ChatStore.open(t.dir, { fs: lying(/^\d{6}-/) }); await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' }); await s.head(V(1)); await s.close();
    }
    const kept = fs.readdirSync(path.join(vdir(t.dir), 'torn')).filter((n) => n.endsWith('-body')).map((n) => fs.readFileSync(path.join(vdir(t.dir), 'torn', n), 'utf8')).sort();
    expect(kept).toEqual(['A'.repeat(30) + '\n', 'B'.repeat(30) + '\n']);
    await t.cleanup();
  });
});
