import type { ToolCallState } from '../../shared/types';

/**
 * Specialists 1c: does this Task card hold a helper's ask that is waiting on
 * the user? Such a card is hoisted to the bottom of the timeline (ChatView)
 * and skipped by its tool group (AssistantTurnBubble) — the SAME treatment a
 * top-level 'awaiting-approval' card gets, so an ask nested under a background
 * hire is never buried in a collapsed group three turns up.
 */
export function hasNestedAsk(tool: ToolCallState): boolean {
  if (tool.toolName !== 'Task' || !tool.subagentSegments) return false;
  return tool.subagentSegments.some(s => s.type === 'tool' && s.status === 'awaiting-approval' && !!s.requestId);
}

/**
 * Specialists plans, Task 5a: does this PLAN card hold a specialist's ask that
 * is waiting on the user? Kept apart from hasNestedAsk on purpose: that one
 * force-opens a Task card's body, and a plan card's body is its raw input —
 * the plan itself is already the card's face. The tool group uses this to say
 * "waiting on you"; the plan card opens the asking row itself (PlanCard.tsx).
 */
export function hasPlanChildAsk(tool: ToolCallState): boolean {
  if (tool.toolName !== 'propose_plan' || !tool.subagentSegments) return false;
  return tool.subagentSegments.some(s => s.type === 'tool' && s.status === 'awaiting-approval' && !!s.requestId);
}
