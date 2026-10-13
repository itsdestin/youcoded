import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

// Every test file is type-checked (tsconfig.tests.json, run by `npm run typecheck` and verify).
// WHY (close-session friction, proposal 19): 47 files sat in its exclude list as debt, and a
// required prop added to a shared card broke one of them only at run time. The list is empty
// now; a file put back in it would hide its type errors again.
describe('the test type-check covers every test', () => {
  it('excludes no test file', () => {
    const text = readFileSync(join(__dirname, '..', 'tsconfig.tests.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const excluded = (JSON.parse(text).exclude as string[]).filter((p) => /(^|\/)tests?\//.test(p) || /\.test\.tsx?$/.test(p));
    expect(excluded, 'fix the file\'s types instead of excluding it').toEqual([]);
  });

  // WHY (final review F56): the exclude pin alone missed the other way to hide a file — a
  // narrowed `include` (say "tests/unit/**/*") would silently drop every other test from the
  // check. Both trees that hold tests must stay in it whole.
  it('includes the whole test tree and the whole source tree', () => {
    const text = readFileSync(join(__dirname, '..', 'tsconfig.tests.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const include = JSON.parse(text).include as string[];
    expect(include).toEqual(expect.arrayContaining(['tests/**/*', 'src/**/*']));
  });
});
