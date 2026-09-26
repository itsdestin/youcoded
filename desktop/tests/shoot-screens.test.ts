// The screen list (dev/workbench/screens) and the components' `useScreenOpen`
// registrations must agree, so neither can drift from the other.
//
// WHY source text and not an ast-grep rule: this compares two sets across many
// files (every registration vs. one list), which a per-file rule cannot see.
// WHY not at runtime here: registrations are only live in the photo-only
// build, which needs a browser (`shoot --check`, scripts/shoot/ in the workspace, opens every
// entry for real). This test is the browser-free half: it fails the moment a
// component registers a name the list lacks, a listed name has no registration
// anywhere, or the list repeats a name.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SCREENS } from '../src/renderer/dev/workbench/screens';

// Spelled `'..', 'src'` so scripts/verify.sh counts this file as a source-scanning
// guard and runs it on every change, not only when the list itself changes.
const SRC = join(__dirname, '..', 'src', 'renderer');

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

// useScreenOpen('name', opener, SUBPAGES?) — the literal name, and whether a
// sub-page list follows the opener (then `name/<page>` is registered too).
const CALL = /useScreenOpen\(\s*'([^']+)'/g;
const registered = new Map<string, { file: string; subpages: boolean }>();
for (const f of files(SRC)) {
  if (f.endsWith('shoot-mode.tsx')) continue;
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(CALL)) {
    // The call runs to the next registration (or 800 characters): a sub-page list
    // is an identifier after the opener's closing brace, `}, PAGE_IDS);`.
    const rest = text.slice(m.index!, m.index! + 800).split(/\buseScreenOpen\(/)[1];
    registered.set(m[1], { file: f.slice(SRC.length + 1), subpages: /\}\s*,\s*[A-Za-z_][\w.]*\s*\)\s*;/.test(rest) });
  }
}
// A `#state` entry opens as its plain name, so it is registered under that.
const listed = SCREENS.map((s) => s.name);
const base = (n: string) => n.split('#')[0];

describe('screen list ↔ useScreenOpen registrations', () => {
  it('finds registrations at all (the pattern still matches the code)', () => {
    expect(registered.size).toBeGreaterThan(5);
  });

  it('every registered name is in the screen list', () => {
    // A leading underscore is a helper the driver calls (`_select-session`), not a screen.
    // A parent that only opens its sub-pages (`pages/page` → pages/page/<id>) counts when one is listed.
    const missing = [...registered.entries()].filter(([n, r]) => !n.startsWith('_') && !listed.map(base).includes(n)
      && !(r.subpages && listed.some((l) => base(l).startsWith(n + '/')))).map(([n]) => n);
    expect(missing, 'add these to dev/workbench/screens/index.ts').toEqual([]);
  });

  it('every listed name is registered, directly or as a sub-page of its parent', () => {
    const orphans = listed.map(base).filter((n) => {
      if (registered.has(n)) return false;
      const parent = n.slice(0, n.lastIndexOf('/'));
      return !(registered.get(parent)?.subpages);
    });
    expect(orphans, 'no component registers these — add useScreenOpen or remove the entry').toEqual([]);
  });

  it('names are unique and every sameAs points at a listed screen', () => {
    expect(new Set(listed).size).toBe(listed.length);
    const bad = SCREENS.filter((s) => s.sameAs && !listed.includes(s.sameAs.name)).map((s) => s.name);
    expect(bad).toEqual([]);
  });
});
