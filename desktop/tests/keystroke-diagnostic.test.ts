import { describe, it, expect } from 'vitest';
import { parseInkSelect, menuToButtons } from '../src/renderer/parser/ink-select-parser';

/**
 * The keystroke contract, per menu shape.
 *
 * This file used to assert the anchor-then-navigate sequence
 * (`UP×(n+2) + DOWN×index + \r`). That sequence was measured against the real CC
 * CLI (2.1.220) on 2026-07-26 and is wrong twice over:
 *
 *   - Arrows in a write that ends with `\r` are DISCARDED. CC acts on the Enter
 *     alone, confirming whatever option is highlighted. Every button on a menu
 *     therefore answered option 1 — on Resume Session that runs /compact, which
 *     is why "all options just compact the session" was reported.
 *   - The menus WRAP rather than clamp, so overshooting UP does not anchor at the
 *     top; `UP×5` on a 3-option menu moves index 0 → 1.
 *
 * So the contract is now: **type the option's printed number**. One byte, no
 * Enter, no dependence on cursor position. These tests pin that across the menu
 * shapes CC actually renders, and pin the "no arrows + CR in one write" rule that
 * the old sequence violated.
 */
describe('keystroke contract', () => {
  const UP = '\u001b[A';
  const DOWN = '\u001b[B';

  /** Every button must be a single write with no Enter in it, or an arrow write
   *  paired with a SEPARATE submit — never both in one string. */
  function expectNoMixedWrite(input: string, submitInput?: string) {
    const hasArrow = input.includes(UP) || input.includes(DOWN);
    expect(hasArrow && input.includes('\r')).toBe(false);
    if (submitInput) expect(submitInput).not.toMatch(/\u001b/);
  }

  describe('Resume Session menu (colon-numbered)', () => {
    const resumeSessionText = `Resume Session

Session is 45 minutes old. Resume from summary will compress context.

1: as is (full replay)
  ❯ 2: from summary (compressed)

Enter to confirm`;

    it('parses options and cursor position', () => {
      const menu = parseInkSelect(resumeSessionText);
      expect(menu).not.toBeNull();
      if (!menu) return;

      expect(menu.options).toEqual(['as is (full replay)', 'from summary (compressed)']);
      expect(menu.selectedIndex).toBe(1);
      expect(menu.optionNumbers).toEqual([1, 2]);
    });

    it('sends each option its own number', () => {
      const menu = parseInkSelect(resumeSessionText);
      if (!menu) return;
      const buttons = menuToButtons(menu);

      expect(buttons[0].input).toBe('1');
      expect(buttons[1].input).toBe('2');
      expect(buttons[0].input).not.toBe(buttons[1].input);
      buttons.forEach((b) => expectNoMixedWrite(b.input, b.submitInput));
    });
  });

  describe('theme selection menu (4 options)', () => {
    const themeMenuText = `Choose a Theme

Currently dark. Switch themes to preview styling.

1: light
2: dark
  ❯ 3: midnight
4: crème

Enter to confirm`;

    it('parses all four options', () => {
      const menu = parseInkSelect(themeMenuText);
      expect(menu).not.toBeNull();
      if (!menu) return;

      expect(menu.options).toHaveLength(4);
      expect(menu.selectedIndex).toBe(2); // cursor on "midnight"
    });

    it('gives every option a distinct keystroke', () => {
      const menu = parseInkSelect(themeMenuText);
      if (!menu) return;
      const buttons = menuToButtons(menu);

      expect(buttons.map((b) => b.input)).toEqual(['1', '2', '3', '4']);
      expect(new Set(buttons.map((b) => b.input)).size).toBe(4);
      buttons.forEach((b) => expectNoMixedWrite(b.input, b.submitInput));
    });
  });

  describe('2-option menu (login method)', () => {
    const loginMenuText = `Select Login Method

Choose how to authenticate:

1: paste auth token
  ❯ 2: open browser

Enter to confirm`;

    it('sends 1 and 2', () => {
      const menu = parseInkSelect(loginMenuText);
      if (!menu) return;
      const buttons = menuToButtons(menu);

      expect(buttons[0].input).toBe('1');
      expect(buttons[1].input).toBe('2');
      buttons.forEach((b) => expectNoMixedWrite(b.input, b.submitInput));
    });
  });

  describe('independence from cursor position', () => {
    it('sends the same keystroke for an option no matter where the cursor was', () => {
      // The property the old anchor trick was reaching for, now actually true:
      // the digit doesn't reference the cursor at all.
      const screen = (cursor: number) =>
        ['   1: first', '   2: second', '   3: third']
          .map((line, i) => (i === cursor ? line.replace('  ', ' ❯') : line))
          .join('\n');

      const inputsFor = (cursor: number) =>
        menuToButtons(parseInkSelect('Pick one:\n' + screen(cursor))!).map((b) => b.input);

      expect(inputsFor(0)).toEqual(['1', '2', '3']);
      expect(inputsFor(1)).toEqual(['1', '2', '3']);
      expect(inputsFor(2)).toEqual(['1', '2', '3']);
    });

    it('an unnumbered menu gets NO fixed keystroke — it is answered by verified navigation', () => {
      // CC 2.1.281's startup dialogs have no numbers and ignore typed digits.
      // A fixed "DOWN × n, then Enter" from the cursor seen when the card was
      // drawn was blind (a moved cursor → the wrong option, which here can mean
      // trusting a folder), so these buttons carry `pick` and type nothing
      // until state/ink-menu-driver.ts has checked the screen.
      const buttons = menuToButtons({
        id: 'test',
        title: 'test',
        options: ['first', 'second', 'third'],
        selectedIndex: 1,
      });
      buttons.forEach((b, i) => {
        expect(b.input).toBe('');
        expect(b.submitInput).toBeUndefined();
        expect(b.pick).toEqual({ signature: expect.any(String), index: i });
        expectNoMixedWrite(b.input, b.submitInput);
      });
    });
  });
});
