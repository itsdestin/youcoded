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

// Answers keyed on the toolCalls Map itself: the reducer replaces that Map
// only when a tool card changes (never on streamed text), so a session whose
// cards did not change is answered without walking them again.
const openAskCache = new WeakMap<Map<string, ToolCallState>, boolean>();

/**
 * Specialists plans, Task 8 (review 6, Q6-1): is ANY specialist in this
 * conversation — a hired one (Task card) or a plan's (plan card) — waiting on
 * the user? The conversation's red dot, its alert sound and the buddy's
 * "awaiting approval" all follow this (useSessionAttention), the same as for
 * the assistant's own asks.
 *
 * WHY every card and not just the current turn's: a background specialist
 * asks after the turn that hired it has ended, so its card is no longer in
 * `activeTurnToolIds`. An answered, expired or resolved-elsewhere ask drops
 * its requestId / leaves 'awaiting-approval' (chat-reducer patchNestedAsk),
 * so the dot clears with it. A HELD ask (the specialist carried on without
 * it) is still answerable and still counts, as it does on the chip.
 */
export function hasOpenSpecialistAsk(toolCalls: Map<string, ToolCallState>): boolean {
  const cached = openAskCache.get(toolCalls);
  if (cached !== undefined) return cached;
  let found = false;
  for (const tool of toolCalls.values()) {
    if (hasNestedAsk(tool) || hasPlanChildAsk(tool)) { found = true; break; }
  }
  openAskCache.set(toolCalls, found);
  return found;
}
