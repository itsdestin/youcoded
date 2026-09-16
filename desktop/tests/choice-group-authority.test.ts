import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { readStripped, RENDERER } from './helpers/guard-scope';

// Guard for K3: "pick one of N" has one implementation.
//
// "No hand-rolled segmented control ships" (the retired class-fragment check)
// converted to an ast-grep rule — scripts/ast-grep/rules/no-hand-rolled-segmented-control.yml
// (Plan B, 2026-09-16). What's left here is the one case ast-grep cannot
// express: "SegmentedTabs has real consumers" is a cross-file existence count
// (no single file's rule can assert "somewhere among N other files"), so per
// global.md's non-vacuity rule it stays, weakened from >=4 to the floor that
// still means something — >=1 real consumer, i.e. the primitive is not dead
// code nobody adopted.

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
  it('SegmentedTabs has at least one real consumer', () => {
    const users = FILES.filter(
      ({ path, src }) => !path.includes(join('components', 'ui')) && src.includes('<SegmentedTabs'),
    );
    expect(users.length).toBeGreaterThanOrEqual(1);
  });
});
