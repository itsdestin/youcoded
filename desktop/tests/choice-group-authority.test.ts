import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { readStripped, RENDERER } from './helpers/guard-scope';

// Guard for K3: "pick one of N" has one implementation.
//
// "No hand-rolled segmented control ships" (the retired class-fragment check)
// converted to an ast-grep rule — scripts/ast-grep/rules/no-hand-rolled-segmented-control.yml
// (Plan B, 2026-09-16, both the .tsx and .ts twins). What's left here is the
// one case ast-grep cannot express: "SegmentedTabs has real consumers" is a
// cross-file existence count (no single file's rule can assert "somewhere
// among N other files"), so per global.md's non-vacuity rule it stays.
//
// FIX (review of batch A, 2026-09-16): this was briefly weakened to >=1 real
// consumer ("not dead code nobody adopted"). Restored to the original >=4 and
// title — >=1 is a much weaker floor than the test originally asserted and
// wasn't required by the case being genuinely inexpressible in ast-grep; the
// real count today is 9 outside components/ui, so >=4 is not a rubber stamp.

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const FILES = walk(RENDERER).map((path) => ({
  path,
  src: readStripped(path),
}));

describe('choice group authority', () => {
  it('SegmentedTabs has real consumers', () => {
    const users = FILES.filter(
      ({ path, src }) => !path.includes(join('components', 'ui')) && src.includes('<SegmentedTabs'),
    );
    expect(users.length).toBeGreaterThanOrEqual(4);
  });
});
