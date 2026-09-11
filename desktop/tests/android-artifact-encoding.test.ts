/**
 * The phone reports, and refuses to save, text in an older encoding.
 *
 * A Latin-1 / Windows-1252 file has no NUL bytes, so it passes the binary sniff
 * and decodes with U+FFFD in place of every accent. Saving it back writes that
 * damage to disk permanently. Desktop flags `notUtf8` on artifacts:get and
 * refuses artifacts:save with `not-utf8`; vitest cannot run Kotlin, so this
 * pins the same two behaviours at the source.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readStripped } from './helpers/guard-scope';

const KOTLIN_ROOT = join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app');
const SESSION_SERVICE = join(KOTLIN_ROOT, 'runtime', 'SessionService.kt');
const POLICY = join(KOTLIN_ROOT, 'artifacts', 'EditablePathPolicy.kt');

function handler(name: string, nextMarker: string): string {
  const src = readStripped(SESSION_SERVICE);
  const start = src.indexOf(`"${name}" ->`);
  expect(start, `${name} handler not found`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(nextMarker, start);
  expect(end, 'next handler marker not found').toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('Android — text in an older encoding', () => {
  it('the policy reports a lossy UTF-8 decode instead of silently replacing characters', () => {
    const policy = readStripped(POLICY);
    expect(policy).toContain('fun losesBytesAsUtf8(');
    expect(policy).toContain('CodingErrorAction.REPORT');
  });

  it('artifacts:get tells the renderer with notUtf8', () => {
    expect(handler('artifacts:get', '"fs:read-head" ->')).toMatch(/put\("notUtf8",\s*!binary && EditablePathPolicy\.losesBytesAsUtf8\(bytes\)\)/);
  });

  it('artifacts:save refuses such a file rather than writing the replacements back', () => {
    const save = handler('artifacts:save', '"artifacts:append-version" ->');
    expect(save).toContain('losesBytesAsUtf8');
    expect(save).toContain('"not-utf8"');
  });
});
