// Regression tests for the terminal view's clipboard key handling (2026-07-16).
//
// Bug: the Ctrl/Cmd+V branch called terminal.paste() itself and returned false,
// but returning false from attachCustomKeyEventHandler only skips xterm's OWN
// key processing — it does not preventDefault the browser keydown. Chromium
// then still fired its native 'paste' event into xterm's hidden textarea, and
// xterm's paste listener wrote the clipboard to the PTY a second time: every
// Ctrl+V in terminal view pasted twice.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTerminalKeyHandler, type ClipboardTerminal } from '../src/renderer/components/terminal-key-handler';

function fakeTerminal(selection = ''): ClipboardTerminal & { paste: ReturnType<typeof vi.fn<(text: string) => void>> } {
  return {
    hasSelection: () => selection.length > 0,
    getSelection: () => selection,
    paste: vi.fn<(text: string) => void>(),
  };
}

function keyEvent(key: string, opts: Partial<KeyboardEvent> = {}) {
  return {
    type: 'keydown',
    key,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...opts,
  } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

const clipboard = {
  readText: vi.fn(),
  writeText: vi.fn(),
};

beforeEach(() => {
  clipboard.readText.mockReset().mockResolvedValue('clip-text');
  clipboard.writeText.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard });
});

describe('createTerminalKeyHandler', () => {
  it('Ctrl+V prevents the native paste and pastes exactly once via terminal.paste', async () => {
    const term = fakeTerminal();
    const handler = createTerminalKeyHandler(term);
    const e = keyEvent('v');

    expect(handler(e)).toBe(false);
    // preventDefault is what stops Chromium's native paste event from ALSO
    // delivering the clipboard into xterm's textarea (the double-paste bug).
    expect(e.preventDefault).toHaveBeenCalled();

    await Promise.resolve(); // let the clipboard read settle
    await Promise.resolve();
    expect(term.paste).toHaveBeenCalledTimes(1);
    expect(term.paste).toHaveBeenCalledWith('clip-text');
  });

  it('Ctrl+V with an empty clipboard pastes nothing', async () => {
    clipboard.readText.mockResolvedValue('');
    const term = fakeTerminal();
    const handler = createTerminalKeyHandler(term);

    expect(handler(keyEvent('v'))).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(term.paste).not.toHaveBeenCalled();
  });

  it('Ctrl+C with a selection copies and blocks xterm handling', () => {
    const term = fakeTerminal('selected text');
    const handler = createTerminalKeyHandler(term);

    expect(handler(keyEvent('c'))).toBe(false);
    expect(clipboard.writeText).toHaveBeenCalledWith('selected text');
  });

  it('Ctrl+C without a selection falls through (SIGINT still works)', () => {
    const term = fakeTerminal('');
    const handler = createTerminalKeyHandler(term);
    expect(handler(keyEvent('c'))).toBe(true);
  });

  it('ignores non-keydown events and modified/unmodified keys', () => {
    const term = fakeTerminal();
    const handler = createTerminalKeyHandler(term);
    expect(handler(keyEvent('v', { type: 'keyup' } as any))).toBe(true);
    expect(handler(keyEvent('v', { shiftKey: true }))).toBe(true);
    expect(handler(keyEvent('v', { ctrlKey: false }))).toBe(true);
    expect(term.paste).not.toHaveBeenCalled();
  });
});
