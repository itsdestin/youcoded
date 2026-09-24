// @vitest-environment jsdom
/**
 * Specialists plans, Task 9a (pause handoff §1): a specialist the plan
 * restarted by itself says so on its row — "Retried after an error", in muted
 * text — and nothing else about the card changes (it keeps running).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React, { useEffect } from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider, useChatDispatch, useChatState } from '../src/renderer/state/chat-context';
import type { PlanView, PlanChildView } from '../src/shared/types';
import { resetPlanSupportForTests } from '../src/renderer/components/plans/plan-bridge';

const S = 's1';
const CARD = 'call-plan';

const child = (over: Partial<PlanChildView> = {}): PlanChildView => ({
  childId: 'kid-a', parentToolCallId: CARD, agentType: 'reviewer', title: 'Wren the Reviewer',
  background: false, status: 'running', startedAt: 1, ...over,
});

const running = (children: PlanChildView[]): PlanView => ({
  planId: 'plan-1', toolUseId: CARD, title: 'Review two files', status: 'running',
  steps: [{ id: 's1', kind: 'map', title: 'Review', specialist: 'reviewer', fanOut: 2, status: 'running', children }],
  ceilingTokens: 42000, ceilingUsd: null, model: { label: 'm' }, usedTokens: 100, seq: 2,
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

beforeEach(() => {
  resetPlanSupportForTests();
  (window as any).claude = { plans: { getAutoApprove: async () => ({ ok: true, underTokens: 0 }) } };
});
afterEach(() => { cleanup(); delete (window as any).claude; });

describe('a specialist the plan retried by itself', () => {
  it('says "Retried after an error" in muted text; the others do not, and the card stays running', () => {
    render(<ChatProvider><Card initial={running([
      child({ childId: 'kid-a', retried: true }),
      child({ childId: 'kid-b', title: 'Idris the Reviewer' }),
    ])} /></ChatProvider>);
    // A running step is open by itself.
    const rows = screen.getAllByTestId('plan-child');
    const note = within(rows[0]).getByTestId('plan-child-retried');
    expect(note).toHaveTextContent(/^Retried after an error$/);
    expect(note.className).toContain('text-fg-muted');
    expect(within(rows[1]).queryByTestId('plan-child-retried')).toBeNull();
    expect(screen.getByTestId('plan-block').getAttribute('data-plan-status')).toBe('running');
    // The row keeps its ordinary status line.
    expect(within(rows[0]).getByTestId('specialist-status-line')).toHaveTextContent(/^Working/);
  });
});
