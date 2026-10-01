// One entry per transcript event type x payload variant the app actually sees.
// Shared by the characterisation test (tests/transcript-event-actions.test.ts) and
// the surface-parity test, so both walk the SAME events.
//
// WHY a matrix: `assistant-thinking` alone carries seven different payloads under
// one event type, and a type-level check cannot see which of them a translator
// forgot (the buddy forgot `promptProcessing` for exactly that reason).
import type { TranscriptEvent, TranscriptEventType } from '../../src/shared/types';

export interface MatrixCase {
  name: string;
  event: TranscriptEvent;
  /** What the surrounding window knew when the event arrived (compact-summary only). */
  ctx?: { compactionPending?: boolean; statuslineContextTokens?: number | null };
}

const SID = 's1';
const ev = (type: TranscriptEventType, data: Record<string, unknown> = {}): TranscriptEvent =>
  ({ type, sessionId: SID, uuid: `u-${type}`, timestamp: 1700, data }) as TranscriptEvent;

const stamp = { parentAgentToolUseId: 'parent-1', agentId: 'agent-1' };
const usage = { inputTokens: 10, outputTokens: 5 };

export const MATRIX: MatrixCase[] = [
  { name: 'user-message plain', event: ev('user-message', { text: 'hi' }) },
  { name: 'user-message slash command', event: ev('user-message', { text: '/x', slashCommand: true }) },
  { name: 'user-message injected', event: ev('user-message', { text: 'report', injected: true, injectedMeta: { from: 'helper' } }) },
  { name: 'user-message subagent-stamped', event: ev('user-message', { text: 'brief', ...stamp }) },

  { name: 'user-interrupt plain', event: ev('user-interrupt', { kind: 'plain' }) },
  { name: 'user-interrupt tool-use', event: ev('user-interrupt', { kind: 'tool-use' }) },
  { name: 'user-interrupt native with usage and no kind', event: ev('user-interrupt', { usage }) },

  { name: 'assistant-text plain', event: ev('assistant-text', { text: 'yo' }) },
  { name: 'assistant-text model and partId', event: ev('assistant-text', { text: 'yo', model: 'm1', partId: 'p1' }) },
  { name: 'assistant-text subagent-stamped', event: ev('assistant-text', { text: 'yo', ...stamp }) },

  { name: 'tool-use plain', event: ev('tool-use', { toolUseId: 't1', toolName: 'Read', toolInput: { path: 'a' } }) },
  { name: 'tool-use without input', event: ev('tool-use', { toolUseId: 't1', toolName: 'Read' }) },
  { name: 'tool-use subagent-stamped', event: ev('tool-use', { toolUseId: 't1', toolName: 'Read', toolInput: {}, ...stamp }) },

  { name: 'tool-result plain', event: ev('tool-result', { toolUseId: 't1', toolResult: 'ok', isError: false }) },
  { name: 'tool-result error with patch and task ids', event: ev('tool-result', { toolUseId: 't1', toolResult: 'bad', isError: true, structuredPatch: [{ oldStart: 1 }], backgroundTaskId: 'b1', resumedTaskId: 'r1' }) },
  { name: 'tool-result without result', event: ev('tool-result', { toolUseId: 't1' }) },
  { name: 'tool-result subagent-stamped', event: ev('tool-result', { toolUseId: 't1', toolResult: 'ok', ...stamp }) },

  { name: 'background-task ended', event: ev('background-task', { toolUseId: 't1', backgroundTask: { taskIds: ['a'], status: 'completed', summary: 's', result: 'r' }, parentAgentToolUseId: 'parent-1' }) },
  { name: 'background-task without payload', event: ev('background-task', {}) },

  { name: 'replay-complete idle', event: ev('replay-complete', { sessionIdle: true }) },
  { name: 'replay-complete not idle', event: ev('replay-complete', { sessionIdle: false }) },
  { name: 'replay-complete without data', event: { ...ev('replay-complete'), data: undefined } as unknown as TranscriptEvent },

  { name: 'turn-complete full', event: ev('turn-complete', { stopReason: 'end_turn', model: 'm1', anthropicRequestId: 'req', usage }) },
  { name: 'turn-complete minimal', event: ev('turn-complete', {}) },
  { name: 'turn-complete subagent-stamped', event: ev('turn-complete', { stopReason: 'end_turn', ...stamp }) },

  { name: 'subagent-usage with usage', event: ev('subagent-usage', { usage, model: 'm1', ...stamp }) },
  { name: 'subagent-usage without usage', event: ev('subagent-usage', { ...stamp }) },

  // assistant-thinking: ONE event type, seven payloads (plus the text one).
  { name: 'assistant-thinking reasoning text', event: ev('assistant-thinking', { text: 'hmm', partId: 'p1', parentAgentToolUseId: 'parent-1' }) },
  { name: 'assistant-thinking empty text is a heartbeat', event: ev('assistant-thinking', { text: '' }) },
  { name: 'assistant-thinking heartbeat', event: ev('assistant-thinking', {}) },
  { name: 'assistant-thinking stallWarning', event: ev('assistant-thinking', { stallWarning: { retryInMs: 5000, willRetry: true } }) },
  { name: 'assistant-thinking stalled', event: ev('assistant-thinking', { stalled: true }) },
  { name: 'assistant-thinking promptProcessing', event: ev('assistant-thinking', { promptProcessing: { promptTokens: 100, budgetMs: 5000, processed: 40 } }) },
  { name: 'assistant-thinking toolPreparing', event: ev('assistant-thinking', { toolPreparing: { toolCallId: 'c1', toolName: 'Write', chars: 12 } }) },
  { name: 'assistant-thinking toolPreparing cleared', event: ev('assistant-thinking', { toolPreparing: { toolCallId: 'c1', toolName: 'Write', chars: 0, cleared: true } }) },
  { name: 'assistant-thinking dropPart', event: ev('assistant-thinking', { dropPart: { partIds: ['p1', 'p2'] } }) },
  { name: 'assistant-thinking usageProgress', event: ev('assistant-thinking', { usageProgress: { contextUsedTokens: 900 } }) },
  { name: 'assistant-thinking toolPreparing and dropPart together', event: ev('assistant-thinking', { toolPreparing: { toolCallId: 'c1', toolName: 'Write', chars: 3 }, dropPart: { partIds: ['p1'] } }) },

  { name: 'session-error message only', event: ev('session-error', { text: 'boom' }) },
  { name: 'session-error with code and usage', event: ev('session-error', { text: 'boom', errorCode: 'openrouter-key-rejected', usage }) },
  { name: 'session-error without text', event: ev('session-error', {}) },

  { name: 'skill-invoked full', event: ev('skill-invoked', { skillId: 'brainstorm', displayName: 'Brainstorm', args: 'x', body: 'BODY', skillPath: '/p/SKILL.md' }) },
  { name: 'skill-invoked minimal', event: ev('skill-invoked', {}) },
  { name: 'skill-invoked id only', event: ev('skill-invoked', { skillId: 'only-id' }) },

  { name: 'context-clear old line', event: ev('context-clear', {}) },
  { name: 'context-clear with window after', event: ev('context-clear', { contextUsedAfter: 1234 }) },
  { name: 'context-clear with zero window after', event: ev('context-clear', { contextUsedAfter: 0 }) },

  { name: 'compact-summary pending, harness figures', event: ev('compact-summary', { summary: 'sum', contextUsedAfter: 100, contextUsedBefore: 900, usage }), ctx: { compactionPending: true, statuslineContextTokens: 777 } },
  { name: 'compact-summary pending, statusline fallback', event: ev('compact-summary', { summary: 'sum' }), ctx: { compactionPending: true, statuslineContextTokens: 777 } },
  { name: 'compact-summary pending, nothing known', event: ev('compact-summary', {}), ctx: { compactionPending: true } },
  { name: 'compact-summary not pending', event: ev('compact-summary', { summary: 'sum', contextUsedAfter: 100, contextUsedBefore: 900 }), ctx: { compactionPending: false } },
  { name: 'compact-summary automatic, not pending', event: ev('compact-summary', { summary: 'sum', autoCompaction: true, retainedFromUuid: 'keep-1', contextUsedAfter: 100, contextUsedBefore: 900, usage }), ctx: { compactionPending: false } },
  { name: 'compact-summary automatic with null retained uuid', event: ev('compact-summary', { autoCompaction: true, retainedFromUuid: null }), ctx: { compactionPending: false } },
  { name: 'compact-summary usage only', event: ev('compact-summary', { usage }), ctx: { compactionPending: false } },
];

/** Every event type the matrix covers, for completeness checks. */
export const MATRIX_TYPES = new Set(MATRIX.map((c) => c.event.type));
