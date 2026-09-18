// desktop/tests/helpers/guard-scope.ts
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { expect } from 'vitest';

/**
 * Shared machinery for the `*-authority` source-text guards.
 *
 * WHY THIS FILE EXISTS. Before it, `inScopeFiles()` was copy-pasted into six
 * test files and `stripComments()` into ten, in THREE different versions. Two
 * of this workstream's worst bugs were bugs in one copy:
 *
 *   - The dialog adoption guard's copy globbed `components/*.tsx`, so it could
 *     not see `App.tsx` or ANY subdirectory. It passed while blind to a third
 *     of its own stated scope; five unmigrated dialogs hid behind it.
 *   - Four older guards used a `stripComments` that deleted block comments
 *     outright and dropped only lines STARTING with `//`. That misses trailing
 *     comments entirely (`foo(); // uses text-3xs uppercase` still matched) and
 *     shifts every line number after it, so any guard reporting a location
 *     reported the wrong one.
 *
 * A rule saying "check your scope" would not have caught either. One shared
 * definition does: fix it here and every guard inherits the fix.
 */

export const RENDERER = join(__dirname, '..', '..', 'src', 'renderer');
const COMPONENTS = join(RENDERER, 'components');

/**
 * The settings / status-bar dialog family — the surface the menu-internals kit
 * governs.
 *
 * IN: `App.tsx`, `components/*.tsx`, `components/development`, `components/ui`.
 *
 * OUT, and deliberately: marketplace, project-view, game, git, tags,
 * context-menu, buddy. Those are different surfaces with their own visual
 * language, recorded as residue rather than silently skipped.
 *
 * Note it walks explicit directories rather than taking a glob. A glob is what
 * hid the subdirectories last time — it looked like it covered the family and
 * did not, and nothing about reading it said otherwise.
 */
const IN_SCOPE_DIRS = ['', 'development', 'ui'];

export function inScopeFiles(exts: readonly string[] = ['.tsx']): string[] {
  const files = [join(RENDERER, 'App.tsx')];
  for (const dir of IN_SCOPE_DIRS) {
    const abs = join(COMPONENTS, dir);
    for (const f of readdirSync(abs)) {
      if (exts.some((e) => f.endsWith(e)) && !f.includes('.test.')) files.push(join(abs, f));
    }
  }
  return files;
}

/** File name without its directory — the key every exemption list is written in. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop()!;
}

/** Path relative to `src/renderer`, for readable failure messages. */
export function relPath(path: string): string {
  return path.replace(RENDERER, '');
}

/**
 * Blank out comments, PRESERVING offsets and line count.
 *
 * Mandatory for every source-text guard here, because the WHY comments these
 * migrations leave behind quote the idiom they replaced — a guard reading raw
 * text fails on the explanation of its own fix.
 *
 * Replacing rather than deleting is the load-bearing part: `slice(0, index)` and
 * `split('\n').length` are how these guards report where a match was, and a
 * stripper that removes characters makes every one of those numbers wrong.
 *
 * The `[^:]` before `//` keeps `https://` out of it.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

/** Read a source or config file as text, line endings normalised. WHY: a Windows
 *  checkout is CRLF, and every guard that split on '\n' saw a trailing \r on each
 *  line — two YAML guards returned null for every key (Windows CI, 2026-09-10 to
 *  09-16). Every text read in the test tree goes through here. */
export function readSource(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
}

/** Read a file with its comments blanked — what every guard actually wants. */
export function readStripped(path: string): string {
  return stripComments(readSource(path));
}

/**
 * 1-indexed line number of a character offset, for failure messages.
 * Correct only because `stripComments` preserves offsets.
 */
export function lineAt(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

// ── Non-vacuity ─────────────────────────────────────────────────────────────
//
// A source-text guard that matches nothing PASSES, and reads as "all clear".
// Three of this workstream's mistakes were exactly that. These two helpers turn
// "remember to check the guard can see" into a function call.

/**
 * Fails if the scope collapsed — a bad glob, a moved directory, a renamed
 * folder. Pass the smallest count that would still be plausible.
 */
export function assertScopeIsPopulated(files: string[], atLeast = 50): void {
  expect(
    files.length,
    `Guard scope collapsed to ${files.length} files. A guard scanning nothing passes and reads as clean.`,
  ).toBeGreaterThanOrEqual(atLeast);
}

/**
 * Fails if `pattern` cannot match something you KNOW it should — the cheapest
 * proof that a zero-offender result means "clean" rather than "broken".
 *
 * This is the check that would have caught the callout guard writing its
 * pattern as tint-then-`border`, which silently scored `Button.tsx` at zero
 * because that recipe reads `border border-destructive/50 … hover:bg-destructive/10`.
 *
 *   assertPatternMatches(TINTED, 'border border-destructive/50 hover:bg-destructive/10',
 *     'a border-first callout surface');
 */
export function assertPatternMatches(pattern: RegExp, knownPositive: string, label: string): void {
  // A /g regex carries lastIndex between calls; test a fresh one.
  const fresh = new RegExp(pattern.source, pattern.flags.replace('g', ''));
  expect(
    fresh.test(knownPositive),
    `This guard's pattern cannot match ${label}, so a clean result proves nothing. `
      + `Pattern: ${pattern}`,
  ).toBe(true);
}
