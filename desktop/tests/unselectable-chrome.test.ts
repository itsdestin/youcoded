// desktop/tests/unselectable-chrome.test.ts
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { RENDERER, readStripped, assertPatternMatches } from './helpers/guard-scope';

// Guard for "app chrome is not highlightable or copyable" (Destin, 2026-09-10).
//
// What Ctrl+A paints is decided by CSS and class names, which no DOM test sees:
// jsdom applies neither the stylesheet nor Tailwind. So this pins the SOURCE of
// the stylesheet half. The right-click half is pinned behaviourally in
// components/context-menu/build-menu.test.tsx.
//
// WHY only globals.css here (Plan B, 2026-09-16): the class-name half — every
// chrome root carries select-none, and both file-name buttons opt back in with
// select-text — is the ast-grep rules chrome-root-select-none-* and
// file-name-button-select-text. The stylesheet stays a text read: CSS is not an
// ast-grep language in this rule set.

const read = (...parts: string[]) => readStripped(join(RENDERER, ...parts));

// The body of every `@layer base { … }` block, found by brace matching.
function layerBaseBodies(css: string): string {
  let out = '';
  for (let at = css.indexOf('@layer base'); at !== -1; at = css.indexOf('@layer base', at + 1)) {
    const open = css.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) { out += css.slice(open + 1, i) + '\n'; break; }
    }
  }
  return out;
}

describe('globals.css: chrome is unselectable, text fields are not', () => {
  const css = read('styles', 'globals.css');
  const base = layerBaseBodies(css);

  const BUTTON_NONE = /(^|[\s,}])button\s*\{[^}]*(?<![-\w])user-select:\s*none/;
  const FIELDS_TEXT = /textarea:focus[^{]*\{[^}]*(?<![-\w])user-select:\s*text/;
  // A bare `textarea`/`input` selector (no :focus) re-enabling selection makes
  // Ctrl+A paint the empty composer's placeholder, measured 2026-09-10.
  const ALWAYS_ON_FIELD = /(^|[\s,{}])(textarea|input)\s*[,{]/;

  it('text fields are NOT re-enabled while unfocused', () => {
    assertPatternMatches(ALWAYS_ON_FIELD, '}\n  input,\n  textarea {\n user-select: text; }', 'ALWAYS_ON_FIELD');
    expect(base, 'an always-on text-field rule paints the empty composer on Ctrl+A').not.toMatch(ALWAYS_ON_FIELD);
  });

  it('every <button> is user-select: none, inside @layer base', () => {
    assertPatternMatches(BUTTON_NONE, 'x }\n  button {\n -webkit-user-select: none;\n user-select: none;\n }', 'BUTTON_NONE');
    // WHY @layer base and not unlayered: Tailwind v4 utilities live in
    // @layer utilities, and an unlayered rule would beat `select-text`.
    expect(base, 'button rule missing from @layer base').toMatch(BUTTON_NONE);
  });

  it('focused text fields re-enable selection, inside @layer base', () => {
    assertPatternMatches(FIELDS_TEXT, 'input:focus,\n textarea:focus,\n [contenteditable]:focus {\n user-select: text;\n }', 'FIELDS_TEXT');
    expect(base, 'text-field rule missing from @layer base').toMatch(FIELDS_TEXT);
  });
});
