// @vitest-environment jsdom
// The plan-approval card as the user meets it: a ToolCard for an ExitPlanMode
// ask, reading a REAL Claude Code 2.1.281 screen from a headless terminal
// registered under the session's id (the same registry TerminalView fills).
// What it must do: show exactly the rows Claude Code shows, type only the
// clicked row's own number, release the hook socket WITHOUT a decision once the
// menu has gone, and show no buttons at all when the menu can't be read.
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import ToolCard from '../src/renderer/components/ToolCard';
import { CompactToolStrip } from '../src/renderer/components/buddy/CompactToolStrip';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { ToolCallState } from '../src/shared/types';
import { FixtureTerminal, loadPlanFixture, markIndex } from './helpers/plan-menu-fixtures';
import { registerTerminal, unregisterTerminal } from '../src/renderer/hooks/terminal-registry';
import { Terminal } from '@xterm/headless';

const terms: Array<{ dispose(): void }> = [];
let sendInput: ReturnType<typeof vi.fn>;
let respondToPermission: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sendInput = vi.fn();
  respondToPermission = vi.fn().mockResolvedValue(true);
  (window as any).claude = { session: { sendInput, respondToPermission } };
});
afterEach(() => {
  cleanup();
  while (terms.length) terms.pop()!.dispose();
  delete (window as any).claude;
});

function planTool(overrides: Partial<ToolCallState> = {}): ToolCallState {
  return {
    toolUseId: 'toolu_plan',
    toolName: 'ExitPlanMode',
    input: { plan: '# Plan\nCreate hello.txt' },
    status: 'awaiting-approval',
    requestId: 'req-1',
    ...overrides,
  } as ToolCallState;
}

/** A session whose terminal replays `file`; keys the card types move the replay on. */
async function sessionFrom(file: string, onKey: Record<string, string> = {}) {
  const fx = loadPlanFixture(file);
  const term = new FixtureTerminal(fx);
  terms.push(term);
  await term.advanceToMark('menu-settled');
  let typed = '';
  sendInput.mockImplementation((_sid: string, data: string) => {
    typed += data;
    for (const [keys, mark] of Object.entries(onKey)) {
      if (typed === keys) {
        typed = '';
        void term.advanceTo(mark === 'END' ? fx.chunks.length : markIndex(fx, mark));
      }
    }
  });
  return term;
}

function mount(sessionId: string, tool = planTool()) {
  return render(<ChatProvider><ToolCard tool={tool} sessionId={sessionId} /></ChatProvider>);
}

describe('PlanApprovalCard', () => {
  it("shows exactly Claude Code's rows, in its own words", async () => {
    const term = await sessionFrom('cc-2.1.281-clear-context-120x40.json');
    mount(term.id);
    await screen.findByRole('button', { name: 'Yes, clear context (5% used) and auto-accept edits' });
    expect(screen.getByRole('button', { name: 'Yes, auto-accept edits' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Yes, manually approve edits' })).toBeTruthy();
    expect(screen.getByPlaceholderText('Tell Claude what to change')).toBeTruthy();
    expect(screen.getByRole('button', { name: "Don't proceed" })).toBeTruthy();
    // None of the old fixed labels survive.
    expect(screen.queryByText('No, refine plan')).toBeNull();
    expect(screen.queryByText('Yes, and bypass permissions')).toBeNull();
  });

  it('a click types only that row\'s number, then releases the socket with NO decision', async () => {
    const term = await sessionFrom('cc-2.1.281-answer-digit2-120x40.json', { '2': 'after-answer-6s' });
    mount(term.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, manually approve edits' }));
    await waitFor(() => expect(respondToPermission).toHaveBeenCalled());
    expect(sendInput.mock.calls).toEqual([[term.id, '2']]);
    // Never a deny: a deny that beat the keystroke would reject what was approved.
    expect(respondToPermission.mock.calls).toEqual([['req-1', {}]]);
  });

  it('feedback: focuses the row, types the text, checks it, presses Enter, then releases', async () => {
    const text = 'Use the word hello 2 times instead';
    const term = await sessionFrom('cc-2.1.281-answer-feedback-120x40.json', {
      '3': 'after-digit', [text]: 'after-typing', '\r': 'after-answer-6s',
    });
    mount(term.id);
    const box = await screen.findByPlaceholderText('Tell Claude what to change');
    fireEvent.change(box, { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(respondToPermission).toHaveBeenCalledWith('req-1', {}));
    const keys = sendInput.mock.calls.map((c) => c[1]);
    expect(keys[0]).toBe('3');
    expect(keys.slice(1, -1).join('')).toBe(text);
    expect(keys[keys.length - 1]).toBe('\r');
  });

  it('shows no buttons, and says to use terminal view, when the options cannot be read', async () => {
    // The plan question is on screen but the rows are not (a half-drawn frame
    // that never completes).
    const t = new Terminal({ cols: 100, rows: 20, allowProposedApi: true });
    registerTerminal('half', t as never);
    terms.push({ dispose: () => { unregisterTerminal('half'); t.dispose(); } });
    await new Promise<void>((r) => t.write(
      '   Claude has written up a plan and is ready to execute. Would you like to proceed?\r\n     1. Yes, auto-accept edits\r\n', r,
    ));
    mount('half');
    await screen.findByText(/can't read Claude Code's plan options right now/, undefined, { timeout: 5000 });
    expect(screen.queryByRole('button', { name: 'Yes, auto-accept edits' })).toBeNull();
    expect(screen.queryByRole('button', { name: "Don't proceed" })).toBeNull();
    expect(sendInput).not.toHaveBeenCalled();
  });

});

describe('the buddy floater and a plan approval', () => {
  it('offers no Allow/Deny (a hook allow does not approve a plan) and points at the main window', () => {
    render(
      <ChatProvider>
        <CompactToolStrip tools={[planTool()]} sessionId="s1" />
      </ChatProvider>,
    );
    expect(screen.getByText('Review the plan in the main window')).toBeTruthy();
    expect(screen.queryByText(/Allow/)).toBeNull();
    expect(screen.queryByText(/Deny/)).toBeNull();
  });
});
