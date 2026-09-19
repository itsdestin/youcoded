// @vitest-environment jsdom
/**
 * Specialists plans (Destin, 2026-09-18): "how would i go about viewing/editing
 * the actual details of the plan if i desired?" — the row showed only the FIRST
 * LINE of a step's instructions, capped and then clipped by the window, so he
 * was approving real spending on text he could not finish reading. Opening a
 * step now shows the whole thing, exactly as the specialist will receive it.
 * Read-only: editing a plan by hand is roadmapped, not built
 * (docs/roadmap/native-harness.md, 2026-09-18).
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
