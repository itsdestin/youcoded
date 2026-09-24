// @vitest-environment jsdom
/**
 * Specialists plans, Task 5a — the SIGNED plan card must read exactly as the
 * product owner approved it (contract rows R1–R18) while the card moves from
 * workbench fakes onto the real bridge.
 *
 * WHY a frozen copy of the states rather than the workbench fixture files:
 * Task 5a also corrects fixture DATA (a verify step fans out to ONE specialist,
 * as the backend validator says), which changes the numbers a fixture prints.
 * This guard is about the CARD's words and shape, so it reads its own frozen
 * inputs (tests/fixtures/plan-card-signed-states.json, copied from the
 * workbench fixtures at base 710bb9dd) and the snapshot was recorded on that
 * base BEFORE any card code changed. A diff here is a visible change to the
 * signed card: that goes to the product owner, not into the snapshot.
 *
 * Re-recorded once, Task 8 (2026-09-16): the product owner asked on review
 * deck 6 (R6-4) for Approve to be the rightmost button with Comment to its
 * left (and so Cancel · Send in the comment box). Those three states changed
 * button ORDER only — every word is as signed.
 *
 * Re-recorded once more, Task 11 (2026-09-17): decision 19 (the product owner,
 * after review deck 7) puts "Ask the assistant" on every paused card as the
 * light button on the far left. Only the plan-paused state changed, by that
 * one button; every other word is as signed.
 *
 * Re-recorded once more, final code review (2026-09-17, F6, a controller
 * decision under decision 6 / R27): a failed card with no known reason now
 * says "The plan couldn't be created." with Report bug and Diagnose — only
 * the plan-failed state changed. The plan-writing input now carries
 * `model.local` (F19: the "on your computer" hint follows that flag instead of
 * a missing price); its words are unchanged.
 *
 * Re-recorded once more, decision 30 (2026-09-18): the product owner read a
 * real six-step plan and said "it's still a bit hard to tell what exactly is
 * going on or what the plan will do from this card", naming the per-step token
 * figure as the loudest and least useful thing on every row before approval.
 * So while a plan is only PROPOSED, each step's "up to N tokens" moves off the
 * row and into the opened step, beside the per-specialist limit sentence that
 * already lives there. That is the ONLY change in these three proposed states:
 * one figure per row is gone from the collapsed card and nothing is added, and
 * a running, paused or finished card is byte-for-byte as signed. The other two
 * halves of that decision — a fan-out step's item labels and the assistant's
 * plain per-step sentence — cannot show here at all, because these frozen
 * inputs were captured before either field existed.
 *
 * Re-recorded once more, decision 31 (2026-09-18): he read the result and said
 * "still isnt great for transparency/understanding … it's not clear to me how
 * this breaks out into 7 reviewers, what the inputs/ouputs are, and how it
 * flows to the next step". An OPEN step now carries one plain line saying what
 * it is given, what it produces and which step takes that on. The whole diff
 * in these five states is the three words "produces 3 reports", once per card,
 * inside the one step that opens itself while a plan is running or paused.
 * The other two clauses cannot show here: these frozen inputs predate both the
 * item labels and `of`, so no step claims an input or names a consumer. Every
 * other word, and every collapsed row, is byte-for-byte as signed.
 *
 * Re-recorded once more, decisions 34–35 (spending rework, 2026-09-24): no
 * more per-step budgets. Every pending step's "up to N tokens" figure is gone
 * from both the collapsed row and the opened step (these frozen inputs predate
 * `estimate`/`spendLimit`, so the proposed cards' "Up to …" ceiling line is
 * gone too, with nothing to replace it — a plan with an `estimate` shows a
 * range instead). A running card's "Spent X of Y" loses the "of Y" half
 * (these inputs have no `spendLimit`, i.e. no limit was set). The opened
 * step's old "Limits" section (the per-specialist token cap) is now "Model"
 * (decision 35: which model the step runs on, changeable in Plan settings).
 * Only the fixtures this pass changed differ; plan-completed and
 * plan-writing are untouched.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { PlanView, ToolCallState } from '../src/shared/types';
import states from './fixtures/plan-card-signed-states.json';

const NOW = 1753800200000;
const all = states as unknown as Record<string, PlanView>;

// Two terminal states the workbench has no fixture for, derived from the
// signed proposal so the header phrase and the block's shape are pinned too.
const extra: Record<string, PlanView> = {
  'plan-failed': { ...all['plan-proposed'], status: 'failed' },
  'plan-stopped': {
    ...all['plan-running'], status: 'stopped', endedAt: NOW,
    steps: all['plan-running'].steps.map((s) => s.status === 'running' ? { ...s, status: 'skipped' } : s),
  },
};

function toolFor(plan: PlanView): ToolCallState {
  return {
    toolUseId: plan.toolUseId,
    toolName: 'propose_plan',
    input: { title: plan.title },
    status: plan.status === 'writing' ? 'running' : 'complete',
    ...(plan.status === 'writing' ? {} : { response: 'Plan proposed; waiting for the user.' }),
    plan: plan.status === 'writing' || plan.status === 'running' ? { ...plan, startedAt: NOW - 90_000 } : plan,
  } as ToolCallState;
}

/** The card as a reader meets it: every visible string in order, plus the
 *  state hooks the review decks key on. Whitespace-normalised only. */
function describeCard(container: HTMLElement): string {
  const lines: string[] = [];
  const block = container.querySelector('[data-testid="plan-block"]');
  lines.push(`block: ${block ? block.getAttribute('data-plan-status') : 'none'}`);
  for (const step of Array.from(container.querySelectorAll('[data-step-status]'))) {
    lines.push(`step ${step.getAttribute('data-testid')}: ${step.getAttribute('data-step-status')}`);
  }
  lines.push(`buttons: ${Array.from(container.querySelectorAll('button')).map((b) => `${(b.textContent ?? '').replace(/\s+/g, ' ').trim()}${(b as HTMLButtonElement).disabled ? ' [disabled]' : ''}`).filter((t) => t && !t.startsWith(' ')).join(' | ')}`);
  lines.push(`text: ${(container.textContent ?? '').replace(/\s+/g, ' ').trim()}`);
  return lines.join('\n');
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  (window as any).claude = {
    plans: {
      approve: vi.fn(), comment: vi.fn(), addBudget: vi.fn(), resume: vi.fn(), stop: vi.fn(),
      getAutoApprove: vi.fn().mockResolvedValue({ ok: true, underTokens: 0 }), setAutoApprove: vi.fn(),
    },
  };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as any).claude; });

describe('the signed plan card reads exactly as approved', () => {
  for (const [name, plan] of Object.entries({ ...all, ...extra })) {
    it(name, () => {
      const { container } = render(<ChatProvider><ToolCard tool={toolFor(plan)} sessionId="s1" /></ChatProvider>);
      expect(describeCard(container)).toMatchSnapshot();
    });
  }

  it('the paused card opens its Add budget control in the same pill', () => {
    const { container } = render(<ChatProvider><ToolCard tool={toolFor(all['plan-paused'])} sessionId="s1" /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }));
    expect(describeCard(container)).toMatchSnapshot();
    // Final review F27 (R17): the field is INSIDE the amber pill, and the
    // pause's reason is still readable beside it in that same pill.
    const pill = screen.getByTestId('plan-paused-reason').closest('.bg-amber-500\\/10');
    expect(pill, 'the reason is not in an amber pill').not.toBeNull();
    expect(pill).toContainElement(screen.getByLabelText('Tokens to allow'));
    expect(pill).toContainElement(screen.getByTestId('plan-add-budget'));
    expect(screen.getByTestId('plan-paused-reason')).toBeVisible();
    expect(screen.getByTestId('plan-paused-reason').textContent!.length).toBeGreaterThan(10);
  });

  it('the proposed card opens its comment box', () => {
    const { container } = render(<ChatProvider><ToolCard tool={toolFor(all['plan-proposed'])} sessionId="s1" /></ChatProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(describeCard(container)).toMatchSnapshot();
  });

  it('a running specialist row opens onto the ordinary specialist sections', () => {
    const { container } = render(<ChatProvider><ToolCard tool={toolFor(all['plan-running'])} sessionId="s1" /></ChatProvider>);
    const rows = container.querySelectorAll('[data-testid="plan-child"] > button');
    expect(rows.length).toBeGreaterThan(0);
    fireEvent.click(rows[0]);
    expect(describeCard(container)).toMatchSnapshot();
  });
});
