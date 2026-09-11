// An outside-the-project file is identified by WHERE it is, not by its name.
//
// External records store only the basename in `path` (resolve-tracked-path.ts),
// and appendVersion matched on (path, kind) — so /tmp/a/plan.md and
// ~/notes/plan.md became one record: the second session's edits were appended to
// the first file's record, that session's drawer row opened the wrong file, and
// its own file never appeared (2026-09-11).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendVersion, readSidecar } from '../../src/main/artifacts/artifact-store';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yc-extid-'));
  mkdirSync(join(root, '.youcoded'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

async function record(absolutePath: string, sessionId: string) {
  return appendVersion(root, 'p', 'proj', {
    path: absolutePath.split('/').pop()!,
    kind: 'external',
    absolutePath,
    sessionId,
    type: 'edit',
    author: 'agent',
  });
}

async function artifacts() {
  const sc = await readSidecar(root);
  if (!sc || 'corrupted' in sc) throw new Error('sidecar unreadable');
  return sc.artifacts;
}

describe('external records with the same file name', () => {
  it('stay separate records, each keeping its own location', async () => {
    await record('/tmp/a/plan.md', 's1');
    await record('/home/u/notes/plan.md', 's2');
    const all = await artifacts();
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.absolutePath).sort())
      .toEqual(['/home/u/notes/plan.md', '/tmp/a/plan.md']);
    // Each session sees only its own file.
    for (const a of all) expect(a.versions.map((v) => v.sessionId)).toHaveLength(1);
  });

  it('the same file touched twice is still ONE record with two versions', async () => {
    await record('/tmp/a/plan.md', 's1');
    await record('/tmp/a/plan.md', 's2');
    const all = await artifacts();
    expect(all).toHaveLength(1);
    expect(all[0].versions).toHaveLength(2);
  });

  it('an in-project file is still matched by its path', async () => {
    for (const sessionId of ['s1', 's2']) {
      await appendVersion(root, 'p', 'proj', {
        path: 'docs/plan.md', kind: 'internal', absolutePath: null, sessionId, type: 'edit', author: 'agent',
      });
    }
    const all = await artifacts();
    expect(all).toHaveLength(1);
    expect(all[0].versions).toHaveLength(2);
  });
});
