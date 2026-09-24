// @vitest-environment jsdom
// (sendPromptInput talks to window.claude — .ts tests default to the node env)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseInkSelect, menuToButtons } from '../src/renderer/parser/ink-select-parser';
import { sendPromptInput, PROMPT_SUBMIT_DELAY_MS } from '../src/renderer/state/prompt-input';

/**
 * The whole chain: PTY screen text → parsed menu → buttons → bytes on the PTY.
 *
 * This is where the 2026-07-26 bug lived end to end. The old buttons carried
 * `UP×(n+2) + DOWN×index + \r` as ONE write, and CC discards arrows that share a
 * write with the Enter — so whichever button the user clicked, the bytes that
 * landed were "confirm the highlighted option". On Resume Session that is option
 * 1, which runs /compact: every option compacted the session.
 */
describe('prompt selection → PTY', () => {
  const RESUME_SCREEN = `Resume Session

Session is 45 minutes old. Resume from summary will compress context.

1: as is (full replay)
  ❯ 2: from summary (compressed)

Enter to confirm`;

  let sendInput: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendInput = vi.fn();
    (window as any).claude = { session: { sendInput } };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the clicked option\'s number, in a single write with no Enter', () => {
    const menu = parseInkSelect(RESUME_SCREEN);
    expect(menu).not.toBeNull();
    if (!menu) return;

    const buttons = menuToButtons(menu);
    expect(buttons).toHaveLength(2);

    // User clicks "from summary" (index 1)
    expect(buttons[1].label).toBe('from summary (compressed)');
    sendPromptInput('s1', buttons[1]);

    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput).toHaveBeenCalledWith('s1', '2');
  });

  it('sends a DIFFERENT byte for the other option', () => {
    const menu = parseInkSelect(RESUME_SCREEN);
    if (!menu) return;
    const buttons = menuToButtons(menu);

    sendPromptInput('s1', buttons[0]);
    expect(sendInput).toHaveBeenCalledWith('s1', '1');
  });

  it('still picks the right option after the menu re-renders with the cursor moved', () => {
    // usePromptDetector does not re-emit SHOW_PROMPT when the menu id is
    // unchanged, so the card can be holding buttons built from an EARLIER parse
    // whose cursor position is now stale. The digit doesn't reference the cursor,
    // so staleness stops mattering — this is what the old anchor trick was for,
    // and it never actually worked.
    const before = parseInkSelect(RESUME_SCREEN);
    const after = parseInkSelect(`Resume Session

Session is 45 minutes old. Resume from summary will compress context.

  ❯ 1: as is (full replay)
    2: from summary (compressed)

Enter to confirm`);
    if (!before || !after) return;

    expect(before.selectedIndex).toBe(1);
    expect(after.selectedIndex).toBe(0);
    // Same menu id → the UI keeps the old buttons.
    expect(before.id).toBe(after.id);
    expect(menuToButtons(before).map((b) => b.input)).toEqual(
      menuToButtons(after).map((b) => b.input),
    );
  });

  it('button labels stay aligned with the parsed options', () => {
    const menu = parseInkSelect(RESUME_SCREEN);
    if (!menu) return;
    const buttons = menuToButtons(menu);

    expect(buttons.map((b) => b.label)).toEqual(menu.options);
  });

  it('a button carrying a second write (Android / older builds) still sends it separately', () => {
    vi.useFakeTimers();
    sendPromptInput('s1', { label: 'b', input: '\u001b[B', submitInput: '\r' });
    // Navigation first, alone.
    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput.mock.calls[0][1]).not.toContain('\r');
    vi.advanceTimersByTime(PROMPT_SUBMIT_DELAY_MS);
    // Then the Enter, as its own write.
    expect(sendInput).toHaveBeenCalledTimes(2);
    expect(sendInput.mock.calls[1][1]).toBe('\r');
  });

  it('an unnumbered menu\'s button types nothing when the menu is not on screen', async () => {
    const [, second] = menuToButtons({ id: 'x', title: 'x', options: ['a', 'b'], selectedIndex: 0 });
    const r = await sendPromptInput('s1', second);
    expect(r).toEqual({ ok: false, reason: 'menu-gone', typed: false });
    expect(sendInput).not.toHaveBeenCalled();
  });
});
