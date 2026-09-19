// @vitest-environment jsdom
/**
 * Specialists plans (Destin, 2026-09-18): "how would i go about viewing/editing
 * the actual details of the plan if i desired?" — the row showed only the FIRST
 * LINE of a step's instructions, capped and then clipped by the window, so he
 * was approving real spending on text he could not finish reading. Opening a
 * step now shows the whole thing, exactly as the specialist will receive it.
 * Read-only: editing a plan by hand is roadmapped, not built
 * (docs/roadmap/native-harness.md, 2026-09-18).
 *
 * Extended the same day (decision 30) after he read a real six-step plan: "it's
 * still a bit hard to tell what exactly is going on or what the plan will do
 * from this card." So the rest of this file covers the row itself — the items
 * each specialist is given, the assistant's own plain sentence, the token
 * figure moving off a proposed row, and the line the expansion used to repeat.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React, { useEffect } from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider, useChatDispatch, useChatState } from '../src/renderer/state/chat-context';
import type { PlanView } from '../src/shared/types';
import { resetPlanSupportForTests } from '../src/renderer/components/plans/plan-bridge';

const S = 's1';
const CARD = 'call-plan';

const FIRST_LINE = 'EXPECTATION PASS (fresh eyes, no implementation reading).';
const REST = 'Work in /home/destin/youcoded-dev. Do not read the implementation.\nWrite one numbered finding per surface.';
const TASK = `${FIRST_LINE}\n${REST}`;

/** A proposal, the moment it matters: before Approve, nothing has run. */
const proposed = (over: Partial<PlanView['steps'][number]> = {}): PlanView => ({
  planId: 'plan-1', toolUseId: CARD, title: 'Audit every desktop surface', status: 'proposed',
  steps: [{
    id: 's1', kind: 'map', title: FIRST_LINE, task: TASK, specialist: 'reviewer',
    fanOut: 7, budgetTokens: 2000, status: 'pending', ...over,
  }],
  ceilingTokens: 42000, ceilingUsd: null, model: { label: 'm' }, seq: 1,
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

const show = (plan: PlanView) => render(<ChatProvider><Card initial={plan} /></ChatProvider>);
const openStep = () => fireEvent.click(screen.getByTestId('plan-step-title').closest('button')!);

beforeEach(() => {
  resetPlanSupportForTests();
  (window as any).claude = { plans: { getAutoApprove: async () => ({ ok: true, underTokens: 0 }) } };
});
afterEach(() => { cleanup(); delete (window as any).claude; });

describe('a plan step opens onto the instructions its specialist will be sent', () => {
  it('shows the whole task, not just the headline the row is capped to', () => {
    show(proposed());
    // Closed, the card still says only what it always said.
    expect(screen.queryByTestId('plan-step-task')).not.toBeInTheDocument();
    openStep();
    const body = screen.getByTestId('plan-step-task');
    // The lines the row could never show are the point of the change.
    expect(body).toHaveTextContent('Do not read the implementation.');
    expect(body).toHaveTextContent('Write one numbered finding per surface.');
  });

  it('keeps the limit line that was already there, so nothing is traded away', () => {
    show(proposed());
    openStep();
    expect(screen.getByText(/stops at its/)).toBeInTheDocument();
  });

  it('leaves the line breaks the model wrote intact, rather than running them together', () => {
    show(proposed());
    openStep();
    const body = screen.getByTestId('plan-step-task');
    expect(body.textContent).toContain('\n');
  });

  it('says nothing extra for an older record that carries no instructions', () => {
    // Plans proposed before this change, replayed from a saved conversation.
    show(proposed({ task: undefined }));
    openStep();
    expect(screen.queryByTestId('plan-step-task')).not.toBeInTheDocument();
    expect(screen.getByText(/stops at its/)).toBeInTheDocument();
  });

  it('still gives a running step its specialists, not the brief in their place', () => {
    const plan = proposed({
      status: 'running',
      children: [{ childId: 'kid-a', parentToolCallId: CARD, agentType: 'reviewer', title: 'Wren the Reviewer', background: false, status: 'running', startedAt: 1 }],
    });
    show({ ...plan, status: 'running' });
    // A running step opens by itself; its children are what the row is for.
    const step = screen.getByTestId('plan-step-s1');
    expect(within(step).getByText('Wren the Reviewer')).toBeInTheDocument();
  });
});

const SURFACES = ['Chat', 'Files', 'Settings', 'Terminal', 'Specialists', 'Skills', 'Games'];
const row = () => screen.getByTestId('plan-step-detail');

describe('a fan-out step says what each of its specialists gets', () => {
  it('names the items on the collapsed row instead of only counting the specialists', () => {
    show(proposed({ items: SURFACES }));
    // "7 reviewers" alone never said on WHAT; the labels are already in the plan.
    expect(row()).toHaveTextContent('7 reviewers');
    expect(row()).toHaveTextContent('one each:');
    expect(row()).toHaveTextContent('Chat');
    expect(row()).toHaveTextContent('Files');
  });

  it('shortens a long list on the row, and still ends it honestly', () => {
    show(proposed({ items: SURFACES }));
    // Not all seven fit one line, so the row says there are more.
    expect(row().textContent).toContain('…');
    expect(row()).not.toHaveTextContent('Games');
  });

  it('lists every item in full when the step is opened, one per line', () => {
    show(proposed({ items: SURFACES }));
    expect(screen.queryByTestId('plan-step-items')).not.toBeInTheDocument();
    openStep();
    const list = screen.getByTestId('plan-step-items');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(SURFACES);
  });

  it('keeps a long item readable when the step is opened, however it was cut on the row', () => {
    const long = 'The whole Settings panel, including the Model Providers section';
    show(proposed({ items: [long, 'Chat'] }));
    expect(row().textContent).toContain('…');
    openStep();
    expect(within(screen.getByTestId('plan-step-items')).getByText(long)).toBeInTheDocument();
  });

  it('leaves a repeating step exactly as it reads today, with no item list', () => {
    show(proposed({ kind: 'repeat', fanOut: 3 }));
    expect(row()).toHaveTextContent('repeats until done');
    expect(row()).not.toHaveTextContent('one each');
    openStep();
    expect(screen.queryByTestId('plan-step-items')).not.toBeInTheDocument();
  });
});

describe('a plan step reads as a sentence written for the person approving it', () => {
  const SUMMARY = 'Seven reviewers each look at one screen and say what feels wrong.';

  it('shows the assistant\'s plain sentence as the row', () => {
    show(proposed({ summary: SUMMARY }));
    expect(screen.getByTestId('plan-step-title')).toHaveTextContent(SUMMARY);
  });

  it('falls back to the headline of the instructions when no sentence was written', () => {
    show(proposed());
    expect(screen.getByTestId('plan-step-title')).toHaveTextContent(FIRST_LINE);
  });
});

describe('a proposed plan step is about what will happen, a running one about progress', () => {
  it('keeps the token figure off the row while the plan is only proposed', () => {
    show(proposed());
    expect(screen.getByTestId('plan-step-s1')).not.toHaveTextContent('up to');
  });

  it('shows that figure when the step is opened, beside the per-specialist limit', () => {
    show(proposed());
    openStep();
    expect(screen.getByTestId('plan-step-s1')).toHaveTextContent('Up to 14,000 tokens for this step.');
    expect(screen.getByText(/stops at its/)).toBeInTheDocument();
  });

  it('leaves a running plan\'s row saying what it says today', () => {
    const plan = proposed({ status: 'running', done: 2, usedTokens: 4000 });
    show({ ...plan, status: 'running' });
    expect(screen.getByTestId('plan-step-s1')).toHaveTextContent('2 of 7 reviewers done');
    expect(screen.getByTestId('plan-step-s1')).toHaveTextContent('4,000 tokens');
  });

  it('still shows a not-yet-started step\'s figure once the plan is running', () => {
    // Only the PLAN's status decides; a pending step inside a running plan
    // keeps the figure it has always had.
    show({ ...proposed(), status: 'running' });
    expect(screen.getByTestId('plan-step-s1')).toHaveTextContent('up to 14,000 tokens');
  });
});

describe('opening a step does not repeat the line its row already shows', () => {
  it('starts the brief after the headline the row is showing', () => {
    show(proposed());
    openStep();
    const body = screen.getByTestId('plan-step-task');
    expect(body).not.toHaveTextContent(FIRST_LINE);
    expect(body).toHaveTextContent('Do not read the implementation.');
  });

  it('adds nothing at all when the whole brief is the one line the row shows', () => {
    show(proposed({ task: FIRST_LINE, title: FIRST_LINE }));
    openStep();
    expect(screen.queryByTestId('plan-step-task')).not.toBeInTheDocument();
    // The limit line is still there, so the expansion is never empty.
    expect(screen.getByText(/stops at its/)).toBeInTheDocument();
  });

  it('shows the brief entire when the row is showing a sentence instead of it', () => {
    show(proposed({ summary: 'Seven reviewers look at one screen each.' }));
    openStep();
    expect(screen.getByTestId('plan-step-task')).toHaveTextContent(FIRST_LINE);
  });

  it('shows the brief entire when the row had to cut its first line short', () => {
    const long = `${'Read every file under the renderer and report what each one does'.repeat(2)}.`;
    show(proposed({ task: `${long}\nThen stop.`, title: `${long.slice(0, 79)}…` }));
    openStep();
    expect(screen.getByTestId('plan-step-task')).toHaveTextContent(long);
  });
});
