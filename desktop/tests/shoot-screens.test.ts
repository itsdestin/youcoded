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
    // follows the opener's closing brace — `}, PAGE_IDS)`, `}, ['docs'])`, `}, list.map(…))`.
    const rest = text.slice(m.index!, m.index! + 800).split(/\buseScreenOpen\(/)[1];
    registered.set(m[1], { file: f.slice(SRC.length + 1), subpages: /\}\s*,\s*(?!undefined\b)[\w.[]/.test(rest) });
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

// Every <Dialog> says which screen it is, or why it has none. WHY: the two checks above
// only compare names someone remembered to register; a NEW dialog with neither was
// invisible to `shoot --all` and nothing said so (16 files like that on 2026-09-26).
// The tag is read to its closing `>` with braces balanced, so a multi-line tag counts.
function openingTags(text: string, name: string): { line: number; tag: string }[] {
  const out: { line: number; tag: string }[] = [];
  for (const m of text.matchAll(new RegExp(`<${name}\\b`, 'g'))) {
    // Skip mentions inside comments (`// … <Dialog>` or a JSDoc line).
    const lineStart = text.lastIndexOf('\n', m.index!) + 1;
    if (/^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, m.index!))) continue;
    let i = m.index! + m[0].length; let depth = 0;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '{') depth++; else if (c === '}') depth--; else if (c === '>' && depth === 0) break;
    }
    out.push({ line: text.slice(0, m.index!).split('\n').length, tag: text.slice(m.index!, i + 1) });
  }
  return out;
}

describe('every dialog is a screen, or says why not', () => {
  const dialogs: { where: string; tag: string }[] = [];
  for (const f of files(SRC)) {
    if (f.endsWith(join('ui', 'Dialog.tsx')) || f.includes(join('workbench', 'compare'))) continue;
    const text = readFileSync(f, 'utf8');
    for (const d of openingTags(text, 'Dialog')) dialogs.push({ where: `${f.slice(SRC.length + 1)}:${d.line}`, tag: d.tag });
  }

  it('finds dialogs at all (the pattern still matches the code)', () => {
    expect(dialogs.length).toBeGreaterThan(20);
  });

  it('each <Dialog> has screen= or noScreen="<why>"', () => {
    const bare = dialogs.filter((d) => !/\bscreen=/.test(d.tag) && !/\bnoScreen="[^"]{10,}"/.test(d.tag)).map((d) => d.where);
    expect(bare, 'give each a screen name (and a useScreenOpen + list entry), or noScreen="<why it cannot open directly>"').toEqual([]);
  });

  it('a literal screen= name is in the screen list', () => {
    const unknown = dialogs.flatMap((d) => [...d.tag.matchAll(/\bscreen="([^"]+)"/g)].map((m) => m[1]))
      .filter((n) => !listed.map(base).includes(n));
    expect(unknown).toEqual([]);
  });
});
