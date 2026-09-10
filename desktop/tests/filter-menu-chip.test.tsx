// @vitest-environment jsdom
// FilterMenuChip + CheckboxMark — the Resume browser's filter row, 2026-09-10.
//
// Destin: the Projects / Tags / Most recent chips "feel very generic/unstyled,
// the margins are odd, and the down/up chevrons/arrows do not feel native to
// the app." What was there: a local 11px pill with a 9px "▾" text glyph in the
// decorative-only fg-faint token, "↓"/"↑" characters inside the sort label, and
// menu rows drawing a `w-3 h-3 rounded-sm border` box that turns into a circle
// on a big-radius theme. Three things are pinned here:
//   1. FilterMenuChip paints the app's ONE filter-pill recipe (FilterChip's
//      strings, verbatim) and the Select field's chevron — it is not a fourth
//      chip look.
//   2. CheckboxMark shares the Checkbox control's paints and its literal 4px
//      radius, so a menu row's box and a real Checkbox can never look different.
//   3. ResumeBrowser uses them: no local pill, no text-glyph chevrons or
//      arrows, no hand-drawn check boxes.
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, screen } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FilterMenuChip } from '../src/renderer/components/ui/FilterMenuChip';
import { FilterChip, FILTER_CHIP_BASE, FILTER_CHIP_ACTIVE, FILTER_CHIP_INACTIVE } from '../src/renderer/components/ui/FilterChip';
import { Checkbox, CheckboxMark } from '../src/renderer/components/ui/Checkbox';
import { pickLabel } from '../src/renderer/components/resume-browser-filters';
import { stripComments, RENDERER } from './helpers/guard-scope';

afterEach(cleanup);

describe('FilterMenuChip', () => {
  it('paints the shared filter-pill recipe, lit or not', () => {
    const { rerender } = render(<FilterMenuChip active={false} open={false} onClick={() => {}}>Projects</FilterMenuChip>);
    const chip = screen.getByRole('button', { name: 'Projects' });
    for (const cls of `${FILTER_CHIP_BASE} ${FILTER_CHIP_INACTIVE}`.split(' ')) expect(chip.classList.contains(cls)).toBe(true);
    rerender(<FilterMenuChip active open={false} onClick={() => {}}>Projects</FilterMenuChip>);
    for (const cls of `${FILTER_CHIP_BASE} ${FILTER_CHIP_ACTIVE}`.split(' ')) expect(chip.classList.contains(cls)).toBe(true);
    expect(chip.classList.contains('text-sm')).toBe(true); // never the old 11px pill again
  });

  it('is a menu trigger: haspopup, expanded, and a chevron that turns while open', () => {
    const { rerender } = render(<FilterMenuChip active={false} open={false} onClick={() => {}}>Tags</FilterMenuChip>);
    const chip = screen.getByRole('button', { name: 'Tags' });
    expect(chip.getAttribute('aria-haspopup')).toBe('listbox');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    const chevron = chip.querySelector('svg')!;
    expect(chevron).not.toBeNull();
    expect(chevron.getAttribute('aria-hidden')).toBe('true');
    // The Select field's glyph, not a "▾" character.
    expect(chevron.querySelector('path')!.getAttribute('d')).toBe('m6 9 6 6 6-6');
    expect(chip.textContent).not.toMatch(/[▾▴▼▲]/);
    expect(chevron.classList.contains('rotate-180')).toBe(false);
    rerender(<FilterMenuChip active={false} open onClick={() => {}}>Tags</FilterMenuChip>);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(chip.querySelector('svg')!.classList.contains('rotate-180')).toBe(true);
  });
});

describe('FilterChip kind="toggle"', () => {
  it('announces as a pressed button, not a checkbox, and keeps the same paint', () => {
    render(<FilterChip kind="toggle" active onClick={() => {}}>Oldest first</FilterChip>);
    const chip = screen.getByRole('button', { name: 'Oldest first' });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.getAttribute('role')).toBeNull();
    expect(chip.getAttribute('aria-checked')).toBeNull();
    for (const cls of `${FILTER_CHIP_BASE} ${FILTER_CHIP_ACTIVE}`.split(' ')) expect(chip.classList.contains(cls)).toBe(true);
  });

  it('leaves the default kind exactly as it was (the marketplace pin depends on it)', () => {
    render(<FilterChip active={false} onClick={() => {}}>Work</FilterChip>);
    const chip = screen.getByRole('checkbox', { name: 'Work' });
    expect(chip.getAttribute('aria-checked')).toBe('false');
    expect(chip.getAttribute('aria-pressed')).toBeNull();
  });
});

describe('CheckboxMark', () => {
  it('shares the Checkbox control paints and the literal 4px radius, and is decoration', () => {
    render(
      <>
        <Checkbox checked onChange={() => {}} aria-label="real" />
        <CheckboxMark checked className="mark-on" />
        <Checkbox checked={false} onChange={() => {}} aria-label="real-off" />
        <CheckboxMark checked={false} className="mark-off" />
      </>,
    );
    const paintOf = (el: Element) => [...el.classList].filter((c) => /^(bg-|border)/.test(c)).sort().join(' ');
    const realOn = screen.getByRole('checkbox', { name: 'real' });
    const realOff = screen.getByRole('checkbox', { name: 'real-off' });
    const markOn = document.querySelector('.mark-on')!;
    const markOff = document.querySelector('.mark-off')!;
    expect(paintOf(markOn)).toBe(paintOf(realOn));
    expect(paintOf(markOff)).toBe(paintOf(realOff));
    expect((markOn as HTMLElement).style.borderRadius).toBe('4px');
    expect(markOn.getAttribute('aria-hidden')).toBe('true');
    expect(markOn.querySelector('svg')).not.toBeNull();
    expect(markOff.querySelector('svg')).toBeNull();
  });
});

describe('chip labels (pickLabel — contract R4)', () => {
  // Deck round 1, S-5: nothing picked → the category; one picked → its name;
  // two or more → the category and a count, like "Tags 2". Never parentheses,
  // never a comma-joined list of names.
  it('names the one pick and counts several', () => {
    expect(pickLabel('Projects', [])).toEqual({ text: 'Projects' });
    expect(pickLabel('Projects', ['youcoded'])).toEqual({ text: 'youcoded' });
    expect(pickLabel('Tags', ['work', 'bug'])).toEqual({ text: 'Tags', count: 2 });
    expect(pickLabel('Projects', ['a', 'b', 'c', 'd'])).toEqual({ text: 'Projects', count: 4 });
  });

  it('is what the Resume browser renders on both chips', () => {
    const src = stripComments(readFileSync(join(RENDERER, 'components/ResumeBrowser.tsx'), 'utf8'));
    expect(src.match(/pickLabel\('(Projects|Tags)'/g)).toEqual(["pickLabel('Projects'", "pickLabel('Tags'"]);
    expect(src).not.toMatch(/join\(', '\)/); // the old comma-joined names
    expect(src).not.toMatch(/Projects \(\$\{/); // the old "Projects (N)"
  });
});

describe('ResumeBrowser filter row', () => {
  const src = stripComments(readFileSync(join(RENDERER, 'components/ResumeBrowser.tsx'), 'utf8'));

  it('uses the shared chips, the shared search pill and the checkbox mark', () => {
    expect(src).toMatch(/<FilterMenuChip\b/);
    expect(src).toMatch(/<FilterChip\b[^>]*kind="toggle"/);
    expect(src).toMatch(/<SearchFilterPill\b/);
    expect(src).toMatch(/<CheckboxMark\b/);
    expect(src).not.toMatch(/function FilterPill\b/);
  });

  it('draws no text-glyph chevrons or arrows and no hand-made check box', () => {
    expect(src).not.toMatch(/[▾▴▼▲↓↑]/);
    expect(src).not.toMatch(/rounded-sm border \$\{checked/);
  });
});
