// Specialists plans, Task 9b — what the assistant is told when a paused plan
// is handed to it (pause handoff design §2, step 4).
//
// Destin's direction (deck 6 follow-up): a pause that needs a decision goes to
// the assistant FIRST. It looks into it and puts the button it recommends on
// the card (or proposes a revised plan); the user still presses every button.
//
// WHY one pinned template (review 1, finding 13): the notice is text the model
// reads as a user-role turn. Everything in it is either a fact the journal
// holds (title, step, kind, numbers, ids, the allowed actions) or the
// provider/tool detail, which is wrapped and marked as untrusted and capped —
// a hostile web page or tool output must never read as the user's instruction.
// Specialist report text is never included: it is model output about the
// work, not a fact about the pause.
import {
  PLAN_ASK_DETAIL_HEADER, PLAN_ASK_NOTICE_LEAD, PLAN_ASK_QUESTION_CLOSE, PLAN_ASK_QUESTION_LABEL, PLAN_ASK_QUESTION_OPEN,
  PLAN_COMPLETE_NOTICE_PREFIX, PLAN_QUESTION_MAX_CHARS, PLAN_RUNNING_NOTICE_PREFIX, type PlanPauseKind,
} from '../../../shared/types';
import { projectPlan } from './plan-journal';
import { pausedRouting } from './pause-routing';
// Issue 1 fix: the completion notice's final result is built from the SAME
// bounded, labelled shape a verify/combine step already reads an earlier
// step's report in (see plan-executor.ts's own WHY comment on both exports).
import { finalStepReportsText, planRunSummary } from './plan-executor';
import type { PlanRecord } from './types';

/** §2 step 6: the assistant's message on the card. */
export const PLAN_RECOMMENDATION_MAX_CHARS = 280;
/** Decision 20: the longest question the user may type in the Ask box
 *  (defined in shared/types.ts so the journal schema and the card share it). */
export { PLAN_QUESTION_MAX_CHARS };

/**
 * Decision 20: the Ask box's text, trimmed. Anything that isn't text, or is
 * blank, is no question. Too long is refused with the reason the card shows
 * (the same shape as a Comment's limit).
 */
export function normalizePlanQuestion(raw: unknown): { ok: true; question?: string } | { ok: false; error: string } {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: true };
  if (text.length > PLAN_QUESTION_MAX_CHARS) return { ok: false, error: `Questions are limited to ${PLAN_QUESTION_MAX_CHARS.toLocaleString('en-US')} characters.` };
  return { ok: true, question: text };
}

/** §2 step 4: how much provider/tool detail the notice may carry. */
export const PLAN_NOTICE_DETAIL_MAX_CHARS = 500;
// WHY PLAN_ADD_BUDGET_MAX_MULTIPLE is GONE (spending rework stage 1,
// decision 34): there is no add_budget recommendation left to bound.
/** §2 "never stuck": a pending handoff whose notice has not started to be
 *  delivered by then is cleared, so the card never stays greyed. Task 11: the
 *  card then says so ("didn't get to your question within 10 minutes"), so
 *  the number in that sentence must follow this one. */
export const PLAN_HANDOFF_BACKSTOP_MS = 10 * 60_000;

const DETAIL_OPEN = '<untrusted-detail>';
const DETAIL_CLOSE = '</untrusted-detail>';
const SHORTENED = '… [shortened]';

const fmt = (n: number) => n.toLocaleString('en-US');

/** What happened, in the assistant's words (never the executor's sentence,
 *  which is the untrusted detail below). */
function whatHappened(paused: NonNullable<PlanRecord['paused']>): string {
  const kind: PlanPauseKind = paused.kind ?? 'unexpected-error';
  const base: Record<PlanPauseKind, string> = {
    // Design §7, decision 37 R-4 (spending rework stage 1): the plan's own
    // spend limit was reached — the one spend-related pause kind left.
    'spend-limit': "the plan reached its spend limit",
    'launch-failed': paused.launch === 'refused' ? "a specialist couldn't be started with this plan's approved settings"
      : paused.launch === 'drift' ? "a specialist's instructions or tools changed since the plan was approved"
        : "a specialist couldn't start",
    'unknown-outcome': `a specialist was cut off after starting a ${fact(paused.tool ?? 'tool')} call, and it is not known whether that call finished`,
    'iteration-cap': paused.repeat
      ? `the repeated steps ran ${paused.repeat.rounds} times without meeting their goal ("${fact(paused.repeat.until)}")`
      : 'the repeated steps used all their rounds without meeting their goal',
    'invalid-report': "a specialist's report was missing or not in the required form",
    'specialist-error': 'a specialist stopped with an error',
    'specialist-stopped': 'the user stopped a specialist',
    'unexpected-error': 'an unexpected problem stopped the plan',
  };
  const drift = paused.launch === 'drift' && kind !== 'launch-failed' ? ", and a specialist's settings changed since approval" : '';
  return `${base[kind]}${drift}${paused.retried ? ', after one automatic retry' : ''}`;
}

/** Neither of the notice's block tags may appear inside any text put into it. */
function withoutBlockTags(text: string): string {
  return text.replace(/<\/?\s*(user-question|untrusted-detail)\s*>/gi, '[tag removed]');
}

/** Decision 20: the user's question inside its block. It is the user's own
 *  words, so it is not marked untrusted, but no tag in it may close its block
 *  or open another, so the notice's structure always holds. */
function userQuestion(text: string): string {
  return withoutBlockTags(text);
}

/**
 * Task 12 review fix 1: a one-line fact whose words a model or a tool wrote
 * (the plan goal, a step title, a tool name, a repeat's stop condition).
 * WHY: the chat draws the user's own bubble from the question block, so such
 * text must never carry a block tag, nor break onto a line of its own where it
 * could pose as the question's label.
 */
function fact(text: string): string {
  return withoutBlockTags(text).replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** The detail, capped and unable to close its own wrapper. */
function untrusted(text: string): string {
  // WHY neutralise both tags: a detail containing the closing tag would end
  // the untrusted block early and let the rest read as the notice's own
  // words; a question tag in it could be drawn as the user's own message
  // (review fix 1).
  const safe = withoutBlockTags(text);
  return safe.length <= PLAN_NOTICE_DETAIL_MAX_CHARS ? safe : `${safe.slice(0, PLAN_NOTICE_DETAIL_MAX_CHARS)}${SHORTENED}`;
}

// WHY addBudgetFloor/addBudgetCap/allowedLine's add_budget branch/topUpLine
// are ALL GONE (spending rework stage 1, design §1, decision 34): there is
// no Add budget action left to size, floor, cap or describe a top-up for —
// `actions` is 'continue'/'stop' only, so the notice just lists them.

/** Design §3/§7: what has actually been spent, and the plan's own limit if
 *  it set one — dollars when priced, tokens otherwise (same pricing-class
 *  rule as `estimate`/`spendLimit`, design §4). */
function spentLine(plan: PlanRecord): string {
  const limit = plan.spendLimit;
  if (limit && 'usd' in limit) return `Spent so far: $${(plan.usedUsd ?? 0).toFixed(2)} of the $${limit.usd.toFixed(2)} limit`;
  if (limit) return `Spent so far: ${fmt(plan.usedTokens)} of the ${fmt(limit.tokens)}-token limit`;
  if (plan.usedUsd !== undefined) return `Spent so far: $${plan.usedUsd.toFixed(2)}`;
  return `Spent so far: ${fmt(plan.usedTokens)} tokens`;
}

/** The notice for `plan`'s current pause (§2 step 4), sent when the user
 *  presses "Ask the assistant" (Task 11, §6). */
export function planHandoffNotice(plan: PlanRecord, handoffId: string, question?: string, now: number = Date.now()): string {
  const paused = plan.paused;
  if (!paused) throw new Error(`Plan ${plan.planId} is not paused.`);
  const view = projectPlan(plan, now);
  const index = view.steps.findIndex((s) => s.id === paused.stepId);
  // Decision 33: a repeat is ONE row that CONTAINS its body, so a pause inside
  // the body belongs to the repeat's row — that is the number the user sees.
  const rowIndex = index >= 0 ? index : view.steps.findIndex((s) => s.body?.some((b) => b.id === paused.stepId));
  const where = rowIndex >= 0
    ? `step ${rowIndex + 1} of ${view.steps.length}, "${fact(view.steps[rowIndex].title)}"`
    : `step "${fact(paused.stepId)}"`;
  const { actions } = pausedRouting(paused);
  const lines = [
    // Task 11 (§6): the user asked, and the notice says so first. The lead is
    // shared with the renderer, which draws this notice as the user's own
    // message (decision 21: the typed question, or "What should I do about
    // this paused plan?"); the facts below reach the assistant only.
    PLAN_ASK_NOTICE_LEAD,
    '',
    `Plan: "${fact(plan.document.goal)}"`,
    `Plan id: ${plan.planId}`,
    `Handoff id: ${handoffId}`,
    `Paused at: ${where}`,
    `What happened: ${whatHappened(paused)}`,
    // WHY this reads spendLimit/usedUsd, not ceilingTokens/approximateLimit
    // (spending rework stage 1, design §3/§7, decision 34): spending is
    // recorded, not reserved, so there is no worst-case ceiling to report
    // against — only what has actually been spent, and the plan's own
    // optional limit if it has one. T6 (design §7's setLimit/resume) is the
    // task that gives this notice its full wording pass; this is the
    // straightforward read of the new fields.
    spentLine(plan),
    `You may recommend: ${actions.join(', ')}`,
    '',
    // Decision 20: what the user typed, after the pinned facts, labelled as
    // theirs. A blank ask leaves the notice exactly as before.
    ...(question?.trim() ? [
      PLAN_ASK_QUESTION_LABEL,
      PLAN_ASK_QUESTION_OPEN,
      userQuestion(question.trim()),
      PLAN_ASK_QUESTION_CLOSE,
      '',
    ] : []),
    PLAN_ASK_DETAIL_HEADER,
    DETAIL_OPEN,
    // Task 12 follow-up 2: a general reason's system text (a failed save's
    // EIO, say) is kept off the card but still reaches the assistant here,
    // inside the same capped, tag-stripped untrusted block.
    untrusted(paused.report ? `${paused.reason}\n${paused.report}` : paused.reason),
    DETAIL_CLOSE,
    '',
    'Reply in one of three ways. Call recommend_plan_action with this plan id and handoff id to put the button you recommend on the plan card, with a short message saying why. '
      + 'Or call propose_plan with a revised plan. Or explain what happened in chat. '
      + 'You cannot continue the plan or stop it yourself: the user presses the button.',
  ];
  return lines.join('\n');
}

/**
 * Decision 38: the notice queued once a plan starts running (manual Approve,
 * or auto-start) — never once for `resume`/Continue, which restarts existing
 * work rather than starting it (PlanHostBridge only calls this from
 * `approve`/`propose`'s auto-start branch). WHY hidden, not drawn as the
 * user's own message like the Ask notice: nobody asked anything — the user's
 * click already showed the approved card, so a second bubble asking a
 * question that was never asked would be confusing. The assistant's OWN
 * reply is what the user is meant to see (decision 38, "1-line confirmation").
 */
export function planApprovalNotice(plan: PlanRecord): string {
  return [
    `${PLAN_RUNNING_NOTICE_PREFIX} The user approved your plan and it is now running.`,
    '',
    `Plan: "${fact(plan.document.goal)}"`,
    `Plan id: ${plan.planId}`,
    '',
    "You'll get another message with its results once every step finishes — you do not need to check on it. "
      + 'Reply to the user now with a short, ONE-LINE confirmation only (do not restate the plan). '
      + 'If the user asks you to do something else in the meantime, you may work on that; the plan keeps running on its own.',
  ].join('\n');
}

/**
 * Issue 1 fix: the notice queued once a plan reaches `completed` — the
 * assistant's only way to learn the plan finished (nothing else tells it).
 * Gives the final step's own report(s), bounded and labelled the identical
 * way an intermediate verify/combine step already reads an earlier one's
 * (finalStepReportsText), plus a one-line summary of what ran — both already
 * computed from facts the journal holds, nothing invented here. Hidden for
 * the same reason the approval notice is: this is the host telling the
 * assistant something, not the user asking it anything.
 */
export function planCompletionNotice(plan: PlanRecord): string {
  return [
    `${PLAN_COMPLETE_NOTICE_PREFIX} Your plan finished running.`,
    '',
    `Plan: "${fact(plan.document.goal)}"`,
    `Plan id: ${plan.planId}`,
    `What ran: ${planRunSummary(plan)}`,
    '',
    'Final result:',
    finalStepReportsText(plan),
    '',
    "Tell the user what the plan produced — this is the assistant's own reply, not a new question from them.",
  ].join('\n');
}
