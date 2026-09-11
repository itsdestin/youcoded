// A tracked file whose saved location is empty is found again when — and only
// when — exactly one file elsewhere in the project agrees on its name and at
// least two parent folders. 2026-09-11: 43% of youcoded-dev's tracked files read
// "deleted" because they were edited inside a worktree copy that was removed
// after merging, while the files lived on in the main checkout.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyRelocations, createFileLookup, findMovedFile, relocateMissingRecords, __resetRelocationMemo,
} from '../../src/main/artifacts/relocate-missing';
import { readSidecar, writeSidecar } from '../../src/main/artifacts/artifact-store';
import { SIDECAR_SCHEMA_VERSION, type ArtifactRecord, type ProjectSidecar } from '../../src/shared/artifacts/types';

let root: string;

function touch(rel: string) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'x');
}

function record(id: string, relPath: string, sessionId: string, extra: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id, path: relPath, kind: 'internal', absolutePath: null,
    lastModified: '2026-09-01T00:00:00.000Z', status: 'active',
    versions: [{ id: `v-${id}`, ts: '2026-09-01T00:00:00.000Z', sessionId, type: 'edit', author: 'agent', toolUseId: `tu-${id}` }],
    comments: [], tags: [], ...extra,
  };
}

function sidecar(artifacts: ArtifactRecord[]): ProjectSidecar {
  return {
    $schema: SIDECAR_SCHEMA_VERSION, projectId: 'p', name: 'proj',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    artifacts, manualExcludes: [], manualIncludes: [],
  };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-relocate-')));
  __resetRelocationMemo();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  vi.restoreAllMocks();
});

describe('findMovedFile', () => {
  it('finds a removed session-worktree copy in the main checkout', async () => {
    touch('youcoded/desktop/src/a.ts');
    expect(await findMovedFile(createFileLookup(root), 'worktrees/sessions/s1/youcoded/desktop/src/a.ts'))
      .toBe('youcoded/desktop/src/a.ts');
  });

  it('finds a removed single-repo worktree copy inside the repo folder it came from', async () => {
    touch('youcoded/desktop/src/a.ts');
    expect(await findMovedFile(createFileLookup(root), 'youcoded.wt/fix-x/desktop/src/a.ts'))
      .toBe('youcoded/desktop/src/a.ts');
  });

  it('needs the name and at least two folders to agree — agreeing on the name and one folder is not enough', async () => {
    touch('lib/src/a.ts');                       // agrees on src/a.ts only
    expect(await findMovedFile(createFileLookup(root), 'worktrees/w/src/a.ts')).toBeNull();
    touch('docs/archive/specs/plan.md');         // a plan moved to the archive stays "not found"
    expect(await findMovedFile(createFileLookup(root), 'docs/active/specs/plan.md')).toBeNull();
  });

  it('refuses to choose between two equally good lookalikes', async () => {
    touch('youcoded/desktop/src/a.ts');
    touch('fixtures/desktop/src/a.ts');
    expect(await findMovedFile(createFileLookup(root), 'worktrees/w/desktop/src/a.ts')).toBeNull();
  });

  it('prefers the candidate that agrees on more folders', async () => {
    touch('youcoded/desktop/src/a.ts');   // agrees on youcoded/desktop/src/a.ts
    touch('lib/desktop/src/a.ts');        // agrees only on desktop/src/a.ts
    expect(await findMovedFile(createFileLookup(root), 'worktrees/w/youcoded/desktop/src/a.ts'))
      .toBe('youcoded/desktop/src/a.ts');
  });

  it('never matches a folder, and never follows a path with ".."', async () => {
    fs.mkdirSync(path.join(root, 'youcoded/desktop/src/a.ts'), { recursive: true });
    expect(await findMovedFile(createFileLookup(root), 'worktrees/w/youcoded/desktop/src/a.ts')).toBeNull();
    touch('youcoded/desktop/src/b.ts');
    expect(await findMovedFile(createFileLookup(root), 'worktrees/w/../youcoded/desktop/src/b.ts')).toBeNull();
  });
});

describe('applyRelocations', () => {
  it('repoints a record, and merges into an existing record for the same file without duplicating a tool call', () => {
    const moved = record('01B', 'worktrees/w/youcoded/a.ts', 's1');
    const twin = record('01A', 'youcoded/a.ts', 's2');
    // The same tool call already recorded on the twin must not appear twice.
    twin.versions.push({ ...moved.versions[0], id: 'v-other' });
    const lone = record('01C', 'worktrees/w/youcoded/b.ts', 's1');
    const { sidecar: out, relocated } = applyRelocations(
      sidecar([moved, twin, lone]),
      new Map([['01B', 'youcoded/a.ts'], ['01C', 'youcoded/b.ts']]),
    );
    expect(relocated).toHaveLength(2);
    expect(out.artifacts.map((a) => [a.id, a.path])).toEqual([['01A', 'youcoded/a.ts'], ['01C', 'youcoded/b.ts']]);
    const merged = out.artifacts[0];
    expect(merged.versions.map((v) => v.sessionId).sort()).toEqual(['s1', 's2']);
  });
});

describe('relocateMissingRecords', () => {
  it("repoints this session's moved files, leaves present and truly-gone ones alone, and is a no-op the second time", async () => {
    fs.mkdirSync(path.join(root, '.youcoded'));
    touch('youcoded/desktop/src/moved.ts');
    touch('youcoded/desktop/src/present.ts');
    await writeSidecar(root, null, sidecar([
      record('01A', 'worktrees/s/youcoded/desktop/src/moved.ts', 's1'),
      record('01B', 'youcoded/desktop/src/present.ts', 's1'),
      record('01C', 'worktrees/s/youcoded/desktop/src/gone.ts', 's1'),
      record('01D', 'worktrees/s/youcoded/desktop/src/deleted.ts', 's1', { status: 'deleted' }),
      record('01E', 'worktrees/other/youcoded/desktop/src/moved.ts', 's2'),   // another session's record
    ]));
    touch('youcoded/desktop/src/deleted.ts');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await relocateMissingRecords(root, 's1')).toEqual({ relocated: 1 });
    const after = await readSidecar(root);
    if (!after || 'corrupted' in after) throw new Error('sidecar unreadable');
    const byId = new Map(after.artifacts.map((a) => [a.id, a.path]));
    expect(byId.get('01A')).toBe('youcoded/desktop/src/moved.ts');
    expect(byId.get('01B')).toBe('youcoded/desktop/src/present.ts');
    expect(byId.get('01C')).toBe('worktrees/s/youcoded/desktop/src/gone.ts');
    expect(byId.get('01D')).toBe('worktrees/s/youcoded/desktop/src/deleted.ts');   // an explicit delete stays one
    expect(byId.get('01E')).toBe('worktrees/other/youcoded/desktop/src/moved.ts'); // only THIS session's rows

    const bytes = fs.readFileSync(path.join(root, '.youcoded/artifacts.json'), 'utf8');
    expect(await relocateMissingRecords(root, 's1')).toEqual({ relocated: 0 });
    expect(fs.readFileSync(path.join(root, '.youcoded/artifacts.json'), 'utf8')).toBe(bytes);
  });

  it('reports nothing — never throws — when the sidecar is unreadable', async () => {
    fs.mkdirSync(path.join(root, '.youcoded'));
    fs.writeFileSync(path.join(root, '.youcoded/artifacts.json'), '{ not json');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(relocateMissingRecords(root, 's1')).resolves.toEqual({ relocated: 0 });
  });
});
