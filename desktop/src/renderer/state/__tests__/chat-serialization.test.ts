import { describe, it, expect } from 'vitest';
import {
  createSessionChatState,
  serializeChatState,
  deserializeChatState,
} from '../chat-types';
import type { ChatState, ToolCallState } from '../chat-types';
import { chatReducer } from '../chat-reducer';
import type { PlanView } from '../../../shared/types';

describe('chat state serialization', () => {
  it('round-trips an empty ChatState', () => {
    const state: ChatState = new Map();
    const round = deserializeChatState(serializeChatState(state));
    expect(round).toEqual(state);
  });

  it('round-trips a turn carrying every segment kind, with the plan segment intact', () => {
    // The earlier round-trip used `segments: []`, so nothing pinned that a
    // POPULATED segment list survives the JSON hop — and `plan` is the one that
    // carries fields beyond content/messageId, which is exactly what a lossy
    // serializer would quietly drop.
    const session = createSessionChatState();
    session.assistantTurns.set('turn-1', {
      id: 'turn-1',
      segments: [
        { type: 'text', content: 'hello', messageId: 'm1' },
        { type: 'reasoning', content: 'thinking', messageId: 'm2' },
        { type: 'tool-group', groupId: 'g1' },
        { type: 'plan', content: '# Plan', messageId: 'm3', planFilePath: '/p/plan.md', allowedPrompts: ['go'] },
      ],
      timestamp: 1,
      stopReason: null,
      model: null,
      usage: null,
      anthropicRequestId: null,
    } as never);
    const state: ChatState = new Map([['session-a', session]]);

    const serialized = serializeChatState(state);
    const json = JSON.stringify(serialized);
    expect(json).toContain('"type":"plan"');
    const round = deserializeChatState(JSON.parse(json));

    expect(round.get('session-a')!.assistantTurns.get('turn-1')!.segments)
      .toEqual(session.assistantTurns.get('turn-1')!.segments);
  });

  it('round-trips a session with tool calls, turns, and an active turn set', () => {
    const session = createSessionChatState();
    const toolCall: ToolCallState = {
      id: 'tool-1',
      name: 'Bash',
      status: 'success',
      input: { command: 'ls' },
      result: 'file.txt',
    } as any;
    session.toolCalls.set('tool-1', toolCall);
    session.activeTurnToolIds.add('tool-1');
    session.assistantTurns.set('turn-1', {
      id: 'turn-1',
      segments: [],
      timestamp: 123,
      stopReason: null,
      model: null,
      usage: null,
      anthropicRequestId: null,
    });
    session.timeline.push({ kind: 'assistant-turn', turnId: 'turn-1' });
    session.isThinking = true;
    session.attentionState = 'stuck';
    session.compactionPending = { startedAt: 456, beforeContextTokens: 1000 };
    const state: ChatState = new Map([['session-a', session]]);

    const serialized = serializeChatState(state);
    const viaJson = JSON.parse(JSON.stringify(serialized));
    const round = deserializeChatState(viaJson);

    const restored = round.get('session-a')!;
    expect(restored.toolCalls.get('tool-1')).toEqual(toolCall);
    expect(restored.activeTurnToolIds.has('tool-1')).toBe(true);
    expect(restored.assistantTurns.get('turn-1')?.timestamp).toBe(123);
    expect(restored.timeline).toEqual([{ kind: 'assistant-turn', turnId: 'turn-1' }]);
    expect(restored.isThinking).toBe(true);
    expect(restored.attentionState).toBe('stuck');
    expect(restored.compactionPending).toEqual({ startedAt: 456, beforeContextTokens: 1000 });
  });

  it('round-trips the transcript-dedup seenUuids set', () => {
    // Remote clients hydrate from this snapshot, then keep receiving the live
    // transcript:event broadcast — an event already baked into the snapshot
    // could be re-delivered live, so the dedup set must cross the wire.
    const session = createSessionChatState();
    session.seenUuids.add('uuid-a');
    session.seenUuids.add('uuid-b');
    const state: ChatState = new Map([['session-a', session]]);

    const viaJson = JSON.parse(JSON.stringify(serializeChatState(state)));
    const restored = deserializeChatState(viaJson).get('session-a')!;

    expect(restored.seenUuids).toBeInstanceOf(Set);
    expect(restored.seenUuids.has('uuid-a')).toBe(true);
    expect(restored.seenUuids.has('uuid-b')).toBe(true);
  });

  it('defaults seenUuids to an empty Set when hydrating a pre-field snapshot', () => {
    // Older desktop hosts predate seenUuids — a snapshot without the field must
    // deserialize to an empty Set, not undefined (which would crash .has()).
    const legacy = { sessions: [['session-a', {
      timeline: [], toolCalls: [], toolGroups: [], assistantTurns: [],
      isThinking: false, streamingText: '', currentGroupId: null, currentTurnId: null,
      lastActivityAt: 0, activeTurnToolIds: [], attentionState: 'ok',
      errorMessage: null, lastBufferActivityAt: 0, compactionPending: null,
    }]] } as any;
    const restored = deserializeChatState(legacy).get('session-a')!;
    expect(restored.seenUuids).toBeInstanceOf(Set);
    expect(restored.seenUuids.size).toBe(0);
  });
  // Specialists plans, Task 5a: a remote client learns a plan card's state from
  // the JSON chat:hydrate snapshot (no parallel plan replay), then keeps
  // receiving plans:event and the stamped specialist events live. Both halves
  // must survive the hop: the record and the per-specialist rows, and a delta
  // after the snapshot must still land on the hydrated card.
  it('round-trips a plan card through JSON chat:hydrate, and later deltas still land', () => {
    const plan = (over: Partial<PlanView>): PlanView => ({
      planId: 'plan-1', toolUseId: 'call-plan', title: 'Review', status: 'running', seq: 4,
      steps: [{ id: 's1', kind: 'map', title: 'Review', specialist: 'reviewer', fanOut: 1, status: 'running',
        children: [{ childId: 'kid', parentToolCallId: 'call-plan', agentType: 'reviewer', title: 'Kid', background: false, status: 'running', startedAt: 1,
          planAttempt: { stepId: 's1', attemptId: 'a1', itemIndex: 0, iteration: 0 } }] }],
      model: { label: 'm' }, paused: undefined,
      ...over,
    });
    const act = (s: ChatState, ...a: any[]) => a.reduce((acc, x) => chatReducer(acc, x), s);
    let host: ChatState = act(new Map(),
      { type: 'SESSION_INIT', sessionId: 'sa' },
      { type: 'TRANSCRIPT_TOOL_USE', sessionId: 'sa', uuid: 'u1', toolUseId: 'call-plan', toolName: 'propose_plan', toolInput: {} },
      { type: 'PLAN_CHANGED', sessionId: 'sa', plan: plan({}) },
      { type: 'TRANSCRIPT_TOOL_USE', sessionId: 'sa', uuid: 'c1', toolUseId: 'call_0', toolName: 'Bash', toolInput: { command: 'rm -rf build' }, timestamp: 5, parentAgentToolUseId: 'call-plan', agentId: 'kid' },
      { type: 'PERMISSION_REQUEST', sessionId: 'sa', toolName: 'Bash', input: { command: 'rm -rf build' }, requestId: 'req',
        specialist: { childId: 'kid', agentType: 'reviewer', title: 'Kid', parentToolCallId: 'call-plan', plan: { planId: 'plan-1', stepId: 's1', attemptId: 'a1' } } },
    );
    const json = JSON.stringify(serializeChatState(host));
    let phone: ChatState = act(new Map(), { type: 'HYDRATE_CHAT_STATE', sessions: JSON.parse(json) });
    const card = () => phone.get('sa')!.toolCalls.get('call-plan')!;
    expect(card().plan).toEqual(host.get('sa')!.toolCalls.get('call-plan')!.plan);
    expect(card().subagentSegments).toEqual([
      expect.objectContaining({ childId: 'kid', toolUseId: 'call_0', status: 'awaiting-approval', requestId: 'req' }),
    ]);
    // Post-snapshot deltas: a stale record is refused, a newer one lands, the
    // ask is answered, and more of the specialist's work arrives in its row.
    phone = act(phone,
      { type: 'PLAN_CHANGED', sessionId: 'sa', plan: plan({ status: 'proposed', seq: 2 }) },
      { type: 'PLAN_CHANGED', sessionId: 'sa', plan: plan({ status: 'paused', seq: 5, paused: { stepId: 's1', reason: 'reached its limit' } }) },
      { type: 'PERMISSION_RESPONDED', sessionId: 'sa', requestId: 'req' },
      { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: 'sa', uuid: 't1', text: 'done', timestamp: 6, partId: 'p', parentAgentToolUseId: 'call-plan', agentId: 'kid' },
    );
    expect(card().plan).toMatchObject({ status: 'paused', seq: 5 });
    expect(card().subagentSegments).toEqual([
      expect.objectContaining({ childId: 'kid', toolUseId: 'call_0', status: 'running' }),
      expect.objectContaining({ childId: 'kid', type: 'text', content: 'done' }),
    ]);
  });
});
