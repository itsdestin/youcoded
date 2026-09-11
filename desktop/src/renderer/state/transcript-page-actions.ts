import type { TranscriptEvent } from '../../shared/types';
import type { ChatAction } from './chat-types';

/**
 * One TranscriptEvent from a history PAGE -> the reducer action that renders it.
 *
 * This is the page-replay mirror of App.tsx's live `switch (event.type)` (search
 * `transcriptHandler`). It deliberately covers only what a page off disk can
 * contain, and returns null for everything else:
 *
 *  - heartbeats (`assistant-thinking` with no text), `session-error`,
 *    `replay-complete` and the native progress events are LIVE conditions. A
 *    page is history; replaying "the model is thinking" from disk would park a
 *    turn that finished hours ago.
 *  - `compact-summary` maps to nothing, matching what the old whole-file replay
 *    did: App only dispatches COMPACTION_COMPLETE when `compactionPending` is
 *    set (i.e. the user just ran /compact in THIS window) or the compaction was
 *    spontaneous — neither is true for a page.
 *
 * WHY a second mapping instead of reusing App's switch: App's cases are wired
 * into rAF batching and read live state (`chatStateMapRef`, `statusData`), so
 * they are not extractable without touching the streaming hot path that cycle 1
 * just tuned. Keep the two in sync — the payload fields here are pinned by
 * tests/history-paging-reducer.test.ts and tests/transcript-page-actions.test.ts.
 */
export function pageEventToAction(event: TranscriptEvent): ChatAction | null {
  const d = event.data;
  switch (event.type) {
    case 'user-message':
      return {
        type: 'TRANSCRIPT_USER_MESSAGE',
        sessionId: event.sessionId,
        uuid: event.uuid,
        text: d.text ?? '',
        timestamp: event.timestamp,
        // Mirrors App.tsx: a slash command read from its command tags starts no turn.
        slashCommand: d.slashCommand,
        injected: d.injected,
        injectedMeta: d.injectedMeta,
        parentAgentToolUseId: d.parentAgentToolUseId,
        agentId: d.agentId,
      } as ChatAction;
    case 'user-interrupt':
      return {
        type: 'TRANSCRIPT_INTERRUPT',
        sessionId: event.sessionId,
        uuid: event.uuid,
        timestamp: event.timestamp,
        kind: (d as any).kind,
      } as ChatAction;
    case 'assistant-text':
      return {
        type: 'TRANSCRIPT_ASSISTANT_TEXT',
        sessionId: event.sessionId,
        uuid: event.uuid,
        text: d.text ?? '',
        timestamp: event.timestamp,
        model: d.model,
        partId: d.partId,
        parentAgentToolUseId: d.parentAgentToolUseId,
        agentId: d.agentId,
      } as ChatAction;
    case 'assistant-thinking':
      // Text = real reasoning content, which belongs in history. No text = a
      // lifecycle heartbeat, which does not.
      if (!d.text) return null;
      return {
        type: 'TRANSCRIPT_ASSISTANT_REASONING',
        sessionId: event.sessionId,
        uuid: event.uuid,
        text: d.text,
        timestamp: event.timestamp,
        partId: d.partId,
        parentAgentToolUseId: d.parentAgentToolUseId,
      } as ChatAction;
    case 'tool-use':
      return {
        type: 'TRANSCRIPT_TOOL_USE',
        sessionId: event.sessionId,
        uuid: event.uuid,
        toolUseId: d.toolUseId,
        toolName: d.toolName,
        toolInput: d.toolInput || {},
        // Same stamp App.tsx's live path forwards — a replayed page must
        // order a helper's notes among its tool rows exactly like live did.
        timestamp: event.timestamp,
        parentAgentToolUseId: d.parentAgentToolUseId,
        agentId: d.agentId,
      } as ChatAction;
    case 'tool-result':
      return {
        type: 'TRANSCRIPT_TOOL_RESULT',
        sessionId: event.sessionId,
        uuid: event.uuid,
        toolUseId: d.toolUseId,
        result: d.toolResult || '',
        isError: d.isError || false,
        structuredPatch: d.structuredPatch,
        parentAgentToolUseId: d.parentAgentToolUseId,
        agentId: d.agentId,
      } as ChatAction;
    case 'turn-complete':
      return {
        type: 'TRANSCRIPT_TURN_COMPLETE',
        sessionId: event.sessionId,
        uuid: event.uuid,
        timestamp: event.timestamp,
        stopReason: d.stopReason ?? null,
        model: d.model ?? null,
        anthropicRequestId: d.anthropicRequestId ?? null,
        usage: d.usage ?? null,
        parentAgentToolUseId: d.parentAgentToolUseId,
        agentId: d.agentId,
      } as ChatAction;
    case 'skill-invoked':
      return {
        type: 'TRANSCRIPT_SKILL_INVOKED',
        sessionId: event.sessionId,
        uuid: event.uuid,
        timestamp: event.timestamp,
        skillId: (d as any).skillId ?? 'skill',
        displayName: (d as any).displayName ?? (d as any).skillId ?? 'Skill',
        args: (d as any).args,
        skillPath: (d as any).skillPath,
      } as ChatAction;
    case 'context-clear':
      // The durable /clear barrier. It fires during history replay too — that
      // is what makes a resumed session show the post-clear view the user left
      // behind instead of resurrecting the conversation before it.
      return {
        type: 'CLEAR_TIMELINE',
        sessionId: event.sessionId,
        markerId: `clear-${event.uuid}`,
        timestamp: event.timestamp,
      } as ChatAction;
    default:
      return null;
  }
}
