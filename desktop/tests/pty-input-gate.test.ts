import { describe, it, expect, vi } from 'vitest';
import {
  hasPendingInteraction,
  canRetrySubmit,
  canPtySend,
  pendingInteractionKind,
  pendingInteractionRefusalCopy,
  pendingCardRef,
  sendBlock,
  screenInputBlock,
  screenPaint,
  waitForPaintedScreen,
} from '../src/renderer/state/pty-input-gate';
import { Terminal } from '@xterm/headless';
import { registerTerminal, unregisterTerminal } from '../src/renderer/hooks/terminal-registry';
import { createSessionChatState, SessionChatState, HISTORY_EXPAND_PROMPT_ID } from '../src/renderer/state/chat-types';
import type { ToolCallState } from '../src/renderer/state/chat-types';

// Why these tests exist: Claude Code keeps its native Ink select menu live in
// the PTY while YouCoded shows a permission / AskUserQuestion / plan card.
// Any programmatic byte written to the PTY in that window is menu input — a
// bare `\r` selects the highlighted option, silently auto-answering the
// question (or auto-approving the permission). These predicates are the
// shared gate every automated PTY writer must consult first.

function makeTool(overrides: Partial<ToolCallState>): ToolCallState {
  return {
    toolUseId: 'tool-1',
    toolName: 'Bash',
    input: {},
    status: 'running',
    ...overrides,
  };
}

function withTool(session: SessionChatState, tool: ToolCallState): SessionChatState {
  session.toolCalls.set(tool.toolUseId, tool);
  session.activeTurnToolIds.add(tool.toolUseId);
  return session;
}

describe('hasPendingInteraction', () => {
  it('is false for a fresh idle session', () => {
    expect(hasPendingInteraction(createSessionChatState())).toBe(false);
  });

  it('is true when an active-turn tool is awaiting approval', () => {
    const session = withTool(createSessionChatState(), makeTool({ status: 'awaiting-approval' }));
    expect(hasPendingInteraction(session)).toBe(true);
  });

  it('is false when the awaiting-approval tool belongs to a PRIOR turn', () => {
    // toolCalls is a session-lifetime Map that is never cleared; only
    // activeTurnToolIds scopes the current turn. A stale awaiting-approval
    // entry from an ended turn must not block input forever.
    const session = createSessionChatState();
    session.toolCalls.set('old', makeTool({ toolUseId: 'old', status: 'awaiting-approval' }));
    expect(hasPendingInteraction(session)).toBe(false);
  });

  it('is false when active-turn tools are merely running', () => {
    const session = withTool(createSessionChatState(), makeTool({ status: 'running' }));
    expect(hasPendingInteraction(session)).toBe(false);
  });

  it('is true when an uncompleted interactive prompt is in the timeline', () => {
    const session = createSessionChatState();
    session.timeline.push({
      kind: 'prompt',
      prompt: { promptId: 'p1', title: 'Trust this folder?', buttons: [] },
    });
    expect(hasPendingInteraction(session)).toBe(true);
  });

  it('is false when the interactive prompt was already completed', () => {
    const session = createSessionChatState();
    session.timeline.push({
      kind: 'prompt',
      prompt: { promptId: 'p1', title: 'Trust this folder?', buttons: [], completed: 'Yes' },
    });
    expect(hasPendingInteraction(session)).toBe(false);
  });

  it('is false when the ONLY uncompleted prompt is the "See previous messages" marker', () => {
    // Regression (2026-07-17): HISTORY_LOADED pushes this marker (no buttons,
    // no `completed`) on EVERY resumed session with history. It rides the
    // `prompt` kind for rendering but is not a live Ink menu — counting it here
    // silently locked all sends until the user clicked "See previous messages".
    const session = createSessionChatState();
    session.timeline.push({
      kind: 'prompt',
      prompt: { promptId: HISTORY_EXPAND_PROMPT_ID, title: 'See previous messages', buttons: [] },
    });
    expect(hasPendingInteraction(session)).toBe(false);
  });

  it('still blocks when a REAL prompt sits alongside the history-expand marker', () => {
    // The marker exclusion must be scoped to the marker id only — a genuine
    // interactive prompt in the same timeline must still gate sends.
    const session = createSessionChatState();
    session.timeline.push({
      kind: 'prompt',
      prompt: { promptId: HISTORY_EXPAND_PROMPT_ID, title: 'See previous messages', buttons: [] },
    });
    session.timeline.push({
      kind: 'prompt',
      prompt: { promptId: 'p1', title: 'Trust this folder?', buttons: [{ label: 'Yes', input: '1\r' }] },
    });
    expect(hasPendingInteraction(session)).toBe(true);
  });
});

describe('canRetrySubmit', () => {
  it('allows retry for an idle session with attentionState ok', () => {
    expect(canRetrySubmit(createSessionChatState())).toBe(true);
  });

  it('blocks retry when attentionState is not ok', () => {
    const session = createSessionChatState();
    session.attentionState = 'stuck';
    expect(canRetrySubmit(session)).toBe(false);
  });

  it('blocks retry while a tool is awaiting approval (menu live in TUI)', () => {
    const session = withTool(createSessionChatState(), makeTool({ status: 'awaiting-approval' }));
    expect(canRetrySubmit(session)).toBe(false);
  });

  it('blocks retry while active-turn tools are running (turn in flight)', () => {
    const session = withTool(createSessionChatState(), makeTool({ status: 'running' }));
    expect(canRetrySubmit(session)).toBe(false);
  });

  it('blocks retry while an assistant turn is in flight (currentTurnId set)', () => {
    // Covers the queued-message case: CC queues messages sent mid-turn and
    // only writes their transcript line when consumed, so `pending` stays set
    // for the whole turn. Retrying mid-turn risks pressing Enter on a menu
    // that appears later in the turn.
    const session = createSessionChatState();
    session.currentTurnId = 'turn-1';
    expect(canRetrySubmit(session)).toBe(false);
  });

  it('blocks retry while an uncompleted interactive prompt is shown', () => {
    const session = createSessionChatState();
    session.timeline.push({
      kind: 'prompt',
      prompt: { promptId: 'p1', title: 'Resume Session', buttons: [] },
    });
    expect(canRetrySubmit(session)).toBe(false);
  });

  it('still allows retry while isThinking is true but nothing else is in flight', () => {
    // isThinking is set on USER_PROMPT and only cleared by endTurn(). In the
    // lost-message state this hook recovers from, CC never received the
    // message, so isThinking stays true forever — it must NOT gate the retry.
    const session = createSessionChatState();
    session.isThinking = true;
    expect(canRetrySubmit(session)).toBe(true);
  });
});

describe('canPtySend (M1 honest guard)', () => {
  it('refuses when the session does not exist', () => expect(canPtySend(undefined, undefined)).toBe(false));
  it('refuses native sessions — they have no PTY worker', () =>
    expect(canPtySend({ provider: 'native' }, { attentionState: 'ok' })).toBe(false));
  it('refuses dead sessions', () =>
    expect(canPtySend({ provider: 'claude' }, { attentionState: 'session-died' })).toBe(false));
  it('allows a live claude session', () =>
    expect(canPtySend({ provider: 'claude' }, { attentionState: 'ok' })).toBe(true));
  it('allows when chat state has not materialized yet (boot window)', () =>
    expect(canPtySend({ provider: 'claude' }, undefined)).toBe(true));
});

// The send-refusal toast names what is blocking: a card in the chat (including a
// kept card whose hook closed) or a prompt scraped from the terminal.
describe('pendingInteractionKind and its refusal copy', () => {
  it('an awaiting card — live or kept — is an approval', () => {
    expect(pendingInteractionKind(withTool(createSessionChatState(), makeTool({ status: 'awaiting-approval', requestId: 'r' })))).toBe('approval');
    expect(pendingInteractionKind(withTool(createSessionChatState(), makeTool({ status: 'awaiting-approval', expired: true })))).toBe('approval');
  });

  it('nothing blocking is null', () => {
    expect(pendingInteractionKind(createSessionChatState())).toBeNull();
  });

  it('agrees with hasPendingInteraction on whether anything blocks', () => {
    for (const status of ['running', 'awaiting-approval', 'complete'] as const) {
      const session = withTool(createSessionChatState(), makeTool({ status }));
      expect(pendingInteractionKind(session) !== null).toBe(hasPendingInteraction(session));
    }
  });

  it('every reason reads the same one sentence (the button says where to look)', () => {
    for (const kind of ['approval', 'prompt', 'screen', null] as const) {
      expect(pendingInteractionRefusalCopy(kind)).toBe('Claude Code is waiting on something — answer it first.');
    }
  });
});

// The refusal toast's way forward: "Show card" needs the waiting card's id;
// with no card, the live screen is what blocks and "Open terminal" is offered.
describe('pendingCardRef — which card "Show card" scrolls to', () => {
  it('names the current turn\'s waiting permission card by its tool id', () => {
    const session = withTool(createSessionChatState(), makeTool({ toolUseId: 'tu-9', status: 'awaiting-approval', requestId: 'r' }));
    expect(pendingCardRef(session)).toEqual({ toolUseId: 'tu-9' });
  });

  it('names an unanswered prompt card by its prompt id, skipping the history marker', () => {
    const session = createSessionChatState();
    session.timeline.push({ kind: 'prompt', prompt: { promptId: HISTORY_EXPAND_PROMPT_ID, title: '', buttons: [], completed: false } } as never);
    session.timeline.push({ kind: 'prompt', prompt: { promptId: 'menu_export', title: 'Export conversation', buttons: [], completed: false } } as never);
    expect(pendingCardRef(session)).toEqual({ promptId: 'menu_export' });
  });

  it('is null when nothing waits', () => {
    expect(pendingCardRef(createSessionChatState())).toBeNull();
    expect(pendingCardRef(undefined)).toBeNull();
  });
});

describe('sendBlock — the screen blocks what the chat state cannot see', () => {
  const RULE = '─'.repeat(60);
  async function withScreen(id: string, rows: string[], run: () => void) {
    const term = new Terminal({ cols: 80, rows: 20, allowProposedApi: true });
    registerTerminal(id, term as never);
    await new Promise<void>((r) => term.write(rows.join('\r\n'), r));
    try { run(); } finally { unregisterTerminal(id); term.dispose(); }
  }

  it('a Claude Code pop-up in place of the message box blocks, as "screen"', async () => {
    await withScreen('s-popup', ['history', RULE, '  Export conversation', '  ❯ 1. Copy to clipboard', '    2. Save to file', '  Esc to cancel'], () => {
      const block = sendBlock(createSessionChatState(), 's-popup');
      expect(block?.kind).toBe('screen');
      expect(block!.screen?.kind).toBe('popup');
    });
  });

  it('the live message box does not block', async () => {
    await withScreen('s-box', ['history', RULE, '❯ ', RULE, '  ⏵⏵ auto mode on (shift+tab to cycle)'], () => {
      expect(sendBlock(createSessionChatState(), 's-box')).toBeNull();
    });
  });

  it('a waiting card wins over the screen (it names the card to answer)', async () => {
    await withScreen('s-both', ['history', RULE, '  Bash command', '  ❯ 1. Yes', '    2. No', '  Esc to cancel'], () => {
      const session = withTool(createSessionChatState(), makeTool({ status: 'awaiting-approval', requestId: 'r' }));
      expect(sendBlock(session, 's-both')?.kind).toBe('approval');
    });
  });

  it('the agents list blocks too, though it draws a box (a send there would start a new session)', async () => {
    await withScreen('s-agents', ['Working', RULE, '❯ describe a task for a new session', RULE, '  ⏵⏵ auto mode · enter to return · space to reply · ctrl+x to delete'], () => {
      const block = sendBlock(createSessionChatState(), 's-agents');
      expect(block?.screen).toEqual({ kind: 'other-view', view: 'agents' });
    });
  });

  it('no terminal at all is no verdict — the send is not refused', () => {
    expect(sendBlock(createSessionChatState(), 'no-such-session')).toBeNull();
  });
});

// 2026-10-05: a freshly re-mounted terminal is blank (or shows one stray row) until the program repaints. The SYNC gate
// stays strict (an unpainted screen may be a hook-less pop-up mid-draw); only the composer waits for a picture.
describe('unpainted screens — strict for sync callers, waited on by the composer', () => {
  const RULE = '─'.repeat(60);
  const FRAME_BOX = ['history', RULE, '❯ ', RULE, '  ⏵⏵ auto mode on'];
  const FRAME_POPUP = ['history', RULE, '  Select model', '  ❯ 1. Default', '    2. Opus', '  Esc to cancel'];
  function mount(id: string) {
    const term = new Terminal({ cols: 120, rows: 20, allowProposedApi: true });
    registerTerminal(id, term as never);
    const set = async (rows: string[]) => { await new Promise<void>((r) => term.write('\x1b[2J\x1b[H' + rows.join('\r\n'), r)); };
    const done = () => { unregisterTerminal(id); term.dispose(); };
    return { set, done };
  }
  function spyRepaint() {
    const requestRepaint = vi.fn();
    (globalThis as any).window = Object.assign((globalThis as any).window ?? {}, { claude: { session: { requestRepaint } } });
    return requestRepaint;
  }

  it('a stray fragment blocks the sync gate (bare-Enter retry, Shift+Tab) and asks for a repaint', async () => {
    const rr = spyRepaint(); const m = mount('p-frag');
    await m.set([' '.repeat(79) + 'Checking for updates']);
    expect(screenInputBlock('p-frag')).not.toBeNull();
    expect(sendBlock(createSessionChatState(), 'p-frag')?.kind).toBe('screen');
    expect(rr).toHaveBeenCalledWith('p-frag', undefined);
    m.done();
  });

  it('a 2-3 row rule-less prompt blocks the sync gate and is "unpainted" for the composer', async () => {
    const m = mount('p-short');
    await m.set(['  Do you trust this folder?', '  ❯ 1. Yes']);
    expect(screenInputBlock('p-short')).not.toBeNull();
    expect(screenPaint('p-short')).toBe('unpainted');
    m.done();
  });

  it('any box-drawing run of 10+ on a tiny screen is not "unpainted" (rounded, double and titled rules)', async () => {
    const m = mount('p-box');
    await m.set(['╭' + '─'.repeat(30) + '╮', '│ Select │']);
    expect(screenPaint('p-box')).toBe('painted');
    await m.set(['── Title ' + '─'.repeat(8) + ' ──', 'x']);
    expect(screenPaint('p-box')).toBe('painted');
    m.done();
  });

  it('a genuine pop-up still blocks; the message box does not; no terminal is no verdict', async () => {
    const m = mount('p-real');
    await m.set(FRAME_POPUP); expect(sendBlock(createSessionChatState(), 'p-real')?.kind).toBe('screen');
    await m.set(FRAME_BOX); expect(sendBlock(createSessionChatState(), 'p-real')).toBeNull();
    m.done();
    expect(sendBlock(createSessionChatState(), 'p-none')).toBeNull();
    expect(screenPaint('p-none')).toBe('none');
  });

  it('waitForPaintedScreen: fragment, then the full frame -> resolves "box" only once the box is there', async () => {
    const m = mount('w-seq');
    await m.set(['Checking for updates']);
    let resolved: string | null = null;
    const p = waitForPaintedScreen('w-seq', { timeoutMs: 1000, stepMs: 10 }).then((v) => { resolved = v; return v; });
    await new Promise((r) => setTimeout(r, 80));
    expect(resolved).toBeNull();                       // still waiting while only the fragment is there
    await m.set(FRAME_BOX);
    expect(await p).toBe('box');
    m.done();
  });

  it('waitForPaintedScreen: a pop-up that draws progressively is "blocked", never "box"', async () => {
    const m = mount('w-pop');
    await m.set([RULE.slice(0, 5)]);                   // fragment of an edge
    const p = waitForPaintedScreen('w-pop', { timeoutMs: 1000, stepMs: 10 });
    await new Promise((r) => setTimeout(r, 30));
    await m.set(FRAME_POPUP);
    expect(await p).toBe('blocked');
    m.done();
  });

  it('waitForPaintedScreen: still nothing at the deadline -> "unpainted" (after waiting), and a cancel writes nothing', async () => {
    const m = mount('w-dead');
    await m.set(['Checking for updates']);
    const t0 = Date.now();
    expect(await waitForPaintedScreen('w-dead', { timeoutMs: 120, stepMs: 10 })).toBe('unpainted');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
    const sig = { aborted: false };
    const p = waitForPaintedScreen('w-dead', { timeoutMs: 1000, stepMs: 10, signal: sig });
    sig.aborted = true;
    expect(await p).toBe('cancelled');
    m.done();
  });
});
