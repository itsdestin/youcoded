import type { SubagentSegment, ToolCallState } from '../../shared/types';

type ToolSegment = Extract<SubagentSegment, { type: 'tool' }>;

/**
 * Specialists 1c: does this Task card hold a helper's ask that is waiting on
 * the user? The card opens itself when it does (ToolCard, AgentSections).
 */
export function hasNestedAsk(tool: ToolCallState): boolean {
  if (tool.toolName !== 'Task' || !tool.subagentSegments) return false;
  return tool.subagentSegments.some(s => s.type === 'tool' && s.status === 'awaiting-approval' && !!s.requestId);
}

/** True when any helper in the session is waiting on the user (see helperAsksOf). */
export function hasHelperAsk(toolCalls: Map<string, ToolCallState>): boolean {
  for (const card of toolCalls.values()) if (hasNestedAsk(card)) return true;
  return false;
}

/** One helper row as the ToolCallState shape the tool views and ToolCard read. */
export function segmentToToolState(segment: ToolSegment): ToolCallState {
  return {
    toolUseId: segment.toolUseId,
    toolName: segment.toolName,
    input: segment.input,
    status: segment.status,
    response: segment.response,
    error: segment.error,
    structuredPatch: segment.structuredPatch,
    // Specialists 1c: the ask fields ride along so ToolBody's per-tool views
    // (and friendlyToolDisplay) see the same shape a top-level card has.
    requestId: segment.requestId,
    denyListed: segment.denyListed,
    external: segment.external,
    noAlwaysAllow: segment.noAlwaysAllow,
    permissionMode: segment.permissionMode,
  };
}

/**
 * Every helper request waiting on the user, in any Task card of the session,
 * as top-level-shaped cards carrying `specialist` (so ToolCard says "Wren …
 * wants to:"). WHY: a helper's request used to exist only inside its Task
 * card — often a background hire's card several turns up, folded into a tool
 * group — while the bottom-of-chat approval cards and the red session dot only
 * looked at the main assistant's own tools. Nothing told the user it was
 * there. Scans ALL cards, not the active turn: a background helper keeps
 * working (and asking) after the turn that hired it ended.
 */
export function helperAsksOf(toolCalls: Map<string, ToolCallState>): ToolCallState[] {
  const out: ToolCallState[] = [];
  // A request can ALSO be a top-level card: the reducer mints one when the
  // helper's Task card isn't loaded yet, and it lingers after the Task card
  // arrives (e.g. older history paged in). That card is already shown at the
  // bottom — skip its nested twin so one request never shows twice.
  const topLevel = new Set<string>();
  for (const t of toolCalls.values()) {
    if (t.status === 'awaiting-approval' && t.requestId) topLevel.add(t.requestId);
  }
  for (const [id, card] of toolCalls) {
    if (!hasNestedAsk(card)) continue;
    for (const seg of card.subagentSegments!) {
      if (seg.type !== 'tool' || seg.status !== 'awaiting-approval' || !seg.requestId) continue;
      if (topLevel.has(seg.requestId)) continue;
      out.push({
        ...segmentToToolState(seg),
        specialist: {
          childId: card.specialistRun?.childId ?? card.agentId ?? id,
          agentType: card.specialistRun?.agentType ?? 'specialist',
          title: card.specialistRun?.title ?? 'A specialist',
        },
      });
    }
  }
  return out;
}
