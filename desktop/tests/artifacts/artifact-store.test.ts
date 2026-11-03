import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync, promises as fsPromises } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readSidecar, writeSidecar, appendVersion, appendVersionsDirect, removeArtifactRecord, runSidecarMigration, renameArtifact, repairRelativeExternals, readSidecarShared, _resetSidecarCacheForTests } from '../../src/main/artifacts/artifact-store';
import type { ProjectSidecar } from '../../src/shared/artifacts/types';
import { SIDECAR_SCHEMA_VERSION } from '../../src/shared/artifacts/types';
import sampleJson from '../../../shared-fixtures/artifacts/sample-sidecar.json';

// WHY cast: the JSON import widens `$schema`/`kind`/`status` to number/string, so it
// can't satisfy ProjectSidecar's literal unions even though the runtime shape matches.
const sample = sampleJson as unknown as ProjectSidecar;

/** An appendVersion input for an internal file; override only what a test cares about. */
const V = (path: string, o: Record<string, unknown> = {}) =>
  ({ path, kind: 'internal' as const, absolutePath: null, sessionId: 's', type: 'create' as const, author: 'agent' as const, ...o }) as any;

// WHY: the 60-iteration concurrency loop does real fs work (~1.3s alone, inflates under a loaded pool); bound the file explicitly.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe('readSidecar', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'as-read-'));
    mkdirSync(join(projectRoot, '.youcoded'));
  });

  it('returns null when sidecar does not exist', async () => {
    const sidecar = await readSidecar(projectRoot);
    expect(sidecar).toBeNull();
  });

  it('parses a well-formed sidecar', async () => {
    writeFileSync(join(projectRoot, '.youcoded/artifacts.json'), JSON.stringify(sample));
    const sidecar = await readSidecar(projectRoot);
    // WHY cast: readSidecar returns ProjectSidecar | {corrupted:true}; this fixture is well-formed.
    const parsed = sidecar as ProjectSidecar | null;
    expect(parsed?.projectId).toBe('01HXAB000000000000000000');
    expect(parsed?.artifacts).toHaveLength(1);
  });

  it('returns {corrupted: true} on parse failure and backs up the file', async () => {
    writeFileSync(join(projectRoot, '.youcoded/artifacts.json'), '{ not valid json');
    const sidecar = await readSidecar(projectRoot);
    expect(sidecar).toEqual({ corrupted: true });
    const { readdirSync } = await import('fs');
    const files = readdirSync(join(projectRoot, '.youcoded'));
    expect(files.some(f => f.startsWith('artifacts.json.bak.'))).toBe(true);
  });
});

describe('writeSidecar', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'as-write-'));
  });

  it('creates sidecar atomically when none exists', async () => {
    const sidecar = { ...sample, updatedAt: '2026-05-21T15:00:00.000Z' };
    const result = await writeSidecar(projectRoot, null, sidecar);
    expect(result.committed).toBe(true);
    const onDisk = await readSidecar(projectRoot);
    expect(onDisk).toMatchObject({ projectId: sidecar.projectId });
  });

  it('CAS rejects when updatedAt does not match', async () => {
    mkdirSync(join(projectRoot, '.youcoded'));
    writeFileSync(
      join(projectRoot, '.youcoded/artifacts.json'),
      JSON.stringify({ ...sample, updatedAt: '2026-05-22T00:00:00.000Z' })
    );
    const updated = { ...sample, updatedAt: '2026-05-21T15:00:00.000Z' };
    const result = await writeSidecar(projectRoot, sample.updatedAt, updated);
    expect(result.committed).toBe(false);
  });
});

describe('appendVersion', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'as-append-'));
  });

  it('creates a new artifact when path is unseen', async () => {
    await appendVersion(projectRoot, sample.projectId, sample.name, V('docs/new.md', {sessionId: 'sess-1' }));
    const sidecar = await readSidecar(projectRoot);
    expect((sidecar as ProjectSidecar).artifacts[0].path).toBe('docs/new.md');
    expect((sidecar as ProjectSidecar).artifacts[0].versions).toHaveLength(1);
  });

  it('appends a version to an existing artifact', async () => {
    await appendVersion(projectRoot, sample.projectId, sample.name, V('docs/x.md', {sessionId: 'sess-1' }));
    await appendVersion(projectRoot, sample.projectId, sample.name, V('docs/x.md', {sessionId: 'sess-1', type: 'edit' }));
    const sidecar = await readSidecar(projectRoot);
    expect((sidecar as ProjectSidecar).artifacts).toHaveLength(1);
    expect((sidecar as ProjectSidecar).artifacts[0].versions).toHaveLength(2);
  });

  it('retries on CAS conflict up to MAX_RETRIES', async () => {
    await appendVersion(projectRoot, sample.projectId, sample.name, V('a.md'));
    const [r1, r2] = await Promise.all([
      appendVersion(projectRoot, sample.projectId, sample.name, V('b.md')),
      appendVersion(projectRoot, sample.projectId, sample.name, V('c.md')),
    ]);
    expect(r1.committed).toBe(true);
    expect(r2.committed).toBe(true);
    const sidecar = await readSidecar(projectRoot) as ProjectSidecar;
    expect(sidecar.artifacts).toHaveLength(3);
  });

  // WHY: the create path was once not CAS-guarded: two writers that both found NO sidecar each built a fresh page-one and the
  // second silently overwrote the first, both reporting committed. Deterministic, so 3 iterations (the ABA sibling below needs 60).
  it('two concurrent FIRST-EVER writes lose no record (ROADMAP L696)', async () => {
    // THREE iterations, not the 60 its ABA sibling below needs. That one races a
    // millisecond-resolution timestamp and only loses a record when both writes
    // land in the same tick; this one is deterministic — both callers await
    // readSidecar before either writes, so every iteration reproduces it
    // (verified: it fails on iteration 1 with the guard removed). The extra
    // iterations bought nothing and cost real filesystem churn — mkdtemp, two
    // lock-guarded fsync'd writes and a recursive delete apiece — in a suite
    // that runs in parallel with the FSEvents watcher tests that go red on the
    // macOS CI leg under exactly that kind of load
    // (docs/active/investigations/2026-09-01-sync-engine-debounce-macos-flake.md).
    for (let i = 0; i < 3; i++) {
      const root = mkdtempSync(join(tmpdir(), 'as-create-race-'));
      try {
        // appendVersionsDirect, not appendVersion (which coalesces same-process callers): a second YouCoded instance still races here.
        const [a, b] = await Promise.all([
          appendVersionsDirect(root, sample.projectId, sample.name, [V('a.md')]),
          appendVersionsDirect(root, sample.projectId, sample.name, [V('b.md')]),
        ]);
        expect(a[0].committed).toBe(true);
        expect(b[0].committed).toBe(true);
        const sidecar = await readSidecar(root) as ProjectSidecar;
        expect(sidecar.artifacts.map((x) => x.path).sort()).toEqual(['a.md', 'b.md']);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('a corrupt sidecar is still replaced, not refused (ROADMAP L696)', async () => {
    // Corruption recovery deliberately overwrites what is on disk, so the must-not-exist rule must not catch it (else the user is stuck).
    const root = mkdtempSync(join(tmpdir(), 'as-corrupt-'));
    try {
      mkdirSync(join(root, '.youcoded'), { recursive: true });
      writeFileSync(join(root, '.youcoded', 'artifacts.json'), '{ this is not json');
      const [r] = await appendVersionsDirect(root, sample.projectId, sample.name, [V('a.md')]);
      expect(r.committed).toBe(true);
      const sidecar = await readSidecar(root) as ProjectSidecar;
      expect(sidecar.artifacts.map((x) => x.path)).toEqual(['a.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // WHY: a same-millisecond CAS ABA once lost a record (needs both writes inside one ms). 60 iterations make it fail every run; if it goes
  // red, a writer produced an updatedAt that does not advance. Uses appendVersionsDirect: appendVersion coalesces same-process callers.
  it('concurrent appends never lose a record (same-millisecond CAS)', async () => {
    for (let i = 0; i < 60; i++) {
      const root = mkdtempSync(join(tmpdir(), 'as-aba-'));
      await appendVersion(root, sample.projectId, sample.name, V('a.md'));
      await Promise.all([
        appendVersionsDirect(root, sample.projectId, sample.name, [V('b.md')]),
        appendVersionsDirect(root, sample.projectId, sample.name, [V('c.md')]),
      ]);
      const s = await readSidecar(root) as ProjectSidecar;
      expect(s.artifacts.map((a) => a.path).sort()).toEqual(['a.md', 'b.md', 'c.md']);
      // 60 iterations x every run x CI — clean up rather than leak temp dirs.
      rmSync(root, { recursive: true, force: true });
    }
  });

  // WHY: the tracker fires appendVersion once per replayed tool call (~1,000 for a long session); each used to parse and rewrite the
  // whole sidecar concurrently until the main process ran out of memory. Callers now coalesce into one read and write per drain.
  describe('burst coalescing', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('applies a burst of concurrent appends in a handful of read/write cycles, all committed', async () => {
      const N = 300;
      const readSpy = vi.spyOn(fsPromises, 'readFile');
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) => appendVersion(projectRoot, sample.projectId, sample.name, {
          path: `docs/f${i % 50}.md`, kind: 'internal', absolutePath: null,
          sessionId: 'sess-burst', type: i % 2 ? 'edit' : 'create', author: 'agent',
          toolUseId: `toolu_${i}`,
        }))
      );
      expect(results.every((r) => r.committed && r.artifactId)).toBe(true);
      const sidecar = (await readSidecar(projectRoot)) as ProjectSidecar;
      expect(sidecar.artifacts).toHaveLength(50);
      expect(sidecar.artifacts.reduce((n, a) => n + a.versions.length, 0)).toBe(N);
      // The old code read the sidecar N times (plus N CAS re-reads). Batching
      // brings it to a few — the first call drains alone, the rest land in
      // one or two follow-up batches. Bound generously; the point is "not N".
      const sidecarReads = readSpy.mock.calls.filter((c) => String(c[0]).endsWith('artifacts.json')).length;
      expect(sidecarReads).toBeLessThan(N / 10);
    });

    it('a rejected batch rejects every caller in it and the queue keeps working afterwards', async () => {
      // Append now reuses the shared parsed copy and skips the read when the file is absent: give it a
      // real file and a cold cache so the injected read failure is actually hit.
      await appendVersion(projectRoot, sample.projectId, sample.name, V('seed.md'));
      _resetSidecarCacheForTests();
      const spy = vi.spyOn(fsPromises, 'readFile').mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));
      const p1 = appendVersion(projectRoot, sample.projectId, sample.name, V('x.md'));
      await expect(p1).rejects.toThrow('EIO');
      spy.mockRestore();
      const r2 = await appendVersion(projectRoot, sample.projectId, sample.name, V('y.md'));
      expect(r2.committed).toBe(true);
    });
  });

  // WHY: re-opening a conversation replays every tool call through the tracker; toolUseId is the stable identity across replays.
  describe('replay dedupe by (sessionId, toolUseId)', () => {
    const base = {
      path: 'docs/plan.md', kind: 'internal' as const, absolutePath: null,
      sessionId: 'sess-1', type: 'edit' as const, author: 'agent' as const,
    };

    it('the same tool call appended twice yields ONE version and leaves the file byte-identical', async () => {
      const first = await appendVersion(projectRoot, sample.projectId, sample.name, { ...base, toolUseId: 'toolu_A' });
      const bytes = readFileSync(join(projectRoot, '.youcoded/artifacts.json'), 'utf8');
      const again = await appendVersion(projectRoot, sample.projectId, sample.name, { ...base, toolUseId: 'toolu_A' });
      expect(again).toEqual({ committed: true, artifactId: first.artifactId, deduped: true });
      expect(readFileSync(join(projectRoot, '.youcoded/artifacts.json'), 'utf8')).toBe(bytes);
      const sidecar = (await readSidecar(projectRoot)) as ProjectSidecar;
      expect(sidecar.artifacts[0].versions).toHaveLength(1);
      expect(sidecar.artifacts[0].versions[0].toolUseId).toBe('toolu_A');
    });

    it('a different tool call on the same file is a new version; the same id in another session is too', async () => {
      await appendVersion(projectRoot, sample.projectId, sample.name, { ...base, toolUseId: 'toolu_A' });
      await appendVersion(projectRoot, sample.projectId, sample.name, { ...base, toolUseId: 'toolu_B' });
      await appendVersion(projectRoot, sample.projectId, sample.name, { ...base, sessionId: 'sess-2', toolUseId: 'toolu_A' });
      const sidecar = (await readSidecar(projectRoot)) as ProjectSidecar;
      expect(sidecar.artifacts[0].versions).toHaveLength(3);
    });

    it('a duplicate inside one batch is deduped against the version appended earlier in that batch', async () => {
      const [r1, r2] = await Promise.all([
        appendVersion(projectRoot, sample.projectId, sample.name, { ...base, toolUseId: 'toolu_A' }),
        appendVersion(projectRoot, sample.projectId, sample.name, { ...base, toolUseId: 'toolu_A' }),
      ]);
      expect(r1.artifactId).toBe(r2.artifactId);
      expect([r1.deduped, r2.deduped].filter(Boolean)).toHaveLength(1);
      const sidecar = (await readSidecar(projectRoot)) as ProjectSidecar;
      expect(sidecar.artifacts[0].versions).toHaveLength(1);
    });

    it('stamps the conversation id when the caller knows it, and omits it otherwise', async () => {
      await appendVersion(projectRoot, sample.projectId, sample.name, { ...base, toolUseId: 'toolu_C', conversationId: 'claude-X' });
      await appendVersion(projectRoot, sample.projectId, sample.name, { ...base, toolUseId: 'toolu_D' });
      const sidecar = (await readSidecar(projectRoot)) as ProjectSidecar;
      expect(sidecar.artifacts[0].versions[0].conversationId).toBe('claude-X');
      expect(sidecar.artifacts[0].versions[1]).not.toHaveProperty('conversationId');
    });

    it('callers with no toolUseId keep the old always-append behaviour', async () => {
      await appendVersion(projectRoot, sample.projectId, sample.name, base);
      await appendVersion(projectRoot, sample.projectId, sample.name, base);
      const sidecar = (await readSidecar(projectRoot)) as ProjectSidecar;
      expect(sidecar.artifacts[0].versions).toHaveLength(2);
      expect(sidecar.artifacts[0].versions[0]).not.toHaveProperty('toolUseId');
    });
  });

  // A committed write always leaves a token strictly greater than the one the writer read, else a stale reader passes CAS.
  it('a committed write always advances updatedAt past the expected token', async () => {
    await appendVersion(projectRoot, sample.projectId, sample.name, V('a.md'));
    const before = (await readSidecar(projectRoot)) as ProjectSidecar;
    // Same-millisecond write: hand back a timestamp that has NOT moved.
    const next = { ...before, updatedAt: before.updatedAt };
    const res = await writeSidecar(projectRoot, before.updatedAt, next);
    expect(res.committed).toBe(true);
    const after = (await readSidecar(projectRoot)) as ProjectSidecar;
    expect(after.updatedAt > before.updatedAt).toBe(true);
    // The in-memory object the caller still holds matches disk.
    expect(next.updatedAt).toBe(after.updatedAt);
  });
});

describe('appendVersion — read semantics + artifact id', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'as-read-sem-'));
  });

  it('returns the artifact id (new and existing records)', async () => {
    const first = await appendVersion(projectRoot, 'p1', 'proj', V('a.md'));
    expect(first.artifactId).toBeTruthy();
    const second = await appendVersion(projectRoot, 'p1', 'proj', V('a.md', {type: 'edit' }));
    // Same record -> same id (feeds the artifacts:changed broadcast the edit-conflict banner matches on).
    expect(second.artifactId).toBe(first.artifactId);
  });

  // A view or a hand-over is not a modification: neither may jump the record to the top of "recently modified".
  it.each([['read', 'user'], ['delivered', 'agent']] as const)("a '%s' version does NOT bump lastModified on an existing record", async (type, author) => {
    await appendVersion(projectRoot, 'p1', 'proj', V('a.md', { type: 'edit' }));
    const stamp = ((await readSidecar(projectRoot)) as ProjectSidecar).artifacts[0].lastModified;
    await new Promise((r) => setTimeout(r, 5));
    await appendVersion(projectRoot, 'p1', 'proj', V('a.md', { sessionId: 's2', type, author, ...(type === 'delivered' ? { toolUseId: 'toolu_d' } : {}) }));
    const after = (await readSidecar(projectRoot)) as ProjectSidecar;
    expect(after.artifacts[0].lastModified).toBe(stamp);
    expect(after.artifacts[0].versions).toHaveLength(2); // still recorded
    expect(after.artifacts[0].versions.at(-1)?.type).toBe(type);
  });
});

describe('removeArtifactRecord', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'as-remove-'));
  });

  it('removes the tracking record (never touches disk files)', async () => {
    const { artifactId } = await appendVersion(projectRoot, 'p1', 'proj', V('a.md'));
    const res = await removeArtifactRecord(projectRoot, artifactId!);
    expect(res.ok).toBe(true);
    const sidecar = (await readSidecar(projectRoot)) as ProjectSidecar;
    expect(sidecar.artifacts).toHaveLength(0);
  });

  it('reports artifact-not-found for unknown ids', async () => {
    await appendVersion(projectRoot, 'p1', 'proj', V('a.md'));
    const res = await removeArtifactRecord(projectRoot, 'nope');
    expect(res).toEqual({ ok: false, error: 'artifact-not-found' });
  });
});

describe('runSidecarMigration', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'as-migrate-'));
    mkdirSync(join(projectRoot, '.youcoded'), { recursive: true });
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  const legacy = () => ({
    $schema: SIDECAR_SCHEMA_VERSION, projectId: 'p', name: 'proj',
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
    artifacts: [{
      id: 'art_A', path: 'play.html', kind: 'external' as const,
      absolutePath: 'flappy-bird/play.html',
      lastModified: '2026-08-13T00:00:00.000Z', status: 'active' as const,
      versions: [], comments: [], tags: [],
    }],
    manualExcludes: [], manualIncludes: [],
  });

  it('repairs relative externals and is a no-op on the second call', async () => {
    await writeSidecar(projectRoot, null, legacy() as any);

    // A repair that rewrites artifact history must announce what it rewrote and where the backup is.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await runSidecarMigration(projectRoot);
    expect(first).toMatchObject({ migrated: true, reclassified: 1, merged: 0 });
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    warn.mockRestore();
    expect(said).toContain('1 record(s) reclassified');
    expect(said).toContain('flappy-bird/play.html -> flappy-bird/play.html');
    expect(said).toContain('.pre-migration.bak');

    const after = await readSidecar(projectRoot) as ProjectSidecar;
    expect(after.artifacts[0]).toMatchObject({
      path: 'flappy-bird/play.html', kind: 'internal', absolutePath: null,
    });

    // The second call short-circuits on the in-process memo (cheap, worth pinning); the cold-memo test below covers the real gate.
    const second = await runSidecarMigration(projectRoot);
    expect(second).toMatchObject({ migrated: false, reclassified: 0 });
    const unchanged = await readSidecar(projectRoot) as ProjectSidecar;
    expect(unchanged.updatedAt).toBe(after.updatedAt);   // it did not rewrite
  });

  // WHY: vi.resetModules() + re-import gives a brand-new empty memo, so the already-repaired sidecar on disk is what must decline
  // the rewrite (else every LIST_SESSION call would rewrite it, or a peer device's fresh relative record would never be repaired).
  it('declines to rewrite an already-repaired sidecar even with a cold memo', async () => {
    await writeSidecar(projectRoot, null, legacy() as any);
    await runSidecarMigration(projectRoot);
    const after = await readSidecar(projectRoot) as ProjectSidecar;

    vi.resetModules();
    const fresh = await import('../../src/main/artifacts/artifact-store');
    const second = await fresh.runSidecarMigration(projectRoot);
    expect(second).toEqual({ migrated: false, reclassified: 0, merged: 0 });

    const unchanged = await readSidecar(projectRoot) as ProjectSidecar;
    expect(unchanged.updatedAt).toBe(after.updatedAt);   // genuinely declined to rewrite
  });

  it('does not write, or back up, a sidecar with nothing to repair', async () => {
    const clean = legacy();
    clean.artifacts[0] = { ...clean.artifacts[0], kind: 'internal' as any, absolutePath: null as unknown as string };
    await writeSidecar(projectRoot, null, clean as any);

    const res = await runSidecarMigration(projectRoot);
    expect(res.migrated).toBe(false);
    expect(readdirSync(join(projectRoot, '.youcoded')).filter((f) => f.includes('.bak'))).toHaveLength(0);
  });

  // The backup must hold the exact pre-migration bytes (restorable) and the live file must have changed (else a no-op migration passes trivially).
  it('backs the sidecar up under a fixed name before rewriting it', async () => {
    await writeSidecar(projectRoot, null, legacy() as any);
    const sidecarPath = join(projectRoot, '.youcoded/artifacts.json');
    const preMigrationBytes = readFileSync(sidecarPath, 'utf8');

    await runSidecarMigration(projectRoot);

    const backups = readdirSync(join(projectRoot, '.youcoded'))
      .filter((f) => f.startsWith('artifacts.json.pre-migration'));
    expect(backups).toEqual(['artifacts.json.pre-migration.bak']);

    const backupPath = join(projectRoot, '.youcoded/artifacts.json.pre-migration.bak');
    expect(readFileSync(backupPath, 'utf8')).toBe(preMigrationBytes);
    expect(readFileSync(sidecarPath, 'utf8')).not.toBe(preMigrationBytes);
  });

  // WHY: the backup is the only way back from a bad migration, so a retry must never clobber the OLDEST copy (COPYFILE_EXCL + swallowed EEXIST).
  it('never overwrites an existing backup', async () => {
    await writeSidecar(projectRoot, null, legacy() as any);
    const backupPath = join(projectRoot, '.youcoded/artifacts.json.pre-migration.bak');
    writeFileSync(backupPath, 'SENTINEL-PRE-EXISTING-BACKUP');

    const res = await runSidecarMigration(projectRoot);
    expect(res.migrated).toBe(true);   // migration itself still proceeds
    expect(readFileSync(backupPath, 'utf8')).toBe('SENTINEL-PRE-EXISTING-BACKUP');
  });

  // WHY: runSidecarMigration runs inside read-only list handlers whose callers have no .catch, so an unexpected copy/write error
  // (ENOSPC, EROFS, EACCES) must never throw: report nothing migrated and don't retry the doomed work every call.
  it('resolves to the NOTHING result — never throws — when the backup copy fails unexpectedly', async () => {
    await writeSidecar(projectRoot, null, legacy() as any);

    const copySpy = vi.spyOn(fsPromises, 'copyFile').mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    );

    await expect(runSidecarMigration(projectRoot)).resolves.toEqual({
      migrated: false, reclassified: 0, merged: 0,
    });

    // The failed repair must not have committed a half-done rewrite.
    const after = await readSidecar(projectRoot) as ProjectSidecar;
    expect(after.artifacts[0].kind).toBe('external');

    // Memoized on failure too: a second call must not retry the same doomed
    // copyFile — it should short-circuit on the memo before reaching it.
    await runSidecarMigration(projectRoot);
    expect(copySpy).toHaveBeenCalledTimes(1);

    copySpy.mockRestore();
  });
});

describe('renameArtifact — guards against a relative absolutePath', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'as-rename-guard-'));
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  // WHY: a RELATIVE absolutePath must never reach fs.access/fs.rename, which would resolve it against the process cwd (a real mutation outside the project).
  it('refuses to rename an external record whose absolutePath is a relative string', async () => {
    const { artifactId } = await appendVersion(projectRoot, 'p1', 'proj', {
      path: 'play.html', kind: 'external', absolutePath: 'flappy-bird/play.html',
      sessionId: 's', type: 'create', author: 'agent',
    });

    const accessSpy = vi.spyOn(fsPromises, 'access');
    const renameSpy = vi.spyOn(fsPromises, 'rename');

    const result = await renameArtifact(projectRoot, artifactId!, 'renamed');

    expect(result).toEqual({ ok: false, error: 'no-path' });
    // Neither the collision check nor the actual rename may touch the
    // filesystem with a path built from the unguarded relative string.
    expect(accessSpy).not.toHaveBeenCalled();
    expect(renameSpy).not.toHaveBeenCalled();

    // The record itself must be untouched.
    const sidecar = await readSidecar(projectRoot) as ProjectSidecar;
    expect(sidecar.artifacts[0].absolutePath).toBe('flappy-bird/play.html');

    accessSpy.mockRestore();
    renameSpy.mockRestore();
  });

  // The guard must not over-fire: a genuinely absolute external path still renames.
  it('still renames an external record with a genuinely absolute absolutePath', async () => {
    const filePath = join(projectRoot, 'outside.txt');
    writeFileSync(filePath, 'hello');
    const { artifactId } = await appendVersion(projectRoot, 'p1', 'proj', {
      path: 'outside.txt', kind: 'external', absolutePath: filePath,
      sessionId: 's', type: 'create', author: 'agent',
    });

    const result = await renameArtifact(projectRoot, artifactId!, 'renamed-outside');
    expect(result.ok).toBe(true);

    const sidecar = await readSidecar(projectRoot) as ProjectSidecar;
    expect(sidecar.artifacts[0].absolutePath).toBe(join(projectRoot, 'renamed-outside.txt').replace(/\\/g, '/'));
  });
});

// WHY: the CAS check must not unpack the on-disk file to read its one timestamp (out-of-memory fix; read side: sidecar-cache.test.ts).
describe('writeSidecar — CAS check reads the timestamp without parsing the file', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'as-cas-probe-'));
    mkdirSync(join(projectRoot, '.youcoded'));
    writeFileSync(join(projectRoot, '.youcoded', 'artifacts.json'), JSON.stringify(sample, null, 2));
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(projectRoot, { recursive: true, force: true }); });

  it('commits a matching write with ZERO JSON.parse calls on the CAS path', async () => {
    const cur = (await readSidecar(projectRoot)) as ProjectSidecar;
    const parse = vi.spyOn(JSON, 'parse');
    const res = await writeSidecar(projectRoot, cur.updatedAt, cur);
    expect(res.committed).toBe(true);
    expect(parse).not.toHaveBeenCalled();
  });

  it('still rejects a stale token', async () => {
    const cur = (await readSidecar(projectRoot)) as ProjectSidecar;
    const res = await writeSidecar(projectRoot, '2000-01-01T00:00:00.000Z', cur);
    expect(res.committed).toBe(false);
  });
});

// Files the agent wrote through `../`: repaired only inside a saved project folder and outside the deny list; the rest stays refused.
describe('repairRelativeExternals', () => {
  let parent: string;
  let projectRoot: string;
  let sibling: string;
  beforeEach(() => {
    // `parent` stands in for the home folder: only folders strictly below home
    // can vouch for a `../` record (review 2026-09-23, F1).
    parent = mkdtempSync(join(tmpdir(), 'as-dotdot-'));
    projectRoot = join(parent, 'proj');
    sibling = join(parent, 'notes');
    mkdirSync(join(projectRoot, '.youcoded'), { recursive: true });
    mkdirSync(join(sibling, '.ssh'), { recursive: true });
    writeFileSync(join(sibling, 'plan.md'), 'plan');
    writeFileSync(join(sibling, '.ssh', 'id_rsa'), 'PRIVATE');
    mkdirSync(join(projectRoot, 'sub'), { recursive: true });
    writeFileSync(join(projectRoot, 'here.md'), 'here');
  });
  afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 3 }));

  const rec = (id: string, rel: string) => ({
    id, path: rel.split('/').pop()!, kind: 'external' as const, absolutePath: rel,
    lastModified: '2026-08-13T00:00:00.000Z', status: 'active' as const, versions: [], comments: [], tags: [],
  });
  const sidecarOf = (...artifacts: any[]) => ({
    $schema: SIDECAR_SCHEMA_VERSION, projectId: 'p', name: 'proj',
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
    artifacts, manualExcludes: [], manualIncludes: [],
  }) as any;

  it('gives a ../ file in a saved project folder its real absolute path', async () => {
    const { sidecar, repaired } = await repairRelativeExternals(sidecarOf(rec('a', '../notes/plan.md')), projectRoot, [sibling], parent);
    expect(repaired).toHaveLength(1);
    expect(sidecar.artifacts[0].kind).toBe('external');
    expect(sidecar.artifacts[0].absolutePath).toMatch(/\/notes\/plan\.md$/);
    expect(sidecar.artifacts[0].path).toBe('plan.md');
  });

  it('makes a ../ path that lands back inside the project internal', async () => {
    const { sidecar } = await repairRelativeExternals(sidecarOf(rec('a', 'sub/../here.md')), projectRoot, [], parent);
    expect(sidecar.artifacts[0]).toMatchObject({ kind: 'internal', path: 'here.md', absolutePath: null });
  });

  it('leaves a ../ file outside every project folder untouched', async () => {
    const input = sidecarOf(rec('a', '../notes/plan.md'));
    const { sidecar, repaired } = await repairRelativeExternals(input, projectRoot, [], parent);
    expect(repaired).toEqual([]);
    expect(sidecar.artifacts[0]).toEqual(input.artifacts[0]);
  });

  it('re-runs the repair when the saved-folder list changes, not only once per launch', async () => {
    // The "repair done" memo is keyed on the saved-folder list, so a folder saved mid-session makes its `../` files repairable.
    await writeSidecar(projectRoot, null, sidecarOf(rec('a', '../notes/plan.md')));
    let saved: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await runSidecarMigration(projectRoot, () => saved, parent)).toMatchObject({ migrated: false });
      saved = [sibling];
      expect(await runSidecarMigration(projectRoot, () => saved, parent)).toMatchObject({ migrated: true });
    } finally { warn.mockRestore(); }
    const after = await readSidecar(projectRoot) as ProjectSidecar;
    expect(after.artifacts[0].absolutePath).toMatch(/\/notes\/plan\.md$/);
  });

  it('never repairs a record because the HOME folder is saved as a project', async () => {
    writeFileSync(join(parent, '.git-credentials'), 'https://u:token@github.com');
    const input = sidecarOf(rec('a', '../notes/plan.md'), rec('b', '../.git-credentials'));
    const { repaired } = await repairRelativeExternals(input, projectRoot, [parent], parent);
    expect(repaired).toEqual([]);
  });

  it('never repairs a PLANTED record that points at a secret, even inside a saved folder', async () => {
    const input = sidecarOf(rec('evil', '../notes/.ssh/id_rsa'));
    const { sidecar, repaired } = await repairRelativeExternals(input, projectRoot, [sibling], parent);
    expect(repaired).toEqual([]);
    expect(sidecar.artifacts[0].absolutePath).toBe('../notes/.ssh/id_rsa');
  });
});

// WHY: appends reuse the shared parsed copy (a 27 MB file re-parsed per cycle froze the app) and write compact JSON; the reuse must never
// hide an outside change or edit what readers hold, and the bytes must still parse to the same data.
describe('appendVersion — shared parsed copy + compact file', () => {
  let projectRoot: string;
  const input = (p: string, extra: object = {}) => ({
    path: p, kind: 'internal' as const, absolutePath: null, sessionId: 's', type: 'edit' as const, author: 'agent' as const, ...extra,
  });
  beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), 'as-shared-')); _resetSidecarCacheForTests(); });

  it('parses the file once across many append cycles', async () => {
    await appendVersion(projectRoot, 'p', 'n', input('a.md'));
    const parse = vi.spyOn(JSON, 'parse');
    for (let i = 0; i < 5; i++) await appendVersion(projectRoot, 'p', 'n', input(`f${i}.md`));
    const bigParses = parse.mock.calls.filter(([t]) => typeof t === 'string' && t.length > 200).length;
    parse.mockRestore();
    expect(bigParses).toBe(0);
  });

  it('picks up a change made by another writer between appends', async () => {
    await appendVersion(projectRoot, 'p', 'n', input('a.md'));
    const path = join(projectRoot, '.youcoded/artifacts.json');
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    onDisk.artifacts.push({ id: 'EXT', path: 'external.md', kind: 'internal', absolutePath: null, lastModified: 'x', status: 'active', versions: [], comments: [], tags: [] });
    onDisk.updatedAt = new Date(Date.now() + 5000).toISOString();
    writeFileSync(path, JSON.stringify(onDisk));
    await appendVersion(projectRoot, 'p', 'n', input('b.md'));
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.artifacts.map((a: any) => a.path).sort()).toEqual(['a.md', 'b.md', 'external.md']);
  });

  it('never edits the copy a reader is holding', async () => {
    await appendVersion(projectRoot, 'p', 'n', input('a.md'));
    const held = (await readSidecarShared(projectRoot)) as ProjectSidecar;
    const before = JSON.stringify(held);
    await appendVersion(projectRoot, 'p', 'n', input('a.md'));
    await appendVersion(projectRoot, 'p', 'n', input('c.md'));
    expect(JSON.stringify(held)).toBe(before);
  });

  it('writes compact JSON that reads back to the same data as the indented form', async () => {
    await appendVersion(projectRoot, 'p', 'n', input('a.md'));
    await appendVersion(projectRoot, 'p', 'n', input('a.md'));
    const text = readFileSync(join(projectRoot, '.youcoded/artifacts.json'), 'utf8');
    expect(text).not.toMatch(/\n\s/);                       // no indentation
    const sc = (await readSidecar(projectRoot)) as ProjectSidecar;
    expect(sc.artifacts).toHaveLength(1);
    expect(sc.artifacts[0].versions).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(sc, null, 2))).toEqual(JSON.parse(text));
  });
});

// A writer from another process can replace the sidecar between our committed write and the stat that seeds the shared copy;
// our object must never be cached under THEIR file's stat.
describe('shared sidecar cache — a replace racing our seed', () => {
  let projectRoot: string;
  beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), 'as-race-')); _resetSidecarCacheForTests(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('does not cache our content under the other writer\'s stat, and the next append still commits', async () => {
    await appendVersion(projectRoot, 'p', 'n', V('a.md'));
    const file = join(projectRoot, '.youcoded/artifacts.json');
    const current = JSON.parse(readFileSync(file, 'utf8'));
    // The other process's version of the file: different content, newer token.
    const theirs = { ...current, updatedAt: new Date(Date.now() + 60_000).toISOString(), artifacts: [...current.artifacts, { ...current.artifacts[0], id: 'THEIRS', path: 'theirs.md' }] };
    // Replace the file right after our next write commits, before the seed's stat runs.
    const realRename = fsPromises.rename;
    let swapped = false;
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (from: any, to: any) => {
      await realRename(from, to);
      if (!swapped && String(to).endsWith('artifacts.json')) {
        swapped = true;
        writeFileSync(file + '.theirs', JSON.stringify(theirs));
        await realRename(file + '.theirs', file);
      }
    });
    await appendVersion(projectRoot, 'p', 'n', V('b.md'));
    vi.restoreAllMocks();
    // Readers must see what is on disk (theirs), not the object we wrote.
    const seen = (await readSidecarShared(projectRoot)) as ProjectSidecar;
    expect(seen.artifacts.some((a) => a.id === 'THEIRS')).toBe(true);
    // And appending again must work against the real file (not loop on a stale cache).
    const r = await appendVersion(projectRoot, 'p', 'n', V('c.md'));
    expect(r.committed).toBe(true);
    expect(((await readSidecar(projectRoot)) as ProjectSidecar).artifacts.some((a) => a.path === 'c.md')).toBe(true);
  });

  it('a refused (CAS conflict) write drops the cached copy', async () => {
    await appendVersion(projectRoot, 'p', 'n', V('a.md'));
    const cached = (await readSidecarShared(projectRoot)) as ProjectSidecar;
    const r = await writeSidecar(projectRoot, '1999-01-01T00:00:00.000Z', { ...cached });  // wrong token: refused
    expect(r.committed).toBe(false);
    const parse = vi.spyOn(JSON, 'parse');
    await readSidecarShared(projectRoot);
    expect(parse.mock.calls.some(([t]) => typeof t === 'string' && t.length > 100)).toBe(true); // had to re-read: nothing was cached
  });
});
