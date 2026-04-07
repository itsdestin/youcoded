import { describe, it, expect, beforeEach } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { ChatState, ChatAction, createSessionChatState } from '../src/renderer/state/chat-types';

const SESSION = 'test-session';

function initState(): ChatState {
  const state: ChatState = new Map();
  return chatReducer(state, { type: 'SESSION_INIT', sessionId: SESSION });
}

function dispatch(state: ChatState, action: ChatAction): ChatState {
  return chatReducer(state, action);
}

describe('TRANSCRIPT_* reducer actions', () => {
  let state: ChatState;

  beforeEach(() => {
    state = initState();
  });

  // --- Test 1: TRANSCRIPT_USER_MESSAGE adds a user bubble and sets isThinking ---
  it('TRANSCRIPT_USER_MESSAGE adds a user bubble and sets isThinking', () => {
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'uuid-1',
      text: 'Hello Claude',
      timestamp: 1000,
    });

    const session = state.get(SESSION)!;
    expect(session.timeline).toHaveLength(1);
    expect(session.timeline[0].kind).toBe('user');
    if (session.timeline[0].kind === 'user') {
      expect(session.timeline[0].message.content).toBe('Hello Claude');
      expect(session.timeline[0].message.timestamp).toBe(1000);
    }
    expect(session.isThinking).toBe(true);
    expect(session.currentGroupId).toBeNull();
  });

  // --- Test 2: TRANSCRIPT_ASSISTANT_TEXT adds an assistant bubble (isThinking stays true) ---
  it('TRANSCRIPT_ASSISTANT_TEXT adds an assistant bubble (isThinking stays true)', () => {
    // Send user message first to set isThinking
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'uuid-1',
      text: 'Hello',
      timestamp: 1000,
    });

    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT',
      sessionId: SESSION,
      uuid: 'uuid-2',
      text: 'Hi there!',
      timestamp: 1001,
    });

    const session = state.get(SESSION)!;
    expect(session.timeline).toHaveLength(2);
    expect(session.timeline[1].kind).toBe('assistant');
    if (session.timeline[1].kind === 'assistant') {
      expect(session.timeline[1].message.content).toBe('Hi there!');
    }
    // isThinking should remain true — turn hasn't completed
    expect(session.isThinking).toBe(true);
  });

  // --- Test 3: TRANSCRIPT_TOOL_USE creates a tool group with a running tool ---
  it('TRANSCRIPT_TOOL_USE creates a tool group with a running tool', () => {
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'uuid-1',
      text: 'Read a file',
      timestamp: 1000,
    });

    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: SESSION,
      uuid: 'uuid-2',
      toolUseId: 'tool-1',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/test.ts' },
    });

    const session = state.get(SESSION)!;
    // Timeline should have user message + tool group
    expect(session.timeline).toHaveLength(2);
    expect(session.timeline[1].kind).toBe('tool-group');

    // Tool should be in toolCalls map with status running
    const tool = session.toolCalls.get('tool-1');
    expect(tool).toBeDefined();
    expect(tool!.toolName).toBe('Read');
    expect(tool!.status).toBe('running');
    expect(tool!.input).toEqual({ file_path: '/tmp/test.ts' });

    // Tool group should exist and contain the tool
    if (session.timeline[1].kind === 'tool-group') {
      const group = session.toolGroups.get(session.timeline[1].groupId);
      expect(group).toBeDefined();
      expect(group!.toolIds).toContain('tool-1');
    }
  });

  // --- Test 4: TRANSCRIPT_TOOL_RESULT completes a tool ---
  it('TRANSCRIPT_TOOL_RESULT completes a tool (status -> complete, stores response)', () => {
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'uuid-1',
      text: 'Read a file',
      timestamp: 1000,
    });

    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: SESSION,
      uuid: 'uuid-2',
      toolUseId: 'tool-1',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/test.ts' },
    });

    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_RESULT',
      sessionId: SESSION,
      uuid: 'uuid-3',
      toolUseId: 'tool-1',
      result: 'File contents here',
      isError: false,
    });

    const session = state.get(SESSION)!;
    const tool = session.toolCalls.get('tool-1');
    expect(tool).toBeDefined();
    expect(tool!.status).toBe('complete');
    expect(tool!.response).toBe('File contents here');
  });

  // --- Test 5: TRANSCRIPT_TOOL_RESULT with isError marks tool as failed ---
  it('TRANSCRIPT_TOOL_RESULT with isError: true marks tool as failed', () => {
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'uuid-1',
      text: 'Read a file',
      timestamp: 1000,
    });

    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: SESSION,
      uuid: 'uuid-2',
      toolUseId: 'tool-1',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/nope.ts' },
    });

    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_RESULT',
      sessionId: SESSION,
      uuid: 'uuid-3',
      toolUseId: 'tool-1',
      result: 'File not found',
      isError: true,
    });

    const session = state.get(SESSION)!;
    const tool = session.toolCalls.get('tool-1');
    expect(tool).toBeDefined();
    expect(tool!.status).toBe('failed');
    expect(tool!.error).toBe('File not found');
  });

  // --- Test 6: TRANSCRIPT_TURN_COMPLETE clears isThinking ---
  it('TRANSCRIPT_TURN_COMPLETE clears isThinking', () => {
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'uuid-1',
      text: 'Hello',
      timestamp: 1000,
    });

    expect(state.get(SESSION)!.isThinking).toBe(true);

    state = dispatch(state, {
      type: 'TRANSCRIPT_TURN_COMPLETE',
      sessionId: SESSION,
      uuid: 'uuid-done',
      timestamp: 2000,
    });

    const session = state.get(SESSION)!;
    expect(session.isThinking).toBe(false);
    expect(session.streamingText).toBe('');
    expect(session.currentGroupId).toBeNull();
  });

  // --- Test 7: TRANSCRIPT_ASSISTANT_TEXT after a completed tool group resets currentGroupId ---
  it('TRANSCRIPT_ASSISTANT_TEXT after completed tool group resets currentGroupId so next tool starts new group', () => {
    // User message
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'uuid-1',
      text: 'Do two things',
      timestamp: 1000,
    });

    // First tool use — creates group 1
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: SESSION,
      uuid: 'uuid-2',
      toolUseId: 'tool-1',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/a.ts' },
    });

    const groupId1 = state.get(SESSION)!.currentGroupId;
    expect(groupId1).not.toBeNull();

    // Complete the tool
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_RESULT',
      sessionId: SESSION,
      uuid: 'uuid-3',
      toolUseId: 'tool-1',
      result: 'ok',
      isError: false,
    });

    // Assistant text between tool groups — this should reset currentGroupId
    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT',
      sessionId: SESSION,
      uuid: 'uuid-4',
      text: 'Now let me do the second thing.',
      timestamp: 1002,
    });

    expect(state.get(SESSION)!.currentGroupId).toBeNull();

    // Second tool use — should create a NEW group
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: SESSION,
      uuid: 'uuid-5',
      toolUseId: 'tool-2',
      toolName: 'Write',
      toolInput: { file_path: '/tmp/b.ts', content: 'hello' },
    });

    const session = state.get(SESSION)!;
    const groupId2 = session.currentGroupId;
    expect(groupId2).not.toBeNull();
    expect(groupId2).not.toBe(groupId1);

    // Timeline should have: user, group1, assistant, group2
    expect(session.timeline).toHaveLength(4);
    expect(session.timeline[0].kind).toBe('user');
    expect(session.timeline[1].kind).toBe('tool-group');
    expect(session.timeline[2].kind).toBe('assistant');
    expect(session.timeline[3].kind).toBe('tool-group');

    // The two groups should be different
    if (session.timeline[1].kind === 'tool-group' && session.timeline[3].kind === 'tool-group') {
      expect(session.timeline[1].groupId).not.toBe(session.timeline[3].groupId);
    }
  });

  // --- Test 9: TRANSCRIPT_USER_MESSAGE deduplicates against optimistic USER_PROMPT ---
  it('TRANSCRIPT_USER_MESSAGE deduplicates against optimistic USER_PROMPT from InputBar', () => {
    // Simulate InputBar sending USER_PROMPT first (optimistic)
    state = dispatch(state, {
      type: 'USER_PROMPT',
      sessionId: SESSION,
      content: 'Hello Claude',
      timestamp: 1000,
    });

    expect(state.get(SESSION)!.timeline).toHaveLength(1);
    expect(state.get(SESSION)!.isThinking).toBe(true);

    // Now transcript watcher fires TRANSCRIPT_USER_MESSAGE with same content
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'uuid-1',
      text: 'Hello Claude',
      timestamp: 1001,
    });

    const session = state.get(SESSION)!;
    // Should NOT add a second user message — the optimistic one is already there
    expect(session.timeline).toHaveLength(1);
    expect(session.isThinking).toBe(true);
  });
});
