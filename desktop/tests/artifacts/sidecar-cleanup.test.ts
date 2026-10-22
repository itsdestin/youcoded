// Sidecar cleanup against REAL temp folders only (never a user's files): archive-first ordering, crash
// points, the brakes, the restore round trip, CAS races, and the pieces around them.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { ArtifactRecord, ProjectSidecar } from '../../src/shared/artifacts/types';
import { SIDECAR_SCHEMA_VERSION } from '../../src/shared/artifacts/types';
import {
  appendVersion, readSidecar, readSidecarShared, enqueueMaintenance, _resetSidecarCacheForTests,
} from '../../src/main/artifacts/artifact-store';
import {
  runCleanup, restoreArchive, surveyProject, noteProjectActive, _resetCleanupSchedulingForTests,
  sidecarFile, ledgerFile, archiveDir, preCleanupBackup,
} from '../../src/main/artifacts/sidecar-cleanup';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-12-01T00:00:00Z');
const LIMITS = { minCandidates: 1, minFraction: 0 };   // tiny fixtures: the real floor is pinned in dead-records.test.ts

let root: string;
const iso = (ms: number) => new Date(ms).toISOString();

function record(id: string, relPath: string, idleDays: number): ArtifactRecord {
  const ts = iso(T0 - idleDays * DAY);
  return { id, path: relPath, kind: 'internal', absolutePath: null, lastModified: ts, status: 'active',
    versions: [{ id: `v-${id}`, ts, sessionId: 's', type: 'edit', author: 'agent' }], comments: [], tags: [] };
}

/** 20 living files (present on disk, recent) + `dead` records whose files do not exist, idle 40+ days. */
function seed(dead = 12): { living: ArtifactRecord[]; dead: ArtifactRecord[] } {
  fs.mkdirSync(path.join(root, '.youcoded'), { recursive: true });
  const living: ArtifactRecord[] = [];
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(path.join(root, `live${i}.md`), 'x');
    living.push(record(`L${i}`, `live${i}.md`, 1));
  }
  const gone = Array.from({ length: dead }, (_, i) => record(`D${i}`, `gone/dir/d${i}.md`, 40 + i));
  const sc: ProjectSidecar = {
    $schema: SIDECAR_SCHEMA_VERSION, projectId: 'p', name: 'n', createdAt: iso(T0 - 100 * DAY), updatedAt: iso(T0 - DAY),
    artifacts: [...living, ...gone], manualExcludes: [], manualIncludes: [],
  };
  fs.writeFileSync(sidecarFile(root), JSON.stringify(sc));
  return { living, dead: gone };
}

const readArchive = (): ArtifactRecord[] => {
  const dir = archiveDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl.gz')).flatMap((n) =>
    zlib.gunzipSync(fs.readFileSync(path.join(dir, n))).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};
const onDisk = (): ProjectSidecar => JSON.parse(fs.readFileSync(sidecarFile(root), 'utf8'));
/** Day-0 survey (first strikes), then the run 8 days later that actually archives. */
async function twoStrikes(extra: Parameters<typeof runCleanup>[1] = {}) {
  // Day 0 only records strikes (nothing is eligible yet, so the size floor answers).
  expect(['nothing-changed', 'below-floor']).toContain((await runCleanup(root, { nowMs: T0, limits: LIMITS })).status);
  return runCleanup(root, { nowMs: T0 + 8 * DAY, limits: LIMITS, ...extra });
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-cleanup-')); _resetSidecarCacheForTests(); });
afterEach(() => { _resetCleanupSchedulingForTests(); vi.useRealTimers(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('runCleanup — the happy path and its gates', () => {
  it('first sweep only records strikes; the sweep 8 days later archives the dead records and keeps the living', async () => {
    const { living, dead } = seed();
    const r = await twoStrikes();
    expect(r).toMatchObject({ status: 'archived', archivedRecords: dead.length });
    expect(onDisk().artifacts.map((a) => a.id).sort()).toEqual(living.map((a) => a.id).sort());
    expect(readArchive().map((a) => a.id).sort()).toEqual(dead.map((a) => a.id).sort());
    expect(readArchive()[0]).toEqual(dead.find((d) => d.id === readArchive()[0].id)); // identical records, not a summary
  });

  it('runs at most once a day per project', async () => {
    seed();
    await runCleanup(root, { nowMs: T0, limits: LIMITS });
    expect((await runCleanup(root, { nowMs: T0 + 3600_000, limits: LIMITS })).status).toBe('skipped-recent');
    expect((await runCleanup(root, { nowMs: T0 + 8 * DAY, limits: LIMITS })).status).toBe('archived');
  });

  it('a file that comes back between the strikes is not archived', async () => {
    const { dead } = seed();
    await runCleanup(root, { nowMs: T0, limits: LIMITS });
    fs.mkdirSync(path.join(root, 'gone/dir'), { recursive: true });
    fs.writeFileSync(path.join(root, 'gone/dir/d0.md'), 'back');
    const r = await runCleanup(root, { nowMs: T0 + 8 * DAY, limits: LIMITS });
    expect(r.archivedRecords).toBe(dead.length - 1);
    expect(onDisk().artifacts.some((a) => a.id === 'D0')).toBe(true);
  });

  it('refuses when the project folder is empty (a missing mount looks like this)', async () => {
    seed();
    for (const n of fs.readdirSync(root)) if (n !== '.youcoded') fs.rmSync(path.join(root, n), { recursive: true, force: true });
    expect((await runCleanup(root, { nowMs: T0, limits: LIMITS })).status).toBe('root-unhealthy');
  });

  it('refuses when the sidecar is absent', async () => {
    fs.mkdirSync(root, { recursive: true });
    expect((await runCleanup(root, { nowMs: T0, limits: LIMITS })).status).toBe('no-sidecar');
  });

  it('writes the one-time backup before the first cleanup and never overwrites it', async () => {
    seed();
    const original = fs.readFileSync(sidecarFile(root), 'utf8');
    await twoStrikes();
    expect(fs.readFileSync(preCleanupBackup(root), 'utf8')).toBe(original);
    // More dead records appear, a later cleanup runs: the backup is still the first state.
    const sc = onDisk();
    sc.artifacts.push(record('LATE', 'late/x.md', 90));
    sc.updatedAt = iso(T0 + 9 * DAY);
    fs.writeFileSync(sidecarFile(root), JSON.stringify(sc));
    _resetSidecarCacheForTests();
    await runCleanup(root, { nowMs: T0 + 10 * DAY, limits: LIMITS });
    await runCleanup(root, { nowMs: T0 + 20 * DAY, limits: LIMITS });
    expect(fs.readFileSync(preCleanupBackup(root), 'utf8')).toBe(original);
  });
});

describe('runCleanup — crash points: a record is never in NEITHER place', () => {
  const idsIn = (recs: ArtifactRecord[]) => new Set(recs.map((r) => r.id));
  const assertNoneLost = (all: ArtifactRecord[]) => {
    const have = new Set([...idsIn(onDisk().artifacts), ...idsIn(readArchive())]);
    for (const r of all) expect(have.has(r.id)).toBe(true);
  };

  it('the sidecar write fails after the archive is written: archive exists, sidecar still full, rerun is clean', async () => {
    const { living, dead } = seed();
    await expect(twoStrikes({ hooks: { writeSidecar: async () => { throw new Error('disk full'); } } })).rejects.toThrow('disk full');
    expect(readArchive()).toHaveLength(dead.length);
    expect(onDisk().artifacts).toHaveLength(living.length + dead.length);
    assertNoneLost([...living, ...dead]);
    // Rerun (the next day): archive again (duplicates by id are harmless), sidecar shrinks.
    _resetSidecarCacheForTests();
    const again = await runCleanup(root, { nowMs: T0 + 9 * DAY, limits: LIMITS });
    expect(again.status).toBe('archived');
    expect(onDisk().artifacts).toHaveLength(living.length);
    assertNoneLost([...living, ...dead]);
  });

  it('a crash right after the archive rename (before the sidecar write) loses nothing', async () => {
    const { living, dead } = seed();
    await expect(twoStrikes({ hooks: { afterArchive: () => { throw new Error('killed'); } } })).rejects.toThrow('killed');
    assertNoneLost([...living, ...dead]);
    expect(onDisk().artifacts).toHaveLength(living.length + dead.length);
  });

  it('a crash before the archive is renamed into place leaves the sidecar untouched and no archive', async () => {
    const { living, dead } = seed();
    await expect(twoStrikes({ hooks: { beforeArchiveRename: () => { throw new Error('killed'); } } })).rejects.toThrow('killed');
    expect(readArchive()).toEqual([]);
    expect(onDisk().artifacts).toHaveLength(living.length + dead.length);
  });
});

describe('runCleanup — races', () => {
  it('another writer changes the sidecar after the archive is written: CAS refuses, their change survives', async () => {
    const { living, dead } = seed();
    const r = await twoStrikes({ hooks: { afterArchive: () => {
      const sc = onDisk();
      sc.artifacts.push(record('EXTERNAL', 'ext.md', 0));
      sc.updatedAt = iso(T0 + 9 * DAY);
      fs.writeFileSync(sidecarFile(root), JSON.stringify(sc));
    } } });
    expect(r.status).toBe('conflict');
    const ids = onDisk().artifacts.map((a) => a.id);
    expect(ids).toContain('EXTERNAL');
    expect(ids.length).toBe(living.length + dead.length + 1); // nothing removed
  });

  it('a candidate that gained a version between the survey and the commit is kept', async () => {
    const { dead } = seed();
    const r = await twoStrikes({ hooks: { beforeCommit: async () => {
      await appendVersion(root, 'p', 'n', { path: 'gone/dir/d0.md', kind: 'internal', absolutePath: null, sessionId: 'x', type: 'edit', author: 'agent' });
    } } });
    expect(r.archivedRecords).toBe(dead.length - 1);
    const kept = onDisk().artifacts.find((a) => a.id === 'D0')!;
    expect(kept.versions.length).toBe(2);
  });

  it('an append racing the cleanup is never lost', async () => {
    const { dead } = seed();
    await runCleanup(root, { nowMs: T0, limits: LIMITS });
    const [r] = await Promise.all([
      runCleanup(root, { nowMs: T0 + 8 * DAY, limits: LIMITS }),
      appendVersion(root, 'p', 'n', { path: 'brand-new.md', kind: 'internal', absolutePath: null, sessionId: 'x', type: 'create', author: 'agent' }),
    ]);
    expect(['archived', 'conflict']).toContain(r.status);
    expect(onDisk().artifacts.some((a) => a.path === 'brand-new.md')).toBe(true);
    if (r.status === 'archived') expect(r.archivedRecords).toBe(dead.length);
  });

  it('a maintenance job never overlaps an append cycle: an append that arrives during it waits', async () => {
    seed();
    const events: string[] = [];
    let late: Promise<unknown> = Promise.resolve();
    const job = enqueueMaintenance(root, async () => {
      events.push('job-start');
      late = appendVersion(root, 'p', 'n', { path: 'during.md', kind: 'internal', absolutePath: null, sessionId: 'x', type: 'create', author: 'agent' })
        .then(() => events.push('append-during'));
      await new Promise((r) => setTimeout(r, 40));
      events.push('job-end');
    });
    await job; await late;
    expect(events).toEqual(['job-start', 'job-end', 'append-during']);
  });
});

describe('restoreArchive — the undo path', () => {
  it('round trip: the archived records come back identical, and restoring twice adds nothing', async () => {
    const { dead } = seed();
    await twoStrikes();
    const first = await restoreArchive(root);
    expect(first).toMatchObject({ status: 'restored', restored: dead.length });
    const back = onDisk().artifacts.filter((a) => a.id.startsWith('D'));
    expect(back.sort((x, y) => x.id.localeCompare(y.id))).toEqual([...dead].sort((x, y) => x.id.localeCompare(y.id)));
    const second = await restoreArchive(root);
    expect(second.restored).toBe(0);
    expect(onDisk().artifacts.filter((a) => a.id.startsWith('D'))).toHaveLength(dead.length);
  });

  it('can restore only some ids', async () => {
    seed();
    await twoStrikes();
    expect((await restoreArchive(root, { ids: ['D1', 'D2'] })).restored).toBe(2);
    expect(onDisk().artifacts.filter((a) => a.id.startsWith('D')).map((a) => a.id).sort()).toEqual(['D1', 'D2']);
  });

  it('skips a record whose path was since re-created under a new id', async () => {
    seed();
    await twoStrikes();
    await appendVersion(root, 'p', 'n', { path: 'gone/dir/d0.md', kind: 'internal', absolutePath: null, sessionId: 'x', type: 'create', author: 'agent' });
    const r = await restoreArchive(root, { ids: ['D0'] });
    expect(r.restored).toBe(0);
  });

  it('with no archive it restores nothing and says so', async () => {
    seed();
    expect(await restoreArchive(root)).toMatchObject({ status: 'restored', restored: 0 });
  });
});

describe('surveyProject — what the disk says', () => {
  it('reports ENOENT with a same-device ancestor, ENOTDIR when a file stands where a folder should, and unresolvable externals', async () => {
    fs.writeFileSync(path.join(root, 'afile'), 'x');
    const recs: ArtifactRecord[] = [
      record('present', 'afile', 0),
      record('missing', 'no/such/dir/f.md', 50),
      record('underfile', 'afile/inside.md', 50),
      { ...record('rel', 'x', 50), kind: 'external', absolutePath: '../up/x.md' },
    ];
    const p = await surveyProject(root, recs);
    expect(p.get('present')).toMatchObject({ exists: true });
    expect(p.get('missing')).toMatchObject({ exists: false, errorCode: 'ENOENT', ancestor: { path: root, sameDevice: true, readable: true } });
    expect(p.get('underfile')).toMatchObject({ exists: false, errorCode: 'ENOTDIR', ancestor: { path: root } });
    expect(p.get('rel')).toMatchObject({ target: null, exists: false });
  });

  it('terminates on a path with no slash in it and on an absolute path on no existing volume', async () => {
    const weird = { ...record('w', 'x', 50), kind: 'external' as const, absolutePath: 'noslashrelative' };
    const odd = { ...record('o', 'x', 50), kind: 'external' as const, absolutePath: '/definitely-not-a-real-root-xyz/a/b.md' };
    const p = await surveyProject(root, [weird, odd]);
    expect(p.get('w')?.target).toBeNull();
    expect(p.get('o')?.exists).toBe(false); // ancestor is "/", which exists: the walk ends there, not forever
  });

  it('does not stat everything at once: it pauses between chunks so the app stays responsive', async () => {
    const recs = Array.from({ length: 450 }, (_, i) => record(`r${i}`, `f${i}.md`, 1));
    const setImm = vi.spyOn(globalThis, 'setImmediate');
    await surveyProject(root, recs);
    expect(setImm.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('integration points', () => {
  it('after the commit, readers get the new object with no big parse (the shared copy was re-seeded)', async () => {
    const { living } = seed();
    await readSidecarShared(root);
    await twoStrikes();
    const parse = vi.spyOn(JSON, 'parse');
    const sc = (await readSidecarShared(root)) as ProjectSidecar;
    const bigParses = parse.mock.calls.filter(([t]) => typeof t === 'string' && t.length > 500).length;
    expect(sc.artifacts).toHaveLength(living.length);
    expect(bigParses).toBe(0);
    expect(((await readSidecar(root)) as ProjectSidecar).artifacts).toHaveLength(living.length);
  });

  it('the strike ledger lives in its own small file and holds only dates', async () => {
    seed();
    await runCleanup(root, { nowMs: T0, limits: LIMITS });
    const ledger = JSON.parse(fs.readFileSync(ledgerFile(root), 'utf8'));
    expect(Object.keys(ledger.strikes)).toHaveLength(12);
    expect(Object.values(ledger.strikes).every((v) => typeof v === 'string')).toBe(true);
  });

  it('scheduling arms exactly one unref’d timer per project, however many appends', () => {
    vi.useFakeTimers();
    noteProjectActive(root);
    noteProjectActive(root);
    noteProjectActive(root);
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('scripts/restore-artifact-archive.mjs', () => {
  it('brings archived records back, saves a copy first, and a second run adds nothing', async () => {
    const { dead } = seed();
    await twoStrikes();
    const script = path.join(__dirname, '..', '..', 'scripts', 'restore-artifact-archive.mjs');
    const { execFileSync } = await import('node:child_process');
    const out1 = execFileSync(process.execPath, [script, root], { encoding: 'utf8' });
    expect(out1).toContain(`restored ${dead.length} records`);
    expect(fs.readdirSync(path.join(root, '.youcoded')).some((n) => n.includes('.pre-restore-'))).toBe(true);
    const ids = onDisk().artifacts.filter((a) => a.id.startsWith('D')).map((a) => a.id).sort();
    expect(ids).toEqual(dead.map((d) => d.id).sort());
    const out2 = execFileSync(process.execPath, [script, root], { encoding: 'utf8' });
    expect(out2).toContain('0 to bring back');
  });
});

describe('archive files, durable restore, last look at commit, and offline-drive stubs', () => {
  it('every run writes a NEW archive file and never rewrites an earlier one', async () => {
    seed(12);
    await twoStrikes();
    const first = fs.readdirSync(archiveDir(root)).filter((n) => n.endsWith('.jsonl.gz'));
    const firstBytes = first.map((n) => fs.readFileSync(path.join(archiveDir(root), n)));
    const sc = onDisk();
    for (let i = 0; i < 3; i++) sc.artifacts.push(record(`X${i}`, `more/x${i}.md`, 90));
    sc.updatedAt = iso(T0 + 9 * DAY);
    fs.writeFileSync(sidecarFile(root), JSON.stringify(sc));
    _resetSidecarCacheForTests();
    await runCleanup(root, { nowMs: T0 + 10 * DAY, limits: LIMITS });          // first strike for X*
    expect((await runCleanup(root, { nowMs: T0 + 18 * DAY, limits: LIMITS })).status).toBe('archived');
    const all = fs.readdirSync(archiveDir(root)).filter((n) => n.endsWith('.jsonl.gz'));
    expect(all.length).toBe(2);
    first.forEach((n, i) => expect(fs.readFileSync(path.join(archiveDir(root), n)).equals(firstBytes[i])).toBe(true));
    expect(readArchive().map((r) => r.id).sort()).toEqual([...Array.from({ length: 12 }, (_, i) => `D${i}`), 'X0', 'X1', 'X2'].sort());
  });

  it('removes archive temp files left by an interrupted write (older than an hour) but not fresh ones', async () => {
    seed();
    fs.mkdirSync(archiveDir(root), { recursive: true });
    const old = path.join(archiveDir(root), '2026-10-x.jsonl.gz.tmp.999');
    const fresh = path.join(archiveDir(root), '2026-12-y.jsonl.gz.tmp.998');
    fs.writeFileSync(old, 'x'); fs.writeFileSync(fresh, 'y');
    // The run's clock is injected (T0 + 8 days); age the files relative to that.
    fs.utimesSync(old, new Date(T0 + 8 * DAY - 3 * 3600_000), new Date(T0 + 8 * DAY - 3 * 3600_000));
    fs.utimesSync(fresh, new Date(T0 + 8 * DAY - 60_000), new Date(T0 + 8 * DAY - 60_000));
    await twoStrikes();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('restored records are protected: not archived again, even though their files are still missing', async () => {
    const { dead } = seed();
    await twoStrikes();
    await restoreArchive(root);
    const r = await runCleanup(root, { nowMs: T0 + 20 * DAY, limits: LIMITS });          // first strike pass
    const r2 = await runCleanup(root, { nowMs: T0 + 30 * DAY, limits: LIMITS });         // would be archivable, but protected
    expect([r.status, r2.status]).not.toContain('archived');
    expect(onDisk().artifacts.filter((a) => a.id.startsWith('D'))).toHaveLength(dead.length);
    // After the 90 days are over they become archivable again.
    expect((await runCleanup(root, { nowMs: Date.now() + 100 * DAY, limits: LIMITS })).status).not.toBe('skipped-recent');
  });

  it('a file that comes back after the survey but before the commit is dropped from the batch', async () => {
    const { dead } = seed();
    const r = await twoStrikes({ hooks: { beforeCommit: () => {
      fs.mkdirSync(path.join(root, 'gone/dir'), { recursive: true });
      fs.writeFileSync(path.join(root, 'gone/dir/d3.md'), 'back');
    } } });
    expect(r.archivedRecords).toBe(dead.length - 1);
    expect(onDisk().artifacts.some((a) => a.id === 'D3')).toBe(true);
  });

  it('survey: an empty stub folder and a symlinked folder are not trusted as ancestors', async () => {
    fs.writeFileSync(path.join(root, 'keep.md'), 'x');
    fs.mkdirSync(path.join(root, 'stub'));                                   // empty: what an unmounted drive leaves
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'real-target-'));
    fs.symlinkSync(real, path.join(root, 'link'));
    const recs = [record('s', 'stub/a.md', 90), record('l', 'link/b.md', 90), record('n', 'normal/c.md', 90)];
    const p = await surveyProject(root, recs);
    expect(p.get('s')?.ancestor).toMatchObject({ path: path.join(root, 'stub'), empty: true });
    expect(p.get('l')?.ancestor).toMatchObject({ path: path.join(root, 'link'), viaSymlink: true });
    expect(p.get('n')?.ancestor).toMatchObject({ path: root, isProjectRoot: true, empty: false });
    fs.rmSync(real, { recursive: true, force: true });
  });

  it('a restore pin made while a cleanup survey is running is not erased by the cleanup\'s ledger write', async () => {
    seed();
    await runCleanup(root, { nowMs: T0, limits: LIMITS });                       // strikes
    const r = await runCleanup(root, { nowMs: T0 + 8 * DAY, limits: LIMITS, hooks: { beforeCommit: async () => {
      // the owner restores D1 (pretend it was archived earlier) while this run is between survey and commit
      fs.mkdirSync(archiveDir(root), { recursive: true });
      const ledger = JSON.parse(fs.readFileSync(ledgerFile(root), 'utf8'));
      ledger.keepUntil = { ...(ledger.keepUntil ?? {}), D1: new Date(Date.now() + 90 * DAY).toISOString() };
      fs.writeFileSync(ledgerFile(root), JSON.stringify(ledger));
    } } });
    expect(r.status).toBe('archived');
    const after = JSON.parse(fs.readFileSync(ledgerFile(root), 'utf8'));
    expect(after.keepUntil?.D1).toBeDefined();                                    // the cleanup's own writes kept it
  });

  it('expired restore pins are pruned from the ledger', async () => {
    seed();
    fs.writeFileSync(ledgerFile(root), JSON.stringify({ strikes: {}, keepUntil: { D1: new Date(T0 - DAY).toISOString(), D2: new Date(T0 + 30 * DAY).toISOString() } }));
    await runCleanup(root, { nowMs: T0, limits: LIMITS });
    const after = JSON.parse(fs.readFileSync(ledgerFile(root), 'utf8'));
    expect(Object.keys(after.keepUntil ?? {})).toEqual(['D2']);
  });

  it('a refused sidecar write removes the archive file that run just wrote', async () => {
    seed();
    const r = await twoStrikes({ hooks: { afterArchive: () => {
      const sc = onDisk(); sc.artifacts.push(record('EXT', 'ext.md', 0)); sc.updatedAt = iso(T0 + 9 * DAY);
      fs.writeFileSync(sidecarFile(root), JSON.stringify(sc));
    } } });
    expect(r.status).toBe('conflict');
    expect(fs.readdirSync(archiveDir(root)).filter((n) => n.endsWith('.jsonl.gz'))).toEqual([]);
  });
});
