// @vitest-environment jsdom
/**
 * Specialists plans, Task 5a — the plan card's five buttons and the two
 * Settings calls go through the typed `window.claude.plans` bridge and land
 * ONLY what the host answered:
 *  - ok → the returned record replaces the card (PLAN_CHANGED);
 *  - a failure → its real reason is shown, nothing on the card changes;
 *  - unsupported (a phone, or a host that can't run plans) → the controls are
 *    disabled and nothing is ever tried again or shown optimistically.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React, { useEffect } from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider, useChatDispatch, useChatState } from '../src/renderer/state/chat-context';
import type { PlanView } from '../src/shared/types';
import { resetPlanSupportForTests } from '../src/renderer/components/plans/plan-bridge';
import { PlansSettings } from '../src/renderer/components/SpecialistsSection';

const S = 's1';
const CARD = 'call-plan';

function plan(over: Partial<PlanView> = {}): PlanView {
  return {
    planId: 'plan-1', toolUseId: CARD, title: 'Review two files', status: 'proposed',
    steps: [{ id: 's1', kind: 'map', title: 'Review', specialist: 'reviewer', fanOut: 2, status: 'pending' }],
    model: { label: 'm' }, seq: 1,
    ...over,
  };
}

/** The card as the app shows it: rendered from the chat store, so a landed
 *  record is visible and an unlanded one is not. */
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

const status = () => screen.getByTestId('plan-block').getAttribute('data-plan-status');

function bridge(over: Record<string, unknown> = {}) {
  const plans = {
    approve: vi.fn(), comment: vi.fn(), setLimit: vi.fn(), setStepModel: vi.fn(), resume: vi.fn(), stop: vi.fn(),
    getAutoApprove: vi.fn().mockResolvedValue({ ok: true, underUsd: 0 }),
    setAutoApprove: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  };
  (window as any).claude = { plans };
  return plans;
}

beforeEach(() => resetPlanSupportForTests());
afterEach(() => { cleanup(); delete (window as any).claude; });

describe('card actions land only what the host answered', () => {
  it('Approve sends the plan id and lands the returned record', async () => {
    const plans = bridge({ approve: vi.fn().mockResolvedValue({ ok: true, plan: plan({ status: 'running', seq: 2 }) }) });
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(status()).toBe('running'));
    expect(plans.approve).toHaveBeenCalledWith(S, 'plan-1');
  });

  it('Comment sends the trimmed note, and closes the box only when the host accepted it', async () => {
    const plans = bridge({
      comment: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: 'The conversation is busy.' })
        .mockResolvedValueOnce({ ok: true, plan: plan({ status: 'stopped', revisedBy: 'plan-2', seq: 2 }) }),
    });
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    const box = screen.getByPlaceholderText('What should change?');
    fireEvent.change(box, { target: { value: '  skip the tests  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('The conversation is busy.');
    // Refused: the note is still there to resend, and the card did not move.
    expect(screen.getByPlaceholderText('What should change?')).toHaveValue('  skip the tests  ');
    expect(status()).toBe('proposed');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(status()).toBe('stopped'));
    expect(plans.comment).toHaveBeenLastCalledWith(S, 'plan-1', 'skip the tests');
    expect(screen.queryByPlaceholderText('What should change?')).toBeNull();
  });

  // T7 (design §6/§7, decision 34/37): Add budget is gone — a plan-limit
  // pause's Continue asks for a NEW total limit, then resumes at it, as ONE
  // call (`resume(sid, planId, limit)`), never `setLimit` then a separate
  // `resume`.
  it('Continue on a spend-limit pause asks for a new limit, then resumes at it in one call; a refusal keeps the box open', async () => {
    const paused = plan({
      status: 'paused', estimate: { lowUsd: 0.4, highUsd: 2 },
      steps: [{ ...plan().steps[0], status: 'paused' }],
      paused: { stepId: 's1', reason: 'Reached your $5 limit.', kind: 'spend-limit', limit: { usd: 5 } },
    });
    const plans = bridge({
      resume: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: 'Set a limit above the $5.00 already spent.' })
        .mockResolvedValueOnce({ ok: true, plan: plan({ status: 'running', seq: 3 }) }),
    });
    render(<ChatProvider><Card initial={paused} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByLabelText('New spending limit'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Set a limit above the $5.00 already spent.');
    expect(plans.resume).toHaveBeenLastCalledWith(S, 'plan-1', { usd: 5 });
    expect(screen.getByTestId('plan-new-limit')).toBeInTheDocument();
    expect(status()).toBe('paused');
    fireEvent.change(screen.getByLabelText('New spending limit'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(status()).toBe('running'));
    expect(plans.resume).toHaveBeenLastCalledWith(S, 'plan-1', { usd: 10 });
  });

  it('Continue (interrupted) and Stop go to resume and stop', async () => {
    const interrupted = plan({ status: 'interrupted' });
    const plans = bridge({
      resume: vi.fn().mockResolvedValue({ ok: true, plan: plan({ status: 'running', seq: 2 }) }),
      stop: vi.fn().mockResolvedValue({ ok: true, plan: plan({ status: 'stopped', seq: 3 }) }),
    });
    render(<ChatProvider><Card initial={interrupted} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(status()).toBe('running'));
    expect(plans.resume).toHaveBeenCalledWith(S, 'plan-1');
    fireEvent.click(screen.getByRole('button', { name: 'Stop the plan' }));
    await waitFor(() => expect(status()).toBe('stopped'));
    expect(plans.stop).toHaveBeenCalledWith(S, 'plan-1');
  });

  it('a failure shows its reason and changes nothing', async () => {
    bridge({ approve: vi.fn().mockResolvedValue({ ok: false, error: "This plan's specialists changed since it was proposed." }) });
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText("This plan's specialists changed since it was proposed.");
    expect(status()).toBe('proposed');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('a malformed answer is a failure, never a success', async () => {
    bridge({ approve: vi.fn().mockResolvedValue({ ok: true }) });
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByTestId('plan-block').textContent).toMatch(/Couldn't update the plan/));
    expect(status()).toBe('proposed');
  });

  it('an unsupported answer disables the controls and never lands anything', async () => {
    const plans = bridge({ approve: vi.fn().mockResolvedValue({ ok: false, unsupported: true, error: "Plans aren't available on the phone." }) });
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText("Plans aren't available on the phone.");
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(plans.approve).toHaveBeenCalledTimes(1);
    expect(status()).toBe('proposed');
  });

  it('a device that cannot run plans shows the card with its controls disabled before any click', async () => {
    const plans = bridge({ getAutoApprove: vi.fn().mockResolvedValue({ ok: false, unsupported: true, error: "Plans aren't available on the phone." }) });
    render(<ChatProvider><Card initial={plan({ status: 'interrupted' })} /></ChatProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    expect(screen.getByText("Plans aren't available on the phone.")).toBeInTheDocument();
    expect(plans.resume).not.toHaveBeenCalled();
  });

  it('a card with no controls never shows the unsupported line', async () => {
    const plans = bridge({ getAutoApprove: vi.fn().mockResolvedValue({ ok: false, unsupported: true, error: "Plans aren't available on the phone." }) });
    for (const done of [plan({ status: 'completed', seq: 2 }), plan({ status: 'failed', seq: 2 }), plan({ status: 'stopped', revisedBy: 'plan-2', seq: 2 })]) {
      const { unmount } = render(<ChatProvider><Card initial={done} /></ChatProvider>);
      await waitFor(() => expect(plans.getAutoApprove).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByText("Plans aren't available on the phone.")).toBeNull();
      unmount();
    }
  });

  it('a second press while a call is out sends nothing more (double Enter)', async () => {
    let finish!: (v: unknown) => void;
    const plans = bridge({ comment: vi.fn(() => new Promise((r) => { finish = r; })) });
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    const box = screen.getByPlaceholderText('What should change?');
    fireEvent.change(box, { target: { value: 'fewer steps' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(plans.comment).toHaveBeenCalledTimes(1);
    finish({ ok: true, plan: plan({ status: 'stopped', revisedBy: 'plan-2', seq: 2 }) });
    await waitFor(() => expect(status()).toBe('stopped'));
    expect(plans.comment).toHaveBeenCalledTimes(1);
  });

  it('a bridge without plans at all is the same as unsupported, not a crash', async () => {
    (window as any).claude = {};
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled());
    expect(status()).toBe('proposed');
  });

  // Final review F10/F11: a thrown call's cause isn't known to the person (a
  // timeout may even have succeeded), so the card shows the general line with
  // Report bug and Retry; the transport's own text goes only to the report.
  it('a thrown call shows the general line and changes nothing', async () => {
    bridge({ stop: vi.fn().mockRejectedValue(new Error('The desktop stopped answering.')) });
    render(<ChatProvider><Card initial={plan({ status: 'running' })} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Stop the plan' }));
    await screen.findByText("Couldn't update the plan. Please try again.");
    expect(screen.queryByText('The desktop stopped answering.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Report bug' })).toBeInTheDocument();
    expect(status()).toBe('running');
  });
});

// Decision 34, Q-6 (spending rework, T7 design §6/§8): per-step budgets are
// gone, so "under N tokens" stopped meaning anything — this row now reads by
// the plan's own dollar ESTIMATE ("Start plans automatically … under $X"),
// and the wire carries `underUsd`, a real dollar figure, not the retired
// `underTokens`.
describe('Settings → Plans reads and writes through the normalized forms', () => {
  it('shows the saved limit, and flips only after the host saved the change', async () => {
    let resolveWrite!: (v: unknown) => void;
    const plans = bridge({
      getAutoApprove: vi.fn().mockResolvedValue({ ok: true, underUsd: 0 }),
      setAutoApprove: vi.fn(() => new Promise((r) => { resolveWrite = r; })),
    });
    render(<PlansSettings />);
    const toggle = await screen.findByRole('switch', { name: 'Start plans automatically' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(plans.setAutoApprove).toHaveBeenCalledWith(5);
    // Not optimistic: still off while the write is out.
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    resolveWrite({ ok: true });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });

  it('a refused write shows the reason and leaves the setting as it was', async () => {
    bridge({
      getAutoApprove: vi.fn().mockResolvedValue({ ok: true, underUsd: 5 }),
      // What the host answers now (final review F11): the general line, the
      // system's text only in `detail`.
      setAutoApprove: vi.fn().mockResolvedValue({ ok: false, error: "Couldn't save the plan settings. Please try again.", detail: 'ENOSPC: disk full' }),
    });
    render(<PlansSettings />);
    const toggle = await screen.findByRole('switch', { name: 'Start plans automatically' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByLabelText('Dollar amount for plans that run without asking')).toHaveValue('5');
    fireEvent.click(toggle);
    await screen.findByText("Couldn't save the plan settings. Please try again.");
    expect(screen.queryByText(/ENOSPC/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Report bug' })).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  // Decision 23: a failed read shows the default (off) with no error row
  // (plan-card-final-review.test.tsx pins it in full).
  it('a failed read shows the default, off, and says nothing', async () => {
    bridge({ getAutoApprove: vi.fn().mockResolvedValue({ ok: false, error: "Couldn't read the plan settings. Please try again.", detail: 'bad file' }) });
    render(<PlansSettings />);
    const toggle = screen.getByRole('switch', { name: 'Start plans automatically' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText(/Couldn't read/)).toBeNull();
  });

  it('a device that cannot run plans shows no Plans section at all', async () => {
    const plans = bridge({ getAutoApprove: vi.fn().mockResolvedValue({ ok: false, unsupported: true, error: "Plans aren't available on the phone." }) });
    const { container } = render(<PlansSettings />);
    await waitFor(() => expect(plans.getAutoApprove).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('an unsupported write hides the section rather than retrying', async () => {
    const plans = bridge({ setAutoApprove: vi.fn().mockResolvedValue({ ok: false, unsupported: true, error: 'nope' }) });
    const { container } = render(<PlansSettings />);
    const toggle = await screen.findByRole('switch', { name: 'Start plans automatically' });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(plans.setAutoApprove).toHaveBeenCalledTimes(1);
  });
});

describe('a plan specialist\'s ask is answered in its own row', () => {
  /** A running plan whose specialist raised an ask — delivered the way the host
   *  delivers it (stamped tool-use, then the routed ask). */
  function AskingCard() {
    const dispatch = useChatDispatch();
    useEffect(() => {
      const running = plan({
        status: 'running', seq: 2,
        steps: [{ ...plan().steps[0], status: 'running', children: [
          { childId: 'kid', parentToolCallId: CARD, agentType: 'worker', title: 'Tam the Worker', background: false, status: 'running', startedAt: 1 },
          { childId: 'sib', parentToolCallId: CARD, agentType: 'worker', title: 'Ola the Worker', background: false, status: 'running', startedAt: 1 },
        ] }],
      });
      dispatch({ type: 'SESSION_INIT', sessionId: S });
      dispatch({ type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'u', toolUseId: CARD, toolName: 'propose_plan', toolInput: {} });
      dispatch({ type: 'PLAN_CHANGED', sessionId: S, plan: running });
      dispatch({ type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'c', toolUseId: 'call_0', toolName: 'Bash', toolInput: { command: 'rm -rf build' }, timestamp: 2, parentAgentToolUseId: CARD, agentId: 'kid' });
      dispatch({ type: 'PERMISSION_REQUEST', sessionId: S, toolName: 'Bash', input: { command: 'rm -rf build' }, requestId: 'req-9', denyListed: true,
        specialist: { childId: 'kid', agentType: 'worker', title: 'Tam the Worker', parentToolCallId: CARD, plan: { planId: 'plan-1', stepId: 's1', attemptId: 'a' } } });
    }, [dispatch]);
    const tool = useChatState(S).toolCalls.get(CARD);
    return tool ? <ToolCard tool={tool} sessionId={S} /> : null;
  }

  it('opens the asking row, and its buttons answer through respondToPermission', async () => {
    bridge();
    const respond = vi.fn().mockResolvedValue(true);
    (window as any).claude.session = { respondToPermission: respond };
    render(<ChatProvider><AskingCard /></ChatProvider>);
    const ask = await screen.findByTestId('nested-ask');
    // Inside Tam's row, not Ola's.
    const rows = screen.getAllByTestId('plan-child');
    expect(rows[0]).toContainElement(ask);
    expect(rows[1].querySelector('[data-testid="nested-ask"]')).toBeNull();
    const yes = Array.from(ask.querySelectorAll('button')).find((b) => /^(Yes|Run it)/.test(b.textContent ?? ''))!;
    expect(yes).toBeTruthy();
    fireEvent.click(yes);
    await waitFor(() => expect(respond).toHaveBeenCalledWith('req-9', expect.anything()));
    await waitFor(() => expect(screen.queryByTestId('nested-ask')).toBeNull());
  });
});
