// @vitest-environment jsdom
//
// Independent correctness audit of the specialists-plans SPENDING math —
// renderer half. Companion to tests/plan-cost-audit.test.ts (the backend
// half runs in a node environment; this needs jsdom, so it is a separate
// file). Reuses THAT file's own hand-computed literals (scenario 1's total)
// so the same numbers are checked at both ends: the backend test proves
// plan.usedUsd/usedTokens equal the hand total, and this file proves the
// card's spentLine() formats those exact numbers the way a person reads them —
// "Spent $X of $Y", the tokens line for an unpriced plan, an under-a-cent
// amount, and never a false "$0.00" (docs/error-message-standards.md).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React, { useEffect } from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider, useChatDispatch, useChatState } from '../src/renderer/state/chat-context';
import type { PlanView } from '../src/shared/types';
import { resetPlanSupportForTests } from '../src/renderer/components/plans/plan-bridge';

const S = 's1';
const CARD = 'call-plan';

function plan(over: Partial<PlanView> = {}): PlanView {
  return {
    planId: 'plan-1', toolUseId: CARD, title: 'Review three files, then sum up', status: 'running',
    steps: [
      { id: 'review', kind: 'map', title: 'Review', specialist: 'reviewer', fanOut: 3, status: 'done', done: 3 },
      { id: 'sum', kind: 'combine', title: 'Combine', specialist: 'reviewer', fanOut: 1, status: 'done', done: 1 },
    ],
    model: { label: 'Child' }, seq: 1,
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

function bridge() {
  (window as any).claude = {
    plans: {
      approve: vi.fn(), comment: vi.fn(), setLimit: vi.fn(), setStepModel: vi.fn(), resume: vi.fn(), stop: vi.fn(),
      getAutoApprove: vi.fn().mockResolvedValue({ ok: true, underUsd: 0 }),
      setAutoApprove: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

const ceilingLine = () => screen.getByTestId('plan-ceiling').textContent ?? '';

beforeEach(() => { resetPlanSupportForTests(); bridge(); });
afterEach(() => { cleanup(); delete (window as any).claude; });

describe('the plan card renders the hand-audited spending literals correctly', () => {
  // Same total as plan-cost-audit.test.ts's "3-specialist parallel split +
  // combine, clean finish" scenario: usedUsd = COST_A+COST_B+COST_C+COST_COMBINE
  // = 0.1665+0.09375+0.072+0.105 = 0.43725. usd() rounds to cents (toFixed(2)),
  // so this reads "$0.44" — a real receipt figure, never "$0.00".
  it('"Spent $X of $Y" with the audited total and a set limit', () => {
    // `estimate` (the {lowUsd,highUsd} shape) is what tells spentLine() this
    // plan is PRICED at all — its own absence reads as unpriced regardless of
    // usedUsd (PlanCard.tsx's `unpriced()`), so a priced fixture always sets it.
    render(<ChatProvider><Card initial={plan({ usedUsd: 0.43725, spendLimit: { usd: 5 }, estimate: { lowUsd: 0.3, highUsd: 0.6 } })} /></ChatProvider>);
    expect(ceilingLine()).toContain('Spent $0.44 of $5');
  });

  it('an under-a-cent spend and limit never print a false "$0.00"', () => {
    render(<ChatProvider><Card initial={plan({ usedUsd: 0.001, spendLimit: { usd: 0.001 }, estimate: { lowUsd: 0.001, highUsd: 0.001 } })} /></ChatProvider>);
    const line = ceilingLine();
    expect(line).toContain('Spent less than a cent of a limit under a cent');
    expect(line).not.toContain('$0.00');
  });

  // Scenario 5's mixed-plan total (plan-cost-audit.test.ts): tokens count
  // both steps (11_494 + 17_000 = 28_494) even though only one step is
  // priced — but a plan is "unpriced" (spentLine's tokens branch) only when
  // NO step has a price at all, so this checks the fully-unpriced case on
  // its own hand-computed token total instead (11_494 + 17_000 tokens' worth
  // of a ChatGPT sign-in run, decision 34 Q-5's own wording).
  it('an unpriced plan shows a tokens line, labelled — never "$0.00"', () => {
    render(<ChatProvider><Card initial={plan({
      usedUsd: undefined,
      usedTokens: 28_494,
      estimate: { tokens: 300_000, unpricedNote: 'included in your ChatGPT plan' },
    })} /></ChatProvider>);
    const line = ceilingLine();
    expect(line).toContain('About 28,494 tokens used');
    expect(line).toContain('included in your ChatGPT plan');
    expect(line).not.toContain('$0.00');
    expect(line).not.toContain('$');
  });
});
