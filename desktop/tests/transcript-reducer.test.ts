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
    expect(session.timeline[1].kind).toBe('assistant-turn');
    if (session.timeline[1].kind === 'assistant-turn') {
      const turn = session.assistantTurns.get(session.timeline[1].turnId);
      expect(turn).toBeDefined();
      expect(turn!.segments).toHaveLength(1);
      expect(turn!.segments[0].type).toBe('text');
      if (turn!.segments[0].type === 'text') {
        expect(turn!.segments[0].content).toBe('Hi there!');
      }
    }
    // isThinking should remain true — turn hasn't completed
    expect(session.isThinking).toBe(true);
  });

  // --- Test 3: TRANSCRIPT_TOOL_USE creates a tool group within an assistant turn ---
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
    // Timeline should have user message + assistant-turn (containing the tool group)
    expect(session.timeline).toHaveLength(2);
    expect(session.timeline[1].kind).toBe('assistant-turn');

    // Tool should be in toolCalls map with status running
    const tool = session.toolCalls.get('tool-1');
    expect(tool).toBeDefined();
    expect(tool!.toolName).toBe('Read');
    expect(tool!.status).toBe('running');
    expect(tool!.input).toEqual({ file_path: '/tmp/test.ts' });

    // The assistant turn should contain a tool-group segment
    if (session.timeline[1].kind === 'assistant-turn') {
      const turn = session.assistantTurns.get(session.timeline[1].turnId);
      expect(turn).toBeDefined();
      const toolGroupSeg = turn!.segments.find(s => s.type === 'tool-group');
      expect(toolGroupSeg).toBeDefined();
      if (toolGroupSeg?.type === 'tool-group') {
        const group = session.toolGroups.get(toolGroupSeg.groupId);
        expect(group).toBeDefined();
        expect(group!.toolIds).toContain('tool-1');
      }
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
      stopReason: null,
      model: null,
      anthropicRequestId: null,
      usage: null,
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

    // Timeline should have: user, assistant-turn (all segments inside the turn)
    expect(session.timeline).toHaveLength(2);
    expect(session.timeline[0].kind).toBe('user');
    expect(session.timeline[1].kind).toBe('assistant-turn');

    // The assistant turn should contain: tool-group, text, tool-group segments
    if (session.timeline[1].kind === 'assistant-turn') {
      const turn = session.assistantTurns.get(session.timeline[1].turnId);
      expect(turn).toBeDefined();
      const toolGroupSegs = turn!.segments.filter(s => s.type === 'tool-group');
      expect(toolGroupSegs).toHaveLength(2);
      // The two tool groups should be different
      if (toolGroupSegs[0].type === 'tool-group' && toolGroupSegs[1].type === 'tool-group') {
        expect(toolGroupSegs[0].groupId).not.toBe(toolGroupSegs[1].groupId);
      }
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

  // --- Test 10: Rapid-fire identical USER_PROMPTs — each gets its own bubble ---
  // Regression: old content-based dedup scanned the last 10 timeline entries
  // and silently suppressed any USER_PROMPT whose content matched a prior
  // user message. Sending "yes" twice meant the second "yes" vanished.
  // New behavior: USER_PROMPT always appends. Dedup is by pending/confirmed,
  // not by content-match.
  it('USER_PROMPT dispatched twice with same content creates TWO distinct timeline entries', () => {
    state = dispatch(state, {
      type: 'USER_PROMPT',
      sessionId: SESSION,
      content: 'yes',
      timestamp: 1000,
    });
    state = dispatch(state, {
      type: 'USER_PROMPT',
      sessionId: SESSION,
      content: 'yes',
      timestamp: 1100,
    });

    const session = state.get(SESSION)!;
    const userEntries = session.timeline.filter((e) => e.kind === 'user');
    expect(userEntries).toHaveLength(2);
  });

  // --- Test 11: transcript confirms each pending entry individually ---
  // With the new pattern, each TRANSCRIPT_USER_MESSAGE consumes the OLDEST
  // matching pending entry. Two rapid sends + two transcript events = two
  // confirmed bubbles, no duplicates.
  it('TRANSCRIPT_USER_MESSAGE confirms pending entries one-by-one without adding duplicates', () => {
    state = dispatch(state, {
      type: 'USER_PROMPT',
      sessionId: SESSION,
      content: 'yes',
      timestamp: 1000,
    });
    state = dispatch(state, {
      type: 'USER_PROMPT',
      sessionId: SESSION,
      content: 'yes',
      timestamp: 1100,
    });

    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'uuid-1',
      text: 'yes',
      timestamp: 1050,
    });
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'uuid-2',
      text: 'yes',
      timestamp: 1150,
    });

    const session = state.get(SESSION)!;
    const userEntries = session.timeline.filter((e) => e.kind === 'user');
    expect(userEntries).toHaveLength(2);
  });

  // --- Test 12: transcript arrives without a pending match → append new ---
  // Remote/replay path: TRANSCRIPT_USER_MESSAGE fires without a prior optimistic
  // USER_PROMPT (e.g. viewer-only client, or user typed straight in terminal).
  // Should add a new timeline entry, not silently drop it.
  it('TRANSCRIPT_USER_MESSAGE appends a new entry when no matching pending entry exists', () => {
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'uuid-remote',
      text: 'hello from remote',
      timestamp: 1000,
    });

    const session = state.get(SESSION)!;
    const userEntries = session.timeline.filter((e) => e.kind === 'user');
    expect(userEntries).toHaveLength(1);
    if (userEntries[0].kind === 'user') {
      expect(userEntries[0].message.content).toBe('hello from remote');
    }
  });
});
