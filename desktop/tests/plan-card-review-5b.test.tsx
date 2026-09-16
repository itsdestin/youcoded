// @vitest-environment jsdom
/**
 * Specialists plans, Task 5b — the ten plan-card changes the product owner
 * reviews on a before/after deck. Each describe block is one numbered change
 * (task-5b-scope.md); the signed states it does not name must stay as signed
 * (tests/plan-card-signed-copy.test.tsx).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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

// The executor's exact pause sentences (plan-executor.ts). tests/plan-pause.test.ts
// pins that these templates still exist in the backend source.
const UNKNOWN_REASON = 'A specialist in step "s1" was cut off, and it isn\'t known whether its last action (Bash) finished. Press Continue to let it pick up from what it recorded.';
const CAP_REASON = 'The repeated steps ran 3 times without meeting their stop condition ("every auth test passes"). Ask the assistant to revise the plan.';

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
    steps: [{ id: 's1', kind: 'map', title: 'Review', specialist: 'reviewer', fanOut: 2, budgetTokens: 2000, status: 'pending' }],
    ceilingTokens: 42000, ceilingUsd: null, model: { label: 'GPT-5.1 (ChatGPT)' }, seq: 1,
    ...over,
  };
}

function paused(reason: string, extra: Partial<PlanView> = {}, minimumAddTokens?: number): PlanView {
  return plan({
    status: 'paused', usedTokens: 4000,
    steps: [{ ...plan().steps[0], status: 'paused', done: 1, usedTokens: 4000 }],
    paused: { stepId: 's1', reason, ...(minimumAddTokens !== undefined ? { minimumAddTokens } : {}) },
    ...extra,
  });
}

// A stable default: a fresh [] per render would re-run the seeding effect forever.
const NO_ACTIONS: ChatAction[] = [];

function Card({ initial, extra = NO_ACTIONS }: { initial: PlanView; extra?: ChatAction[] }) {
  const dispatch = useChatDispatch();
  useEffect(() => {
    dispatch({ type: 'SESSION_INIT', sessionId: S });
    dispatch({ type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'u', toolUseId: CARD, toolName: 'propose_plan', toolInput: {} });
    dispatch({ type: 'PLAN_CHANGED', sessionId: S, plan: initial });
    for (const a of extra) dispatch(a);
  }, [dispatch, initial, extra]);
  const tool = useChatState(S).toolCalls.get(CARD);
  return tool ? <><ToolCard tool={tool} sessionId={S} /><SpecialistsChip sessionId={S} /></> : null;
}

const block = () => screen.getByTestId('plan-block');
const status = () => block().getAttribute('data-plan-status');
const buttons = () => within(block()).queryAllByRole('button').map((b) => (b.textContent ?? '').trim()).filter(Boolean);

function bridge(over: Record<string, unknown> = {}) {
  const plans = {
    approve: vi.fn(), comment: vi.fn(), addBudget: vi.fn(), resume: vi.fn(), stop: vi.fn(),
    getAutoApprove: vi.fn().mockResolvedValue({ ok: true, underTokens: 0 }),
    setAutoApprove: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  };
  (window as any).claude = { plans };
  return plans;
}

beforeEach(() => resetPlanSupportForTests());
afterEach(() => { cleanup(); delete (window as any).claude; });

describe('1. an approximate limit says so', () => {
  it('the ceiling reads "about" and one line explains the ChatGPT overshoot', () => {
    bridge();
    render(<ChatProvider><Card initial={plan({ approximateLimit: true })} /></ChatProvider>);
    expect(screen.getByTestId('plan-ceiling')).toHaveTextContent('Up to about 42,000 tokens · specialists run on GPT-5.1 (ChatGPT), which has no published price');
    expect(screen.getByTestId('plan-approximate-note')).toHaveTextContent('On ChatGPT, one reply can run past this limit before the plan pauses.');
  });

  it('a priced approximate plan says "about" for the tokens too, and so does "spent of"', () => {
    bridge();
    const { unmount } = render(<ChatProvider><Card initial={plan({ approximateLimit: true, ceilingUsd: 0.12 })} /></ChatProvider>);
    expect(screen.getByTestId('plan-ceiling')).toHaveTextContent('Up to about $0.12 (about 42,000 tokens)');
    unmount();
    render(<ChatProvider><Card initial={plan({ approximateLimit: true, status: 'running', usedTokens: 1000, steps: [{ ...plan().steps[0], status: 'running' }] })} /></ChatProvider>);
    expect(screen.getByTestId('plan-ceiling')).toHaveTextContent('Spent 1,000 tokens of the limit of about 42,000 tokens');
    expect(screen.getByTestId('plan-approximate-note')).toBeInTheDocument();
  });

  it('an exact limit is unchanged and has no note', () => {
    bridge();
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    expect(screen.getByTestId('plan-ceiling')).toHaveTextContent('Up to 42,000 tokens · specialists run on');
    expect(screen.queryByTestId('plan-approximate-note')).toBeNull();
  });
});

describe('2. a failed card explains itself', () => {
  it('shows the real reason with Report bug and Diagnose, which open the report screen', async () => {
    bridge();
    const detail = 'The saved plan file is not valid JSON (Unexpected end of JSON input).';
    render(<ChatProvider><Card initial={plan({ status: 'failed', failure: { detail } })} /></ChatProvider>);
    const alert = within(block()).getByRole('alert');
    expect(alert).toHaveTextContent(detail);
    expect(within(alert).getByRole('button', { name: 'Report bug' })).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Diagnose with the assistant' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('a failed card with no reason shows no error block (nothing is invented)', () => {
    bridge();
    render(<ChatProvider><Card initial={plan({ status: 'failed' })} /></ChatProvider>);
    expect(within(block()).queryByRole('alert')).toBeNull();
  });

  it('a salvaged card with no steps does not print a meaningless 0-token limit', () => {
    bridge();
    render(<ChatProvider><Card initial={plan({ status: 'failed', steps: [], ceilingTokens: 0, failure: { detail: 'The saved plan file is damaged.' } })} /></ChatProvider>);
    expect(screen.queryByTestId('plan-ceiling')).toBeNull();
  });
});

describe('3. an unknown-outcome pause warns before Continue', () => {
  it('names the action in plain words, warns it may repeat, and offers Stop and Continue', async () => {
    const plans = bridge({ resume: vi.fn().mockResolvedValue({ ok: true, plan: plan({ status: 'running', seq: 2 }) }) });
    render(<ChatProvider><Card initial={paused(UNKNOWN_REASON)} /></ChatProvider>);
    const reason = screen.getByTestId('plan-paused-reason');
    expect(reason).toHaveTextContent('Paused — a specialist in step 1 stopped while running a command, and it isn\'t known whether that finished.');
    expect(screen.getByTestId('plan-paused-warning')).toHaveTextContent('Continue may run it again. Check first whether it already happened.');
    expect(buttons()).toEqual(expect.arrayContaining(['Stop', 'Continue']));
    expect(buttons()).not.toContain('Add budget');
    fireEvent.click(within(block()).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(status()).toBe('running'));
    expect(plans.resume).toHaveBeenCalledWith(S, 'plan-1');
  });

  it('keeps the cut-off note the backend appended', () => {
    bridge();
    const note = '1 other specialist in step "s1" was cut off mid-request, and it isn\'t known whether that request finished; Continue lets it pick up from what it recorded.';
    render(<ChatProvider><Card initial={paused(`${UNKNOWN_REASON} ${note}`)} /></ChatProvider>);
    expect(screen.getByTestId('plan-paused-reason')).toHaveTextContent(note);
  });

  it('the header says to check before continuing', () => {
    expect(planDisplay({}, paused(UNKNOWN_REASON)).detail).toBe('paused — check before continuing');
  });
});

describe('5. an iteration-cap pause offers only Stop', () => {
  it('says the rounds ran out, suggests a revised plan, and has no Add budget or Continue', () => {
    bridge();
    render(<ChatProvider><Card initial={paused(CAP_REASON, { paused: { stepId: 'loop', reason: CAP_REASON } })} /></ChatProvider>);
    expect(screen.getByTestId('plan-paused-reason')).toHaveTextContent('Paused — the repeated steps ran 3 times without meeting their goal ("every auth test passes").');
    expect(screen.getByTestId('plan-paused-warning')).toHaveTextContent('To keep going, ask the assistant for a revised plan.');
    expect(buttons().filter((b) => ['Stop', 'Add budget', 'Continue'].includes(b))).toEqual(['Stop']);
    expect(planDisplay({}, paused(CAP_REASON)).detail).toBe('paused — needs a revised plan');
  });
});

describe('6. a minimum top-up', () => {
  const budgetPause = () => paused('step 1 hit its limit.', {}, 12500);

  it('starts the field at the minimum and says so', () => {
    bridge();
    render(<ChatProvider><Card initial={budgetPause()} /></ChatProvider>);
    fireEvent.click(within(block()).getByRole('button', { name: 'Add budget' }));
    expect(screen.getByLabelText('Tokens to allow')).toHaveValue('12,500');
    expect(screen.getByTestId('plan-add-minimum')).toHaveTextContent('Add at least 12,500 tokens to continue.');
  });

  it('starts at the minimum even when the step’s own cap is larger', () => {
    bridge();
    const big = paused('step 1 hit its limit.', {}, 12500);
    big.steps = [{ ...big.steps[0], budgetTokens: 20000 }];
    render(<ChatProvider><Card initial={big} /></ChatProvider>);
    fireEvent.click(within(block()).getByRole('button', { name: 'Add budget' }));
    expect(screen.getByLabelText('Tokens to allow')).toHaveValue('12,500');
  });

  it('refuses a smaller amount before sending anything', () => {
    const plans = bridge();
    render(<ChatProvider><Card initial={budgetPause()} /></ChatProvider>);
    fireEvent.click(within(block()).getByRole('button', { name: 'Add budget' }));
    fireEvent.change(screen.getByLabelText('Tokens to allow'), { target: { value: '5,000' } });
    const cont = within(screen.getByTestId('plan-add-budget')).getByRole('button', { name: 'Continue' });
    expect(cont).toBeDisabled();
    expect(within(screen.getByTestId('plan-add-minimum')).getByRole('alert')).toHaveTextContent('Add at least 12,500 tokens to continue.');
    fireEvent.keyDown(screen.getByLabelText('Tokens to allow'), { key: 'Enter' });
    fireEvent.click(cont);
    expect(plans.addBudget).not.toHaveBeenCalled();
  });

  it('without a minimum the field keeps the step’s own cap and no line shows', () => {
    bridge();
    render(<ChatProvider><Card initial={paused('step 1 hit its limit.')} /></ChatProvider>);
    fireEvent.click(within(block()).getByRole('button', { name: 'Add budget' }));
    expect(screen.getByLabelText('Tokens to allow')).toHaveValue('2,000');
    expect(screen.queryByTestId('plan-add-minimum')).toBeNull();
  });

  it('a budget the host accepted continues the plan (the host leaves it paused until Continue)', async () => {
    const stillPaused = { ...budgetPause(), ceilingTokens: 54500, seq: 2 };
    const plans = bridge({
      addBudget: vi.fn().mockResolvedValue({ ok: true, plan: stillPaused }),
      resume: vi.fn().mockResolvedValue({ ok: true, plan: plan({ status: 'running', seq: 3 }) }),
    });
    render(<ChatProvider><Card initial={budgetPause()} /></ChatProvider>);
    fireEvent.click(within(block()).getByRole('button', { name: 'Add budget' }));
    fireEvent.click(within(screen.getByTestId('plan-add-budget')).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(status()).toBe('running'));
    expect(plans.addBudget).toHaveBeenCalledWith(S, 'plan-1', 12500);
    expect(plans.resume).toHaveBeenCalledWith(S, 'plan-1');
  });

  it('a budget answer that already runs the plan is not resumed twice', async () => {
    const plans = bridge({
      addBudget: vi.fn().mockResolvedValue({ ok: true, plan: plan({ status: 'running', seq: 2 }) }),
      resume: vi.fn(),
    });
    render(<ChatProvider><Card initial={budgetPause()} /></ChatProvider>);
    fireEvent.click(within(block()).getByRole('button', { name: 'Add budget' }));
    fireEvent.click(within(screen.getByTestId('plan-add-budget')).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(status()).toBe('running'));
    expect(plans.resume).not.toHaveBeenCalled();
  });
});

describe('7. the card’s error line follows the error standards', () => {
  it('an unreadable answer is the general line with Report bug and Retry, and Retry repeats the action', async () => {
    const plans = bridge({
      approve: vi.fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true, plan: plan({ status: 'running', seq: 2 }) }),
    });
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    fireEvent.click(within(block()).getByRole('button', { name: 'Approve' }));
    const alert = await within(block()).findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't update the plan. Please try again.");
    expect(within(alert).getByRole('button', { name: 'Report bug' })).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(status()).toBe('running'));
    expect(plans.approve).toHaveBeenCalledTimes(2);
  });

  it('a host’s own reason is shown as-is with Retry only', async () => {
    bridge({ stop: vi.fn().mockResolvedValue({ ok: false, error: 'This plan is running in another YouCoded window. Stop it there.' }) });
    render(<ChatProvider><Card initial={plan({ status: 'running', steps: [{ ...plan().steps[0], status: 'running' }] })} /></ChatProvider>);
    fireEvent.click(within(block()).getByRole('button', { name: 'Stop the plan' }));
    const alert = await within(block()).findByRole('alert');
    expect(alert).toHaveTextContent('This plan is running in another YouCoded window. Stop it there.');
    expect(within(alert).queryByRole('button', { name: 'Report bug' })).toBeNull();
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('the unsupported reason is a quiet note, not an error', async () => {
    bridge({ getAutoApprove: vi.fn().mockResolvedValue({ ok: false, unsupported: true, error: "Plans aren't available here." }) });
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    expect(await screen.findByText("Plans aren't available here.")).toBeInTheDocument();
    expect(within(block()).queryByRole('alert')).toBeNull();
  });
});

describe('9. a specialist stopped before it started', () => {
  it('reads "Not started", not "the assistant can pick this back up"', () => {
    bridge();
    const stopped = plan({
      status: 'stopped',
      steps: [{ ...plan().steps[0], status: 'skipped', children: [
        child({ childId: 'kid-a', status: 'completed', endedAt: 61_001, report: { text: 'done', status: 'completed', timestamp: 2 } }),
        child({ childId: 'kid-b', title: 'Idris the Reviewer', status: 'interrupted', endedAt: 30_001, segments: [{ type: 'text', id: 't', content: 'reading' }] }),
        child({ childId: 'kid-c', title: 'Mara the Reviewer', status: 'interrupted', endedAt: 1_001 }),
      ] }],
    });
    render(<ChatProvider><Card initial={stopped} /></ChatProvider>);
    fireEvent.click(within(screen.getByTestId('plan-step-s1')).getAllByRole('button')[0]);
    const rows = screen.getAllByTestId('plan-child');
    expect(rows[2]).toHaveTextContent('Mara the ReviewerNot started');
    expect(rows[2]).not.toHaveTextContent('pick this back up');
    // A specialist that did work keeps its ordinary stopped line.
    expect(rows[1]).toHaveTextContent('Stopped after');
  });
});

describe('10. a plan specialist waiting on the user lights the specialists chip', () => {
  const ask: ChatAction = {
    type: 'PERMISSION_REQUEST', sessionId: S, toolName: 'Bash', input: { command: 'npm test' }, requestId: 'req-plan-1',
    specialist: { childId: 'kid-a', agentType: 'reviewer', title: 'Wren the Reviewer', parentToolCallId: CARD, plan: { planId: 'plan-1', stepId: 's1', attemptId: 'att-a' } },
  };
  const ASKS = [ask];
  const running = plan({ status: 'running', steps: [{ ...plan().steps[0], status: 'running', children: [child(), child({ childId: 'kid-b', title: 'Idris the Reviewer' })] }] });

  it('shows "1 needs you", and the popup lists that specialist with its ask', () => {
    bridge();
    render(<ChatProvider><Card initial={running} extra={ASKS} /></ChatProvider>);
    const chip = screen.getByTestId('specialists-chip');
    expect(chip).toHaveTextContent('1 needs you');
    fireEvent.click(chip);
    const card = screen.getByTestId('helper-card-kid-a');
    expect(within(card).getByTestId('helper-card-ask')).toHaveTextContent('Wren wants to:');
    // Only the asking specialist is listed — its working sibling is not.
    expect(screen.queryByTestId('helper-card-kid-b')).toBeNull();
  });

  it('a plan with no open ask adds nothing to the chip', () => {
    bridge();
    render(<ChatProvider><Card initial={running} /></ChatProvider>);
    expect(screen.queryByTestId('specialists-chip')).toBeNull();
  });
});
