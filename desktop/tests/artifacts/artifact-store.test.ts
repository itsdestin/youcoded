import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync, promises as fsPromises } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readSidecar, writeSidecar, appendVersion, appendVersionsDirect, removeArtifactRecord, runSidecarMigration, renameArtifact, repairRelativeExternals } from '../../src/main/artifacts/artifact-store';
import type { ProjectSidecar } from '../../src/shared/artifacts/types';
import { SIDECAR_SCHEMA_VERSION } from '../../src/shared/artifacts/types';
import sample from '../../../shared-fixtures/artifacts/sample-sidecar.json';

// The 60-iteration concurrency loop below does real fs work (mkdtemp, fsync,
// rename, rm x60) and takes ~1.3s locally — under vitest's default 5000ms
// testTimeout, but only ~4x headroom, and fs work is exactly what inflates
// under a loaded parallel pool. Bounding the file explicitly keeps this PR from
// trading one load-dependent budget for another.
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
    expect(sidecar?.projectId).toBe('01HXAB000000000000000000');
    expect(sidecar?.artifacts).toHaveLength(1);
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
    await appendVersion(projectRoot, sample.projectId, sample.name, {
      path: 'docs/new.md',
      kind: 'internal',
      absolutePath: null,
      sessionId: 'sess-1',
      type: 'create',
      author: 'agent',
    });
    const sidecar = await readSidecar(projectRoot);
    expect((sidecar as ProjectSidecar).artifacts[0].path).toBe('docs/new.md');
    expect((sidecar as ProjectSidecar).artifacts[0].versions).toHaveLength(1);
  });

  it('appends a version to an existing artifact', async () => {
    await appendVersion(projectRoot, sample.projectId, sample.name, {
      path: 'docs/x.md', kind: 'internal', absolutePath: null,
      sessionId: 'sess-1', type: 'create', author: 'agent',
    });
    await appendVersion(projectRoot, sample.projectId, sample.name, {
      path: 'docs/x.md', kind: 'internal', absolutePath: null,
      sessionId: 'sess-1', type: 'edit', author: 'agent',
    });
    const sidecar = await readSidecar(projectRoot);
    expect((sidecar as ProjectSidecar).artifacts).toHaveLength(1);
    expect((sidecar as ProjectSidecar).artifacts[0].versions).toHaveLength(2);
  });

  it('retries on CAS conflict up to MAX_RETRIES', async () => {
    await appendVersion(projectRoot, sample.projectId, sample.name, {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's', type: 'create', author: 'agent',
    });
    const [r1, r2] = await Promise.all([
      appendVersion(projectRoot, sample.projectId, sample.name, {
        path: 'b.md', kind: 'internal', absolutePath: null,
        sessionId: 's', type: 'create', author: 'agent',
      }),
      appendVersion(projectRoot, sample.projectId, sample.name, {
        path: 'c.md', kind: 'internal', absolutePath: null,
        sessionId: 's', type: 'create', author: 'agent',
      }),
    ]);
    expect(r1.committed).toBe(true);
    expect(r2.committed).toBe(true);
    const sidecar = await readSidecar(projectRoot) as ProjectSidecar;
    expect(sidecar.artifacts).toHaveLength(3);
  });

  // ROADMAP L696: the CREATION sibling of the same-millisecond ABA race below.
  // The update path has been CAS-guarded since PR #198, but the create path
  // was not: two writers that both found NO sidecar each built a fresh
  // page-one and the second silently overwrote the first, both reporting
  // committed: true. Window is narrow (it needs the first-ever two artifact
  // writes in a project to land together) but the loss is invisible and
  // permanent, so this loops.
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
        // No sidecar exists yet: both calls read null and both build page-one.
        // appendVersionsDirect, not appendVersion — the latter coalesces
        // same-process callers into one batch, so it cannot reach this race.
        // A second YouCoded instance on the same project still can.
        const [a, b] = await Promise.all([
          appendVersionsDirect(root, sample.projectId, sample.name, [{
            path: 'a.md', kind: 'internal', absolutePath: null,
            sessionId: 's', type: 'create', author: 'agent',
          }]),
          appendVersionsDirect(root, sample.projectId, sample.name, [{
            path: 'b.md', kind: 'internal', absolutePath: null,
            sessionId: 's', type: 'create', author: 'agent',
          }]),
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
    // The other half of splitting `null`: corruption recovery deliberately
    // overwrites what is on disk, so it must NOT be caught by the new
    // must-not-exist rule. Without CAS_REPLACE_ANY this write is refused and
    // the user is stuck with a broken sidecar forever.
    const root = mkdtempSync(join(tmpdir(), 'as-corrupt-'));
    try {
      mkdirSync(join(root, '.youcoded'), { recursive: true });
      writeFileSync(join(root, '.youcoded', 'artifacts.json'), '{ this is not json');
      const [r] = await appendVersionsDirect(root, sample.projectId, sample.name, [{
        path: 'a.md', kind: 'internal', absolutePath: null,
        sessionId: 's', type: 'create', author: 'agent',
      }]);
      expect(r.committed).toBe(true);
      const sidecar = await readSidecar(root) as ProjectSidecar;
      expect(sidecar.artifacts.map((x) => x.path)).toEqual(['a.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Pins the same-millisecond CAS ABA fix. The single-shot case above only
  // caught it ~1 run in 3 (it needs both writes inside one millisecond), which
  // read as a flaky test for months; at 60 iterations the old code loses a
  // record essentially every run. If this ever goes red again, a writer is
  // producing an updatedAt that does NOT advance past the value it read.
  // Uses appendVersionsDirect, NOT appendVersion: since 2026-08-15 appendVersion
  // coalesces same-process callers into one batch, so two concurrent calls no
  // longer race the CAS at all — the direct path is what a SECOND process
  // (another YouCoded instance on the same project) still exercises.
  it('concurrent appends never lose a record (same-millisecond CAS)', async () => {
    for (let i = 0; i < 60; i++) {
      const root = mkdtempSync(join(tmpdir(), 'as-aba-'));
      await appendVersion(root, sample.projectId, sample.name, {
        path: 'a.md', kind: 'internal', absolutePath: null,
        sessionId: 's', type: 'create', author: 'agent',
      });
      await Promise.all([
        appendVersionsDirect(root, sample.projectId, sample.name, [{
          path: 'b.md', kind: 'internal', absolutePath: null,
          sessionId: 's', type: 'create', author: 'agent',
        }]),
        appendVersionsDirect(root, sample.projectId, sample.name, [{
          path: 'c.md', kind: 'internal', absolutePath: null,
          sessionId: 's', type: 'create', author: 'agent',
        }]),
      ]);
      const s = await readSidecar(root) as ProjectSidecar;
      expect(s.artifacts.map((a) => a.path).sort()).toEqual(['a.md', 'b.md', 'c.md']);
      // 60 iterations x every run x CI — clean up rather than leak temp dirs.
      rmSync(root, { recursive: true, force: true });
    }
  });

  // 2026-08-15 — "YouCoded dies 16–21 s after opening one big session". The
  // tracker fires appendVersion once per replayed tool call (~1,000 for a long
  // session) and every call used to parse + hold + rewrite the whole sidecar
  // concurrently until the main process OOM'd. Callers inside one process now
  // coalesce into a per-project batch: one read and one write per drain.
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
      const spy = vi.spyOn(fsPromises, 'readFile').mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));
      const p1 = appendVersion(projectRoot, sample.projectId, sample.name, {
        path: 'x.md', kind: 'internal', absolutePath: null, sessionId: 's', type: 'create', author: 'agent',
      });
      await expect(p1).rejects.toThrow('EIO');
      spy.mockRestore();
      const r2 = await appendVersion(projectRoot, sample.projectId, sample.name, {
        path: 'y.md', kind: 'internal', absolutePath: null, sessionId: 's', type: 'create', author: 'agent',
      });
      expect(r2.committed).toBe(true);
    });
  });

  // Replay dedupe: re-opening a conversation replays every tool call it ever
  // made through the tracker. Without this every open appended the same edits
  // again — 14k versions / 4.4 MB in youcoded-dev by 2026-08-15. toolUseId is
  // the stable identity of one tool call across replays.
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

  // The invariant the fix rests on, asserted directly: a committed write always
  // leaves a token strictly greater than the one the writer read. Without this,
  // a concurrent reader holding the old token passes CAS on stale data.
  it('a committed write always advances updatedAt past the expected token', async () => {
    await appendVersion(projectRoot, sample.projectId, sample.name, {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's', type: 'create', author: 'agent',
    });
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
    const first = await appendVersion(projectRoot, 'p1', 'proj', {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's', type: 'create', author: 'agent',
    });
    expect(first.artifactId).toBeTruthy();
    const second = await appendVersion(projectRoot, 'p1', 'proj', {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's', type: 'edit', author: 'agent',
    });
    // Same record → same id (this id feeds the artifacts:changed broadcast the
    // edit-conflict banner matches on).
    expect(second.artifactId).toBe(first.artifactId);
  });

  it("a 'read' version does NOT bump lastModified on an existing record", async () => {
    await appendVersion(projectRoot, 'p1', 'proj', {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's', type: 'edit', author: 'agent',
    });
    const before = (await readSidecar(projectRoot)) as ProjectSidecar;
    const stamp = before.artifacts[0].lastModified;
    await new Promise((r) => setTimeout(r, 5));
    await appendVersion(projectRoot, 'p1', 'proj', {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's2', type: 'read', author: 'user',
    });
    const after = (await readSidecar(projectRoot)) as ProjectSidecar;
    expect(after.artifacts[0].lastModified).toBe(stamp);   // unchanged — a view is not a modification
    expect(after.artifacts[0].versions).toHaveLength(2);   // the read IS still recorded
  });

  it("a 'delivered' version does NOT bump lastModified on an existing record", async () => {
    // Handing the user an old file is not a modification — it must not jump
    // to the top of "recently modified" (spec 2026-08-25 §4.2).
    await appendVersion(projectRoot, 'p1', 'proj', {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's', type: 'edit', author: 'agent',
    });
    const before = (await readSidecar(projectRoot)) as ProjectSidecar;
    const stamp = before.artifacts[0].lastModified;
    await new Promise((r) => setTimeout(r, 5));
    await appendVersion(projectRoot, 'p1', 'proj', {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's2', type: 'delivered', author: 'agent', toolUseId: 'toolu_d',
    });
    const after = (await readSidecar(projectRoot)) as ProjectSidecar;
    expect(after.artifacts[0].lastModified).toBe(stamp);
    expect(after.artifacts[0].versions.at(-1)?.type).toBe('delivered');
  });
});

describe('removeArtifactRecord', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'as-remove-'));
  });

  it('removes the tracking record (never touches disk files)', async () => {
    const { artifactId } = await appendVersion(projectRoot, 'p1', 'proj', {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's', type: 'create', author: 'agent',
    });
    const res = await removeArtifactRecord(projectRoot, artifactId!);
    expect(res.ok).toBe(true);
    const sidecar = (await readSidecar(projectRoot)) as ProjectSidecar;
    expect(sidecar.artifacts).toHaveLength(0);
  });

  it('reports artifact-not-found for unknown ids', async () => {
    await appendVersion(projectRoot, 'p1', 'proj', {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's', type: 'create', author: 'agent',
    });
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

    // ROADMAP L598: a repair that rewrites artifact history must announce
    // exactly what it rewrote and where the backup is — it is the only
    // detector for a repair that over-reclassifies.
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

    // Both calls share this test's projectRoot AND this test's module instance,
    // so the first call's `migrationChecked.add(projectRoot)` is still warm here
    // — this second call short-circuits on the MEMO, before readSidecar ever
    // runs. That's cheap and worth pinning (repeat calls in one process should
    // not re-scan), but it proves nothing about the production run-once gate
    // (`reclassified === 0` from the pure migration). See the next test for that.
    const second = await runSidecarMigration(projectRoot);
    expect(second).toMatchObject({ migrated: false, reclassified: 0 });
    const unchanged = await readSidecar(projectRoot) as ProjectSidecar;
    expect(unchanged.updatedAt).toBe(after.updatedAt);   // it did not rewrite
  });

  // The test above cannot reach the real gate: same process + same projectRoot
  // means the memo is always warm on the second call. This test forces a COLD
  // memo — via vi.resetModules() + a dynamic re-import, which re-evaluates
  // artifact-store.ts and so constructs a brand new, empty `migrationChecked`
  // Set — and re-runs the migration against the already-repaired sidecar on
  // disk. If this ever regresses to relying on the memo, a peer device that
  // wrote a fresh relative-external record after this process's memo was
  // populated would never get it repaired; if it regresses to re-writing
  // unconditionally, every LIST_SESSION call would rewrite the sidecar.
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
    clean.artifacts[0] = { ...clean.artifacts[0], kind: 'internal' as any, absolutePath: null };
    await writeSidecar(projectRoot, null, clean as any);

    const res = await runSidecarMigration(projectRoot);
    expect(res.migrated).toBe(false);
    expect(readdirSync(join(projectRoot, '.youcoded')).filter((f) => f.includes('.bak'))).toHaveLength(0);
  });

  // Pins the FIXED backup name (not one file per attempt). The second
  // migration call in the old version of this test was a memo short-circuit —
  // it never reached the copyFile/EEXIST branch a second time — so it proved
  // nothing beyond what one call already does; calling once is honest about
  // what's being checked.
  //
  // This test also pins the backup's CONTENT, not just its name. The backup
  // exists so a maintainer can recover a sidecar if the repair turns out
  // wrong for a record nobody anticipated — a file merely existing at the
  // right name proves nothing about whether it's actually restorable. So we
  // capture the sidecar's raw bytes BEFORE migration runs, then assert the
  // backup holds exactly those pre-migration bytes (byte for byte — if the
  // copy read from the wrong source, ran too late, or wrote empty/truncated
  // output, this catches it). We also assert the live sidecar's bytes CHANGED
  // from that snapshot; without that check, a migration that silently did
  // nothing at all would still make the backup content match trivially
  // (backup == pre-migration == post-migration, all identical), so the
  // byte-equality assertion above would pass for the wrong reason.
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

  // The backup is the only way back from a bad migration, so it must protect
  // the OLDEST copy — a retry (or a second window racing the same repair)
  // must never clobber it with already-half-migrated state. Pre-creating the
  // backup file with a sentinel and asserting the sentinel survives is what
  // actually exercises the COPYFILE_EXCL + swallowed-EEXIST branch; without
  // COPYFILE_EXCL (a plain copyFile) this test fails because the sentinel
  // gets overwritten.
  it('never overwrites an existing backup', async () => {
    await writeSidecar(projectRoot, null, legacy() as any);
    const backupPath = join(projectRoot, '.youcoded/artifacts.json.pre-migration.bak');
    writeFileSync(backupPath, 'SENTINEL-PRE-EXISTING-BACKUP');

    const res = await runSidecarMigration(projectRoot);
    expect(res.migrated).toBe(true);   // migration itself still proceeds
    expect(readFileSync(backupPath, 'utf8')).toBe('SENTINEL-PRE-EXISTING-BACKUP');
  });

  // Finding 1 (final review): runSidecarMigration is called from THREE
  // handlers that were read-only before this branch (LIST_SESSION,
  // LIST_PROJECT, LIST_ALL_FILES). fs.copyFile's EEXIST-only swallow and
  // writeSidecar's CAS write can both throw unexpected errors (ENOSPC, EROFS,
  // EACCES, Windows EPERM from AV). Before the fix, that rejection propagated
  // straight out of this function into those handlers; FilesTab.tsx's
  // `listAllFiles(...).then(...)` has no `.catch`, so the Files tab's loading
  // state would never clear. This pins the fail-closed contract: never throw,
  // report NOTHING migrated, and don't retry the doomed work on every
  // subsequent call in this process.
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

  // This is the same escape write-authorization's four sites already close,
  // now closed at the fifth: a RELATIVE absolutePath (the pre-fix classifier
  // bug, or a record deliberately left external because its real path escapes
  // the project root with `..`) must never reach fs.access/fs.rename, which
  // would resolve it against the PROCESS cwd — a real filesystem mutation
  // outside the project, not just a stale read.
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

  // Sanity check that the guard doesn't over-fire: a genuinely absolute
  // external path still renames normally.
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

// 2026-08-27 OOM fix — see tests/artifacts/sidecar-cache.test.ts for the read
// side. This pins the write side: the CAS check must not unpack the on-disk
// file to read its one timestamp.
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

// Files the agent wrote through `../` (Destin, 2026-09-23, option A): repaired
// only inside a project folder and outside the deny list; everything else is
// left untouched, still refused.
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

