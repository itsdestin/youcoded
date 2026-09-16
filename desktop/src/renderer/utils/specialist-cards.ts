import type { ToolCallState } from '../../shared/types';

/**
 * Specialists 1c: does this Task card hold a helper's ask that is waiting on
 * the user? Where it is read (checked 2026-09-16, Task 5a review — the old
 * comment named a ChatView hoist that no longer exists):
 *  - ToolCard force-opens the card once per ask, so the buttons are reachable;
 *  - AgentSections (ToolBody) opens the Activity section the ask lives in;
 *  - AssistantTurnBubble counts it in a folded group's "waiting on you" (the
 *    group's question icon), so an ask is never silent behind a fold.
 *  - PlanCard opens a plan specialist's row for its ask (the row renders as a
 *    Task-shaped card).
 * A plan CARD itself uses hasPlanChildAsk below instead.
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
