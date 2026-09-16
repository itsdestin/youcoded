import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlanView, PlanStepView, PlanChildView, ToolCallState } from '../../../shared/types';
import { useChatDispatch } from '../../state/chat-context';
import { Button, ErrorState, FieldError, StatusStrip, Textarea, TextInput } from '../ui';
import { CheckIcon, FailIcon, StoppedIcon, ChevronIcon } from '../Icons';
import { BugReportPopup } from '../development/BugReportPopup';
import type { ReportContext } from '../development/ReportDesign';
import { toolActionLabel } from '../../utils/tool-group-summary';
import { classifyPause } from './plan-pause';
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
  const title = plan?.title || asString(input.title) || 'a plan';
  const label = `Plan: ${title}`;
  if (!plan) return { label, detail: '' };
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const detail =
    // The writing clock is live, so the header renders <PlanWritingDetail>
    // instead of this static string (Destin, round 1, P-4: one line, like every
    // other collapsed tool card).
    plan.status === 'writing' ? ''
    : plan.status === 'proposed' ? 'waiting for your approval'
    : plan.status === 'running' ? `step ${Math.min(done + 1, total)} of ${total}`
    // Task 5b: two pauses are not about the limit, and the header must not
    // say they are (plan-pause.ts explains how they are told apart).
    : plan.status === 'paused' ? pausedDetail(plan)
    : plan.status === 'interrupted' ? `interrupted — ${done} of ${total} steps done`
    : plan.status === 'completed' ? `finished in ${formatElapsed((plan.endedAt ?? 0) - (plan.startedAt ?? 0))}`
    : plan.status === 'stopped' ? (plan.revisedBy ? 'revised — see the new plan below' : `stopped — ${done} of ${total} steps done`)
    : 'failed';
  return { label, detail };
}

function pausedDetail(plan: PlanView): string {
  const kind = classifyPause(plan.paused).kind;
  return kind === 'unknown-outcome' ? 'paused — check before continuing'
    : kind === 'iteration-cap' ? 'paused — needs a revised plan'
    : 'paused — reached its limit';
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

/** "$0.12"; "less than a cent" rather than a false "$0.00" (error-message
 *  standard: never print a zero that is not one). */
function usd(n: number): string {
  if (n > 0 && n < 0.005) return 'less than a cent';
  return `$${n.toFixed(2)}`;
}

/** Task 8 (review 6, R6-1): a limit one reply can overshoot (ChatGPT sends
 *  without an output cap) is not exact, so every LIMIT figure on the card —
 *  tokens and dollars alike — wears a tilde: "~42,000 tokens", "~$0.12".
 *  Spent figures are real counts and never get one. Replaced the 5b "about"
 *  wording plus its extra "On ChatGPT…" sentence, which the product owner
 *  found unnecessary. An exact limit reads exactly as signed. */
function approx(plan: PlanView): string { return plan.approximateLimit ? '~' : ''; }
function limitTokens(plan: PlanView, n: number): string { return `${approx(plan)}${tokens(n)}`; }

/** The ceiling, priced when the model has a price. */
function ceiling(plan: PlanView): string {
  // UX run 1, U9/U21: the dollar figure is the part a student understands, so it
  // leads when the model has a price; the token limit always follows (spec §4).
  // "specialists run on" says whose model this is — the chat may be on another.
  const t = limitTokens(plan, plan.ceilingTokens);
  if (plan.ceilingUsd == null) return `Up to ${t} · specialists run on ${plan.model.label}, which has no published price`;
  // A priced ceiling was always "about $X" (a price is an estimate); an
  // approximate one says it with the tilde instead, like its token figure.
  const dollars = plan.approximateLimit ? `~${usd(plan.ceilingUsd)}` : `about ${usd(plan.ceilingUsd)}`;
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
  return plan.ceilingUsd == null ? `the ${t} limit` : `the ${approx(plan)}${usd(plan.ceilingUsd)} limit (${t})`;
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
  // Destin, round 2 (R-1): while the plan is being written the card must be
  // exactly a header row — not a header plus an empty padded body, which read
  // as thicker than every other collapsed tool card.
  const writing = plan.status === 'writing';
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState('');
  const [adding, setAdding] = useState(false);
  // UX run 1, U18: default to the paused step's own per-specialist cap (a
  // sensible size for one more pass), shown with a thousands comma.
  // Task 5b: when the host says a smaller amount would only pause again
  // (`minimumAddTokens`), the field starts AT that minimum instead.
  const pausedIndex = plan.steps.findIndex((st) => st.id === plan.paused?.stepId);
  const pausedStep = pausedIndex >= 0 ? plan.steps[pausedIndex] : undefined;
  const minimum = plan.paused?.minimumAddTokens;
  const [extra, setExtra] = useState(String(minimum ?? pausedStep?.budgetTokens ?? 10000));
  // A later push can raise or set the minimum while the card is open: never
  // leave the field below the new floor.
  useEffect(() => {
    if (minimum !== undefined) setExtra((v) => (Number(v) < minimum ? String(minimum) : v));
  }, [minimum]);
  const belowMinimum = minimum !== undefined && (Number(extra) || 0) < minimum;
  const pause = classifyPause(plan.paused);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Task 5b: the card's error line offers Retry (error-message-standards:
  // every error has an action). Retry repeats the button that failed.
  const lastAction = useRef<(() => void) | null>(null);
  const [reportContext, setReportContext] = useState<ReportContext | null>(null);
  // Task 5a: a device or host that can't run plans (asked once per window, or
  // learned from a button's answer) keeps every control disabled and says why
  // in the card's own error line. Nothing is retried or shown in advance.
  const probedUnsupported = usePlanUnsupported();
  const [answeredUnsupported, setAnsweredUnsupported] = useState<string | null>(null);
  const unsupported = answeredUnsupported ?? probedUnsupported?.error ?? null;
  const blocked = busy !== null || unsupported !== null;
  const revised = plan.status === 'stopped' && !!plan.revisedBy;
  // Only a card that offers buttons explains why they are disabled; a
  // finished, failed or revised card has nothing to refuse (Task 5a review).
  const hasControls = !revised && (plan.status === 'proposed' || plan.status === 'running' || plan.status === 'paused' || plan.status === 'interrupted');
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
    if (!sessionId || unsupported !== null || inFlight.current) return null;
    inFlight.current = true;
    setBusy(name); setError(null);
    try {
      const res = await planAction(fn);
      if (res.ok) { dispatch({ type: 'PLAN_CHANGED', sessionId, plan: res.plan }); return res.plan; }
      if (res.unsupported) setAnsweredUnsupported(res.error);
      else setError(res.error);
      return null;
    } finally { inFlight.current = false; setBusy(null); }
  };
  const id = sessionId ?? '';
  const approve = () => { lastAction.current = approve; return act('approve', (b) => b.approve(id, plan.planId)); };
  // A refused note or amount stays where it was typed, so it can be sent again.
  const sendComment = () => { lastAction.current = sendComment; return act('comment', (b) => b.comment(id, plan.planId, comment.trim())).then((ok) => { if (ok) { setComment(''); setCommenting(false); } }); };
  const addBudget = async () => {
    // Task 5b: an amount under the host's minimum is refused here, before
    // anything is sent — the host would refuse it anyway.
    if (belowMinimum) return;
    lastAction.current = addBudget;
    const landed = await act('budget', (b) => b.addBudget(id, plan.planId, Number(extra) || 0));
    if (!landed) return;
    setAdding(false);
    // Task 5b: the real host only raises the limit and leaves the plan
    // paused; the control's button says Continue (R8: "continues from where
    // the plan stopped"), so the card presses Continue for the user. An
    // answer that already runs the plan (the workbench fake) is not resumed
    // a second time.
    // Retry after THIS step must only continue — repeating addBudget would
    // add the tokens twice.
    if (landed.status === 'paused') { lastAction.current = cont; await act('continue', (b) => b.resume(id, plan.planId)); }
  };
  const cont = () => { lastAction.current = cont; return act('continue', (b) => b.resume(id, plan.planId)); };
  const stop = () => { lastAction.current = stop; return act('stop', (b) => b.stop(id, plan.planId)); };
  const retry = () => { void lastAction.current?.(); };
  // Report bug / Diagnose open the app's ticket screen with the real text.
  const report = (errorText: string, diagnose: boolean) => setReportContext({ surface: 'a plan card', error: errorText, ...(diagnose ? { diagnose } : {}) });

  const specialists = plan.steps.reduce((n, s) => n + s.fanOut, 0);
  const done = plan.steps.filter((s) => s.status === 'done').length;
  if (writing) return null;

  return (
    <div className={`px-3 pb-2.5 pt-1.5 space-y-2 ${revised ? 'opacity-60' : ''}`} data-testid="plan-block" data-plan-status={plan.status}>
      <ol className="space-y-1" data-testid="plan-steps">
            {plan.steps.map((step, i) => (
              <StepRow key={step.id} step={step} index={i} plan={plan} sessionId={sessionId} />
            ))}
          </ol>

          {/* ONE ceiling line (Q-2). While the plan moves it becomes "spent of".
              A running plan's Stop shares this row (Destin, round 2).
              Task 5b: a failed card salvaged from a damaged file has no steps
              and a 0 limit — printing "of the 0 tokens limit" says nothing true,
              so that card shows only its reason. */}
          {plan.steps.length > 0 && (
          <div className="flex items-center justify-between gap-3 flex-wrap" data-testid="plan-ceiling">
          <span className="text-xs text-fg-dim min-w-0">
            {plan.status === 'proposed' || revised
              // A revised plan never ran, so it keeps its proposal line rather
              // than a meaningless "Spent 0" (UX run 1 follow-up).
              ? <>{specialists} specialist{specialists === 1 ? '' : 's'} · {ceiling(plan)}</>
              // UX run 1, U16: the header already says how long it took.
              : plan.status === 'completed'
                ? <>Spent {spent(plan)} of {limit(plan)}</>
                : <>Spent {spent(plan)} of {limit(plan)}</>}
          </span>
            {plan.status === 'running' && (
              <Button size="sm" variant="danger-outline" className="shrink-0" onClick={stop} disabled={blocked}>{busy === 'stop' ? 'Stopping…' : 'Stop the plan'}</Button>
            )}
          </div>
          )}

          {/* Task 5b (decision 6): a failed plan says why, in the reader's own
              words, with the two actions for a failure the user cannot fix
              from here (error-message-standards §2). No reason → no block:
              nothing is invented. */}
          {plan.status === 'failed' && plan.failure?.detail && (
            <ErrorState
              variant="inline"
              message={plan.failure.detail}
              onReportBug={() => report(plan.failure!.detail, false)}
              onDiagnose={() => report(plan.failure!.detail, true)}
            />
          )}

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
              tone="warn"
              surface="tinted"
              className="!py-2"
              action={!adding ? (
                <div className="flex items-center gap-2 shrink-0">
                  <Button size="sm" variant="danger-outline" onClick={stop} disabled={blocked}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</Button>
                  {/* Task 5b: the button that answers THIS pause. An unknown
                      outcome is resolved by Continue (Task 4: pressing it is
                      the explicit recovery); a used-up repeat can't be helped
                      by budget or Continue (the executor pauses again), so it
                      gets Stop alone; every other pause keeps Add budget. */}
                  {pause.kind === 'unknown-outcome' ? (
                    <Button size="sm" variant="primary" onClick={cont} disabled={blocked}>{busy === 'continue' ? 'Continuing…' : 'Continue'}</Button>
                  ) : pause.kind === 'iteration-cap' ? null : (
                    <Button size="sm" variant="primary" onClick={() => setAdding(true)} disabled={blocked}>Add budget</Button>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 shrink-0" data-testid="plan-add-budget">
                  <span className="text-xs text-fg-dim">Allow</span>
                  <TextInput size="sm" inputMode="numeric" value={Number(extra) ? Number(extra).toLocaleString() : extra} onChange={(e) => setExtra(e.target.value.replace(/[^0-9]/g, ''))} className="w-20" aria-label="Tokens to allow" />
                  <span className="text-xs text-fg-dim">tokens{plan.ceilingUsd != null && plan.ceilingTokens > 0 ? ` (${usd((Number(extra) || 0) * (plan.ceilingUsd / plan.ceilingTokens))})` : ''}</span>
                  <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={blocked}>Cancel</Button>
                  <Button size="sm" variant="primary" onClick={addBudget} disabled={blocked || !(Number(extra) > 0) || belowMinimum}>{busy === 'budget' || busy === 'continue' ? 'Continuing…' : 'Continue'}</Button>
                </div>
              )}
            >
              <PausedReason plan={plan} pause={pause} stepNumber={pausedIndex + 1} />
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

          {plan.status === 'interrupted' && (
            // Grey dot, not amber: an interrupted plan is waiting, not warning —
            // nothing went wrong and nothing is at risk.
            <StatusStrip
              tone="idle"
              surface="tinted"
              className="!py-2"
              action={(
                <div className="flex items-center gap-2 shrink-0">
                  <Button size="sm" variant="danger-outline" onClick={stop} disabled={blocked}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</Button>
                  <Button size="sm" variant="primary" onClick={cont} disabled={blocked}>{busy === 'continue' ? 'Continuing…' : 'Continue'}</Button>
                </div>
              )}
            >
              <span data-testid="plan-interrupted-note">
                The app closed mid-plan. {done === 0 ? 'Nothing had finished yet' : done === 1 ? 'Step 1 is saved' : `Steps 1–${done} are saved`}; Continue runs the rest.
              </span>
            </StatusStrip>
          )}

          {revised && (
            <div className="text-2xs text-fg-muted">Revised after your comment — the new plan is below.</div>
          )}

      {/* The proposal keeps its buttons on their own row: it has two forward
          actions and no status sentence to share a line with.
          Task 8 (review 6, R6-4; design guide G-29): the row sits on the
          RIGHT and the filled Approve is the rightmost button, with the light
          Comment to its left — a filled button is never left-aligned. */}
          {plan.status === 'proposed' && !commenting && (
            <div className="flex items-center justify-end gap-2 flex-wrap">
              <Button size="sm" variant="secondary" onClick={() => setCommenting(true)} disabled={blocked}>Comment</Button>
              <Button size="sm" variant="primary" onClick={approve} disabled={blocked}>{busy === 'approve' ? 'Approving…' : 'Approve'}</Button>
            </div>
          )}
          {plan.status === 'proposed' && commenting && (
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
        ? <ErrorState variant="inline" message={error} onReportBug={() => report(error, false)} onDiagnose={() => report(error, true)} onRetry={retry} />
        : <ErrorState variant="inline" message={error} onRetry={retry} />)}
      {/* "Plans aren't available here" is why the buttons are disabled, not a
          failure: a quiet note beside them (design guide §4.7 "Disabled"). */}
      {!error && hasControls && unsupported && <div className="text-2xs text-fg-muted">{unsupported}</div>}
      <BugReportPopup open={!!reportContext} onClose={() => setReportContext(null)} context={reportContext ?? undefined} />
    </div>
  );
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
  return <span data-testid="plan-paused-reason">Paused — {plan.paused?.reason}</span>;
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
      writing the plan · {elapsed}{plan.ceilingUsd == null ? ' · can take a few minutes on your computer' : ''}
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

const KIND_WORD: Record<PlanStepView['kind'], string> = {
  map: 'at the same time',
  verify: 'checks each result',
  combine: 'combines the results',
  repeat: 'repeats until done',
};

function StepRow({ step, index, plan, sessionId }: { step: PlanStepView; index: number; plan: PlanView; sessionId?: string }) {
  // A running step opens itself so its specialists are visible without a
  // click (Q-5: the card is the progress surface); anything else folds.
  // Task 5a: a specialist in this step waiting on the user opens the step
  // too — its buttons are useless behind a folded row (the same rule that
  // force-opens a Task card holding an ask).
  const asking = !!step.children?.some((c) => c.segments?.some((sg) => sg.type === 'tool' && sg.status === 'awaiting-approval' && !!sg.requestId));
  const [open, setOpen] = useState(step.status === 'running' || step.status === 'paused' || asking);
  useEffect(() => { if (step.status === 'running' || step.status === 'paused') setOpen(true); }, [step.status]);
  useEffect(() => { if (asking) setOpen(true); }, [asking]);
  const who = `${step.fanOut} ${step.specialist}${step.fanOut === 1 ? '' : 's'}`;
  const right =
    step.status === 'pending' || plan.status === 'proposed' ? `up to ${limitTokens(plan, step.budgetTokens * step.fanOut)}`
    : step.status === 'running' || step.status === 'paused' ? `${step.done ?? 0} of ${step.fanOut} ${step.specialist}s done · ${tokens(step.usedTokens ?? 0)}`
    : step.status === 'done' ? tokens(step.usedTokens ?? 0)
    : '';
  return (
    // Destin, round 2 (R-2): a step is a container like the cards above and
    // below it, so the nesting reads plan → step → specialist by shape rather
    // than by indentation; the specialists sit on the container's own padding.
    <li className="border border-edge-dim rounded-md overflow-hidden bg-inset/25" data-testid={`plan-step-${step.id}`} data-step-status={step.status}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="w-full flex items-center gap-2 text-left px-2 py-1 hover:bg-inset/50 transition-colors">
        <span className="shrink-0 inline-flex w-3.5 justify-center">{STEP_GLYPH[step.status]}</span>
        <span className="text-xs text-fg-muted tabular-nums shrink-0">{index + 1}.</span>
        <span className={`text-xs ${step.status === 'done' ? 'text-fg-dim' : 'text-fg-2'} truncate`}>{step.title}</span>
        <span className="text-2xs text-fg-dim truncate">{who} · {KIND_WORD[step.kind]}</span>
        <span className="ml-auto text-2xs text-fg-muted tabular-nums shrink-0">{right}</span>
        <ChevronIcon className="w-3 h-3 text-fg-muted shrink-0" expanded={open} />
      </button>
      {open && (
        <div className="px-1.5 pb-1.5 pt-1 space-y-1 border-t border-edge-dim">
          {step.children && step.children.length > 0 ? (
            step.children.map((c) => <PlanSpecialistCard key={c.childId} child={c} sessionId={sessionId} />)
          ) : (
            <div className="text-2xs text-fg-muted">
              Each {step.specialist} stops at its {limitTokens(plan, step.budgetTokens)} limit.
            </div>
          )}
        </div>
      )}
    </li>
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
    : notStarted ? <span className="inline-block w-3 h-3 rounded-full border border-edge" aria-label="not started" />
    : <StoppedIcon className="w-3 h-3 text-fg-muted" />;
  return (
    <div className="border border-edge rounded-md overflow-hidden bg-inset/60" data-testid="plan-child">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-left hover:bg-inset transition-colors">
        <span className="shrink-0 inline-flex w-3 justify-center">{glyph}</span>
        <span aria-hidden="true" className="w-px h-3 bg-edge shrink-0" />
        <span className="text-xs font-medium text-fg-2 shrink-0">{child.title}</span>
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
        <ChevronIcon className="w-3 h-3 text-fg-muted shrink-0" expanded={open} />
      </button>
      {open && (
        <div className="px-2 py-1.5 border-t border-edge-dim space-y-1">
          <AgentSections tool={tool} sessionId={sessionId}>
            {child.status === 'running' && sessionId && <SpecialistActions sessionId={sessionId} run={child} />}
          </AgentSections>
        </div>
      )}
    </div>
  );
}
