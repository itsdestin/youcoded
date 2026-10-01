import { describe, it, expect } from 'vitest';
import { pageEventToAction } from '../src/renderer/state/transcript-page-actions';
import type { TranscriptEvent, TranscriptEventType, DataOf, EventOf } from '../src/shared/types';
import { ev as mkEv, malformedEv } from './helpers/transcript-events';

const ev = <T extends TranscriptEventType>(type: T, data: DataOf<T>): EventOf<T> =>
  mkEv(type, data, { sessionId: 's', uuid: 'u', timestamp: 7 });
// Deliberately minimal / legacy shapes: pins how the page path copes, so they must not satisfy the union.
const loose = (type: string, data: Record<string, unknown>): TranscriptEvent =>
  malformedEv(type, data, { sessionId: 's', uuid: 'u', timestamp: 7 });

describe('pageEventToAction', () => {
  it('maps each renderable event type to its reducer action', () => {
    expect(pageEventToAction(ev('user-message', { text: 'hi' }))!.type).toBe('TRANSCRIPT_USER_MESSAGE');
    expect(pageEventToAction(ev('user-interrupt', { kind: 'plain' }))!.type).toBe('TRANSCRIPT_INTERRUPT');
    expect(pageEventToAction(ev('assistant-text', { text: 'yo' }))!.type).toBe('TRANSCRIPT_ASSISTANT_TEXT');
    expect(pageEventToAction(ev('assistant-thinking', { text: 'hmm' }))!.type).toBe('TRANSCRIPT_ASSISTANT_REASONING');
    expect(pageEventToAction(ev('tool-use', { toolUseId: 't', toolName: 'Read', toolInput: {} }))!.type).toBe('TRANSCRIPT_TOOL_USE');
    expect(pageEventToAction(ev('tool-result', { toolUseId: 't', toolResult: 'ok', isError: false }))!.type).toBe('TRANSCRIPT_TOOL_RESULT');
    expect(pageEventToAction(ev('turn-complete', {}))!.type).toBe('TRANSCRIPT_TURN_COMPLETE');
    expect(pageEventToAction(ev('skill-invoked', { skillId: 'x', displayName: 'X', body: 'b' }))!.type).toBe('TRANSCRIPT_SKILL_INVOKED');
    expect(pageEventToAction(ev('context-clear', {}))!.type).toBe('CLEAR_TIMELINE');
  });

  it('drops live-only conditions — a page is history, not a running turn', () => {
    // A heartbeat replayed from disk would park or spin a turn that ended hours ago.
    expect(pageEventToAction(ev('assistant-thinking', {}))).toBeNull();
    expect(pageEventToAction(ev('assistant-thinking', { stallWarning: { retryInMs: 1, willRetry: true } }))).toBeNull();
    expect(pageEventToAction(ev('session-error', { text: 'boom' }))).toBeNull();
    expect(pageEventToAction(ev('replay-complete', { sessionIdle: false }))).toBeNull();
    // compact-summary matches what the old whole-file replay did: App only
    // dispatches COMPACTION_COMPLETE when THIS window has a /compact pending.
    expect(pageEventToAction(ev('compact-summary', { summary: 's' }))).toBeNull();
  });

  it('forwards the subagent stamp so a child\'s work routes into its Agent card', () => {
    for (const t of ['user-message', 'assistant-text', 'tool-use', 'tool-result', 'turn-complete']) {
      const a = pageEventToAction(loose(t, { text: 'x', toolUseId: 't', parentAgentToolUseId: 'parent-1' })) as any;
      expect(a.parentAgentToolUseId).toBe('parent-1');
    }
  });
});
