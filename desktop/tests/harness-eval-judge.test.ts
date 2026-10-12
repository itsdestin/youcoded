// The judge (Task 10) — everything here is driven by a FAKE judge model.
// No network, no key, no spend: a MockLanguageModelV4 whose doGenerate returns
// a canned string is the entire "provider" for this suite.
//
// The load-bearing test in this file is the quote enforcement group. The whole
// design rests on "a grade without a verbatim quote is discarded", so those
// tests carry a positive control (a real quote survives) — without it, a
// judgeRun that returned `grades: []` unconditionally would pass every drop
// test and prove nothing.
import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import {
  judgeRun, MIN_QUOTE_CHARS, MAX_QUOTE_SEGMENTS, JUDGE_SCALE_MAX,
  type JudgeResult,
} from '../src/main/harness/eval/judge';
import { calledTool } from '../src/main/harness/eval/assertions';
import type { CaseRun, CheckResult, RubricItem } from '../src/main/harness/eval/case-types';
import type { TranscriptEvent } from '../src/shared/types';

// --- fixtures ---------------------------------------------------------------

// The run's written answer. Every "real quote" below is copied out of THIS
// string, so a reader can check the tests the same way the tool asks Destin to
// check a grade.
const ANSWER = [
  'I read the config loader before changing anything, because the failure only',
  'shows up when two loaders race.',
  '',
  'The trade-off is between a lock and a retry: a lock is simpler to reason about',
  'but serializes every startup, while a retry keeps startup parallel and pays for',
  'it with a worst case nobody can bound.',
  '',
  'I went with the lock, and I would revisit that if startup time became the',
  'complaint people actually had.',
].join('\n');

function toolUse(name: string, input: Record<string, unknown>): TranscriptEvent {
  return { type: 'tool-use', sessionId: 's', uuid: `u${Math.random()}`, timestamp: 0, data: { toolName: name, toolInput: input } };
}

function makeRun(over: Partial<CaseRun> = {}): CaseRun {
  return {
    label: 'test', modelId: 'vendor/model-under-test', review: ANSWER,
    events: [toolUse('Read', { file_path: 'config.ts' }), toolUse('Grep', { pattern: 'loadConfig' })],
    toolCalls: 2, asks: 0, stepGates: 0, fixtureRoot: '/tmp/fixture', outcome: 'complete',
    metrics: {
      wallClockMs: 1000, toolCalls: 2, asks: 0, stepGates: 0, thinkingEvents: 0,
      inputTokens: 10, outputTokens: 10, stopReasons: ['stop'], toolsUsed: ['Grep', 'Read'], repeats: [],
    },
    ...over,
  };
}

const RUBRIC: RubricItem[] = [
  { id: 'tradeoffs', ask: 'Does the answer lay out the trade-offs?' },
  { id: 'searched', ask: 'Did it look at the code before answering?' },
];

// --- the fake judge model ---------------------------------------------------

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A judge whose single generate call returns `payload` — an object/array is
 *  JSON-encoded, a string is returned raw (that is how the malformed-JSON and
 *  empty-answer cases are driven). `seen` collects the prompts it was sent. */
function fakeJudge(payload: unknown, modelId = 'vendor/judge-model', seen?: any[]) {
  return {
    modelId,
    factory: async () => new MockLanguageModelV4({
      doGenerate: async (req: any) => {
        seen?.push(req.prompt);
        return {
          content: [{ type: 'text' as const, text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
          finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: USAGE, warnings: [],
        };
      },
    }) as any,
  };
}

/** A judge whose factory rejects — the "provider is down / 402" path. */
function throwingJudge(err: unknown = new Error('OpenRouter 402: insufficient credits')) {
  return { modelId: 'vendor/judge-model', factory: async () => { throw err; } };
}

/** The prompt text the fake judge was actually sent. WHY not `JSON.stringify`
 *  like the older assertions below: a tool-call line contains double quotes,
 *  which JSON-escapes to `\"` and would make a `toContain` check silently
 *  impossible to satisfy. */
function promptOf(seen: any[]): string {
  return seen
    .flatMap((p: any) => (Array.isArray(p) ? p : [p]))
    .flatMap((m: any) => (Array.isArray(m?.content) ? m.content : [m]))
    .map((c: any) => (typeof c === 'string' ? c : c?.text ?? ''))
    .join('\n');
}

// WHY: some cases hand the judge a deliberately malformed grade (score: 'excellent'),
// so the override is loosely typed instead of Partial<Grade>.
const g = (over: Record<string, unknown> = {}) =>
  ({ id: 'tradeoffs', score: 4, quote: 'The trade-off is between a lock and a retry', ...over });

// --- quote enforcement (the load-bearing group) ------------------------------

describe('judgeRun quote enforcement', () => {
  // POSITIVE CONTROL. If this ever fails, the drop tests below stop meaning
  // anything, because "returns nothing, always" would satisfy all of them.
  it('keeps a grade whose quote is verbatim in the answer', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g()]), []);
    expect(r.unavailable).toBeUndefined();
    expect(r.grades).toHaveLength(1);
    expect(r.grades[0]).toMatchObject({ id: 'tradeoffs', score: 4 });
    expect(ANSWER).toContain(r.grades[0].quote);
  });

  it('drops a grade that carries no quote', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g({ quote: '' })]), []);
    expect(r.grades).toHaveLength(0);
    expect(r.warnings.join()).toMatch(/quote/i);
  });

  it('drops a grade whose quote is not in the answer', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g({ quote: 'it never said any of this at all' })]), []);
    expect(r.grades).toHaveLength(0);
    expect(r.warnings.join()).toMatch(/not found|verbatim/i);
  });

  it('drops a paraphrase that only shares words with the answer', async () => {
    // Same vocabulary, different sentence: the check is substring, not overlap.
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g({ quote: 'a retry is between the trade-off and a lock' })]), []);
    expect(r.grades).toHaveLength(0);
  });

  it('drops a quote too short to be checkable', async () => {
    const short = 'a lock'; // < MIN_QUOTE_CHARS, and genuinely present in the answer
    expect(short.length).toBeLessThan(MIN_QUOTE_CHARS);
    expect(ANSWER).toContain(short);
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g({ quote: short })]), []);
    expect(r.grades).toHaveLength(0);
    expect(r.warnings.join()).toMatch(/short/i);
  });

  it('accepts a quote reflowed across the answer’s line break and with smart quotes', async () => {
    // The answer wraps mid-sentence; a model re-quoting it collapses the newline
    // to a space and often "smartens" the apostrophes. Neither is a fabrication.
    const reflowed = 'I read the config loader before changing anything, because the failure only shows up';
    expect(ANSWER).not.toContain(reflowed);   // proves the raw string really is reflowed
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g({ quote: reflowed })]), []);
    expect(r.grades).toHaveLength(1);
    // The stored quote is the SOURCE substring, so Ctrl-F in the answer finds it.
    expect(ANSWER).toContain(r.grades[0].quote);
  });

  it('accepts an elided quote only when both halves appear, in order', async () => {
    const ok = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      g({ quote: 'The trade-off is between a lock and a retry ... serializes every startup' }),
    ]), []);
    expect(ok.grades).toHaveLength(1);

    // Same two halves, reversed: the answer never says them in this order.
    const backwards = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      g({ quote: 'serializes every startup ... The trade-off is between a lock and a retry' }),
    ]), []);
    expect(backwards.grades).toHaveLength(0);
  });

  it('drops a grade for a rubric item that does not exist', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g({ id: 'invented-item' })]), []);
    expect(r.grades).toHaveLength(0);
    expect(r.warnings.join()).toMatch(/invented-item/);
  });

  it('drops a grade whose score is not a number in range', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      g({ id: 'tradeoffs', score: 'excellent' }),
      g({ id: 'searched', score: JUDGE_SCALE_MAX + 3, quote: 'I read the config loader before changing anything' }),
    ]), []);
    expect(r.grades).toHaveLength(0);
    expect(r.warnings.join()).toMatch(/score/i);
  });

  it('warns about a rubric item the judge skipped', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g()]), []);
    expect(r.warnings.join()).toMatch(/searched/);
  });

  it('caps how many fragments one quote may be stitched from', async () => {
    // Four pieces, each verbatim and in order — the assembly loophole: every
    // fragment checks out and the sentence they add up to is invented.
    const pieces = [
      'I read the config loader',
      'shows up when two loaders race',
      'serializes every startup',
      'I went with the lock',
    ];
    for (const piece of pieces) expect(ANSWER).toContain(piece);
    expect(pieces.length).toBeGreaterThan(MAX_QUOTE_SEGMENTS);

    const over = await judgeRun(makeRun(), RUBRIC, fakeJudge([g({ quote: pieces.join(' ... ') })]), []);
    expect(over.grades).toHaveLength(0);
    expect(over.warnings.join()).toMatch(/fragments/i);

    // Control: the same quote at the cap is still accepted, so the cap is a cap
    // and not a ban on elision.
    const atCap = await judgeRun(makeRun(), RUBRIC, fakeJudge([g({ quote: pieces.slice(0, MAX_QUOTE_SEGMENTS).join(' ... ') })]), []);
    expect(atCap.grades).toHaveLength(1);
  });

  it('says SEGMENTS, not "the quote", when the answer’s own text contains an ellipsis', async () => {
    // A 24-character verbatim quote that splits into two short halves because
    // the "…" is the ANSWER's, not the judge's. It is still dropped — but the
    // message must not claim a 24-character quote is under 12 characters.
    const review = 'Wait for it… then retry the whole thing.';
    const quote = 'Wait for it… then retry';
    expect(review).toContain(quote);
    expect(quote.length).toBeGreaterThan(MIN_QUOTE_CHARS);

    const r = await judgeRun(makeRun({ review }), RUBRIC, fakeJudge([g({ quote })]), []);
    expect(r.grades).toHaveLength(0);
    const warning = r.warnings.find((w) => w.includes('tradeoffs')) ?? '';
    expect(warning).toMatch(/2 segments/);
    expect(warning).toMatch(/answer's own text/);
  });

  // The haystack is the ANSWER and nothing else. Both strings below are in the
  // prompt the judge was shown, so a judge could copy either one back verbatim;
  // both must be rejected. Nothing but the `run.review` argument enforces that
  // today, which is exactly why it needs pinning.
  it.each([
    ['the rubric question', 'Does the answer lay out the trade-offs?'],
    ['the tool-call list', 'Read {"file_path":"config.ts"}'],
  ])('rejects a quote copied from %s rather than the answer', async (_label, quote) => {
    const seen: any[] = [];
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g({ quote })], 'vendor/judge-model', seen), []);
    // The string really was available to copy — otherwise this proves nothing.
    expect(promptOf(seen)).toContain(quote);
    expect(ANSWER).not.toContain(quote);
    expect(r.grades).toHaveLength(0);
    expect(r.warnings.join()).toMatch(/not found|verbatim/i);
  });

  it('does not let a malformed grade steal the id from a valid one', async () => {
    // The judge grades "tradeoffs" twice: first with a junk score, then
    // correctly. The second must survive — dropping it as a duplicate would
    // name the wrong problem AND lose a usable grade.
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      g({ score: 'excellent' }),
      g({ score: 4 }),
    ]), []);
    expect(r.grades).toEqual([expect.objectContaining({ id: 'tradeoffs', score: 4 })]);
    expect(r.warnings.join()).not.toMatch(/graded it twice/i);

    // Control: two genuinely valid grades for one id still trip the duplicate rule.
    const dupes = await judgeRun(makeRun(), RUBRIC, fakeJudge([g({ score: 4 }), g({ score: 1 })]), []);
    expect(dupes.grades).toHaveLength(1);
    expect(dupes.warnings.join()).toMatch(/graded it twice/i);
  });
});

// --- did anything survive? (attempted / kept) --------------------------------

describe('judgeRun discard accounting', () => {
  const badQuote = 'the judge made this sentence up entirely';

  it('says the run is UNGRADED when every grade is discarded', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      g({ id: 'tradeoffs', quote: badQuote }),
      g({ id: 'searched', quote: badQuote }),
    ]), []);
    expect(r.grades).toEqual([]);
    expect(r.unavailable).toBeUndefined();   // the judge answered; nothing survived
    expect(r.attempted).toBe(2);
    expect(r.kept).toBe(0);
    // Leading, so a report renders it as a header rather than burying it under
    // the per-grade lines.
    expect(r.warnings[0]).toMatch(/ungraded/i);
    expect(r.warnings[0]).toContain('2');
  });

  it('does NOT say that when a grade survived and one item was skipped', async () => {
    // The discriminating case: this run also returns `unavailable: undefined`
    // and also carries per-item warnings, and is a completely different result.
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g()]), []);
    expect(r.attempted).toBe(1);
    expect(r.kept).toBe(1);
    expect(r.warnings.join()).not.toMatch(/ungraded/i);
    expect(r.warnings.join()).toMatch(/No usable grade for "searched"/);
  });

  it('counts attempted and kept separately when some grades are discarded', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      g({ id: 'tradeoffs' }),
      g({ id: 'searched', quote: badQuote }),
    ]), []);
    expect(r.attempted).toBe(2);
    expect(r.kept).toBe(1);
    expect(r.warnings.join()).not.toMatch(/ungraded/i);
  });

  it('reports zero attempted when the judge never produced grades', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, throwingJudge(), []);
    expect(r.attempted).toBe(0);
    expect(r.kept).toBe(0);
    expect(r.warnings.join()).not.toMatch(/ungraded/i);   // `unavailable` already says so
  });
});

// --- contradicting a mechanical check ---------------------------------------

describe('judgeRun vs the mechanical checks', () => {
  // The id shape assertions.ts's `calledTool(name)` actually emits. Tool
  // evidence is read from the ID ONLY, so the detail here is realistic prose
  // (it is what that check really writes) and must contribute nothing.
  const passedGrep: CheckResult[] = [
    { id: 'called-tool:Grep', state: 'passed', detail: 'Grep was called. Tools attempted: Grep, Read.' },
  ];

  it('warns when the judge contradicts a passing check instead of averaging it in', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      { id: 'searched', score: 0, quote: '...', reason: 'It never searched the code.' },
    ]), passedGrep);
    expect(r.warnings.join()).toMatch(/contradict/i);
    expect(r.warnings.join()).toMatch(/called-tool:Grep/);
  });

  // PINS A CROSS-MODULE COUPLING THAT NOTHING ELSE HOLDS.
  //
  // judge.ts reads tool evidence by regex-matching the check ID against
  // `called-tool:` — deliberately, because the previous version scanned the
  // free-text `detail` and could print a factually INVERTED warning (a check
  // that passed by proving a tool was never used registered that tool as
  // proven). The id is a controlled vocabulary; prose is not.
  //
  // But the two halves live in different modules and were built in separate
  // worktrees. Every other test here hand-writes the string 'called-tool:Grep',
  // so if assertions.ts ever renames its prefix, the regex silently matches
  // nothing, contradiction detection goes quiet, and NOT ONE TEST FAILS. This
  // test is the only thing that would notice: it takes the id from the real
  // factory rather than retyping it.
  it('reads the id shape assertions.ts actually emits, not a hand-written copy', async () => {
    const realResult = calledTool('Grep').run(makeRun());
    expect(realResult.state).toBe('passed'); // the run above really does call Grep

    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      { id: 'searched', score: 0, quote: '...', reason: 'It never searched the code.' },
    ]), [realResult]);

    expect(r.warnings.join()).toMatch(/contradict/i);
    expect(r.warnings.join()).toContain(realResult.id);
  });

  it('leaves the score alone when it warns', async () => {
    // A contradicted grade that IS quoted still keeps its score verbatim — the
    // warning is printed next to it, never blended into it.
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      { id: 'searched', score: 0, quote: 'I read the config loader before changing anything', reason: 'It never ran Grep.' },
    ]), passedGrep);
    expect(r.grades).toEqual([expect.objectContaining({ id: 'searched', score: 0 })]);
    expect(r.warnings.join()).toMatch(/contradict/i);
  });

  it('does not warn when no check backs the denial', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      { id: 'searched', score: 0, quote: 'I read the config loader before changing anything', reason: 'It never searched the code.' },
    ]), [{ id: 'called-tool:Grep', state: 'failed', detail: 'No Grep call. Tools attempted: Read.' }]);
    expect(r.warnings.join()).not.toMatch(/contradict/i);
  });

  it('does not warn on a positive statement that merely names a tool', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      { id: 'searched', score: 5, quote: 'I read the config loader before changing anything', reason: 'It ran Grep before answering.' },
    ]), passedGrep);
    expect(r.warnings.join()).not.toMatch(/contradict/i);
  });

  it('does not read the run’s own words as a judge claim', async () => {
    // The quote is the RUN talking, not the judge. A run that honestly says it
    // never searched must not be scored as the JUDGE contradicting a check.
    const run = makeRun({ review: `${ANSWER}\n\nI never searched the code, I answered from memory.` });
    const r = await judgeRun(run, RUBRIC, fakeJudge([
      { id: 'searched', score: 1, quote: 'I never searched the code, I answered from memory.' },
    ]), passedGrep);
    expect(r.grades).toHaveLength(1);
    expect(r.warnings.join()).not.toMatch(/contradict/i);
  });

  // --- tool evidence comes from the check ID, never its detail ---------------

  it('does not treat a passing ABSENCE check as proof the tool was used', async () => {
    // The inverted-warning bug: a check asserting the model made no Write/Edit
    // calls PASSES, its detail names both tools, and a judge agreeing with it
    // ("it never wrote any code") would be warned about for contradicting a
    // check that says exactly the same thing.
    const noWrites: CheckResult[] = [
      { id: 'no-source-edits', state: 'passed', detail: 'The model made no Write or Edit calls.' },
    ];
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      { id: 'searched', score: 3, quote: 'I read the config loader before changing anything', reason: 'It never wrote any code.' },
    ]), noWrites);
    expect(r.warnings.join()).not.toMatch(/contradict/i);
  });

  it('does not let one check’s detail prove the other tools it happens to list', async () => {
    // `called-tool:Grep`'s passing detail lists every tool attempted, so a
    // detail scan would prove Read off a check that only measured Grep.
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      { id: 'searched', score: 2, quote: 'I read the config loader before changing anything', reason: 'It never read the file it was changing.' },
    ]), passedGrep);
    expect(r.warnings.join()).not.toMatch(/contradict/i);
  });

  // --- the denial must be about the tool, not merely near it -----------------

  const passedRead: CheckResult[] = [
    { id: 'called-tool:Read', state: 'passed', detail: 'Read was called. Tools attempted: Grep, Read.' },
  ];
  const passedBash: CheckResult[] = [
    { id: 'called-tool:Bash', state: 'passed', detail: 'Bash was called. Tools attempted: Bash.' },
  ];

  it.each([
    // Comma-joined: the denial is about the reasoning, the tool word is in a
    // different fragment and is not being denied at all.
    ['It never explains its reasoning, though it did read the config loader', passedRead],
    // "read like" is a comparison, not the Read tool.
    ['It does not read like someone who understood the code', passedRead],
    // "ran into" is a phrasal verb, not the Bash tool.
    ['It never ran into the real problem', passedBash],
  ])('does not warn on %s', async (reason, checks) => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      { id: 'searched', score: 2, quote: 'I read the config loader before changing anything', reason },
    ]), checks);
    expect(r.warnings.join()).not.toMatch(/contradict/i);
  });

  it('still warns when the denial and the tool share a fragment', async () => {
    // POSITIVE CONTROL for the three above: narrowing the match must not have
    // turned the whole scan off.
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      { id: 'searched', score: 0, quote: 'I read the config loader before changing anything', reason: 'It explains itself well, but it never read the config loader.' },
    ]), passedRead);
    expect(r.warnings.join()).toMatch(/contradict/i);
    expect(r.warnings.join()).toMatch(/called-tool:Read/);
  });
});

// --- failure handling: grading must never cost a paid run its results --------

describe('judgeRun failure handling', () => {
  const expectNoGrades = (r: JudgeResult) => {
    expect(r.grades).toEqual([]);
    expect(r.unavailable).toBeTruthy();
  };

  it('a broken judge never costs the run its other results', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, throwingJudge(), []);
    expectNoGrades(r);
  });

  it('carries the provider’s real message, not a guess', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, throwingJudge(new Error('OpenRouter 402: insufficient credits')), []);
    expect(r.unavailable).toContain('OpenRouter 402: insufficient credits');
  });

  it('never renders a non-Error rejection as [object Object]', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, throwingJudge({ error: { code: 402, message: 'Insufficient credits' } }), []);
    expect(r.unavailable).not.toContain('[object Object]');
    expect(r.unavailable).toContain('Insufficient credits');
  });

  it('blames this file, not the provider, when the prompt cannot be built', async () => {
    // A malformed run makes OUR prompt builder throw. That must not be reported
    // as "The judge model failed" — accurate about the text, wrong about the
    // actor, and it would send a reader to the provider's status page.
    const r = await judgeRun(makeRun({ review: undefined as unknown as string }), RUBRIC, fakeJudge([g()]), []);
    expectNoGrades(r);
    expect(r.unavailable).not.toMatch(/judge model failed/i);
    expect(r.unavailable).toMatch(/prompt/i);
    // Still the real error, never a guessed cause.
    expect(r.unavailable).toMatch(/length/);
  });

  it('survives malformed JSON and says what came back', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge('Sure! Here are my grades: tradeoffs = great'), []);
    expectNoGrades(r);
    expect(r.unavailable).toMatch(/JSON/i);
    expect(r.unavailable).toContain('Sure! Here are my grades');
  });

  it('survives an empty answer', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge(''), []);
    expectNoGrades(r);
    expect(r.unavailable).toMatch(/no text|empty/i);
  });

  it('survives valid JSON of the wrong shape', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge({ verdict: 'good' }), []);
    expectNoGrades(r);
  });

  it('reads grades out of a {grades:[...]} wrapper and a fenced block', async () => {
    const wrapped = await judgeRun(makeRun(), RUBRIC, fakeJudge({ grades: [g()] }), []);
    expect(wrapped.grades).toHaveLength(1);
    const fenced = await judgeRun(makeRun(), RUBRIC, fakeJudge('```json\n' + JSON.stringify([g()]) + '\n```'), []);
    expect(fenced.grades).toHaveLength(1);
  });

  // PREMISE FIX (fix pass 1, 2026-08-12 review, IMPORTANT 3). These two used to
  // assert the exact shape `{ grades: [], warnings: [], attempted: 0, kept: 0 }`
  // — which is BYTE-IDENTICAL to the result of a judge that was called and
  // answered `{"grades": []}`. The report could not tell the two apart and told
  // the reader "the judge returned no grades for this run" about a call that was
  // never made. The no-op is unchanged (no call, no warnings, no spend); the
  // result now SAYS which no-op it was, and these assert that rather than
  // asserting its absence. Every original assertion is still here — the object
  // is still compared whole with toEqual, so a stray warning or a phantom grade
  // still fails.
  it('is a clean no-op when there is no judge, and says that is why', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, null, []);
    expect(r).toEqual({
      grades: [], warnings: [], attempted: 0, kept: 0,
      notAttempted: 'no judge was configured for this plan, so nothing was graded and nothing was spent on grading',
    });
    // Distinguishable from "a judge answered with nothing", which is what the
    // report used to print for this shape.
    expect(r.unavailable).toBeUndefined();
  });

  it('is a clean no-op when the case has no rubric, and NEVER calls the judge', async () => {
    const seen: any[] = [];
    const r = await judgeRun(makeRun(), [], fakeJudge([g()], 'vendor/judge-model', seen), []);
    expect(r).toEqual({
      grades: [], warnings: [], attempted: 0, kept: 0,
      notAttempted: 'this case declares no rubric, so no judge call was made — nothing was asked and nothing was '
        + 'spent on grading',
    });
    // The no-op is a REAL no-op: the fake judge was never generated from, so
    // nothing would have been billed.
    expect(seen).toHaveLength(0);
  });

  it('tells the two no-op reasons apart', async () => {
    const noJudge = await judgeRun(makeRun(), RUBRIC, null, []);
    const noRubric = await judgeRun(makeRun(), [], fakeJudge([g()]), []);
    expect(noJudge.notAttempted).not.toBe(noRubric.notAttempted);
  });
});

// --- self-grading ------------------------------------------------------------

describe('judgeRun self-grading', () => {
  it('flags self-grading when the judge is also under test', async () => {
    const r = await judgeRun(
      makeRun({ modelId: 'anthropic/claude-opus-5' }), RUBRIC,
      fakeJudge([g()], 'anthropic/claude-opus-5'), [],
    );
    expect(r.warnings.join()).toMatch(/self-grad/i);
  });

  it('flags it without discarding the grades', async () => {
    const r = await judgeRun(
      makeRun({ modelId: 'anthropic/claude-opus-5' }), RUBRIC,
      fakeJudge([g()], 'anthropic/claude-opus-5'), [],
    );
    expect(r.grades).toHaveLength(1);
  });

  it('flags an OpenRouter variant suffix as the same model', async () => {
    // `:free` / `:beta` / `:nitro` pick a serving tier, not different weights —
    // exact string equality would let a model grade its own output unflagged.
    const r = await judgeRun(
      makeRun({ modelId: 'anthropic/claude-opus-5' }), RUBRIC,
      fakeJudge([g()], 'anthropic/claude-opus-5:beta'), [],
    );
    expect(r.warnings.join()).toMatch(/self-grad/i);
  });

  it('does not flag a different judge model', async () => {
    const r = await judgeRun(makeRun({ modelId: 'anthropic/claude-opus-5' }), RUBRIC, fakeJudge([g()]), []);
    expect(r.warnings.join()).not.toMatch(/self-grad/i);
  });

  it('does not flag a different model that merely shares a suffix', async () => {
    // Control for the strip above: dropping everything after ":" must not
    // collapse two genuinely different models into one.
    const r = await judgeRun(
      makeRun({ modelId: 'anthropic/claude-opus-5:free' }), RUBRIC,
      fakeJudge([g()], 'openai/gpt-6:free'), [],
    );
    expect(r.warnings.join()).not.toMatch(/self-grad/i);
  });
});

// --- what the judge is actually shown ---------------------------------------

describe('the judge prompt', () => {
  const promptText = (seen: any[]) => JSON.stringify(seen);

  it('shows the answer, the rubric asks, and the tool calls', async () => {
    const seen: any[] = [];
    await judgeRun(makeRun(), RUBRIC, fakeJudge([g()], 'vendor/judge-model', seen), []);
    const p = promptText(seen);
    expect(p).toContain('Does the answer lay out the trade-offs?');
    expect(p).toContain('I went with the lock');
    expect(p).toContain('Grep');
  });

  it('does not tell the judge which model wrote the answer', async () => {
    const seen: any[] = [];
    await judgeRun(makeRun({ modelId: 'anthropic/claude-opus-5' }), RUBRIC, fakeJudge([g()], 'vendor/judge-model', seen), []);
    expect(promptText(seen)).not.toContain('claude-opus-5');
  });
});
