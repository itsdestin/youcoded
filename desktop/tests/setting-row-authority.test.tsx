// @vitest-environment jsdom
// desktop/tests/setting-row-authority.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SettingRow } from '../src/renderer/components/ui/SettingRow';
import { inScopeFiles, stripComments, readSource } from './helpers/guard-scope';

// Guard for K2 — the setting row.
//
// Two kinds of assertion here, for two different failure modes:
//
//   RENDER, for behaviour: button-vs-control, no double-fire, radio tile.
//   (Type sizes, classes and title wrapping are judged by screenshot review.)
//
//   ADOPTION. The way this erodes is not a bad edit to SettingRow — it is the
//   next popup hand-rolling `<div className="flex items-center
//   justify-between">` with a label and a <Toggle> in it, which looks fine in
//   isolation and only shows up as a fourth type size months later. Five
//   separate shapes got in exactly that way. WHY mostly not here (Plan B,
//   2026-09-16): those checks are ast-grep rules in youcoded-dev's
//   scripts/ast-grep/rules/ — no-hand-rolled-setting-row (the retired
//   recipes), no-hand-rolled-setting-row-toggle (a Toggle outside a control
//   slot) and no-button-styled-as-field. Only the exemption COUNTS below stay a
//   source read.

afterEach(cleanup);

function row(): HTMLElement {
  // WHY not a class selector: copy/styling is not asserted; the row is the render root.
  const el = document.body.firstElementChild?.firstElementChild;
  if (!el) throw new Error('no row rendered');
  return el as HTMLElement;
}

describe('SettingRow structure', () => {
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
    // This is what the <label> wrappers around the Remote access toggles bought,
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
});

// ── The adoption guard ──────────────────────────────────────────────────────


describe('setting row adoption', () => {
  /**
   * Every <Toggle> in scope that is NOT in a SettingRow's control slot, by file.
   *
   * A count rather than a bare file list, because SettingsPanel legitimately has
   * both: eight of its toggles are SettingRow controls now and two are not. A
   * file-level exemption would let a ninth hand-rolled toggle row in without a
   * word. Adding one here should mean writing down why — and adding the file to
   * the ignores: of the ast-grep rule no-hand-rolled-setting-row-toggle, which
   * holds every OTHER in-scope file at zero (youcoded-dev's check.sh fails if
   * the two lists differ).
   *
   * These are not oversights — each is a surface with a different job:
   */
  const TOGGLES_OUTSIDE_A_ROW: Record<string, { count: number; why: string }> = {
    'App.tsx': { count: 1, why: 'welcome screen new-session form — a form, not a settings list' },
    'SessionStrip.tsx': { count: 2, why: 'new-session form in the session dropdown, same as App.tsx' },
    'SettingsPanel.tsx': {
      count: 1,
      why: "Sound's category switch — "
        + 'the only row in the family whose label lives OUTSIDE it (in the tab above), '
        + 'so it has no title for the description to sit under',
    },
    // The Settings Toggle wrapper's definition moved here from SettingsPanel.tsx (2026-10-22 phone speed), so popups
    // that use it no longer pull all of Settings into the startup download.
    'settings-toggle.tsx': { count: 1, why: "the Settings Toggle wrapper's own definition" },
    // WHY count dropped 2 -> 1 (fix batch 1, 2026-09-24): the "Additional
    // backups" master toggle moved into a SettingRow's control slot when that
    // section was flattened out of its old border-dashed card (design guide
    // "Groups are flat"). The one remaining exemption is the main sync status
    // card's own enable toggle, which is not — the status card is a K6
    // per-item surface, not a settings row.
    'SyncPanel.tsx': { count: 1, why: 'K6 sync-space status card toggle — a per-item status surface, not a settings row' },
    'ProvidersSection.tsx': { count: 1, why: 'K6 provider list row' },
    // SyncSetupWizard.tsx left the list 2026-10-13 (small-fixes-3): its switch is the setting row now.
    'ResumeBrowser.tsx': { count: 1, why: 'L1 drawer — out of the dialog family entirely' },
    // The Resume browser's Skip permissions / new-window switches, moved into a
    // shared file (2026-09-16) so the Projects preview draws the same block.
    'ResumeOptions.tsx': { count: 2, why: 'the Resume browser\'s launch switches, shared with the Projects preview — same drawer styling, not a settings menu' },
    'CloseSessionPrompt.tsx': { count: 1, why: 'dialog footer: "Don\'t show again" beside the confirm button — a footer convention, not a settings row (P-15, 2026-08-26)' },
    'QuitSessionsPrompt.tsx': { count: 1, why: 'Destin\'s dictated layout (welcome-back design review 2, B-quit): the switch sits on the SAME row as the Close window button, not in a settings list' },
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

  it('every exemption still exists and still applies', () => {
    // An exemption is a liability the moment it stops being true — the four in
    // the dialog guard included two that were simply wrong, written off on a
    // class string without reading the style object beneath it.
    // WHY still a source read: "exactly N Toggles outside a row in THIS file"
    // is a per-file count, which an ast-grep rule cannot express.
    // WHY the rule named in the messages (review of u8): the same files are listed
    // under that rule's ignores:, and youcoded-dev's check.sh fails when the two differ.
    const RULE = "the rule's ignores: in youcoded-dev scripts/ast-grep/rules/no-hand-rolled-setting-row-toggle.yml";
    const byName = new Map(inScopeFiles().map((p) => [p.split(/[\\/]/).pop()!, p]));
    for (const [file, { count, why }] of Object.entries(TOGGLES_OUTSIDE_A_ROW)) {
      const abs = byName.get(file);
      expect(abs, `${file} is exempted but no longer in scope — drop it, and remove it from ${RULE}`).toBeTruthy();
      expect(
        togglesOutsideARow(readSource(abs!)),
        `${file} (${why}) no longer has ${count} — update the count, or drop the exemption and remove it from ${RULE}`,
      ).toBe(count);
    }
  });
});
