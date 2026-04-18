import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseInkSelect, menuToButtons } from '../src/renderer/parser/ink-select-parser';

/**
 * Integration test: Simulate the full flow from menu detection to PTY input.
 * This captures what the chat view would actually send.
 */
describe('Prompt Selection Integration', () => {
  let sendInputMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendInputMock = vi.fn();
  });

  it('simulates clicking "from summary" on Resume Session', () => {
    // Simulate screen text that Claude Code would output
    const screenText = `Resume Session

Session is 45 minutes old. Resume from summary will compress context.

1: as is (full replay)
  ❯ 2: from summary (compressed)

Enter to confirm`;

    // Step 1: Parse the menu (what usePromptDetector does)
    const menu = parseInkSelect(screenText);
    expect(menu).not.toBeNull();
    if (!menu) return;

    // Step 2: Generate buttons (what usePromptDetector does)
    const buttons = menuToButtons(menu);
    expect(buttons).toHaveLength(2);

    // Step 3: User clicks "from summary" button (index 1)
    const clickedButton = buttons[1];
    expect(clickedButton.label).toBe('from summary (compressed)');

    // Step 4: ChatView sends the input to PTY
    // (simulating what handlePromptSelect does)
    sendInputMock(clickedButton.input);

    // Verification
    expect(sendInputMock).toHaveBeenCalledOnce();
    const sentInput = sendInputMock.mock.calls[0][0];

    console.log('\n=== Integration: Click "from summary" ===');
    console.log('Menu options:', menu.options);
    console.log('Selected index at parse:', menu.selectedIndex);
    console.log('Button clicked: index 1 -', clickedButton.label);
    console.log('Input sent to PTY:', sentInput);

    const UP = '\u001b[A';
    const DOWN = '\u001b[B';
    const expected = UP.repeat(4) + DOWN.repeat(1) + '\r';

    expect(sentInput).toBe(expected);
    console.log('Expected:', expected);
    console.log('Actual:  ', sentInput);
    console.log('Match:', sentInput === expected);
  });

  it('simulates clicking "as is" on Resume Session', () => {
    const screenText = `Resume Session

Session is 45 minutes old. Resume from summary will compress context.

1: as is (full replay)
  ❯ 2: from summary (compressed)

Enter to confirm`;

    const menu = parseInkSelect(screenText);
    if (!menu) return;

    const buttons = menuToButtons(menu);
    const clickedButton = buttons[0]; // Click "as is"

    sendInputMock(clickedButton.input);

    console.log('\n=== Integration: Click "as is" ===');
    console.log('Button clicked: index 0 -', clickedButton.label);
    console.log('Input sent to PTY:', sendInputMock.mock.calls[0][0]);

    const UP = '\u001b[A';
    const expected = UP.repeat(4) + '\r'; // 4 UPs, no DOWNs, ENTER

    expect(sendInputMock.mock.calls[0][0]).toBe(expected);
  });

  it('handles menu re-render scenario (cursor moved by user)', () => {
    // Scenario: Menu renders with cursor on option 2, user arrows to option 1,
    // then menu re-renders (same menu.id, so prompt not re-emitted),
    // then user clicks "as is"

    const screenText1 = `Resume Session

Session is 45 minutes old. Resume from summary will compress context.

1: as is (full replay)
  ❯ 2: from summary (compressed)

Enter to confirm`;

    const menu1 = parseInkSelect(screenText1);
    if (!menu1) return;

    // Menu detected, buttons generated
    const buttons1 = menuToButtons(menu1);

    // Now simulate: user presses UP arrow, menu re-renders
    // (Ink shows the same menu but with cursor on option 1)
    const screenText2 = `Resume Session

Session is 45 minutes old. Resume from summary will compress context.

  ❯ 1: as is (full replay)
    2: from summary (compressed)

Enter to confirm`;

    const menu2 = parseInkSelect(screenText2);
    if (!menu2) return;

    // Because menu.id is the same, usePromptDetector won't emit SHOW_PROMPT again
    // So the OLD buttons1 are still in the UI!
    // User clicks "as is" using buttons1[0]

    sendInputMock(buttons1[0].input);

    console.log('\n=== Integration: Menu Re-render (cursor moved) ===');
    console.log('Original menu selectedIndex:', menu1.selectedIndex);
    console.log('Menu re-renders with selectedIndex:', menu2.selectedIndex);
    console.log('UI still has OLD button clicks from buttons1');
    console.log('User clicks "as is" button from buttons1');
    console.log('Input sent:', sendInputMock.mock.calls[0][0]);

    const UP = '\u001b[A';
    const expected1 = UP.repeat(4) + '\r'; // Buttons from menu1 parsing
    expect(sendInputMock.mock.calls[0][0]).toBe(expected1);

    // KEY INSIGHT: Regardless of menu re-renders, the keystroke should still work
    // because anchor-then-navigate is independent of cursor state!
    console.log(
      'This should STILL select "as is" because anchor-then-navigate is cursor-independent'
    );
  });

  it('identifies the critical failure mode', () => {
    // What if the issue is that buttons are being clicked in the WRONG ORDER?
    // Or that the menu options are being parsed INCORRECTLY and the indices are off?

    const screenText = `Resume Session

1: as is
  ❯ 2: from summary`;

    const menu = parseInkSelect(screenText);
    if (!menu) return;

    console.log('\n=== Critical Test: Menu Parsing Correctness ===');
    console.log('Parsed options:', menu.options);
    console.log('Parsed selectedIndex:', menu.selectedIndex);

    // CRITICAL: If options are [a, b] and selectedIndex is 1,
    // then button[0] should click option "a" and button[1] should click option "b"
    const buttons = menuToButtons(menu);
    console.log('Button 0 label:', buttons[0].label);
    console.log('Button 1 label:', buttons[1].label);

    // Verify buttons array matches parsed options
    expect(buttons.length).toBe(menu.options.length);
    for (let i = 0; i < buttons.length; i++) {
      // The label might have numbering stripped, but should correspond
      expect(buttons[i].label.toLowerCase()).toContain(
        menu.options[i].toLowerCase().split(/[\s\(]/)[0]
      );
    }
  });
});
