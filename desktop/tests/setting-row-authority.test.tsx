// @vitest-environment jsdom
// desktop/tests/setting-row-authority.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { SettingRow } from '../src/renderer/components/ui/SettingRow';
import { inScopeFiles, stripComments, RENDERER, assertScopeIsPopulated } from './helpers/guard-scope';

// Guard for K2 — the setting row.
//
// Two kinds of assertion here, for two different failure modes:
//
//   RENDER, for the shape. K2's whole prize is that "the drawer row and the
//   in-menu row become the same object", and that the description ALWAYS lives
//   in the left column under the title. Those are structural claims, so they
//   are checked against a real render.
//
//   SOURCE-TEXT, for adoption. The way this erodes is not a bad edit to
//   SettingRow — it is the next popup hand-rolling `<div className="flex
//   items-center justify-between">` with a label and a <Toggle> in it, which
//   looks fine in isolation and only shows up as a fourth type size months
//   later. Five separate shapes got in exactly that way.

afterEach(cleanup);

function row(): HTMLElement {
  const el = document.querySelector('.bg-inset\\/50');
  if (!el) throw new Error('no row rendered');
  return el as HTMLElement;
}

describe('SettingRow densities', () => {
  // Both sizes below are Destin's, from looking at rendered UI: nav is change 51
  // (2026-07-16, "at 11px the title/subtitle gap read as too loose"), item is the
  // Sound preset list approved 2026-07-26. The spec asked for ONE size for every
  // row, which would have silently reverted the first of those.
  it('nav rows navigate: larger type and a chevron', () => {
    render(<SettingRow title="Appearance" description="Midnight" onClick={() => {}} />);
    expect(screen.getByText('Appearance').className).toContain('text-sm');
    expect(screen.getByText('Midnight').className).toContain('text-2xs');
    expect(row().querySelector('svg'), 'a row that navigates shows where it goes').not.toBeNull();
  });

  it('item rows are scanned: smaller type and no chevron', () => {
    render(<SettingRow variant="item" title="Reduced motion" description="Minimizes animations" control={<button>x</button>} />);
    expect(screen.getByText('Reduced motion').className).toContain('text-xs');
    expect(screen.getByText('Minimizes animations').className).toContain('text-3xs');
  });

  it('the two densities differ ONLY in type size', () => {
    // The consistency win K2 is actually buying is one geometry, one description
    // rule, one control vocabulary. If the variants ever diverge in padding,
    // radius or surface, a nav row and an item row stop stacking without a seam.
    render(<SettingRow title="A" onClick={() => {}} />);
    const nav = row().className;
    cleanup();
    render(<SettingRow variant="item" title="A" control={<span />} />);
    const item = row().className;
    for (const cls of ['px-3', 'py-2', 'rounded-lg', 'bg-inset/50', 'gap-3', 'items-center']) {
      expect(nav, `nav row missing ${cls}`).toContain(cls);
      expect(item, `item row missing ${cls}`).toContain(cls);
    }
  });
});

describe('SettingRow structure', () => {
  it('the description sits under the title, in the same column', () => {
    // THE one rule that retires all five shapes. The five were about placement,
    // not size: below the whole row (Sound), after the row (Buddy), as a K1
    // section label (Session Defaults, Skip Permissions), and as a stray <p>
    // outside the container (Buddy again — two placements in ONE popup).
    render(<SettingRow variant="item" title="Show buddy floater" description="A small mascot" control={<span />} />);
    const title = screen.getByText('Show buddy floater');
    const desc = screen.getByText('A small mascot');
    expect(desc.parentElement, 'description must be a sibling of the title').toBe(title.parentElement);
    expect(title.parentElement!.className).toContain('flex-1');
  });

  it('a navigating row is a button; a row with a control is not', () => {
    // Nested buttons are invalid HTML and break keyboard focus, so a row that
    // holds its own interactive control must not also be one.
    render(<SettingRow title="Appearance" onClick={() => {}} />);
    expect(row().tagName).toBe('BUTTON');
    cleanup();
    render(<SettingRow variant="item" title="Enabled" control={<button>t</button>} />);
    expect(row().tagName).not.toBe('BUTTON');
  });

  it('a control row can take a whole-row click without double-firing', () => {
    // This is what the <label> wrappers around the Remote Access toggles bought,
    // and what PerformancePopup hand-rolled as a closest('[role="switch"]')
    // guard. Without the stopPropagation, clicking the toggle would fire the
    // row handler too and land straight back where it started.
    const onRow = vi.fn();
    const onControl = vi.fn();
    render(
      <SettingRow variant="item" title="Enabled" onClick={onRow} control={<button onClick={onControl}>t</button>} />,
    );
    fireEvent.click(screen.getByText('t'));
    expect(onControl).toHaveBeenCalledTimes(1);
    expect(onRow, 'the control must not bubble into the row handler').not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Enabled'));
    expect(onRow).toHaveBeenCalledTimes(1);
  });

  it('onSelect renders a radio and makes the whole tile the hit target', () => {
    // K3's "any option needs a description" form is a K2 row with the Radio in
    // the icon slot. You should not have to aim at the 14px circle.
    const onSelect = vi.fn();
    render(<SettingRow variant="item" title="Chime" description="C5 → E5" selected onSelect={onSelect} />);
    const radio = screen.getByRole('radio');
    expect(radio).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByText('C5 → E5'));
    expect(onSelect).toHaveBeenCalled();
  });

  it('titles wrap by default and clip only when asked', () => {
    // Row titles are authored copy; clipping them silently loses words. Only a
    // filename the user chose is unbounded enough to need truncation.
    render(<SettingRow variant="item" title="Pin buddy above other windows (KDE only)" control={<span />} />);
    expect(screen.getByText(/Pin buddy/).className).not.toContain('truncate');
    cleanup();
    render(<SettingRow variant="item" title="my-sound.wav" truncateTitle control={<span />} />);
    expect(screen.getByText('my-sound.wav').className).toContain('truncate');
  });
});

// ── The adoption guard ──────────────────────────────────────────────────────


describe('setting row adoption', () => {
  it('this guard can see what it claims to cover', () => {
    // A source-text guard that matches nothing PASSES and reads as clean.
    // Three of this workstream's worst misses were exactly that.
    assertScopeIsPopulated(inScopeFiles());
  });

  it('the retired row recipes are gone', () => {
    // Verbatim class strings from the five shapes K2 replaced. A string match is
    // enough HERE (unlike K1, which had to match on the class SET) because these
    // are whole hand-rolled row containers, not a multi-class recipe someone can
    // re-order — if a variant reappears the count assertion below catches it.
    const RETIRED = [
      'flex items-start justify-between gap-3 p-2 rounded hover:bg-inset',        // Preferences ToggleRow, ModelPicker fast mode
      'flex items-start gap-3 p-2 rounded hover:bg-inset cursor-pointer',         // Preferences permission-mode list
      'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50',        // DevelopmentPopup Row
      'flex items-center gap-3 px-3 py-2 rounded-lg bg-inset/50 hover:bg-inset cursor-pointer', // Sound presets
      'w-full text-left flex items-start gap-3 p-3 rounded-lg hover:bg-inset',    // PerformancePopup power-saving row
    ];
    const offenders: string[] = [];
    for (const file of inScopeFiles()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const recipe of RETIRED) {
        if (src.includes(recipe)) offenders.push(`${file.replace(RENDERER, '')}: ${recipe}`);
      }
    }
    expect(offenders, 'Setting rows go through <SettingRow>.').toEqual([]);
  });

  /**
   * Every <Toggle> in scope that is NOT in a SettingRow's control slot, by file.
   *
   * A count rather than a bare file list, because SettingsPanel legitimately has
   * both: eight of its toggles are SettingRow controls now and two are not. A
   * file-level exemption would let a ninth hand-rolled toggle row in without a
   * word. Adding one here should mean writing down why.
   *
   * These are not oversights — each is a surface with a different job:
   */
  const TOGGLES_OUTSIDE_A_ROW: Record<string, { count: number; why: string }> = {
    'App.tsx': { count: 1, why: 'welcome screen new-session form — a form, not a settings list' },
    'SessionStrip.tsx': { count: 2, why: 'new-session form in the session dropdown, same as App.tsx' },
    'SettingsPanel.tsx': {
      count: 2,
      why: "the local Toggle wrapper's own definition, and Sound's category switch — "
        + 'the only row in the family whose label lives OUTSIDE it (in the tab above), '
        + 'so it has no title for the description to sit under',
    },
    'SyncPanel.tsx': { count: 2, why: 'K6 sync-space list rows — a per-item list, not settings rows' },
    'ProvidersSection.tsx': { count: 1, why: 'K6 provider list row' },
    'SyncSetupWizard.tsx': { count: 1, why: 'a wizard step, not a settings menu' },
    'ResumeBrowser.tsx': { count: 1, why: 'L1 drawer — out of the dialog family entirely' },
    // The Resume browser's Skip Permissions / new-window switches, moved into a
    // shared file (2026-09-16) so the Projects preview draws the same block.
    'ResumeOptions.tsx': { count: 2, why: 'the Resume browser\'s launch switches, shared with the Projects preview — same drawer styling, not a settings menu' },
    'CloseSessionPrompt.tsx': { count: 1, why: 'dialog footer: "Don\'t show again" beside the confirm button — a footer convention, not a settings row (P-15, 2026-08-26)' },
  };

  function togglesOutsideARow(src: string): number {
    const clean = stripComments(src);
    let n = 0;
    for (const m of clean.matchAll(/<(Ui)?Toggle\b/g)) {
      const before = clean.slice(0, m.index);
      const slot = before.lastIndexOf('control={');
      // In a control slot only if nothing has closed a tag since it opened.
      const inSlot = slot !== -1 && !before.slice(slot).includes('/>') && !before.slice(slot).includes('</');
      if (!inSlot) n++;
    }
    return n;
  }

  it('no in-scope file grows a new hand-rolled toggle row', () => {
    const drift: string[] = [];
    for (const file of inScopeFiles()) {
      const name = file.split(/[\\/]/).pop()!;
      if (name === 'Toggle.tsx' || name === 'SettingRow.tsx') continue;  // where it is defined / rendered
      const n = togglesOutsideARow(readFileSync(file, 'utf8'));
      const allowed = TOGGLES_OUTSIDE_A_ROW[name]?.count ?? 0;
      if (n !== allowed) drift.push(`${name}: ${n} outside a SettingRow, expected ${allowed}`);
    }
    expect(
      drift,
      'A label with a switch beside it is a <SettingRow variant="item" control={<Toggle .../>} />. '
        + 'If this row genuinely is not one, add it to TOGGLES_OUTSIDE_A_ROW with the reason.',
    ).toEqual([]);
  });

  it('every exemption still exists and still applies', () => {
    // An exemption is a liability the moment it stops being true — the four in
    // the dialog guard included two that were simply wrong, written off on a
    // class string without reading the style object beneath it.
    const byName = new Map(inScopeFiles().map((p) => [p.split(/[\\/]/).pop()!, p]));
    for (const [file, { count, why }] of Object.entries(TOGGLES_OUTSIDE_A_ROW)) {
      const abs = byName.get(file);
      expect(abs, `${file} is exempted but no longer in scope — drop it`).toBeTruthy();
      expect(
        togglesOutsideARow(readFileSync(abs!, 'utf8')),
        `${file} (${why}) no longer has ${count} — update or drop the exemption`,
      ).toBe(count);
    }
  });

  it('no control is styled as a field it is not', () => {
    // K7. The project folder rendered as a <button> wearing the FIELD surface —
    // bg-inset + border-edge-dim — so it looked typeable and was not. A value
    // chosen elsewhere (an OS picker, a dialog, another screen) is a value row
    // plus a Change button, which says what it is and how to change it.
    const offenders: string[] = [];
    for (const file of inScopeFiles()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/className="[^"]*\bbg-inset border border-edge-dim\b[^"]*"/g)) {
        // Walk back to the element this className belongs to.
        const openTag = src.lastIndexOf('<', m.index);
        if (src.startsWith('<button', openTag)) {
          offenders.push(`${file.replace(RENDERER, '')}:${src.slice(0, m.index).split('\n').length}`);
        }
      }
    }
    expect(
      offenders,
      'A <button> must not wear the field surface — it reads as typeable. Use a value row + Change.',
    ).toEqual([]);
  });
});
