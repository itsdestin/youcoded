// desktop/tests/item-list-authority.test.ts
import { describe, it, expect } from 'vitest';
import { inScopeFiles, readSource } from './helpers/guard-scope';

// "No bare glyph survives..." and "no in-menu copy tells the user to press a
// control that was removed" converted to ast-grep rules —
// scripts/ast-grep/rules/no-bare-glyph-item-action.yml and
// -stale-copy.yml (Plan B, 2026-09-16). Those rules' `ignores:` exempt
// QueuedMessagesStrip.tsx WHOLESALE, weaker than what this test used to
// check: the retired test asserted the exemption's count is EXACTLY 1 (not
// "0 or more"). A whole-file `ignores:` cannot express "at most 1 here", so
// per global.md's "at most N matches" guidance this ONE case stays.
//
// Dropped, not converted: "this guard can see what it claims to cover"
// (assertScopeIsPopulated) — a pure scan-count non-vacuity check with
// nothing left to guard once the shape check is an ast-grep rule; the
// fixture pass in scripts/ast-grep/check.sh is the non-vacuity check now.
const GLYPH_EXEMPT: Record<string, { count: number; why: string }> = {
  'QueuedMessagesStrip.tsx': {
    count: 1,
    why: 'already a <Button variant="ghost" size="icon"> with a real aria-label and focus ring — '
      + 'the glyph is its visible label, not a hand-rolled button. Compact composer strip, not a settings list.',
  },
};

function bareGlyphs(src: string): number {
  return [...src.matchAll(/>\s*✕\s*</g)].length;
}

describe('item list actions exemptions', () => {
  it('an exemption covers exactly the occurrences it was granted for', () => {
    const byName = new Map(inScopeFiles().map((p) => [p.split(/[\\/]/).pop()!, p]));
    for (const [file, { count, why }] of Object.entries(GLYPH_EXEMPT)) {
      const abs = byName.get(file);
      expect(abs, `${file} is exempted but no longer in scope — drop it`).toBeTruthy();
      expect(
        bareGlyphs(readSource(abs!)),
        `${file} (${why}) no longer has ${count} — update or drop the exemption`,
      ).toBe(count);
    }
  });
});
