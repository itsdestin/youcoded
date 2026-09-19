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

// The executor's pause sentences (plan-executor.ts). The card no longer reads
// them — it reads `paused.kind` and its facts (5b follow-up) — they are here
// so each fixture looks like what the host really sends.
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

type PauseFacts = Omit<NonNullable<PlanView['paused']>, 'stepId' | 'reason'>;
const UNKNOWN: PauseFacts = { kind: 'unknown-outcome', tool: 'Bash' };
const CAP: PauseFacts = { kind: 'iteration-cap', repeat: { rounds: 3, until: 'every auth test passes' } };

function paused(reason: string, extra: Partial<PlanView> = {}, minimumAddTokens?: number, facts: PauseFacts = { kind: 'budget' }): PlanView {
  return plan({
    status: 'paused', usedTokens: 4000,
    steps: [{ ...plan().steps[0], status: 'paused', done: 1, usedTokens: 4000 }],
    paused: { stepId: 's1', reason, ...facts, ...(minimumAddTokens !== undefined ? { minimumAddTokens } : {}) },
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

// 1. The approximate limit: superseded by Task 8 (review 6, R6-1 — a tilde on
// every limit figure, no extra sentence). Pinned in tests/plan-card-review-r7.test.tsx.
describe('1. an exact limit is unchanged', () => {
  it('reads as signed, with no tilde and no note', () => {
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

  // Final review F6 (R27): every failed card says what went wrong in one line.
  // With no known reason that line is general and names no cause; it still
  // offers Report bug and Diagnose. Nothing is invented.
  it('a failed card with no known reason shows the general line with Report bug and Diagnose', () => {
    bridge();
    render(<ChatProvider><Card initial={plan({ status: 'failed' })} /></ChatProvider>);
    const alert = within(block()).getByRole('alert');
    expect(alert).toHaveTextContent("The plan couldn't be created.");
    expect(alert.textContent).not.toMatch(/because|probably|may have/i);
    expect(within(alert).getByRole('button', { name: 'Report bug' })).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Diagnose with the assistant' })).toBeInTheDocument();
  });

  it('a failed card with a reason shows that reason, not the general line', () => {
    bridge();
    render(<ChatProvider><Card initial={plan({ status: 'failed', failure: { detail: "Plans aren't available in this conversation." } })} /></ChatProvider>);
    const alert = within(block()).getByRole('alert');
    expect(alert).toHaveTextContent("Plans aren't available in this conversation.");
    expect(alert).not.toHaveTextContent("couldn't be created");
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
    render(<ChatProvider><Card initial={paused(UNKNOWN_REASON, {}, undefined, UNKNOWN)} /></ChatProvider>);
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
    render(<ChatProvider><Card initial={paused(`${UNKNOWN_REASON} ${note}`, {}, undefined, { ...UNKNOWN, note })} /></ChatProvider>);
    expect(screen.getByTestId('plan-paused-reason')).toHaveTextContent(note);
  });

  it('the header says to check before continuing', () => {
    expect(planDisplay({}, paused(UNKNOWN_REASON, {}, undefined, UNKNOWN)).detail).toBe('paused — check before continuing');
  });
});

describe('5. an iteration-cap pause offers only Stop', () => {
  it('says the rounds ran out, suggests a revised plan, and has no Add budget or Continue', () => {
    bridge();
    render(<ChatProvider><Card initial={paused(CAP_REASON, { paused: { stepId: 'loop', reason: CAP_REASON, ...CAP } })} /></ChatProvider>);
    expect(screen.getByTestId('plan-paused-reason')).toHaveTextContent('Paused — the repeated steps ran 3 times without meeting their goal ("every auth test passes").');
    expect(screen.getByTestId('plan-paused-warning')).toHaveTextContent('To keep going, ask the assistant for a revised plan.');
    expect(buttons().filter((b) => ['Stop', 'Add budget', 'Continue'].includes(b))).toEqual(['Stop']);
    expect(planDisplay({}, paused(CAP_REASON, {}, undefined, CAP)).detail).toBe('paused — needs a revised plan');
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
    expect(plans.addBudget).toHaveBeenCalledWith(S, 'plan-1', 12500, expect.any(String));
    expect(plans.resume).toHaveBeenCalledWith(S, 'plan-1');
  });

  it('keeps saying it is working while the slow half of Add budget runs', async () => {
    // Destin, 2026-09-19: "adding budget to a specialist in a plan seems to
    // completely freeze the app". It does not freeze — Add budget is TWO host
    // calls, and the second (Continue) re-resolves the plan's manifest, which
    // opens a probe session per specialist and can take minutes. The card
    // closed its Add budget box the moment the FIRST call landed, so the whole
    // slow half was a pause strip with every button disabled and nothing
    // saying why. Disabled and silent for minutes reads as frozen.
    let releaseResume!: (v: unknown) => void;
    const resume = vi.fn().mockReturnValue(new Promise((r) => { releaseResume = r; }));
    const plans = bridge({
      addBudget: vi.fn().mockResolvedValue({ ok: true, plan: { ...budgetPause(), ceilingTokens: 54500, seq: 2 } }),
      resume,
    });
    render(<ChatProvider><Card initial={budgetPause()} /></ChatProvider>);
    fireEvent.click(within(block()).getByRole('button', { name: 'Add budget' }));
    fireEvent.click(within(screen.getByTestId('plan-add-budget')).getByRole('button', { name: 'Continue' }));
    // The first call has landed and the second is in flight.
    await waitFor(() => expect(plans.resume).toHaveBeenCalled());
    // The card must still be visibly working, not a silent row of dead buttons.
    expect(screen.getByTestId('plan-add-budget')).toBeInTheDocument();
    expect(within(screen.getByTestId('plan-add-budget')).getByRole('button', { name: 'Continuing…' })).toBeDisabled();
    releaseResume({ ok: true, plan: plan({ status: 'running', seq: 3 }) });
    await waitFor(() => expect(status()).toBe('running'));
    // And it stands down once the plan really is running.
    expect(screen.queryByTestId('plan-add-budget')).toBeNull();
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
    // 5b review: an unknown cause offers Diagnose too (error-message-standards §2).
    expect(within(alert).getByRole('button', { name: 'Diagnose with the assistant' })).toBeInTheDocument();
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
    expect(within(alert).queryByRole('button', { name: 'Diagnose with the assistant' })).toBeNull();
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
        child({ childId: 'kid-b', title: 'Idris the Reviewer', status: 'interrupted', phase: 'response-persisted', endedAt: 30_001, segments: [{ type: 'text', id: 't', content: 'reading' }] }),
        child({ childId: 'kid-c', title: 'Mara the Reviewer', status: 'interrupted', phase: 'prepared', endedAt: 1_001 }),
        // 5b follow-up: its request WAS sent, it just showed nothing yet —
        // not "Not started" (tokens may have been spent).
        child({ childId: 'kid-d', title: 'Tobin the Reviewer', status: 'interrupted', phase: 'request-sent', endedAt: 1_001 }),
        // No phase at all (an older journal): never guessed as not started.
        child({ childId: 'kid-e', title: 'Juno the Reviewer', status: 'interrupted', endedAt: 1_001 }),
      ] }],
    });
    render(<ChatProvider><Card initial={stopped} /></ChatProvider>);
    fireEvent.click(within(screen.getByTestId('plan-step-s1')).getAllByRole('button')[0]);
    const rows = screen.getAllByTestId('plan-child');
    expect(rows[2]).toHaveTextContent('Mara the ReviewerNot started');
    expect(rows[2]).not.toHaveTextContent('pick this back up');
    // Final review F27 (R28): muted, with an EMPTY circle (an outline, no fill,
    // no check or stop mark) — the same glyph a step that hasn't started wears.
    expect(within(rows[2]).getByText('Not started')).toHaveClass('text-fg-muted');
    const circle = within(rows[2]).getByLabelText('not started');
    expect(circle).toHaveClass('rounded-full', 'border');
    expect(circle.className).not.toMatch(/\bbg-/);
    expect(circle.childElementCount).toBe(0);
    expect(within(rows[1]).queryByLabelText('not started')).toBeNull();
    // A specialist that did work keeps its ordinary stopped line.
    expect(rows[1]).toHaveTextContent('Stopped after');
    expect(rows[3]).not.toHaveTextContent('Not started');
    expect(rows[3]).toHaveTextContent('Stopped after');
    expect(rows[4]).not.toHaveTextContent('Not started');
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
    // Final review F27 (R30): the whole row — its question, Yes and No, and
    // the specialist's own Note and Stop. Each control is checked where it
    // belongs: Yes/No answer THIS ask (inside its block), Note/Stop are the
    // specialist's own actions, so a button rendered anywhere on the popup no
    // longer satisfies the row.
    const askBlock = within(card).getByTestId('helper-card-ask');
    expect(askBlock).toHaveTextContent('npm test');
    for (const name of ['Yes', 'No']) {
      expect(within(askBlock).getByRole('button', { name }), name).toBeEnabled();
    }
    const actions = within(card).getByTestId('specialist-actions');
    for (const name of ['Note', 'Stop']) {
      expect(within(actions).getByRole('button', { name }), name).toBeEnabled();
    }
    // The note box is a real control, not a label: pressing Note opens it.
    fireEvent.click(within(actions).getByRole('button', { name: 'Note' }));
    expect(within(actions).getByRole('textbox')).toBeInTheDocument();
    // Task 8 (review 6, Q6-2): the working sibling is now listed too, under
    // the same plan (tests/plan-card-review-r7.test.tsx pins the grouping).
    expect(screen.getByTestId('helper-card-kid-b')).toBeInTheDocument();
  });

  it('a plan with no open ask does not say "needs you" (Task 8: it counts its working specialists instead)', () => {
    bridge();
    render(<ChatProvider><Card initial={running} /></ChatProvider>);
    expect(screen.getByTestId('specialists-chip')).toHaveTextContent('2 specialists');
    expect(screen.getByTestId('specialists-chip')).not.toHaveTextContent('needs you');
  });
});
