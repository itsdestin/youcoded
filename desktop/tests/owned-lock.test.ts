// R-4 / L-1: the shared "busy" marker. Fake process lookups drive every verdict; one test uses a real killed child process.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { acquireOwnedLock, processStartTime } from '../src/main/owned-lock';

const HOUR = 3600_000;
let root = '';
const mk = () => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-owned-lock-')); return path.join(root, 'state', '.sync-lock'); };
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = ''; });

const writeOwner = (dir: string, o: object) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(o)); };

describe('acquireOwnedLock', () => {
  it('acquires a free lock, writes owner + the old pid file, and releases only its own', async () => {
    const dir = mk();
    const r = await acquireOwnedLock(dir, { pid: 111, processStart: async () => 's1' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')).startTime).toBe('s1');
    expect(fs.readFileSync(path.join(dir, 'pid'), 'utf8')).toBe('111');
    await r.lock.release(); expect(fs.existsSync(dir)).toBe(false);
  });

  it('refuses while a verified owner (same start time) lives, however old the lock is', async () => {
    const dir = mk(); writeOwner(dir, { pid: 5, startTime: 'S', createdAt: 0, token: 't' });
    const r = await acquireOwnedLock(dir, { pid: 9, now: () => 100 * HOUR, unverifiableStaleAfterMs: 2 * HOUR, isAlive: () => true, processStart: async (p) => (p === 5 ? 'S' : 'mine') });
    expect(r).toMatchObject({ ok: false, reason: 'held', holder: { pid: 5 } });
  });

  it('takes over when the owner is gone', async () => {
    const dir = mk(); writeOwner(dir, { pid: 5, startTime: 'S', createdAt: 0, token: 't' });
    const r = await acquireOwnedLock(dir, { pid: 9, isAlive: () => false, processStart: async () => 'mine' });
    expect(r).toMatchObject({ ok: true, tookOver: 'dead-owner' });
  });

  it('takes over when the number was reused by a different process (different start time)', async () => {
    const dir = mk(); writeOwner(dir, { pid: 5, startTime: 'OLD', createdAt: 0, token: 't' });
    const r = await acquireOwnedLock(dir, { pid: 9, isAlive: () => true, processStart: async (p) => (p === 5 ? 'NEW' : 'mine') });
    expect(r).toMatchObject({ ok: true, tookOver: 'reused-pid' });
  });

  it('L-1: an owner that cannot be verified keeps the lock for under 2 hours and loses it after', async () => {
    const dir = mk(); writeOwner(dir, { pid: 5, startTime: null, createdAt: 0, token: 't' });
    const base = { pid: 9, isAlive: () => true, processStart: async () => undefined, unverifiableStaleAfterMs: 2 * HOUR };
    expect(await acquireOwnedLock(dir, { ...base, now: () => 1 * HOUR })).toMatchObject({ ok: false, reason: 'held' });
    expect(await acquireOwnedLock(dir, { ...base, now: () => 2 * HOUR + 1 })).toMatchObject({ ok: true, tookOver: 'unverifiable-aged' });
  });

  it('an unreadable lock is refused while fresh, taken over once aged, and never when no age rule is given', async () => {
    const dir = mk(); fs.mkdirSync(dir, { recursive: true });           // a folder with nothing readable in it
    const fresh = Date.now();
    expect(await acquireOwnedLock(dir, { pid: 9, now: () => fresh, unverifiableStaleAfterMs: 2 * HOUR })).toMatchObject({ ok: false, reason: 'unverifiable' });
    expect(await acquireOwnedLock(dir, { pid: 9, now: () => fresh + 100 * HOUR })).toMatchObject({ ok: false, reason: 'unverifiable' });
    expect(await acquireOwnedLock(dir, { pid: 9, now: () => fresh + 3 * HOUR, unverifiableStaleAfterMs: 2 * HOUR, processStart: async () => 'm' })).toMatchObject({ ok: true });
  });

  it('a lock written by an older app version (pid file only) is honoured while that process lives', async () => {
    const dir = mk(); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'pid'), '5');
    expect(await acquireOwnedLock(dir, { pid: 9, isAlive: () => true, unverifiableStaleAfterMs: 2 * HOUR, processStart: async () => undefined })).toMatchObject({ ok: false, reason: 'held' });
    expect(await acquireOwnedLock(dir, { pid: 9, isAlive: () => false, processStart: async () => undefined })).toMatchObject({ ok: true, tookOver: 'dead-owner' });
  });

  it('two contenders: exactly one wins', async () => {
    const dir = mk();
    const opts = { isAlive: () => true, processStart: async () => 'x' };
    const rs = await Promise.all([acquireOwnedLock(dir, { ...opts, pid: 1 }), acquireOwnedLock(dir, { ...opts, pid: 2 })]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
  });

  it('a late release by a former owner does not remove the lock that replaced it', async () => {
    const dir = mk();
    const first = await acquireOwnedLock(dir, { pid: 1, processStart: async () => 'a' }); if (!first.ok) throw new Error('setup');
    const second = await acquireOwnedLock(dir, { pid: 2, isAlive: () => false, processStart: async () => 'b' }); if (!second.ok) throw new Error('setup');
    await first.lock.release(); first.lock.releaseSync();
    expect(fs.existsSync(dir)).toBe(true);
    await second.lock.release(); expect(fs.existsSync(dir)).toBe(false);
  });

  it.runIf(process.platform === 'linux')('real processes: a killed child no longer holds the lock; a living one still does', async () => {
    const dir = mk();
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    writeOwner(dir, { pid, startTime: await processStartTime(pid), createdAt: Date.now(), token: 't' });
    expect(await acquireOwnedLock(dir)).toMatchObject({ ok: false, reason: 'held' });
    await new Promise<void>((res) => { child.once('exit', () => res()); child.kill('SIGKILL'); });
    expect(await acquireOwnedLock(dir)).toMatchObject({ ok: true, tookOver: 'dead-owner' });
  });
});
