// desktop/tests/menu-row-reachability.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { RENDERER, stripComments } from './helpers/guard-scope';

// Most of this file's cases converted to ast-grep rules —
// scripts/ast-grep/rules/shortcuts-dialog-keeps-scroll-body(.yml, -session-name.yml,
// -session-menu-height.yml, -model-picker-upward.yml) (Plan B, 2026-09-16).
//
// Dropped, not converted (Class H — a quantity/non-vacuity check, not a
// shape ban): "every shortcut in the list is rendered from the list
// itself"'s row-count half — `rows = [...settings.matchAll(/{ keys: '/g)].length;
// expect(rows).toBeGreaterThanOrEqual(13)`. That half asserted "the list is
// long enough to overflow", which has nothing left to guard once the shape
// check (SHORTCUTS.map presence, folded into shortcuts-dialog-keeps-scroll-body)
// is an ast-grep rule — the fixture pass in scripts/ast-grep/check.sh is the
// non-vacuity check now.
//
// Kept here: the ONE case ast-grep cannot express — an EXACT count (2, not
// "at least 2" or "present/absent") of a marker attribute across the whole
// file. A whole-file rule can ban or require presence, but not pin a count,
// so per global.md's "at most N matches" guidance this stays as a small
// text case rather than being dropped.
const modelPicker = stripComments(readFileSync(join(RENDERER, 'components', 'model', 'ModelPicker.tsx'), 'utf8'));

describe('reference lists stay reachable', () => {
  it('the model filter portal remains inside its session-menu host', () => {
    // Both ModelPicker portals need this marker: its filter panel is a sibling
    // of the main picker panel in document.body, not a descendant of it.
    expect(modelPicker.match(/data-model-picker-portal=""/g)).toHaveLength(2);
  });
});
