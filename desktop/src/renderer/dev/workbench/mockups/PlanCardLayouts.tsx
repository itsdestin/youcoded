// src/renderer/dev/workbench/mockups/PlanCardLayouts.tsx
//
// Three candidate ARRANGEMENTS of the proposed plan card, for the
// `plan-card-hierarchy` comparison in compare/registry.tsx.
//
// WHY they exist (decision 32, Destin 2026-09-18): "this whole thing is just
// not well organized or easy to navigate through visually. i want you to
// propose a new plan card style with better visual heirarchy that is easier to
// quickly glance/click through and understand. minimal copy, maximum
// transparency and comprehensibility". Decisions 30 and 31 both kept the flat
// step list and rewrote the sentences on it; three complaints in a row say the
// words were the wrong lever. These change the LAYOUT.
//
// The registry's rule holds here: every control is the REAL primitive (Button,
// Badge, ChevronIcon) and every colour is a real token. What is new code is the
// ARRANGEMENT and nothing else. The shipped card (components/plans/PlanCard.tsx)
// is NOT touched — these are proposals.
//
// WHY the data is the real fixture: every number and string below is copied
// verbatim from fixtures/bubbles/plan-proposed.jsonl, so all three panes show
// the SAME plan and the comparison is about layout, not content. Nothing here
// is invented — `of` is the only source for what feeds what, `fanOut` for the
// counts, `items` for the per-specialist slices.
//
// WHY there is no useNarrowViewport branch: in the app this card is ~460px wide
// inside a window that is usually far wider, so the phone breakpoint (640px
// viewport) does not describe it. A layout that needed the hook here would be
// one that breaks whenever the bubble is narrow but the window is not. All
// three are fluid instead — they hold from 390px to 460px with no branch.
//
// Dev-only, like the rest of dev/.
import React, { useRef, useState } from 'react';
import { Badge, Button, SegmentedProgress, SettingRow, type ProgressSegment } from '../../../components/ui';
import { ChevronIcon } from '../../../components/Icons';
import type { PlanStepView, PlanView } from '../../../../shared/types';

// ── the plan every candidate draws ───────────────────────────────────────────
// fixtures/bubbles/plan-proposed.jsonl, line 5, verbatim.
const PLAN: PlanView = {
  planId: 'plan-1',
  toolUseId: 'toolu_01Plan',
  title: 'Review the auth module before the release',
  status: 'proposed',
  steps: [
    {
      id: 's1', kind: 'map', title: 'Review the six files that changed in the auth module',
      specialist: 'reviewer', fanOut: 3, status: 'pending',
      summary: 'Three helpers read the changed sign-in files and write down anything that looks wrong.',
      items: ['Sign-in screen and password reset', 'Session tokens and two-factor codes', 'Account lockout and sign-out'],
    },
    {
      id: 's2', kind: 'verify', title: 'Check each review against the file it describes',
      specialist: 'reviewer', fanOut: 1, status: 'pending', of: 's1',
      summary: 'One helper re-reads those notes against the files, to catch anything mistaken.',
    },
    {
      id: 's3', kind: 'combine', title: 'Combine the findings into one ranked list',
      specialist: 'worker', fanOut: 1, status: 'pending', of: 's2',
      summary: 'One helper turns everything into a single list, worst problem first.',
    },
  ],
  // WHY estimate, not ceilingTokens/ceilingUsd (spending rework stage 1,
  // design §2/§4): there is no per-step token budget left to sum into a
  // worst-case ceiling — the proposed card reads a range estimate instead.
  estimate: { lowUsd: 0.06, highUsd: 0.12 },
  model: { label: 'Claude Sonnet 4.6' },
};

const STEPS = PLAN.steps;
const SPECIALISTS = STEPS.reduce((n, s) => n + s.fanOut, 0);

/** "3 reviewers" / "1 worker" — the count beside a step, from `fanOut`. */
function who(step: PlanStepView): string {
  return `${step.fanOut} ${step.specialist}${step.fanOut === 1 ? '' : 's'}`;
}
/** What a step hands on: one report per specialist (the shipped card's word). */
function reports(n: number): string { return n === 1 ? '1 report' : `${n} reports`; }
/** The 1-based row number of the step whose reports `step` consumes, or 0. */
function sourceIndex(step: PlanStepView): number {
  return step.of ? STEPS.findIndex((s) => s.id === step.of) + 1 : 0;
}

// WHY these read `estimate`, not ceilingTokens/ceilingUsd (spending rework
// stage 1, decision 34): the proposed card shows a range from past runs, a
// guide, never a limit.
const PLAN_ESTIMATE = PLAN.estimate as { lowUsd: number; highUsd: number };
const ESTIMATE_TEXT = `$${PLAN_ESTIMATE.lowUsd.toFixed(2)}–$${PLAN_ESTIMATE.highUsd.toFixed(2)}`;

/** The limit line, in as few words as it can be said honestly. The shipped line
 *  spells out "specialists run on Claude Sonnet 4.6"; the specialist count is
 *  already at the head of this line, so the model name alone says the same
 *  thing in three fewer words. */
const LIMIT_LINE = `${SPECIALISTS} specialists · usually ${ESTIMATE_TEXT} · ${PLAN.model.label}`;

/** B's version of the same line. Its heading already carries the specialist
 *  count and the price, so repeating them under the steps would be the one
 *  thing this round is trying to cut — the estimate and the model are what is
 *  left to say, and nothing is lost. */
const LIMIT_LINE_SHORT = `Usually ${ESTIMATE_TEXT} · ${PLAN.model.label}`;

/** The last thing the plan produces. The only label on any candidate that is
 *  not a count or a name — it says where the whole thing lands. */
const ANSWER_LABEL = 'your answer';

/**
 * The header the card really sits under, identical in all three.
 *
 * WHY it is here at all: in the app the plan block is the BODY of a tool card
 * whose header already draws "Plan: <title> · waiting for approval"
 * (PlanCard.tsx `planDisplay`/`planIcon`). The first build of these candidates
 * gave B its own title and left A and C without one, so B looked like the only
 * one with a heading when in truth all three inherit the same one — he would
 * have been picking a layout for a reason that is not real. Drawn plainly here
 * rather than by importing ToolCard, which would need a whole ToolCallState;
 * it is the same in every pane, so it is not what is being compared.
 */
function PlanHeader() {
  return (
    <div className="flex items-baseline gap-2 px-3 pt-2 pb-1 border-b border-edge-dim">
      <span className="text-xs text-fg-2 truncate">Plan: {PLAN.title}</span>
      <span className="text-2xs text-fg-muted shrink-0">waiting for approval</span>
    </div>
  );
}

/**
 * The card's bottom row, identical in all three so it is not what is being
 * compared: the limit on the left, Comment then Approve on the right (decision
 * 9/15 — the filled button rightmost, the light one on its left, both sharing
 * the limit's row). Real `Button`, both of them.
 */
function ApproveRow({ limit = LIMIT_LINE }: { limit?: string }) {
  return (
    <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap" data-testid="candidate-approve-row">
      <span className="text-xs text-fg-dim flex-1 min-w-0 basis-64">{limit}</span>
      <div className="flex items-center justify-end gap-2 shrink-0 ml-auto">
        <Button size="sm" variant="secondary">Comment</Button>
        <Button size="sm" variant="primary">Approve</Button>
      </div>
    </div>
  );
}

/** The empty circle a specialist that has not started wears. Same classes as
 *  PlanCard's NOT_STARTED_GLYPH, which is a module-local there — copied rather
 *  than re-styled so these rows draw the app's own mark. */
const NOT_STARTED = <span className="mt-0.5 block w-3 h-3 rounded-full border border-edge shrink-0" aria-label="not started" />;

// ── A · spine ────────────────────────────────────────────────────────────────

/** How many branch items hang off the rail before the rest are counted.
 *  renderer-lists.md: a list the card cannot bound is a list that can run off
 *  the screen — 8 items is the grammar's cap but records from other builds
 *  replay here too. */
const SPINE_ITEMS_MAX = 4;

/**
 * A · "Draw the structure". A vertical rail down the left made of real border
 * tokens (not an SVG); each step is a node on it; a fan-out step's specialists
 * hang off the rail as a short branch that is ALWAYS visible and converges back
 * into the rail before the next node. No flow sentence anywhere — the rail says
 * what `stepFlow()` used to spell out (Destin, decision 31: "it's not clear to
 * me how this breaks out into 7 reviewers").
 */
export function SpinePlanCard() {
  return (
    <div data-testid="plan-candidate-spine">
      <PlanHeader />
      <div className="px-3 pb-2.5 pt-1.5 space-y-2">
      <ol>
        {STEPS.map((step, i) => (
          <SpineNode key={step.id} step={step} index={i} last={i === STEPS.length - 1} />
        ))}
      </ol>
      <ApproveRow />
      </div>
    </div>
  );
}

function SpineNode({ step, index, last }: { step: PlanStepView; index: number; last: boolean }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const items = step.items ?? [];
  const shown = showAll ? items : items.slice(0, SPINE_ITEMS_MAX);
  // What leaves this step and goes down the rail: one report per specialist.
  // On the last step the rail instead ends at where the work lands.
  const passes = last ? ANSWER_LABEL : reports(step.fanOut);
  return (
    <li className="relative pl-7">
      {/* THE RAIL. One px of border token, drawn per node so the segments
          stack into one continuous line; the last node's stops at its closing
          label instead of running off the bottom of the card. */}
      <span aria-hidden="true" className={`absolute left-2.5 top-0 w-px bg-edge ${last ? 'bottom-4' : 'bottom-0'}`} />
      {/* The node itself: the step number in a circle ON the rail. bg-canvas so
          the rail passes behind it rather than through the digit. */}
      <span className="absolute left-0 top-1 w-5 h-5 rounded-full border border-edge bg-canvas flex items-center justify-center text-3xs text-fg-muted tabular-nums">
        {index + 1}
      </span>
      <button
        type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="w-full flex items-start gap-2 text-left py-1 rounded-md hover:bg-inset/50 transition-colors"
      >
        {/* The ONE prominent string per step. Everything else on the node is
            muted or a number, so the eye lands here first. */}
        <span className="text-xs text-fg flex-1 min-w-0 break-words">{step.summary}</span>
        <Badge className="mt-0.5">{who(step)}</Badge>
        <ChevronIcon className="w-3 h-3 text-fg-muted shrink-0 mt-1" expanded={open} />
      </button>
      {/* A click opens the specialist's brief and nothing else — the workers
          are already on the page, so the chevron has exactly one meaning here
          (fault 5: today every chevron hides a different kind of thing). */}
      {open && (
        <div className="pb-1 text-2xs text-fg-dim break-words" data-testid="spine-brief">{step.title}</div>
      )}
      {items.length > 0 && (
        <div className="relative pl-4 pb-1.5" data-testid="spine-branch">
          {/* The branch: it leaves the spine, runs down past the specialists,
              and curves back into it before the next node — the fan-out visibly
              splits and re-joins, which is the whole of what `stepFlow()` used
              to say in words. One box of border tokens with its left side
              missing (the spine is that side), 4.5 spacing units wide, which is
              exactly the gap between the spine (x=10) and the branch (x=28). */}
          <span aria-hidden="true" className="absolute left-0 top-0 bottom-2 -ml-4.5 w-4.5 border-r border-t border-b border-edge rounded-r-md" />
          <ul className="space-y-1">
            {shown.map((item, i) => (
              <li key={`${i}-${item}`} className="flex items-start gap-1.5">
                {NOT_STARTED}
                <span className="text-2xs text-fg-dim min-w-0 break-words">{item}</span>
              </li>
            ))}
          </ul>
          {items.length > SPINE_ITEMS_MAX && !showAll && (
            <Button size="sm" variant="ghost" className="mt-0.5" onClick={() => setShowAll(true)}>
              +{items.length - SPINE_ITEMS_MAX} more
            </Button>
          )}
        </div>
      )}
      {/* What travels down the rail to the next node — derived from this step's
          fan-out, never written. */}
      <div className="py-0.5 text-3xs text-fg-muted" data-testid="spine-passes">{passes}</div>
    </li>
  );
}

// ── B · ledger ───────────────────────────────────────────────────────────────

/**
 * B · "Hierarchy by type, inputs named". No drawing at all: the same facts made
 * scannable by weight and size, with the counts in a fixed right column so they
 * line up down the card, and every arrow pointing at what comes IN.
 */
export function LedgerPlanCard() {
  return (
    <div data-testid="plan-candidate-ledger">
      <PlanHeader />
      <div className="px-3 pb-2.5 pt-1.5 space-y-2">
      {/* B's entry point. It was the plan's title until the shared PlanHeader
          went in above and printed the same words one line higher — the goal is
          already stated by the card this block sits inside, so repeating it is
          the exact duplication this round is meant to cut. What B keeps is the
          part the header does NOT say: the shape of the whole plan in one muted
          line, read before any step is. */}
      <div className="text-2xs text-fg-muted">
        {STEPS.length} steps · {SPECIALISTS} specialists · up to about ${PLAN.ceilingUsd?.toFixed(2)}
      </div>
      <ol className="divide-y divide-edge-dim border-t border-edge-dim">
        {STEPS.map((step, i) => <LedgerRow key={step.id} step={step} index={i} last={i === STEPS.length - 1} />)}
      </ol>
      <ApproveRow limit={LIMIT_LINE_SHORT} />
      </div>
    </div>
  );
}

function LedgerRow({ step, index, last }: { step: PlanStepView; index: number; last: boolean }) {
  const [open, setOpen] = useState(false);
  const from = sourceIndex(step);
  // ONE line per step in one grammar, and it always names the INPUT: the item
  // labels for a fan-out, the step whose reports this one is handed otherwise.
  const inputs = step.items && step.items.length > 0
    ? step.items.join(' · ')
    : from > 0 ? `← step ${from}'s ${reports(STEPS[from - 1].fanOut)}` : '';
  return (
    <li className="py-1">
      <button
        type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="w-full flex items-start gap-2 text-left rounded-md hover:bg-inset/50 transition-colors"
      >
        {/* The number is a column of its own, at a size nothing else on the row
            uses — the row is findable without reading it. */}
        <span className="text-sm text-fg-muted tabular-nums w-4 shrink-0 text-right">{index + 1}</span>
        <span className="text-xs font-medium text-fg flex-1 min-w-0 break-words">{step.summary}</span>
        {/* A FIXED column, so the counts stack into a readable column rather
            than floating wherever the sentence above them ended. */}
        <span className="text-2xs text-fg-muted w-20 shrink-0 text-right tabular-nums">{who(step)}</span>
        <ChevronIcon className="w-3 h-3 text-fg-muted shrink-0 mt-0.5" expanded={open} />
      </button>
      {/* Open, a fan-out step draws its items as rows — so the joined line
          above would be the same labels twice. It stands down (the point of
          this round is less copy, not more of it). */}
      {inputs && !(open && (step.items?.length ?? 0) > 0) && (
        <div className="flex items-start gap-2 pl-6">
          <span className="text-2xs text-fg-muted flex-1 min-w-0 break-words" data-testid="ledger-inputs">{inputs}</span>
          {/* The one output anybody needs before approving: where it all ends. */}
          {last && <span className="text-2xs text-fg-muted shrink-0">→ {ANSWER_LABEL}</span>}
        </div>
      )}
      {/* A click opens the rows the fan-out becomes, plus the specialist's
          brief — the same rows the card draws once the plan is running. */}
      {open && (
        <div className="pl-6 pt-1 space-y-1" data-testid="ledger-open">
          {(step.items ?? []).map((item, i) => (
            <div key={`${i}-${item}`} className="flex items-start gap-1.5">
              {NOT_STARTED}
              <span className="text-2xs text-fg-dim min-w-0 break-words">{item}</span>
            </div>
          ))}
          <div className="text-2xs text-fg-dim break-words">{step.title}</div>
        </div>
      )}
    </li>
  );
}

// ── C · strip ────────────────────────────────────────────────────────────────

/**
 * C · "A glance line, then a quiet list". The whole plan's shape is one row of
 * nodes at the top — three dots, then one, then one — so it reads "three at
 * once, then one, then one" before a single word is read. The list under it is
 * deliberately bare: number, sentence, count, chevron, nothing else.
 */
export function StripPlanCard() {
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = useRef<Record<string, HTMLLIElement | null>>({});
  const toggle = (id: string) => {
    setOpenId((cur) => (cur === id ? null : id));
    // Clicking a node up in the strip must land you at the step it names —
    // otherwise the strip is decoration rather than navigation.
    rows.current[id]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  return (
    <div data-testid="plan-candidate-strip">
      <PlanHeader />
      <div className="px-3 pb-2.5 pt-1.5 space-y-2">
      {/* THE STRIP. Divs and tokens, no SVG: each step is a node whose SIZE is
          its fan-out (three dots for three specialists), joined by thin
          connectors, numbered underneath. */}
      <div className="flex items-start gap-1 py-1" data-testid="strip">
        {STEPS.map((step, i) => (
          <React.Fragment key={step.id}>
            {/* The connector meets the MIDDLE of the dot box, not the middle of
                the button: the button is taller than the dots (it carries the
                step number too), so centring on it hung the line off the bottom
                dot of the fan-out node. mt-4 = the button's py-1 plus half the
                fixed dot box. */}
            {i > 0 && <span aria-hidden="true" className="flex-1 h-px bg-edge-dim self-start mt-4" />}
            <button
              type="button" onClick={() => toggle(step.id)} aria-expanded={openId === step.id}
              aria-label={`Step ${i + 1}, ${who(step)}`}
              // The open node is marked by its own fill as well as by the
              // accent dots: a theme whose accent is close to the muted
              // foreground would otherwise mark it invisibly.
              className={`flex flex-col items-center gap-1 px-1.5 py-1 rounded-md transition-colors ${openId === step.id ? 'bg-inset' : 'hover:bg-inset/50'}`}
            >
              {/* A FIXED height whatever the fan-out, so every node's dots are
                  centred on the same line and the numbers share a baseline. */}
              <span className="h-6 flex flex-col items-center justify-center gap-0.5">
                {Array.from({ length: step.fanOut }, (_, d) => (
                  <span key={d} className={`w-1.5 h-1.5 rounded-full ${openId === step.id ? 'bg-accent' : 'bg-fg-muted'}`} />
                ))}
              </span>
              <span className={`text-3xs tabular-nums ${openId === step.id ? 'text-fg' : 'text-fg-muted'}`}>{i + 1}</span>
            </button>
          </React.Fragment>
        ))}
      </div>
      <ol className="divide-y divide-edge-dim border-t border-edge-dim">
        {STEPS.map((step, i) => (
          <StripRow
            key={step.id} step={step} index={i}
            open={openId === step.id}
            onToggle={() => toggle(step.id)}
            rowRef={(el) => { rows.current[step.id] = el; }}
          />
        ))}
      </ol>
      <ApproveRow />
      </div>
    </div>
  );
}

function StripRow({ step, index, open, onToggle, rowRef }: {
  step: PlanStepView; index: number; open: boolean; onToggle: () => void;
  rowRef: (el: HTMLLIElement | null) => void;
}) {
  return (
    <li ref={rowRef} className="py-1">
      <button
        type="button" onClick={onToggle} aria-expanded={open}
        className="w-full flex items-start gap-2 text-left rounded-md hover:bg-inset/50 transition-colors"
      >
        <span className="text-xs text-fg-muted tabular-nums shrink-0">{index + 1}.</span>
        <span className="text-xs text-fg flex-1 min-w-0 break-words">{step.summary}</span>
        <span className="text-2xs text-fg-muted shrink-0">{who(step)}</span>
        <ChevronIcon className="w-3 h-3 text-fg-muted shrink-0 mt-0.5" expanded={open} />
      </button>
      {/* Everything the quiet row leaves out is here, one click away: the rows
          the fan-out becomes, the brief, and this step's own limit. */}
      {open && (
        <div className="pl-6 pt-1 space-y-1" data-testid="strip-open">
          {(step.items ?? []).map((item, i) => (
            <div key={`${i}-${item}`} className="flex items-start gap-1.5">
              {NOT_STARTED}
              <span className="text-2xs text-fg-dim min-w-0 break-words">{item}</span>
            </div>
          ))}
          <div className="text-2xs text-fg-dim break-words">{step.title}</div>
          {/* WHY no per-step limit line any more (spending rework stage 1,
              decision 34): each specialist runs on its own default model
              with no per-step token budget to name here. */}
        </div>
      )}
    </li>
  );
}

// ═══ ROUND 2 ═════════════════════════════════════════════════════════════════
//
// Destin on round 1: "doesnt match existing ui at all. lots of bare text and
// divider lines, which we don't use anywhere else in the app. we need to make
// this look/feel like native app ui. try again."
//
// He is right and the design guide says so in specifics. Round 1 hand-rolled a
// <button> row per step (G-1: that row IS `SettingRow`), put a leading glyph and
// a bare chevron on it (G-29, and Destin 2026-09-05: "I HATE the bare dropdowns
// with a chevron"), separated steps with `divide-y` hairlines — an idiom that
// appears in exactly ONE renderer file, because this app separates things by
// CONTAINMENT — and printed information at `text-3xs` (G-5's floor is
// `text-2xs`).
//
// What round 1 got wrong was throwing out the SHIPPED card's materials along
// with its hierarchy. Those materials were already Destin's own round-2 call:
// nested bordered containers, so the nesting reads plan → step → specialist by
// SHAPE (PlanCard.tsx `StepRow`). Round 2 keeps them and changes only the
// arrangement and the amount of copy.
//
// So every row below is the real `SettingRow`: the app's universal row, which
// brings the right-hand chevron that turns while open, the hover/press/focus
// ladder (§2.4) and the two approved densities with it. The counts are the real
// `Badge`. The bar in C is a real primitive (`ui/SegmentedProgress`), not a
// class string, because no primitive drew one — G-1's own answer to "the app
// has nothing for this".

/** A step's container, verbatim from the SHIPPED card's `StepRow` <li>: one
 *  step down the depth ladder from the card it sits in, `md` radius (G-3: a
 *  list row), `edge-dim` because it is an inset container (§2.4). Copied
 *  rather than imported because it is a module-local there — and copied
 *  EXACTLY, so a winner pastes back into that file unchanged. */
const STEP_CARD = 'border border-edge-dim rounded-md overflow-hidden bg-inset/25';

/** A helper's container, verbatim from the shipped `PlanItemRow`: the same card
 *  one step deeper and one shade brighter, which is how the app already draws a
 *  specialist inside a step. These are the exact cards that light up when the
 *  plan runs — approving is a preview of watching it run (decision 31). */
const HELPER_CARD = 'border border-edge rounded-md overflow-hidden bg-inset/60';

/** The shipped card's `NOT_STARTED_GLYPH`, without round 1's `mt-0.5` nudge:
 *  `SettingRow`'s icon slot centres its own contents. */
const NOT_STARTED_DOT = <span className="inline-block w-3 h-3 rounded-full border border-edge" aria-label="not started" />;

/** renderer-lists.md: nothing unbounded is drawn. The shipped card's cap, so
 *  the two never disagree about when a fan-out stops listing and starts
 *  counting. */
const HELPERS_MAX = 8;

/**
 * The one line a step says about itself, in one grammar for every step: what it
 * is handed, what it makes, and who takes that on — "← step 1 · 1 report →
 * step 3". It lives in the row's DESCRIPTION slot, under the title, which is
 * where `SettingRow` puts a row's second line and the only place it may go.
 *
 * Every part is derived: `of` names the earlier step whose reports the executor
 * literally feeds in (decision 31), `fanOut` is one report per specialist, and
 * the step nobody consumes ends at the answer. Nothing is invented and nothing
 * is read out of the model's prose.
 */
function flow(step: PlanStepView): string {
  const from = sourceIndex(step);
  const toIndex = STEPS.findIndex((s) => s.of === step.id);
  const makes = `${reports(step.fanOut)} → ${toIndex >= 0 ? `step ${toIndex + 1}` : ANSWER_LABEL}`;
  return from > 0 ? `← step ${from} · ${makes}` : makes;
}

/**
 * The helpers a fan-out step hands its work to, as nested cards — the fan-out
 * drawn in the app's own material instead of on a rail. Each is the specialist's
 * own card in its not-started state, numbered (decision 31: one row per
 * specialist, each showing its own item).
 */
function HelperCards({ step }: { step: PlanStepView }) {
  const items = step.items ?? [];
  if (items.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="r2-helpers">
      {items.slice(0, HELPERS_MAX).map((item, i) => (
        <div key={`${i}-${item}`} className={HELPER_CARD}>
          <SettingRow
            variant="item"
            icon={
              <span className="flex items-center gap-1.5">
                {NOT_STARTED_DOT}
                <span className="text-2xs text-fg-muted tabular-nums">{i + 1}.</span>
              </span>
            }
            title={item}
          />
        </div>
      ))}
      {items.length > HELPERS_MAX && (
        <div className="text-2xs text-fg-muted">…and {items.length - HELPERS_MAX} more.</div>
      )}
    </div>
  );
}

/** The step's brief — the specialist's own headline, which the row does not
 *  show. Data, not layout copy: it is the plan's `title` field verbatim. */
function Brief({ step }: { step: PlanStepView }) {
  return <div className="text-2xs text-fg-dim break-words" data-testid="r2-brief">{step.title}</div>;
}

// ── A · nested — the structure IS the containment ────────────────────────────

/**
 * A · every step is a card, and a fan-out step CONTAINS its helpers, visible and
 * unfolded. Three helpers is three cards inside the step's card: that is the
 * fan-out, drawn in the material the app already nests with, so the shape is
 * there before anything is clicked — which is exactly when he is deciding.
 * The chevron then has one meaning and one only: the brief.
 */
export function NestedPlanCard() {
  return (
    <div data-testid="plan-candidate-nested">
      <PlanHeader />
      <div className="px-3 pb-2.5 pt-1.5 space-y-2">
        <ol className="space-y-1.5">
          {STEPS.map((step) => <NestedStep key={step.id} step={step} />)}
        </ol>
        <ApproveRow />
      </div>
    </div>
  );
}

function NestedStep({ step }: { step: PlanStepView }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={STEP_CARD} data-testid="nested-step">
      <SettingRow
        variant="item"
        title={step.summary}
        description={flow(step)}
        accessory={<Badge>{who(step)}</Badge>}
        onClick={() => setOpen((v) => !v)}
        expanded={open}
      />
      {/* The helpers sit on the step card's own padding — the container is the
          only thing saying they belong to this step, which is the point. */}
      {(step.items?.length ?? 0) > 0 && (
        <div className="px-1.5 pb-1.5">
          <HelperCards step={step} />
        </div>
      )}
      {open && (
        <div className="px-3 pb-2">
          <Brief step={step} />
        </div>
      )}
    </li>
  );
}

// ── B · rows — the app's universal row, and nothing else ─────────────────────

/**
 * B · the conservative one: it invents nothing at all. Every step is the app's
 * own row — title, description, count, chevron — and the card carries nothing
 * else but the limit line and the two buttons. Open, the row reveals the same
 * nested helper cards A shows always, plus the brief.
 */
export function RowsPlanCard() {
  return (
    <div data-testid="plan-candidate-rows">
      <PlanHeader />
      <div className="px-3 pb-2.5 pt-1.5 space-y-2">
        <ol className="space-y-1">
          {STEPS.map((step) => <RowStep key={step.id} step={step} />)}
        </ol>
        <ApproveRow />
      </div>
    </div>
  );
}

function RowStep({ step }: { step: PlanStepView }) {
  const [open, setOpen] = useState(false);
  return (
    <li data-testid="rows-step">
      <SettingRow
        variant="item"
        title={step.summary}
        description={flow(step)}
        accessory={<Badge>{who(step)}</Badge>}
        onClick={() => setOpen((v) => !v)}
        expanded={open}
      />
      {/* Indented under the row it belongs to, in the same cards A uses. */}
      {open && (
        <div className="mt-1 pl-3 space-y-1" data-testid="rows-open">
          <HelperCards step={step} />
          <Brief step={step} />
        </div>
      )}
    </li>
  );
}

// ── C · bar — one glance line that becomes the progress bar ──────────────────

/** The plan's shape as parts: one segment per step, each as wide as its
 *  fan-out, so "three at once, then one, then one" is one glance. Before
 *  approval every segment is an empty outline — nothing has happened yet, and
 *  the accent paints state, not decoration (G-8). The SAME object fills in as
 *  steps finish once it runs. */
const PLAN_SHAPE: ProgressSegment[] = STEPS.map((step, i) => ({
  id: step.id,
  weight: step.fanOut,
  label: `Step ${i + 1} · ${who(step)}`,
}));

/** The bar's accessible name: a shape is a picture, so it says in words what it
 *  shows, and how much of it is done. */
const SHAPE_LABEL = `Plan shape — ${STEPS.map((s) => who(s)).join(', then ')}. None finished yet.`;

export function BarPlanCard() {
  return (
    <div data-testid="plan-candidate-bar">
      <PlanHeader />
      <div className="px-3 pb-2.5 pt-1.5 space-y-2">
        <SegmentedProgress segments={PLAN_SHAPE} aria-label={SHAPE_LABEL} className="mt-1 mb-0.5" />
        <ol className="space-y-1">
          {STEPS.map((step) => <RowStep key={step.id} step={step} />)}
        </ol>
        <ApproveRow />
      </div>
    </div>
  );
}
