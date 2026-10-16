import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readIndex,
  upsertProject,
  removeProject,
  listProjects,
} from '../../src/main/artifacts/central-index';
import { INDEX_SCHEMA_VERSION } from '../../src/shared/artifacts/types';

describe('central-index', () => {
  let claudeDir: string;
  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), 'ci-'));
  });

  it('returns an empty index when none exists', async () => {
    const idx = await readIndex(claudeDir);
    expect(idx).toEqual({ $schema: INDEX_SCHEMA_VERSION, projects: [] });
  });

  it('upserts a new project', async () => {
    await upsertProject(claudeDir, {
      id: 'p1', name: 'a', path: '/p/a',
      lastIndexed: '2026-01-01T00:00:00Z',
      lastSession: null, contentTypes: ['artifacts'] as ('artifacts' | 'conversations')[],
      stats: { artifactCount: 0 },
    });
    const idx = await readIndex(claudeDir);
    expect(idx.projects).toHaveLength(1);
    expect(idx.projects[0].id).toBe('p1');
  });

  it('upserts overwrites an existing project by id', async () => {
    const base = {
      id: 'p1', name: 'a', path: '/p/a',
      lastIndexed: '2026-01-01T00:00:00Z',
      lastSession: null, contentTypes: ['artifacts'] as ('artifacts' | 'conversations')[],
      stats: { artifactCount: 0 },
    };
    await upsertProject(claudeDir, base);
    await upsertProject(claudeDir, { ...base, name: 'a-renamed', stats: { artifactCount: 5 } });
    const idx = await readIndex(claudeDir);
    expect(idx.projects).toHaveLength(1);
    expect(idx.projects[0].name).toBe('a-renamed');
    expect(idx.projects[0].stats.artifactCount).toBe(5);
  });

  it('removeProject removes by id', async () => {
    await upsertProject(claudeDir, {
      id: 'p1', name: 'a', path: '/p/a',
      lastIndexed: '2026-01-01T00:00:00Z',
      lastSession: null, contentTypes: ['artifacts'],
      stats: { artifactCount: 0 },
    });
    await removeProject(claudeDir, 'p1');
    const idx = await readIndex(claudeDir);
    expect(idx.projects).toHaveLength(0);
  });

  it('concurrent upserts do not lose updates (read-modify-write is locked)', async () => {
    // The lost-update race: both writers read v0 outside any lock, then the
    // second write clobbers the first's project. mutateIndex performs the
    // read-modify-write INSIDE the file lock, so all N projects must survive.
    const make = (n: number) => ({
      id: `p${n}`, name: `proj-${n}`, path: `/p/${n}`,
      lastIndexed: '2026-01-01T00:00:00Z',
      lastSession: null, contentTypes: ['artifacts'] as any,
      stats: { artifactCount: 0 },
    });
    await Promise.all(Array.from({ length: 8 }, (_, n) => upsertProject(claudeDir, make(n))));
    const idx = await readIndex(claudeDir);
    expect(idx.projects.map((p) => p.id).sort()).toEqual(
      Array.from({ length: 8 }, (_, n) => `p${n}`).sort()
    );
  });

  it('concurrent upsert + remove of different projects both land', async () => {
    await upsertProject(claudeDir, {
      id: 'keep', name: 'keep', path: '/p/keep',
      lastIndexed: '2026-01-01T00:00:00Z',
      lastSession: null, contentTypes: ['artifacts'],
      stats: { artifactCount: 0 },
    });
    await upsertProject(claudeDir, {
      id: 'gone', name: 'gone', path: '/p/gone',
      lastIndexed: '2026-01-01T00:00:00Z',
      lastSession: null, contentTypes: ['artifacts'],
      stats: { artifactCount: 0 },
    });
    await Promise.all([
      removeProject(claudeDir, 'gone'),
      upsertProject(claudeDir, {
        id: 'new', name: 'new', path: '/p/new',
        lastIndexed: '2026-01-01T00:00:00Z',
        lastSession: null, contentTypes: ['artifacts'],
        stats: { artifactCount: 0 },
      }),
    ]);
    const idx = await readIndex(claudeDir);
    expect(idx.projects.map((p) => p.id).sort()).toEqual(['keep', 'new']);
  });
});
