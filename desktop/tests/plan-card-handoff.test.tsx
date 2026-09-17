// @vitest-environment jsdom
/**
 * Specialists plans, Task 9b — the plan card while a pause is handed to the
 * assistant (pause handoff design §2 steps 2, 7 and 8; since Task 11 the
 * handoff starts only from "Ask the assistant", which leads every paused
 * card's buttons — plan-card-ask.test.tsx):
 *  - pending: greyed, no buttons, "The assistant is looking into this.";
 *  - recommended: the assistant's message, the recommended action as the
 *    filled RIGHT button (Add budget pre-filled), Stop as the light button on
 *    its left (design guide G-29, decision 9); a recommended Stop is the one
 *    filled button;
 *  - answered with no recommendation: the default buttons for the kind.
 * The user still presses every button.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React, { useEffect } from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider, useChatDispatch, useChatState } from '../src/renderer/state/chat-context';
import type { PlanView } from '../src/shared/types';
import { resetPlanSupportForTests } from '../src/renderer/components/plans/plan-bridge';
import { planDisplay } from '../src/renderer/components/plans/PlanCard';
import { toolActionLabel } from '../src/renderer/utils/tool-group-summary';

const S = 's1';
const CARD = 'call-plan';

function paused(pausedOver: Partial<NonNullable<PlanView['paused']>> = {}, over: Partial<PlanView> = {}): PlanView {
  return {
    planId: 'plan-1', toolUseId: CARD, title: 'Review two files', status: 'paused',
    steps: [
      { id: 's1', kind: 'map', title: 'Review', specialist: 'reviewer', fanOut: 2, budgetTokens: 2000, status: 'paused', done: 1, usedTokens: 4000 },
      { id: 's2', kind: 'combine', title: 'Combine', specialist: 'worker', fanOut: 1, budgetTokens: 4000, status: 'pending' },
    ],
    ceilingTokens: 8000, ceilingUsd: null, model: { label: 'Model' }, usedTokens: 4000, seq: 4,
    paused: { stepId: 's1', reason: 'step 1 hit its limit.', kind: 'budget', minimumAddTokens: 1200, actions: ['add_budget', 'stop'], ...pausedOver },
    ...over,
  };
}

function Card({ initial }: { initial: PlanView }) {
  const dispatch = useChatDispatch();
  useEffect(() => {
    dispatch({ type: 'SESSION_INIT', sessionId: S });
    dispatch({ type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'u', toolUseId: CARD, toolName: 'propose_plan', toolInput: {} });
    dispatch({ type: 'PLAN_CHANGED', sessionId: S, plan: initial });
  }, [dispatch, initial]);
  const tool = useChatState(S).toolCalls.get(CARD);
  return tool ? <ToolCard tool={tool} sessionId={S} /> : null;
}

const block = () => screen.getByTestId('plan-block');
const buttons = () => within(block()).queryAllByRole('button')
  .filter((b) => !b.hasAttribute('aria-expanded'))
  .map((b) => (b.textContent ?? '').trim()).filter(Boolean);
let api: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  resetPlanSupportForTests();
  api = {
    approve: vi.fn(), comment: vi.fn(), resume: vi.fn(), stop: vi.fn(),
    addBudget: vi.fn(async (_s: string, _p: string, tokens: number) => ({ ok: true, plan: paused({ minimumAddTokens: undefined }, { ceilingTokens: 8000 + tokens }) })),
    getAutoApprove: vi.fn().mockResolvedValue({ ok: true, underTokens: 0 }),
    setAutoApprove: vi.fn().mockResolvedValue({ ok: true }),
  };
  (window as any).claude = { plans: api };
});
afterEach(() => { cleanup(); delete (window as any).claude; });

describe('pending: the assistant is looking into it', () => {
  it('is greyed, has no buttons, and says so', () => {
    render(<ChatProvider><Card initial={paused({ handoff: { state: 'pending' } })} /></ChatProvider>);
    expect(block()).toHaveClass('opacity-60');
    expect(screen.getByTestId('plan-handoff-pending')).toHaveTextContent('The assistant is looking into this.');
    expect(buttons()).toEqual([]);
    expect(screen.getByTestId('plan-paused-reason')).toHaveTextContent('Paused — step 1 hit its limit.');
    // The header agrees (the Specialists chip's plan row reads the same phrase).
    expect(planDisplay({}, paused({ handoff: { state: 'pending' } })).detail).toBe('paused — the assistant is looking into this');
  });

  it('nothing on it can be pressed, not even Stop', () => {
    render(<ChatProvider><Card initial={paused({ handoff: { state: 'pending' } })} /></ChatProvider>);
    expect(within(block()).queryByRole('button', { name: /stop|add budget|continue/i })).toBeNull();
    expect(api.stop).not.toHaveBeenCalled();
  });
});

describe('recommended: the assistant\'s button, filled and on the right', () => {
  const message = 'One reviewer ran out; 3,000 more tokens lets it finish.';

  it('add_budget: Stop (light) then Add budget (filled); the amount is pre-filled with the recommendation', async () => {
    render(<ChatProvider><Card initial={paused({ handoff: { state: 'answered', recommendation: { action: 'add_budget', addTokens: 3000, message } } })} /></ChatProvider>);
    expect(block()).not.toHaveClass('opacity-60');
    expect(screen.getByTestId('plan-recommendation')).toHaveTextContent(`The assistant suggests: ${message}`);
    expect(buttons()).toEqual(['Ask the assistant', 'Stop', 'Add budget']);
    const add = screen.getByRole('button', { name: 'Add budget' });
    expect(add.className).toContain('bg-accent');
    expect(screen.getByRole('button', { name: 'Stop' }).className).not.toContain('bg-destructive ');
    fireEvent.click(add);
    expect(screen.getByLabelText('Tokens to allow')).toHaveValue('3,000');
    // Nothing is sent until the user presses Continue.
    expect(api.addBudget).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.addBudget).toHaveBeenCalledWith(S, 'plan-1', 3000));
  });

  it('add_budget below the host\'s minimum starts at the minimum instead', () => {
    render(<ChatProvider><Card initial={paused({ minimumAddTokens: 5000, handoff: { state: 'answered', recommendation: { action: 'add_budget', addTokens: 3000, message } } })} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }));
    expect(screen.getByLabelText('Tokens to allow')).toHaveValue('5,000');
  });

  it('continue: Stop (light) then Continue (filled)', () => {
    render(<ChatProvider><Card initial={paused({ kind: 'unexpected-error', minimumAddTokens: undefined, actions: ['continue', 'stop'], handoff: { state: 'answered', recommendation: { action: 'continue', message: 'The provider hiccuped; trying again should work.' } } })} /></ChatProvider>);
    expect(buttons()).toEqual(['Ask the assistant', 'Stop', 'Continue']);
    expect(screen.getByRole('button', { name: 'Continue' }).className).toContain('bg-accent');
    expect(screen.getByTestId('plan-recommendation')).toHaveTextContent('The assistant suggests: The provider hiccuped; trying again should work.');
  });

  it('stop: one filled Stop button, and nothing else but Ask (Task 11)', () => {
    render(<ChatProvider><Card initial={paused({ handoff: { state: 'answered', recommendation: { action: 'stop', message: 'This cannot finish as planned.' } } })} /></ChatProvider>);
    expect(buttons()).toEqual(['Ask the assistant', 'Stop']);
    // Whole class: the light variant only has `hover:bg-destructive/10`.
    expect(screen.getByRole('button', { name: 'Stop' }).className.split(/\s+/)).toContain('bg-destructive');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(api.stop).toHaveBeenCalledWith(S, 'plan-1');
  });

  it('the button row sits on the right (G-29)', () => {
    render(<ChatProvider><Card initial={paused({ handoff: { state: 'answered', recommendation: { action: 'add_budget', addTokens: 3000, message } } })} /></ChatProvider>);
    const row = screen.getByRole('button', { name: 'Add budget' }).parentElement!;
    expect(row.lastElementChild).toBe(screen.getByRole('button', { name: 'Add budget' }));
  });
});

describe('answered with no recommendation: the default buttons (§2 step 7)', () => {
  it.each([
    ['budget', ['add_budget', 'stop'], ['Stop', 'Add budget']],
    ['ceiling-shortfall', ['add_budget', 'stop'], ['Stop', 'Add budget']],
    ['plan-limit', ['stop'], ['Stop']],
    ['local-pool', ['stop'], ['Stop']],
    ['launch-failed', ['stop'], ['Stop']],
    ['unexpected-error', ['continue', 'stop'], ['Stop', 'Continue']],
    ['specialist-error', ['continue', 'stop'], ['Stop', 'Continue']],
    ['invalid-report', ['continue', 'stop'], ['Stop', 'Continue']],
  ] as const)('%s → %j', (kind, actions, shown) => {
    render(<ChatProvider><Card initial={paused({ kind, actions: [...actions], minimumAddTokens: undefined, handoff: { state: 'answered' } })} /></ChatProvider>);
    // Task 11 (decision 19): every paused card leads with Ask.
    expect(buttons()).toEqual(['Ask the assistant', ...shown]);
    expect(screen.queryByTestId('plan-recommendation')).toBeNull();
    expect(screen.queryByTestId('plan-handoff-pending')).toBeNull();
    expect(block()).not.toHaveClass('opacity-60');
  });

  it('a pause never asked about uses the same defaults', () => {
    render(<ChatProvider><Card initial={paused({ kind: 'specialist-error', actions: ['continue', 'stop'], minimumAddTokens: undefined })} /></ChatProvider>);
    expect(buttons()).toEqual(['Ask the assistant', 'Stop', 'Continue']);
  });

  it('a Stop-only pause shows its Stop as the light button, as the iteration cap always did', () => {
    render(<ChatProvider><Card initial={paused({ kind: 'plan-limit', actions: ['stop'], minimumAddTokens: undefined, handoff: { state: 'answered' } })} /></ChatProvider>);
    expect(screen.getByRole('button', { name: 'Stop' }).className).toContain('border-destructive');
  });
});

describe('a plan the assistant revised', () => {
  it('says so, rather than "after your comment"', () => {
    render(<ChatProvider><Card initial={paused({}, { status: 'stopped', paused: undefined, revisedBy: 'plan-2', revisedOnPause: true })} /></ChatProvider>);
    expect(block()).toHaveTextContent('Revised by the assistant — the new plan is below.');
    expect(block()).not.toHaveTextContent('after your comment');
  });
});

describe('the recommend_plan_action tool card', () => {
  it('its own card header reads as a plain action, not the tool name', () => {
    function RecCard() {
      const dispatch = useChatDispatch();
      useEffect(() => {
        dispatch({ type: 'SESSION_INIT', sessionId: S });
        dispatch({ type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'r', toolUseId: 'rec-1', toolName: 'recommend_plan_action', toolInput: { action: 'stop', message: 'm' } });
        dispatch({ type: 'TRANSCRIPT_TOOL_RESULT', sessionId: S, uuid: 'r2', toolUseId: 'rec-1', result: 'Recommendation recorded.', isError: false });
      }, [dispatch]);
      const tool = useChatState(S).toolCalls.get('rec-1');
      return tool ? <ToolCard tool={tool} sessionId={S} /> : null;
    }
    const { container } = render(<ChatProvider><RecCard /></ChatProvider>);
    expect(container).toHaveTextContent('Suggested a next step for the plan');
    expect(container).not.toHaveTextContent('recommend_plan_action');
  });

  it('reads as a plain action, not "Used a tool"', () => {
    expect(toolActionLabel('recommend_plan_action', false)).toBe('Suggested a next step for the plan');
    expect(toolActionLabel('recommend_plan_action', true)).toBe('Suggesting a next step for the plan');
  });
});
