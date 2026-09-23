import { describe, it, expect, beforeEach, vi } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { ChatState, ChatAction, serializeChatState, deserializeChatState } from '../src/renderer/state/chat-types';
import { hookEventToAction } from '../src/renderer/state/hook-dispatcher';
import { selectNativeStatusChips } from '../src/renderer/components/StatusBar';
import type { HookEvent } from '../src/shared/types';

const SESSION = 'test-session';

function initState(): ChatState {
  const state: ChatState = new Map();
  return chatReducer(state, { type: 'SESSION_INIT', sessionId: SESSION });
}

function dispatch(state: ChatState, action: ChatAction): ChatState {
  return chatReducer(state, action);
}

describe('transient native usage progress', () => {
  const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 });
  const heartbeat = (sessionId: string, inputTokens: number, timestamp: number, uuid: string): ChatAction => ({
    type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId, usageProgress: usage(inputTokens), timestamp, uuid,
  });

  it.each(['/compact', '/clear'] as const)('lets measured progress replace the %s context override, but preserves it for usage-silent progress', (command) => {
    let s = dispatch(initState(), { type: 'NATIVE_HISTORY_REWRITTEN', sessionId: SESSION,
      uuid: `rewrite-${command}`, contextUsedTokens: 0 });
    const chips = () => selectNativeStatusChips(s.get(SESSION)!.inProgressUsage, 1000, s.get(SESSION)!.contextUsedOverride);
    s = dispatch(s, { type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: SESSION, timestamp: 100, uuid: 'silent',
      usageProgress: { ...usage(20), liveProgress: true } });
    expect(s.get(SESSION)!.contextUsedOverride).toBe(0);
    expect(chips()?.contextUsedTokens).toBe(0);
    s = dispatch(s, { type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: SESSION, timestamp: 101, uuid: 'measured',
      usageProgress: { ...usage(30), liveProgress: true, contextUsedTokens: 400 } });
    expect(s.get(SESSION)!.contextUsedOverride).toBeNull();
    expect(chips()?.contextUsedTokens).toBe(400);
    expect(chips()?.contextPct).toBe(60);
  });

  it('keeps two sessions independent and replaces cumulative progress without durable totals', () => {
    let s = dispatch(initState(), { type: 'SESSION_INIT', sessionId: 'other' });
    s = dispatch(s, heartbeat(SESSION, 10, 100, 'p1'));
    s = dispatch(s, heartbeat('other', 20, 101, 'p2'));
    s = dispatch(s, heartbeat(SESSION, 30, 102, 'p3'));
    expect(s.get(SESSION)!.inProgressUsage).toEqual(usage(30));
    expect(s.get('other')!.inProgressUsage).toEqual(usage(20));
    expect(s.get(SESSION)!.totals).toEqual(initState().get(SESSION)!.totals);
    expect(JSON.stringify(serializeChatState(s))).not.toContain('inProgressUsage');
    expect(deserializeChatState(serializeChatState(s)).get(SESSION)!.inProgressUsage).toBeNull();
  });

  it('clears measured progress on completion interruption and error', () => {
    for (const terminal of [
      { type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: SESSION, uuid: 'end', timestamp: 201, stopReason: null, model: null, anthropicRequestId: null, usage: null },
      { type: 'TRANSCRIPT_INTERRUPT', sessionId: SESSION, uuid: 'end', timestamp: 201 },
      { type: 'NATIVE_SESSION_ERROR', sessionId: SESSION, message: 'failed' },
    ] as ChatAction[]) {
      let s = dispatch(initState(), heartbeat(SESSION, 10, 100, 'p1'));
      s = dispatch(s, terminal);
      expect(s.get(SESSION)!.inProgressUsage).toBeNull();
    }
  });

  it('clears confirmed idle replay but preserves progress for active replay', () => {
    const live = dispatch(initState(), heartbeat(SESSION, 10, 100, 'p1'));
    expect(dispatch(live, { type: 'TRANSCRIPT_REPLAY_COMPLETE', sessionId: SESSION, sessionIdle: false }).get(SESSION)!.inProgressUsage).toEqual(usage(10));
    expect(dispatch(live, { type: 'TRANSCRIPT_REPLAY_COMPLETE', sessionId: SESSION, sessionIdle: true }).get(SESSION)!.inProgressUsage).toBeNull();
  });

  it('fences late attach by host terminal time even when the renderer clock is behind or ahead', () => {
    for (const rendererTime of [1, 999_999]) {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(rendererTime);
      try {
        let s = dispatch(initState(), heartbeat(SESSION, 10, 100, 'old'));
        s = dispatch(s, { type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: SESSION,
          uuid: 'end', timestamp: 110, stopReason: null, model: null, anthropicRequestId: null, usage: null });
        expect(s.get(SESSION)!.usageProgressAt).toBe(110);
        expect(dispatch(s, heartbeat(SESSION, 11, 105, 'late'))).toBe(s);
        // A later host measurement in a new turn must not be blocked by the
        // renderer's unrelated wall clock (even if it reads 999999).
        s = dispatch(s, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SESSION,
          uuid: `user-${rendererTime}`, timestamp: 120, text: 'next' });
        s = dispatch(s, heartbeat(SESSION, 20, 130, 'next-progress'));
        expect(s.get(SESSION)!.inProgressUsage).toEqual(usage(20));
      } finally {
        clock.mockRestore();
      }
    }
  });

  it('fences attach after interrupted and failed turns using their host event stamps', () => {
    for (const terminal of [
      { type: 'TRANSCRIPT_INTERRUPT', sessionId: SESSION, uuid: 'interrupt', timestamp: 200, kind: 'plain' },
      { type: 'NATIVE_SESSION_ERROR', sessionId: SESSION, message: 'failed', timestamp: 200 },
    ] as ChatAction[]) {
      let s = dispatch(initState(), heartbeat(SESSION, 10, 100, 'old'));
      s = dispatch(s, terminal);
      expect(s.get(SESSION)!.inProgressUsage).toBeNull();
      expect(dispatch(s, heartbeat(SESSION, 10, 150, 'late'))).toBe(s);
    }
  });

  it('does not let progress-only late attach dismiss a newer stall, but an ordinary heartbeat clears it', () => {
    let s = dispatch(initState(), heartbeat(SESSION, 10, 100, 'old'));
    s = dispatch(s, { type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: SESSION,
      timestamp: 200, uuid: 'stall', stalled: true, stallWarning: { retryInMs: 5000, willRetry: false } });
    const stalled = s.get(SESSION)!;
    expect(stalled.attentionState).toBe('stalled');
    expect(dispatch(s, heartbeat(SESSION, 15, 150, 'attach'))).toBe(s);
    expect(s.get(SESSION)).toBe(stalled);
    s = dispatch(s, { type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: SESSION, timestamp: 210, uuid: 'resumed' });
    expect(s.get(SESSION)!.attentionState).toBe('ok');
    expect(s.get(SESSION)!.stallWarning).toBeNull();
    expect(s.get(SESSION)!.inProgressUsage).toEqual(usage(10));
  });

  it('rejects stale attach progress and duplicate UUID without changing references', () => {
    let s = dispatch(initState(), heartbeat(SESSION, 30, 102, 'new'));
    expect(dispatch(s, heartbeat(SESSION, 10, 100, 'old'))).toBe(s);
    expect(dispatch(s, heartbeat(SESSION, 99, 103, 'new'))).toBe(s);
    s = dispatch(s, heartbeat(SESSION, 40, 104, 'newer'));
    expect(s.get(SESSION)!.inProgressUsage).toEqual(usage(40));
    s = dispatch(s, { type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: SESSION });
    expect(s.get(SESSION)!.inProgressUsage).toEqual(usage(40));
    s = dispatch(s, { type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: SESSION,
      uuid: 'end', timestamp: 105, stopReason: null, model: null, anthropicRequestId: null, usage: null });
    expect(dispatch(s, heartbeat(SESSION, 30, 102, 'attach')).get(SESSION)!.inProgressUsage).toBeNull();
  });
});

describe('TRANSCRIPT_TURN_COMPLETE metadata', () => {
  let state: ChatState;

  beforeEach(() => {
    state = initState();
  });

  // Verifies Task 2.3: the reducer stamps stopReason/model/usage/anthropicRequestId
  // onto the in-flight turn before endTurn() clears currentTurnId.
  it('stores stopReason/model/usage/anthropicRequestId on the completing turn', () => {
    // Create an in-flight turn by dispatching assistant text. That populates
    // currentTurnId and adds an entry to assistantTurns with null metadata.
    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT',
      sessionId: SESSION,
      uuid: 'uuid-1',
      text: 'Hello from Claude',
      timestamp: 1000,
    });

    const turnId = state.get(SESSION)!.currentTurnId;
    expect(turnId).not.toBeNull();

    // Dispatch turn-complete with all four metadata fields populated.
    state = dispatch(state, {
      type: 'TRANSCRIPT_TURN_COMPLETE',
      sessionId: SESSION,
      uuid: 'uuid-done',
      timestamp: 2000,
      stopReason: 'max_tokens',
      model: 'claude-opus-4-7',
      anthropicRequestId: 'req_abc',
      usage: {
        inputTokens: 10,
        outputTokens: 4096,
        cacheReadTokens: 5,
        cacheCreationTokens: 2,
      },
    });

    const session = state.get(SESSION)!;
    const turn = session.assistantTurns.get(turnId!);
    expect(turn).toBeDefined();
    expect(turn!.stopReason).toBe('max_tokens');
    expect(turn!.model).toBe('claude-opus-4-7');
    expect(turn!.anthropicRequestId).toBe('req_abc');
    expect(turn!.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4096,
      cacheReadTokens: 5,
      cacheCreationTokens: 2,
    });

    // endTurn() still fires: isThinking cleared, currentTurnId reset to null.
    expect(session.isThinking).toBe(false);
    expect(session.currentTurnId).toBeNull();
  });

  // Verifies Task 2.4: the reducer captures the model from the FIRST
  // assistant-text event so the model is visible on in-flight turns
  // (before turn-complete arrives).
  it('sets turn.model on first assistant-text when action carries model', () => {
    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT',
      sessionId: SESSION,
      uuid: 'uuid-text-1',
      text: 'Hello',
      timestamp: 1000,
      model: 'claude-sonnet-4-6',
    });

    const session = state.get(SESSION)!;
    const turnId = session.currentTurnId;
    expect(turnId).not.toBeNull();
    const turn = session.assistantTurns.get(turnId!);
    expect(turn).toBeDefined();
    expect(turn!.model).toBe('claude-sonnet-4-6');
  });

  // Once the turn has a model, a later text chunk without a model must not
  // overwrite it. Guard against clobbering the existing value.
  it('preserves existing turn.model when later assistant-text has no model', () => {
    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT',
      sessionId: SESSION,
      uuid: 'uuid-text-1',
      text: 'Hello',
      timestamp: 1000,
      model: 'claude-sonnet-4-6',
    });
    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT',
      sessionId: SESSION,
      uuid: 'uuid-text-2',
      text: 'More text',
      timestamp: 1100,
    });

    const session = state.get(SESSION)!;
    const turnId = session.currentTurnId!;
    const turn = session.assistantTurns.get(turnId);
    expect(turn!.model).toBe('claude-sonnet-4-6');
  });

  // Defensive path: turn-complete can arrive with no in-flight turn (edge case
  // where the reducer hasn't seen any assistant text yet). Must not throw.
  it('gracefully handles turn-complete with no in-flight turn (no crash)', () => {
    expect(state.get(SESSION)!.currentTurnId).toBeNull();

    expect(() => {
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
    }).not.toThrow();

    const session = state.get(SESSION)!;
    expect(session.isThinking).toBe(false);
    expect(session.currentTurnId).toBeNull();
    expect(session.assistantTurns.size).toBe(0);
  });

  it('reasoning: consecutive REASONING events with same partId merge into one segment', () => {
    // Thinking models (native harness) stream reasoning as per-token deltas
    // carrying a text payload + partId. Same partId → append to one segment
    // (unlike the text path, which appends whole blocks as new segments).
    // Without this, the collapsible reasoning block would render dozens of
    // tiny disclosures per turn.
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r1', text: 'Let me ', timestamp: 1, partId: 'rprt_1' });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r2', text: 'think...', timestamp: 2, partId: 'rprt_1' });

    const turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.length).toBe(1);
    expect(turn.segments[0]).toMatchObject({ type: 'reasoning', content: 'Let me think...', partId: 'rprt_1' });
  });

  it('reasoning: different or missing partIds do NOT merge — each starts a new segment', () => {
    // The don't-over-merge half of the contract: merging is keyed strictly
    // on a matching partId. A new partId means a new reasoning part; an
    // undefined partId can never match, so those events always append.
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r1', text: 'first part', timestamp: 1, partId: 'rprt_1' });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r2', text: 'second part', timestamp: 2, partId: 'rprt_2' });

    let turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.length).toBe(2);
    expect(turn.segments[0]).toMatchObject({ type: 'reasoning', content: 'first part', partId: 'rprt_1' });
    expect(turn.segments[1]).toMatchObject({ type: 'reasoning', content: 'second part', partId: 'rprt_2' });

    // Events with undefined partId each start a new segment — even
    // back-to-back (undefined never satisfies the merge predicate).
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r3', text: 'no id A', timestamp: 3 });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r4', text: 'no id B', timestamp: 4 });

    turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.length).toBe(4);
    expect(turn.segments[2]).toMatchObject({ type: 'reasoning', content: 'no id A' });
    expect(turn.segments[3]).toMatchObject({ type: 'reasoning', content: 'no id B' });
  });

  it('reasoning: REASONING followed by TEXT produces two segments (reasoning then text)', () => {
    // The bubble splitter then attaches the reasoning to the following text
    // bubble as a collapsible disclosure. Reducer just keeps them as
    // distinct segments in order. (TEXT carries no partId on master.)
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r1', text: 'thinking', timestamp: 1, partId: 'rprt_1' });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't1', text: 'answer', timestamp: 2 });

    const turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.length).toBe(2);
    expect(turn.segments[0].type).toBe('reasoning');
    expect(turn.segments[1].type).toBe('text');
  });

  it('reasoning: REASONING action clears stale attentionState back to ok', () => {
    // Reasoning is genuine activity — bumps lastActivityAt and clears the
    // 'stuck' banner. Mirrors the existing TRANSCRIPT_THINKING_HEARTBEAT
    // behavior so thinking models don't surface false-positive stuck banners
    // while reasoning is streaming.
    state = dispatch(state, { type: 'ATTENTION_STATE_CHANGED', sessionId: SESSION, state: 'stuck' });
    expect(state.get(SESSION)!.attentionState).toBe('stuck');
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r1', text: 'x', timestamp: 1, partId: 'rprt_1' });
    expect(state.get(SESSION)!.attentionState).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// PERMISSION_REQUEST → running-tool matching (2026-07-10 review fix)
// ---------------------------------------------------------------------------
describe('PERMISSION_REQUEST tool matching', () => {
  let state: ChatState;

  const toolUse = (toolUseId: string, toolName: string, toolInput: Record<string, unknown>): ChatAction => ({
    type: 'TRANSCRIPT_TOOL_USE',
    sessionId: SESSION,
    uuid: `uuid-${toolUseId}`,
    toolUseId,
    toolName,
    toolInput,
    timestamp: 1000,
  } as ChatAction);

  beforeEach(() => {
    state = initState();
  });

  it('attaches approval to the running tool whose input matches, not the first same-name tool', () => {
    // Two Bash tools running in parallel — the permission is for the SECOND.
    state = dispatch(state, toolUse('tool-a', 'Bash', { command: 'ls' }));
    state = dispatch(state, toolUse('tool-b', 'Bash', { command: 'rm -rf build' }));

    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
      requestId: 'req-1',
    });

    const session = state.get(SESSION)!;
    expect(session.toolCalls.get('tool-b')!.status).toBe('awaiting-approval');
    expect(session.toolCalls.get('tool-b')!.requestId).toBe('req-1');
    expect(session.toolCalls.get('tool-a')!.status).toBe('running');
  });

  it('carries permissionMode onto the tool entry, on the matched AND synthetic paths', () => {
    // Matched-running-tool path.
    state = dispatch(state, toolUse('tool-a', 'Bash', { command: 'git push origin master' }));
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'git push origin master' },
      requestId: 'req-fa',
      denyListed: true,
      permissionMode: 'full-auto',
    });
    expect(state.get(SESSION)!.toolCalls.get('tool-a')!.permissionMode).toBe('full-auto');

    // Permission-before-transcript synthetic path (no running tool to match).
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'sudo ls' },
      requestId: 'req-syn',
      denyListed: true,
      permissionMode: 'full-auto',
    });
    const syn = [...state.get(SESSION)!.toolCalls.values()].find((t) => t.requestId === 'req-syn')!;
    expect(syn.permissionMode).toBe('full-auto');
  });

  it('matches input regardless of key order', () => {
    state = dispatch(state, toolUse('tool-a', 'Write', { file_path: '/x', content: 'one' }));
    state = dispatch(state, toolUse('tool-b', 'Write', { content: 'two', file_path: '/y' }));

    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Write',
      input: { file_path: '/y', content: 'two' },
      requestId: 'req-2',
    });

    const session = state.get(SESSION)!;
    expect(session.toolCalls.get('tool-b')!.status).toBe('awaiting-approval');
    expect(session.toolCalls.get('tool-a')!.status).toBe('running');
  });

  it('falls back to the first same-name running tool when no input matches', () => {
    // Pins the pre-existing fallback: hook input shape may not always mirror
    // the transcript's toolInput — degrading to name-match must keep working.
    state = dispatch(state, toolUse('tool-a', 'Bash', { command: 'ls' }));
    state = dispatch(state, toolUse('tool-b', 'Bash', { command: 'pwd' }));

    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'echo mismatched' },
      requestId: 'req-3',
    });

    const session = state.get(SESSION)!;
    const awaiting = ['tool-a', 'tool-b'].filter(
      (id) => session.toolCalls.get(id)!.status === 'awaiting-approval',
    );
    expect(awaiting).toEqual(['tool-a']);
  });

  // 2026-08-16: main now RE-ANNOUNCES every still-pending ask on a heartbeat so
  // a card that never rendered (or that a later event overwrote) heals itself
  // instead of hanging the turn forever. That makes PERMISSION_REQUEST a
  // REPEATABLE action — these four pin what a repeat must and must not do.
  describe('re-delivered by the heartbeat', () => {
    it('is a no-op — identical state object — when the card is already awaiting approval', () => {
      state = dispatch(state, toolUse('tool-a', 'Bash', { command: 'ls' }));
      state = dispatch(state, {
        type: 'PERMISSION_REQUEST', sessionId: SESSION, toolName: 'Bash', input: { command: 'ls' }, requestId: 'req-hb',
      });
      const settled = state;
      state = dispatch(state, {
        type: 'PERMISSION_REQUEST', sessionId: SESSION, toolName: 'Bash', input: { command: 'ls' }, requestId: 'req-hb',
      });
      // Reference equality, not deep equality: a fresh object every 3s would
      // re-render the whole timeline for nothing.
      expect(state).toBe(settled);
    });

    it('never binds a SECOND card when another same-name tool is running', () => {
      // The hazard the heartbeat introduces: tier-2 matches by NAME only, so a
      // repeat could hand the same requestId to an unrelated running card and
      // put Allow/Deny buttons on two cards for one ask.
      state = dispatch(state, toolUse('tool-a', 'Bash', { command: 'ls' }));
      state = dispatch(state, {
        type: 'PERMISSION_REQUEST', sessionId: SESSION, toolName: 'Bash', input: { command: 'ls' }, requestId: 'req-hb',
      });
      state = dispatch(state, toolUse('tool-b', 'Bash', { command: 'pwd' }));
      state = dispatch(state, {
        type: 'PERMISSION_REQUEST', sessionId: SESSION, toolName: 'Bash', input: { command: 'ls' }, requestId: 'req-hb',
      });

      const session = state.get(SESSION)!;
      const awaiting = [...session.toolCalls.values()].filter((t) => t.status === 'awaiting-approval');
      expect(awaiting).toHaveLength(1);
      expect(session.toolCalls.get('tool-a')!.status).toBe('awaiting-approval');
      expect(session.toolCalls.get('tool-b')!.status).toBe('running');
    });

    it('RE-BINDS a card whose ask was wiped — the whole point of the heartbeat', () => {
      // Reproduces the shipped stuck-turn shape: the card held the ask, then a
      // later event overwrote it back to plain 'running' with no requestId, so
      // no buttons rendered while main was still waiting. The next heartbeat
      // must put the ask back rather than mint a duplicate.
      state = dispatch(state, toolUse('tool-a', 'Read', { file_path: '/x' }));
      state = dispatch(state, {
        type: 'PERMISSION_REQUEST', sessionId: SESSION, toolName: 'Read', input: { file_path: '/x' }, requestId: 'req-hb',
      });
      const session0 = state.get(SESSION)!;
      const wiped = new Map(session0.toolCalls);
      wiped.set('tool-a', { ...wiped.get('tool-a')!, status: 'running', requestId: undefined });
      state = new Map(state).set(SESSION, { ...session0, toolCalls: wiped });

      state = dispatch(state, {
        type: 'PERMISSION_REQUEST', sessionId: SESSION, toolName: 'Read', input: { file_path: '/x' }, requestId: 'req-hb',
      });

      const session = state.get(SESSION)!;
      expect(session.toolCalls.get('tool-a')!.status).toBe('awaiting-approval');
      expect(session.toolCalls.get('tool-a')!.requestId).toBe('req-hb');
      expect([...session.toolCalls.values()].filter((t) => t.requestId === 'req-hb')).toHaveLength(1);
    });

    it('re-creates the card entirely when it was lost (transcript replay / re-dock)', () => {
      state = dispatch(state, {
        type: 'PERMISSION_REQUEST', sessionId: SESSION, toolName: 'Read', input: { file_path: '/x' }, requestId: 'req-hb',
      });
      const session0 = state.get(SESSION)!;
      // Replay rebuilt the timeline from the JSONL, which has no record of a
      // pending ask — the card is simply gone (ROADMAP bug, 2026-08-16).
      state = new Map(state).set(SESSION, { ...session0, toolCalls: new Map(), activeTurnToolIds: new Set() });

      state = dispatch(state, {
        type: 'PERMISSION_REQUEST', sessionId: SESSION, toolName: 'Read', input: { file_path: '/x' }, requestId: 'req-hb',
      });

      const session = state.get(SESSION)!;
      const card = session.toolCalls.get('perm-req-hb');
      expect(card?.status).toBe('awaiting-approval');
      // Load-bearing: ChatView renders awaiting cards from activeTurnToolIds,
      // and AssistantTurnBubble deliberately skips them — an awaiting card
      // outside that Set renders NOWHERE.
      expect(session.activeTurnToolIds.has('perm-req-hb')).toBe(true);
    });
  });

  it('still creates a synthetic entry when no running tool exists', () => {
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'echo hi' },
      requestId: 'req-4',
    });

    const session = state.get(SESSION)!;
    const syn = session.toolCalls.get('perm-req-4');
    expect(syn).toBeDefined();
    expect(syn!.status).toBe('awaiting-approval');
  });

  // Task 13: denyListed must survive onto the tool so ToolCard can gate the
  // consequence-warning "Always allow". Covers both the matched-tool branch and
  // the synthetic-entry branch.
  it('carries denyListed onto the matched running tool', () => {
    state = dispatch(state, toolUse('tool-a', 'Bash', { command: 'rm -rf /' }));
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
      requestId: 'native-req-5',
      denyListed: true,
    });
    expect(state.get(SESSION)!.toolCalls.get('tool-a')!.denyListed).toBe(true);
  });

  it('carries denyListed onto a synthetic entry', () => {
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
      requestId: 'native-req-6',
      denyListed: true,
    });
    expect(state.get(SESSION)!.toolCalls.get('perm-native-req-6')!.denyListed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PERMISSION_RESPONDED → synthetic budget gates (max_steps / doom_loop)
// Regression: a budget gate is a synthetic ask with no real tool execution, so
// no TRANSCRIPT_TOOL_RESULT ever closes its card. If the card stays 'running'
// after the response, endTurn() force-fails it 'Turn ended' on a normal finish.
// The card must close 'complete' on response. (The tier-3 "first running tool of

// ---------------------------------------------------------------------------
// Preparing card × permission ask ordering (2026-08-16, Destin's Specialists 1b
// Test 1 hang). Main emits tool-use THEN the ask; the renderer batches
// transcript events into an animation frame but dispatches hook events at once,
// so the reducer sees NATIVE_TOOL_PREPARING → PERMISSION_REQUEST →
// TRANSCRIPT_TOOL_USE. The ask binds to the preparing card (status 'running');
// the late tool-use used to overwrite that entry wholesale — status back to
// 'running', requestId gone — so the Allow/Deny buttons never rendered and the
// turn hung on an ask nobody could answer.
// ---------------------------------------------------------------------------
describe('TRANSCRIPT_TOOL_USE landing on a preparing card that already holds an ask', () => {
  it('keeps awaiting-approval + requestId (and the ask metadata) when the real tool-use supersedes the preparing card', () => {
    let state = initState();
    state = dispatch(state, {
      type: 'NATIVE_TOOL_PREPARING', sessionId: SESSION, toolCallId: 'call-1', toolName: 'Task', chars: 120,
    });
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST', sessionId: SESSION, toolName: 'Task',
      input: { agent: 'explorer', prompt: 'find config', work_dir: '/p', description: 'd' },
      requestId: 'req-prep', denyListed: false, external: false, permissionMode: 'ask',
    });
    // Sanity: the ask bound to the preparing card.
    expect(state.get(SESSION)!.toolCalls.get('call-1')!.status).toBe('awaiting-approval');

    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE', sessionId: SESSION, uuid: 'uuid-call-1', toolUseId: 'call-1', toolName: 'Task',
      toolInput: { agent: 'explorer', prompt: 'find config', work_dir: '/p', description: 'd' }, timestamp: 1000,
    } as ChatAction);

    const tool = state.get(SESSION)!.toolCalls.get('call-1')!;
    expect(tool.status).toBe('awaiting-approval');
    expect(tool.requestId).toBe('req-prep');
    expect(tool.permissionMode).toBe('ask');
    expect(tool.preparing).toBeFalsy();
    expect(tool.input).toEqual({ agent: 'explorer', prompt: 'find config', work_dir: '/p', description: 'd' });
    // Still exactly one card — superseded in place, never duplicated.
    expect([...state.get(SESSION)!.toolCalls.keys()].filter((k) => k === 'call-1' || k.startsWith('perm-'))).toEqual(['call-1']);
  });

  it('a preparing card with NO ask still becomes a plain running tool (unchanged path)', () => {
    let state = initState();
    state = dispatch(state, {
      type: 'NATIVE_TOOL_PREPARING', sessionId: SESSION, toolCallId: 'call-2', toolName: 'Bash', chars: 10,
    });
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE', sessionId: SESSION, uuid: 'uuid-call-2', toolUseId: 'call-2', toolName: 'Bash',
      toolInput: { command: 'ls' }, timestamp: 1000,
    } as ChatAction);
    const tool = state.get(SESSION)!.toolCalls.get('call-2')!;
    expect(tool.status).toBe('running');
    expect(tool.requestId).toBeUndefined();
    expect(tool.preparing).toBeFalsy();
  });
});

// any name" fallback this also used to cite was deleted 2026-08-09.)
// ---------------------------------------------------------------------------
// 2026-08-16: a host-injected user-role turn (a delivered specialist report,
// TranscriptEvent.data.injected = 'specialist-report') must carry its marker
// onto the timeline entry so ChatView/BubbleFeed can draw it as a system
// notice rather than the user's own bubble.
describe('TRANSCRIPT_USER_MESSAGE carries the host-injected marker', () => {
  it('stamps `injected` on the appended entry, and leaves a real user message unmarked', () => {
    let state = initState();
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SESSION, uuid: 'u-inj', timestamp: 1000,
      text: '[Background specialist finished] Vega completed the task.', injected: 'specialist-report',
      injectedMeta: { childId: 'c1', title: 'Vega', agentType: 'researcher', status: 'completed', steps: 3 },
    });
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SESSION, uuid: 'u-real', timestamp: 2000, text: 'thanks',
    });
    const entries = state.get(SESSION)!.timeline.filter((e) => e.kind === 'user') as Extract<import('../src/renderer/state/chat-types').TimelineEntry, { kind: 'user' }>[];
    expect(entries).toHaveLength(2);
    expect(entries[0].injected).toBe('specialist-report');
    expect(entries[0].injectedMeta).toEqual({ childId: 'c1', title: 'Vega', agentType: 'researcher', status: 'completed', steps: 3 });
    expect(entries[0].message.content).toContain('[Background specialist finished]');
    expect(entries[1].injected).toBeUndefined();
  });
});

describe('TRANSCRIPT_USER_MESSAGE suppresses the redundant /compact bubble', () => {
  // CC writes a bare `/compact` user line into the JSONL on BOTH the typed path
  // and the resume-from-summary path. CompactingCard is the intended feedback
  // for that event, so the bubble is pure duplication — but everything else the
  // event drives (turn state, uuid dedup) must still happen.
  it('drops the bubble for /compact but still starts the turn', () => {
    let state = initState();
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SESSION, uuid: 'u-compact', timestamp: 1000,
      text: '/compact',
    });
    const session = state.get(SESSION)!;
    expect(session.timeline.filter((e) => e.kind === 'user')).toHaveLength(0);
    expect(session.isThinking).toBe(true);
    expect(session.seenUuids.has('u-compact')).toBe(true);
  });

  it('drops it with focus instructions too', () => {
    let state = initState();
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SESSION, uuid: 'u-c2', timestamp: 1000,
      text: '/compact focus on the auth work',
    });
    expect(state.get(SESSION)!.timeline.filter((e) => e.kind === 'user')).toHaveLength(0);
  });

  it('keeps a real message that merely mentions /compact', () => {
    let state = initState();
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SESSION, uuid: 'u-real', timestamp: 1000,
      text: 'why did /compact take so long?',
    });
    expect(state.get(SESSION)!.timeline.filter((e) => e.kind === 'user')).toHaveLength(1);
  });

  // The suppression MUST sit below the confirm arm. The `\/compact` escape
  // hatch is passthrough text, so InputBar does dispatch an optimistic bubble
  // for it; dropping its confirmation would leave `pending` set forever and
  // useSubmitConfirmation would fire a stray recovery keystroke.
  it('still confirms an optimistic /compact bubble instead of stranding it pending', () => {
    let state = initState();
    state = dispatch(state, {
      type: 'USER_PROMPT', sessionId: SESSION, content: '/compact', timestamp: 1000,
    });
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SESSION, uuid: 'u-esc', timestamp: 1001,
      text: '/compact',
    });
    const users = state.get(SESSION)!.timeline.filter((e) => e.kind === 'user') as any[];
    expect(users).toHaveLength(1);
    expect(users[0].pending).toBe(false);
  });

  // Reload/resume replays CC's JSONL. Without the same rule on that path, every
  // bubble the live fix removed grows back on reload. Since perf cycle 2 the
  // path is HISTORY_PAGE_LOADED, which replays real transcript events through
  // the same per-event cases — so the suppression is inherited rather than
  // duplicated, and this test pins that it really is.
  it('drops the echo from replayed history too', () => {
    let state = initState();
    const ev = (type: string, uuid: string, text: string, ts: number) =>
      ({ type, sessionId: SESSION, uuid, timestamp: ts, data: { text } }) as any;
    state = dispatch(state, {
      type: 'HISTORY_PAGE_LOADED', sessionId: SESSION, cursor: null, hasMore: false,
      events: [
        ev('user-message', 'h1', 'first question', 1),
        ev('user-message', 'h2', '/compact', 2),
        ev('assistant-text', 'h3', 'an answer', 3),
        ev('user-message', 'h4', 'second question', 4),
      ],
    });
    const users = state.get(SESSION)!.timeline.filter((e) => e.kind === 'user') as any[];
    expect(users.map((e) => e.message.content)).toEqual(['first question', 'second question']);
    // The assistant turn either side of it must survive untouched.
    expect(state.get(SESSION)!.timeline.filter((e) => e.kind === 'assistant-turn')).toHaveLength(1);
  });
});

describe('PERMISSION_RESPONDED budget gates', () => {
  let state: ChatState;

  const budgetAsk = (requestId: string, toolName: 'max_steps' | 'doom_loop', input: Record<string, unknown>): ChatAction => ({
    type: 'PERMISSION_REQUEST',
    sessionId: SESSION,
    toolName,
    input,
    requestId,
  });
  const responded = (requestId: string): ChatAction => ({
    type: 'PERMISSION_RESPONDED',
    sessionId: SESSION,
    requestId,
  });

  beforeEach(() => {
    state = initState();
  });

  it('closes a max_steps card complete (not running) on response', () => {
    state = dispatch(state, budgetAsk('req-1', 'max_steps', { steps: 50 }));
    state = dispatch(state, responded('req-1'));

    const card = state.get(SESSION)!.toolCalls.get('perm-req-1')!;
    expect(card.status).toBe('complete');
    expect(card.requestId).toBeUndefined();
  });

  it('a same-turn re-trip synthesizes a FRESH card instead of reusing the orphan', () => {
    state = dispatch(state, budgetAsk('req-1', 'max_steps', { steps: 50 }));
    state = dispatch(state, responded('req-1'));
    // Second trip in the same turn — different requestId, larger step count.
    state = dispatch(state, budgetAsk('req-2', 'max_steps', { steps: 100 }));

    const session = state.get(SESSION)!;
    // The first card stays closed; a brand-new synthetic card is awaiting approval.
    expect(session.toolCalls.get('perm-req-1')!.status).toBe('complete');
    const fresh = session.toolCalls.get('perm-req-2')!;
    expect(fresh.status).toBe('awaiting-approval');
    expect(fresh.requestId).toBe('req-2');
    expect(fresh.input).toEqual({ steps: 100 });
  });

  it('turn completion does NOT force-fail an answered budget-gate card', () => {
    state = dispatch(state, budgetAsk('req-1', 'max_steps', { steps: 50 }));
    state = dispatch(state, responded('req-1'));
    state = dispatch(state, { type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: SESSION } as ChatAction);

    const card = state.get(SESSION)!.toolCalls.get('perm-req-1')!;
    expect(card.status).toBe('complete');
    expect(card.error).toBeUndefined();
  });

  it('a real tool still returns to running on response (budget-gate carve-out is scoped)', () => {
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: SESSION,
      uuid: 'uuid-tool-a',
      toolUseId: 'tool-a',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      timestamp: 1000,
    } as ChatAction);
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'ls' },
      requestId: 'req-9',
    });
    state = dispatch(state, responded('req-9'));

    expect(state.get(SESSION)!.toolCalls.get('tool-a')!.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// hookEventToAction — native denyListed passthrough (Task 13)
// ---------------------------------------------------------------------------
describe('hookEventToAction PermissionRequest', () => {
  it('passes denyListed from the broker payload into the action', () => {
    const action = hookEventToAction({
      type: 'PermissionRequest',
      sessionId: SESSION,
      payload: {
        _requestId: 'native-abc',
        tool_name: 'Bash',
        tool_input: { command: 'git push --force' },
        denyListed: true,
      },
      timestamp: Date.now(),
    } as HookEvent);
    expect(action).not.toBeNull();
    expect(action!.type).toBe('PERMISSION_REQUEST');
    expect((action as any).denyListed).toBe(true);
  });

  it('leaves denyListed undefined for a CC event without it', () => {
    const action = hookEventToAction({
      type: 'PermissionRequest',
      sessionId: SESSION,
      payload: {
        _requestId: 'cc-xyz',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        permission_suggestions: ['Bash(ls:*)'],
      },
      timestamp: Date.now(),
    } as HookEvent);
    expect((action as any).denyListed).toBeUndefined();
    expect((action as any).permissionSuggestions).toEqual(['Bash(ls:*)']);
  });
});

// ---------------------------------------------------------------------------
// Native runtime reducer paths (Task 11): text partId merge + NATIVE_SESSION_ERROR
// ---------------------------------------------------------------------------
describe('native runtime reducer paths', () => {
  let state: ChatState;

  beforeEach(() => {
    state = initState();
  });

  it('TRANSCRIPT_ASSISTANT_TEXT with partId merges same-part deltas into one segment', () => {
    // Native harness streams text as per-token deltas carrying a shared partId;
    // same partId → append to the last text segment (mirrors reasoning).
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't1', text: 'Hello ', timestamp: 1, partId: 'p1' });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't2', text: 'world', timestamp: 2, partId: 'p1' });

    const turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.length).toBe(1);
    expect(turn.segments[0]).toMatchObject({ type: 'text', content: 'Hello world', partId: 'p1' });
  });

  it('does NOT over-merge: a new partId or an interleaved reasoning segment starts a new text segment', () => {
    // text p1 → reasoning r1 → text p2 → segments types [text, reasoning, text].
    // The reasoning segment breaks adjacency, and p2 differs from p1 anyway, so
    // the second text can never merge into the first.
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't1', text: 'A', timestamp: 1, partId: 'p1' });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r1', text: 'thinking', timestamp: 2, partId: 'rprt_1' });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't2', text: 'B', timestamp: 3, partId: 'p2' });

    const turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.map((s) => s.type)).toEqual(['text', 'reasoning', 'text']);
    expect(turn.segments[0]).toMatchObject({ type: 'text', content: 'A', partId: 'p1' });
    expect(turn.segments[2]).toMatchObject({ type: 'text', content: 'B', partId: 'p2' });
  });

  it('two adjacent text deltas with DIFFERENT partIds do not merge (partId mismatch alone forces a new segment)', () => {
    // Isolates the last.partId === action.partId clause: both segments are
    // type 'text' and adjacent (no reasoning between), so the ONLY thing
    // preventing a merge is the mismatched partId.
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't1', text: 'A', timestamp: 1, partId: 'p1' });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't2', text: 'B', timestamp: 2, partId: 'p2' });

    const turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.length).toBe(2);
    expect(turn.segments[0]).toMatchObject({ type: 'text', content: 'A', partId: 'p1' });
    expect(turn.segments[1]).toMatchObject({ type: 'text', content: 'B', partId: 'p2' });
  });

  it('events WITHOUT partId keep the whole-block append (CC path untouched)', () => {
    // CC's transcript path sends whole text blocks with no partId — undefined
    // never satisfies the merge predicate, so each stays its own segment.
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't1', text: 'first block', timestamp: 1 });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't2', text: 'second block', timestamp: 2 });

    const turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.length).toBe(2);
    expect(turn.segments[0]).toMatchObject({ type: 'text', content: 'first block' });
    expect(turn.segments[1]).toMatchObject({ type: 'text', content: 'second block' });
  });

  it('NATIVE_SESSION_ERROR ends the turn and surfaces attentionState error + message', () => {
    state = dispatch(state, { type: 'USER_PROMPT', sessionId: SESSION, content: 'do a thing', timestamp: 1 });
    expect(state.get(SESSION)!.isThinking).toBe(true);

    state = dispatch(state, { type: 'NATIVE_SESSION_ERROR', sessionId: SESSION, message: 'Rate limit exceeded' });

    const session = state.get(SESSION)!;
    expect(session.isThinking).toBe(false);
    expect(session.attentionState).toBe('error');
    expect(session.errorMessage).toBe('Rate limit exceeded');
    expect(session.currentTurnId).toBeNull();
  });

  it('the next user prompt clears the error state', () => {
    state = dispatch(state, { type: 'USER_PROMPT', sessionId: SESSION, content: 'first', timestamp: 1 });
    state = dispatch(state, { type: 'NATIVE_SESSION_ERROR', sessionId: SESSION, message: 'boom' });
    expect(state.get(SESSION)!.attentionState).toBe('error');

    // Typing again is the retry — clears both attentionState and errorMessage.
    state = dispatch(state, { type: 'USER_PROMPT', sessionId: SESSION, content: 'retry', timestamp: 2 });
    const session = state.get(SESSION)!;
    expect(session.attentionState).toBe('ok');
    expect(session.errorMessage).toBeNull();
  });

  // Connection trust (2026-09-18): the error's code picks the card's button, so
  // it is stored with the message, cleared with it, and survives a phone
  // reconnect (the snapshot) — otherwise a reconnecting phone loses the button.
  it('an error code is stored, cleared by the next prompt, and survives the snapshot', () => {
    state = dispatch(state, { type: 'USER_PROMPT', sessionId: SESSION, content: 'first', timestamp: 1 });
    state = dispatch(state, { type: 'NATIVE_SESSION_ERROR', sessionId: SESSION, message: 'm', errorCode: 'openrouter-credit-short' });
    expect(state.get(SESSION)!.errorCode).toBe('openrouter-credit-short');
    expect(deserializeChatState(serializeChatState(state)).get(SESSION)!.errorCode).toBe('openrouter-credit-short');
    state = dispatch(state, { type: 'USER_PROMPT', sessionId: SESSION, content: 'again', timestamp: 2 });
    expect(state.get(SESSION)!.errorCode).toBeNull();
  });

  it('NATIVE_MODEL_STATE_CHANGED sets modelState + modelInfo without touching turn state', () => {
    state = dispatch(state, { type: 'USER_PROMPT', sessionId: SESSION, content: 'hi', timestamp: 1 });
    expect(state.get(SESSION)!.isThinking).toBe(true);

    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'loading', modelId: 'Qwen-2B', sizeBytes: 2_000_000_000 });
    let s = state.get(SESSION)!;
    expect(s.modelState).toBe('loading');
    expect(s.modelInfo).toEqual({ modelId: 'Qwen-2B', sizeBytes: 2_000_000_000 });
    expect(s.isThinking).toBe(true); // model residency is orthogonal to the turn

    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'sleeping', modelId: 'Qwen-2B', sizeBytes: 2_000_000_000 });
    expect(state.get(SESSION)!.modelState).toBe('sleeping');

    // No-op when unchanged → same object reference (cheap, no needless render).
    const before = state.get(SESSION)!;
    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'sleeping', modelId: 'Qwen-2B', sizeBytes: 2_000_000_000 });
    expect(state.get(SESSION)!).toBe(before);
  });

  it('NATIVE_MODEL_STATE_CHANGED re-renders on load-progress bytes even when state is unchanged', () => {
    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'loading', modelId: 'Qwen-9B', sizeBytes: 9_000_000_000, loadedBytes: 1_000_000_000 });
    expect(state.get(SESSION)!.modelLoadedBytes).toBe(1_000_000_000);

    // Same state, MORE bytes resident → must produce a new object (progress bar advances).
    const before = state.get(SESSION)!;
    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'loading', modelId: 'Qwen-9B', sizeBytes: 9_000_000_000, loadedBytes: 6_000_000_000 });
    expect(state.get(SESSION)!).not.toBe(before);
    expect(state.get(SESSION)!.modelLoadedBytes).toBe(6_000_000_000);

    // Identical bytes → no-op (same reference).
    const same = state.get(SESSION)!;
    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'loading', modelId: 'Qwen-9B', sizeBytes: 9_000_000_000, loadedBytes: 6_000_000_000 });
    expect(state.get(SESSION)!).toBe(same);
  });

  it('modelEverResident latches on first loaded and stays true through sleep/unload', () => {
    // Fresh session's cold state: not yet resident → the Reload prompt must NOT
    // key on this (ModelLoadingBar shows the loading bar instead).
    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'unloaded', modelId: 'Qwen-2B', sizeBytes: 2_000_000_000 });
    expect(state.get(SESSION)!.modelEverResident).toBe(false);

    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'loading', modelId: 'Qwen-2B', sizeBytes: 2_000_000_000 });
    expect(state.get(SESSION)!.modelEverResident).toBe(false);

    // First time fully loaded → latch true.
    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'loaded', modelId: 'Qwen-2B', sizeBytes: 2_000_000_000 });
    expect(state.get(SESSION)!.modelEverResident).toBe(true);

    // Idle sleep after use → still true, so the Reload prompt is now valid.
    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'sleeping', modelId: 'Qwen-2B', sizeBytes: 2_000_000_000 });
    expect(state.get(SESSION)!.modelEverResident).toBe(true);
  });

  // ---- Task 12: queued messages leave the timeline — docked strip list ----
  describe('QUEUED_MESSAGE_ADDED / QUEUED_MESSAGE_REMOVED', () => {
    it('QUEUED_MESSAGE_ADDED appends to queuedMessages, not the timeline', () => {
      state = dispatch(state, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SESSION, queueId: 'q-1', content: 'queued msg', timestamp: 1 });
      expect(state.get(SESSION)!.timeline).toHaveLength(0);
      expect(state.get(SESSION)!.queuedMessages).toEqual([{ queueId: 'q-1', content: 'queued msg', timestamp: 1 }]);
    });

    it('QUEUED_MESSAGE_REMOVED removes only the matching entry, leaving others untouched', () => {
      state = dispatch(state, { type: 'USER_PROMPT', sessionId: SESSION, content: 'keep me (sent)', timestamp: 1 });
      state = dispatch(state, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SESSION, queueId: 'q-1', content: 'cancel me', timestamp: 2 });
      state = dispatch(state, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SESSION, queueId: 'q-2', content: 'keep me (queued)', timestamp: 3 });
      expect(state.get(SESSION)!.timeline).toHaveLength(1); // only the sent-path bubble
      expect(state.get(SESSION)!.queuedMessages).toHaveLength(2);

      state = dispatch(state, { type: 'QUEUED_MESSAGE_REMOVED', sessionId: SESSION, queueId: 'q-1' });

      expect(state.get(SESSION)!.timeline).toHaveLength(1); // untouched
      expect(state.get(SESSION)!.queuedMessages).toEqual([{ queueId: 'q-2', content: 'keep me (queued)', timestamp: 3 }]);
    });

    it('is a no-op when the drain already won the race (TRANSCRIPT_USER_MESSAGE confirmed first)', () => {
      state = dispatch(state, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SESSION, queueId: 'q-1', content: 'racer', timestamp: 1 });
      // Confirm arrives first — the drain-side removal (TRANSCRIPT_USER_MESSAGE) already cleared the list entry.
      state = dispatch(state, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SESSION, uuid: 'u-1', text: 'racer', timestamp: 2 });
      const before = state.get(SESSION)!;
      expect(before.queuedMessages).toEqual([]);
      expect(before.timeline).toHaveLength(1);

      state = dispatch(state, { type: 'QUEUED_MESSAGE_REMOVED', sessionId: SESSION, queueId: 'q-1' });

      // No-op: same object reference, timeline entry still present and confirmed.
      expect(state.get(SESSION)!).toBe(before);
      expect(state.get(SESSION)!.timeline).toHaveLength(1);
    });

    it('is a no-op for an unknown session id', () => {
      state = dispatch(state, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SESSION, queueId: 'q-1', content: 'irrelevant', timestamp: 1 });
      const before = state;
      state = dispatch(state, { type: 'QUEUED_MESSAGE_REMOVED', sessionId: 'ghost-session', queueId: 'q-1' });
      expect(state).toBe(before);
    });

    it('TRANSCRIPT_USER_MESSAGE appends the drained queued message at the END (true position), not in place of a bubble that was never written', () => {
      state = dispatch(state, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SESSION, queueId: 'q-1', content: 'confirm me', timestamp: 1 });
      expect(state.get(SESSION)!.timeline).toHaveLength(0);
      state = dispatch(state, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SESSION, uuid: 'u-1', text: 'confirm me', timestamp: 2 });
      const timeline = state.get(SESSION)!.timeline;
      expect(timeline).toHaveLength(1);
      const entry = timeline[0];
      expect(entry).toMatchObject({ kind: 'user', pending: false });
      if (entry.kind === 'user') expect(entry.message.content).toBe('confirm me');
      expect(state.get(SESSION)!.queuedMessages).toEqual([]);
    });
  });

  // Step 3 (2026-08-17, broadened): the session's STARTING context (context
  // transparency — local or cloud, truncated or not).
  describe('SESSION_CONTEXT', () => {
    const record = {
      modelLabel: 'qwen2.5-coder:14b',
      contextWindowTokens: 16384,
      summary: 'Context was trimmed to fit qwen2.5-coder:14b’s window.',
      systemPrompt: 'You are YouCoded…',
      projectInstructions: {
        path: '/repo/CLAUDE.md',
        text: '# CLAUDE.md\n…',
        truncated: true,
        note: '3 of 12 sections kept (headings only)',
      },
      skills: [
        { id: 's1', label: 'theme-builder', path: '/repo/SKILL.md', truncated: true, note: 'body cut' },
        { id: 's2', label: 'chatsearch', path: '/repo/SKILL.md' },
      ],
      tools: ['Read', 'Write', 'Edit'],
      droppedMcpServers: ['docs-index'],
    };

    it('stores the starting-context record on session state', () => {
      state = dispatch(state, { type: 'SESSION_CONTEXT', sessionId: SESSION, context: record });
      expect(state.get(SESSION)!.sessionContext).toEqual(record);
    });

    it('accepts a null context (host has not reported yet)', () => {
      state = dispatch(state, { type: 'SESSION_CONTEXT', sessionId: SESSION, context: null });
      expect(state.get(SESSION)!.sessionContext).toBeNull();
    });

    it('is idempotent — re-firing the identical record returns the same reference', () => {
      state = dispatch(state, { type: 'SESSION_CONTEXT', sessionId: SESSION, context: record });
      const before = state.get(SESSION)!;
      state = dispatch(state, { type: 'SESSION_CONTEXT', sessionId: SESSION, context: record });
      expect(state.get(SESSION)!).toBe(before);
    });

    it('round-trips through the chat serializers', () => {
      state = dispatch(state, { type: 'SESSION_CONTEXT', sessionId: SESSION, context: record });
      const ser = serializeChatState(state);
      const restored = deserializeChatState(ser);
      expect(restored.get(SESSION)!.sessionContext).toEqual(record);
    });

    it('is a no-op for an unknown session id', () => {
      const before = state;
      state = dispatch(state, { type: 'SESSION_CONTEXT', sessionId: 'ghost-session', context: record });
      expect(state).toBe(before);
    });
  });
});

// 2026-09-16 smoothness sweep, A3: per-word work must not grow with the chat.
// Every streamed word used to COPY the set of every uuid the session had ever
// seen (`new Set(session.seenUuids).add(uuid)`), so a 4,000-word reply did
// ~8M copies and the last paragraph lurched. The set is append-only and
// nothing renders it, so the reducer now appends in place — its one documented
// purity exception (see markSeen's WHY). Pinned by identity, not timing.
describe('seen-uuid dedup appends in place', () => {
  const text = (uuid: string, t = 'w'): ChatAction => ({ type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid, text: t, timestamp: 1 });
  const turnText = (s: ChatState) => {
    const sess = s.get(SESSION)!;
    return [...sess.assistantTurns.values()].flatMap((t) => t.segments).filter((seg) => seg.type === 'text').map((seg: any) => seg.content).join('');
  };

  it('a streamed word keeps the seenUuids Set identity and records the uuid', () => {
    let state = dispatch(initState(), text('u0'));
    const before = state.get(SESSION)!.seenUuids;
    state = dispatch(state, text('u1'));
    expect(state.get(SESSION)!.seenUuids).toBe(before);
    expect(before.has('u1')).toBe(true);
  });

  it('a duplicate uuid is still dropped and leaves the state untouched', () => {
    let state = dispatch(initState(), text('u0', 'a'));
    state = dispatch(state, text('u1', 'b'));
    const before = state;
    state = dispatch(state, text('u1', 'b'));
    expect(state).toBe(before);
    expect(turnText(state)).toBe('ab');
  });

  it('a user message, a skill invocation and a turn end record their uuids the same way', () => {
    let state = dispatch(initState(), { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SESSION, uuid: 'um1', text: 'hi', timestamp: 1 } as ChatAction);
    const set = state.get(SESSION)!.seenUuids;
    expect(set.has('um1')).toBe(true);
    state = dispatch(state, text('t1'));
    state = dispatch(state, { type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: SESSION, uuid: 'tc1', usage: { input_tokens: 1, output_tokens: 1 } } as unknown as ChatAction);
    expect(state.get(SESSION)!.seenUuids).toBe(set);
    expect(set.has('t1')).toBe(true);
    expect(set.has('tc1')).toBe(true);
  });

  it('a session that started without a set (legacy snapshot) still records uuids', () => {
    let state = initState();
    const bare = { ...state.get(SESSION)!, seenUuids: undefined as unknown as Set<string> };
    state = new Map(state).set(SESSION, bare);
    state = dispatch(state, { type: 'TRANSCRIPT_SKILL_INVOKED', sessionId: SESSION, uuid: 'sk1', skillId: 'x', displayName: 'x', timestamp: 1 } as ChatAction);
    expect(state.get(SESSION)!.seenUuids.has('sk1')).toBe(true);
  });
});

// SESSION_MOVED — another device took over this session's lease. It ONLY ends
// the in-flight turn cleanly (endTurn); it appends no timeline marker. The
// holder destroys the session immediately after, so any appended marker would be
// wiped by SESSION_REMOVE back-to-back and never render. The user-facing
// "this session was taken over on <device>" surface is App.tsx's MovedGate, not
// the timeline. These tests pin that endTurn still runs and NO marker is added.
describe('SESSION_MOVED reducer action', () => {
  let state: ChatState;

  beforeEach(() => {
    state = initState();
  });

  it('mid-turn: clears isThinking, fails running tools with "Turn ended", appends NO marker', () => {
    // Start a turn + emit a tool so there is in-flight state to tear down.
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
    expect(state.get(SESSION)!.isThinking).toBe(true);
    expect(state.get(SESSION)!.toolCalls.get('tool-1')!.status).toBe('running');

    const timelineLenBefore = state.get(SESSION)!.timeline.length;

    state = dispatch(state, {
      type: 'SESSION_MOVED',
      sessionId: SESSION,
      device: 'MacBook Pro',
    });

    const session = state.get(SESSION)!;
    // endTurn() effects
    expect(session.isThinking).toBe(false);
    expect(session.activeTurnToolIds.size).toBe(0);
    expect(session.toolCalls.get('tool-1')!.status).toBe('failed');
    expect(session.toolCalls.get('tool-1')!.error).toBe('Turn ended');
    // Attention resets to 'ok' — this is a clean turn end, NOT a terminal error state.
    expect(session.attentionState).toBe('ok');

    // NO system marker is appended (the Moved Gate is the surface now) and the
    // timeline length is otherwise unchanged.
    const markers = session.timeline.filter((e) => e.kind === 'system-marker');
    expect(markers.length).toBe(0);
    expect(session.timeline.length).toBe(timelineLenBefore);
  });

  it('idle: no marker, no spurious tool changes', () => {
    const before = state.get(SESSION)!;
    expect(before.isThinking).toBe(false);
    expect(before.timeline.length).toBe(0);

    state = dispatch(state, {
      type: 'SESSION_MOVED',
      sessionId: SESSION,
      device: 'Linux Desktop',
    });

    const session = state.get(SESSION)!;
    expect(session.toolCalls.size).toBe(0);
    expect(session.isThinking).toBe(false);
    const markers = session.timeline.filter((e) => e.kind === 'system-marker');
    expect(markers.length).toBe(0);
  });

  it('unknown sessionId: returns state unchanged (no throw)', () => {
    const before = state;
    const after = dispatch(state, {
      type: 'SESSION_MOVED',
      sessionId: 'no-such-session',
      device: 'Phantom',
    });
    expect(after).toBe(before);
  });
});

describe('reducer session totals', () => {
  const SID = 's1';
  const start = (): ChatState => chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: SID });

  const turnComplete = (usage: any, uuid: string) => ({
    type: 'TRANSCRIPT_TURN_COMPLETE' as const,
    sessionId: SID, uuid, timestamp: 1,
    stopReason: 'end_turn', model: 'm', anthropicRequestId: null, usage,
  });

  it('sums usage across turns', () => {
    let s = start();
    s = chatReducer(s, turnComplete({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 }, 'u1'));
    s = chatReducer(s, turnComplete({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 }, 'u2'));
    expect(s.get(SID)!.totals.inputTokens).toBe(300);
    expect(s.get(SID)!.totals.outputTokens).toBe(30);
  });

  it('counts a turn exactly once, even when the watcher re-delivers it', () => {
    // The watcher's re-emit contract and re-dock replay both RE-DELIVER
    // turn-complete ("the reducer absorbs them"), and addTurnUsage is not
    // idempotent. This was latent until 2026-09-03, when the In:/Out:/Cached:
    // chips started reading a Claude Code session's totals — before that
    // nothing displayed them, so a double count was invisible. Re-docking a
    // session would otherwise have inflated every number on the bar.
    let s = start();
    const usage = { inputTokens: 1_000, outputTokens: 90, cacheReadTokens: 800, cacheCreationTokens: 20 };
    s = chatReducer(s, turnComplete(usage, 'dup-1'));
    s = chatReducer(s, turnComplete(usage, 'dup-1'));   // same turn, re-delivered
    s = chatReducer(s, turnComplete(usage, 'dup-1'));   // and again
    expect(s.get(SID)!.totals.inputTokens).toBe(1_000);
    expect(s.get(SID)!.totals.outputTokens).toBe(90);
    expect(s.get(SID)!.totals.cacheReadTokens).toBe(800);
    // A genuinely different turn still adds.
    s = chatReducer(s, turnComplete(usage, 'dup-2'));
    expect(s.get(SID)!.totals.inputTokens).toBe(2_000);
  });

  it('does not count a SUBAGENT turn-complete twice — the subagent-usage event owns that', () => {
    let s = start();
    s = chatReducer(s, {
      ...turnComplete({ inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 }, 'u3'),
      parentAgentToolUseId: 'parent-tool-1',
      agentId: 'child-1',
    } as any);
    expect(s.get(SID)!.totals.inputTokens).toBe(0);
  });

  it('counts edited lines from a tool result exactly once, even on a duplicate emit', () => {
    let s = start();
    const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' ctx', '-a', '+b', '+c'] }];
    const use = { type: 'TRANSCRIPT_TOOL_USE' as const, sessionId: SID, uuid: 'tu', timestamp: 1, toolUseId: 't1', toolName: 'Edit', toolInput: {} };
    const result = { type: 'TRANSCRIPT_TOOL_RESULT' as const, sessionId: SID, uuid: 'tr', timestamp: 2, toolUseId: 't1', toolName: 'Edit', result: 'ok', isError: false, structuredPatch: patch };
    s = chatReducer(s, use as any);
    s = chatReducer(s, result as any);
    s = chatReducer(s, result as any);   // duplicate delivery (replay overlapping live)
    expect(s.get(SID)!.totals.linesAdded).toBe(2);
    expect(s.get(SID)!.totals.linesRemoved).toBe(1);
  });

  it('counts a SPECIALIST edit — the segment path, not the main tool-call path', () => {
    let s = start();
    const patch = [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, lines: ['+x', '+y', '+z'] }];
    s = chatReducer(s, { type: 'TRANSCRIPT_TOOL_USE', sessionId: SID, uuid: 'p1', timestamp: 1, toolUseId: 'task-1', toolName: 'Task', toolInput: {} } as any);
    s = chatReducer(s, { type: 'TRANSCRIPT_TOOL_USE', sessionId: SID, uuid: 'c1', timestamp: 2, toolUseId: 'ct-1', toolName: 'Write', toolInput: {}, parentAgentToolUseId: 'task-1', agentId: 'child-1' } as any);
    s = chatReducer(s, { type: 'TRANSCRIPT_TOOL_RESULT', sessionId: SID, uuid: 'c2', timestamp: 3, toolUseId: 'ct-1', toolName: 'Write', result: 'ok', isError: false, structuredPatch: patch, parentAgentToolUseId: 'task-1', agentId: 'child-1' } as any);
    expect(s.get(SID)!.totals.linesAdded).toBe(3);
  });

  it('counts a SPECIALIST edit exactly once, even on a duplicate emit, as the main timeline does', () => {
    let s = start();
    const patch = [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, lines: ['+x', '+y', '+z'] }];
    s = chatReducer(s, { type: 'TRANSCRIPT_TOOL_USE', sessionId: SID, uuid: 'p3', timestamp: 1, toolUseId: 'task-3', toolName: 'Task', toolInput: {} } as any);
    s = chatReducer(s, { type: 'TRANSCRIPT_TOOL_USE', sessionId: SID, uuid: 'c3', timestamp: 2, toolUseId: 'ct-3', toolName: 'Write', toolInput: {}, parentAgentToolUseId: 'task-3', agentId: 'child-1' } as any);
    const result = { type: 'TRANSCRIPT_TOOL_RESULT' as const, sessionId: SID, uuid: 'c4', timestamp: 3, toolUseId: 'ct-3', toolName: 'Write', result: 'ok', isError: false, structuredPatch: patch, parentAgentToolUseId: 'task-3', agentId: 'child-1' };
    s = chatReducer(s, result as any);
    s = chatReducer(s, result as any);   // duplicate delivery (replay overlapping live)
    expect(s.get(SID)!.totals.linesAdded).toBe(3);
  });

  it('main timeline: an orphan tool result — no preceding tool-use for that toolUseId — contributes nothing, even on duplicate delivery', () => {
    let s = start();
    const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' ctx', '-a', '+b', '+c'] }];
    // No TRANSCRIPT_TOOL_USE for 'missing-tool' ever dispatched — this simulates
    // a dropped/malformed tool-use line, which this codebase treats as a real
    // possibility (see the once-only guard comments above the reducer cases).
    const result = { type: 'TRANSCRIPT_TOOL_RESULT' as const, sessionId: SID, uuid: 'tr-orphan', timestamp: 2, toolUseId: 'missing-tool', toolName: 'Edit', result: 'ok', isError: false, structuredPatch: patch };
    s = chatReducer(s, result as any);
    s = chatReducer(s, result as any);   // duplicate delivery
    expect(s.get(SID)!.totals.linesAdded).toBe(0);
    expect(s.get(SID)!.totals.linesRemoved).toBe(0);
  });

  it('specialist: an orphan specialist tool result — no preceding tool-use under the parent — contributes nothing, even on duplicate delivery', () => {
    let s = start();
    const patch = [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, lines: ['+x', '+y', '+z'] }];
    // The parent Agent tool-call DOES exist (otherwise applySubagentEvent bails
    // entirely before reaching the patch guard), but no TRANSCRIPT_TOOL_USE ever
    // created a 'ct-orphan' segment under it.
    s = chatReducer(s, { type: 'TRANSCRIPT_TOOL_USE', sessionId: SID, uuid: 'p4', timestamp: 1, toolUseId: 'task-4', toolName: 'Task', toolInput: {} } as any);
    const result = { type: 'TRANSCRIPT_TOOL_RESULT' as const, sessionId: SID, uuid: 'c-orphan', timestamp: 3, toolUseId: 'ct-orphan', toolName: 'Write', result: 'ok', isError: false, structuredPatch: patch, parentAgentToolUseId: 'task-4', agentId: 'child-1' };
    s = chatReducer(s, result as any);
    s = chatReducer(s, result as any);   // duplicate delivery
    expect(s.get(SID)!.totals.linesAdded).toBe(0);
    expect(s.get(SID)!.totals.linesRemoved).toBe(0);
  });

  // Task 17: the two new totals fields, seen through the real reducer.
  // NOTE: there is no reducer path that calls addSubagentUsage yet — a
  // specialist's spend is meant to arrive as its own subagent-usage event
  // (see the WHY block above the addTurnUsage call in chat-reducer.ts), which
  // main does not emit yet. So what the reducer can be held to today is the
  // other half: a parent turn's cost is NEVER specialist spend, and a
  // specialist's own turn-complete still contributes nothing at all.
  it('a parent turn with a cost is not counted as specialist spend', () => {
    let s = start();
    s = chatReducer(s, turnComplete({ inputTokens: 100, outputTokens: 10, costUsd: 0.5 }, 'u10'));
    const totals = s.get(SID)!.totals;
    expect(totals.costUsd).toBeCloseTo(0.5, 10);
    expect(totals.specialistCostUsd).toBe(0);
    expect(totals.specialistRuns).toBe(0);
  });

  it('a SPECIALIST turn-complete adds no cost and no specialist spend — its own event owns that', () => {
    let s = start();
    s = chatReducer(s, {
      ...turnComplete({ inputTokens: 500, outputTokens: 50, costUsd: 0.9 }, 'u11'),
      parentAgentToolUseId: 'parent-tool-2',
      agentId: 'child-2',
    } as any);
    const totals = s.get(SID)!.totals;
    expect(totals.costUsd).toBe(0);
    expect(totals.specialistCostUsd).toBe(0);
  });

  it('carries a free-to-run turn through to the session totals', () => {
    let s = start();
    s = chatReducer(s, turnComplete({ inputTokens: 100, outputTokens: 10, free: true }, 'u12'));
    const totals = s.get(SID)!.totals;
    expect(totals.anyFree).toBe(true);
    expect(totals.anyUnpriced).toBe(false);
    expect(totals.anyPriced).toBe(false);
  });

  it('survives serialization', async () => {
    const { serializeChatState, deserializeChatState } = await import('../src/renderer/state/chat-types');
    let s = start();
    s = chatReducer(s, turnComplete({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 0 }, 'u9'));
    const back = deserializeChatState(serializeChatState(s));
    expect(back.get(SID)!.totals.inputTokens).toBe(7);
  });

  it('gives a pre-field snapshot empty totals rather than undefined', async () => {
    const { deserializeChatState, createSessionChatState } = await import('../src/renderer/state/chat-types');
    const legacy: any = { sessions: [[SID, { ...createSessionChatState(), toolCalls: [], toolGroups: [], assistantTurns: [], activeTurnToolIds: [], seenUuids: [], totals: undefined }]] };
    const back = deserializeChatState(legacy);
    expect(back.get(SID)!.totals.inputTokens).toBe(0);
  });
});
