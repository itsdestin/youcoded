// @vitest-environment jsdom
/**
 * Specialists plans, Task 8 — the review-deck-6 changes (controller decisions
 * 8, 9 and 11):
 *  A. an approximate limit shows a tilde on every limit number, with no extra
 *     sentence (R6-1);
 *  B. Approve is the rightmost button and Comment sits to its left; every
 *     filled + light pair on the card puts the light one on the left and the
 *     row on the right (R6-4, design guide G-29);
 *  D. the Specialists chip also lists a plan's WORKING specialists, grouped
 *     under a collapsible one-line plan row (Q6-2).
 * (C, the session dot for specialist asks, is tests/specialist-ask-attention.test.tsx.)
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React, { useEffect } from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import SpecialistsChip from '../src/renderer/components/SpecialistsChip';
import { ChatProvider, useChatDispatch, useChatState } from '../src/renderer/state/chat-context';
import type { PlanView, PlanChildView } from '../src/shared/types';
import type { ChatAction } from '../src/renderer/state/chat-types';
import { resetPlanSupportForTests } from '../src/renderer/components/plans/plan-bridge';
import { planDisplay } from '../src/renderer/components/plans/PlanCard';

const S = 's1';
const CARD = 'call-plan';

function child(over: Partial<PlanChildView> = {}): PlanChildView {
  return {
    childId: 'kid-a', parentToolCallId: CARD, agentType: 'reviewer', title: 'Wren the Reviewer',
    background: false, status: 'running', startedAt: 1,
    ...over,
  };
}

function plan(over: Partial<PlanView> = {}): PlanView {
  return {
    planId: 'plan-1', toolUseId: CARD, title: 'Review two files', status: 'proposed',
    steps: [
      { id: 's1', kind: 'map', title: 'Review', specialist: 'reviewer', fanOut: 2, status: 'pending' },
      { id: 's2', kind: 'combine', title: 'Combine', specialist: 'worker', fanOut: 1, status: 'pending' },
    ],
    model: { label: 'GPT-5.1 (ChatGPT)' }, seq: 1,
    ...over,
  };
}

const NO_ACTIONS: ChatAction[] = [];

function Card({ initial, extra = NO_ACTIONS, withCard = true }: { initial: PlanView; extra?: ChatAction[]; withCard?: boolean }) {
  const dispatch = useChatDispatch();
  useEffect(() => {
    dispatch({ type: 'SESSION_INIT', sessionId: S });
    dispatch({ type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'u', toolUseId: CARD, toolName: 'propose_plan', toolInput: {} });
    dispatch({ type: 'PLAN_CHANGED', sessionId: S, plan: initial });
    for (const a of extra) dispatch(a);
  }, [dispatch, initial, extra]);
  const tool = useChatState(S).toolCalls.get(CARD);
  if (!tool) return null;
  return <>{withCard && <ToolCard tool={tool} sessionId={S} />}<SpecialistsChip sessionId={S} /></>;
}

const block = () => screen.getByTestId('plan-block');
// The plan row is the app's SettingRow (its button carries aria-expanded).
const planToggle = () => within(screen.getByTestId('plan-group-toggle')).getAllByRole('button')[0];
const buttons = () => within(block()).queryAllByRole('button').map((b) => (b.textContent ?? '').trim()).filter(Boolean);

function bridge() {
  (window as any).claude = {
    plans: {
      approve: vi.fn(), comment: vi.fn(), setLimit: vi.fn(), setStepModel: vi.fn(), resume: vi.fn(), stop: vi.fn(),
      getAutoApprove: vi.fn().mockResolvedValue({ ok: true, underUsd: 0 }),
      setAutoApprove: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

beforeEach(() => { resetPlanSupportForTests(); bridge(); });
afterEach(() => { cleanup(); delete (window as any).claude; });

const running = (over: Partial<PlanView> = {}) => plan({
  status: 'running', usedTokens: 1000,
  steps: [
    { ...plan().steps[0], status: 'running', done: 1, children: [
      child({ childId: 'kid-a', title: 'Wren the Reviewer' }),
      child({ childId: 'kid-b', title: 'Idris the Reviewer' }),
      child({ childId: 'kid-c', title: 'Mara the Reviewer', status: 'completed', endedAt: 61_001, report: { text: 'done', status: 'completed', timestamp: 2 } }),
    ] },
    plan().steps[1],
  ],
  ...over,
});

// ---------------------------------------------------------------------------

// Decision 34 retires the worst-case ceiling this block used to pin (and the
// tilde that marked it as approximate — R6-1/R7-1): a proposed card now shows
// an ESTIMATE (a range, or a token count + note, inherently approximate by
// shape, so nothing needs marking); a running card shows the live SPEND,
// which is a real count and never wore a tilde even under the old wording.
describe('A. decision 34: the estimate/spend lines replace the ceiling, tilde and all', () => {
  it('proposed, unpriced: "About N tokens · note", never the retired ceiling sentence', () => {
    render(<ChatProvider><Card initial={plan({ estimate: { tokens: 42000, unpricedNote: 'runs on ChatGPT, included in your plan' } })} /></ChatProvider>);
    expect(screen.getByTestId('plan-ceiling')).toHaveTextContent('3 specialists · About 42,000 tokens · runs on ChatGPT, included in your plan');
    expect(block()).not.toHaveTextContent('specialists run on');
    expect(block()).not.toHaveTextContent('which has no published price');
  });

  it('proposed, priced: a plain dollar range, no tilde needed', () => {
    render(<ChatProvider><Card initial={plan({ estimate: { lowUsd: 0.05, highUsd: 0.12 } })} /></ChatProvider>);
    expect(screen.getByTestId('plan-ceiling')).toHaveTextContent('Usually $0.05–$0.12');
  });

  it('each step shows no per-step figure at all, ever — decision 34 removed it entirely', () => {
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    for (const id of ['plan-step-s1', 'plan-step-s2']) {
      fireEvent.click(within(screen.getByTestId(id)).getAllByRole('button')[0]);
      expect(screen.getByTestId(id)).not.toHaveTextContent(/token/);
    }
  });

  it('while spending: no limit shown unless the user set one in Plan settings', () => {
    render(<ChatProvider><Card initial={running()} /></ChatProvider>);
    // This plan has no `estimate` (an older-shape record): tokens, no "of" clause.
    expect(screen.getByTestId('plan-ceiling')).toHaveTextContent('About 1,000 tokens used');
    expect(screen.getByTestId('plan-ceiling')).not.toHaveTextContent(' of ');
  });

  it('a plan with a limit set shows "Spent $X of $Y"', () => {
    render(<ChatProvider><Card initial={running({ estimate: { lowUsd: 1, highUsd: 3 }, usedUsd: 0.5, spendLimit: { usd: 5 } })} /></ChatProvider>);
    expect(screen.getByTestId('plan-ceiling')).toHaveTextContent('Spent $0.50 of $5');
  });
});

// ---------------------------------------------------------------------------

/** Final review F27 (R22): a filled button is a solid fill (accent or
 *  destructive); a light one is an outline or ghost. */
const isFilled = (b: HTMLElement) => /(^|\s)bg-(accent|destructive)(\s|$)/.test(b.className);
// --- R22 "wherever": the sweep -------------------------------------------
// WHY a sweep rather than a list of rows: the row says "WHEREVER a filled and
// a light button sit together". A named list only proves the rows someone
// remembered, so a NEW row (an error block's Report bug · Diagnose, a pause
// that gained a button) would ship unchecked. This walks the rendered DOM of
// every card state, finds each innermost element holding two or more buttons,
// and checks the real fill class of each — then asserts the exact set of mixed
// rows it found, so a row that stops rendering cannot quietly shrink the sweep.

/** Every innermost element holding two or more buttons: the card's real button
 *  rows, whatever wrappers sit above them. */
function buttonRows(root: HTMLElement): HTMLElement[] {
  const holders = Array.from(root.querySelectorAll<HTMLElement>('*'))
    .filter((el) => el.querySelectorAll('button').length >= 2);
  return holders.filter((el) => !holders.some((other) => other !== el && el.contains(other)));
}
/** Right-aligned the way G-28 allows: the row (or the slot holding it) pushes
 *  its content right, or a flex-1 element sits to its left and does. Checked up
 *  to the card itself, because StatusStrip right-aligns its action slot rather
 *  than the button row inside it. */
const classesOf = (el: Element) => el.getAttribute('class') ?? '';
function pushedRight(row: HTMLElement, firstBtn: HTMLElement): boolean {
  // An inline error row: the message itself is the flex-1 spacer that puts the
  // buttons at the right-hand end.
  for (let sib = firstBtn.previousElementSibling; sib; sib = sib.previousElementSibling) {
    if (/(^|\s)flex-1(\s|$)/.test(classesOf(sib))) return true;
  }
  for (let el: HTMLElement | null = row; el && el.dataset.testid !== 'plan-block'; el = el.parentElement) {
    if (/(^|\s)(justify-end|ml-auto)(\s|$)/.test(classesOf(el))) return true;
    for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (/(^|\s)flex-1(\s|$)/.test(classesOf(sib))) return true;
    }
  }
  return false;
}
/** Check every mixed row in what is on screen; return their labels. */
/** Decision 37: a trailing dismiss `CloseButton` — "the same small
 *  unobtrusive close every dismissable box in the app uses" — is not a
 *  member of the row's primary filled/light action pair (Stop/Continue,
 *  Cancel/Send, …); it is the box's own escape hatch, always last, whatever
 *  the action button's fill. Recognized by its icon-button shape: no visible
 *  text and a close/cancel/dismiss-flavoured `aria-label`. */
function isTrailingDismiss(b: HTMLElement): boolean {
  return !(b.textContent ?? '').trim() && /close|cancel|stop setting|dismiss/i.test(b.getAttribute('aria-label') ?? '');
}

function sweepMixedRows(where: string): string[] {
  const found: string[] = [];
  for (const row of buttonRows(document.body)) {
    const btns = within(row).queryAllByRole('button').filter((b) => !b.hasAttribute('aria-expanded') && !isTrailingDismiss(b));
    if (btns.length < 2) continue;
    const kinds = btns.map((b) => (isFilled(b) ? 'filled' : 'light'));
    // Decision 35: the Plan settings gear is an icon-only ghost button
    // (aria-label, no visible text) sharing several of these rows now — it
    // still has to obey the light-before-filled/right-alignment rule (kept in
    // `kinds`/`pushedRight` above), but an unlabelled button adds nothing to
    // read, so it is left out of the row's LABEL.
    const label = btns.filter((b) => (b.textContent ?? '').trim()).map((b) => (b.textContent ?? '').trim()).join(' | ');
    if (!kinds.includes('filled') || !kinds.includes('light')) continue;   // not a mixed row
    expect(kinds.join(' '), `${where} — ${label}: a filled button is left of a light one`).toMatch(/^(light )*(filled ?)*$/);
    expect(pushedRight(row, btns[0]), `${where} — ${label}: the row is not on the right`).toBe(true);
    found.push(label);
  }
  return found;
}

describe('B. filled buttons sit on the right, the light one to their left', () => {
  // Final review F27 (R22, "wherever"): every row of the plan card where a
  // filled and a light button sit together, checked by their real fill.
  it('every button row on the card: light first, filled rightmost', () => {
    // T7 (design §1/§2, decision 34): `budget`/`add_budget` are retired — the
    // generic strip's fixture is now `specialist-error`; the ONE remaining
    // "ask for a number, then Continue" box belongs to a `spend-limit` pause
    // instead (its own dedicated row, never the generic strip — decision 37 R-4).
    const pausedPlan = plan({
      status: 'paused', steps: [{ ...plan().steps[0], status: 'paused' }, plan().steps[1]],
      paused: { stepId: 's1', reason: 'a specialist ran into an error.', kind: 'specialist-error', actions: ['continue', 'stop'] },
    });
    const spendLimitPlan = plan({
      status: 'paused', steps: [{ ...plan().steps[0], status: 'paused' }, plan().steps[1]],
      estimate: { lowUsd: 0.4, highUsd: 2 },
      paused: { stepId: 's1', reason: 'Reached your $5 limit.', kind: 'spend-limit', limit: { usd: 5 } },
    });
    const pausedWith = (over: Partial<NonNullable<PlanView['paused']>>) =>
      plan({ ...pausedPlan, paused: { ...pausedPlan.paused!, ...over } });
    const seen: string[] = [];
    /** Render one state, run the extra clicks it needs, sweep it, unmount. */
    const state = (label: string, initial: PlanView, open?: () => void) => {
      const { unmount } = render(<ChatProvider><Card initial={initial} /></ChatProvider>);
      open?.();
      seen.push(...sweepMixedRows(label));
      unmount();
    };
    const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

    state('a proposal', plan());
    // The two named buttons of R6-4 by their real fill, not only their order.
    const { unmount } = render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    expect(isFilled(screen.getByRole('button', { name: 'Approve' }))).toBe(true);
    expect(isFilled(screen.getByRole('button', { name: 'Comment' }))).toBe(false);
    unmount();
    state('the comment box', plan(), () => press('Comment'));
    state('a specialist-error pause', pausedPlan);
    state('the Ask box', pausedPlan, () => press('Ask the assistant'));
    state('a recommended Stop', pausedWith({ handoff: { state: 'answered', recommendation: { action: 'stop', message: 'Stop here.' } } }));
    state('a recommended Continue', pausedWith({ actions: ['continue', 'stop'], handoff: { state: 'answered', recommendation: { action: 'continue', message: 'Carry on.' } } }));
    // Decision 24: a pause with the system's own text behind it adds Report bug.
    state('a pause with Report bug', pausedWith({ report: 'EIO writing the journal', actions: ['continue', 'stop'] }));
    state('a spend-limit pause', spendLimitPlan);
    state('the new-limit box', spendLimitPlan, () => press('Continue'));
    state('an interrupted plan', plan({ status: 'interrupted' }));
    state('a failed plan', plan({ status: 'failed' }));
    state('a running plan', running());

    // The sweep found every row it should have: a row that stops rendering
    // (or a state that stops reaching its buttons) fails here rather than
    // silently checking less.
    expect(new Set(seen)).toEqual(new Set([
      'Comment | Approve',
      'Cancel | Send',
      'Ask the assistant | Stop',
      'Ask the assistant | Stop | Continue',
      'Report bug | Ask the assistant | Stop | Continue',
      'Stop | Continue',
      'Report bug | Diagnose with the assistant',
    ]));
  });

  it('a proposal reads Comment, then Approve, in a right-aligned row', () => {
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    expect(buttons().slice(-2)).toEqual(['Comment', 'Approve']);
    const row = screen.getByRole('button', { name: 'Approve' }).parentElement!;
    expect(row).toHaveClass('justify-end');
  });

  it('the comment box reads Cancel, then Send, in a right-aligned row', () => {
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(buttons().slice(-2)).toEqual(['Cancel', 'Send']);
    expect(screen.getByRole('button', { name: 'Send' }).parentElement!).toHaveClass('justify-end');
  });

  it('paused and interrupted already follow the rule: Stop, then Continue', () => {
    const { unmount } = render(<ChatProvider><Card initial={plan({ status: 'interrupted' })} /></ChatProvider>);
    expect(buttons().slice(-2)).toEqual(['Stop', 'Continue']);
    unmount();
    render(<ChatProvider><Card initial={plan({
      status: 'paused', steps: [{ ...plan().steps[0], status: 'paused' }, plan().steps[1]],
      estimate: { lowUsd: 0.4, highUsd: 2 },
      paused: { stepId: 's1', reason: 'Reached your $5 limit.', kind: 'spend-limit', limit: { usd: 5 } },
    })} /></ChatProvider>);
    expect(buttons().slice(-2)).toEqual(['Stop', 'Continue']);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(buttons()).toContain('Continue');
  });
});

// ---------------------------------------------------------------------------

describe('D. the Specialists chip lists a plan\'s working specialists, grouped under the plan', () => {
  const ask: ChatAction = {
    type: 'PERMISSION_REQUEST', sessionId: S, toolName: 'Bash', input: { command: 'npm test' }, requestId: 'req-plan-1',
    specialist: { childId: 'kid-a', agentType: 'reviewer', title: 'Wren the Reviewer', parentToolCallId: CARD, plan: { planId: 'plan-1', stepId: 's1', attemptId: 'att-a' } },
  };
  const ASKS = [ask];

  it('a running plan counts its working specialists on the chip', () => {
    render(<ChatProvider><Card initial={running()} withCard={false} /></ChatProvider>);
    // Two working (the finished one is not counted).
    expect(screen.getByTestId('specialists-chip')).toHaveTextContent('2 specialists');
  });

  it('the popup shows one folded plan row; opening it shows the working specialists only', () => {
    render(<ChatProvider><Card initial={running()} withCard={false} /></ChatProvider>);
    fireEvent.click(screen.getByTestId('specialists-chip'));
    const toggle = planToggle();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('Review two files');
    // Review fix: the row carries the card header's own status phrase, so the
    // two can never disagree ("step 1 of 2", not a finished count).
    expect(toggle).toHaveTextContent('step 1 of 2');
    expect(toggle).toHaveTextContent(planDisplay({}, running()).detail);
    expect(toggle).not.toHaveTextContent('0 of 2');
    expect(toggle).not.toHaveTextContent('needs you');
    expect(screen.queryByTestId('helper-card-kid-a')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const group = screen.getByTestId('plan-group-plan-1');
    expect(within(group).getByTestId('helper-card-kid-a')).toBeInTheDocument();
    expect(within(group).getByTestId('helper-card-kid-b')).toBeInTheDocument();
    expect(screen.queryByTestId('helper-card-kid-c')).toBeNull();
    // Plan specialists are not repeated in the ordinary sections.
    // (Task 10, R7-5: the plan card itself now sits under "Working", so the
    // check is that each specialist card appears once, inside the plan.)
    expect(screen.getAllByTestId('helper-card-kid-a')).toHaveLength(1);
    expect(screen.getAllByTestId(/^helper-card-/).every((c) => group.contains(c))).toBe(true);
  });

  it('a plan with an asking specialist starts open, says "1 needs you", and lists its working sibling too', () => {
    render(<ChatProvider><Card initial={running()} extra={ASKS} withCard={false} /></ChatProvider>);
    const chip = screen.getByTestId('specialists-chip');
    expect(chip).toHaveTextContent('1 needs you');
    fireEvent.click(chip);
    const toggle = planToggle();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('1 needs you');
    const group = screen.getByTestId('plan-group-plan-1');
    expect(within(within(group).getByTestId('helper-card-kid-a')).getByTestId('helper-card-ask')).toHaveTextContent('Wren wants to:');
    expect(within(group).getByTestId('helper-card-kid-b')).toBeInTheDocument();
    // The asker comes first.
    const cards = within(group).getAllByTestId(/^helper-card-kid-/);
    expect(cards[0]).toHaveAttribute('data-testid', 'helper-card-kid-a');
  });

  it('the asker is listed first even when it is not the first specialist of the step', () => {
    const askB: ChatAction = { ...ask, requestId: 'req-plan-b', specialist: { ...(ask as any).specialist, childId: 'kid-b', title: 'Idris the Reviewer' } } as ChatAction;
    render(<ChatProvider><Card initial={running()} extra={[askB]} withCard={false} /></ChatProvider>);
    fireEvent.click(screen.getByTestId('specialists-chip'));
    const cards = within(screen.getByTestId('plan-group-plan-1')).getAllByTestId(/^helper-card-kid-/);
    expect(cards.map((c) => c.getAttribute('data-testid'))).toEqual(['helper-card-kid-b', 'helper-card-kid-a']);
  });

  it('a paused plan\'s row says what the card header says', () => {
    const pausedPlan = running({ status: 'paused', paused: { stepId: 's1', reason: 'Reached your $5 limit.', kind: 'spend-limit', limit: { usd: 5 } } });
    render(<ChatProvider><Card initial={pausedPlan} extra={ASKS} withCard={false} /></ChatProvider>);
    fireEvent.click(screen.getByTestId('specialists-chip'));
    expect(planToggle()).toHaveTextContent('paused — reached its limit');
    expect(planToggle()).toHaveTextContent(planDisplay({}, pausedPlan).detail);
  });

  it('several plans at once: the one with an asking specialist first, then in conversation order', () => {
    const mk = (n: number, title: string): PlanView => ({
      ...running(), planId: `plan-${n}`, toolUseId: `card-${n}`, title,
      steps: running().steps.map((st) => ({ ...st, children: st.children?.map((c) => ({ ...c, childId: `${c.childId}-${n}`, parentToolCallId: `card-${n}` })) })),
    });
    const plans = [mk(1, 'First plan'), mk(2, 'Second plan'), mk(3, 'Third plan')];
    const askThird: ChatAction = {
      type: 'PERMISSION_REQUEST', sessionId: S, toolName: 'Bash', input: { command: 'npm test' }, requestId: 'req-3',
      specialist: { childId: 'kid-b-3', agentType: 'reviewer', title: 'Idris the Reviewer', parentToolCallId: 'card-3', plan: { planId: 'plan-3', stepId: 's1', attemptId: 'a3' } },
    };
    function Many() {
      const dispatch = useChatDispatch();
      useEffect(() => {
        dispatch({ type: 'SESSION_INIT', sessionId: S });
        plans.forEach((p, i) => {
          dispatch({ type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: `u${i}`, toolUseId: p.toolUseId, toolName: 'propose_plan', toolInput: {} });
          dispatch({ type: 'PLAN_CHANGED', sessionId: S, plan: p });
        });
        dispatch(askThird);
      }, [dispatch]);
      return <SpecialistsChip sessionId={S} />;
    }
    render(<ChatProvider><Many /></ChatProvider>);
    const chip = screen.getByTestId('specialists-chip');
    expect(chip).toHaveTextContent('1 needs you');
    fireEvent.click(chip);
    const rows = screen.getAllByTestId(/^plan-group-plan-/).map((g) => g.getAttribute('data-testid'));
    expect(rows).toEqual(['plan-group-plan-3', 'plan-group-plan-1', 'plan-group-plan-2']);
    // Only the asking plan opens itself.
    const toggles = screen.getAllByTestId('plan-group-toggle').map((t) => within(t).getAllByRole('button')[0].getAttribute('aria-expanded'));
    expect(toggles).toEqual(['true', 'false', 'false']);
    // Each plan's specialists stay under their own plan.
    expect(within(screen.getByTestId('plan-group-plan-3')).getByTestId('helper-card-kid-b-3')).toBeInTheDocument();
    expect(within(screen.getByTestId('plan-group-plan-3')).queryByTestId('helper-card-kid-b-1')).toBeNull();
  });

  it('finished, stopped and failed plans are not listed (and alone draw no chip)', () => {
    for (const status of ['completed', 'stopped', 'failed'] as const) {
      const { unmount } = render(<ChatProvider><Card initial={running({ status })} withCard={false} /></ChatProvider>);
      expect(screen.queryByTestId('specialists-chip')).toBeNull();
      unmount();
    }
  });

  it('an ask still open on a plan that has ended stays listed, so it can still be answered', () => {
    render(<ChatProvider><Card initial={running({ status: 'stopped' })} extra={ASKS} withCard={false} /></ChatProvider>);
    expect(screen.getByTestId('specialists-chip')).toHaveTextContent('1 needs you');
    fireEvent.click(screen.getByTestId('specialists-chip'));
    const group = screen.getByTestId('plan-group-plan-1');
    expect(within(group).getByTestId('helper-card-kid-a')).toBeInTheDocument();
    // Only the asker: nothing else of an ended plan is "working".
    expect(within(group).queryByTestId('helper-card-kid-b')).toBeNull();
  });

  it('a paused plan with nobody working is not listed', () => {
    render(<ChatProvider><Card initial={plan({ status: 'paused', paused: { stepId: 's1', reason: 'x', kind: 'spend-limit' } })} withCard={false} /></ChatProvider>);
    expect(screen.queryByTestId('specialists-chip')).toBeNull();
  });
});
