import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseInkSelect, menuToButtons } from '../src/renderer/parser/ink-select-parser';

/**
 * Diagnostic test: Capture and analyze the actual keystroke sequences
 * that would be sent to the PTY for various menu scenarios.
 *
 * This helps identify if the keystroke generation is the root cause
 * of menu selection failures.
 */
describe('Keystroke Sequence Diagnostics', () => {
  // Helper to visualize escape sequences
  function visualizeKeystrokes(input: string): string {
    return input
      .replace(/\u001b\[A/g, '[UP]')
      .replace(/\u001b\[B/g, '[DOWN]')
      .replace(/\r/g, '[ENTER]');
  }

  describe('Resume Session Menu (colon-numbered)', () => {
    const resumeSessionText = `Resume Session

Session is 45 minutes old. Resume from summary will compress context.

1: as is (full replay)
  ❯ 2: from summary (compressed)

Enter to confirm`;

    it('parses resume session correctly', () => {
      const menu = parseInkSelect(resumeSessionText);
      expect(menu).not.toBeNull();
      if (!menu) return;

      console.log('\n=== Resume Session Parse ===');
      console.log('Title:', menu.title);
      console.log('Options:', menu.options);
      console.log('Selected index:', menu.selectedIndex);
      console.log('Description:', menu.description);

      expect(menu.options).toEqual(['as is (full replay)', 'from summary (compressed)']);
      expect(menu.selectedIndex).toBe(1);
    });

    it('generates correct keystroke sequences for resume session', () => {
      const menu = parseInkSelect(resumeSessionText);
      if (!menu) return;

      const buttons = menuToButtons(menu);

      console.log('\n=== Resume Session Keystrokes ===');
      buttons.forEach((btn, idx) => {
        const viz = visualizeKeystrokes(btn.input);
        console.log(`Button ${idx} (${btn.label}): ${viz}`);
      });

      // With 2 options and anchor-then-navigate:
      // Should send UP × 4 (2 + 2) to anchor, then DOWN × index
      const UP = '\u001b[A';
      const DOWN = '\u001b[B';

      expect(buttons[0].input).toBe(UP.repeat(4) + DOWN.repeat(0) + '\r');
      expect(buttons[1].input).toBe(UP.repeat(4) + DOWN.repeat(1) + '\r');

      // Key assertion: both buttons have DIFFERENT keystroke sequences
      expect(buttons[0].input).not.toBe(buttons[1].input);
    });
  });

  describe('Theme Selection Menu', () => {
    const themeMenuText = `Choose a Theme

Currently dark. Switch themes to preview styling.

1: light
2: dark
  ❯ 3: midnight
4: crème

Enter to confirm`;

    it('parses theme menu correctly', () => {
      const menu = parseInkSelect(themeMenuText);
      expect(menu).not.toBeNull();
      if (!menu) return;

      console.log('\n=== Theme Menu Parse ===');
      console.log('Title:', menu.title);
      console.log('Options:', menu.options);
      console.log('Selected index:', menu.selectedIndex);

      expect(menu.options).toHaveLength(4);
      expect(menu.selectedIndex).toBe(2); // cursor is on "midnight"
    });

    it('generates keystrokes for all theme options', () => {
      const menu = parseInkSelect(themeMenuText);
      if (!menu) return;

      const buttons = menuToButtons(menu);
      const UP = '\u001b[A';
      const DOWN = '\u001b[B';

      console.log('\n=== Theme Menu Keystrokes ===');
      buttons.forEach((btn, idx) => {
        const viz = visualizeKeystrokes(btn.input);
        console.log(`Button ${idx} (${btn.label}): ${viz}`);
      });

      // 4 options → anchor with UP × 6
      expect(buttons[0].input).toBe(UP.repeat(6) + DOWN.repeat(0) + '\r'); // light
      expect(buttons[1].input).toBe(UP.repeat(6) + DOWN.repeat(1) + '\r'); // dark
      expect(buttons[2].input).toBe(UP.repeat(6) + DOWN.repeat(2) + '\r'); // midnight (currently selected)
      expect(buttons[3].input).toBe(UP.repeat(6) + DOWN.repeat(3) + '\r'); // crème

      // All buttons should have different sequences
      const sequences = buttons.map(b => b.input);
      const uniqueSequences = new Set(sequences);
      expect(uniqueSequences.size).toBe(4);
    });
  });

  describe('2-Option Menu (Theme/Login)', () => {
    const loginMenuText = `Select Login Method

Choose how to authenticate:

1: paste auth token
  ❯ 2: open browser

Enter to confirm`;

    it('generates correct keystrokes for 2-option menu', () => {
      const menu = parseInkSelect(loginMenuText);
      if (!menu) return;

      const buttons = menuToButtons(menu);
      const UP = '\u001b[A';
      const DOWN = '\u001b[B';

      console.log('\n=== 2-Option Login Menu Keystrokes ===');
      buttons.forEach((btn, idx) => {
        const viz = visualizeKeystrokes(btn.input);
        console.log(`Button ${idx} (${btn.label}): ${viz}`);
      });

      // 2 options → anchor with UP × 4
      expect(buttons[0].input).toBe(UP.repeat(4) + DOWN.repeat(0) + '\r');
      expect(buttons[1].input).toBe(UP.repeat(4) + DOWN.repeat(1) + '\r');

      // Verify they're different
      expect(buttons[0].input).not.toBe(buttons[1].input);
    });
  });

  describe('Critical: Keystroke Independence', () => {
    it('keystroke sequences should be independent of initial selectedIndex', () => {
      // This is the core guarantee of anchor-then-navigate:
      // Clicking option 0 should ALWAYS send the same keystrokes,
      // regardless of which option was selected when parsing.

      const options = ['first', 'second', 'third'];
      const UP = '\u001b[A';
      const DOWN = '\u001b[B';

      // Scenario 1: User at first option when menu renders
      const seq1 = menuToButtons({
        id: 'test',
        title: 'test',
        options,
        selectedIndex: 0,
      })[0].input;

      // Scenario 2: User at second option when menu renders
      const seq2 = menuToButtons({
        id: 'test',
        title: 'test',
        options,
        selectedIndex: 1,
      })[0].input;

      // Scenario 3: User at third option when menu renders
      const seq3 = menuToButtons({
        id: 'test',
        title: 'test',
        options,
        selectedIndex: 2,
      })[0].input;

      console.log('\n=== Keystroke Independence Test ===');
      console.log('Cursor at index 0:', visualizeKeystrokes(seq1));
      console.log('Cursor at index 1:', visualizeKeystrokes(seq2));
      console.log('Cursor at index 2:', visualizeKeystrokes(seq3));

      // All should be identical (this is the whole point!)
      expect(seq1).toBe(seq2);
      expect(seq2).toBe(seq3);

      const expected = UP.repeat(5) + DOWN.repeat(0) + '\r'; // 3 options → UP×5
      expect(seq1).toBe(expected);
    });
  });
});
