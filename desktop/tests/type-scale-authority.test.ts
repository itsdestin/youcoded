import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { stripComments, RENDERER } from './helpers/guard-scope';

// Guard for tranche 6 (change 35): the renderer's type scale is enumerable.
//
// Before this, 572 sites across 87 files set their font size with an arbitrary
// `text-[10px]` / `text-[11px]` / `text-[13px]` etc. Nothing listed the sizes the
// app actually used, so "make this one step smaller" meant grepping for a pixel
// value and hoping you found every sibling. Naming them makes the scale greppable
// and makes a new odd size a visible decision instead of a silent one.
//
// Source-text assertion rather than a render test on purpose: the failure mode is
// a future session typing `text-[10px]` into one new component, which renders
// perfectly and only shows up as scale drift months later.


// The named steps. Below text-xs (12px) the ladder is 2xs/3xs/4xs; text-sm-tight
// is the one step ABOVE xs that Tailwind's scale is missing (see globals.css).
const NAMED_TOKENS = ['--text-2xs', '--text-3xs', '--text-4xs', '--text-sm-tight'];

// Comments are allowed to quote the retired class names — several WHY comments
// exist precisely to record what a site used to be. Strip block comments (which
// covers JSX `{/* ... */}` too) and whole-line `//` comments before scanning, so
// the invariant is about what SHIPS in a class list, not what prose may mention.
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe('type scale authority', () => {
  it('every step of the sub-Tailwind scale is defined in globals.css', () => {
    const css = readFileSync(join(RENDERER, 'styles', 'globals.css'), 'utf8');
    for (const token of NAMED_TOKENS) {
      expect(css, `${token} must be declared in the @theme block`).toMatch(
        new RegExp(`${token}:\\s*\\d+px`),
      );
    }
  });

  // Decimal sizes too (text-[12.5px]): 29 of them slipped past the whole-pixel
  // pattern until the design check found them, 2026-09-14.
  it('no component sets a font size with an arbitrary text-[Npx]', () => {
    const offenders: string[] = [];
    for (const file of walk(join(RENDERER))) {
      const src = stripComments(readFileSync(file, 'utf8'));
      src.split('\n').forEach((line, i) => {
        for (const hit of line.match(/text-\[\d+(?:\.\d+)?px\]/g) ?? []) {
          offenders.push(`${file.slice(RENDERER.length + 1)}:${i + 1}  ${hit}`);
        }
      });
    }
    expect(
      offenders,
      'Use a named step (text-4xs/3xs/2xs/xs/sm-tight/sm/base/lg). If the app '
        + 'genuinely needs a new size, add it to the @theme block in globals.css '
        + 'and to NAMED_TOKENS here — that is the decision this guard exists to force.',
    ).toEqual([]);
  });
});
