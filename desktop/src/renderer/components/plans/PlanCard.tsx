import { useEffect, useMemo, useRef, useState } from 'react';
import { PLAN_QUESTION_MAX_CHARS, type PlanView, type PlanStepView, type PlanChildView, type ToolCallState } from '../../../shared/types';
import { useChatDispatch } from '../../state/chat-context';
import { Button, ErrorState, FieldError, StatusStrip, Textarea, TextInput } from '../ui';
import { CheckIcon, FailIcon, StoppedIcon, ChevronIcon } from '../Icons';
import { BugReportPopup } from '../development/BugReportPopup';
import type { ReportContext } from '../development/ReportDesign';
import { toolActionLabel } from '../../utils/tool-group-summary';
import { classifyPause } from './plan-pause';
import { markPlanReceived, warmMinimumExpiresAt } from '../../state/plan-received';
import { planStatusPhrase } from './plan-status';
import BrailleSpinner from '../BrailleSpinner';
import { SpecialistActions } from '../specialists/SpecialistActions';
import { RunStatusLine, formatElapsed } from '../specialists/RunStatusLine';
// The Briefing / Activity / Report sections a hired specialist's card already
// renders. Reused verbatim so a specialist inside a plan looks and behaves like
// one outside it (Destin, review round 1, P-5).
import { AgentSections } from '../tool-views/ToolBody';
import { asString } from '../../utils/tool-input';
import { hasNestedAsk } from '../../utils/specialist-cards';
import type { SubagentSegment } from '../../../shared/types';
import { PLAN_UNREADABLE, planAction, usePlanUnsupported } from './plan-bridge';
import { planChildCard, planWithActivity } from './plan-activity';
import { useNarrowViewport } from '../../hooks/use-narrow-viewport';
import { previewSessionKey } from '../../../shared/chatsearch-refs';

/**
 * Specialists stage two — the PLAN CARD (designed 2026-09-05; since Task 5a
 * every button goes through the typed `window.claude.plans` bridge via
 * plan-bridge.ts, and the workbench fakes answer the same forms).
 *
 * What Destin decided on the 2026-09-05 questions deck, and what each answer
 * pins here:
 *  Q-2  Before approval the card is a short step list, the specialist count,
 *       ONE ceiling line, then Approve and Comment. Detail folds per step.
 *  Q-3  Comment opens a note box under the card; the assistant rewrites the
 *       plan and posts a NEW card, and this one greys out ("revised").
 *  Q-4  Auto-approve is off until the user turns it on in Settings; a plan
 *       that ran without asking says so on the card, ceiling still printed.
 *  Q-5  The plan card IS the progress surface: steps tick off, each running
 *       specialist is a line inside its step with Note / Stop.
 *  Q-6  A plan that hits its ceiling pauses IN PLACE: finished work stays,
 *       the stuck step says why, Add budget / Stop.
 *  Q-7  After a restart the card comes back "Interrupted — 3 of 5 done" with
 *       Continue; nothing runs until it is pressed.
 * Settled by the spec (§4), not up for re-derivation: budgets are hard stops,
 * the ceiling is Σ(step cap × fan-out) priced per model, dollars appear only
 * when the model has a published price — tokens always do.
 */

// ---- header (ToolCard's friendlyToolDisplay reads these) --------------------

/** "Plan: <goal>" plus the one status phrase the header can carry. */
export function planDisplay(input: Record<string, unknown>, plan?: PlanView): { label: string; detail: string } {
  // Final review F20: the tool's field is `goal`. A writing/failed/stopped
  // shell carries no title of its own, so the input names the plan.
  const title = plan?.title || asString(input.goal) || asString(input.title) || 'a plan';
  const label = `Plan: ${title}`;
  if (!plan) return { label, detail: '' };
  // Task 8 review: shared with the Specialists chip's plan row (plan-status.ts).
  return { label, detail: planStatusPhrase(plan) };
}

/** The header glyph. A proposed plan wears the question mark every ask wears. */
export function planIcon(plan: PlanView): 'spinner' | 'check' | 'fail' | 'stopped' | 'question' | 'paused' {
  switch (plan.status) {
    case 'writing': case 'running': return 'spinner';
    case 'proposed': return 'question';
    case 'completed': return 'check';
    case 'failed': return 'fail';
    // Paused and interrupted are WAITING states, not endings: the same glyph
    // as stopped but without the header's "stopped" tag, which would say the
    // plan is over when Add budget / Continue are right there.
    case 'paused': case 'interrupted': return 'paused';
    default: return 'stopped';
  }
}

// ---- numbers -----------------------------------------------------------------

function tokens(n: number): string { return `${n.toLocaleString()} tokens`; }

/** Decision 20: the longest Ask question main accepts. Review fix 3: now the
 *  shared constant itself (shared/types.ts), so the two can't drift. */
const PLAN_QUESTION_LIMIT = PLAN_QUESTION_MAX_CHARS;

/** Final review F6: a failed plan whose cause isn't known — general, and
 *  names no cause (docs/error-message-standards.md), with Report bug and
 *  Diagnose beside it. */
const PLAN_FAILED_GENERAL = "The plan couldn't be created.";

/** "$0.12"; "less than a cent" rather than a false "$0.00" (error-message
 *  standard: never print a zero that is not one). */
function usd(n: number): string {
  if (isUnderACent(n)) return 'less than a cent';
  return `$${n.toFixed(2)}`;
}
const isUnderACent = (n: number) => n > 0 && n < 0.005;
/** Final review F22: an estimate with its marker — "about $0.12" / "~$0.12" —
 *  but never "about less than a cent" or "~less than a cent" (the words
 *  already say it is small). */
function estimateUsd(n: number, marker: string): string {
  return isUnderACent(n) ? usd(n) : `${marker}${usd(n)}`;
}

/** Task 8 (review 6, R6-1): a limit one reply can overshoot (ChatGPT sends
 *  without an output cap) is not exact, so every LIMIT figure on the card —
 *  tokens and dollars alike — wears a tilde: "~42,000 tokens", "~$0.12".
 *  Spent figures are real counts and never get one. Replaced the 5b "about"
 *  wording plus its extra "On ChatGPT…" sentence, which the product owner
 *  found unnecessary. An exact limit reads exactly as signed. */
function approx(plan: PlanView): string { return plan.approximateLimit ? '~' : ''; }
function limitTokens(plan: PlanView, n: number): string { return `${approx(plan)}${tokens(n)}`; }
/** UX tester (Task 11): before the word "limit" the number reads as an
 *  adjective — "its 9,000-token limit", never "its 9,000 tokens limit". */
function tokenLimit(plan: PlanView, n: number): string { return `${approx(plan)}${n.toLocaleString()}-token limit`; }

/** The ceiling, priced when the model has a price. */
function ceiling(plan: PlanView): string {
  // UX run 1, U9/U21: the dollar figure is the part a student understands, so it
  // leads when the model has a price; the token limit always follows (spec §4).
  // "specialists run on" says whose model this is — the chat may be on another.
  const t = limitTokens(plan, plan.ceilingTokens);
  if (plan.ceilingUsd == null) return `Up to ${t} · specialists run on ${plan.model.label}, which has no published price`;
  // A priced ceiling was always "about $X" (a price is an estimate); an
  // approximate one says it with the tilde instead, like its token figure.
  const dollars = estimateUsd(plan.ceilingUsd, plan.approximateLimit ? '~' : 'about ');
  return `Up to ${dollars} (${t}) · specialists run on ${plan.model.label}`;
}

function spent(plan: PlanView): string {
  const t = tokens(plan.usedTokens ?? 0);
  return plan.usedUsd == null ? t : `${usd(plan.usedUsd)} (${t})`;
}

/** "of the $0.12 limit" / "of the 40,000-token limit" — one word, "limit", for the
 *  cap everywhere on the card (UX run 1, U8: budget/cap/ceiling were four words for one idea). */
function limit(plan: PlanView): string {
  const t = limitTokens(plan, plan.ceilingTokens);
  if (plan.ceilingUsd == null) return `the ${tokenLimit(plan, plan.ceilingTokens)}`;
  // Final review F22: "the less than a cent limit" doesn't read; say it plainly.
  if (isUnderACent(plan.ceilingUsd)) return `a limit under one cent (${t})`;
  return `the ${approx(plan)}${usd(plan.ceilingUsd)} limit (${t})`;
}

/** Final review F24: what one specialist of `step` may use in all — its work
 *  budget plus its fixed setup cost — so the rows add up to the plan limit. */
function perSpecialist(step: PlanStepView): number {
  return step.budgetTokens + (step.setupTokens ?? 0);
}

/** Final review F1: one id per Add budget press. `crypto.randomUUID` is only
 *  there in a secure context (a phone browser over plain http has none). */
function newRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Final review F25: a conversation preview (previewSessionKey) draws the
 *  chat's own cards, but nothing on them may act — the plan is not running here. */
const PREVIEW_KEY_PREFIX = previewSessionKey('');

/** Decision 24: the buttons for a pause whose record predates `actions`,
 *  by kind — mirrors main's pause-routing.ts table (pinned against
 *  pausedRouting by plan-card-final-review.test.tsx). */
export function fallbackActions(paused: PlanView['paused']): Array<'add_budget' | 'continue' | 'stop'> {
  switch (paused?.kind) {
    case 'budget': case 'ceiling-shortfall':
      return paused.launch === 'drift' ? ['stop'] : ['add_budget', 'stop'];
    case 'plan-limit': case 'budget-refused': case 'iteration-cap': case 'local-pool':
      return ['stop'];
    case 'specialist-stopped':
      return ['continue', 'stop'];
    default:
      return paused?.launch === 'drift' || (paused?.kind === 'launch-failed' && paused.launch === 'refused') ? ['stop'] : ['continue', 'stop'];
  }
}

// ---- the block ---------------------------------------------------------------

export function PlanBlock({ plan: record, segments, sessionId }: {
  plan: PlanView;
  /** Task 5a: the card's collected specialist activity (tagged by childId),
   *  joined into each specialist's row here — see plan-activity.ts. */
  segments?: SubagentSegment[];
  sessionId?: string;
}) {
  const plan = useMemo(() => planWithActivity(record, segments), [record, segments]);
  const dispatch = useChatDispatch();
  // Final review F25: a conversation preview is read-only.
  const readOnly = sessionId?.startsWith(PREVIEW_KEY_PREFIX) === true;
  // Destin, round 2 (R-1): while the plan is being written the card must be
  // exactly a header row — not a header plus an empty padded body, which read
  // as thicker than every other collapsed tool card.
  const writing = plan.status === 'writing';
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState('');
  const [adding, setAdding] = useState(false);
  // Decision 20: "Ask the assistant" opens a small optional question box,
  // like Comment's. Blank is fine; Send asks either way.
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const questionTooLong = question.trim().length > PLAN_QUESTION_LIMIT;
  // UX run 1, U18: default to the paused step's own per-specialist cap (a
  // sensible size for one more pass), shown with a thousands comma.
  // Task 5b: when the host says a smaller amount would only pause again
  // (`minimumAddTokens`), the field starts AT that minimum instead.
  // Decision 33: a repeat is one row that contains its body, so a pause inside
  // the body belongs to the repeat's row — that is the number the reader sees —
  // while the amount to top up comes from the body step that actually ran out.
  const pausedAt = findPausedRow(plan.steps, plan.paused?.stepId);
  const pausedIndex = pausedAt ? pausedAt.index : -1;
  const pausedStep = pausedAt?.step;
  const numbers = useMemo(() => rowNumbers(plan.steps), [plan.steps]);
  const minimum = useMinimumNow(plan.paused);
  const defaultExtra = String(minimum ?? pausedStep?.budgetTokens ?? 10000);
  const [extra, setExtra] = useState(defaultExtra);
  // Final review F1: the id of this pause's Add budget press. Kept for Retry
  // and for a second press on the same pause (the host adds nothing twice);
  // forgotten when the plan leaves the pause, so the next pause gets a new one.
  const budgetRequest = useRef<string | null>(null);
  const isPaused = plan.status === 'paused';
  // Final review F16: a box left open (or a value left typed) belongs to the
  // pause it was opened on. When the plan leaves that pause — resumed from
  // another window, say — the boxes close and the next pause starts fresh.
  const defaultExtraRef = useRef(defaultExtra);
  defaultExtraRef.current = defaultExtra;
  // Task 12 follow-up 1: when the warm minimum expires (or a new one lands)
  // a closed Add budget box opens at the minimum that holds now.
  const addingRef = useRef(adding);
  addingRef.current = adding;
  useEffect(() => {
    if (isPaused && !addingRef.current) setExtra(defaultExtraRef.current);
  }, [minimum, isPaused]);
  useEffect(() => {
    if (isPaused) { setExtra(defaultExtraRef.current); return; }
    budgetRequest.current = null;
    setAdding(false);
    setAsking(false);
    setQuestion('');
  }, [isPaused]);
  useEffect(() => { if (plan.status !== 'proposed') setCommenting(false); }, [plan.status]);
  // Task 9b: "Add budget pre-filled" — the assistant's amount, never below
  // the host's minimum (the host would refuse less).
  const recommendedTokens = plan.paused?.handoff?.recommendation?.action === 'add_budget' ? plan.paused.handoff.recommendation.addTokens : undefined;
  useEffect(() => {
    if (recommendedTokens !== undefined) setExtra(String(Math.max(recommendedTokens, minimum ?? 0)));
  }, [recommendedTokens, minimum]);
  // A later push can raise or set the minimum while the card is open: never
  // leave the field below the new floor.
  useEffect(() => {
    if (minimum !== undefined) setExtra((v) => (Number(v) < minimum ? String(minimum) : v));
  }, [minimum]);
  const belowMinimum = minimum !== undefined && (Number(extra) || 0) < minimum;
  const pause = classifyPause(plan.paused);
  // Task 9b (pause handoff §2): the pause may be with the assistant first.
  // Pending → greyed, no buttons. Answered → buttons again, led by the
  // assistant's recommendation when it made one. The user presses every one.
  const handoff = plan.status === 'paused' ? plan.paused?.handoff : undefined;
  const handoffPending = handoff?.state === 'pending';
  const recommendation = handoff?.state === 'answered' ? handoff.recommendation : undefined;
  // Task 11 (pause handoff §6): a question the assistant never answered —
  // it had not started within 10 minutes, or its reply failed. The card says
  // so with Retry (which asks again) instead of silently returning its buttons.
  const askProblem = handoff?.state === 'answered' && !recommendation ? handoff.problem : undefined;
  // The buttons this pause offers (main works them out from the same table
  // that limits the assistant's recommendation). A record from before that
  // field keeps the card's earlier rule.
  // Decision 24: a record without `actions` falls back by the pause's KIND,
  // the same table main uses (pause-routing.ts) — only the budget kinds offer
  // Add budget. The old fallback gave every unnamed kind Add budget.
  const offered: ReadonlyArray<'add_budget' | 'continue' | 'stop'> = plan.paused?.actions ?? fallbackActions(plan.paused);
  const [busy, setBusy] = useState<string | null>(null);
  // Final review F15: an error belongs to the state it happened in; once a
  // push moves the card on, it (and its Retry) no longer applies.
  const [failed, setFailed] = useState<{ text: string; detail?: string; status: PlanView['status'] } | null>(null);
  const error = failed && failed.status === plan.status ? failed.text : null;
  // Task 14 (decision 27): the host asked once, because the models this plan's
  // specialists run on changed and the new worst case could cost more. Nothing
  // failed, so it is NOT an error: it is a line in the card's own tinted strip,
  // and it belongs to the state it was answered in — once the plan runs (or
  // moves on), it is gone.
  const [asked, setAsked] = useState<{ text: string; status: PlanView['status'] } | null>(null);
  const limitNotice = asked && asked.status === plan.status ? asked.text : null;
  // Task 11: "Ask the assistant" on every paused card, except while a question
  // is pending, when this conversation's model can't use tools, or while the
  // ask error line's Retry already offers the same thing — only while that
  // line is actually showing (review fix 3: another action's error hides it,
  // and that error's Retry does not ask).
  const canAsk = !readOnly && plan.status === 'paused' && !!plan.paused && !handoffPending && !plan.paused.askUnavailable && !(askProblem && !error);
  // Task 5b: the card's error line offers Retry (error-message-standards:
  // every error has an action). Retry repeats the button that failed.
  // Final review F14: it names the action, and Retry runs that action as it
  // is NOW — with the note, question or amount on the card at that moment.
  const lastAction = useRef<string | null>(null);
  const [reportContext, setReportContext] = useState<ReportContext | null>(null);
  // Task 5a: a device or host that can't run plans (asked once per window, or
  // learned from a button's answer) keeps every control disabled and says why
  // in the card's own error line. Nothing is retried or shown in advance.
  const probedUnsupported = usePlanUnsupported(!readOnly);
  const [answeredUnsupported, setAnsweredUnsupported] = useState<string | null>(null);
  const unsupported = answeredUnsupported ?? probedUnsupported?.error ?? null;
  const blocked = busy !== null || unsupported !== null;
  const revised = plan.status === 'stopped' && !!plan.revisedBy;
  // Only a card that offers buttons explains why they are disabled; a
  // finished, failed or revised card has nothing to refuse (Task 5a review).
  const hasControls = !readOnly && !revised && (plan.status === 'proposed' || plan.status === 'running' || plan.status === 'paused' || plan.status === 'interrupted');
  // Task 5a review: `busy` is React state and does not update between two
  // presses in the same tick (double Enter in the comment box sent the note
  // twice). A ref closes that gap: one call at a time per card.
  const inFlight = useRef(false);

  // Every button makes one bridge call and lands ONLY the record the host
  // returned (the same record its plans:event push carries) — so the card
  // never invents a state on its own. Returns whether the host accepted.
  // Task 5b: answers the landed record (or null) so Add budget can decide
  // whether the plan still needs a Continue.
  const act = async (name: string, fn: Parameters<typeof planAction>[0]): Promise<PlanView | null> => {
    if (!sessionId || readOnly || unsupported !== null || inFlight.current) return null;
    inFlight.current = true;
    // The status the press was made in: the error it may leave belongs there.
    const at = plan.status;
    setBusy(name); setFailed(null); setAsked(null);
    try {
      const res = await planAction(fn);
      if (res.ok) {
        // Task 12 follow-up 1: an action's answer is a view received now.
        markPlanReceived(res.plan);
        dispatch({ type: 'PLAN_CHANGED', sessionId, plan: res.plan });
        return res.plan;
      }
      // Task 14: the one answer that is neither success nor failure — press the
      // same button again and the plan runs at the new limit.
      if (res.notice !== undefined) setAsked({ text: res.notice, status: at });
      else if (res.unsupported) setAnsweredUnsupported(res.error);
      else setFailed({ text: res.error, ...(res.detail ? { detail: res.detail } : {}), status: at });
      return null;
    } finally { inFlight.current = false; setBusy(null); }
  };
  const id = sessionId ?? '';
  const approve = () => { lastAction.current = 'approve'; return act('approve', (b) => b.approve(id, plan.planId)); };
  // A refused note or amount stays where it was typed, so it can be sent again.
  const sendComment = () => { lastAction.current = 'comment'; return act('comment', (b) => b.comment(id, plan.planId, comment.trim())).then((ok) => { if (ok) { setComment(''); setCommenting(false); } }); };
  const addBudget = async () => {
    // Task 5b: an amount under the host's minimum is refused here, before
    // anything is sent — the host would refuse it anyway.
    if (belowMinimum) return;
    lastAction.current = 'budget';
    budgetRequest.current ??= newRequestId();
    const landed = await act('budget', (b) => b.addBudget(id, plan.planId, Number(extra) || 0, budgetRequest.current!));
    if (!landed) return;
    // Task 5b: the real host only raises the limit and leaves the plan
    // paused; the control's button says Continue (R8: "continues from where
    // the plan stopped"), so the card presses Continue for the user. An
    // answer that already runs the plan (the workbench fake) is not resumed
    // a second time.
    // Retry after THIS step only continues (a repeated Add budget would add
    // nothing anyway: same request id, final review F1).
    if (landed.status === 'paused') { lastAction.current = 'continue'; await act('continue', (b) => b.resume(id, plan.planId)); }
    // WHY the box closes only HERE, after both calls (Destin, 2026-09-19:
    // "adding budget to a specialist in a plan seems to completely freeze the
    // app"): Continue re-resolves the plan's manifest, which opens a probe
    // session per specialist and can run for minutes. Closing on the FIRST
    // call's answer handed that whole wait back to the pause strip, whose
    // every button is disabled while an action is in flight and none of which
    // says why — disabled and silent for minutes is indistinguishable from
    // frozen. The box's own button reads "Continuing…" for both calls, so
    // keeping it up is the only thing on the card that admits work is going on.
    setAdding(false);
  };
  const cont = () => { lastAction.current = 'continue'; return act('continue', (b) => b.resume(id, plan.planId)); };
  const stop = () => { lastAction.current = 'stop'; return act('stop', (b) => b.stop(id, plan.planId)); };
  // Task 11 (§6): the host checks, records and queues; the card only lands the
  // greyed record it answers. `act` ignores presses while one is in flight.
  // Decision 20: the question travels with the request.
  const sendAsk = (text: string): Promise<void> => {
    return act('ask', (b) => b.askAssistant(id, plan.planId, text)).then((landed) => {
      // A refused question stays where it was typed, so it can be sent again.
      if (landed) { setAsking(false); setQuestion(''); }
    });
  };
  const submitAsk = () => { lastAction.current = 'ask'; if (!questionTooLong) void sendAsk(question.trim()); };
  // The ask error line's Retry asks again with the words that were asked.
  const askAgain = () => { lastAction.current = 'ask-again'; return sendAsk(handoff?.question ?? ''); };
  // Final review F14: the latest version of each action, read at Retry time.
  const actions = useRef<Record<string, () => unknown>>({});
  actions.current = {
    approve, comment: sendComment, budget: addBudget, continue: cont, stop,
    // The Ask box is still open after a refused question: send what it holds now.
    ask: () => (asking ? submitAsk() : askAgain()),
    'ask-again': askAgain,
  };
  const retry = () => { const name = lastAction.current; if (name) void actions.current[name]?.(); };
  // Report bug / Diagnose open the app's ticket screen with the real text
  // (final review F11: the system's own detail when there is one).
  const report = (errorText: string, diagnose: boolean) => setReportContext({ surface: 'a plan card', error: errorText, ...(diagnose ? { diagnose } : {}) });
  const reportText = (text: string, detail?: string) => (detail ? `${text}\n\n${detail}` : text);

  const specialists = plan.steps.reduce((n, s) => n + s.fanOut, 0);
  const done = plan.steps.filter((s) => s.status === 'done').length;
  if (writing) return null;
  // Final review F21: a proposal stopped before it was written has nothing to
  // show under its header ("Plan: … · stopped").
  if (plan.status === 'stopped' && plan.steps.length === 0 && !plan.revisedBy) return null;

  return (
    // Task 9b: a pause handed to the assistant greys the card like a revised
    // one — it is waiting on someone else, and nothing on it can be pressed.
    <div className={`px-3 pb-2.5 pt-1.5 space-y-2 ${revised || handoffPending ? 'opacity-60' : ''}`} data-testid="plan-block" data-plan-status={plan.status} {...(handoff ? { 'data-handoff': handoff.state } : {})}>
      <ol className="space-y-1" data-testid="plan-steps">
            {plan.steps.map((step, i) => (
              <StepRow key={step.id} step={step} index={i} siblings={plan.steps} number={String(i + 1)}
                numbers={numbers} plan={plan} sessionId={sessionId} />
            ))}
          </ol>

          {/* Task 14 (decision 27): a proposal whose specialists now cost more
              than the card said asks in its own tinted strip, above the Comment ·
              Approve row. The same Approve, pressed again, runs it at the new
              limit — so there is no new button and nothing failed (never
              ErrorState). A paused plan says the same thing as a line inside the
              pause strip it already has. */}
          {limitNotice && plan.status === 'proposed' && (
            <StatusStrip tone="warn" surface="tinted" className="!py-2">
              <span data-testid="plan-limit-notice">{limitNotice}</span>
            </StatusStrip>
          )}

          {/* ONE ceiling line (Q-2). While the plan moves it becomes "spent of".
              A running plan's Stop shares this row (Destin, round 2).
              Task 5b: a failed card salvaged from a damaged file has no steps
              and a 0 limit — printing "of the 0 tokens limit" says nothing true,
              so that card shows only its reason. */}
          {/* Task 10 (review 7, R7-2 note: "put the buttons in-line with the
              text on the left. lots of empty space"): a proposal's Comment ·
              Approve share this row too, like a running plan's Stop. The text
              takes the free space (flex-1) but keeps a readable 16rem before
              the buttons give way; below that the buttons wrap onto their own
              line and stay on the right (ml-auto), Approve rightmost (G-29). */}
          {plan.steps.length > 0 && (
          <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap" data-testid="plan-ceiling">
          <span className="text-xs text-fg-dim flex-1 min-w-0 basis-64">
            {plan.status === 'proposed' || revised
              // A revised plan never ran, so it keeps its proposal line rather
              // than a meaningless "Spent 0" (UX run 1 follow-up).
              ? <>{specialists} specialist{specialists === 1 ? '' : 's'} · {ceiling(plan)}</>
              // UX run 1, U16: the header already says how long it took, so a
              // finished plan reads like any other: what it spent of its limit.
              : <>Spent {spent(plan)} of {limit(plan)}</>}
          </span>
            {plan.status === 'running' && !readOnly && (
              <div className="flex items-center justify-end gap-2 shrink-0 ml-auto">
                <Button size="sm" variant="danger-outline" onClick={stop} disabled={blocked}>{busy === 'stop' ? 'Stopping…' : 'Stop the plan'}</Button>
              </div>
            )}
            {/* Task 8 (review 6, R6-4; design guide G-29): Comment (light) on
                the left, the filled Approve rightmost. Hidden while the comment
                box is open — that box carries its own Cancel · Send. */}
            {plan.status === 'proposed' && !commenting && !readOnly && (
              <div className="flex items-center justify-end gap-2 shrink-0 ml-auto">
                <Button size="sm" variant="secondary" onClick={() => setCommenting(true)} disabled={blocked}>Comment</Button>
                <Button size="sm" variant="primary" onClick={approve} disabled={blocked}>{busy === 'approve' ? 'Approving…' : 'Approve'}</Button>
              </div>
            )}
          </div>
          )}

          {/* Task 5b (decision 6): a failed plan says why, in the reader's own
              words, with the two actions for a failure the user cannot fix
              from here (error-message-standards §2). No reason → no block:
              nothing is invented. */}
          {/* Final review F6: a failed card ALWAYS says something. With no
              known reason it says so generally (the system's own text, when
              there is some, goes only to the report). */}
          {plan.status === 'failed' && (() => {
            const shown = plan.failure?.detail ?? PLAN_FAILED_GENERAL;
            const toReport = reportText(shown, plan.failure?.report);
            return (
              <ErrorState
                variant="inline"
                message={shown}
                onReportBug={() => report(toReport, false)}
                onDiagnose={() => report(toReport, true)}
              />
            );
          })()}

          {plan.autoApproved && (
            <div className="text-2xs text-fg-muted">Ran without asking — under the limit you set in Settings.</div>
          )}

          {/* Destin, round 3 (S-3/S-4/S-5): a sentence that states where the plan
              stands AND carries the buttons that answer it is the app's status
              strip — one tinted container, a status dot, the words, the action
              on the right. (`Callout` is the same shape WITHOUT an action, and
              its own doc says a block with a button is this component instead.) */}
          {plan.status === 'paused' && plan.paused && (
            <StatusStrip
              // Task 9b: grey while the assistant has it — waiting, not warning.
              tone={handoffPending ? 'idle' : 'warn'}
              surface="tinted"
              className="!py-2"
              // Task 11: at 390 px the buttons move under the reason instead
              // of crushing it into a one-letter column.
              wrapAction
              action={handoffPending || asking || readOnly ? undefined : !adding ? (
                <div className="flex flex-wrap items-center justify-end gap-2 ml-auto" data-testid="plan-pause-actions">
                  {/* Decision 24 (deck 10, G-7): a pause whose reason is a
                      general line with the system's own text behind it
                      (progress that couldn't be saved) offers Report bug in
                      this same row, far left — no separate error block. The
                      text goes only to the report screen. */}
                  {plan.paused.report && (
                    <Button size="sm" variant="secondary" onClick={() => report(reportText(plan.paused!.reason, plan.paused!.report), false)}>Report bug</Button>
                  )}
                  {/* Task 11 (§6, G-29): Ask is a light button, far left. */}
                  {canAsk && (
                    <Button size="sm" variant="secondary" onClick={() => setAsking(true)} disabled={blocked}>Ask the assistant</Button>
                  )}
                  {/* Task 9b (§2 step 7, design guide G-29): the filled button
                      is the rightmost; Stop is the light one on its left. A
                      recommended Stop is the card's one filled button. The
                      defaults come from `offered`: Stop · Add budget for the
                      budget kinds, Stop alone where only a revised plan can
                      help, Stop · Continue otherwise (an unknown outcome's
                      Continue is Task 4's explicit recovery). */}
                  {recommendation?.action === 'stop' ? (
                    <Button size="sm" variant="danger" onClick={stop} disabled={blocked}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</Button>
                  ) : (
                    <Button size="sm" variant="danger-outline" onClick={stop} disabled={blocked}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</Button>
                  )}
                  {(recommendation ? recommendation.action === 'continue' : offered.includes('continue')) && (
                    <Button size="sm" variant="primary" onClick={cont} disabled={blocked}>{busy === 'continue' ? 'Continuing…' : 'Continue'}</Button>
                  )}
                  {(recommendation ? recommendation.action === 'add_budget' : offered.includes('add_budget')) && (
                    <Button size="sm" variant="primary" onClick={() => setAdding(true)} disabled={blocked}>Add budget</Button>
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-end gap-2 ml-auto" data-testid="plan-add-budget">
                  <span className="text-xs text-fg-dim">Allow</span>
                  <TextInput size="sm" inputMode="numeric" value={Number(extra) ? Number(extra).toLocaleString() : extra} onChange={(e) => setExtra(e.target.value.replace(/[^0-9]/g, ''))} className="w-20" aria-label="Tokens to allow" />
                  {/* Final review F23: an approximate plan's dollar figure wears the tilde too (R26). */}
                  <span className="text-xs text-fg-dim">tokens{plan.ceilingUsd != null && plan.ceilingTokens > 0 ? ` (${estimateUsd((Number(extra) || 0) * (plan.ceilingUsd / plan.ceilingTokens), approx(plan))})` : ''}</span>
                  <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={blocked}>Cancel</Button>
                  <Button size="sm" variant="primary" onClick={addBudget} disabled={blocked || !(Number(extra) > 0) || belowMinimum}>{busy === 'budget' || busy === 'continue' ? 'Continuing…' : 'Continue'}</Button>
                </div>
              )}
            >
              <PausedReason plan={plan} pause={pause} stepNumber={pausedIndex + 1} />
              {/* Task 14: the new-limit question, in the strip that already
                  carries Continue — one block, not a second one. */}
              {limitNotice && (
                <span className="block mt-0.5 font-medium text-fg" data-testid="plan-limit-notice">{limitNotice}</span>
              )}
              {handoffPending && (
                <span className="block mt-0.5 font-medium text-fg" data-testid="plan-handoff-pending">
                  {/* Task 11 (§6, review 4-5): a question behind a reply in
                      progress says it will wait, rather than look stuck. */}
                  {handoff?.waiting === 'reply' ? 'The assistant will look at this after its current reply.' : 'The assistant is looking into this.'}
                </span>
              )}
              {recommendation && (
                <span className="block mt-0.5 text-fg" data-testid="plan-recommendation">
                  <span className="font-medium">The assistant suggests:</span> {recommendation.message}
                </span>
              )}
              {/* Task 5b: the smallest amount that lets the plan go on, while
                  the amount is being chosen. Below it, the same words turn into
                  the field's error and Continue stays disabled. */}
              {adding && minimum !== undefined && (
                <span className="block mt-0.5" data-testid="plan-add-minimum">
                  {belowMinimum
                    ? <FieldError size="2xs">Add at least {tokens(minimum)} to continue.</FieldError>
                    : <span className="text-2xs text-fg-muted">Add at least {tokens(minimum)} to continue.</span>}
                </span>
              )}
            </StatusStrip>
          )}

          {/* Task 11 (§6, error-message standards): a question cleared without
              an answer. The real cause when main knows it; otherwise a
              general line that names none, with Report bug and Diagnose.
              Retry asks again. Hidden while the card's own error slot shows a
              newer failure (that one has its own Retry). */}
          {askProblem && !error && !readOnly && (
            <div data-testid="plan-ask-error">
              {askProblem.kind === 'no-start' ? (
                // "10 minutes" is main's backstop (plan-handoff.ts
                // PLAN_HANDOFF_BACKSTOP_MS; pinned by plan-card-ask.test.tsx).
                <ErrorState variant="inline" message="The assistant didn't get to your question within 10 minutes." onRetry={askAgain} />
              ) : askProblem.detail ? (
                <ErrorState variant="inline" message={`The assistant couldn't answer your question: ${askProblem.detail}`} onRetry={askAgain} />
              ) : (
                <ErrorState
                  variant="inline"
                  message="The assistant couldn't answer your question."
                  onReportBug={() => report("The assistant couldn't answer a question about a paused plan.", false)}
                  onDiagnose={() => report("The assistant couldn't answer a question about a paused plan.", true)}
                  onRetry={askAgain}
                />
              )}
            </div>
          )}

          {/* Decision 20: the Ask box — the Comment box's shape (G-29:
              Cancel light on the left, Send filled on the right). */}
          {plan.status === 'paused' && asking && !handoffPending && !readOnly && (
            <div className="space-y-1.5" data-testid="plan-ask-box">
              <Textarea
                size="sm"
                rows={2}
                className="w-full"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAsk(); } }}
                placeholder="What would you like to ask? (optional)"
                autoFocus
              />
              {questionTooLong && <FieldError size="2xs">Questions are limited to {PLAN_QUESTION_LIMIT.toLocaleString()} characters.</FieldError>}
              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => { setAsking(false); setQuestion(''); }} disabled={blocked}>Cancel</Button>
                <Button size="sm" variant="primary" onClick={submitAsk} disabled={blocked || questionTooLong} title="The assistant looks into this pause and replies in the chat">{busy === 'ask' ? 'Sending…' : 'Send'}</Button>
              </div>
            </div>
          )}

          {plan.status === 'interrupted' && (
            // Grey dot, not amber: an interrupted plan is waiting, not warning —
            // nothing went wrong and nothing is at risk.
            <StatusStrip
              // Task 14: amber only while the changed-specialists question is
              // showing — that one needs an answer; waiting for Continue does not.
              tone={limitNotice ? 'warn' : 'idle'}
              surface="tinted"
              className="!py-2"
              // Review finding 14: the changed-specialists question adds ~130
              // characters to this strip's one line, which at 390 px would
              // squeeze Stop · Continue against a column of single words. Only
              // then does the row wrap, so the plain waiting card that was
              // signed off keeps its exact one-row shape.
              wrapAction={limitNotice != null}
              action={readOnly ? undefined : (
                <div className="flex items-center gap-2 shrink-0 ml-auto" data-testid="plan-interrupted-actions">
                  <Button size="sm" variant="danger-outline" onClick={stop} disabled={blocked}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</Button>
                  <Button size="sm" variant="primary" onClick={cont} disabled={blocked}>{busy === 'continue' ? 'Continuing…' : 'Continue'}</Button>
                </div>
              )}
            >
              <span data-testid="plan-interrupted-note">
                The app closed mid-plan. {done === 0 ? 'Nothing had finished yet' : done === 1 ? 'Step 1 is saved' : `Steps 1–${done} are saved`}; Continue runs the rest.
              </span>
              {/* Task 14: an interrupted card's Continue can meet the same
                  changed-specialists question; it says so in this same strip. */}
              {limitNotice && (
                <span className="block mt-0.5 font-medium text-fg" data-testid="plan-limit-notice">{limitNotice}</span>
              )}
            </StatusStrip>
          )}

          {revised && (
            <div className="text-2xs text-fg-muted">
              {/* Task 9b: the assistant may revise a paused plan on its own. */}
              {plan.revisedOnPause ? 'Revised by the assistant — the new plan is below.' : 'Revised after your comment — the new plan is below.'}
            </div>
          )}

          {plan.status === 'proposed' && commenting && !readOnly && (
            <div className="space-y-1.5" data-testid="plan-comment">
              <Textarea
                size="sm"
                rows={2}
                className="w-full"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (comment.trim()) void sendComment(); } }}
                placeholder="What should change?"
                autoFocus
              />
              {/* Task 8 (G-29): same rule as the proposal row — Cancel (light)
                  on the left, Send (filled) rightmost, row on the right. */}
              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => { setCommenting(false); setComment(''); }} disabled={blocked}>Cancel</Button>
                <Button size="sm" variant="primary" onClick={sendComment} disabled={blocked || !comment.trim()} title="The assistant rewrites the plan and shows you a new one">{busy === 'comment' ? 'Sending…' : 'Send'}</Button>
              </div>
            </div>
          )}

      {/* The card's one error slot (Task 5b, error-message-standards): the
          host's own reason with Retry; the bridge's general "Couldn't update
          the plan" (no known cause) also gets Report bug and Diagnose
          (5b review). Never a bare red
          sentence (design guide §4.7). */}
      {error && (error === PLAN_UNREADABLE
        ? <ErrorState variant="inline" message={error} onReportBug={() => report(reportText(error, failed?.detail), false)} onDiagnose={() => report(reportText(error, failed?.detail), true)} onRetry={retry} />
        : <ErrorState variant="inline" message={error} onRetry={retry} />)}
      {/* "Plans aren't available here" is why the buttons are disabled, not a
          failure: a quiet note beside them (design guide §4.7 "Disabled"). */}
      {!error && hasControls && unsupported && <div className="text-2xs text-fg-muted">{unsupported}</div>}
      <BugReportPopup open={!!reportContext} onClose={() => setReportContext(null)} context={reportContext ?? undefined} />
    </div>
  );
}

/**
 * Task 12 follow-up 1: the Add budget minimum that holds right now. While the
 * paused specialist's prompt is still cached, only its new part must fit (the
 * warm minimum); `forMs` after this window received the view, the cold one
 * applies. A timer re-renders the card at that moment. undefined = none.
 */
function useMinimumNow(paused: PlanView['paused']): number | undefined {
  const warm = paused?.warmMinimum;
  const expiresAt = warm ? warmMinimumExpiresAt(warm) : undefined;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (expiresAt === undefined) return undefined;
    const left = expiresAt - Date.now();
    if (left < 0) return undefined;
    const timer = setTimeout(() => setTick((n) => n + 1), left + 1);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  if (warm && expiresAt !== undefined && Date.now() <= expiresAt) return warm.tokens > 0 ? warm.tokens : undefined;
  return paused?.minimumAddTokens;
}

/**
 * Task 5b — the paused pill's words. An ordinary pause shows the host's own
 * reason as signed. The two pauses plan-pause.ts recognises get plain words
 * instead of the executor's sentence (which names internal step ids and the
 * raw tool name), plus one line on what to do next.
 */
function PausedReason({ plan, pause, stepNumber }: { plan: PlanView; pause: ReturnType<typeof classifyPause>; stepNumber: number }) {
  if (pause.kind === 'unknown-outcome') {
    // "Running a command" → "running a command": the same plain verb the chat
    // uses for that tool everywhere else.
    const doing = toolActionLabel(pause.tool, true);
    const verb = doing.charAt(0).toLowerCase() + doing.slice(1);
    const where = stepNumber > 0 ? ` in step ${stepNumber}` : '';
    return (
      <>
        <span data-testid="plan-paused-reason">
          Paused — a specialist{where} stopped while {verb}, and it isn't known whether that finished.{pause.rest ? ` ${pause.rest}` : ''}
        </span>
        <span className="block mt-0.5 font-medium text-fg" data-testid="plan-paused-warning">
          Continue may run it again. Check first whether it already happened.
        </span>
      </>
    );
  }
  if (pause.kind === 'iteration-cap') {
    return (
      <>
        <span data-testid="plan-paused-reason">
          Paused — the repeated steps ran {pause.rounds} times without meeting their goal ("{pause.until}").
        </span>
        <span className="block mt-0.5" data-testid="plan-paused-warning">
          To keep going, ask the assistant for a revised plan.
        </span>
      </>
    );
  }
  return <span data-testid="plan-paused-reason">Paused — {continueSentence(plan.paused?.reason ?? '')}</span>;
}

/** r11b review: after "Paused —" the host's reason continues the sentence, so
 *  its capital goes ("Paused — the plan stopped …"). Only an ordinary
 *  capitalised word is lowered; an acronym ("API key …") keeps its case. */
function continueSentence(reason: string): string {
  return /^[A-Z][a-z]/.test(reason) ? reason.charAt(0).toLowerCase() + reason.slice(1) : reason;
}

/** The header's own detail while the plan is being written: a live clock, so the
 *  card is ONE line like every other collapsed tool card (Destin, round 1, P-4)
 *  and still visibly alive — a local model reasons 40 s to 4 min first (probe 3). */
export function PlanWritingDetail({ plan }: { plan: PlanView }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const elapsed = formatElapsed(Math.max(0, now - (plan.startedAt ?? now)));
  return (
    <span className="text-xs text-fg-muted truncate flex-1 min-w-0" data-testid="plan-writing">
      {/* Final review F19: only a model on this computer is that slow. */}
      writing the plan · {elapsed}{plan.model.local ? ' · can take a few minutes on your computer' : ''}
    </span>
  );
}

const STEP_GLYPH: Record<PlanStepView['status'], React.ReactNode> = {
  pending: <span className="inline-block w-3.5 h-3.5 rounded-full border border-edge" aria-label="not started" />,
  running: <BrailleSpinner size="sm" />,
  done: <CheckIcon className="w-3.5 h-3.5 text-fg-dim" />,
  paused: <StoppedIcon className="w-3.5 h-3.5 text-amber-500" />,
  failed: <FailIcon className="w-3.5 h-3.5 text-destructive-fg" />,
  skipped: <StoppedIcon className="w-3.5 h-3.5 text-fg-muted" />,
};

// ---- where a step's input comes from ----------------------------------------

/** Every row's display number, in the order the card draws them: "1", "2",
 *  "2.1" for the first step of the repeat on row 2. `order` is that same
 *  sequence as a number, so "is this source earlier?" is one comparison. */
type RowNumber = { label: string; order: number };
function rowNumbers(steps: PlanStepView[]): Map<string, RowNumber> {
  const map = new Map<string, RowNumber>();
  let order = 0;
  for (const [i, step] of steps.entries()) {
    const label = String(i + 1);
    map.set(step.id, { label, order: order++ });
    step.body?.forEach((b, j) => map.set(b.id, { label: `${label}.${j + 1}`, order: order++ }));
  }
  return map;
}

/**
 * "← from step 1", and only when the row directly above is NOT where this
 * step's input comes from.
 *
 * WHY the label is backward-only and usually absent (decision 33; it reverses
 * part of decision 31): every link names exactly one earlier step, so the plan
 * is always a tree, and in the ordinary chain each step simply consumes the one
 * above it — saying so on every row is noise the reader has to filter. The
 * forward clause decision 31 added ("produces 3 reports → step 2 combines
 * them") is gone with it: now that every row carries a required plain sentence,
 * it restated that sentence and doubled the row's text.
 *
 * A reference that names no EARLIER row — a hand-edited file, a forward
 * reference — produces no label at all: a wrong step number is worse than a
 * missing one.
 */
function flowLabel(step: PlanStepView, siblings: PlanStepView[], index: number, numbers: Map<string, RowNumber>): string {
  if (!step.of) return '';
  const source = numbers.get(step.of);
  const self = numbers.get(step.id);
  if (!source || !self || source.order >= self.order) return '';
  if (index > 0 && siblings[index - 1].id === step.of) return '';
  return `← from step ${source.label}`;
}

/** What this step may spend at worst. A repeat's body steps each carry their
 *  own budget, so its total is computed once in the projection rather than
 *  from a single pair of numbers here. */
function stepCeiling(step: PlanStepView): number {
  return step.ceilingTokens ?? perSpecialist(step) * step.fanOut;
}

/** The ROW a pause belongs to (a repeat's, when it paused inside the body) and
 *  the step that actually ran out (the body step itself). */
function findPausedRow(steps: PlanStepView[], id: string | undefined): { index: number; step: PlanStepView } | undefined {
  if (!id) return undefined;
  for (const [index, step] of steps.entries()) {
    if (step.id === id) return { index, step };
    const inner = step.body?.find((b) => b.id === id);
    if (inner) return { index, step: inner };
  }
  return undefined;
}

/** WHY the card caps the rows a fan-out step draws (renderer-lists.md: nothing
 *  the user cannot see is built): the grammar stops a fan-out at 8 items, but
 *  the card also replays records written by other builds, and a step's
 *  breakdown must never become an unbounded list. The rest are counted, not
 *  dropped in silence. */
const ITEM_ROWS_MAX = 8;

/**
 * The brief, minus the line the row above it is already showing.
 *
 * WHY (2026-09-18): opening a step was made to show the whole `task`, but the
 * row shows that task's first line, so every expansion repeated it. A line is
 * dropped ONLY when the row printed it in full — a headline the row had to cut
 * at 80 characters, or a row showing the assistant's `summary` instead, still
 * needs the brief entire. A one-line brief the row already shows leaves nothing
 * to add, and returns '' so the card draws no empty block.
 */
function briefBelowRow(task: string | undefined, rowLine: string): string {
  if (!task) return '';
  const body = task.trim();
  const breakAt = body.indexOf('\n');
  const firstLine = (breakAt === -1 ? body : body.slice(0, breakAt)).trim();
  if (firstLine !== rowLine) return body;
  return breakAt === -1 ? '' : body.slice(breakAt + 1).replace(/^\n+/, '');
}

/** The placeholder a fan-out brief carries where each specialist's own line
 *  goes. MARKED, never substituted: substituting it silently would say all
 *  seven specialists are sent seven different briefs, when the truth is one
 *  brief with one slot (Destin, 2026-09-18). */
const ITEM_SLOT = '{item}';

/** How many lines of the brief the collapsed preview draws. A real slice, not
 *  a fade (renderer-lists.md); the rest opens into a capped scroller, the same
 *  treatment a file box gets. */
const BRIEF_PREVIEW_LINES = 6;

/** The brief with every `{item}` drawn as the slot it is. */
function markItemSlot(text: string): React.ReactNode {
  const parts = text.split(ITEM_SLOT);
  if (parts.length === 1) return text;
  return parts.map((part, i) => (
    <span key={i}>
      {i > 0 && <span className="rounded border border-edge px-1 text-fg-2" data-testid="plan-step-slot">{ITEM_SLOT}</span>}
      {part}
    </span>
  ));
}

/**
 * The ONE brief every specialist in this step is sent.
 *
 * WHY it is labelled, bounded, and sits ABOVE the rows (Destin, 2026-09-18:
 * "lots of bare text at the bottom with no indication how it ties into the
 * cards above"): it used to be thirty unlabelled lines under seven rows, and
 * nothing on the card said what those lines were or who received them. That
 * relationship is the most important fact on an opened fan-out step. The brief
 * is what the specialists have in COMMON, so it goes above the part that
 * varies, wearing an eyebrow that names it and a collapsed preview so it can
 * never be a wall again.
 */
function StepBrief({ text, items }: { text: string; items: number }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  const hidden = Math.max(0, lines.length - BRIEF_PREVIEW_LINES);
  const shown = open || hidden === 0 ? text : lines.slice(0, BRIEF_PREVIEW_LINES).join('\n');
  return (
    <div className="rounded-md border border-edge-dim bg-inset/40 px-2 py-1.5 space-y-1" data-testid="plan-step-brief">
      <div className="text-2xs uppercase tracking-wide text-fg-muted">
        {items > 1 ? `The same brief for all ${items}` : 'The brief'}
      </div>
      {/* Decision: say it ONCE, plainly, and only where the slot exists.
          "above", not "below": decision 33 puts the item rows FIRST and the
          shared brief under them, so the old word pointed the reader the wrong
          way down the card. */}
      {items > 1 && text.includes(ITEM_SLOT) && (
        <div className="text-2xs text-fg-muted" data-testid="plan-step-slot-note">
          Each one gets its own line from the list above where {ITEM_SLOT} appears.
        </div>
      )}
      <div
        className={`text-2xs text-fg-dim whitespace-pre-wrap break-words ${open ? 'max-h-64 overflow-y-auto' : ''}`}
        data-testid="plan-step-task"
      >{markItemSlot(shown)}</div>
      {hidden > 0 && (
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} data-testid="plan-step-brief-toggle">
          {open ? 'Show less' : `Show all ${lines.length} lines`}
        </Button>
      )}
    </div>
  );
}

/**
 * Whether a clamped element is actually hiding any of its text.
 *
 * WHY it is MEASURED and not guessed from the string's length (Destin,
 * 2026-09-18: "substep cards that have chevrons and appear to be
 * clickable/expandable but never expand"): a fan-out item wraps differently at
 * every card width, so the only honest answer is the element's own. Measured
 * while the element is CLAMPED and remembered while it is open — an open row is
 * unclamped, so re-measuring there would report "nothing hidden" and take away
 * the control that closes it again.
 *
 * WHY a callback ref and an `isConnected` guard rather than a plain one: saying
 * "this row has something hidden" turns its wrapper from a <div> into a
 * <button>, which remounts the measured element. With a plain ref the observer
 * stayed on the DETACHED node, measured 0 against 0, and reported the text
 * unclamped again — the chevron appeared and vanished within a frame, so every
 * row on the real plan lost it. The callback ref re-binds to the new node.
 */
function useClamped(open: boolean, text: string): [(el: HTMLSpanElement | null) => void, boolean] {
  const [node, setNode] = useState<HTMLSpanElement | null>(null);
  const [clamped, setClamped] = useState(false);
  useEffect(() => {
    if (open || !node) return undefined;
    const measure = () => { if (node.isConnected) setClamped(node.scrollHeight - node.clientHeight > 1); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, text, node]);
  return [setNode, clamped];
}

/**
 * One labelled part of an opened step (design guide G-7: an eyebrow is the only
 * section header). Every section of the opened body wears one, so the four
 * things a step can show — the parts, the shared brief, the stop condition and
 * the limits — are never again a run of unlabelled paragraphs.
 */
function StepSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1" data-testid={`plan-step-section-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
      <div className="text-2xs uppercase tracking-wide text-fg-muted">{label}</div>
      {children}
    </div>
  );
}

function StepRow({ step, index, siblings, number, numbers, plan, sessionId }: {
  step: PlanStepView; index: number;
  /** The list this row sits in — the plan's steps, or a repeat's body. */
  siblings: PlanStepView[];
  /** "2" at the top level, "2.1" inside a repeat. */
  number: string;
  numbers: Map<string, RowNumber>;
  plan: PlanView; sessionId?: string;
}) {
  // A running step opens itself so its specialists are visible without a
  // click (Q-5: the card is the progress surface); anything else folds.
  // Task 5a: a specialist in this step waiting on the user opens the step
  // too — its buttons are useless behind a folded row (the same rule that
  // force-opens a Task card holding an ask).
  const asking = !!step.children?.some((c) => c.segments?.some((sg) => sg.type === 'tool' && sg.status === 'awaiting-approval' && !!sg.requestId));
  const [open, setOpen] = useState(step.status === 'running' || step.status === 'paused' || asking);
  useEffect(() => { if (step.status === 'running' || step.status === 'paused') setOpen(true); }, [step.status]);
  useEffect(() => { if (asking) setOpen(true); }, [asking]);
  // Decision 33: WHO does it — a count and a role, on every kind, with no kind
  // word beside it. "at the same time" / "checks each result" / "combines the
  // results" are gone: with a required plain sentence on the row they restated
  // the sentence. A repeat launches no specialist of its own, so its count is
  // its rounds, and a ceiling ("up to 3 rounds") because it stops the moment it
  // meets its goal.
  const who = step.kind === 'repeat'
    ? `up to ${step.rounds ?? 1} round${step.rounds === 1 ? '' : 's'}`
    : `${step.fanOut} ${step.specialist}${step.fanOut === 1 ? '' : 's'}`;
  // Task 11: on a phone-width screen one line cut every title to "1." (the
  // token figure and the specialist words took the room), so the details
  // move to a second line there. Wide screens keep the signed one-line row.
  const narrow = useNarrowViewport();
  // Decision 30: the row is the assistant's plain sentence for the reader.
  // Decision 33 made it required, so `title` — the first line of a brief
  // addressed to a machine — is only the fallback for a record written before
  // that change.
  const line = step.summary ?? step.title;
  const flow = flowLabel(step, siblings, index, numbers);
  const detail = flow ? `${flow} · ${who}` : who;
  // Decision 33 item 3: a repeat says on its COLLAPSED row when it will stop —
  // the one fact that decides whether "up to 3 rounds" is worth approving. One
  // line here, whole when the row is opened.
  const stops = step.kind === 'repeat' && step.until ? `Stops when: ${step.until}` : '';
  // WHY the token figure leaves a PROPOSED row (decision 30): "up to 286,181
  // tokens" was the loudest thing on every row and the least useful before
  // approval. While a plan is only proposed the row is about WHAT will happen
  // and the figure moves into the opened step; the moment it is running,
  // paused or finished the row is about progress and spend, exactly as signed.
  const proposing = plan.status === 'proposed';
  const right =
    proposing ? ''
    : step.status === 'pending' ? `up to ${limitTokens(plan, stepCeiling(step))}`
    // Final review F26: "0 of 1 reviewer done", not "reviewers".
    : step.status === 'running' || step.status === 'paused' ? `${step.done ?? 0} of ${step.fanOut} ${step.specialist}${step.fanOut === 1 ? '' : 's'} done · ${tokens(step.usedTokens ?? 0)}`
    : step.status === 'done' ? tokens(step.usedTokens ?? 0)
    : '';
  const brief = briefBelowRow(step.task, line);
  return (
    // Destin, round 2 (R-2): a step is a container like the cards above and
    // below it, so the nesting reads plan → step → specialist by shape rather
    // than by indentation; the specialists sit on the container's own padding.
    <li className="border border-edge-dim rounded-md overflow-hidden bg-inset/25" data-testid={`plan-step-${step.id}`} data-step-status={step.status}>
      {narrow ? (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="w-full flex flex-col gap-0.5 text-left px-2 py-1 hover:bg-inset/50 transition-colors">
          <span className="flex items-center gap-2 min-w-0">
            <span className="shrink-0 inline-flex w-3.5 justify-center">{STEP_GLYPH[step.status]}</span>
            <span className="text-xs text-fg-muted tabular-nums shrink-0">{number}.</span>
            {/* Final review F8 (R41): on a narrow window the title wraps. */}
            <span className={`text-xs ${step.status === 'done' ? 'text-fg-dim' : 'text-fg-2'} break-words flex-1 min-w-0`} data-testid="plan-step-title">{line}</span>
            <ChevronIcon className="w-3 h-3 text-fg-muted shrink-0" expanded={open} />
          </span>
          {/* Lined up under the title (glyph 0.875rem + gap 0.5rem). */}
          {/* UX tester: the usage figure ("2 of 3 reviewers done · 27,000
              tokens") was held at full width and clipped by the card edge.
              It now wraps: first onto its own line, then within itself. */}
          <span className="flex flex-wrap items-center gap-x-2 min-w-0 pl-5.5">
            {/* WRAPS on a phone, where the wide row truncates. Decision 33 put
                a flow label in front of the count ("← from step 1 · 1
                researcher"), and at 390 px that cut the role word off the end —
                the same unreadable half-line the item preview was removed for.
                Only a row that has more to say than fits gets a second line. */}
            <span className="text-2xs text-fg-dim break-words min-w-0" data-testid="plan-step-detail">{detail}</span>
            <span className="ml-auto text-2xs text-fg-muted tabular-nums min-w-0 text-right">{right}</span>
          </span>
          {stops && <span className="text-2xs text-fg-dim truncate max-w-full pl-5.5" data-testid="plan-step-stops">{stops}</span>}
        </button>
      ) : (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="w-full flex flex-col gap-0.5 text-left px-2 py-1 hover:bg-inset/50 transition-colors">
          <span className="flex items-center gap-2 w-full min-w-0">
            <span className="shrink-0 inline-flex w-3.5 justify-center">{STEP_GLYPH[step.status]}</span>
            <span className="text-xs text-fg-muted tabular-nums shrink-0">{number}.</span>
            <span className={`text-xs ${step.status === 'done' ? 'text-fg-dim' : 'text-fg-2'} truncate`} data-testid="plan-step-title">{line}</span>
            {/* WHY the detail never shrinks (2026-09-19): both this and the
                sentence beside it were flex items that could truncate, so
                flexbox cut them in proportion and a long sentence ate the
                count — "← from step 1 · 1 re…" on the fork fixture. The count
                and the source step are short, bounded and the two facts a row
                exists to carry; the sentence is the long, self-describing one
                and is the only thing here that may lose its tail. */}
            <span className="text-2xs text-fg-dim shrink-0" data-testid="plan-step-detail">{detail}</span>
            <span className="ml-auto text-2xs text-fg-muted tabular-nums shrink-0">{right}</span>
            <ChevronIcon className="w-3 h-3 text-fg-muted shrink-0" expanded={open} />
          </span>
          {/* The repeat's second line. `truncate` holds it to ONE line whatever
              the window is, so a long stop condition can never make one row
              taller than the rest; the whole of it is one click away. */}
          {stops && <span className="text-2xs text-fg-dim truncate max-w-full pl-5.5" data-testid="plan-step-stops">{stops}</span>}
        </button>
      )}
      {open && (
        // Decision 33: ONE opened anatomy, in one fixed order, each part
        // labelled and each omitted when this step has no such data — the
        // parts, the shared brief, the stop condition, the limits.
        <div className="px-1.5 pb-1.5 pt-1 space-y-1.5 border-t border-edge-dim">
          {/* Decision 33: a repeat is one row that CONTAINS its body — the only
              nesting the card has, because the grammar forbids a repeat inside
              a repeat. The rows below are numbered 2.1, 2.2 under step 2. */}
          {step.body && step.body.length > 0 && (
            // NOT "each round": a body row's count is its worst case over ALL
            // the rounds (2 items × 3 rounds = 6 workers), the same number the
            // flattened rows always showed, so a per-round heading would
            // misread every figure under it.
            <StepSection label={`What repeats${step.rounds ? `, up to ${step.rounds} times` : ''}`}>
              <ol className="space-y-1" data-testid="plan-step-body">
                {step.body.map((b, i) => (
                  <StepRow key={b.id} step={b} index={i} siblings={step.body!} number={`${number}.${i + 1}`}
                    numbers={numbers} plan={plan} sessionId={sessionId} />
                ))}
              </ol>
            </StepSection>
          )}
          {step.children && step.children.length > 0 ? (
            step.children.map((c) => <PlanSpecialistCard key={c.childId} child={c} sessionId={sessionId} />)
          ) : (
            <>
              {/* Decision 31: one ROW PER SPECIALIST, each carrying its own
                  slice — the same rows this step draws once it is running, so
                  the card keeps its shape when the plan starts. */}
              {step.items && step.items.length > 1 && (
                <StepSection label="What each one gets">
                  <div className="space-y-1" data-testid="plan-step-items">
                    {step.items.slice(0, ITEM_ROWS_MAX).map((item, i) => <PlanItemRow key={`${i}-${item}`} index={i} item={item} />)}
                    {step.items.length > ITEM_ROWS_MAX && (
                      <div className="text-2xs text-fg-muted">…and {step.items.length - ITEM_ROWS_MAX} more.</div>
                    )}
                  </div>
                </StepSection>
              )}
              {/* Decision 33: a ONE-ITEM split draws no list — one thing is not
                  a list, and a numbered row with a chevron promises siblings it
                  does not have. It still says WHAT the one specialist is given:
                  the brief above it can name `{item}`, and a slot pointing at
                  nothing at all is worse than no list. */}
              {step.items && step.items.length === 1 && (
                <StepSection label="What it gets">
                  <div className="text-2xs text-fg-dim break-words" data-testid="plan-step-item-only">{step.items[0]}</div>
                </StepSection>
              )}
              {/* Destin, 2026-09-18: the row shows one sentence, so before
                  Approve there was no way to read what the specialists are
                  actually sent. Labelled and bounded (StepBrief). Absent on
                  plans projected before `task` existed. A repeat's own brief is
                  shared with nobody — its body steps carry theirs — so it is
                  "The brief", never "the same brief for all 9". */}
              {brief && <StepBrief text={brief} items={step.body ? 1 : (step.items?.length ?? step.fanOut)} />}
            </>
          )}
          {/* Decision 33 item 3: the whole stop condition, for the repeat whose
              row could only show one line of it. */}
          {step.until && (
            <StepSection label="Stops when">
              <div className="text-2xs text-fg-dim break-words" data-testid="plan-step-until">{step.until}</div>
            </StepSection>
          )}
          <StepSection label="Limits">
            <div className="text-2xs text-fg-muted" data-testid="plan-step-limits">
              {/* A repeat launches no specialist of its own — its body rows
                  carry the per-specialist figures — so it states its total
                  only, and never a per-specialist limit it does not have. */}
              {step.body
                ? `Up to ${limitTokens(plan, stepCeiling(step))} for this step, over all its rounds.`
                : <>Each {step.specialist} stops at its {tokenLimit(plan, perSpecialist(step))}.
                  {/* Decision 30: the figure the proposed row no longer carries,
                      beside the per-specialist limit it belongs with. */}
                  {proposing ? ` Up to ${limitTokens(plan, stepCeiling(step))} for this step.` : ''}</>}
            </div>
          </StepSection>
        </div>
      )}
    </li>
  );
}

/**
 * The header every specialist row inside a step wears: glyph · divider · name ·
 * whatever that row has to say · chevron. Shared by the RUNNING specialist card
 * and by the pending rows a fan-out step shows before it starts, so the two
 * cannot drift apart (decision 31: approving the plan is a preview of watching
 * it run, and the card must not change shape the moment it starts).
 *
 * WHY `onToggle` is optional (Destin, 2026-09-18: rows "that have chevrons and
 * appear to be clickable/expandable but never expand"): a row with nothing
 * hidden is not a button at all — no chevron, no hover, no focus stop. A
 * chevron is a promise of a disclosure, and the card may only draw one where
 * there is something to disclose.
 */
function SpecialistRowButton({ open, onToggle, glyph, name, children }: {
  open: boolean; onToggle?: () => void; glyph: React.ReactNode; name: React.ReactNode; children?: React.ReactNode;
}) {
  const row = 'w-full flex items-center gap-1.5 px-2 py-1 text-left';
  const inner = (
    <>
      <span className="shrink-0 inline-flex w-3 justify-center">{glyph}</span>
      <span aria-hidden="true" className="w-px h-3 bg-edge shrink-0" />
      <span className="text-xs font-medium text-fg-2 shrink-0">{name}</span>
      {children}
    </>
  );
  if (!onToggle) return <div className={row}>{inner}</div>;
  return (
    <button type="button" onClick={onToggle} aria-expanded={open}
      className={`${row} hover:bg-inset transition-colors`}>
      {inner}
      <ChevronIcon className="w-3 h-3 text-fg-muted shrink-0" expanded={open} />
    </button>
  );
}

/** The circle a specialist that has not started wears, here and on a stopped
 *  child that never sent its first request. */
const NOT_STARTED_GLYPH = <span className="inline-block w-3 h-3 rounded-full border border-edge" aria-label="not started" />;

/**
 * One PENDING specialist of a fan-out step, carrying the slice of the work that
 * specialist will be given.
 *
 * WHY a row rather than a line in a list (decision 31, Destin: "it's not clear
 * to me how this breaks out into 7 reviewers"): a real fan-out item is a label
 * plus a long file list, so seven of them read as seven paragraphs, not seven
 * workers. Held to two lines each; the whole of it is one click away, because
 * the point is that he can SEE both the breakdown and the detail. The row is
 * the running specialist's own row in its not-started state, so these exact
 * rows are the ones that light up when the plan starts.
 *
 * It offers that click ONLY while its two lines are actually hiding something
 * (`useClamped`). An item that already fits is a plain row: pressing it did
 * nothing, and a chevron that does nothing is worse than no chevron.
 */
function PlanItemRow({ index, item }: { index: number; item: string }) {
  const [open, setOpen] = useState(false);
  const [textRef, clamped] = useClamped(open, item);
  return (
    <div className="border border-edge rounded-md overflow-hidden bg-inset/60" data-testid="plan-step-item">
      <SpecialistRowButton open={open} onToggle={clamped ? () => setOpen((v) => !v) : undefined} glyph={NOT_STARTED_GLYPH} name={`${index + 1}.`}>
        <span
          ref={textRef}
          className={`min-w-0 flex-1 text-xs text-fg-dim ${open ? 'whitespace-pre-wrap break-words' : 'line-clamp-2'}`}
          data-testid="plan-step-item-text"
        >{item}</span>
      </SpecialistRowButton>
    </div>
  );
}

/**
 * One specialist inside a plan step — the SAME card a hired specialist gets in
 * chat: a collapsed header (glyph · name · status) that opens onto Briefing,
 * Activity (its thinking, tool calls and output) and Report, with Send-a-note
 * and Stop while it runs. Destin, review round 1 (P-5): "keep our current
 * agent/specialist cards … Plan → Step → Specialist".
 *
 * Built from the plan's own child record rather than a Task tool call, because
 * a plan's children are spawned by the step — the model never calls Task once
 * per specialist, so there is no tool card to hang them on.
 */
function PlanSpecialistCard({ child, sessionId }: { child: PlanChildView; sessionId?: string }) {
  const readOnly = sessionId?.startsWith(PREVIEW_KEY_PREFIX) === true;
  const tool = useMemo<ToolCallState>(() => planChildCard(child), [child]);
  // Task 5a: this specialist's ask is answered inside its Activity, so the row
  // opens when one arrives (Activity itself opens for it — AgentSections).
  // Opens once per ask; the user can still fold it afterwards.
  const asking = hasNestedAsk(tool);
  const [open, setOpen] = useState(asking);
  useEffect(() => { if (asking) setOpen(true); }, [asking]);
  // Task 5b: a specialist that Stop caught before its first request was ever
  // sent never started, so "the assistant can pick this back up" would
  // describe work that never existed. 5b follow-up: decided from the
  // journal's attempt phase (`prepared` = nothing sent), not guessed from
  // missing activity — a specialist whose request was out but had shown
  // nothing yet may already have spent tokens. No phase → never "Not started".
  const notStarted = child.status === 'interrupted' && child.phase === 'prepared';
  const glyph = child.status === 'running' ? <BrailleSpinner size="sm" />
    : child.status === 'completed' ? <CheckIcon className="w-3 h-3 text-fg-dim" />
    : child.status === 'failed' ? <FailIcon className="w-3 h-3 text-destructive-fg" />
    // The same empty circle a step that hasn't started wears.
    : notStarted ? NOT_STARTED_GLYPH
    : <StoppedIcon className="w-3 h-3 text-fg-muted" />;
  // The same promise-of-interactivity bug as PlanItemRow's, found in the sweep
  // that fix asked for: AgentSections renders NOTHING for a child with no
  // briefing, no activity and no report — which is exactly a specialist Stop
  // caught before its first request went out. Its chevron opened onto an empty
  // box. These are the four things the opened body can contain, so the row is
  // a button only when one of them exists.
  const hasBody = !!child.prompt || (child.segments?.length ?? 0) > 0 || !!child.report
    || (child.status === 'running' && !!sessionId && !readOnly);
  return (
    <div className="border border-edge rounded-md overflow-hidden bg-inset/60" data-testid="plan-child">
      <SpecialistRowButton open={open} onToggle={hasBody ? () => setOpen((v) => !v) : undefined} glyph={glyph} name={child.title}>
        <div className="min-w-0 flex-1 truncate">
          {notStarted
            ? <div className="text-xs text-fg-muted" data-testid="specialist-status-line">Not started</div>
            : <RunStatusLine run={child} report={child.report} />}
        </div>
        {/* Task 9a (pause handoff §1): the plan restarted this specialist by
            itself after an error. Muted and beside the status, so the row
            otherwise looks exactly as before and the card keeps running. */}
        {child.retried && (
          <span className="shrink-0 text-2xs text-fg-muted" data-testid="plan-child-retried">Retried after an error</span>
        )}
      </SpecialistRowButton>
      {open && hasBody && (
        <div className="px-2 py-1.5 border-t border-edge-dim space-y-1">
          <AgentSections tool={tool} sessionId={sessionId}>
            {child.status === 'running' && sessionId && !readOnly && <SpecialistActions sessionId={sessionId} run={child} />}
          </AgentSections>
        </div>
      )}
    </div>
  );
}
