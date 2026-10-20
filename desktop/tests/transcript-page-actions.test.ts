import { describe, it, expect } from 'vitest';
import { pageEventToActions } from '../src/renderer/state/transcript-page-actions';
import type { TranscriptEvent, TranscriptEventType, DataOf, EventOf } from '../src/shared/types';
import { ev as mkEv, malformedEv } from './helpers/transcript-events';

const ev = <T extends TranscriptEventType>(type: T, data: DataOf<T>): EventOf<T> =>
  mkEv(type, data, { sessionId: 's', uuid: 'u', timestamp: 7 });
// Deliberately minimal / legacy shapes: pins how the page path copes, so they must not satisfy the union.
const loose = (type: string, data: Record<string, unknown>): TranscriptEvent =>
  malformedEv(type, data, { sessionId: 's', uuid: 'u', timestamp: 7 });

describe('pageEventToActions', () => {
  it('maps each renderable event type to its reducer action', () => {
    expect(pageEventToActions(ev('user-message', { text: 'hi' }))[0].type).toBe('TRANSCRIPT_USER_MESSAGE');
    expect(pageEventToActions(ev('user-interrupt', { kind: 'plain' }))[0].type).toBe('TRANSCRIPT_INTERRUPT');
    expect(pageEventToActions(ev('assistant-text', { text: 'yo' }))[0].type).toBe('TRANSCRIPT_ASSISTANT_TEXT');
    expect(pageEventToActions(ev('assistant-thinking', { text: 'hmm' }))[0].type).toBe('TRANSCRIPT_ASSISTANT_REASONING');
    expect(pageEventToActions(ev('tool-use', { toolUseId: 't', toolName: 'Read', toolInput: {} }))[0].type).toBe('TRANSCRIPT_TOOL_USE');
    expect(pageEventToActions(ev('tool-result', { toolUseId: 't', toolResult: 'ok', isError: false }))[0].type).toBe('TRANSCRIPT_TOOL_RESULT');
    expect(pageEventToActions(ev('turn-complete', {}))[0].type).toBe('TRANSCRIPT_TURN_COMPLETE');
    expect(pageEventToActions(ev('skill-invoked', { skillId: 'x', displayName: 'X', body: 'b' }))[0].type).toBe('TRANSCRIPT_SKILL_INVOKED');
    expect(pageEventToActions(ev('context-clear', {}))[0].type).toBe('CLEAR_TIMELINE');
  });

  it('drops live-only conditions — a page is history, not a running turn', () => {
    // A heartbeat replayed from disk would park or spin a turn that ended hours ago.
    expect(pageEventToActions(ev('assistant-thinking', {}))).toEqual([]);
    expect(pageEventToActions(ev('assistant-thinking', { stallWarning: { retryInMs: 1, willRetry: true } }))).toEqual([]);
    expect(pageEventToActions(ev('session-error', { text: 'boom' }))).toEqual([]);
    expect(pageEventToActions(ev('replay-complete', { sessionIdle: false }))).toEqual([]);
  });

  it('restores a saved summary boundary even without a pending spinner', () => {
    expect(pageEventToActions(ev('compact-summary', { summary: 's', contextUsedAfter: 100 }))).toEqual([
      expect.objectContaining({ type: 'NATIVE_HISTORY_REWRITTEN', contextUsedTokens: 100 }),
      expect.objectContaining({ type: 'COMPACTION_COMPLETE', recorded: true,
        timestamp: 7, markerId: 'compact-done-u', summary: 's' }),
    ]);
  });

  it.each([
    { contextUsedAfter: null },
    { contextUsedBefore: null },
    { autoCompaction: false },
    { retainedFromUuid: null },
    { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } },
  ])('recognizes native summary evidence even when it is false or unknown (%j)', (evidence) => {
    expect(pageEventToActions(loose('compact-summary', { summary: 'Native summary', ...evidence })))
      .toContainEqual(expect.objectContaining({ type: 'COMPACTION_COMPLETE', recorded: true }));
  });

  it('keeps synthetic Claude Code resume summaries suppressed on pages', () => {
    expect(pageEventToActions(ev('compact-summary', { summary: 'Resume summary' }))).toEqual([]);
  });

  it('forwards the subagent stamp so a child\'s work routes into its Agent card', () => {
    for (const t of ['user-message', 'assistant-text', 'tool-use', 'tool-result', 'turn-complete']) {
      const a = pageEventToActions(loose(t, { text: 'x', toolUseId: 't', parentAgentToolUseId: 'parent-1' }))[0] as any;
      expect(a.parentAgentToolUseId).toBe('parent-1');
    }
  });
});
