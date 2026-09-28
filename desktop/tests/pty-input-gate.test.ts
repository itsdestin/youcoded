import { describe, it, expect } from 'vitest';
import {
  hasPendingInteraction,
  canRetrySubmit,
  canPtySend,
  pendingInteractionKind,
  pendingInteractionRefusalCopy,
} from '../src/renderer/state/pty-input-gate';
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

  it('the copy points at the card for an approval, at the prompt otherwise', () => {
    expect(pendingInteractionRefusalCopy('approval')).toMatch(/answer the card in the chat first/);
    expect(pendingInteractionRefusalCopy('prompt')).toMatch(/answer the prompt first/);
    expect(pendingInteractionRefusalCopy(null)).toMatch(/answer the prompt first/);
  });
});
