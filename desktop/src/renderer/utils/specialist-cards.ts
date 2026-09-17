import type { SubagentSegment, ToolCallState } from '../../shared/types';

type ToolSegment = Extract<SubagentSegment, { type: 'tool' }>;

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
 *  - helperAsksOf (below) lifts the ask into the bottom-of-chat approval
 *    cards and the buddy's feed (master, 2026-09-16).
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
 * so the dot clears with it. (Merge note: master removed the 5-minute "held"
 * state, so an open ask simply stays open until answered or canceled.)
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

/**
 * True when any helper in the session is waiting on the user (see helperAsksOf).
 * Merge note (master + specialists plans): master scanned Task cards only; a
 * plan's specialist asks inside its plan card, so this now answers the same
 * question as hasOpenSpecialistAsk — the red dot, the bottom-of-chat cards and
 * this helper can never disagree about whether a specialist is waiting.
 */
export function hasHelperAsk(toolCalls: Map<string, ToolCallState>): boolean {
  return hasOpenSpecialistAsk(toolCalls);
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
    // Merge note (master + specialists plans): a plan's specialists ask from
    // inside the PLAN card (one card, many specialists, each segment tagged
    // with its childId). They wait for the user exactly like a hired
    // specialist, so they are lifted to the bottom too — otherwise the red
    // dot would say "waiting on you" with nothing to answer at the bottom
    // while the plan card sits folded several turns up.
    const plan = hasPlanChildAsk(card);
    if (!plan && !hasNestedAsk(card)) continue;
    for (const seg of card.subagentSegments!) {
      if (seg.type !== 'tool' || seg.status !== 'awaiting-approval' || !seg.requestId) continue;
      if (topLevel.has(seg.requestId)) continue;
      const kid = plan && seg.childId
        ? card.plan?.steps.flatMap((st) => st.children ?? []).find((c) => c.childId === seg.childId)
        : undefined;
      out.push({
        ...segmentToToolState(seg),
        specialist: plan
          ? {
            childId: seg.childId ?? id,
            agentType: kid?.agentType ?? 'specialist',
            title: kid?.title ?? 'A specialist',
          }
          : {
            childId: card.specialistRun?.childId ?? card.agentId ?? id,
            agentType: card.specialistRun?.agentType ?? 'specialist',
            title: card.specialistRun?.title ?? 'A specialist',
          },
      });
    }
  }
  return out;
}
