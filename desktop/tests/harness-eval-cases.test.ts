import { describe, it, expect } from 'vitest';
import { getCase, allCaseIds } from '../src/main/harness/eval/cases';
import { BATTERY_PROMPT } from '../src/main/harness/eval/battery';
import { WRAP_UP_PROMPT } from '../src/main/harness/eval/run-case';

/** The four cases the claude-md-guidance plan runs. Named here rather than
 *  derived from allCaseIds() so that DELETING one is a test failure — a plan
 *  file naming a case that no longer exists fails at validation, but a plan
 *  file that silently lost a case would just run a smaller matrix. */
const GUIDANCE_CASES = ['config-investigation', 'options-proposal', 'port-bump', 'code-explanation'];
// "Notify user" reliability (test-engine/eval-plans/notify-user.json).
const NOTIFY_CASES = ['notify-finished-task', 'notify-needs-decision', 'notify-checkpoint', 'notify-quick-answer', 'notify-waiting-on-background'];

describe('case registry', () => {
  it('carries the battery as a case', () => {
    expect(getCase('harness-battery').prompt).toBe(BATTERY_PROMPT);
    expect(getCase('harness-battery').minToolCalls).toBe(10);
  });
  it('names the known ids when asked for an unknown one', () => {
    expect(() => getCase('nope')).toThrow(/harness-battery/);
  });
  it('lists ids in a stable order', () => {
    expect(allCaseIds()).toEqual([...allCaseIds()].sort());
  });

  it('grades the battery on the three mechanical checks', () => {
    expect(getCase('harness-battery').expect.map((c) => c.id))
      .toEqual(['stayed-inside-test-folder', 'ended-with-an-answer', 'called-tool:Grep']);
  });

  // --- the claude-md-guidance cases ----------------------------------------

  it('registers all four guidance cases under their own ids', () => {
    for (const id of GUIDANCE_CASES) expect(getCase(id).id).toBe(id);
    expect(allCaseIds()).toEqual([...GUIDANCE_CASES, 'harness-battery', ...NOTIFY_CASES].sort());
  });

  it('gives every case a non-empty prompt', () => {
    // runCell refuses an empty prompt because it would silently run the default
    // battery prompt and bill it as this case (harness-eval.mjs). This is the
    // same guard one layer earlier, where it costs nothing.
    for (const id of allCaseIds()) {
      expect(getCase(id).prompt.trim(), `${id} prompt`).not.toBe('');
    }
  });

  it('gives every guidance case a wrap-up prompt that is NOT the battery review request', () => {
    // The battery's wrap-up literally says "write your review of the harness".
    // Sent at the end of "explain this file", it asks for a deliverable nobody
    // wanted — and the answer that comes back is what gets graded and paid for.
    for (const id of GUIDANCE_CASES) {
      const body = getCase(id);
      expect(body.wrapUpPrompt.trim(), `${id} wrap-up`).not.toBe('');
      expect(body.wrapUpPrompt, `${id} wrap-up must not be the battery's`).not.toBe(WRAP_UP_PROMPT);
      expect(body.wrapUpPrompt, `${id} wrap-up must not ask for a harness review`)
        .not.toMatch(/review of the harness/i);
      // run-case.ts denies every tool call during the wrap-up turn. A wrap-up
      // prompt that does not say so leaves the model spending its last paid
      // turn confused by denials instead of writing the answer.
      expect(body.wrapUpPrompt, `${id} wrap-up must warn that tools are denied`)
        .toMatch(/will be denied/i);
    }
  });

  it('sets a per-task tool-call floor rather than inheriting the battery\'s 10', () => {
    // run-facts.ts flags a run below the floor as truncated. The battery's 10
    // measures "did it walk seven areas of tool surface"; on "explain this
    // six-line file" a perfect one-Read answer would be flagged by it.
    for (const id of GUIDANCE_CASES) {
      const floor = getCase(id).minToolCalls;
      expect(floor, `${id} floor`).toBeGreaterThanOrEqual(1);
      expect(floor, `${id} floor must not be the battery's`).toBeLessThan(10);
    }
  });

  it('gives every case rubric ids that are unique within that case', () => {
    // judge.ts drops a second grade for an id it has already seen ("the judge
    // graded it twice"), so a duplicated id silently costs the whole matrix one
    // rubric item on every cell of that case.
    for (const id of allCaseIds()) {
      const ids = getCase(id).rubric.map((item) => item.id);
      expect(new Set(ids).size, `${id} rubric ids: ${ids.join(', ')}`).toBe(ids.length);
    }
  });

  it('asks every guidance rubric question in a form with something to quote either way', () => {
    // judge.ts DISCARDS a grade whose quote is not found verbatim in the answer,
    // rather than scoring it low. So a question with no quotable negative comes
    // back as no grade at all — a blank cell that reads as "nothing found".
    // Every ask must therefore name what to quote in both directions, and say
    // which end of the scale is good (a bare "unexplained-jargon: 4" is
    // unreadable without it).
    for (const id of GUIDANCE_CASES) {
      const body = getCase(id);
      expect(body.rubric.length, `${id} rubric`).toBeGreaterThanOrEqual(5);
      for (const item of body.rubric) {
        expect(item.ask, `${id} → ${item.id} must say which end of the scale is good`)
          .toMatch(/score (high|low)/i);
        expect(item.ask, `${id} → ${item.id} must ask for a quote`).toMatch(/quote/i);
        expect(item.ask, `${id} → ${item.id} must offer a quote for the negative case too`)
          .toMatch(/;\s*if\b/i);
      }
    }
  });

  it('shares the same four prose questions across all four guidance cases', () => {
    // The experiment compares three versions of one block of writing guidance.
    // If the shared questions drifted apart per case, the arms would no longer
    // be comparable across cases, which is most of what the plan is for.
    const shared = ['plain-language', 'unexplained-jargon', 'padding', 'evidence-not-assertion'];
    for (const id of GUIDANCE_CASES) {
      expect(getCase(id).rubric.slice(0, 4).map((item) => item.id), `${id} shared rubric`).toEqual(shared);
    }
  });

  // Registry-wide guards, not battery-specific ones: a case added later gets
  // them for free. A check that reports a verdict about the MODEL on a run the
  // model never got to take part in is the `notes/pristine.md` failure shape —
  // a grade for something that never happened — and it must be caught at the
  // case level, not only in assertions.ts's own tests.
  //
  // WHY these runs carry a `user-message` event: `session.send()` emits one
  // synchronously before the provider is ever called (harness-session.ts
  // beginTurn) and run-case.ts pushes every event into `events`, so `events: []`
  // — what this test used to pass — is a shape `runCase` cannot produce. The old
  // version was green against an impossible input while the real one (below)
  // reported `failed`.
  const baseRun = {
    label: 'none', modelId: 'none', review: '', toolCalls: 0, asks: 0,
    stepGates: 0, fixtureRoot: '', outcome: 'no-review' as const,
    metrics: {
      wallClockMs: 0, toolCalls: 0, asks: 0, stepGates: 0, thinkingEvents: 0,
      inputTokens: 0, outputTokens: 0, stopReasons: [], toolsUsed: [], repeats: [],
    },
  };
  const event = (type: 'user-message' | 'session-error', text: string) =>
    ({ type, sessionId: 'eval', uuid: `u-${type}`, timestamp: 1, data: { text } }) as const;

  it('lets no case check report passed on a run where the model never took a step', () => {
    const nothingHappened = { ...baseRun, events: [event('user-message', 'do the task')] };
    for (const id of allCaseIds()) {
      for (const check of getCase(id).expect) {
        const result = check.run(nothingHappened);
        expect(result.state, `${id} → ${check.id}`).toBe('never-ran');
        expect(result.detail, `${id} → ${check.id} must explain itself`).not.toBe('');
      }
    }
  });

  it('lets no case check blame the model when the provider failed on the first step', () => {
    // The real round-8 shape: a 402 before the model ever produced a step.
    const err = 'You requested up to 65536 tokens, but can only afford 63293';
    const provider402 = {
      ...baseRun,
      outcome: 'error' as const,
      error: err,
      events: [event('user-message', 'do the task'), event('session-error', err)],
    };
    for (const id of allCaseIds()) {
      for (const check of getCase(id).expect) {
        const result = check.run(provider402);
        expect(result.state, `${id} → ${check.id} on a first-step 402`).toBe('never-ran');
      }
    }
  });
});
