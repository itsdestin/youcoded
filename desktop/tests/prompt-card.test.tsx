// @vitest-environment jsdom
/**
 * Pins the Resume Session / setup-prompt card (PromptCard.tsx) after the
 * 2026-07-26 keystroke fix.
 *
 * The bug being guarded against: every button used to send
 * `UP×(n+2) + DOWN×index + \r` in ONE pty write, and CC discards arrows that
 * share a write with the Enter — so all three options confirmed option 1
 * ("Resume from summary"), which runs /compact. Destin's report was "all options
 * just compact the session regardless of my intention".
 *
 * What must keep holding:
 *  1. A click sends the clicked option's OWN keystroke (its printed digit), and
 *     each button sends a distinct one.
 *  2. The number-key shortcuts answer the same option the digit does — they are
 *     the same mapping, not a parallel one that can drift.
 *  3. "Don't ask me again" needs two clicks. It writes `resumeReturnDismissed`
 *     into ~/.claude.json, so the prompt never appears again on ANY session; a
 *     mis-click there is unrecoverable from inside the app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import PromptCard from '../src/renderer/components/PromptCard';
import { parseInkSelect, menuToButtons } from '../src/renderer/parser/ink-select-parser';
import type { InteractivePrompt } from '../src/renderer/state/chat-types';

const RESUME_SCREEN = [
  '────────────────────────────────────────────────────────────',
  '  This session is 17d 19h old and 415.6k tokens.',
  '',
  '  Resuming the full session will consume a substantial portion of your usage limits. We',
  '  recommend resuming from a summary.',
  '',
  '  ❯ 1. Resume from summary (recommended)',
  '    2. Resume full session as-is',
  "    3. Don't ask me again",
  '',
  '  Enter to confirm · Esc to cancel',
].join('\n');

/** Build the prompt exactly the way usePromptDetector does, so the test covers
 *  the real parser → buttons → card chain rather than a hand-written fixture. */
function resumePrompt(): InteractivePrompt {
  const menu = parseInkSelect(RESUME_SCREEN);
  if (!menu) throw new Error('fixture no longer parses as a menu');
  return {
    promptId: menu.id,
    title: menu.title,
    description: menu.description,
    buttons: menuToButtons(menu).map((b) => ({
      label: b.label,
      input: b.input,
      submitInput: b.submitInput,
    })),
  };
}

afterEach(cleanup);

describe('PromptCard — Resume Session', () => {
  let onSelect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSelect = vi.fn();
  });

  it('sends each option its own keystroke', () => {
    const prompt = resumePrompt();
    render(<PromptCard prompt={prompt} sessionId="s1" onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: /Resume full session as-is/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].input).toBe('2');
    expect(onSelect.mock.calls[0][1]).toBe('Resume full session as-is');

    fireEvent.click(screen.getByRole('button', { name: /Resume from summary/ }));
    expect(onSelect.mock.calls[1][0].input).toBe('1');
  });

  it('never hands out a keystroke containing both an arrow and a carriage return', () => {
    const prompt = resumePrompt();
    for (const button of prompt.buttons) {
      const hasArrow = /\[[AB]/.test(button.input);
      expect(hasArrow && button.input.includes('\r')).toBe(false);
    }
  });

  it('answers via the number key shown on the button', () => {
    const prompt = resumePrompt();
    render(<PromptCard prompt={prompt} sessionId="s1" onSelect={onSelect} />);

    fireEvent.keyDown(window, { key: '2' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].input).toBe('2');
    expect(onSelect.mock.calls[0][1]).toBe('Resume full session as-is');
  });

  it('requires a second click before setting the sticky "don\'t ask again" preference', () => {
    const prompt = resumePrompt();
    render(<PromptCard prompt={prompt} sessionId="s1" onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: /Don't ask me again/ }));
    expect(onSelect).not.toHaveBeenCalled();

    const confirm = screen.getByRole('button', { name: /Click again to confirm/ });
    fireEvent.click(confirm);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].input).toBe('3');
  });

  it('shows only the prompt\'s own body text', () => {
    const prompt = resumePrompt();
    render(<PromptCard prompt={prompt} sessionId="s1" onSelect={onSelect} />);
    expect(screen.getByText(/This session is 17d 19h old/)).toBeTruthy();
    expect(screen.queryByText(/Enter to confirm/)).toBeNull();
  });

  it('keyboard shortcuts can be disabled for multi-card feeds', () => {
    const prompt = resumePrompt();
    render(
      <PromptCard prompt={prompt} sessionId="s1" onSelect={onSelect} keyboardShortcuts={false} />,
    );
    fireEvent.keyDown(window, { key: '2' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not run shortcuts for the folder-trust dialog (TrustGate owns it)', () => {
    // The trust prompt renders behind TrustGate's full-screen takeover, so a
    // stray "1" must not trust a folder the user never saw the question for.
    const menu = parseInkSelect(' ❯ 1. Yes, I trust this folder\n   2. No, exit');
    if (!menu) throw new Error('trust fixture no longer parses');
    const prompt: InteractivePrompt = {
      promptId: menu.id,
      title: menu.title,
      buttons: menuToButtons(menu),
    };
    expect(prompt.title).toBe('Trust This Folder?');

    render(<PromptCard prompt={prompt} sessionId="s1" onSelect={onSelect} />);
    fireEvent.keyDown(window, { key: '1' });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

// Claude Code 2.1.281's startup dialogs carry no option numbers; their buttons
// are answered by verified navigation (state/ink-menu-driver.ts), which reports
// back — so the card waits, and says so if Claude Code did not take it.
const MCP_SCREEN = [
  '─'.repeat(100),
  '  New MCP server found in this project: demo',
  '',
  '  MCP servers may execute code or access system resources. All tool calls require approval. Learn',
  '  more in the MCP documentation.',
  '',
  '    Use this MCP server',
  '    Use this and all future MCP servers in this project',
  '  ❯ Continue without using this MCP server',
  '',
  '  Enter to confirm · Esc to cancel',
].join('\n');

function mcpPrompt(): InteractivePrompt {
  const menu = parseInkSelect(MCP_SCREEN);
  if (!menu) throw new Error('MCP screen no longer parses');
  return {
    promptId: menu.id, title: menu.title, description: menu.description,
    buttons: menuToButtons(menu), defaultIndex: menu.selectedIndex,
  };
}

describe('PromptCard — a dialog answered by verified navigation', () => {
  it('starts on the option Claude Code highlights, so Enter means what it means in the terminal', () => {
    const onSelect = vi.fn();
    const prompt = mcpPrompt();
    expect(prompt.title).toBe('New MCP Server Found');
    render(<PromptCard prompt={prompt} sessionId="s1" onSelect={onSelect} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onSelect.mock.calls[0][1]).toBe('Continue without using this MCP server');
  });

  it('asks twice before "Use this and all future MCP servers"', () => {
    const onSelect = vi.fn();
    render(<PromptCard prompt={mcpPrompt()} sessionId="s1" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /all future MCP servers/ }));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Click again to confirm/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('disables every button while the answer is being typed, and says why when it is refused', async () => {
    let settle!: (r: { ok: false; reason: 'menu-changed'; typed: false }) => void;
    const onSelect = vi.fn(() => new Promise<any>((res) => { settle = res; }));
    render(<PromptCard prompt={mcpPrompt()} sessionId="s1" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Continue without/ }));
    for (const b of screen.getAllByRole('button')) expect((b as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^Use this MCP server$/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    settle({ ok: false, reason: 'menu-changed', typed: false });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringMatching(/options changed/));
    for (const b of screen.getAllByRole('button')) expect((b as HTMLButtonElement).disabled).toBe(false);
  });
});
