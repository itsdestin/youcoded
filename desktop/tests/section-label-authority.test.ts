import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { readStripped, RENDERER } from './helpers/guard-scope';

// Guard for K1 (menu-internals tranche 1): a section label has ONE spelling.
//
// This file used to also assert the class-set-not-order recipe and the <h4>
// ban — both converted to ast-grep rules `section-label-canonical-classes`
// (+ its `-ts` twin) and `section-label-no-h4` (retired by Plan B,
// 2026-09-16). What's left is the ONE case ast-grep cannot express: a plain
// count of real adopters, kept per global.md's non-vacuity rule (a guard
// scanning nothing passes and reads as clean — this is the cheapest proof
// the walk still reaches real files).

const CANONICAL = 'text-3xs font-medium text-fg-muted tracking-wider uppercase';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const FILES = walk(RENDERER).map((path) => ({ path, src: readStripped(path) }));

describe('section label authority', () => {
  it('the canonical recipe is actually in use', () => {
    // Sanity: if this reads zero the walk broke and the (now retired) class-set
    // guard would have been vacuous.
    const users = FILES.filter(({ src }) => src.includes(CANONICAL));
    expect(users.length).toBeGreaterThan(25);
  });
});
