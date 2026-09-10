// desktop/tests/unselectable-chrome.test.ts
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { RENDERER, readStripped, assertPatternMatches } from './helpers/guard-scope';

// Guard for "app chrome is not highlightable or copyable" (Destin, 2026-09-10).
//
// What Ctrl+A paints is decided by CSS and class names, which no DOM test sees:
// jsdom applies neither the stylesheet nor Tailwind. So this pins the SOURCE of
// both halves. The right-click half is pinned behaviourally in
// components/context-menu/build-menu.test.tsx.

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

describe('chrome areas carry select-none on their own root', () => {
  const cases: Array<[label: string, file: string[], pattern: RegExp, positive: string]> = [
    ['status bar', ['components', 'StatusBar.tsx'], /className="status-bar\b[^"]*\bselect-none\b/, 'className="status-bar flex select-none"'],
    ['header bar', ['components', 'HeaderBar.tsx'], /className="header-bar\b[^"]*\bselect-none\b/, 'className="header-bar flex select-none"'],
    ['composer', ['components', 'InputBar.tsx'], /className="input-bar-container\b[^"]*\bselect-none\b/, 'className="input-bar-container shrink-0 select-none"'],
    ['quick chips', ['components', 'QuickChips.tsx'], /<div className="[^"]*\bselect-none\b[^"]*">\s*<div className="flex gap-1 px-3 py-1 overflow-x-auto/, '<div className="relative select-none">\n <div className="flex gap-1 px-3 py-1 overflow-x-auto'],
    ['thinking line', ['components', 'ThinkingIndicator.tsx'], /data-testid="thinking-indicator" className="[^"]*\bselect-none\b/, 'data-testid="thinking-indicator" className="flex select-none"'],
    ['empty-chat hint', ['components', 'ChatView.tsx'], /className="[^"]*\bselect-none\b[^"]*"[^>]*>\s*Start a conversation with/, 'className="absolute select-none"\n style={{ top: 1 }}\n >\n Start a conversation with'],
    ['no-session title', ['App.tsx'], /className="[^"]*\bselect-none\b[^"]*">No Active Session</, '<p className="text-xl select-none">No Active Session<'],
    ['tool card title (both header variants)', ['components', 'ToolCard.tsx'], /const headerClass = isCompactSkill\s*\?\s*'[^']*\bselect-none\b[^']*'\s*:\s*'[^']*\bselect-none\b[^']*'/, "const headerClass = isCompactSkill\n ? 'w-full select-none'\n : 'w-full select-none';"],
  ];

  for (const [label, file, pattern, positive] of cases) {
    it(label, () => {
      assertPatternMatches(pattern, positive, label);
      expect(read(...file), `${label}: select-none missing`).toMatch(pattern);
    });
  }
});

describe('a button whose label is message content opts back in', () => {
  it('both clickable file-name variants carry select-text', () => {
    const src = read('components', 'FilepathToken.tsx');
    // Each <button …>…</button> element that carries the right-click path marker.
    const fileButtons = src.split('<button').slice(1)
      .map((chunk) => chunk.slice(0, chunk.indexOf('</button>')))
      .filter((el) => el.includes('data-file-path='));
    expect(fileButtons.length, 'expected the inline and pill variants').toBe(2);
    for (const el of fileButtons) expect(el).toMatch(/className="[^"]*\bselect-text\b/);
  });
});
