// desktop/tests/field-error-adoption.test.ts
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { RENDERER, readSource } from './helpers/guard-scope';

// "No file hand-rolls the primitive markup" converted to an ast-grep rule —
// scripts/ast-grep/rules/no-hand-rolled-field-error.yml (Plan B, 2026-09-16).
// That rule's `ignores:` exempts the two files below WHOLESALE, which is
// weaker than what this test used to check: the retired test asserted each
// exemption's count is EXACTLY 1 (not "0 or more") AND that the exemption
// still matches something (so a fixed site doesn't silently keep a grant it
// no longer needs). A whole-file `ignores:` cannot express "at most 1 here",
// so per global.md's "at most N matches" guidance this ONE case stays,
// routed through readSource rather than dropped.
//
// The regex is the same one the retired test used, kept private to this
// file rather than shared, since the ast-grep rule is now the primary guard
// and this is a narrow bookkeeping check on exactly two named files.
const EXEMPT: Record<string, { count: number; why: string }> = {
  'GitReviewView.tsx': { count: 1, why: 'destructive text button' },
  'UpdateButton.tsx': { count: 1, why: 'role="status" by design' },
};

function handRolledCount(src: string): number {
  return (src.match(/text-[23]xs text-destructive-fg(?![/\w-])/g) ?? []).length;
}

describe('FieldError adoption exemptions', () => {
  it('an exemption covers exactly the occurrences it was granted for', () => {
    const files = [
      join(RENDERER, 'components', 'git', 'GitReviewView.tsx'),
      join(RENDERER, 'components', 'marketplace', 'UpdateButton.tsx'),
    ];
    const counts = new Map(
      files.map((f) => [f.split(/[\\/]/).pop()!, handRolledCount(readSource(f))]),
    );
    for (const [name, { count, why }] of Object.entries(EXEMPT)) {
      expect(counts.get(name) ?? 0, `${name} (exempt: ${why})`).toBe(count);
    }
  });
});
