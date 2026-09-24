// @vitest-environment jsdom
// The plan-approval card as the user meets it: a ToolCard for an ExitPlanMode
// ask, reading a REAL Claude Code 2.1.281 screen from a headless terminal
// registered under the session's id (the same registry TerminalView fills).
// What it must do: show exactly the rows Claude Code shows, type only the
// clicked row's own number, release the hook socket WITHOUT a decision once the
// menu has gone, and show no buttons at all when the menu can't be read.
import React from 'react';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import ToolCard from '../src/renderer/components/ToolCard';
import { CompactToolStrip } from '../src/renderer/components/buddy/CompactToolStrip';
import { ExpiredApprovalActions } from '../src/renderer/components/ExpiredApprovalActions';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { ToolCallState } from '../src/shared/types';
import { FixtureTerminal, loadPlanFixture, markIndex, PLAN_FIXTURE_DIR } from './helpers/plan-menu-fixtures';
import { registerTerminal, unregisterTerminal } from '../src/renderer/hooks/terminal-registry';
import { Terminal } from '@xterm/headless';
import { act } from '@testing-library/react';
import { makeStoreWrapper } from './helpers/chat-store-harness';
import { useSessionToolCalls, type ChatStore } from '../src/renderer/state/chat-context';

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

  it('keeps the buttons working when the card is shown for an ask whose hook already closed', async () => {
    // (No requestId: the socket is gone, but the terminal menu is still live.)
    const term = await sessionFrom('cc-2.1.281-answer-digit2-120x40.json', { '2': 'after-answer-6s' });
    mount(term.id, planTool({ requestId: undefined, expired: true } as Partial<ToolCallState>));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, manually approve edits' }));
    await waitFor(() => expect(sendInput).toHaveBeenCalledWith(term.id, '2'));
    // (This harness passes the tool as a prop, so the settle's store update does
    // not unmount the card; once the menu has been gone past the read grace the
    // card says it cannot read one — by then the answer path has finished.)
    await screen.findByText(/can't read Claude Code's plan options/, undefined, { timeout: 8000 });
    // No socket exists to release — a kept card never calls the hook.
    expect(respondToPermission).not.toHaveBeenCalled();
    expect(sendInput.mock.calls).toEqual([[term.id, '2']]);
  });
});

// F5 (review 2026-09-23): Esc and clear-context make Claude Code kill the hook
// the moment the key lands (fixture hookLog: SIGTERM ~0s after Esc), so the card
// turns into a KEPT card while the driver is still waiting for the menu to
// leave. The driver's success must settle the card anyway — not leave it on
// "Sending to Claude Code…" waiting for some other path.
describe('a plan card whose hook is killed while its answer is going in', () => {
  function LiveCard({ sessionId }: { sessionId: string }) {
    const tools = useSessionToolCalls(sessionId);
    const tool = [...tools.values()].find((t) => t.toolName === 'ExitPlanMode');
    return tool ? <div data-status={tool.status}><ToolCard tool={tool} sessionId={sessionId} /></div> : null;
  }

  for (const [label, file, key] of [
    ["Don't proceed", 'cc-2.1.281-answer-esc-120x40.json', '\u001b'],
    ['Yes, clear context (5% used) and auto-accept edits', 'cc-2.1.281-answer-clear1-120x40.json', '1'],
  ] as const) {
    it(`settles after "${label}" even though the card became a kept card mid-answer`, async () => {
      const fx = loadPlanFixture(file);
      const term = new FixtureTerminal(fx);
      terms.push(term);
      await term.advanceToMark('menu-settled');
      const { wrapper: Wrapper, store } = makeStoreWrapper([term.id]);
      const st = store as ChatStore;
      sendInput.mockImplementation((_sid: string, data: string) => {
        if (data !== key) return;
        // Claude Code kills the hook as the key lands → PERMISSION_EXPIRED
        // 'hook-closed' reaches the renderer BEFORE the menu has left the screen.
        act(() => st.dispatch({ type: 'PERMISSION_EXPIRED', sessionId: term.id, requestId: 'req-1', reason: 'hook-closed' }));
        void term.advanceTo(markIndex(fx, 'after-answer-6s'));
      });
      const { container } = render(<Wrapper><LiveCard sessionId={term.id} /></Wrapper>);
      act(() => st.dispatch({ type: 'PERMISSION_REQUEST', sessionId: term.id, toolName: 'ExitPlanMode', input: { plan: 'x' }, requestId: 'req-1' } as never));
      fireEvent.click(await screen.findByRole('button', { name: label }));
      // Settled by the answer itself: the card leaves 'awaiting-approval'.
      await waitFor(() => expect(container.querySelector('[data-status]')?.getAttribute('data-status')).toBe('complete'));
      expect(screen.queryByText('Sending to Claude Code…')).toBeNull();
      // The socket was already gone — nothing to release.
      expect(respondToPermission).not.toHaveBeenCalled();
    });
  }
});

describe('a kept card that is not a plan', () => {
  // The real Write prompt the dev instance showed (CC 2.1.281, 80 columns).
  const WRITE_HELLO = fs.readFileSync(path.join(PLAN_FIXTURE_DIR, 'app-screen-cc-2.1.281-write-permission-80col.txt'), 'utf8');
  const writeTool = (file: string) => planTool({ toolName: 'Write', input: { file_path: file, content: 'hi' }, requestId: undefined, expired: true } as Partial<ToolCallState>);
  // The screen came from a session in /tmp/plan-e2e/a1, where Claude Code
  // prints the path relative to that folder. ToolCard passes the session's
  // folder; here it is given directly.
  const mountKept = (sid: string, file: string) => render(
    <ChatProvider>
      <ExpiredApprovalActions sessionId={sid} toolName="Write" input={{ file_path: file, content: 'hi' }} cwd="/tmp/plan-e2e/a1" onDismiss={() => {}} />
    </ChatProvider>,
  );

  async function termWith(id: string, text: string) {
    const t = new Terminal({ cols: 100, rows: 40, allowProposedApi: true });
    registerTerminal(id, t as never);
    terms.push({ dispose: () => { unregisterTerminal(id); t.dispose(); } });
    await new Promise<void>((r) => t.write(text.replace(/\n/g, '\r\n'), r));
    return t;
  }

  it("offers its OWN menu's numbered rows and Dismiss; a row types only its number", async () => {
    await termWith('kept', WRITE_HELLO);
    mountKept('kept', '/tmp/plan-e2e/a1/hello.txt');
    fireEvent.click(await screen.findByRole('button', { name: 'No' }));
    expect(sendInput.mock.calls).toEqual([['kept', '3']]);
    expect(screen.getByRole('button', { name: 'Dismiss — I answered in the terminal' })).toBeTruthy();
    expect(respondToPermission).not.toHaveBeenCalled();
  });

  it('a same-named file in another folder is a different call — no buttons', async () => {
    await termWith('samename', WRITE_HELLO);
    mountKept('samename', '/tmp/plan-e2e/a1/sub/hello.txt');
    await screen.findByText(/Answer it there, or dismiss this/);
    expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull();
  });

  it('through ToolCard with no known session folder, an absolute path cannot match a relative one — no buttons', async () => {
    await termWith('nocwd', WRITE_HELLO);
    mount('nocwd', writeTool('/tmp/plan-e2e/a1/hello.txt'));
    await screen.findByText(/Answer it there, or dismiss this/);
    expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull();
  });

  it("two asks in a row: a card whose ask was answered shows NO buttons for the NEXT ask's menu", async () => {
    // Card A (Write a.txt) was answered in the terminal; the screen now shows
    // B's prompt (Write hello.txt). A's "Yes" must not be able to approve B.
    await termWith('next', WRITE_HELLO);
    mountKept('next', '/tmp/plan-e2e/a1/a.txt');
    await screen.findByText(/Answer it there, or dismiss this/);
    expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'No' })).toBeNull();
  });

  it("re-reads the screen at click time: if the next ask's menu replaced its own, nothing is typed", async () => {
    const t = await termWith('swap', WRITE_HELLO);
    mountKept('swap', '/tmp/plan-e2e/a1/hello.txt');
    const yes = await screen.findByRole('button', { name: 'Yes' });
    // Before the next 2s re-read, the terminal moves on to a different ask.
    await new Promise<void>((r) => t.write('\x1b[2J\x1b[H' + WRITE_HELLO.replace(/hello\.txt/g, 'other.txt').replace(/\n/g, '\r\n'), r));
    fireEvent.click(yes);
    expect(sendInput).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/menu changed before that went through, so nothing was sent/);
  });

  it('an AskUserQuestion kept card gets Dismiss only — no rows are guessed', async () => {
    await termWith('ask', ' Pick one\n ❯ 1. Red\n   2. Blue\n');
    mount('ask', planTool({ toolName: 'AskUserQuestion', input: { questions: [{ question: 'Pick one', header: 'Q', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] }, requestId: undefined, expired: true } as Partial<ToolCallState>));
    await screen.findByRole('button', { name: 'Dismiss — I answered in the terminal' });
    expect(screen.queryByRole('button', { name: 'Red' })).toBeNull();
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

describe('the buddy floater and a kept card', () => {
  it('offers only Dismiss, worded as the claim it is', () => {
    render(
      <ChatProvider>
        <CompactToolStrip tools={[planTool({ toolName: 'Bash', input: { command: 'ls' }, requestId: undefined, expired: true } as Partial<ToolCallState>)]} sessionId="s1" />
      </ChatProvider>,
    );
    expect(screen.getByText('Dismiss — I answered in the terminal')).toBeTruthy();
    expect(screen.queryByText(/Allow/)).toBeNull();
  });
});
