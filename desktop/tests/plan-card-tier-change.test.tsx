// @vitest-environment jsdom
/**
 * Specialists plans, Task 14 (decision 27) — the card's side of a tier change.
 *
 * When the models a plan's specialists run on change and the new worst case
 * could cost more, the host answers the press with a NOTICE instead of running
 * the plan. Nothing failed, so the card shows it the way it shows a pause — one
 * tinted strip — and never as an error. The same button, pressed again, runs it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React, { useEffect } from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider, useChatDispatch, useChatState } from '../src/renderer/state/chat-context';
import type { PlanView } from '../src/shared/types';
import { resetPlanSupportForTests } from '../src/renderer/components/plans/plan-bridge';
import { NARROW_VIEWPORT_QUERY } from '../src/renderer/hooks/use-narrow-viewport';

const S = 's1';
const CARD = 'call-plan';
const NOTICE = 'Your specialists changed. This plan could now cost up to ~$0.42, more than the ~$0.18 you approved. Press Continue again to run it at the new limit.';

function plan(over: Partial<PlanView> = {}): PlanView {
  return {
    planId: 'plan-1', toolUseId: CARD, title: 'Review two files', status: 'proposed',
    steps: [{ id: 's1', kind: 'map', title: 'Review', specialist: 'reviewer', fanOut: 2, budgetTokens: 2000, status: 'pending' }],
    ceilingTokens: 4000, ceilingUsd: null, model: { label: 'm' }, seq: 1,
    ...over,
  };
}

const paused = (): PlanView => plan({
  status: 'paused', seq: 2,
  steps: [{ id: 's1', kind: 'map', title: 'Review', specialist: 'reviewer', fanOut: 2, budgetTokens: 2000, status: 'paused' }],
  paused: { stepId: 's1', reason: 'the specialist could not start', kind: 'launch-failed', launch: 'not-ready', actions: ['continue', 'stop'] },
});

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

const interrupted = (): PlanView => plan({ status: 'interrupted', seq: 2 });

const status = () => screen.getByTestId('plan-block').getAttribute('data-plan-status');
/** The tinted strip a line belongs to. */
const stripOf = (testId: string) => screen.getByTestId(testId).closest('div.rounded-lg')!;

beforeEach(() => resetPlanSupportForTests());
afterEach(() => { cleanup(); delete (window as any).claude; delete (window as any).matchMedia; });

describe('the new-limit notice is a notice, not an error', () => {
  it('a proposed card shows it as a tinted strip above the buttons, and Approve keeps its label', async () => {
    const approveNotice = NOTICE.replace('Continue', 'Approve');
    const plans = bridge({
      approve: vi.fn()
        .mockResolvedValueOnce({ ok: false, notice: approveNotice })
        .mockResolvedValueOnce({ ok: true, plan: plan({ status: 'running', seq: 2 }) }),
    });
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const strip = await screen.findByTestId('plan-limit-notice');
    expect(strip).toHaveTextContent(approveNotice);
    // Never ErrorState: no alert, no Retry, no red dot — nothing failed.
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    // A tinted warn strip, the shape the pause row already uses.
    expect(strip.closest('div.rounded-lg')?.className ?? '').toContain('bg-amber-500/10');
    // The plan did not start and the button is the same button.
    expect(status()).toBe('proposed');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(status()).toBe('running'));
    // It disappears once the plan runs.
    expect(screen.queryByTestId('plan-limit-notice')).toBeNull();
    expect(plans.approve).toHaveBeenCalledTimes(2);
  });

  it('a paused card shows it as a line inside the pause strip, and Continue keeps its label', async () => {
    bridge({
      resume: vi.fn()
        .mockResolvedValueOnce({ ok: false, notice: NOTICE })
        .mockResolvedValueOnce({ ok: true, plan: plan({ status: 'running', seq: 3 }) }),
    });
    render(<ChatProvider><Card initial={paused()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const line = await screen.findByTestId('plan-limit-notice');
    expect(line).toHaveTextContent(NOTICE);
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    // The SAME strip as the paused reason — one block, not a second one.
    const strip = line.closest('div.rounded-lg');
    expect(strip).not.toBeNull();
    expect(strip).toContainElement(screen.getByTestId('plan-paused-reason'));
    expect(strip!.className).toContain('bg-amber-500/10');
    expect(status()).toBe('paused');

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(status()).toBe('running'));
    expect(screen.queryByTestId('plan-limit-notice')).toBeNull();
  });

  // Review finding 8: the amber flip had no test, so `tone="idle"` could come
  // back with the whole suite green.
  it('an interrupted card is grey while it waits and amber only while the question is showing', async () => {
    bridge({ resume: vi.fn().mockResolvedValueOnce({ ok: false, notice: NOTICE }) });
    render(<ChatProvider><Card initial={interrupted()} /></ChatProvider>);
    // Waiting for Continue is not a warning: grey.
    expect(stripOf('plan-interrupted-note').className).toContain('bg-inset');
    expect(stripOf('plan-interrupted-note').className).not.toContain('bg-amber-500/10');

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByTestId('plan-limit-notice');
    // A question that needs an answer: amber, and in the same one strip.
    expect(stripOf('plan-interrupted-note').className).toContain('bg-amber-500/10');
    expect(stripOf('plan-limit-notice')).toBe(stripOf('plan-interrupted-note'));
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });
});

/**
 * Review finding 14. jsdom has NO layout engine, so none of this proves a pixel
 * — it proves that nothing in the card forbids the text from wrapping and the
 * buttons from moving below it, which is what 390 px needs. The card's other
 * suites judge narrow width the same way.
 */
describe('narrow widths (390 px): the question wraps instead of crushing the buttons', () => {
  // narrow-viewport rule: a test of a viewport-branching component declares the
  // viewport (jsdom has no matchMedia, which reads as wide).
  const narrow = () => {
    window.matchMedia = ((q: string) => ({
      matches: q === NARROW_VIEWPORT_QUERY, media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as any;
  };
  const wrappable = (el: Element) => {
    const cls = el.className.split(/\s+/);
    expect(cls).not.toContain('truncate');
    expect(cls).not.toContain('whitespace-nowrap');
  };

  it('a proposed card gives the question a strip of its own, with no button on its row', async () => {
    narrow();
    bridge({ approve: vi.fn().mockResolvedValueOnce({ ok: false, notice: NOTICE.replace('Continue', 'Approve') }) });
    render(<ChatProvider><Card initial={plan()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const line = await screen.findByTestId('plan-limit-notice');
    wrappable(line);
    // Its own strip: the Approve row is a different block entirely.
    expect(stripOf('plan-limit-notice').querySelector('button')).toBeNull();
  });

  it('a paused card lets its buttons drop below the reason and the question', async () => {
    narrow();
    bridge({ resume: vi.fn().mockResolvedValueOnce({ ok: false, notice: NOTICE }) });
    render(<ChatProvider><Card initial={paused()} /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const line = await screen.findByTestId('plan-limit-notice');
    wrappable(line);
    expect(stripOf('plan-limit-notice').className.split(/\s+/)).toContain('flex-wrap');
    expect(screen.getByTestId('plan-pause-actions').className.split(/\s+/)).toEqual(expect.arrayContaining(['flex-wrap', 'ml-auto']));
  });

  it('an interrupted card lets its buttons drop below the question too', async () => {
    narrow();
    bridge({ resume: vi.fn().mockResolvedValueOnce({ ok: false, notice: NOTICE }) });
    render(<ChatProvider><Card initial={interrupted()} /></ChatProvider>);
    const before = stripOf('plan-interrupted-note').className.split(/\s+/);
    // Unchanged while it is only waiting: one row, exactly as signed off.
    expect(before).not.toContain('flex-wrap');

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const line = await screen.findByTestId('plan-limit-notice');
    wrappable(line);
    // With ~130 characters of question added, Stop and Continue must be able to
    // move below it rather than squeeze it into a column of single words.
    expect(stripOf('plan-limit-notice').className.split(/\s+/)).toContain('flex-wrap');
    expect(screen.getByTestId('plan-interrupted-actions').className.split(/\s+/)).toContain('ml-auto');
  });
});
