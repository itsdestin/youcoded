// @vitest-environment jsdom
// Regression tests for usePromptDetector's prompt lifecycle (2026-07-16).
//
// Bug: when a recognized setup prompt (e.g. "Resume Session") was showing and
// the PTY screen then advanced to a DIFFERENT menu, the detector overwrote its
// lastMenuRef tracking id BEFORE the SETUP_PROMPT_TITLES gate bailed out — so
// the old prompt's DISMISS_PROMPT never fired (dismissal only targets whatever
// id the ref currently points at). The orphaned timeline entry stayed at
// completed:false forever and hasPendingInteraction() blocked all sends.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  callbacks: [] as Array<(sid: string) => void>,
  screen: { text: '' },
  // Minimal ChatStore stand-in (tranche 1: the detector reads the store
  // directly instead of subscribing to the whole chat map). These tests drive
  // the detector purely through terminal buffer events, so chat state stays
  // empty — no awaiting-approval tools — and nothing ever notifies. Identity
  // is stable across renders, matching the real store's per-provider lifetime.
  // Most tests leave `sessions` empty (no awaiting-approval tools); the
  // kept-card tests below fill it per test.
  sessions: new Map<string, any>(),
  store: {
    getState: () => mocks.sessions,
    subscribeAll: () => () => {},
  },
}));

vi.mock('../src/renderer/hooks/terminal-registry', () => ({
  onBufferReady: (cb: (sid: string) => void) => {
    mocks.callbacks.push(cb);
    return () => {
      const i = mocks.callbacks.indexOf(cb);
      if (i >= 0) mocks.callbacks.splice(i, 1);
    };
  },
  getVisibleScreenText: () => mocks.screen.text,
}));

vi.mock('../src/renderer/state/chat-context', () => ({
  useChatDispatch: () => mocks.dispatch,
  useChatStore: () => mocks.store,
}));

import { usePromptDetector } from '../src/renderer/hooks/usePromptDetector';

// A recognized setup prompt (title in SETUP_PROMPT_TITLES).
const RESUME_MENU = `Resume Session

1: as is
  ❯ 2: from summary

press enter to confirm`;

// A different menu the detector does NOT recognize as a setup prompt.
const UNRECOGNIZED_MENU = `Pick a flavor

 ❯ 1. Vanilla
   2. Chocolate`;

function fireBuffer(sid: string) {
  act(() => {
    for (const cb of [...mocks.callbacks]) cb(sid);
  });
}

describe('usePromptDetector prompt lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.dispatch.mockClear();
    mocks.callbacks.length = 0;
    mocks.screen.text = '';
    mocks.sessions.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a recognized setup prompt after the debounce', () => {
    renderHook(() => usePromptDetector());
    mocks.screen.text = RESUME_MENU;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(400); });

    const show = mocks.dispatch.mock.calls.find((c) => c[0].type === 'SHOW_PROMPT');
    expect(show).toBeTruthy();
    expect(show![0].title).toBe('Resume Session');
  });

  it('dismisses the previous prompt when a different, unrecognized menu replaces it', () => {
    renderHook(() => usePromptDetector());

    // Step 1: recognized prompt appears and is shown.
    mocks.screen.text = RESUME_MENU;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(400); });
    const show = mocks.dispatch.mock.calls.find((c) => c[0].type === 'SHOW_PROMPT');
    expect(show).toBeTruthy();
    const shownId = show![0].promptId as string;

    // Step 2: the PTY advances to a different, unrecognized menu.
    mocks.dispatch.mockClear();
    mocks.screen.text = UNRECOGNIZED_MENU;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(700); }); // > DISMISS_DEBOUNCE_MS

    // The old prompt must be dismissed — otherwise it orphans at
    // completed:false and hasPendingInteraction() blocks sends forever.
    const dismiss = mocks.dispatch.mock.calls.find((c) => c[0].type === 'DISMISS_PROMPT');
    expect(dismiss).toBeTruthy();
    expect(dismiss![0].promptId).toBe(shownId);

    // And the unrecognized menu must NOT produce a SHOW_PROMPT.
    const strayShow = mocks.dispatch.mock.calls.find((c) => c[0].type === 'SHOW_PROMPT');
    expect(strayShow).toBeUndefined();
  });

  it('cancels a pending (not yet shown) prompt when a different menu replaces it', () => {
    renderHook(() => usePromptDetector());

    // Recognized menu appears but the debounce has NOT elapsed yet.
    mocks.screen.text = RESUME_MENU;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(100); }); // < PROMPT_DEBOUNCE_MS

    // Screen advances to an unrecognized menu before the show fired.
    mocks.screen.text = UNRECOGNIZED_MENU;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(1000); });

    // The stale pending show must never fire.
    const show = mocks.dispatch.mock.calls.find((c) => c[0].type === 'SHOW_PROMPT');
    expect(show).toBeUndefined();
  });

  it('dispatches nothing while unrecognized menus churn (streaming numbered lists)', () => {
    renderHook(() => usePromptDetector());

    // Streaming output that happens to parse as menus, with changing ids —
    // up to ~60 buffer flushes/sec. No prompt was ever shown, so no reducer
    // dispatches should occur at all.
    mocks.screen.text = UNRECOGNIZED_MENU;
    fireBuffer('s1');
    mocks.screen.text = `Pick a size

 ❯ 1. Small
   2. Large`;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(1000); });

    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('does NOT show a prompt if the menu vanished during the debounce with no trailing flush', () => {
    // Regression (2026-07-17): the show timer captured `menu` at schedule time
    // and dispatched SHOW_PROMPT without re-checking the screen. If the PTY
    // advanced past the menu during the 350ms debounce and then went IDLE (no
    // further buffer flush to run the disappear branch), a completed:false
    // prompt entry stranded with nothing on screen — locking every send.
    renderHook(() => usePromptDetector());

    // Recognized menu appears, scheduling the show timer.
    mocks.screen.text = RESUME_MENU;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(100); }); // < PROMPT_DEBOUNCE_MS

    // The menu left the screen, but NO further buffer flush fires (idle PTY).
    mocks.screen.text = 'plain output, no menu here';

    // Let the show timer fire. Its re-check must see the menu is gone and bail.
    act(() => { vi.advanceTimersByTime(400); });

    const show = mocks.dispatch.mock.calls.find((c) => c[0].type === 'SHOW_PROMPT');
    expect(show).toBeUndefined();
  });

  it('still dismisses when the menu disappears entirely (existing behavior)', () => {
    renderHook(() => usePromptDetector());
    mocks.screen.text = RESUME_MENU;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(400); });
    const show = mocks.dispatch.mock.calls.find((c) => c[0].type === 'SHOW_PROMPT');
    const shownId = show![0].promptId as string;

    mocks.dispatch.mockClear();
    mocks.screen.text = 'plain output, no menu here';
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(700); });

    const dismiss = mocks.dispatch.mock.calls.find((c) => c[0].type === 'DISMISS_PROMPT');
    expect(dismiss).toBeTruthy();
    expect(dismiss![0].promptId).toBe(shownId);
  });
});

// The detector is the ONLY thing that settles a KEPT card on its own (a card
// whose hook socket died while Claude Code's menu may still be live): after two
// consecutive buffer flushes with no menu on screen.
describe('usePromptDetector settles kept cards when the menu is gone', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.dispatch.mockClear();
    mocks.callbacks.length = 0;
    mocks.screen.text = '';
    mocks.sessions.clear();
  });
  afterEach(() => { vi.useRealTimers(); });

  // An unrecognized menu: "a menu is present" without triggering a PromptCard.
  const NEUTRAL_MENU = `Pick a flavor

 ❯ 1. Vanilla
   2. Chocolate`;
  const PLAN_MENU = [
    '   Claude has written up a plan and is ready to execute. Would you like to proceed?',
    '   ❯ 1. Yes, auto-accept edits',
    '     2. Yes, manually approve edits',
    '     3. Tell Claude what to change',
    '        shift+tab to approve with this feedback',
  ].join('\n');
  const NO_MENU = 'plain output, no menu here';
  const resolvedCalls = () => mocks.dispatch.mock.calls.filter((c) => c[0].type === 'PERMISSION_CARD_RESOLVED');

  function keep(toolName = 'Bash', extra: Record<string, unknown> = { expired: true }) {
    const tool = { toolUseId: 'toolu_kept', toolName, status: 'awaiting-approval', input: {}, ...extra };
    mocks.sessions.set('s1', { toolCalls: new Map([[tool.toolUseId, tool]]), activeTurnToolIds: new Set([tool.toolUseId]) });
  }

  it('a menu coming back resets the count', () => {
    keep();
    renderHook(() => usePromptDetector());
    mocks.screen.text = NO_MENU; fireBuffer('s1');
    mocks.screen.text = NEUTRAL_MENU; fireBuffer('s1');
    mocks.screen.text = NO_MENU; fireBuffer('s1');
    expect(resolvedCalls()).toEqual([]);
  });

  it('one absent flush is not enough', () => {
    keep();
    renderHook(() => usePromptDetector());
    mocks.screen.text = NO_MENU; fireBuffer('s1');
    expect(resolvedCalls()).toEqual([]);
  });

  it('two consecutive absent flushes settle the kept card', () => {
    keep();
    renderHook(() => usePromptDetector());
    mocks.screen.text = NO_MENU; fireBuffer('s1'); fireBuffer('s1');
    expect(resolvedCalls().map((c) => c[0])).toEqual([{ type: 'PERMISSION_CARD_RESOLVED', sessionId: 's1', toolUseId: 'toolu_kept' }]);
  });

  it("Claude Code's plan menu counts as present — a kept plan card is not settled while it is up", () => {
    keep('ExitPlanMode');
    renderHook(() => usePromptDetector());
    mocks.screen.text = PLAN_MENU; fireBuffer('s1'); fireBuffer('s1'); fireBuffer('s1');
    expect(resolvedCalls()).toEqual([]);
  });

  it('a LIVE ask is never settled by this rule, and still silences setup-prompt cards', () => {
    keep('Bash', {});
    renderHook(() => usePromptDetector());
    mocks.screen.text = NO_MENU; fireBuffer('s1'); fireBuffer('s1');
    mocks.screen.text = RESUME_MENU; fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(400); });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('a kept card does NOT silence setup-prompt cards', () => {
    keep();
    renderHook(() => usePromptDetector());
    mocks.screen.text = RESUME_MENU; fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(400); });
    expect(mocks.dispatch.mock.calls.some((c) => c[0].type === 'SHOW_PROMPT')).toBe(true);
  });
});

// ---- the startup safety net -------------------------------------------------
import { getUnreadableStartupDialog } from '../src/renderer/state/startup-dialog-store';

const RULE = '─'.repeat(80);
const NEW_DIALOG = [
  RULE,
  '  Something Claude Code has never asked before',
  '',
  '  Some body text explaining it.',
  '',
  '  ❯ Keep going',
  '    Stop here',
  '',
  '  Enter to confirm · Esc to cancel',
].join('\n');
const TRUST_2_1_281 = [
  RULE,
  ' Accessing workspace:',
  '',
  ' /home/someone/project',
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');
const MULTI_SELECT = [
  RULE,
  '  2 new MCP servers found in this project',
  '  Select any you wish to enable.',
  '',
  '  ❯ [✔] demo',
  '    [✔] other',
  '       Enable selected',
  ' Space to select · Esc to reject all',
].join('\n');

describe('usePromptDetector startup safety net', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.dispatch.mockClear();
    mocks.callbacks.length = 0;
    mocks.screen.text = '';
    mocks.sessions.clear();
  });
  afterEach(() => { vi.useRealTimers(); });

  const shows = () => mocks.dispatch.mock.calls.filter((c) => c[0].type === 'SHOW_PROMPT').map((c) => c[0]);

  it('shows the 2.1.281 trust dialog with verified-navigation buttons, starting on "No, exit"', () => {
    renderHook(() => usePromptDetector({ isStarting: () => true }));
    mocks.screen.text = TRUST_2_1_281;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(400); });
    const [show] = shows();
    expect(show.title).toBe('Trust This Folder?');
    expect(show.buttons.map((b: any) => b.label)).toEqual(['No, exit', 'Yes, I trust this folder']);
    expect(show.buttons.every((b: any) => b.pick && b.input === '')).toBe(true);
    expect(show.defaultIndex).toBe(0);
  });

  it('while starting, shows a dialog nobody taught it about — titled with its own heading', () => {
    renderHook(() => usePromptDetector({ isStarting: () => true }));
    mocks.screen.text = NEW_DIALOG;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(400); });
    const [show] = shows();
    expect(show.title).toBe('Something Claude Code has never asked before');
    expect(show.buttons.map((b: any) => b.label)).toEqual(['Keep going', 'Stop here']);
    expect(show.defaultIndex).toBe(0);
  });

  it('once started, the same unknown menu is left alone (permission menus belong to the hook cards)', () => {
    renderHook(() => usePromptDetector({ isStarting: () => false }));
    mocks.screen.text = NEW_DIALOG;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(400); });
    expect(shows()).toEqual([]);
    expect(getUnreadableStartupDialog('s1')).toBeNull();
  });

  it('never turns a numbered list in a reply into a card, even while starting', () => {
    renderHook(() => usePromptDetector({ isStarting: () => true }));
    mocks.screen.text = UNRECOGNIZED_MENU;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(400); });
    expect(shows()).toEqual([]);
  });

  it('reports a dialog it cannot turn into buttons at once, and clears it when it goes', () => {
    renderHook(() => usePromptDetector({ isStarting: () => true }));
    mocks.screen.text = MULTI_SELECT;
    fireBuffer('s1');
    expect(getUnreadableStartupDialog('s1')).toEqual({ heading: '2 new MCP servers found in this project' });
    expect(shows()).toEqual([]);
    mocks.screen.text = '❯ \n? for shortcuts';
    fireBuffer('s1');
    expect(getUnreadableStartupDialog('s1')).toBeNull();
  });
});
