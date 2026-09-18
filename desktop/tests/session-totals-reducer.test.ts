import { describe, it, expect } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { ChatState } from '../src/renderer/state/chat-types';

const SID = 's1';
const start = (): ChatState => chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: SID });

const turnComplete = (usage: any, uuid: string) => ({
  type: 'TRANSCRIPT_TURN_COMPLETE' as const,
  sessionId: SID, uuid, timestamp: 1,
  stopReason: 'end_turn', model: 'm', anthropicRequestId: null, usage,
});

describe('reducer session totals', () => {
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
