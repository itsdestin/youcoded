/**
 * The phone's artifacts:read-binary answers a failed read as a failure.
 *
 * It caught every IOException — permission denied included — as `orphan`, which
 * BinaryContent words as "isn't where it was saved". So an image the phone could
 * not read told the user it had been deleted (2026-09-11). artifacts:get was
 * fixed for exactly this the day before; this is the bytes path.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readStripped } from './helpers/guard-scope';

const SESSION_SERVICE = join(
  __dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt',
);

function readBinaryHandler(): string {
  const src = readStripped(SESSION_SERVICE);
  const start = src.indexOf('"artifacts:read-binary" ->');
  expect(start, 'artifacts:read-binary handler not found').toBeGreaterThanOrEqual(0);
  const end = src.indexOf('"artifacts:save" ->', start);
  expect(end, 'next handler marker not found').toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('Android artifacts:read-binary', () => {
  it('answers orphan only for a file that is genuinely absent', () => {
    expect(readBinaryHandler()).toMatch(/if \(!resolvedBin\.exists\(\)\)[\s\S]{0,120}"orphan"/);
  });

  it('reports an unreadable file with its reason, not as a deleted one', () => {
    const handler = readBinaryHandler();
    expect(handler).toContain('EditablePathPolicy.readWhole(resolvedBin)');
    expect(handler).toMatch(/FileRead\.Unreadable ->[\s\S]{0,160}put\("error", read\.reason\)/);
    expect(handler).not.toMatch(/catch \(e: java\.io\.IOException\) \{[\s\S]{0,120}"orphan"/);
  });
});
