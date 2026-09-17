// @vitest-environment jsdom
/**
 * Specialists plans, Task 11 — the plan card's "Ask the assistant" button
 * (pause handoff design §6, revision 4; review 4 findings in brackets).
 *
 * Destin, after review deck 7: no automatic handing off — a button instead.
 * Every paused card (all kinds, the user-stopped one included) shows its
 * reason and default buttons at once, plus Ask as the light button on the
 * far left (design guide G-29). A restart-interrupted card is unchanged. The
 * card greys while the assistant looks, says when the question waits behind a
 * reply, and shows an error line with Retry when a question was cleared
 * without an answer.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, within, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React, { useEffect } from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider, useChatDispatch, useChatState } from '../src/renderer/state/chat-context';
import type { PlanView } from '../src/shared/types';
import { resetPlanSupportForTests } from '../src/renderer/components/plans/plan-bridge';
import { planDisplay } from '../src/renderer/components/plans/PlanCard';
import { NARROW_VIEWPORT_QUERY } from '../src/renderer/hooks/use-narrow-viewport';
import { PLAN_HANDOFF_BACKSTOP_MS } from '../src/main/harness/plans/plan-handoff';

const S = 's1';
const CARD = 'call-plan';
const ASK = 'Ask the assistant';

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
const show = (plan: PlanView) => render(<ChatProvider><Card initial={plan} /></ChatProvider>);

const block = () => screen.getByTestId('plan-block');
/** The card's action buttons, left to right (row toggles excluded). */
const buttons = () => within(block()).queryAllByRole('button')
  .filter((b) => !b.hasAttribute('aria-expanded'))
  .map((b) => (b.textContent ?? '').trim()).filter(Boolean);
let api: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  resetPlanSupportForTests();
  api = {
    approve: vi.fn(), comment: vi.fn(), resume: vi.fn(), stop: vi.fn(), addBudget: vi.fn(),
    askAssistant: vi.fn(async () => ({ ok: true, plan: paused({ handoff: { state: 'pending' } }, { seq: 5 }) })),
    getAutoApprove: vi.fn().mockResolvedValue({ ok: true, underTokens: 0 }),
    setAutoApprove: vi.fn().mockResolvedValue({ ok: true }),
  };
  (window as any).claude = { plans: api };
});
afterEach(() => { cleanup(); delete (window as any).claude; });

describe('every paused card offers Ask, as the light button on the far left (§6)', () => {
  it.each([
    ['a budget kind', paused(), [ASK, 'Stop', 'Add budget']],
    ['a Stop-only kind', paused({ kind: 'iteration-cap', actions: ['stop'], minimumAddTokens: undefined, repeat: { rounds: 3, until: 'tests pass' } }), [ASK, 'Stop']],
    ['the user-stopped state', paused({ kind: 'specialist-stopped', actions: ['continue', 'stop'], minimumAddTokens: undefined }), [ASK, 'Stop', 'Continue']],
    ['an answered question with no recommendation', paused({ handoff: { state: 'answered' } }), [ASK, 'Stop', 'Add budget']],
    ['a recommendation (asking again replaces it)', paused({ handoff: { state: 'answered', recommendation: { action: 'add_budget', addTokens: 3000, message: 'm' } } }), [ASK, 'Stop', 'Add budget']],
    ['a record from before `actions`', paused({ actions: undefined }), [ASK, 'Stop', 'Add budget']],
  ])('%s', (_what, plan, shown) => {
    show(plan);
    expect(buttons()).toEqual(shown);
    const ask = screen.getByRole('button', { name: ASK });
    // Light (G-29): never the filled accent button.
    expect(ask.className.split(/\s+/)).not.toContain('bg-accent');
    // The reason is still there, at once.
    expect(screen.getByTestId('plan-paused-reason')).toBeInTheDocument();
    expect(block()).not.toHaveClass('opacity-60');
  });

  it('a restart-interrupted card is unchanged: Stop · Continue, no Ask (review 4-1)', () => {
    show(paused({}, { status: 'interrupted', paused: undefined }));
    expect(buttons()).toEqual(['Stop', 'Continue']);
  });

  it('is hidden when the conversation\'s model cannot use tools (review 4-9)', () => {
    show(paused({ askUnavailable: true }));
    expect(buttons()).toEqual(['Stop', 'Add budget']);
  });

  it('is not offered while a question is pending (§6)', () => {
    show(paused({ handoff: { state: 'pending' } }));
    expect(buttons()).toEqual([]);
  });

  it('is not offered on a running, proposed, finished or stopped card', () => {
    for (const status of ['running', 'proposed', 'completed', 'stopped'] as const) {
      cleanup();
      show(paused({}, { status, paused: undefined }));
      expect(screen.queryByRole('button', { name: ASK })).toBeNull();
    }
  });
});

describe('pressing Ask', () => {
  it('sends one request for this plan and lands the greyed card the host returned', async () => {
    show(paused());
    fireEvent.click(screen.getByRole('button', { name: ASK }));
    await waitFor(() => expect(screen.getByTestId('plan-handoff-pending')).toHaveTextContent('The assistant is looking into this.'));
    expect(api.askAssistant).toHaveBeenCalledTimes(1);
    expect(api.askAssistant).toHaveBeenCalledWith(S, 'plan-1');
    expect(block()).toHaveClass('opacity-60');
    expect(buttons()).toEqual([]);
  });

  it('ignores more clicks while its request is in flight (review 4-3)', async () => {
    let finish!: (v: unknown) => void;
    api.askAssistant.mockImplementation(() => new Promise((r) => { finish = r; }));
    show(paused());
    const ask = screen.getByRole('button', { name: ASK });
    fireEvent.click(ask);
    fireEvent.click(ask);
    fireEvent.click(ask);
    expect(api.askAssistant).toHaveBeenCalledTimes(1);
    expect(ask).toHaveTextContent('Asking…');
    await act(async () => { finish({ ok: true, plan: paused({ handoff: { state: 'pending' } }, { seq: 5 }) }); });
    expect(api.askAssistant).toHaveBeenCalledTimes(1);
  });

  it('a refusal shows the host\'s reason with Retry, and Retry asks again', async () => {
    api.askAssistant.mockResolvedValueOnce({ ok: false, error: 'You stopped this conversation. Send the assistant a message, then ask again.' });
    show(paused());
    fireEvent.click(screen.getByRole('button', { name: ASK }));
    await waitFor(() => expect(block()).toHaveTextContent('You stopped this conversation. Send the assistant a message, then ask again.'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.askAssistant).toHaveBeenCalledTimes(2));
  });
});

describe('while the assistant has the question (§6)', () => {
  it('delivered: greyed, no buttons, "The assistant is looking into this."', () => {
    show(paused({ handoff: { state: 'pending' } }));
    expect(block()).toHaveClass('opacity-60');
    expect(screen.getByTestId('plan-handoff-pending')).toHaveTextContent('The assistant is looking into this.');
    expect(planDisplay({}, paused({ handoff: { state: 'pending' } })).detail).toBe('paused — the assistant is looking into this');
  });

  it('behind a reply in progress: "The assistant will look at this after its current reply." (review 4-5)', () => {
    show(paused({ handoff: { state: 'pending', waiting: 'reply' } }));
    expect(block()).toHaveClass('opacity-60');
    expect(screen.getByTestId('plan-handoff-pending')).toHaveTextContent('The assistant will look at this after its current reply.');
    expect(buttons()).toEqual([]);
    expect(planDisplay({}, paused({ handoff: { state: 'pending', waiting: 'reply' } })).detail).toBe('paused — waiting for the assistant');
  });
});

describe('a question cleared without an answer shows an error line with Retry (§6, review 4-5/4-10)', () => {
  it('not started within 10 minutes', async () => {
    show(paused({ handoff: { state: 'answered', problem: { kind: 'no-start' } } }));
    const line = screen.getByTestId('plan-ask-error');
    expect(line).toHaveTextContent("The assistant didn't get to your question within 10 minutes.");
    // Retry is the ask; the default buttons stay, Ask itself does not repeat.
    expect(buttons()).toEqual(['Stop', 'Add budget', 'Retry']);
    fireEvent.click(within(line).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.askAssistant).toHaveBeenCalledWith(S, 'plan-1'));
    await waitFor(() => expect(screen.queryByTestId('plan-ask-error')).toBeNull());
  });

  it('a failed reply names the real error', () => {
    show(paused({ handoff: { state: 'answered', problem: { kind: 'reply-failed', detail: 'The provider returned an error (529: overloaded).' } } }));
    const line = screen.getByTestId('plan-ask-error');
    expect(line).toHaveTextContent("The assistant couldn't answer your question: The provider returned an error (529: overloaded).");
    expect(within(line).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(line).queryByRole('button', { name: /report/i })).toBeNull();
  });

  it('a failed reply with no known cause names none, and also offers Report bug and Diagnose', () => {
    show(paused({ handoff: { state: 'answered', problem: { kind: 'reply-failed' } } }));
    const line = screen.getByTestId('plan-ask-error');
    expect(line).toHaveTextContent("The assistant couldn't answer your question.");
    const names = within(line).getAllByRole('button').map((b) => (b.textContent ?? '').trim());
    expect(names).toContain('Retry');
    expect(names.some((n) => /report/i.test(n))).toBe(true);
    expect(names.some((n) => /diagnose/i.test(n))).toBe(true);
    // Retry is last (error-message standards).
    expect(names[names.length - 1]).toBe('Retry');
  });

  it('while another action\'s error shows, the ask error line hides and Ask comes back (review of Task 11, finding 3)', async () => {
    api.stop.mockResolvedValueOnce({ ok: false, error: 'This plan is running in another YouCoded window. Stop it there.' });
    show(paused({ handoff: { state: 'answered', problem: { kind: 'no-start' } } }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(block()).toHaveTextContent('Stop it there.'));
    expect(screen.queryByTestId('plan-ask-error')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: ASK }));
    await waitFor(() => expect(api.askAssistant).toHaveBeenCalledWith(S, 'plan-1'));
  });

  it('a recommendation that arrived first is kept, with no error line', () => {
    show(paused({ handoff: { state: 'answered', recommendation: { action: 'stop', message: 'stop it' } } }));
    expect(screen.queryByTestId('plan-ask-error')).toBeNull();
  });
});

describe('narrow widths (390 px): the card wraps instead of crushing its text', () => {
  // narrow-viewport rule: a test of a viewport-branching component declares
  // the viewport (jsdom has no matchMedia, which reads as wide).
  const viewport = (narrow: boolean) => {
    window.matchMedia = ((q: string) => ({
      matches: narrow && q === NARROW_VIEWPORT_QUERY, media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as any;
  };
  afterEach(() => { delete (window as any).matchMedia; });

  it('the paused strip lets its buttons wrap below the reason (any width; it only wraps when out of room)', () => {
    viewport(false);
    show(paused());
    const actions = screen.getByTestId('plan-pause-actions');
    expect(actions.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex-wrap', 'ml-auto', 'justify-end']));
    const strip = actions.parentElement!;
    expect(strip.className.split(/\s+/)).toContain('flex-wrap');
  });

  it('narrow: a step row puts its title on the first line and the details on a second', () => {
    viewport(true);
    show(paused());
    const row = within(screen.getByTestId('plan-step-s2')).getAllByRole('button')[0];
    expect(row.className.split(/\s+/)).toContain('flex-col');
    const [first, second] = Array.from(row.children) as HTMLElement[];
    expect(within(first).getByTestId('plan-step-title')).toHaveTextContent('Combine');
    expect(first.textContent).not.toContain('worker');
    expect(second).toHaveTextContent('1 worker · combines the results');
    expect(second).toHaveTextContent('up to 4,000 tokens');
  });

  it('narrow: the usage text on the second line wraps instead of being clipped (UX tester)', () => {
    viewport(true);
    show(paused());
    const row = within(screen.getByTestId('plan-step-s1')).getAllByRole('button')[0];
    const second = row.children[1] as HTMLElement;
    expect(second.className.split(/\s+/)).toContain('flex-wrap');
    const usage = within(second).getByText('2 of 2 reviewers done · 4,000 tokens'.replace('2 of 2', '1 of 2'));
    const cls = usage.className.split(/\s+/);
    // Never clipped: it may shrink and wrap, and is not held at its full width.
    expect(cls).not.toContain('shrink-0');
    expect(cls).not.toContain('truncate');
    expect(cls).not.toContain('whitespace-nowrap');
    expect(cls).toContain('min-w-0');
  });

  it('wide: a step row stays one line, as signed', () => {
    viewport(false);
    show(paused());
    const row = within(screen.getByTestId('plan-step-s2')).getAllByRole('button')[0];
    expect(row.className.split(/\s+/)).not.toContain('flex-col');
    expect(within(row).getByTestId('plan-step-title')).toHaveTextContent('Combine');
    expect(row).toHaveTextContent('1 worker · combines the results');
  });
});

describe('the "10 minutes" in the card\'s copy', () => {
  it('matches the backstop main uses', () => {
    expect(PLAN_HANDOFF_BACKSTOP_MS).toBe(10 * 60_000);
  });
});
