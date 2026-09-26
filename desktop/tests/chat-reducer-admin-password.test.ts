import { describe, it, expect } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { ChatState, ChatAction } from '../src/renderer/state/chat-types';
import { hookEventToAction } from '../src/renderer/state/hook-dispatcher';
import type { HookEvent } from '../src/shared/types';

// admin-password design §2.5/§2.6: a running Bash call's sudo is waiting for
// the computer password. Unlike PERMISSION_REQUEST, the card is matched by
// `toolUseId` directly — the broker/askpass-server already know exactly
// which call is asking, so there is no name/input guessing to test.

const SESSION = 'test-session';
const TASK_ID = 'task-1';
const CHILD_ID = 'child-1';

function initState(): ChatState {
  const state: ChatState = new Map();
  return chatReducer(state, { type: 'SESSION_INIT', sessionId: SESSION });
}

function dispatch(state: ChatState, action: ChatAction): ChatState {
  return chatReducer(state, action);
}

function bashCard(state: ChatState, toolUseId: string): ChatState {
  return dispatch(state, {
    type: 'TRANSCRIPT_TOOL_USE',
    sessionId: SESSION,
    uuid: `uuid-${toolUseId}`,
    toolUseId,
    toolName: 'Bash',
    toolInput: { command: 'apt update' },
  });
}

function seedTaskCard(state: ChatState, toolUseId = TASK_ID): ChatState {
  return dispatch(state, {
    type: 'TRANSCRIPT_TOOL_USE',
    sessionId: SESSION,
    uuid: `uuid-${toolUseId}`,
    toolUseId,
    toolName: 'Task',
    toolInput: { description: 'hire a specialist' },
  });
}

describe('PASSWORD_REQUEST / PASSWORD_RESOLVED — top-level Bash card', () => {
  it('sets passwordAsk on the RUNNING Bash card named by toolUseId', () => {
    let state = bashCard(initState(), 'bash-1');
    state = dispatch(state, { type: 'PASSWORD_REQUEST', sessionId: SESSION, requestId: 'req-1', toolUseId: 'bash-1', command: 'apt update' });
    const tool = state.get(SESSION)!.toolCalls.get('bash-1')!;
    expect(tool.status).toBe('running'); // never becomes awaiting-approval
    expect(tool.passwordAsk).toEqual({ requestId: 'req-1', command: 'apt update' });
  });

  it('carries via and triesLeft when present', () => {
    let state = bashCard(initState(), 'bash-1');
    state = dispatch(state, {
      type: 'PASSWORD_REQUEST', sessionId: SESSION, requestId: 'req-1', toolUseId: 'bash-1',
      command: 'apt update', via: 'install.sh', triesLeft: 2,
    });
    expect(state.get(SESSION)!.toolCalls.get('bash-1')!.passwordAsk).toEqual({
      requestId: 'req-1', command: 'apt update', via: 'install.sh', triesLeft: 2,
    });
  });

  it('a repeat with the same requestId is a heartbeat no-op (returns the identical state object)', () => {
    let state = bashCard(initState(), 'bash-1');
    state = dispatch(state, { type: 'PASSWORD_REQUEST', sessionId: SESSION, requestId: 'req-1', toolUseId: 'bash-1', command: 'apt update' });
    const settled = state;
    state = dispatch(state, { type: 'PASSWORD_REQUEST', sessionId: SESSION, requestId: 'req-1', toolUseId: 'bash-1', command: 'apt update' });
    expect(state).toBe(settled);
  });

  it('a wrong-try re-ask (new triesLeft) replaces the ask on the same card', () => {
    let state = bashCard(initState(), 'bash-1');
    state = dispatch(state, { type: 'PASSWORD_REQUEST', sessionId: SESSION, requestId: 'req-1', toolUseId: 'bash-1', command: 'apt update' });
    state = dispatch(state, { type: 'PASSWORD_REQUEST', sessionId: SESSION, requestId: 'req-2', toolUseId: 'bash-1', command: 'apt update', triesLeft: 2 });
    expect(state.get(SESSION)!.toolCalls.get('bash-1')!.passwordAsk).toEqual({ requestId: 'req-2', command: 'apt update', triesLeft: 2 });
  });

  it('PASSWORD_RESOLVED clears the field, leaving the card running with no other change', () => {
    let state = bashCard(initState(), 'bash-1');
    state = dispatch(state, { type: 'PASSWORD_REQUEST', sessionId: SESSION, requestId: 'req-1', toolUseId: 'bash-1', command: 'apt update' });
    state = dispatch(state, { type: 'PASSWORD_RESOLVED', sessionId: SESSION, requestId: 'req-1' });
    const tool = state.get(SESSION)!.toolCalls.get('bash-1')!;
    expect(tool.passwordAsk).toBeUndefined();
    expect(tool.status).toBe('running');
  });

  it('PASSWORD_RESOLVED for an unknown requestId is a no-op', () => {
    let state = bashCard(initState(), 'bash-1');
    state = dispatch(state, { type: 'PASSWORD_REQUEST', sessionId: SESSION, requestId: 'req-1', toolUseId: 'bash-1', command: 'apt update' });
    const before = state;
    state = dispatch(state, { type: 'PASSWORD_RESOLVED', sessionId: SESSION, requestId: 'not-this-one' });
    expect(state).toBe(before);
    expect(state.get(SESSION)!.toolCalls.get('bash-1')!.passwordAsk).toBeDefined();
  });

  it('does nothing when the named toolUseId has no card yet (never fabricates one)', () => {
    const state = initState();
    const next = dispatch(state, { type: 'PASSWORD_REQUEST', sessionId: SESSION, requestId: 'req-1', toolUseId: 'bash-1', command: 'apt update' });
    expect(next).toBe(state);
    expect(next.get(SESSION)!.toolCalls.has('bash-1')).toBe(false);
  });
});

describe('PASSWORD_REQUEST / PASSWORD_RESOLVED — nested under a specialist\'s Task card', () => {
  it('sets passwordAsk on the CHILD\'s own segment inside the Task card, not a top-level card', () => {
    let state = seedTaskCard(initState());
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE', sessionId: SESSION, uuid: 'uuid-child-bash', toolUseId: 'child-bash-1',
      toolName: 'Bash', toolInput: { command: 'apt update' }, parentAgentToolUseId: TASK_ID,
    });
    state = dispatch(state, {
      type: 'PASSWORD_REQUEST', sessionId: SESSION, requestId: 'req-1', toolUseId: 'child-bash-1',
      command: 'apt update', specialist: { childId: CHILD_ID, agentType: 'worker', title: 'Wren', parentToolCallId: TASK_ID },
    });

    const card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    expect(card.passwordAsk).toBeUndefined(); // never on the Task card itself
    const seg = card.subagentSegments!.find((s) => s.type === 'tool' && s.toolUseId === 'child-bash-1') as any;
    expect(seg.passwordAsk).toEqual({ requestId: 'req-1', command: 'apt update' });
  });

  it('a repeat for the nested segment is a heartbeat no-op', () => {
    let state = seedTaskCard(initState());
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE', sessionId: SESSION, uuid: 'uuid-child-bash', toolUseId: 'child-bash-1',
      toolName: 'Bash', toolInput: { command: 'apt update' }, parentAgentToolUseId: TASK_ID,
    });
    const ask: ChatAction = {
      type: 'PASSWORD_REQUEST', sessionId: SESSION, requestId: 'req-1', toolUseId: 'child-bash-1',
      command: 'apt update', specialist: { childId: CHILD_ID, agentType: 'worker', title: 'Wren', parentToolCallId: TASK_ID },
    };
    state = dispatch(state, ask);
    const settled = state;
    state = dispatch(state, ask);
    expect(state).toBe(settled);
  });

  it('PASSWORD_RESOLVED clears the nested segment\'s field', () => {
    let state = seedTaskCard(initState());
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE', sessionId: SESSION, uuid: 'uuid-child-bash', toolUseId: 'child-bash-1',
      toolName: 'Bash', toolInput: { command: 'apt update' }, parentAgentToolUseId: TASK_ID,
    });
    state = dispatch(state, {
      type: 'PASSWORD_REQUEST', sessionId: SESSION, requestId: 'req-1', toolUseId: 'child-bash-1',
      command: 'apt update', specialist: { childId: CHILD_ID, agentType: 'worker', title: 'Wren', parentToolCallId: TASK_ID },
    });
    state = dispatch(state, { type: 'PASSWORD_RESOLVED', sessionId: SESSION, requestId: 'req-1' });
    const card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    const seg = card.subagentSegments!.find((s) => s.type === 'tool' && s.toolUseId === 'child-bash-1') as any;
    expect(seg.passwordAsk).toBeUndefined();
  });

  it('falls back to a top-level card carrying the specialist label when no Task card/segment exists yet', () => {
    let state = bashCard(initState(), 'child-bash-1');
    state = dispatch(state, {
      type: 'PASSWORD_REQUEST', sessionId: SESSION, requestId: 'req-1', toolUseId: 'child-bash-1',
      command: 'apt update', specialist: { childId: 'child-x', agentType: 'worker', title: 'Wren', parentToolCallId: 'task-not-loaded' },
    });
    const tool = state.get(SESSION)!.toolCalls.get('child-bash-1')!;
    expect(tool.passwordAsk).toEqual({ requestId: 'req-1', command: 'apt update' });
    expect(tool.specialist?.title).toBe('Wren');
  });
});

describe('hook-dispatcher — PasswordRequest / PasswordResolved payload shapes', () => {
  const event = (type: string, payload: Record<string, unknown>): HookEvent => ({ type, sessionId: SESSION, payload, timestamp: 1 });

  it('maps a PasswordRequest hook-event to PASSWORD_REQUEST, with no password field ever read', () => {
    const action = hookEventToAction(event('PasswordRequest', {
      _requestId: 'req-1', toolUseId: 'bash-1', command: 'apt update', via: 'install.sh', triesLeft: 2,
    }));
    expect(action).toEqual({
      type: 'PASSWORD_REQUEST', sessionId: SESSION, requestId: 'req-1', toolUseId: 'bash-1',
      command: 'apt update', via: 'install.sh', triesLeft: 2, specialist: undefined,
    });
  });

  it('drops a PasswordRequest missing requestId/toolUseId/command', () => {
    expect(hookEventToAction(event('PasswordRequest', { toolUseId: 'bash-1', command: 'x' }))).toBeNull();
    expect(hookEventToAction(event('PasswordRequest', { _requestId: 'r', command: 'x' }))).toBeNull();
    expect(hookEventToAction(event('PasswordRequest', { _requestId: 'r', toolUseId: 'bash-1' }))).toBeNull();
  });

  it('degrades an malformed specialist field to unlabelled rather than crashing', () => {
    const action = hookEventToAction(event('PasswordRequest', {
      _requestId: 'req-1', toolUseId: 'bash-1', command: 'apt update', specialist: { not: 'a childId' },
    }));
    expect((action as any)?.specialist).toBeUndefined();
  });

  it('maps a PasswordResolved hook-event to PASSWORD_RESOLVED', () => {
    expect(hookEventToAction(event('PasswordResolved', { _requestId: 'req-1' }))).toEqual({
      type: 'PASSWORD_RESOLVED', sessionId: SESSION, requestId: 'req-1',
    });
  });

  it('drops a PasswordResolved missing requestId', () => {
    expect(hookEventToAction(event('PasswordResolved', {}))).toBeNull();
  });
});
