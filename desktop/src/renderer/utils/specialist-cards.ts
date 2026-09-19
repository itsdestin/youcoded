import type { SubagentSegment, ToolCallState } from '../../shared/types';

type ToolSegment = Extract<SubagentSegment, { type: 'tool' }>;

/** Specialists plans: a `propose_plan` card — its specialists' rows are keyed
 *  by child. Final review F32: the ONE copy of this test (the reducer, the
 *  plan card and the Specialists chip all read it). */
export function isPlanCard(tool: ToolCallState): boolean {
  return tool.toolName === 'propose_plan';
}

/**
 * Decision 28: a plan attempt that ended without ever producing a plan. Its
 * only record is the card's own projection — `writing:<toolUseId>`, minted by
 * the harness's writingPlanProjection and terminalized in place — so there is
 * no journal entry, no steps and nothing to approve. A plan the host really
 * journalled has its own planId and is never one of these, whatever state it
 * later reaches.
 */
export function isSpentPlanShell(tool: ToolCallState): boolean {
  if (!isPlanCard(tool)) return false;
  // No record at all counts: the card can only be the shell of an attempt.
  if (!tool.plan) return true;
  return tool.plan.planId.startsWith('writing:') && tool.plan.status !== 'writing';
}

/**
 * Decision 29: a plan AWAITING APPROVAL is drawn as the last thing in the
 * chat, the way an unanswered permission prompt is, and snaps back to its
 * place once answered. Only `proposed` lifts — a running, paused, interrupted
 * or finished plan is a record of what happened, not a decision to make.
 */
function isLiftedPlan(tool: ToolCallState): boolean {
  return isPlanCard(tool) && tool.plan?.status === 'proposed';
}

/**
 * Should this card be left out of its place in the conversation timeline?
 * ONE function so the chat, the buddy feed and the "does this bubble paint
 * anything" test cannot drift — the same reason awaiting-approval tools are
 * filtered in exactly two mirrored places.
 *
 * `turnLive` = this card's turn is the one still running. A spent plan shell
 * is hidden only then: the assistant has one automatic repair left, and a
 * failure it fixes by itself is never shown (decision 28). When the turn ends
 * with no usable plan the same card is drawn, once, where it always was.
 *
 * `liftsPlans` = this timeline has a bottom to lift a proposal to. A read-only
 * preview does not, so there a proposal stays in its place rather than
 * disappearing.
 */
export function hiddenFromTimeline(tool: ToolCallState, turnLive: boolean, liftsPlans: boolean): boolean {
  return (liftsPlans && isLiftedPlan(tool)) || (turnLive && isSpentPlanShell(tool));
}

/**
 * Every plan waiting for Approve / Comment in this conversation, drawn at the
 * bottom of the chat. Scans ALL cards, not the active turn, because decision
 * 29 keeps a proposal following the bottom until it is answered — losing a
 * plan you were about to approve is worse than seeing it twice.
 */
export function proposedPlansOf(toolCalls: Map<string, ToolCallState>): ToolCallState[] {
  const out: ToolCallState[] = [];
  for (const tool of toolCalls.values()) if (isLiftedPlan(tool)) out.push(tool);
  return out;
}

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
  if (!isPlanCard(tool) || !tool.subagentSegments) return false;
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
