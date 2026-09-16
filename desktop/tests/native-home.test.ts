// Tests for NativeHome — the single module all ~/.youcoded/ I/O goes through.
// Real filesystem (temp dir per test), no fs mocking — the locking + atomic-write
// behavior is exactly what we need to exercise for real.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NativeHome } from '../src/main/native-home';

describe('NativeHome', () => {
  let root: string;
  let home: NativeHome;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-native-home-'));
    home = new NativeHome(root);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('does not create the directory until first write (lazy)', () => {
    expect(fs.existsSync(path.join(root, '.youcoded'))).toBe(false);
    expect(home.readJson('providers.json')).toBeNull();          // read of nothing is null, still no dir
    expect(fs.existsSync(path.join(root, '.youcoded'))).toBe(false);
  });

  // A directory sitting where the file should be makes readFileSync throw
  // EISDIR — a real I/O error, NOT "file absent". readJson must rethrow it:
  // returning null would let an initialize-on-null caller clobber real data.
  it('readJson rethrows non-ENOENT I/O errors (directory in place of file)', () => {
    fs.mkdirSync(path.join(root, '.youcoded', 'providers.json'), { recursive: true });
    expect(() => home.readJson('providers.json')).toThrow();
  });

  it('writeJson round-trips and creates the dir', async () => {
    await home.writeJson('providers.json', { v: 1, providers: [] });
    expect(home.readJson('providers.json')).toEqual({ v: 1, providers: [] });
    expect(fs.existsSync(path.join(root, '.youcoded', 'providers.json'))).toBe(true);
  });

  it('mutateJson applies read-modify-write under the lock', async () => {
    await home.writeJson('providers.json', { v: 1, providers: [] });
    await home.mutateJson('providers.json', (cur: any) => ({ ...cur, providers: [{ id: 'x' }] }));
    expect((home.readJson('providers.json') as any).providers).toHaveLength(1);
  });

  it('appendSessionLine + readSessionLines round-trip under sessions/<slug>/<id>.jsonl', async () => {
    await home.appendSessionLine('my-slug', 'abc', { v: 1, sessionId: 'abc' });
    await home.appendSessionLine('my-slug', 'abc', { type: 'user-message' });
    const lines = home.readSessionLines('my-slug', 'abc');
    expect(lines).toEqual([{ v: 1, sessionId: 'abc' }, { type: 'user-message' }]);
    expect(home.readSessionLines('my-slug', 'missing')).toEqual([]);
  });

  // Crash-torn tail: a process that died mid-append leaves a final line with
  // no trailing newline. The next appendSessionLine must add a newline FIRST
  // so the new record starts on its own line — otherwise the new JSON fuses
  // onto the torn fragment and BOTH records are lost, not just the torn one.
  it('appendSessionLine after a torn tail keeps the new record readable', async () => {
    await home.appendSessionLine('my-slug', 'abc', { seq: 1 });
    const p = path.join(root, '.youcoded', 'sessions', 'my-slug', 'abc.jsonl');
    fs.appendFileSync(p, '{"seq":2,"type":"torn', 'utf8'); // simulated crash mid-write, no \n
    await home.appendSessionLine('my-slug', 'abc', { seq: 3 });
    // Only the torn fragment is lost; records before and after survive.
    expect(home.readSessionLines('my-slug', 'abc')).toEqual([{ seq: 1 }, { seq: 3 }]);
  });

  // Contention: cas-write's lock is a <target>.lock DIRECTORY. Pre-creating it
  // with a fresh mtime means acquireLock can't stale-break it (30s heuristic),
  // so every attempt times out after LOCK_MAX_WAIT_MS (3s). maxRetries: 1 keeps
  // the test at ~3s while exercising the exact same contention + throw path the
  // default 5-retry production config uses. Real fs, no mocking of cas-write.
  it('mutateJson throws when the lock cannot be acquired', async () => {
    await home.writeJson('providers.json', { v: 1 });
    const lock = path.join(root, '.youcoded', 'providers.json.lock');
    fs.mkdirSync(lock, { recursive: true }); // fresh lock dir — held by "another process"
    try {
      await expect(
        home.mutateJson('providers.json', (cur) => cur, { maxRetries: 1 })
      ).rejects.toThrow(/lock/i);
      // The contended write must NOT have touched the file.
      expect(home.readJson('providers.json')).toEqual({ v: 1 });
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }, 10_000); // one lock-wait cycle is ~3s; vitest default 5s is too tight for slow CI

  it('readSessionHead returns full parsed lines when the file fits in the window', async () => {
    await home.appendSessionLine('my-slug', 'abc', { v: 1, sessionId: 'abc' });
    await home.appendSessionLine('my-slug', 'abc', { type: 'user-message' });
    expect(home.readSessionHead('my-slug', 'abc')).toEqual([{ v: 1, sessionId: 'abc' }, { type: 'user-message' }]);
    expect(home.readSessionHead('my-slug', 'missing')).toEqual([]);
  });

  // Bounded head: with a tiny byte cap, the read stops mid-file. The last line
  // in the window may be truncated, so it's DROPPED — only whole records the
  // window fully contains come back (here just line 1, the header).
  it('readSessionHead drops the truncated trailing record when the read is bounded', async () => {
    await home.appendSessionLine('my-slug', 'abc', { v: 1, sessionId: 'abc' });
    await home.appendSessionLine('my-slug', 'abc', { type: 'user-message', text: 'a much longer second line that spills past the cap' });
    // Cap just past the first line so line 2 is entered but truncated.
    const head = home.readSessionHead('my-slug', 'abc', 40);
    expect(head).toEqual([{ v: 1, sessionId: 'abc' }]);
  });

  it('listSessionFiles enumerates slug dirs with mtimes', async () => {
    await home.appendSessionLine('slug-a', 's1', { v: 1 });
    const files = home.listSessionFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ slug: 'slug-a', sessionId: 's1' });
    expect(typeof files[0].mtimeMs).toBe('number');
    expect(typeof files[0].sizeBytes).toBe('number');
  });

  // The guard NativeHome gained from lane-guards.ts. Native sessions are real
  // files today, so this pins the defensive behavior against a future regression
  // (and against the CC lane's 687-symlink incident repeating here).
  const canSymlinkNh = (() => {
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-nh-symlink-probe-'));
    try {
      fs.writeFileSync(path.join(probeDir, 'target'), 'x');
      fs.symlinkSync('target', path.join(probeDir, 'link'), 'file');
      return true;
    } catch { return false; }
    finally { try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {} }
  })();

  it.skipIf(!canSymlinkNh)('listSessionFiles skips a symlinked session file', () => {
    const slugDir = path.join(root, '.youcoded', 'sessions', 'proj-a');
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, 'real.jsonl'), '{"v":1}\n');
    fs.symlinkSync('real.jsonl', path.join(slugDir, 'linked.jsonl'), 'file');

    const ids = home.listSessionFiles().map((f) => f.sessionId).sort();
    expect(ids).toEqual(['real']);
  });

  it('listSessionFiles still enumerates a session smaller than the junk threshold', () => {
    const slugDir = path.join(root, '.youcoded', 'sessions', 'proj-b');
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, 'tiny.jsonl'), '{"v":1}\n'); // ~8 bytes

    const ids = home.listSessionFiles().map((f) => f.sessionId);
    expect(ids).toContain('tiny');
  });

  // DelegationLedger (plan 1b Task 2) writes one sidecar per parent session,
  // sessions/<slug>/<parentId>.delegations.json — sitting in the SAME slug
  // directory as real .jsonl session files. listSessionFiles feeds the Resume
  // Browser and pruneNativePhantomRecords; a sidecar mistaken for a session
  // would show up as a broken, unopenable row in both.
  it('listSessionFiles ignores .delegations.json sidecars', async () => {
    await home.appendSessionLine('proj-c', 'real-session', { v: 1 });
    const slugDir = path.join(root, '.youcoded', 'sessions', 'proj-c');
    fs.writeFileSync(path.join(slugDir, 'parent-1.delegations.json'), JSON.stringify({ v: 1, delegations: [] }));

    const ids = home.listSessionFiles().map((f) => f.sessionId);
    expect(ids).toEqual(['real-session']);
  });

  // Task 3 (plan 1c): ensureTextFile is the ONE sanctioned way the personal
  // specialists folder and its starter file get created (ADR 008 — NativeHome
  // is the only ~/.youcoded writer). First call creates parents + file and
  // reports true; a second call must never overwrite whatever the user has
  // since typed into that file.
  it('ensureTextFile creates parents + file, returns true; second call returns false and leaves edits alone', async () => {
    const rel = path.join('specialists', 'example.md');
    const target = path.join(root, '.youcoded', rel);
    expect(fs.existsSync(target)).toBe(false);

    const first = await home.ensureTextFile(rel, 'starter contents');
    expect(first).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('starter contents');

    // Simulate the user editing the file after it was created.
    fs.writeFileSync(target, 'the user edited this');

    const second = await home.ensureTextFile(rel, 'starter contents');
    expect(second).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('the user edited this');
  });
  // Specialists plans (Task 2): the plan journal must tell "absent" apart from
  // "present but unreadable" — readJson collapses both to null. These strict
  // helpers keep the lock/atomic-write story while exposing the raw bytes.
  it('readRawBytes returns null only for a missing file and the exact bytes otherwise', () => {
    expect(home.readRawBytes('plans/x.json')).toBeNull();
    expect(fs.existsSync(path.join(root, '.youcoded'))).toBe(false);
    const target = path.join(root, '.youcoded', 'plans', 'x.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = Buffer.from([0x7b, 0xff, 0x00, 0x7d]);
    fs.writeFileSync(target, bytes);
    expect(home.readRawBytes('plans/x.json')?.equals(bytes)).toBe(true);
    fs.rmSync(target); fs.mkdirSync(target);
    expect(() => home.readRawBytes('plans/x.json')).toThrow();
  });

  it('mutateText hands the raw text to the callback, writes its string, and a null return writes nothing', async () => {
    const target = path.join(root, '.youcoded', 'raw.json');
    await home.mutateText('raw.json', (cur) => { expect(cur).toBeNull(); return 'first'; });
    expect(fs.readFileSync(target, 'utf8')).toBe('first');
    await home.mutateText('raw.json', (cur) => { expect(cur).toBe('first'); return null; });
    expect(fs.readFileSync(target, 'utf8')).toBe('first');
    // A throwing callback aborts the write and releases the lock.
    await expect(home.mutateText('raw.json', () => { throw new Error('refuse'); })).rejects.toThrow('refuse');
    expect(fs.existsSync(target + '.lock')).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('first');
  });

  // Pins the pre-plans contract: a write that ends up writing nothing may
  // leave the folder it created, and NativeHome never removes a directory —
  // removing one could pull it out from under a writer waiting on a lock
  // inside it or a transcript append (review, 2026-09-16).
  it('mutateText/mutateJson that write nothing never remove directories (the folder may remain)', async () => {
    fs.mkdirSync(path.join(root, '.youcoded', 'keep'), { recursive: true });
    await home.mutateText('a/b/c.json', () => null);
    await expect(home.mutateJson('a/b/d.json', () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(fs.existsSync(path.join(root, '.youcoded', 'a', 'b'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.youcoded', 'keep'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.youcoded', 'a', 'b', 'c.json'))).toBe(false);
  });

  it('mutateJson still treats a corrupt file as absent (contract unchanged)', async () => {
    const target = path.join(root, '.youcoded', 'c.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{nope');
    await home.mutateJson('c.json', (cur) => ({ saw: cur }));
    expect(home.readJson('c.json')).toEqual({ saw: null });
  });

  it('createFileExclusive writes bytes once and never replaces an existing file', async () => {
    const bytes = Buffer.from([1, 2, 3]);
    expect(await home.createFileExclusive('q/a.bin', bytes)).toBe(true);
    expect(await home.createFileExclusive('q/a.bin', Buffer.from([9]))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.youcoded', 'q', 'a.bin')).equals(bytes)).toBe(true);
  });
});
