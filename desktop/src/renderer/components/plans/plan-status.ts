import type { PlanView } from '../../../shared/types';
import { classifyPause } from './plan-pause';
import { formatElapsed } from '../specialists/RunStatusLine';

/**
 * The one status phrase a plan carries next to its title — "waiting for your
 * approval", "step 1 of 3", "paused — reached its limit" …
 *
 * WHY its own module (Task 8 review): the plan card's header AND the
 * Specialists chip's plan row both print it, and they must always agree. The
 * chip's data hook (hooks/useSpecialists.ts) can't import PlanCard.tsx without
 * an import loop (PlanCard → ToolBody → useSpecialists), so the phrase lives
 * here and both read it.
 */
export function planStatusPhrase(plan: PlanView): string {
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.status === 'done').length;
  // The writing clock is live, so the header renders <PlanWritingDetail>
  // instead of this static string (Destin, round 1, P-4: one line, like every
  // other collapsed tool card).
  return plan.status === 'writing' ? ''
    : plan.status === 'proposed' ? 'waiting for your approval'
    : plan.status === 'running' ? `step ${Math.min(done + 1, total)} of ${total}`
    // Task 5b: two pauses are not about the limit, and the header must not
    // say they are (plan-pause.ts explains how they are told apart).
    : plan.status === 'paused' ? pausedDetail(plan)
    : plan.status === 'interrupted' ? `interrupted — ${done} of ${total} steps done`
    : plan.status === 'completed' ? `finished in ${formatElapsed((plan.endedAt ?? 0) - (plan.startedAt ?? 0))}`
    // Final review F21: a proposal stopped before it had steps has no count to give.
    : plan.status === 'stopped' ? (plan.revisedBy ? 'revised — see the new plan below' : total === 0 ? 'stopped' : `stopped — ${done} of ${total} steps done`)
    : 'failed';
}

function pausedDetail(plan: PlanView): string {
  // Task 9b: while the assistant has the pause, that is what the header says.
  // Task 11 (§6): a question still waiting behind a reply says it is waiting.
  if (plan.paused?.handoff?.state === 'pending') {
    return plan.paused.handoff.waiting === 'reply' ? 'paused — waiting for the assistant' : 'paused — the assistant is looking into this';
  }
  if (classifyPause(plan.paused).kind === 'unknown-outcome') return 'paused — check before continuing';
  // r11b review: the phrase follows the pause's recorded KIND. It used to say
  // "reached its limit" for every other pause — including an unsaved-progress
  // (unexpected-error) pause, which has nothing to do with a limit.
  switch (plan.paused?.kind) {
    // Design §7, decision 37 R-4 (spending rework stage 1): the plan's own
    // spend limit — the one spend-related pause kind left.
    case 'spend-limit':
      return 'paused — reached its limit';
    // Only a revised plan can help this (pause-routing.ts: Stop only).
    case 'iteration-cap':
      return 'paused — needs a revised plan';
    case 'specialist-stopped':
      return 'paused — a specialist was stopped';
    case 'unexpected-error': case 'specialist-error': case 'launch-failed': case 'invalid-report': case 'unknown-outcome':
      return 'paused — something went wrong';
    // A record from before `kind`: say nothing about why.
    default:
      return 'paused';
  }
}
