// @vitest-environment jsdom
/**
 * Specialists plans — the plan card and Settings fixes from the final code
 * review (docs/active/reviews/2026-09-17-specialists-plans-code-review.md in
 * the workspace). One describe per finding, named by its number.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor, within, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React, { useEffect } from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider, useChatDispatch, useChatState } from '../src/renderer/state/chat-context';
import type { PlanView } from '../src/shared/types';
import { planAction, resetPlanSupportForTests, PLAN_UNREADABLE } from '../src/renderer/components/plans/plan-bridge';
import { planStatusPhrase } from '../src/renderer/components/plans/plan-status';
import { PlansSettings } from '../src/renderer/components/SpecialistsSection';
import { REMOTE_HOST_CHANGED_EVENT, REMOTE_NOT_SENT } from '../src/renderer/remote-unsupported';
import { NARROW_VIEWPORT_QUERY } from '../src/renderer/hooks/use-narrow-viewport';
import { previewSessionKey } from '../src/shared/chatsearch-refs';

// The report screen, reduced to what it was handed (the real one only shows
// the error text inside a collapsed "details" section).
vi.mock('../src/renderer/components/development/BugReportPopup', () => ({
  BugReportPopup: ({ open, context }: { open: boolean; context?: { error?: string } }) =>
    (open ? <div role="dialog">{context?.error}</div> : null),
}));

const S = 's1';
const CARD = 'call-plan';

function plan(over: Partial<PlanView> = {}): PlanView {
  return {
    planId: 'plan-1', toolUseId: CARD, title: 'Review two files', status: 'proposed',
    steps: [{ id: 's1', kind: 'map', title: 'Review', specialist: 'reviewer', fanOut: 2, budgetTokens: 2000, status: 'pending' }],
    ceilingTokens: 4000, ceilingUsd: null, model: { label: 'm' }, seq: 1,
    ...over,
  };
}
const paused = (over: Partial<PlanView> = {}) => plan({
  status: 'paused', steps: [{ ...plan().steps[0], status: 'paused' }],
  paused: { stepId: 's1', reason: 'step 1 hit its limit.', kind: 'budget', actions: ['add_budget', 'stop'] }, ...over,
});

/** The card as the app shows it, from the chat store (a push lands through PLAN_CHANGED). */
let push: (p: PlanView) => void = () => {};
const NO_INPUT: Record<string, unknown> = {};
function Card({ initial, sessionId = S, input = NO_INPUT }: { initial: PlanView; sessionId?: string; input?: Record<string, unknown> }) {
  const dispatch = useChatDispatch();
  useEffect(() => {
    dispatch({ type: 'SESSION_INIT', sessionId });
    dispatch({ type: 'TRANSCRIPT_TOOL_USE', sessionId, uuid: 'u', toolUseId: CARD, toolName: 'propose_plan', toolInput: input });
    dispatch({ type: 'PLAN_CHANGED', sessionId, plan: initial });
  }, [dispatch, initial, sessionId, input]);
  push = (p) => dispatch({ type: 'PLAN_CHANGED', sessionId, plan: p });
  const tool = useChatState(sessionId).toolCalls.get(CARD);
  return tool ? <ToolCard tool={tool} sessionId={sessionId} /> : null;
}
const status = () => screen.getByTestId('plan-block').getAttribute('data-plan-status');

function bridge(over: Record<string, unknown> = {}) {
  const plans = {
    approve: vi.fn(), comment: vi.fn(), addBudget: vi.fn(), resume: vi.fn(), stop: vi.fn(), askAssistant: vi.fn(),
    getAutoApprove: vi.fn().mockResolvedValue({ ok: true, underTokens: 0 }),
    setAutoApprove: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  };
  (window as any).claude = { plans };
  return plans;
}

beforeEach(() => resetPlanSupportForTests());
afterEach(() => { cleanup(); delete (window as any).claude; delete (window as any).matchMedia; });

describe('F1: Add budget is safe to repeat', () => {
  it('Retry after a lost reply sends the SAME request id; a new pause gets a new one', async () => {
    const plans = bridge({
      addBudget: vi.fn()
        .mockRejectedValueOnce(new Error('Request plans:add-budget timed out'))
        .mockResolvedValue({ ok: true, plan: paused({ seq: 2, paused: undefined, status: 'paused' }) }),
      resume: vi.fn().mockResolvedValue({ ok: true, plan: plan({ status: 'running', seq: 3 }) }),
    });
    render(<ChatProvider><Card initial={paused()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // A timeout is an unknown outcome: the general line, with Report bug and Retry.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(PLAN_UNREADABLE);
    expect(alert).not.toHaveTextContent('plans:add-budget');
    expect(within(alert).getByRole('button', { name: 'Report bug' })).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(status()).toBe('running'));
    const [first, second] = plans.addBudget.mock.calls;
    expect(typeof first[3]).toBe('string');
    expect(second[3]).toBe(first[3]);
    // The next pause: a fresh id.
    act(() => push(paused({ seq: 4 })));
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(plans.addBudget).toHaveBeenCalledTimes(3));
    expect(plans.addBudget.mock.calls[2][3]).not.toBe(first[3]);
  });

  it('a second press of Add budget on the same pause reuses the id', async () => {
    const plans = bridge({
      addBudget: vi.fn().mockResolvedValue({ ok: true, plan: paused({ seq: 2 }) }),
      resume: vi.fn().mockResolvedValue({ ok: false, error: 'This plan is being run by another YouCoded window.' }),
    });
    render(<ChatProvider><Card initial={paused()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('This plan is being run by another YouCoded window.');
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(plans.addBudget).toHaveBeenCalledTimes(2));
    expect(plans.addBudget.mock.calls[1][3]).toBe(plans.addBudget.mock.calls[0][3]);
  });
});

describe('F5: a plan button pressed while the phone is reconnecting', () => {
  it('says nothing was sent, with Retry, instead of the general line', async () => {
    bridge({ approve: vi.fn().mockRejectedValue(new Error(REMOTE_NOT_SENT)) });
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(REMOTE_NOT_SENT);
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('F6: every failed card explains itself', () => {
  it('a failed card with no known reason says so generally, with Report bug and Diagnose', () => {
    bridge();
    render(<ChatProvider><Card initial={plan({ status: 'failed' })} /></ChatProvider>);
    const alert = within(screen.getByTestId('plan-block')).getByRole('alert');
    expect(alert).toHaveTextContent("The plan couldn't be created.");
    expect(within(alert).getByRole('button', { name: 'Report bug' })).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Diagnose with the assistant' })).toBeInTheDocument();
  });
});

describe('F8: step titles wrap on a narrow window', () => {
  it('the narrow row lets a long title wrap instead of cutting it off', () => {
    window.matchMedia = ((q: string) => ({ matches: q === NARROW_VIEWPORT_QUERY, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as any;
    bridge();
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    const title = screen.getByTestId('plan-step-title');
    expect(title.className).not.toMatch(/\btruncate\b/);
    expect(title.className).toMatch(/\bbreak-words\b/);
    expect(title.className).toMatch(/\bmin-w-0\b/);
  });
});

describe('F9: a cached "unsupported" is forgotten when the host changes', () => {
  it('a card on screen asks again when the shim switches hosts', async () => {
    const plans = bridge({ getAutoApprove: vi.fn().mockResolvedValueOnce({ ok: false, unsupported: true, error: "Plans aren't available on the phone yet." }).mockResolvedValue({ ok: true, underTokens: 0 }) });
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled());
    act(() => { window.dispatchEvent(new CustomEvent(REMOTE_HOST_CHANGED_EVENT)); });
    await waitFor(() => expect(plans.getAutoApprove).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled());
    expect(screen.queryByText("Plans aren't available on the phone yet.")).toBeNull();
  });
});

describe('F10/F11: no channel ids or system text on the card', () => {
  it('an older desktop\'s "not over remote access (plans:…)" answer shows the plain line', async () => {
    bridge({ getAutoApprove: vi.fn().mockResolvedValue({ ok: false, unsupported: true, error: "This feature isn't available over remote access yet (plans:get-auto-approve)." }) });
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled());
    expect(screen.getByTestId('plan-block')).not.toHaveTextContent('plans:');
    expect(screen.getByTestId('plan-block')).toHaveTextContent("Plans aren't available here.");
  });

  it('a thrown call keeps its text for the bug report only', async () => {
    (window as any).claude = { plans: { approve: vi.fn().mockRejectedValue(new Error('EACCES: permission denied')) } };
    const r = await planAction((b) => b.approve('s', 'p'));
    expect(r).toEqual({ ok: false, error: PLAN_UNREADABLE, detail: 'EACCES: permission denied' });
  });

  it('a host failure\'s detail goes to the report screen, not the card', async () => {
    bridge({ approve: vi.fn().mockResolvedValue({ ok: false, error: PLAN_UNREADABLE, detail: 'EIO: disk' }) });
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('EIO');
    fireEvent.click(within(alert).getByRole('button', { name: 'Report bug' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('EIO: disk');
  });
});

describe('F12/F13: Settings → Plans', () => {
  it('a failed read offers Retry, which reads again and enables the switch', async () => {
    const plans = bridge({ getAutoApprove: vi.fn().mockResolvedValueOnce({ ok: false, error: "Couldn't read the plan settings. Please try again." }).mockResolvedValue({ ok: true, underTokens: 0 }) });
    render(<PlansSettings />);
    const alert = await screen.findByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Run small plans without asking' })).toBeEnabled());
    expect(plans.getAutoApprove).toHaveBeenCalledTimes(2);
  });

  it('a click during a save is not lost or raced: one write at a time, the last choice wins', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    const plans = bridge({ setAutoApprove: vi.fn(() => new Promise((r) => { resolvers.push(r); })) });
    render(<PlansSettings />);
    const toggle = await screen.findByRole('switch', { name: 'Run small plans without asking' });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);                                  // on → write 20000
    expect(plans.setAutoApprove).toHaveBeenCalledTimes(1);
    expect(toggle).toBeDisabled();                            // no second write while one is out
    await act(async () => { resolvers[0]({ ok: true }); });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    const field = screen.getByLabelText('Token limit for plans that run without asking');
    fireEvent.change(field, { target: { value: '9000' } });
    fireEvent.blur(field);                                    // write 9000
    fireEvent.click(toggle);                                  // queued: off
    expect(plans.setAutoApprove).toHaveBeenCalledTimes(2);
    await act(async () => { resolvers[1]({ ok: true }); });
    await waitFor(() => expect(plans.setAutoApprove).toHaveBeenCalledTimes(3));
    expect(plans.setAutoApprove).toHaveBeenLastCalledWith(0);
    await act(async () => { resolvers[2]({ ok: true }); });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
  });

  it('the setting says "limit", like the card', async () => {
    bridge();
    render(<PlansSettings />);
    await screen.findByRole('switch', { name: 'Run small plans without asking' });
    expect(screen.getByTestId('plans-auto-approve')).not.toHaveTextContent('ceiling');
    expect(screen.getByTestId('plans-auto-approve')).toHaveTextContent('limit');
  });
});

describe('F14: Retry sends what is on the card now', () => {
  it('a note edited after a failed Send is the note Retry sends', async () => {
    const plans = bridge({ comment: vi.fn().mockResolvedValueOnce({ ok: false, error: 'The conversation is busy.' }).mockResolvedValue({ ok: true, plan: plan({ status: 'stopped', revisedBy: 'x', seq: 2 }) }) });
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    const box = screen.getByPlaceholderText('What should change?');
    fireEvent.change(box, { target: { value: 'first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const alert = await screen.findByRole('alert');
    fireEvent.change(box, { target: { value: 'second thoughts' } });
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(plans.comment).toHaveBeenCalledTimes(2));
    expect(plans.comment).toHaveBeenLastCalledWith(S, 'plan-1', 'second thoughts');
  });
});

describe('F15: an old error does not outlive the state it was about', () => {
  it('a failed Stop, then a push that shows the plan finished, clears the error and its Retry', async () => {
    const plans = bridge({ stop: vi.fn().mockResolvedValue({ ok: false, error: 'This plan is running in another YouCoded window. Stop it there.' }) });
    render(<ChatProvider><Card initial={plan({ status: 'running' })} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Stop the plan' }));
    await screen.findByRole('alert');
    act(() => push(plan({ status: 'completed', seq: 5 })));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(plans.stop).toHaveBeenCalledTimes(1);
  });
});

describe('F16: boxes do not reopen on the next pause', () => {
  it('an open Add budget field closes when the plan resumes elsewhere, and the next pause shows its buttons', async () => {
    bridge();
    render(<ChatProvider><Card initial={paused()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }));
    fireEvent.change(screen.getByLabelText('Tokens to allow'), { target: { value: '777' } });
    act(() => push(plan({ status: 'running', seq: 2 })));
    act(() => push(paused({ seq: 3, paused: { stepId: 's1', reason: 'again', kind: 'budget', actions: ['add_budget', 'stop'] } })));
    expect(screen.queryByTestId('plan-add-budget')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add budget' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }));
    expect(screen.getByLabelText('Tokens to allow')).not.toHaveValue('777');
  });

  it('an open question box closes when the plan leaves the pause', async () => {
    bridge();
    render(<ChatProvider><Card initial={paused()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Ask the assistant' }));
    fireEvent.change(screen.getByPlaceholderText('What would you like to ask? (optional)'), { target: { value: 'old' } });
    act(() => push(plan({ status: 'running', seq: 2 })));
    act(() => push(paused({ seq: 3 })));
    expect(screen.queryByTestId('plan-ask-box')).toBeNull();
    expect(screen.getByRole('button', { name: 'Ask the assistant' })).toBeInTheDocument();
  });
});

const GOAL_INPUT = { goal: 'Tidy the docs' };
describe('F18/F19/F20: the writing header', () => {
  const writing = (over: Partial<PlanView> = {}) => plan({ status: 'writing', title: '', steps: [], ceilingTokens: 0, seq: 0, ...over });

  it('the clock counts from when writing began', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    bridge();
    render(<ChatProvider><Card initial={writing({ startedAt: 1_000_000 - 75_000 })} /></ChatProvider>);
    expect(screen.getByTestId('plan-writing')).toHaveTextContent('1m 15s');
  });

  it('only a plan written on this computer says it can take a few minutes', () => {
    bridge();
    const { unmount } = render(<ChatProvider><Card initial={writing()} /></ChatProvider>);
    expect(screen.getByTestId('plan-writing')).not.toHaveTextContent('on your computer');
    unmount();
    render(<ChatProvider><Card initial={writing({ model: { label: 'qwen', local: true } })} /></ChatProvider>);
    expect(screen.getByTestId('plan-writing')).toHaveTextContent('can take a few minutes on your computer');
  });

  it('writing, failed and stopped cards name the plan from its goal', () => {
    bridge();
    render(<ChatProvider><Card initial={writing()} input={GOAL_INPUT} /></ChatProvider>);
    expect(screen.getByText('Plan: Tidy the docs')).toBeInTheDocument();
  });
});

describe('F21: a proposal stopped before it was written', () => {
  it('reads "stopped" with no step count, and draws no empty body', () => {
    const stopped = plan({ status: 'stopped', steps: [], ceilingTokens: 0, title: '' });
    expect(planStatusPhrase(stopped)).toBe('stopped');
    bridge();
    render(<ChatProvider><Card initial={stopped} /></ChatProvider>);
    expect(screen.queryByTestId('plan-block')).toBeNull();
    expect(screen.queryByText(/0 of 0/)).toBeNull();
  });
});

describe('F22/F23: dollar wording', () => {
  it('a limit under a cent never reads "about less than a cent"', () => {
    bridge();
    render(<ChatProvider><Card initial={plan({ ceilingUsd: 0.001 })} /></ChatProvider>);
    const line = screen.getByTestId('plan-ceiling');
    expect(line).toHaveTextContent('Up to less than a cent (4,000 tokens)');
    expect(line).not.toHaveTextContent(/about less|~less/);
  });

  it('a running plan under a cent never reads "the less than a cent limit"', () => {
    bridge();
    render(<ChatProvider><Card initial={plan({ status: 'running', ceilingUsd: 0.001, usedUsd: 0.0001, usedTokens: 100, approximateLimit: true })} /></ChatProvider>);
    const line = screen.getByTestId('plan-ceiling');
    expect(line).not.toHaveTextContent(/less than a cent limit|~less/);
    expect(line).toHaveTextContent('Spent less than a cent (100 tokens) of a limit under one cent (~4,000 tokens)');
  });

  it('the Add budget price wears a tilde on an approximate plan', () => {
    bridge();
    render(<ChatProvider><Card initial={paused({ ceilingUsd: 0.4, approximateLimit: true })} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }));
    expect(screen.getByTestId('plan-add-budget')).toHaveTextContent('tokens (~$0.20)');
  });
});

describe('F24/F26: step figures', () => {
  it('"up to" includes each specialist\'s setup cost, and the limit sentence matches', () => {
    bridge();
    render(<ChatProvider><Card initial={plan({ steps: [{ ...plan().steps[0], setupTokens: 500 }], ceilingTokens: 5000 })} /></ChatProvider>);
    expect(screen.getByTestId('plan-step-s1')).toHaveTextContent('up to 5,000 tokens');
    fireEvent.click(within(screen.getByTestId('plan-step-s1')).getByRole('button'));
    expect(screen.getByTestId('plan-step-s1')).toHaveTextContent('Each reviewer stops at its 2,500-token limit.');
  });

  it('one specialist is singular', () => {
    bridge();
    render(<ChatProvider><Card initial={plan({ status: 'running', steps: [{ ...plan().steps[0], fanOut: 1, status: 'running', done: 0, usedTokens: 0 }] })} /></ChatProvider>);
    expect(screen.getByTestId('plan-step-s1')).toHaveTextContent('0 of 1 reviewer done');
  });
});

describe('F25: plan cards in a conversation preview are read-only', () => {
  it.each([
    ['proposed', plan()],
    ['paused', paused()],
    ['interrupted', plan({ status: 'interrupted' })],
    ['running', plan({ status: 'running' })],
  ] as const)('a %s card shows no action buttons', (_label, p) => {
    const plans = bridge();
    render(<ChatProvider><Card initial={p} sessionId={previewSessionKey('conv-1')} /></ChatProvider>);
    const block = screen.getByTestId('plan-block');
    for (const name of ['Approve', 'Comment', 'Add budget', 'Continue', 'Stop', 'Stop the plan', 'Ask the assistant']) {
      expect(within(block).queryByRole('button', { name })).toBeNull();
    }
    expect(plans.getAutoApprove).not.toHaveBeenCalled();
  });
});

// Task 12 review fix 2: a plan whose progress couldn't be saved pauses with a
// general line on the card; the system's own text (an EIO, say) goes only to
// the report screen (docs/error-message-standards.md).
describe('review fix 2: an unsaved-progress pause keeps the system text for the report', () => {
  const GENERAL = "The plan stopped because its progress couldn't be saved.";
  const orphanPause = () => paused({
    paused: { stepId: 's1', reason: GENERAL, kind: 'unexpected-error', actions: ['continue', 'stop'], report: 'EIO: i/o error, write' },
  });

  it('the card shows the general line, and Report bug hands over the system text', async () => {
    bridge();
    render(<ChatProvider><Card initial={orphanPause()} /></ChatProvider>);
    const block = screen.getByTestId('plan-block');
    expect(within(block).getByTestId('plan-paused-reason')).toHaveTextContent(GENERAL);
    expect(block).not.toHaveTextContent('EIO');
    const alert = within(block).getByTestId('plan-paused-report');
    fireEvent.click(within(alert).getByRole('button', { name: 'Report bug' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(GENERAL);
    expect(dialog).toHaveTextContent('EIO: i/o error, write');
    expect(within(alert).getByRole('button', { name: 'Diagnose with the assistant' })).toBeInTheDocument();
  });

  it('an ordinary pause shows no report actions', () => {
    bridge();
    render(<ChatProvider><Card initial={paused()} /></ChatProvider>);
    expect(screen.queryByTestId('plan-paused-report')).toBeNull();
  });
});
