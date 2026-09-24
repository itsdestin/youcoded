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
 *    turn that finished hours ago. Accepted consequence: a failed turn's usage
 *    (carried on `session-error` since 2026-09-16) does not replay, so a resumed
 *    session's totals are short by it. Replaying the event to recover the tokens
 *    would also re-raise an error banner for a failure the user already saw and
 *    moved past, which is the worse trade. The INTERRUPT path has no such
 *    conflict and does replay.
 *  - `compact-summary` draws no MARKER, matching what the old whole-file replay
 *    did: App only dispatches COMPACTION_COMPLETE when `compactionPending` is
 *    set (i.e. the user just ran /compact in THIS window) or the compaction was
 *    spontaneous — neither is true for a page. Its bookkeeping half DOES replay;
 *    see the case below.
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
        // Replayed like turn-complete's usage, and deduped the same way, so a
        // resumed session's totals include the turns the user interrupted.
        usage: d.usage,
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
        backgroundTaskId: d.backgroundTaskId,
        resumedTaskId: d.resumedTaskId,
        parentAgentToolUseId: d.parentAgentToolUseId,
        agentId: d.agentId,
      } as ChatAction;
    case 'background-task':
      // Claude Code: background work ended. Replayable — it only settles a
      // card (and records the outcome for a card on an older page).
      if (!d.backgroundTask) return null;
      return {
        type: 'TRANSCRIPT_BACKGROUND_TASK',
        sessionId: event.sessionId,
        uuid: event.uuid,
        toolUseId: d.toolUseId,
        taskIds: d.backgroundTask.taskIds,
        status: d.backgroundTask.status,
        summary: d.backgroundTask.summary,
        result: d.backgroundTask.result,
        parentAgentToolUseId: d.parentAgentToolUseId,
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
    case 'subagent-usage':
      // A delegated run's whole spend. Pure bookkeeping — no timeline, no turn
      // state — so unlike the live conditions above it is perfectly replayable.
      //
      // Fix (2026-09-16): this case was MISSING, so every specialist's tokens
      // and dollars vanished from a session's totals the moment its history came
      // from a page instead of the live stream — i.e. on every resume and every
      // reopen. The comment on App.tsx's live case still claimed it "replays
      // from the parent's record on resume like any other persisted event",
      // which was true until paging replaced whole-file replay. The reducer
      // dedups on uuid, and HISTORY_PAGE_LOADED seeds the scratch state with the
      // live seenUuids, so a page that overlaps the live stream cannot
      // double-count.
      return {
        type: 'TRANSCRIPT_SUBAGENT_USAGE',
        sessionId: event.sessionId,
        uuid: event.uuid,
        timestamp: event.timestamp,
        usage: d.usage ?? null,
        parentAgentToolUseId: d.parentAgentToolUseId,
        agentId: (d as any).agentId,
      } as ChatAction;
    case 'compact-summary':
      // No marker (see the header): App only draws one for a compaction that
      // happened in THIS window. But the summarize call's own bill and the
      // window it left behind are facts about the record, so they replay — the
      // totals otherwise shrank every time a compacted session was reopened.
      // The re-based occupancy is discarded by HISTORY_PAGE_LOADED's explicit
      // merge (the live session's own value wins), which is what stops an OLDER
      // page's compaction from stomping the current gauge.
      if (d.contextUsedAfter === undefined && !d.usage) return null;
      return {
        type: 'NATIVE_HISTORY_REWRITTEN',
        sessionId: event.sessionId,
        uuid: event.uuid,
        contextUsedTokens: d.contextUsedAfter ?? null,
        usage: d.usage,
      } as ChatAction;
    default:
      return null;
  }
}
