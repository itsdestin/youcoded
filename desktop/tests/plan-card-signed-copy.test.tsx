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
