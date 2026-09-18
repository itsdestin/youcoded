import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeSidecar } from '../../src/main/artifacts/artifact-store';
import { SIDECAR_SCHEMA_VERSION } from '../../src/shared/artifacts/types';

// Fix (finding 4, final review): countArtifacts's alive-check must not throw
// on a malformed external record whose absolutePath is null — see
// projects-index.ts's WHY comment on the guard for the full defect (the old
// `fs.access(null)` call threw INSIDE a try and was swallowed; the new
// isAbsoluteRecorded(full) guard sits OUTSIDE that try and would throw a raw
// TypeError on null instead).
//
// This mocks trackedArtifacts to pass every sidecar record through
// unfiltered. That's necessary, not incidental: visible-artifacts.ts's REAL
// filter (rule 4) requires an external record to match a manualIncludes PIN
// to be "visible" at all, and the pin-match key is built from absolutePath —
// `a.absolutePath ? canonicalize(a.absolutePath, null) : null`. A null
// absolutePath always produces a null key, and `if (key && included.has(key))`
// short-circuits false for any falsy key, so NO sidecar/manualIncludes shape
// can carry such a record past the real trackedArtifacts (verified directly:
// every attempted pin — matching by path, by the literal string 'null', by
// empty string — still filters the record out). So this exact input can never
// reach countArtifacts's guard via the real end-to-end pipeline today. The
// mock exercises the guard in isolation anyway, as defense in depth: the type
// (`absolutePath: string | null`) allows this value, trackedArtifacts's own
// history shows its filtering rule has changed before (its comments note a
// 2026-07-23 attempt to make externals visible without a pin, reverted the
// same day), and countArtifacts should not silently rely on an orthogonal
// module's filter to avoid crashing on its own input.
vi.mock('../../src/main/artifacts/visible-artifacts', () => ({
  trackedArtifacts: (artifacts: any[]) => artifacts,
}));

import { countArtifacts } from '../../src/main/artifacts/projects-index';

describe('countArtifacts — null absolutePath guard', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'pi-count-'));
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('does not throw, and does not count, an external record with a null absolutePath', async () => {
    await writeSidecar(projectRoot, null, {
      $schema: SIDECAR_SCHEMA_VERSION,
      projectId: 'p',
      name: 'proj',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      artifacts: [{
        id: 'a1', path: 'ghost.txt', kind: 'external', absolutePath: null,
        lastModified: '2026-08-01T00:00:00.000Z', status: 'active',
        versions: [], comments: [], tags: [],
      }],
      manualExcludes: [],
      manualIncludes: [],
    } as any);

    await expect(countArtifacts(projectRoot)).resolves.toBe(0);
  });

  it('still counts a live internal record alongside the null-path external one', async () => {
    const internalFile = join(projectRoot, 'real.txt');
    writeFileSync(internalFile, 'hi');
    await writeSidecar(projectRoot, null, {
      $schema: SIDECAR_SCHEMA_VERSION,
      projectId: 'p',
      name: 'proj',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      artifacts: [
        {
          id: 'a1', path: 'ghost.txt', kind: 'external', absolutePath: null,
          lastModified: '2026-08-01T00:00:00.000Z', status: 'active',
          versions: [], comments: [], tags: [],
        },
        {
          id: 'a2', path: 'real.txt', kind: 'internal', absolutePath: null,
          lastModified: '2026-08-01T00:00:00.000Z', status: 'active',
          versions: [{ id: 'v1', ts: '2026-08-01T00:00:00.000Z', sessionId: 's', type: 'create', author: 'agent' }],
          comments: [], tags: [],
        },
      ],
      manualExcludes: [],
      manualIncludes: [],
    } as any);

    await expect(countArtifacts(projectRoot)).resolves.toBe(1);
  });
});
