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
    ceilingTokens: 42000, ceilingUsd: null, model: { label: 'GPT-5.1 (ChatGPT)' }, seq: 1,
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
      approve: vi.fn(), comment: vi.fn(), addBudget: vi.fn(), resume: vi.fn(), stop: vi.fn(),
      getAutoApprove: vi.fn().mockResolvedValue({ ok: true, underTokens: 0 }),
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

describe('A. an approximate limit wears a tilde, and no extra sentence', () => {
  it('proposed, no price: "Up to ~42,000 tokens", and no ChatGPT note', () => {
    render(<ChatProvider><Card initial={plan({ approximateLimit: true })} /></ChatProvider>);
    expect(screen.getByTestId('plan-ceiling')).toHaveTextContent('3 specialists · Up to ~42,000 tokens · specialists run on GPT-5.1 (ChatGPT), which has no published price');
    expect(screen.queryByTestId('plan-approximate-note')).toBeNull();
    expect(block()).not.toHaveTextContent('On ChatGPT');
    expect(block()).not.toHaveTextContent('about 42,000');
  });

  it('proposed, priced: the dollars and the tokens both wear the tilde', () => {
    render(<ChatProvider><Card initial={plan({ approximateLimit: true, ceilingUsd: 0.12 })} /></ChatProvider>);
    expect(screen.getByTestId('plan-ceiling')).toHaveTextContent('Up to ~$0.12 (~42,000 tokens) · specialists run on GPT-5.1 (ChatGPT)');
  });

  it('each step\'s "up to" figure wears it too', () => {
    render(<ChatProvider><Card initial={plan({ approximateLimit: true })} /></ChatProvider>);
    expect(screen.getByTestId('plan-step-s1')).toHaveTextContent('up to ~4,000 tokens');
    expect(screen.getByTestId('plan-step-s2')).toHaveTextContent('up to ~4,000 tokens');
    // A folded step with no specialists yet says each one's own limit.
    fireEvent.click(within(screen.getByTestId('plan-step-s1')).getAllByRole('button')[0]);
    expect(screen.getByTestId('plan-step-s1')).toHaveTextContent('Each reviewer stops at its ~2,000 tokens limit.');
  });

  it('while spending: the limit wears it, the spent figure (a real count) does not', () => {
    const { unmount } = render(<ChatProvider><Card initial={running({ approximateLimit: true })} /></ChatProvider>);
    expect(screen.getByTestId('plan-ceiling')).toHaveTextContent('Spent 1,000 tokens of the ~42,000 tokens limit');
    expect(screen.queryByTestId('plan-approximate-note')).toBeNull();
    unmount();
    render(<ChatProvider><Card initial={running({ approximateLimit: true, ceilingUsd: 0.12, usedUsd: 0.01 })} /></ChatProvider>);
    expect(screen.getByTestId('plan-ceiling')).toHaveTextContent('Spent $0.01 (1,000 tokens) of the ~$0.12 limit (~42,000 tokens)');
  });

  it('an exact limit has no tilde anywhere (the signed wording)', () => {
    const { unmount } = render(<ChatProvider><Card initial={plan({ ceilingUsd: 0.12 })} /></ChatProvider>);
    expect(screen.getByTestId('plan-ceiling')).toHaveTextContent('Up to about $0.12 (42,000 tokens)');
    expect(block()).not.toHaveTextContent('~');
    unmount();
    render(<ChatProvider><Card initial={running()} /></ChatProvider>);
    expect(screen.getByTestId('plan-ceiling')).toHaveTextContent('Spent 1,000 tokens of the 42,000 tokens limit');
    expect(block()).not.toHaveTextContent('~');
  });
});

// ---------------------------------------------------------------------------

describe('B. filled buttons sit on the right, the light one to their left', () => {
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

  it('paused and interrupted already follow the rule: Stop, then Continue / Add budget', () => {
    const { unmount } = render(<ChatProvider><Card initial={plan({ status: 'interrupted' })} /></ChatProvider>);
    expect(buttons().slice(-2)).toEqual(['Stop', 'Continue']);
    unmount();
    render(<ChatProvider><Card initial={plan({
      status: 'paused', steps: [{ ...plan().steps[0], status: 'paused' }, plan().steps[1]],
      paused: { stepId: 's1', reason: 'step 1 hit its limit.', kind: 'budget' },
    })} /></ChatProvider>);
    expect(buttons().slice(-2)).toEqual(['Stop', 'Add budget']);
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }));
    expect(buttons().slice(-2)).toEqual(['Cancel', 'Continue']);
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
    expect(toggle).toHaveTextContent('0 of 2 steps');
    expect(toggle).not.toHaveTextContent('needs you');
    expect(screen.queryByTestId('helper-card-kid-a')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const group = screen.getByTestId('plan-group-plan-1');
    expect(within(group).getByTestId('helper-card-kid-a')).toBeInTheDocument();
    expect(within(group).getByTestId('helper-card-kid-b')).toBeInTheDocument();
    expect(screen.queryByTestId('helper-card-kid-c')).toBeNull();
    // Plan specialists are not repeated in the ordinary sections.
    expect(screen.queryByText('Working')).toBeNull();
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
    render(<ChatProvider><Card initial={plan({ status: 'paused', paused: { stepId: 's1', reason: 'x', kind: 'budget' } })} withCard={false} /></ChatProvider>);
    expect(screen.queryByTestId('specialists-chip')).toBeNull();
  });
});
