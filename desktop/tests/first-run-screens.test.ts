// Claude Code's FIRST-RUN screens (theme picker, security notes), read the way the app reads them.
// WHY: on a fresh install Claude Code 2.1.300 waits on these before it starts; the app drew no card for them, so the chat sat on
// "Initializing session…" (Android UX test, 2026-11-01). Screen text below is the layout captured in tests/fixtures/popup-corpus/slash-theme.json
// (CC 2.1.286, same picker) plus the first-run wording seen on the phone (CC 2.1.300). After a Claude Code update, re-check these.
import { describe, it, expect } from 'vitest';
import { parseInkSelect, menuToButtons } from '../src/shared/ink-select-parser';
import { cardTitleFor } from '../src/shared/prompt-card-rules';

const RULE = '╌'.repeat(60);
const themeScreen = (cursorRow: number, check = 1, extra: string[] = []) => {
  const labels = ['Auto (match terminal)', 'Dark mode', 'Light mode', 'Dark mode (colorblind-friendly)', 'Light mode (colorblind-friendly)',
    'Dark mode (ANSI colors only)', 'Light mode (ANSI colors only)', ...extra];
  const rows = labels.map((l, i) => `${i === cursorRow ? '  ❯ ' : '    '}${i === check ? '✔ ' : '  '}${l}`);
  return [
    " Let's get started.", '',
    '  Choose the text style that looks best with your terminal',
    '  To change this later, run /theme', '',
    ...rows, '', `  ${RULE}`, '   1  function greet() {', '   2 -  console.log("Hello, World!");', '   2 +  console.log("Hello, Claude!");', '   3  }',
    `  ${RULE}`, '   Syntax theme: Monokai Extended (ctrl+t to disable)',
  ].join('\n');
};
const SECURITY = [
  ' Security notes:', '',
  ' 1. Claude can make mistakes', '    You should always review Claude\'s responses, especially when', '    running code.', '',
  ' 2. Due to prompt injection risks, only use it with code you trust', '    For more details see:', '    https://code.claude.com/docs/en/security', '',
  ' Press Enter to continue…',
].join('\n');

describe('first-run theme picker', () => {
  it('reads as a pick-by-arrow card with Claude Code\'s own labels and cursor', () => {
    const m = parseInkSelect(themeScreen(1))!;
    expect(m.title).toBe('Choose a Theme');
    expect(m.options).toHaveLength(7);
    expect(m.options[1]).toBe('Dark mode');
    expect(m.selectedIndex).toBe(1);
    expect(cardTitleFor(m, true, themeScreen(1))).toEqual({ title: 'Choose a Theme', generic: false });
    // no printed numbers → verified navigation, never a typed digit
    expect(menuToButtons(m).every((b) => b.pick)).toBe(true);
  });
  it('follows the cursor when it is on a row without the tick', () => {
    const m = parseInkSelect(themeScreen(2))!;
    expect(m.selectedIndex).toBe(2);
    expect(m.options[2]).toBe('Light mode');
  });
  it('drops "New custom theme…" but refuses when the cursor sits on it', () => {
    expect(parseInkSelect(themeScreen(1, 1, ['New custom theme…']))!.options).toHaveLength(7);
    expect(parseInkSelect(themeScreen(7, 1, ['New custom theme…']))).toBeNull();
  });
  it('refuses a quoted menu with the message box under it and a list cut short', () => {
    expect(parseInkSelect(themeScreen(1) + `\n${'─'.repeat(60)}\n❯ hello\n${'─'.repeat(60)}`)).toBeNull();
    expect(parseInkSelect(themeScreen(1).replace('Light mode', 'Light mode that wraps\n        onto a second row'))).toBeNull();
  });
  it('survives ANSI colour codes', () => {
    const colored = themeScreen(1).split('\n').map((l) => `\u001b[1m${l}\u001b[0m`).join('\n');
    expect(parseInkSelect(colored)?.title).toBe('Choose a Theme');
  });
});

describe('first-run security notes', () => {
  it('reads as one Continue button with Claude Code\'s wording', () => {
    const m = parseInkSelect(SECURITY)!;
    expect(m.title).toBe('Security notes');
    expect(m.options).toEqual(['Continue']);
    expect(m.description).toContain('1. Claude can make mistakes');
    expect(m.description).toContain('only use it with code you trust');
    expect(cardTitleFor(m, true, SECURITY)).toEqual({ title: 'Security notes', generic: false });
    expect(menuToButtons(m)[0].pick).toEqual({ signature: m.signature, index: 0 });
  });
  it('copes with a narrow, wrapped prompt line', () => {
    expect(parseInkSelect(SECURITY.replace('Press Enter to continue…', 'Press Enter to\n continue…'))?.title).toBe('Security notes');
  });
  it('is not read when the prompt line is absent or the screen moved on', () => {
    expect(parseInkSelect(SECURITY.replace('Press Enter to continue…', ''))).toBeNull();
    expect(parseInkSelect(SECURITY + '\n\n Do you trust this folder?')).toBeNull();
  });
});

describe('first-run security notes, newer layout (no blank rows between notes)', () => {
  const NEW = [
    ' Security notes:', '',
    ' 1. Claude can make mistakes', "    You're responsible for Claude's actions and should always review", '    them, especially when running code.',
    ' 2. Due to prompt injection risks, only use it with code you trust', '    Learn more: https://code.claude.com/docs/en/security', '',
    ' Press Enter to continue…',
  ].join('\n');
  it('puts each note on its own line, its sub-line under it, and the link last', () => {
    expect(parseInkSelect(NEW)!.description).toBe([
      '1. Claude can make mistakes', "You're responsible for Claude's actions and should always review them, especially when running code.",
      '2. Due to prompt injection risks, only use it with code you trust',
      'Learn more: https://code.claude.com/docs/en/security',
    ].join('\n'));
  });
  it('keeps the old layout readable too (blank rows, "For more details see:")', () => {
    expect(parseInkSelect(SECURITY)!.description).toBe([
      "1. Claude can make mistakes\nYou should always review Claude's responses, especially when running code.",
      '2. Due to prompt injection risks, only use it with code you trust',
      'Learn more: https://code.claude.com/docs/en/security',
    ].join('\n'));
  });
});

describe('real Claude Code capture', () => {
  it('reads the theme picker exactly as Claude Code drew it (slash-theme capture, CC 2.1.286)', async () => {
    const { FixtureTerminal, loadPlanFixture } = await import('./helpers/plan-menu-fixtures');
    const { getVisibleScreenText } = await import('../src/renderer/hooks/terminal-registry');
    const path = await import('path');
    const fx = loadPlanFixture('slash-theme.json', path.join(__dirname, 'fixtures', 'popup-corpus'));
    const t = new FixtureTerminal(fx as never);
    await t.advanceTo(fx.marks[0] && 13);
    const m = parseInkSelect(getVisibleScreenText(t.id) as string)!;
    expect(m.title).toBe('Choose a Theme');
    expect(m.options.slice(0, 3)).toEqual(['Auto (match terminal)', 'Dark mode', 'Light mode']);
    expect(m.options.some((o) => /custom/i.test(o))).toBe(false);
    expect(m.selectedIndex).toBe(1);
  });
});
