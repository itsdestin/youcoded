/**
 * Specialists plans, Task 5b — the card tells two pauses apart from their
 * backend sentences, because PlanView.paused carries no kind (see the Task 5b
 * report's open questions). These tests pin BOTH ends: the renderer's reader,
 * and the executor templates it reads, so a wording change in either place
 * fails here instead of silently turning a warning card into an ordinary one.
 * Also pinned: the "On ChatGPT" note is true only while ChatGPT is the one
 * route without an output cap, and the Comment follow-up turn's wording.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readStripped } from './helpers/guard-scope';
import { join } from 'node:path';
import { classifyPause } from '../src/renderer/components/plans/plan-pause';
import { budgetAdapterFor } from '../src/main/harness/plans/budget-adapter';
import { commentTurnText } from '../src/main/harness/plans/plan-host-bridge';

// Comments blanked, so a template quoted in a comment cannot keep this green.
const executorSource = readStripped(join(__dirname, '../src/main/harness/plans/plan-executor.ts'));

describe('classifyPause', () => {
  it('reads an unknown-outcome pause, its tool, and any note after it', () => {
    const reason = 'A specialist in step "s2" was cut off, and it isn\'t known whether its last action (mcp__gmail__send) finished. Press Continue to let it pick up from what it recorded. 2 other specialists were cut off.';
    expect(classifyPause({ stepId: 's2', reason })).toEqual({ kind: 'unknown-outcome', tool: 'mcp__gmail__send', rest: '2 other specialists were cut off.' });
  });

  it('an unanswered REQUEST (no action named) is not an unknown-outcome pause', () => {
    const reason = 'A specialist in step "s2" was cut off, and it isn\'t known whether its last request finished. Press Continue to let it pick up from what it recorded.';
    expect(classifyPause({ stepId: 's2', reason }).kind).toBe('other');
  });

  it('reads an iteration-cap pause', () => {
    const reason = 'The repeated steps ran 5 times without meeting their stop condition ("no failing tests (unit or e2e)"). Ask the assistant to revise the plan.';
    expect(classifyPause({ stepId: 'loop', reason })).toEqual({ kind: 'iteration-cap', rounds: 5, until: 'no failing tests (unit or e2e)' });
  });

  it('anything else is an ordinary pause', () => {
    expect(classifyPause({ stepId: 's1', reason: 'step 1 hit its limit.' }).kind).toBe('other');
    expect(classifyPause(undefined).kind).toBe('other');
  });
});

describe('the executor still writes the sentences the card reads', () => {
  it('unknown outcome', () => {
    expect(executorSource).toContain('`its last action (${verdict.tool})`');
    expect(executorSource).toContain('reason: `A specialist in step "${stepId}" was cut off, and it isn\'t known whether ${what} finished. `');
    expect(executorSource).toContain("+ 'Press Continue to let it pick up from what it recorded.',");
  });

  it('iteration cap', () => {
    expect(executorSource).toContain('reason: `The repeated steps ran ${step.max_iterations} times without meeting their stop condition ("${step.until}"). `');
    expect(executorSource).toContain("+ 'Ask the assistant to revise the plan.',");
  });
});

describe('the card’s "On ChatGPT" note', () => {
  it('stays true: ChatGPT is the only route whose replies cannot be capped', () => {
    const types = ['anthropic', 'openai', 'google', 'openrouter', 'openai-compatible', 'local-engine', 'chatgpt'] as const;
    const soft = types.filter((t) => { const r = budgetAdapterFor(t); return r.ok && !r.adapter.capsOutput; });
    expect(soft).toEqual(['chatgpt']);
  });
});

describe('the Comment follow-up turn', () => {
  it('is the user’s words, then one short plain instruction', () => {
    expect(commentTurnText('Also check the tests folder.')).toBe('Also check the tests folder.\n\n(Feedback on your plan: please revise it and propose it again.)');
  });

  it('the workbench fixture shows the same text the app sends', () => {
    const raw = readFileSync(join(__dirname, '../src/renderer/dev/workbench/fixtures/bubbles/plan-comment-followup.jsonl'), 'utf8');
    const turn = raw.trim().split('\n').map((l) => JSON.parse(l)).filter((o) => o.type === 'user_message')[1];
    expect(turn.text).toBe(commentTurnText('Also check the tests folder, not just the auth code.'));
  });
});
