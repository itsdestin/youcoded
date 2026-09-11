/**
 * The phone identifies an outside-the-project file by WHERE it is, not by name.
 *
 * External records keep only the basename in `path`, and appendVersion matched on
 * (path, kind) on both platforms — so /tmp/a/plan.md and ~/notes/plan.md became one
 * record (2026-09-11). Desktop is pinned by tests/artifacts/external-record-identity.ts;
 * vitest cannot run Kotlin, so the mirror is pinned at the source. The phone's sidecar
 * is per-device, so a drifted Kotlin copy would merge records there and nowhere else.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readStripped } from './helpers/guard-scope';

const STORE = join(
  __dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'artifacts', 'ArtifactStore.kt',
);

describe('Android appendVersion — record identity', () => {
  it('no longer matches a record on (path, kind) alone', () => {
    expect(readStripped(STORE)).not.toContain('find { it.path == input.path && it.kind == input.kind }');
  });

  it('compares canonicalized absolute paths for externals, and path for internals', () => {
    const src = readStripped(STORE);
    expect(src).toMatch(/if \(input\.kind == "internal"\) return@find a\.path == input\.path/);
    expect(src).toMatch(/canonicalize\(recordedAbs, null\) == canonicalize\(incomingAbs, null\)/);
  });
});
