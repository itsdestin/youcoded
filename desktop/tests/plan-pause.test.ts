/**
 * Specialists plans, Task 5b — the card tells two pauses apart by the
 * executor's `paused.kind` (5b follow-up; the executor side is pinned in
 * plan-executor.test.ts and plan-journal.test.ts). Also pinned: ChatGPT is the one route without an output cap (the route
 * whose plan cards show "~" limits — Task 8 removed the 5b "On ChatGPT" note
 * that named it), and the Comment follow-up turn's wording.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyPause } from '../src/renderer/components/plans/plan-pause';
import { commentTurnText } from '../src/main/harness/plans/plan-host-bridge';

describe('classifyPause reads the executor’s pause kind (5b follow-up)', () => {
  it('an unknown outcome with its tool, and the cut-off note as the rest', () => {
    expect(classifyPause({ stepId: 's2', reason: 'anything', kind: 'unknown-outcome', tool: 'mcp__gmail__send', note: '2 other specialists were cut off.' }))
      .toEqual({ kind: 'unknown-outcome', tool: 'mcp__gmail__send', rest: '2 other specialists were cut off.' });
    expect(classifyPause({ stepId: 's2', reason: 'anything', kind: 'unknown-outcome', tool: 'Bash' }))
      .toEqual({ kind: 'unknown-outcome', tool: 'Bash', rest: '' });
  });

  it('an iteration cap with its rounds and stop condition', () => {
    expect(classifyPause({ stepId: 'loop', reason: 'anything', kind: 'iteration-cap', repeat: { rounds: 5, until: 'no failing tests' } }))
      .toEqual({ kind: 'iteration-cap', rounds: 5, until: 'no failing tests' });
  });

  it('never reads the sentence: the old executor wording without a kind is an ordinary pause', () => {
    const reason = 'A specialist in step "s2" was cut off, and it isn\'t known whether its last action (Bash) finished. Press Continue to let it pick up from what it recorded.';
    expect(classifyPause({ stepId: 's2', reason }).kind).toBe('other');
  });

  it('a kind without the facts it needs, any other kind, or no pause is ordinary', () => {
    expect(classifyPause({ stepId: 's2', reason: 'r', kind: 'unknown-outcome' }).kind).toBe('other');
    expect(classifyPause({ stepId: 'loop', reason: 'r', kind: 'iteration-cap' }).kind).toBe('other');
    // spend-limit is a valid pause kind (shared/types.ts) with no special
    // card of its own — classifyPause only special-cases unknown-outcome and
    // iteration-cap, so it falls back to the ordinary pause exactly like an
    // unrecognized kind would.
    expect(classifyPause({ stepId: 's1', reason: 'r', kind: 'spend-limit' }).kind).toBe('other');
    expect(classifyPause(undefined).kind).toBe('other');
  });
});

// WHY "the routes whose plan limits are approximate" is GONE (spending
// rework stage 1, design §1, decision 34): `budget-adapter.ts` and its
// per-route `capsOutput` distinction are deleted outright — nothing is
// capped in advance any more, so no route's cap can be "approximate".

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
