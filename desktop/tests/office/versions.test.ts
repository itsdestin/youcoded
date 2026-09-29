import { chmod, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// WHY mocked: the project watcher pulls in chokidar and the artifact store; here only the call
// matters (a restore must tell the watcher the write is Office's own).
const watcher = vi.hoisted(() => ({ noteOwnWrite: vi.fn() }));
vi.mock('../../src/main/artifacts/project-watcher', () => watcher);

import { list, pruneAll, pruneKeep, restore, snapshot, versionsDir } from '../../src/main/office/versions';

const MEMO = fileURLToPath(new URL('./fixtures/memo.docx', import.meta.url));

// The owner's pruning choice, "tiered-30" (R11): everything from the last 24 hours, then the
// newest copy of each day for 30 days, never more than 50 per file. Pure, so no clock and no disk.
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Midday, so "N days ago" never lands on a day boundary in any time zone the tests run in.
const NOW = new Date(2026, 8, 28, 12, 0, 0);
const v = (id: string, msAgo: number, bytes = 10) => ({ id, at: new Date(NOW.getTime() - msAgo).toISOString(), bytes });

describe('pruneKeep (tiered-30)', () => {
  it('keeps every version from the last 24 hours', () => {
    const list = [v('a', 1000), v('b', HOUR), v('c', 5 * HOUR), v('d', 23 * HOUR)];
    expect([...pruneKeep(list, NOW)].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps only the newest version of each calendar day between 1 and 30 days old', () => {
    const list = [
      v('day3-early', 3 * DAY + 2 * HOUR),
      v('day3-late', 3 * DAY - 2 * HOUR),
      v('day3-mid', 3 * DAY),
      v('day10', 10 * DAY),
      v('day10-earlier', 10 * DAY + HOUR),
    ];
    expect([...pruneKeep(list, NOW)].sort()).toEqual(['day10', 'day3-late']);
  });

  it('drops versions older than 30 days', () => {
    const list = [v('recent', HOUR), v('day29', 29 * DAY), v('day31', 31 * DAY), v('day90', 90 * DAY)];
    expect([...pruneKeep(list, NOW)].sort()).toEqual(['day29', 'recent']);
  });

  it('keeps at most 50 versions of a file, letting the oldest go first', () => {
    const list = Array.from({ length: 60 }, (_, i) => v(`m${i}`, i * 60_000));
    const kept = pruneKeep(list, NOW);
    expect(kept.size).toBe(50);
    for (let i = 0; i < 50; i++) expect(kept.has(`m${i}`)).toBe(true);
    for (let i = 50; i < 60; i++) expect(kept.has(`m${i}`)).toBe(false);
  });

  it('keeps nothing when there is nothing', () => {
    expect(pruneKeep([], NOW).size).toBe(0);
  });

  it('treats a version stamped slightly in the future (a clock change) as recent, never as lost', () => {
    expect([...pruneKeep([v('ahead', -5 * 60_000)], NOW)]).toEqual(['ahead']);
  });
});

// ── The store, on a temporary userData ──
let dir: string;
let userData: string;
let file: string;
let memo: Buffer;
// A zip-shaped stand-in: a restore checks a kept copy is a whole document (PK header) first.
const doc = (text: string) => Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from(text)]);

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'office-versions-test-')));
  userData = path.join(dir, 'userData');
  file = path.join(dir, 'plan.docx');
  memo = await readFile(MEMO);
  await writeFile(file, memo);
  watcher.noteOwnWrite.mockClear();
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('the versions store', () => {
  it('keeps a copy and names it in index.json; the same bytes again keep nothing new', async () => {
    const v = await snapshot(userData, file, 'opened', memo);
    expect(v).toMatchObject({ reason: 'opened', bytes: memo.length });
    expect(v!.id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{6}\.\d{3}Z-[0-9a-f]{4}$/);
    const vdir = versionsDir(userData, file);
    expect((await readFile(path.join(vdir, `${v!.id}.docx`))).equals(memo)).toBe(true);
    const index = JSON.parse(await readFile(path.join(vdir, 'index.json'), 'utf8'));
    expect(typeof index.updatedAt).toBe('string');
    expect(index.versions.map((x: { id: string }) => x.id)).toEqual([v!.id]);
    await expect(snapshot(userData, file, 'autosave', memo)).resolves.toBeNull();
    expect(await list(userData, file)).toHaveLength(1);
  });

  // POSIX permissions (Windows has none to compare).
  it.skipIf(process.platform === 'win32')('keeps the copies private to this account', async () => {
    const v = await snapshot(userData, file, 'opened', memo);
    const vdir = versionsDir(userData, file);
    expect((await stat(vdir)).mode & 0o077).toBe(0);
    expect((await stat(path.join(vdir, `${v!.id}.docx`))).mode & 0o077).toBe(0);
  });

  it('lists versions newest first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 28, 9, 0));
    await snapshot(userData, file, 'opened', doc('one'));
    vi.setSystemTime(new Date(2026, 8, 28, 9, 20));
    await snapshot(userData, file, 'autosave', doc('two'));
    vi.setSystemTime(new Date(2026, 8, 28, 9, 40));
    await snapshot(userData, file, 'autosave', doc('three'));
    const got = await list(userData, file);
    expect(got.map((v) => v.at)).toEqual([
      new Date(2026, 8, 28, 9, 40).toISOString(),
      new Date(2026, 8, 28, 9, 20).toISOString(),
      new Date(2026, 8, 28, 9, 0).toISOString(),
    ]);
    expect(got.map((v) => v.reason)).toEqual(['autosave', 'autosave', 'opened']);
  });

  it('two snapshots of one file at once both end up in the index', async () => {
    await Promise.all([snapshot(userData, file, 'opened', doc('a')), snapshot(userData, file, 'autosave', doc('bb'))]);
    expect((await list(userData, file)).map((v) => v.bytes).sort()).toEqual([5, 6]);
  });

  it('restores a kept copy: keeps the current file first as before-restore, then replaces it', async () => {
    const opened = await snapshot(userData, file, 'opened', memo);
    const edited = doc('edited since');
    await writeFile(file, edited);
    if (process.platform !== 'win32') await chmod(file, 0o640);
    await expect(restore(userData, file, opened!.id)).resolves.toEqual({ ok: true });
    expect((await readFile(file)).equals(memo)).toBe(true);
    // The file keeps its own permissions, as a save does.
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o640);
    const versions = await list(userData, file);
    expect(versions[0].reason).toBe('before-restore');
    const vdir = versionsDir(userData, file);
    expect((await readFile(path.join(vdir, `${versions[0].id}.docx`))).equals(edited)).toBe(true);
    expect(watcher.noteOwnWrite).toHaveBeenCalledWith(file);
    // Nothing is left beside the file (the private write folder is removed).
    expect((await readdir(dir)).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('says a version that is no longer kept cannot be restored, and leaves the file alone', async () => {
    await snapshot(userData, file, 'opened', memo);
    await expect(restore(userData, file, '2020-01-01T000000.000Z-abcd')).resolves.toEqual({ ok: false, message: 'That version is no longer kept.' });
    await expect(restore(userData, file, '../../etc/passwd')).resolves.toEqual({ ok: false, message: 'That version is no longer kept.' });
    expect((await readFile(file)).equals(memo)).toBe(true);
  });

  it('refuses a damaged kept copy rather than write it over the file', async () => {
    const v = await snapshot(userData, file, 'opened', doc('whole'));
    await writeFile(path.join(versionsDir(userData, file), `${v!.id}.docx`), 'not a document');
    const r = await restore(userData, file, v!.id);
    expect(r.ok).toBe(false);
    expect((await readFile(file)).equals(memo)).toBe(true);
  });

  it('keeps each file to its own rules after every snapshot', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date(2026, 8, 28, 9, 0).getTime();
    for (let i = 0; i < 55; i++) {
      vi.setSystemTime(start + i * 60_000);
      await snapshot(userData, file, 'autosave', doc(`v${i}`));
    }
    const got = await list(userData, file);
    expect(got).toHaveLength(50);
    expect(got.at(-1)!.at).toBe(new Date(start + 5 * 60_000).toISOString());
    const vdir = versionsDir(userData, file);
    expect((await readdir(vdir)).filter((n) => n.endsWith('.docx'))).toHaveLength(50);
  });

  it('holds all files together under the total limit, letting the oldest go first but never a file\'s newest', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const other = path.join(dir, 'budget.xlsx');
    const at = (h: number) => vi.setSystemTime(new Date(2026, 8, 28, h, 0));
    at(8); await snapshot(userData, file, 'opened', doc('a'.repeat(96)));   // 100 bytes, oldest
    at(9); await snapshot(userData, other, 'opened', doc('b'.repeat(96)));
    at(10); await snapshot(userData, file, 'autosave', doc('c'.repeat(96)));
    at(11); await snapshot(userData, other, 'autosave', doc('d'.repeat(96)));
    at(12);
    await pruneAll(userData, new Date(), 250);
    expect((await list(userData, file)).map((v) => v.at)).toEqual([new Date(2026, 8, 28, 10).toISOString()]);
    expect((await list(userData, other)).map((v) => v.at)).toEqual([new Date(2026, 8, 28, 11).toISOString()]);
    // Still over a limit smaller than one copy each: the newest of each file stays anyway.
    await pruneAll(userData, new Date(), 10);
    expect(await list(userData, file)).toHaveLength(1);
    expect(await list(userData, other)).toHaveLength(1);
  });

  it('names a kept copy again when a crash left it out of the index, rather than deleting it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 28, 9, 0));
    const v = await snapshot(userData, file, 'opened', doc('kept'));
    const vdir = versionsDir(userData, file);
    await writeFile(path.join(vdir, 'index.json'), '{ broken');
    vi.setSystemTime(new Date(2026, 8, 28, 12, 0));
    expect((await list(userData, file)).map((x) => x.id)).toEqual([v!.id]);
  });
});
