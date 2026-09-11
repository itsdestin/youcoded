/**
 * The phone's artifacts:get answers a failed read as a failure, not as a deleted file.
 *
 * Error inventory 2026-09-10, false message 13. After `resolved.exists()` had already
 * passed, SessionService.kt did `try { resolved.readBytes() } catch (IOException) { null }`
 * and answered the null with `orphan: true`. useArtifactContent.ts renders orphan — and
 * only orphan — as "This file is no longer on disk.", so a phone that could not READ a
 * file told the user it had been deleted. It answers any other `{ ok: false, error }` as
 * "Couldn't read this file: <reason>" with Retry, which is what desktop already produces.
 *
 * Kotlin can't be exercised from vitest, so this pins the shape at the source; the read
 * helper's behaviour is pinned by app/.../artifacts/EditablePathPolicyReadTest.kt.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readStripped } from './helpers/guard-scope';

const SESSION_SERVICE = join(
  __dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt',
);

function artifactsGetHandler(): string {
  const src = readStripped(SESSION_SERVICE);
  const start = src.indexOf('"artifacts:get" ->');
  expect(start, 'artifacts:get handler not found').toBeGreaterThanOrEqual(0);
  const end = src.indexOf('"fs:read-head" ->', start);
  expect(end, 'next handler marker not found').toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('Android artifacts:get — an unreadable file is not "no longer on disk"', () => {
  it('reads the whole file through EditablePathPolicy.readWhole', () => {
    expect(artifactsGetHandler()).toContain('EditablePathPolicy.readWhole(');
  });

  it('no longer turns a caught read failure into a null that becomes orphan', () => {
    expect(artifactsGetHandler()).not.toMatch(/readBytes\(\)\s*\}\s*catch\s*\(_:\s*java\.io\.IOException\)\s*\{\s*null\s*\}/);
  });

  // Code review 2026-09-11, F6: the over-cap branch read with the throwing readFully, so the
  // same unreadable file over the size cap got no answer at all (or took the handler down).
  it('reads an over-cap file through the guarded prefix helper, never the throwing one', () => {
    expect(artifactsGetHandler()).toContain('EditablePathPolicy.readPrefix(');
    expect(artifactsGetHandler()).not.toContain('EditablePathPolicy.readFully(');
  });
});
