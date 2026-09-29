import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, it, expect } from 'vitest';
import { readStripped, RENDERER } from './helpers/guard-scope';

// Guard for K1 (menu-internals tranche 1), REPURPOSED by the labels batch
// (guide: no spaced capitals — decisions H-3/L-1…L-4).
//
// This file used to also assert the class-set-not-order recipe and the <h4>
// ban — both converted to ast-grep rules `section-label-canonical-classes`
// (+ its `-ts` twin) and `section-label-no-h4` (retired by Plan B,
// 2026-09-16). It then asserted the recipe was in use across >25 files, as a
// non-vacuity check on the walk. That assertion is now FALSE ON PURPOSE: the
// labels batch migrated every real (non-exempt) site off the spaced-caps
// eyebrow onto the shared `<SectionLabel>` primitive, so the recipe's only
// remaining adopters are the guide's named exemptions (tool cards, tool-views,
// the file viewer, and dev/** workbench-only code). Re-asserting "more than
// 25" would just mean the migration slid backwards.
//
// Repurposed into the guard ast-grep can't express: a closed allowlist. A new
// adopter outside it means either a spaced-caps label crept back into a real
// screen, or this file needs a deliberate new exemption — either way, look.

const CANONICAL = 'text-3xs font-medium text-fg-muted tracking-wider uppercase';

// Every current real adopter, as of the labels batch (2026-09-28). Paths are
// relative to RENDERER (src/renderer).
const ALLOWED_ADOPTERS = new Set([
  // Tool cards — exempt (owner's decision; not yet redesigned).
  'components/tool-views/ToolBody.tsx',
  // The dedicated file viewer — exempt ("file viewers").
  'components/artifact-views/ActiveArtifactView.tsx',
  // dev/** is workbench-only, never in the shipped bundle — exempt.
  'dev/workbench/compare/permission-modes.ts',
  'dev/workbench/WorkbenchToolbar.tsx',
  'dev/workbench/compare/registry.tsx',
  'dev/workbench/mockups/CardAnatomyDemo.tsx',
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const FILES = walk(RENDERER).map((path) => ({ path, src: readStripped(path) }));

describe('section label authority', () => {
  it('the spaced-caps recipe never adopts a new, non-exempt site', () => {
    const users = FILES
      .filter(({ src }) => src.includes(CANONICAL))
      .map(({ path }) => relative(RENDERER, path).split('\\').join('/'));
    const unexpected = users.filter((p) => !ALLOWED_ADOPTERS.has(p));
    expect(unexpected).toEqual([]);
  });

  it('the allowlist itself still names real files (non-vacuity)', () => {
    // Cheapest proof the walk still reaches real files — a guard scanning
    // nothing passes and reads as clean (global.md's non-vacuity rule).
    const users = new Set(
      FILES
        .filter(({ src }) => src.includes(CANONICAL))
        .map(({ path }) => relative(RENDERER, path).split('\\').join('/')),
    );
    for (const allowed of ALLOWED_ADOPTERS) {
      expect(users.has(allowed)).toBe(true);
    }
  });
});
