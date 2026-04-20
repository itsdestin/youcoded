import { describe, it, expect, beforeEach } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { ChatState, ChatAction } from '../src/renderer/state/chat-types';

const SESSION = 'test-session';

function initState(): ChatState {
  const state: ChatState = new Map();
  return chatReducer(state, { type: 'SESSION_INIT', sessionId: SESSION });
}

function dispatch(state: ChatState, action: ChatAction): ChatState {
  return chatReducer(state, action);
}

describe('Attention state reducer actions', () => {
  let state: ChatState;

  beforeEach(() => {
    state = initState();
  });

  it('default attentionState is "ok"', () => {
    expect(state.get(SESSION)!.attentionState).toBe('ok');
  });

  it('ATTENTION_STATE_CHANGED updates the state', () => {
    state = dispatch(state, {
      type: 'ATTENTION_STATE_CHANGED',
      sessionId: SESSION,
      state: 'stuck',
    });
    expect(state.get(SESSION)!.attentionState).toBe('stuck');
  });

  it('ATTENTION_STATE_CHANGED is a no-op when the value matches', () => {
    const before = state;
    state = dispatch(state, {
      type: 'ATTENTION_STATE_CHANGED',
      sessionId: SESSION,
      state: 'ok',
    });
    // Map reference is preserved when no change occurred
    expect(state).toBe(before);
  });

  it('SESSION_PROCESS_EXITED with exitCode=0 and no in-flight → no-op', () => {
    const before = state;
    state = dispatch(state, {
      type: 'SESSION_PROCESS_EXITED',
      sessionId: SESSION,
      exitCode: 0,
    });
    expect(state).toBe(before);
    expect(state.get(SESSION)!.attentionState).toBe('ok');
  });

  it('SESSION_PROCESS_EXITED with nonzero exitCode → session-died + endTurn', () => {
    // Start a turn
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'u1',
      text: 'hi',
      timestamp: 1000,
    });
    expect(state.get(SESSION)!.isThinking).toBe(true);

    state = dispatch(state, {
      type: 'SESSION_PROCESS_EXITED',
      sessionId: SESSION,
      exitCode: 137,
    });

    const session = state.get(SESSION)!;
    expect(session.attentionState).toBe('session-died');
    expect(session.isThinking).toBe(false);
    expect(session.activeTurnToolIds.size).toBe(0);
  });

  it('SESSION_PROCESS_EXITED with in-flight tools fails them and sets session-died', () => {
    // Start a turn + emit a tool
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'u1',
      text: 'hi',
      timestamp: 1000,
    });
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: SESSION,
      uuid: 'u2',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });
    expect(state.get(SESSION)!.toolCalls.get('tool-1')!.status).toBe('running');

    state = dispatch(state, {
      type: 'SESSION_PROCESS_EXITED',
      sessionId: SESSION,
      exitCode: 0, // clean exit, but a tool was in flight
    });

    const session = state.get(SESSION)!;
    expect(session.attentionState).toBe('session-died');
    expect(session.toolCalls.get('tool-1')!.status).toBe('failed');
  });

  it('transcript events clear a prior non-ok attentionState back to ok', () => {
    state = dispatch(state, {
      type: 'ATTENTION_STATE_CHANGED',
      sessionId: SESSION,
      state: 'stuck',
    });
    expect(state.get(SESSION)!.attentionState).toBe('stuck');

    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT',
      sessionId: SESSION,
      uuid: 'u1',
      text: 'here is my answer',
      timestamp: 2000,
    });
    expect(state.get(SESSION)!.attentionState).toBe('ok');
  });

  it('TRANSCRIPT_TURN_COMPLETE (via endTurn) clears attentionState to ok', () => {
    state = dispatch(state, {
      type: 'ATTENTION_STATE_CHANGED',
      sessionId: SESSION,
      state: 'shell-idle',
    });
    state = dispatch(state, {
      type: 'TRANSCRIPT_TURN_COMPLETE',
      sessionId: SESSION,
      uuid: 'u1',
      timestamp: 3000,
      stopReason: null,
      model: null,
      anthropicRequestId: null,
      usage: null,
    });
    expect(state.get(SESSION)!.attentionState).toBe('ok');
  });

  it('TRANSCRIPT_THINKING_HEARTBEAT bumps lastActivityAt and clears attentionState', () => {
    state = dispatch(state, {
      type: 'ATTENTION_STATE_CHANGED',
      sessionId: SESSION,
      state: 'stuck',
    });
    const before = state.get(SESSION)!.lastActivityAt;

    // Tiny wait to guarantee Date.now() advances
    const now = Date.now();
    while (Date.now() === now) { /* spin */ }

    state = dispatch(state, {
      type: 'TRANSCRIPT_THINKING_HEARTBEAT',
      sessionId: SESSION,
    });
    const session = state.get(SESSION)!;
    expect(session.attentionState).toBe('ok');
    expect(session.lastActivityAt).toBeGreaterThan(before);
  });

  it('PERMISSION_REQUEST clears attentionState (no redundant banner over the card)', () => {
    // Set up a running tool so the permission can find a match
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'u1',
      text: 'hi',
      timestamp: 1000,
    });
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: SESSION,
      uuid: 'u2',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });
    state = dispatch(state, {
      type: 'ATTENTION_STATE_CHANGED',
      sessionId: SESSION,
      state: 'stuck',
    });

    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'ls' },
      requestId: 'req-1',
    });
    expect(state.get(SESSION)!.attentionState).toBe('ok');
  });
});
