import { describe, it, expect, beforeEach } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { ChatState, ChatAction, createSessionChatState } from '../src/renderer/state/chat-types';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import type { TranscriptEvent, DataOf } from '../src/shared/types';
import { ev as mkEv } from './helpers/transcript-events';

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
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1,
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
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1,
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
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1,
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
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1,
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
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1,
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

describe('Subagent threading', () => {
  let state: ChatState;

  beforeEach(() => {
    state = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: SESSION });
  });

  function emitParentAgentToolUse(): ChatState {
    return chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1,
      sessionId: SESSION,
      uuid: 'uuid-parent',
      toolUseId: 'toolu_parent',
      toolName: 'Agent',
      toolInput: { description: 'Find bug', subagent_type: 'Explore', prompt: 'go' },
    });
  }

  it('subagent tool_use appends a subagent segment to the parent Agent tool', () => {
    state = emitParentAgentToolUse();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1,
      sessionId: SESSION,
      uuid: 'uuid-s1',
      toolUseId: 'toolu_child',
      toolName: 'Read',
      toolInput: { file_path: '/a' },
      parentAgentToolUseId: 'toolu_parent',
      agentId: 'abc',
    });

    const session = state.get(SESSION)!;
    const parent = session.toolCalls.get('toolu_parent')!;
    expect(parent.subagentSegments).toBeDefined();
    expect(parent.subagentSegments!.length).toBe(1);
    const seg = parent.subagentSegments![0];
    expect(seg.type).toBe('tool');
    if (seg.type === 'tool') {
      expect(seg.toolUseId).toBe('toolu_child');
      expect(seg.toolName).toBe('Read');
      expect(seg.status).toBe('running');
    }
    expect(session.toolCalls.has('toolu_child')).toBe(false);
    expect(session.activeTurnToolIds.has('toolu_child')).toBe(false);
  });

  it('subagent tool_result flips the matching segment to complete', () => {
    state = emitParentAgentToolUse();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: SESSION, uuid: 'uuid-s1',
      toolUseId: 'toolu_child', toolName: 'Read', toolInput: {},
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_RESULT', sessionId: SESSION, uuid: 'uuid-s2',
      toolUseId: 'toolu_child', result: 'file contents', isError: false,
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });

    const parent = state.get(SESSION)!.toolCalls.get('toolu_parent')!;
    const seg = parent.subagentSegments![0];
    expect(seg.type).toBe('tool');
    if (seg.type === 'tool') {
      expect(seg.status).toBe('complete');
      expect(seg.response).toBe('file contents');
    }
  });

  it('subagent assistant text appends a text segment', () => {
    state = emitParentAgentToolUse();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'uuid-s1',
      text: "I'll check the Android side.",
      timestamp: 1000,
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });
    const parent = state.get(SESSION)!.toolCalls.get('toolu_parent')!;
    expect(parent.subagentSegments!.length).toBe(1);
    const seg = parent.subagentSegments![0];
    expect(seg.type).toBe('text');
    if (seg.type === 'text') expect(seg.content).toBe("I'll check the Android side.");
  });

  // Fix: the native harness (harness-session.ts:1769) emits one assistant-text
  // event per stream delta rather than per whole message, so without
  // coalescing a specialist's report rendered as hundreds of separate
  // markdown blocks. Same-partId deltas must merge into ONE segment.
  it('subagent assistant text deltas sharing a partId coalesce into one segment', () => {
    state = emitParentAgentToolUse();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'uuid-d1',
      text: 'The bug is ', timestamp: 1000, partId: 'part-1',
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'uuid-d2',
      text: 'in the Android build.', timestamp: 1001, partId: 'part-1',
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });
    const parent = state.get(SESSION)!.toolCalls.get('toolu_parent')!;
    expect(parent.subagentSegments!.length).toBe(1);
    const seg = parent.subagentSegments![0];
    expect(seg.type).toBe('text');
    if (seg.type === 'text') {
      expect(seg.content).toBe('The bug is in the Android build.');
    }
  });

  it('subagent assistant text with different partIds stays as separate segments', () => {
    state = emitParentAgentToolUse();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'uuid-d1',
      text: 'First delta.', timestamp: 1000, partId: 'part-1',
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'uuid-d2',
      text: 'Second block.', timestamp: 1001, partId: 'part-2',
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });
    const parent = state.get(SESSION)!.toolCalls.get('toolu_parent')!;
    expect(parent.subagentSegments!.length).toBe(2);
    expect(parent.subagentSegments![0].type).toBe('text');
    expect(parent.subagentSegments![1].type).toBe('text');
    if (parent.subagentSegments![0].type === 'text') {
      expect(parent.subagentSegments![0].content).toBe('First delta.');
    }
    if (parent.subagentSegments![1].type === 'text') {
      expect(parent.subagentSegments![1].content).toBe('Second block.');
    }
  });

  it('subagent event for unknown parent is a no-op', () => {
    const before = state;
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: SESSION, uuid: 'uuid-s1',
      toolUseId: 'toolu_child', toolName: 'Read', toolInput: {},
      parentAgentToolUseId: 'toolu_nonexistent', agentId: 'abc',
    });
    expect(state).toBe(before);
  });

  it('subagent events do not touch activeTurnToolIds or toolGroups', () => {
    state = emitParentAgentToolUse();
    const beforeSession = state.get(SESSION)!;
    const activeIdsBefore = new Set(beforeSession.activeTurnToolIds);
    const groupsBefore = new Map(beforeSession.toolGroups);

    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: SESSION, uuid: 'uuid-s1',
      toolUseId: 'toolu_child', toolName: 'Read', toolInput: {},
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });

    const afterSession = state.get(SESSION)!;
    expect(afterSession.activeTurnToolIds).toEqual(activeIdsBefore);
    expect(afterSession.toolGroups.size).toBe(groupsBefore.size);
  });

  it('duplicate subagent tool_use for same toolUseId updates in place (no duplicate segment)', () => {
    state = emitParentAgentToolUse();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: SESSION, uuid: 'uuid-s1',
      toolUseId: 'toolu_child', toolName: 'Read', toolInput: {},
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: SESSION, uuid: 'uuid-s1',
      toolUseId: 'toolu_child', toolName: 'Read', toolInput: { file_path: '/updated' },
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });
    const parent = state.get(SESSION)!.toolCalls.get('toolu_parent')!;
    expect(parent.subagentSegments!.length).toBe(1);
  });

  it('subagent tool_result with isError:true flips segment to failed', () => {
    state = emitParentAgentToolUse();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: SESSION, uuid: 'uuid-s1',
      toolUseId: 'toolu_child', toolName: 'Read', toolInput: {},
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_RESULT', sessionId: SESSION, uuid: 'uuid-s2',
      toolUseId: 'toolu_child', result: 'ENOENT: no such file', isError: true,
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });
    const parent = state.get(SESSION)!.toolCalls.get('toolu_parent')!;
    const seg = parent.subagentSegments![0];
    expect(seg.type).toBe('tool');
    if (seg.type === 'tool') {
      expect(seg.status).toBe('failed');
      expect(seg.error).toBe('ENOENT: no such file');
      expect(seg.response).toBeUndefined();
    }
  });

  it('subagent tool_result carries structuredPatch onto the segment', () => {
    state = emitParentAgentToolUse();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: SESSION, uuid: 'uuid-s1',
      toolUseId: 'toolu_child', toolName: 'Edit',
      toolInput: { file_path: '/a', old_string: 'x', new_string: 'y' },
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });
    const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [' x', '-y', '+z'] }];
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_RESULT', sessionId: SESSION, uuid: 'uuid-s2',
      toolUseId: 'toolu_child', result: 'edited', isError: false,
      structuredPatch: patch,
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });
    const parent = state.get(SESSION)!.toolCalls.get('toolu_parent')!;
    const seg = parent.subagentSegments![0];
    expect(seg.type).toBe('tool');
    if (seg.type === 'tool') {
      expect(seg.status).toBe('complete');
      expect(seg.structuredPatch).toEqual(patch);
    }
  });

  it('interleaved subagent text and tool segments preserve order', () => {
    state = emitParentAgentToolUse();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'uuid-t1',
      text: 'First thought', timestamp: 1000,
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1000, sessionId: SESSION, uuid: 'uuid-tool1',
      toolUseId: 'toolu_mid', toolName: 'Read', toolInput: {},
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'uuid-t2',
      text: 'Second thought', timestamp: 1001,
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });
    const parent = state.get(SESSION)!.toolCalls.get('toolu_parent')!;
    expect(parent.subagentSegments!.length).toBe(3);
    expect(parent.subagentSegments![0].type).toBe('text');
    expect(parent.subagentSegments![1].type).toBe('tool');
    expect(parent.subagentSegments![2].type).toBe('text');
  });

  // Task 9 fix (external review, 2026-08-13): getHistory() has no guard
  // against being called twice against an already-populated reducer state —
  // a live re-dock re-sends the SAME stamped events off disk, not just a
  // post-restart resume. Replaying the identical delta twice must not
  // duplicate the text it produced the first time.
  it('replaying the same subagent assistant-text delta twice does not duplicate the segment content', () => {
    state = emitParentAgentToolUse();
    const deliver = (s: ChatState) => chatReducer(s, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'uuid-report',
      text: 'The bug is in the Android build.', timestamp: 1000, partId: 'part-1',
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });
    state = deliver(state);
    state = deliver(state); // second delivery of the SAME event (identical uuid) — replay-twice
    const parent = state.get(SESSION)!.toolCalls.get('toolu_parent')!;
    expect(parent.subagentSegments!.length).toBe(1);
    const seg = parent.subagentSegments![0];
    expect(seg.type).toBe('text');
    if (seg.type === 'text') expect(seg.content).toBe('The bug is in the Android build.');
  });

  it('replaying a multi-delta subagent report twice reproduces the same final text exactly once', () => {
    state = emitParentAgentToolUse();
    const events: ChatAction[] = [
      {
        type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'uuid-d1',
        text: 'The bug is ', timestamp: 1000, partId: 'part-1',
        parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
      },
      {
        type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'uuid-d2',
        text: 'in the Android build.', timestamp: 1001, partId: 'part-1',
        parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
      },
    ];
    const replay = (s: ChatState) => events.reduce((acc, ev) => chatReducer(acc, ev), s);
    state = replay(state); // first replay (e.g. getHistory() after a restart)
    state = replay(state); // second replay (e.g. a live re-dock) — the SAME stamped events again
    const parent = state.get(SESSION)!.toolCalls.get('toolu_parent')!;
    expect(parent.subagentSegments!.length).toBe(1);
    const seg = parent.subagentSegments![0];
    expect(seg.type).toBe('text');
    if (seg.type === 'text') expect(seg.content).toBe('The bug is in the Android build.');
  });

  it('CLEAR_TIMELINE preserves subagentSegments on toolCalls entries', () => {
    state = emitParentAgentToolUse();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: SESSION, uuid: 'uuid-s1',
      toolUseId: 'toolu_child', toolName: 'Read', toolInput: {},
      parentAgentToolUseId: 'toolu_parent', agentId: 'abc',
    });
    state = chatReducer(state, {
      type: 'CLEAR_TIMELINE', sessionId: SESSION, markerId: 'm1', timestamp: 1000,
    });
    const session = state.get(SESSION)!;
    const parent = session.toolCalls.get('toolu_parent')!;
    expect(parent.subagentSegments!.length).toBe(1);
  });

  // Regression: a sub-agent's end_turn was reaching into parent state because
  // TRANSCRIPT_TURN_COMPLETE lacked the parentAgentToolUseId guard that the
  // other three transcript handlers have. The visible symptom was the
  // status-bar model pill flipping to the sub-agent's model mid-turn (and the
  // drift-reconciliation effect persisting it via setPreference).
  it('subagent TRANSCRIPT_TURN_COMPLETE does not pollute parent turn.model or call endTurn', () => {
    // User sent a prompt — isThinking flips to true.
    state = chatReducer(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'uuid-user',
      text: 'Run an agent for me',
      timestamp: 999,
    });
    // Parent emits assistant text on its own turn so turn.model is set to the
    // parent's model (opus), then dispatches the Agent tool_use.
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT',
      sessionId: SESSION,
      uuid: 'uuid-parent-text',
      text: 'Dispatching an agent…',
      timestamp: 1000,
      model: 'claude-opus-4-7',
    });
    state = emitParentAgentToolUse();

    const parentTurnId = state.get(SESSION)!.currentTurnId!;
    expect(parentTurnId).not.toBeNull();
    expect(state.get(SESSION)!.assistantTurns.get(parentTurnId)!.model).toBe('claude-opus-4-7');
    expect(state.get(SESSION)!.isThinking).toBe(true);

    // Sub-agent's final assistant message: parseTranscriptLine emits a
    // turn-complete event, SubagentWatcher stamps it with parentAgentToolUseId.
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TURN_COMPLETE',
      sessionId: SESSION,
      uuid: 'uuid-subagent-done',
      timestamp: 2000,
      stopReason: 'end_turn',
      model: 'claude-haiku-4-5-20251001',
      anthropicRequestId: 'req_subagent',
      usage: null,
      parentAgentToolUseId: 'toolu_parent',
      agentId: 'abc',
    });

    const session = state.get(SESSION)!;
    // Parent turn.model must remain the parent's model — the drift-reconciliation
    // effect in App.tsx walks back to find this value and would silently flip
    // (and persist) the status-bar pill if the sub-agent's model leaked through.
    expect(session.assistantTurns.get(parentTurnId)!.model).toBe('claude-opus-4-7');
    expect(session.assistantTurns.get(parentTurnId)!.stopReason).toBeNull();
    expect(session.assistantTurns.get(parentTurnId)!.anthropicRequestId).toBeNull();
    // endTurn() must NOT have run — parent is still in-flight running the agent.
    expect(session.currentTurnId).toBe(parentTurnId);
    expect(session.isThinking).toBe(true);
    // The parent's Task tool must not have been flipped to 'failed: Turn ended'.
    expect(session.toolCalls.get('toolu_parent')!.status).not.toBe('failed');
  });
});

// The main window and the buddy window both translate a native heartbeat through
// eventToAction (state/transcript-event-actions.ts), so a field added there reaches
// both. This pins that each watchdog field actually lands on the action, for the
// two option sets the two windows use.
describe('native heartbeat forwarding is shared by both windows', () => {
  const ev = (data: DataOf<'assistant-thinking'>) =>
    mkEv('assistant-thinking', data, { sessionId: 's', uuid: 'u', timestamp: 1 });
  const WINDOWS = {
    'main window': { live: true, compactionPending: false, fallbackContextTokens: 5 },
    'buddy window': { live: true, compactionPending: false, fallbackContextTokens: null },
  };

  for (const [name, opts] of Object.entries(WINDOWS)) {
    it(`${name} forwards stallWarning`, () => {
      const stallWarning = { retryInMs: 5, willRetry: true };
      expect(eventToAction(ev({ stallWarning }), opts)).toContainEqual(expect.objectContaining({ type: 'TRANSCRIPT_THINKING_HEARTBEAT', stallWarning }));
    });
    it(`${name} forwards stalled`, () => {
      expect(eventToAction(ev({ stalled: true }), opts)).toContainEqual(expect.objectContaining({ type: 'TRANSCRIPT_THINKING_HEARTBEAT', stalled: true }));
    });
    it(`${name} forwards dropPart, ahead of the heartbeat`, () => {
      const types = eventToAction(ev({ dropPart: { partIds: ['p'] } }), opts).map((a) => a.type);
      expect(types).toEqual(['NATIVE_PARTS_DROPPED', 'TRANSCRIPT_THINKING_HEARTBEAT']);
    });
  }

  // A history page keeps the saved marker (it used to return nothing, so a reopened
  // conversation showed the discarded retry text) but never the live-only heartbeat.
  it('a history page forwards dropPart and drops the heartbeat', () => {
    const types = eventToAction(ev({ dropPart: { partIds: ['p'] } }), { live: false }).map((a) => a.type);
    expect(types).toEqual(['NATIVE_PARTS_DROPPED']);
  });
});
