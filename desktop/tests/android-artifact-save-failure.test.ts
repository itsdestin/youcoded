/**
 * The phone's artifacts:save answers a failed write instead of throwing it.
 *
 * Kotlin handlers run in a coroutine scope with no exception handler, so an
 * escaping IOException meant NO response at all: the renderer's save promise sat
 * there until it timed out, and the user saw a Save button that did nothing.
 * Desktop returns { ok: false, error: 'write-failed' } (ipc-handlers.ts); this
 * pins the Kotlin half, which vitest cannot execute.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readStripped } from './helpers/guard-scope';

const SESSION_SERVICE = join(
  __dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt',
);

function artifactsSaveHandler(): string {
  const src = readStripped(SESSION_SERVICE);
  const start = src.indexOf('"artifacts:save" ->');
  expect(start, 'artifacts:save handler not found').toBeGreaterThanOrEqual(0);
  const end = src.indexOf('"artifacts:append-version" ->', start);
  expect(end, 'next handler marker not found').toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('Android artifacts:save — a write that fails is answered, not thrown', () => {
  it('wraps the temp-write and move in a catch that responds with write-failed', () => {
    const handler = artifactsSaveHandler();
    expect(handler).toMatch(/try\s*\{[\s\S]*writeText\(newContent[\s\S]*Files\.move\([\s\S]*\}\s*catch/);
    expect(handler).toContain('"write-failed"');
  });

  it('still answers the request in that path (no silent drop)', () => {
    const afterCatch = artifactsSaveHandler().split('catch').slice(1).join('catch');
    expect(afterCatch).toMatch(/bridgeServer\.respond\([\s\S]*"ok", false/);
  });
});
