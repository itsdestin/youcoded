import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, utimesSync, promises as fsPromises } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readSidecar, readSidecarShared, writeSidecar, appendVersion, _resetSidecarCacheForTests,
  SIDECAR_CACHE_IDLE_MS,
} from '../../src/main/artifacts/artifact-store';
import type { ProjectSidecar } from '../../src/shared/artifacts/types';
import sample from '../../../shared-fixtures/artifacts/sample-sidecar.json';

// 2026-08-27 — "YouCoded dies after 12 h of use". PR #318 queued the sidecar
// WRITER; every READER stayed unguarded, and one Edit now costs ~11 full parses
// of a 6.4 MB artifacts.json (LIST_SESSION, artifacts:get per visible card,
// check-existence, the watcher's id map, every open tab at startup…). Under a
// burst those parses pile up — the core dump held 477 copies ≈ 3.0 GB. The
// shared read below bounds that to ONE parsed copy per project, however many
// callers ask at once, and to ZERO extra parses after a write the app itself
// just made. Full evidence: docs/active/investigations/2026-08-27-artifacts-sidecar-oom-crash.md.

const sidecarReads = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((c) => String(c[0]).endsWith('artifacts.json')).length;

describe('readSidecarShared — one parsed copy per project', () => {
  let projectRoot: string;
  let sidecarPath: string;
  beforeEach(() => {
    _resetSidecarCacheForTests();
    projectRoot = mkdtempSync(join(tmpdir(), 'as-shared-'));
    mkdirSync(join(projectRoot, '.youcoded'));
    sidecarPath = join(projectRoot, '.youcoded', 'artifacts.json');
    writeFileSync(sidecarPath, JSON.stringify(sample));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    _resetSidecarCacheForTests();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('a burst of N concurrent reads performs ONE parse and hands every caller the same object', async () => {
    const N = 300;
    const readSpy = vi.spyOn(fsPromises, 'readFile');
    const results = await Promise.all(Array.from({ length: N }, () => readSidecarShared(projectRoot)));
    expect(sidecarReads(readSpy)).toBe(1);
    expect(results.every((r) => r === results[0])).toBe(true);
    expect((results[0] as ProjectSidecar).projectId).toBe(sample.projectId);
  });

  it('a second read of an unchanged file costs no parse at all', async () => {
    const readSpy = vi.spyOn(fsPromises, 'readFile');
    const a = await readSidecarShared(projectRoot);
    const b = await readSidecarShared(projectRoot);
    expect(sidecarReads(readSpy)).toBe(1);
    expect(b).toBe(a);
  });

  it('re-parses when the file changes on disk (another process wrote it)', async () => {
    const a = (await readSidecarShared(projectRoot)) as ProjectSidecar;
    const changed = { ...sample, name: 'renamed-elsewhere', updatedAt: '2030-01-01T00:00:00.000Z' };
    writeFileSync(sidecarPath, JSON.stringify(changed));
    // Same-size-same-mtime collisions are the only blind spot; force a
    // distinct mtime so the test is about content, not filesystem tick size.
    const t = new Date(Date.now() + 5_000);
    utimesSync(sidecarPath, t, t);
    const b = (await readSidecarShared(projectRoot)) as ProjectSidecar;
    expect(b).not.toBe(a);
    expect(b.name).toBe('renamed-elsewhere');
  });

  it('a committed writeSidecar SEEDS the cache — the reads that follow every edit cost zero parses', async () => {
    const cur = (await readSidecar(projectRoot)) as ProjectSidecar;
    cur.name = 'written-here';
    const res = await writeSidecar(projectRoot, cur.updatedAt, cur);
    expect(res.committed).toBe(true);
    const readSpy = vi.spyOn(fsPromises, 'readFile');
    const shared = (await readSidecarShared(projectRoot)) as ProjectSidecar;
    expect(sidecarReads(readSpy)).toBe(0);
    expect(shared.name).toBe('written-here');
    expect(shared.updatedAt).toBe(cur.updatedAt);
  });

  it('a queued appendVersion burst leaves the cache holding the final state, with no parse for the reader', async () => {
    await readSidecarShared(projectRoot);
    await Promise.all(Array.from({ length: 50 }, (_, i) => appendVersion(projectRoot, sample.projectId, sample.name, {
      path: `docs/burst-${i}.md`, kind: 'internal', absolutePath: null,
      sessionId: 'sess-cache', type: 'create', author: 'agent', toolUseId: `toolu_c${i}`,
    })));
    const readSpy = vi.spyOn(fsPromises, 'readFile');
    const shared = (await readSidecarShared(projectRoot)) as ProjectSidecar;
    expect(sidecarReads(readSpy)).toBe(0);
    expect(shared.artifacts.filter((a) => a.path.startsWith('docs/burst-'))).toHaveLength(50);
    // And the shared copy is exactly what is on disk.
    const disk = (await readSidecar(projectRoot)) as ProjectSidecar;
    expect(disk.updatedAt).toBe(shared.updatedAt);
    expect(disk.artifacts.length).toBe(shared.artifacts.length);
  });

  it('a missing sidecar reads as null and is picked up once it appears', async () => {
    rmSync(sidecarPath);
    expect(await readSidecarShared(projectRoot)).toBeNull();
    writeFileSync(sidecarPath, JSON.stringify(sample));
    expect((await readSidecarShared(projectRoot)) as ProjectSidecar).toMatchObject({ projectId: sample.projectId });
  });

  it('a corrupted sidecar is backed up ONCE, not once per reader', async () => {
    writeFileSync(sidecarPath, '{ not json');
    const results = await Promise.all(Array.from({ length: 20 }, () => readSidecarShared(projectRoot)));
    expect(results.every((r) => r && 'corrupted' in r)).toBe(true);
    await readSidecarShared(projectRoot);
    const backups = readdirSync(join(projectRoot, '.youcoded')).filter((f) => f.includes('.bak.'));
    expect(backups).toHaveLength(1);
  });

  it('an idle copy is dropped after SIDECAR_CACHE_IDLE_MS and re-parsed on the next read', async () => {
    vi.useFakeTimers();
    await readSidecarShared(projectRoot);
    const readSpy = vi.spyOn(fsPromises, 'readFile');
    await vi.advanceTimersByTimeAsync(SIDECAR_CACHE_IDLE_MS + 1);
    await readSidecarShared(projectRoot);
    expect(sidecarReads(readSpy)).toBe(1);
  });
});
