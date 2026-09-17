// @vitest-environment jsdom
/**
 * Specialists plans, Task 10 — the review-deck-7 changes (controller
 * decisions 15 and 16):
 *  A. (R7-2 note) a proposal's Comment · Approve sit on the SAME row as the
 *     limit line — text on the left, buttons on the right, Approve rightmost —
 *     and drop below it, still on the right, when the row is too narrow;
 *  B. (R7-5) the Specialists popup has no separate "Plans" header: each plan
 *     is a card as wide as an ordinary specialist's card, titled
 *     "Plan: <name>" with its status phrase, and still folds to its
 *     specialists.
 * (Decision 17, the hidden plan notice row, is tests/plan-notice-hidden.test.tsx.)
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
      { id: 's1', kind: 'map', title: 'Review', specialist: 'reviewer', fanOut: 2, budgetTokens: 2000, status: 'pending' },
      { id: 's2', kind: 'combine', title: 'Combine', specialist: 'worker', fanOut: 1, budgetTokens: 4000, status: 'pending' },
    ],
    ceilingTokens: 42000, ceilingUsd: null, model: { label: 'Claude Sonnet 4.6' }, seq: 1,
    ...over,
  };
}

const running = (over: Partial<PlanView> = {}) => plan({
  status: 'running', usedTokens: 1000,
  steps: [
    { ...plan().steps[0], status: 'running', done: 0, children: [
      child({ childId: 'kid-a', title: 'Wren the Reviewer' }),
      child({ childId: 'kid-b', title: 'Idris the Reviewer' }),
    ] },
    plan().steps[1],
  ],
  ...over,
});

// An ordinary (independent) specialist, hired with the Task tool.
const HIRE: ChatAction[] = [
  { type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'u-task', toolUseId: 'task-1', toolName: 'Task', toolInput: { agent: 'worker', description: 'Run the checklist', background: true } },
  { type: 'SPECIALIST_RUN_CHANGED', sessionId: S, run: { childId: 'solo', parentToolCallId: 'task-1', agentType: 'worker', title: 'Kai the Worker', description: 'Run the checklist', background: true, status: 'running', startedAt: 1 } },
];
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
const ceilingRow = () => screen.getByTestId('plan-ceiling');
const planToggle = () => within(screen.getByTestId('plan-group-toggle')).getAllByRole('button')[0];

beforeEach(() => {
  resetPlanSupportForTests();
  (window as any).claude = {
    plans: {
      approve: vi.fn(), comment: vi.fn(), addBudget: vi.fn(), resume: vi.fn(), stop: vi.fn(),
      getAutoApprove: vi.fn().mockResolvedValue({ ok: true, underTokens: 0 }),
      setAutoApprove: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
});
afterEach(() => { cleanup(); delete (window as any).claude; });

// ---------------------------------------------------------------------------

describe('A. a proposal\'s buttons share the limit line', () => {
  it('Comment and Approve sit in the limit row, after its text, Approve rightmost', () => {
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    const row = ceilingRow();
    const names = within(row).getAllByRole('button').map((b) => b.textContent?.trim());
    expect(names).toEqual(['Comment', 'Approve']);
    // Text first, then the buttons: the words read left, the actions right.
    const [text, actions] = Array.from(row.children);
    expect(text).toHaveTextContent('3 specialists · Up to 42,000 tokens');
    expect(actions).toContainElement(screen.getByRole('button', { name: 'Approve' }));
    // No second row of buttons below the card's text any more.
    expect(within(block()).getAllByRole('button', { name: /^(Comment|Approve)$/ })).toHaveLength(2);
  });

  it('wraps gracefully: the text can shrink and wrap, the buttons drop below on the right', () => {
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    const row = ceilingRow();
    expect(row).toHaveClass('flex', 'flex-wrap');
    const [text, actions] = Array.from(row.children);
    // The text takes the free space but keeps a readable minimum before the
    // buttons are pushed onto their own line…
    expect(text).toHaveClass('flex-1', 'min-w-0', 'basis-64');
    // …and the buttons never shrink, and stay on the right when they wrap.
    expect(actions).toHaveClass('shrink-0', 'ml-auto', 'justify-end');
  });

  it('opening the comment box takes the buttons out of the row; the box keeps Cancel · Send', () => {
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(within(ceilingRow()).queryAllByRole('button')).toHaveLength(0);
    const box = screen.getByTestId('plan-comment');
    expect(within(box).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['Cancel', 'Send']);
  });

  it('a running plan keeps Stop on the same row, laid out the same way', () => {
    render(<ChatProvider><Card initial={running()} withCard /></ChatProvider>);
    const row = ceilingRow();
    const [text, actions] = Array.from(row.children);
    expect(text).toHaveTextContent('Spent 1,000 tokens');
    expect(within(actions as HTMLElement).getByRole('button', { name: 'Stop the plan' })).toBeInTheDocument();
    expect(actions).toHaveClass('shrink-0', 'ml-auto');
  });

  it('a revised or finished card has no buttons in that row', () => {
    for (const p of [plan({ status: 'stopped', revisedBy: 'plan-2' }), plan({ status: 'completed' })]) {
      const { unmount } = render(<ChatProvider><Card initial={p} /></ChatProvider>);
      expect(within(ceilingRow()).queryAllByRole('button')).toHaveLength(0);
      unmount();
    }
  });
});

// ---------------------------------------------------------------------------

describe('B. a plan in the Specialists popup is a card like a specialist\'s', () => {
  it('no "Plans" header; the plan card is titled "Plan: <name>" with its status, folded', () => {
    render(<ChatProvider><Card initial={running()} withCard={false} /></ChatProvider>);
    fireEvent.click(screen.getByTestId('specialists-chip'));
    expect(screen.queryByText('Plans')).toBeNull();
    const toggle = planToggle();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('Plan: Review two files');
    expect(toggle).toHaveTextContent('step 1 of 2');
    expect(screen.queryByTestId('helper-card-kid-a')).toBeNull();
  });

  it('is as wide as an ordinary specialist\'s card: the same list, the same card frame', () => {
    render(<ChatProvider><Card initial={running()} extra={HIRE} withCard={false} /></ChatProvider>);
    fireEvent.click(screen.getByTestId('specialists-chip'));
    const planCard = screen.getByTestId('plan-group-plan-1');
    const soloCard = screen.getByTestId('helper-card-solo');
    // Siblings in one list → the same width by construction.
    expect(planCard.parentElement).toBe(soloCard.parentElement);
    // The same frame an ordinary card wears.
    for (const cls of ['rounded-lg', 'border', 'bg-inset/50', 'overflow-hidden']) {
      expect(planCard).toHaveClass(cls);
      expect(soloCard).toHaveClass(cls);
    }
    // A working plan sits with the working specialists, first.
    const cards = Array.from(planCard.parentElement!.children).map((c) => c.getAttribute('data-testid'));
    expect(cards).toEqual(['plan-group-plan-1', 'helper-card-solo']);
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('opens inside its own card onto the plan\'s specialists', () => {
    render(<ChatProvider><Card initial={running()} extra={HIRE} withCard={false} /></ChatProvider>);
    fireEvent.click(screen.getByTestId('specialists-chip'));
    fireEvent.click(planToggle());
    expect(planToggle()).toHaveAttribute('aria-expanded', 'true');
    const planCard = screen.getByTestId('plan-group-plan-1');
    expect(within(planCard).getByTestId('helper-card-kid-a')).toBeInTheDocument();
    expect(within(planCard).getByTestId('helper-card-kid-b')).toBeInTheDocument();
    expect(within(planCard).queryByTestId('helper-card-solo')).toBeNull();
    fireEvent.click(planToggle());
    expect(within(planCard).queryByTestId('helper-card-kid-a')).toBeNull();
  });

  it('a plan with an asking specialist sits under "Needs you", opened, with the amber frame', () => {
    const ask: ChatAction = {
      type: 'PERMISSION_REQUEST', sessionId: S, toolName: 'Bash', input: { command: 'npm test' }, requestId: 'req-plan-1',
      specialist: { childId: 'kid-a', agentType: 'reviewer', title: 'Wren the Reviewer', parentToolCallId: CARD, plan: { planId: 'plan-1', stepId: 's1', attemptId: 'att-a' } },
    };
    render(<ChatProvider><Card initial={running()} extra={[...HIRE, ask]} withCard={false} /></ChatProvider>);
    fireEvent.click(screen.getByTestId('specialists-chip'));
    const needs = screen.getByText('Needs you').closest('section')!;
    const planCard = within(needs).getByTestId('plan-group-plan-1');
    expect(planCard).toHaveClass('border-amber-700/40');
    expect(planToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(planToggle()).toHaveTextContent('1 needs you');
    // The ordinary working specialist is still under Working, not Needs you.
    const working = screen.getByText('Working').closest('section')!;
    expect(within(working).getByTestId('helper-card-solo')).toBeInTheDocument();
    expect(within(working).queryByTestId('plan-group-plan-1')).toBeNull();
  });
});
