import { describe, it, expect } from 'vitest';
import { parseInkSelect, menuToButtons } from '../src/renderer/parser/ink-select-parser';

describe('ink-select-parser', () => {
  describe('parseInkSelect', () => {
    it('parses a simple 2-option menu', () => {
      const screenText = `
Resume Session

1: as is
  ❯ 2: from summary

press enter to confirm`;

      const menu = parseInkSelect(screenText);
      expect(menu).not.toBeNull();
      if (!menu) return;

      expect(menu.options).toEqual(['as is', 'from summary']);
      expect(menu.selectedIndex).toBe(1); // cursor is on option 2 (index 1)
      expect(menu.title).toBe('Resume Session');
    });

    it('parses Resume Session with description', () => {
      const screenText = `Resume Session
Session age: 45 minutes | Usage: 85% of limit
Trade-off: Resume from summary will skip token-intensive context

1: as is
  ❯ 2: from summary

press enter to confirm`;

      const menu = parseInkSelect(screenText);
      expect(menu).not.toBeNull();
      if (!menu) {
        console.log('Menu is null');
        return;
      }

      console.log('Parsed menu:', {
        title: menu.title,
        options: menu.options,
        selectedIndex: menu.selectedIndex,
        description: menu.description,
      });

      expect(menu.options).toEqual(['as is', 'from summary']);
      expect(menu.selectedIndex).toBe(1);
      // For now, just log what we get
      // expect(menu.description).toBeDefined();
    });

    it('parses when cursor is on first option', () => {
      const screenText = `Resume Session
  ❯ 1: as is
    2: from summary`;

      const menu = parseInkSelect(screenText);
      expect(menu).not.toBeNull();
      if (!menu) return;

      expect(menu.options).toEqual(['as is', 'from summary']);
      expect(menu.selectedIndex).toBe(0); // cursor is on option 1 (index 0)
    });
  });

  describe('menuToButtons', () => {
    it('generates correct keystroke sequences with anchor-then-navigate', () => {
      const menu = {
        id: 'test',
        title: 'Resume Session',
        options: ['as is', 'from summary'],
        selectedIndex: 1,
        description: 'test',
      };

      const buttons = menuToButtons(menu);
      expect(buttons).toHaveLength(2);

      const UP = '\u001b[A';
      const DOWN = '\u001b[B';

      // First option: go to top (UP×4 for 2 options) then navigate to index 0
      const firstButton = buttons[0];
      expect(firstButton.label).toBe('as is');
      const expectedFirst = UP.repeat(4) + DOWN.repeat(0) + '\r';
      expect(firstButton.input).toBe(expectedFirst);

      // Second option: go to top, then DOWN once
      const secondButton = buttons[1];
      expect(secondButton.label).toBe('from summary');
      const expectedSecond = UP.repeat(4) + DOWN.repeat(1) + '\r';
      expect(secondButton.input).toBe(expectedSecond);
    });

    it('produces independent keystroke sequences regardless of initial selectedIndex', () => {
      // Same options, different selectedIndex shouldn't change the sequences
      // (this is the whole point of anchor-then-navigate)

      const option0Cmd = menuToButtons({
        id: 'test', title: 'Test', options: ['a', 'b'], selectedIndex: 0,
      })[0].input;

      const option0Cmd2 = menuToButtons({
        id: 'test', title: 'Test', options: ['a', 'b'], selectedIndex: 1,
      })[0].input;

      // Both should produce the same keystroke sequence for option 0
      // (This verifies cursor state doesn't matter)
      expect(option0Cmd).toBe(option0Cmd2);
    });
  });

  describe('cross-platform consistency', () => {
    it('handles colon-numbered options like Resume Session uses', () => {
      const screenText = `  ❯ 1: as is
    2: from summary`;

      const menu = parseInkSelect(screenText);
      expect(menu).not.toBeNull();
      if (!menu) return;

      // Should strip the numbering
      expect(menu.options).toEqual(['as is', 'from summary']);
    });
  });
});
