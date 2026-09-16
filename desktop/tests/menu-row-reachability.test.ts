// desktop/tests/menu-row-reachability.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { RENDERER, stripComments } from './helpers/guard-scope';

const modelPicker = stripComments(readFileSync(join(RENDERER, 'components', 'model', 'ModelPicker.tsx'), 'utf8'));

// Guard: the two reference lists that used to hide rows from the user.
//
// Phase E of the 2026-08-25 UI review (P-7, P-8) found both:
//
//   - Keyboard Shortcuts rendered thirteen shortcuts into a `prompt` dialog
//     with `scrollBody={false}`. The dialog caps at 476px, the list needs
//     ~550px, and with the scroll body switched off there was no scrollable
//     region ANYWHERE — the last three shortcuts could not be reached at any
//     window size. It looked fine in every screenshot, because a clipped list
//     looks exactly like a short one.
//   - The All Sessions menu wrapped session names to three lines to keep the
//     whole name visible, which made rows 42–70px tall and cost the list two
//     rows of its height. The name is now one line with the full text on hover.
//
// Both are source-text checks on purpose: jsdom has no layout, so a render test
// cannot tell a reachable row from a clipped one.

// Comments are stripped: the WHY note above the fixed dialog quotes the very
// prop this guard forbids, and a guard that reads its own explanation as code
// fails on the fix it is guarding.
const settings = stripComments(readFileSync(join(RENDERER, 'components', 'SettingsPanel.tsx'), 'utf8'));
const strip = stripComments(readFileSync(join(RENDERER, 'components', 'SessionStrip.tsx'), 'utf8'));

// Slice one top-level function, from its `function X` line to the next one.
// A fixed character window bled into the NEXT component and read its props as
// this one's — the guard failed on a `scrollBody={false}` that was never here.
function block(src: string, startsWith: string): string {
  const i = src.indexOf(startsWith);
  expect(i, `${startsWith} not found — this guard is looking at the wrong file`).toBeGreaterThan(-1);
  const rest = src.slice(i + startsWith.length);
  const end = rest.search(/\n(?:export )?function /);
  return startsWith + (end === -1 ? rest : rest.slice(0, end));
}

describe('reference lists stay reachable', () => {
  const shortcuts = block(settings, 'function ShortcutsPopup');

  it('the shortcuts dialog keeps the scrolling body', () => {
    // The dialog's own body is the only scroll region it has.
    expect(shortcuts).not.toMatch(/scrollBody=\{false\}/);
  });

  it('the shortcuts dialog is the wider size', () => {
    // `prompt` (340px) wrapped four of the labels onto a second line.
    expect(shortcuts).toMatch(/size="panel"/);
  });

  it('every shortcut in the list is rendered from the list itself', () => {
    // Guard sees what it claims: the list is long enough to overflow.
    const rows = [...settings.matchAll(/\{ keys: '/g)].length;
    expect(rows).toBeGreaterThanOrEqual(13);
    expect(shortcuts).toMatch(/SHORTCUTS\.map/);
  });

  it('a session name is one truncated line with the full name on hover', () => {
    const name = block(strip, 'function SessionName');
    expect(name).toMatch(/truncate/);
    expect(name).toMatch(/<Tooltip text=\{name\}>/);
    // The three-line clamp is what made the rows uneven.
    expect(name).not.toMatch(/WebkitLineClamp/);
  });

  it('the session menu gives its list the remaining screen height', () => {
    // The footer contains the New Session path, so the list must flex and scroll
    // before it can move below the viewport on a short display.
    expect(strip).toMatch(/height: undefined/);
    expect(strip).toMatch(/maxHeight: `min\(680px, \$\{belowTrigger\}\)`/);
    expect(strip).toMatch(/maxHeight: 'var\(--session-menu-available-height\)'/);
    expect(strip).toMatch(/var\(--vvp-offset, 0px\)/);
    expect(strip).toMatch(/className="scroll-fade flex-1"/);
    expect(strip).toMatch(/className="scroll-fade flex-1 py-1"/);
  });

  it('the model filter portal remains inside its session-menu host', () => {
    // Both ModelPicker portals need this marker: its filter panel is a sibling
    // of the main picker panel in document.body, not a descendant of it.
    expect(modelPicker.match(/data-model-picker-portal=""/g)).toHaveLength(2);
  });

  it('opens a model panel upward when its trigger lacks room below', () => {
    // A picker in New Session can sit at the bottom of an otherwise valid menu.
    // It must use the room above rather than render its rows beyond the viewport.
    expect(modelPicker).toMatch(/const opensUpward = spaceBelow < 180 && spaceAbove > spaceBelow/);
    expect(modelPicker).toMatch(/opensUpward \? \{ bottom: window\.innerHeight - r\.top \+ gap \} : \{ top: r\.bottom \+ gap \}/);
  });
});
