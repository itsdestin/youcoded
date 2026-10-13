// The report (Task 11). Everything here is a pure string comparison — the
// renderer takes data and returns markdown, so there is no filesystem, no
// network, no key and no spend anywhere in this suite.
//
// WHAT THESE TESTS ARE FOR. Six tests on this branch have passed with the
// thing they claimed to test deleted, so every assertion below is written to
// FAIL when its mechanism is removed, not merely to find a word somewhere on a
// long page. The two that matter most carry an explicit contrast:
//   - `never ran` is asserted to render DIFFERENTLY from `passed` (an
//     assertion that only checked "the page mentions the check" would pass
//     with the three states collapsed into one).
//   - an all-discarded judge result is asserted to read as NOT GRADED and to
//     differ from a judge result that kept a grade (an assertion that only
//     checked "no grades are printed" would pass on a renderer that printed
//     nothing at all).
import { describe, it, expect } from 'vitest';
import { renderReport, type CellResult, type ReportMeta } from '../src/main/harness/eval/report';
import { cellFilename, type Cell, type EvalPlan } from '../src/main/harness/eval/matrix';
import type { CaseRun, CheckResult, RubricItem } from '../src/main/harness/eval/case-types';
// judgeRun is imported so the "no judge" tests can render the shape the
// ORCHESTRATOR really produces instead of a hand-written one — see the premise
// fix in the all-discarded group. `judge: null` makes no call and spends
// nothing, so this stays a pure, offline suite.
import { judgeRun, type JudgeResult } from '../src/main/harness/eval/judge';
import { collectRunFacts } from '../src/main/harness/eval/run-facts';
import type { TranscriptEvent } from '../src/shared/types';

// --- fixtures ---------------------------------------------------------------

// The answer every quote below is copied out of, so a reader can check these
// tests exactly the way the report asks Destin to check a grade.
const ANSWER = [
  'I read the config loader before changing anything, because the failure only',
  'shows up when two loaders race.',
  '',
  'The trade-off is between a lock and a retry: a lock is simpler to reason about',
  'but serializes every startup.',
].join('\n');

const PLAN: EvalPlan = {
  name: 'claude-md-guidance',
  cases: ['config-investigation', 'port-bump'],
  instructions: [{ id: 'none', file: null }, { id: 'draft', file: 'draft.md' }],
  models: ['Claude Opus 5'],
  judge: 'x-ai/grok-4.5',
  repeats: 1,
};

const META: ReportMeta = { startedISO: '2026-08-12T14:03:22.941Z', buildSha: 'abc1234' };

function toolUse(name: string): TranscriptEvent {
  return { type: 'tool-use', sessionId: 's', uuid: `u-${name}`, timestamp: 0, data: { toolUseId: `t-${name}`, toolName: name, toolInput: {} } };
}

function makeRun(over: Partial<CaseRun> = {}): CaseRun {
  return {
    label: 'Claude Opus 5', modelId: 'anthropic/claude-opus-5', review: ANSWER,
    events: [toolUse('Read'), toolUse('Grep')],
    toolCalls: 2, asks: 0, stepGates: 0, fixtureRoot: '/tmp/fixture', outcome: 'complete',
    metrics: {
      wallClockMs: 61_000, toolCalls: 2, asks: 0, stepGates: 0, thinkingEvents: 0,
      inputTokens: 100, outputTokens: 200, stopReasons: ['stop'], toolsUsed: ['Grep', 'Read'], repeats: [],
    },
    ...over,
  };
}

function makeCell(over: Partial<Cell> = {}): Cell {
  return {
    id: 'config-investigation|none|Claude Opus 5|current|0',
    caseId: 'config-investigation',
    instructionsId: 'none',
    instructionsFile: null,
    model: 'Claude Opus 5',
    buildId: 'current',
    dist: '/abs/dist',
    repeat: 0,
    ...over,
  };
}

const KEPT_GRADE: JudgeResult = {
  grades: [{ id: 'tradeoffs', score: 4, quote: 'a lock is simpler to reason about', reason: 'it names both sides' }],
  warnings: [],
  attempted: 2,
  kept: 1,
};

/** A judge that answered in full and had every single grade thrown away. This
 *  is the shape that used to render as an empty (green-looking) grade column. */
const ALL_DISCARDED: JudgeResult = {
  grades: [],
  warnings: [
    '⚠️ This run is effectively UNGRADED: the judge returned 3 grades and all 3 of them were discarded — 0 kept.',
    'Dropped "tradeoffs" (score 5): the quote is not in the answer.',
  ],
  attempted: 3,
  kept: 0,
};

const RUBRIC: RubricItem[] = [{ id: 'tradeoffs', ask: 'Does the answer lay out the trade-offs?' }];

/** One cell block's GRADES region — from its `**Grades**` header to the answer
 *  printed under it.
 *
 *  WHY assertions about grading are scoped to this rather than to the page: the
 *  stated-limits paragraph and the grid legend BOTH discuss grading on every
 *  report, so a page-wide `toContain('not graded')` passes with the block empty.
 *  That trap was measured on this branch once already (the grid test passed off
 *  the legend until it was narrowed), so it is a helper now. */
function gradeBlockOf(page: string): string {
  const start = page.indexOf('**Grades**');
  if (start < 0) throw new Error(`no **Grades** block on this page:\n${page}`);
  const end = page.indexOf('**The answer, verbatim**', start);
  return page.slice(start, end < 0 ? undefined : end);
}

/** One cell block's CHECKS region, scoped for the same reason. */
function checkBlockOf(page: string): string {
  const start = page.indexOf('**Checks**');
  if (start < 0) throw new Error(`no **Checks** block on this page:\n${page}`);
  return page.slice(start, page.indexOf('**Grades**', start));
}

function ok(over: Partial<CellResult> = {}): CellResult {
  const run = over.run ?? makeRun();
  return {
    cell: makeCell(),
    run,
    checks: [{ id: 'calledTool:Grep', state: 'passed', detail: 'Grep was called' }],
    judge: KEPT_GRADE,
    facts: collectRunFacts(run, 2),
    ...over,
  };
}

// --- the brief's four -------------------------------------------------------

describe('renderReport', () => {
  it('is pure — same input, byte-identical output', () => {
    expect(renderReport(PLAN, [ok()], META)).toBe(renderReport(PLAN, [ok()], META));
  });

  it('states the single-run caveat when repeats is 1', () => {
    expect(renderReport({ ...PLAN, repeats: 1 }, [ok()], META)).toMatch(/one run per combination/i);
  });

  it('names cells that never ran rather than omitting them', () => {
    const out = renderReport(PLAN, [], META);
    expect(out).toMatch(/did not run/i);
    // …and names them individually, so "what did I not get" is a list, not an
    // inference from empty squares.
    expect(out).toContain('config-investigation · draft · Claude Opus 5');
    expect(out).toContain('port-bump · none · Claude Opus 5');
  });

  it('shows never-ran checks distinctly from passed ones', () => {
    const neverRan: CheckResult = { id: 'noToolErrors', state: 'never-ran', detail: 'no tool calls, nothing to check' };
    expect(renderReport(PLAN, [ok({ checks: [neverRan] })], META)).toMatch(/never ran/i);
  });
});

// --- item 1: never-ran is not a pass, and the page says so differently -------

describe('a check that never ran is not a check that passed', () => {
  const ID = 'noToolErrors';
  const DETAIL = 'no tool calls were made, so there was nothing to check';

  function render(state: CheckResult['state']): string {
    return renderReport(PLAN, [ok({ checks: [{ id: ID, state, detail: DETAIL }] })], META);
  }

  it('renders the two states as different text, not just different icons', () => {
    // THE DISCRIMINATING ASSERTION. Both pages name the check and its detail,
    // so an assertion of the form `expect(out).toContain('noToolErrors')`
    // passes on a renderer that collapsed the three states into one. These do
    // not: the two pages must differ, and each must carry its own state word
    // while carrying neither the other's.
    const passed = render('passed');
    const never = render('never-ran');
    expect(never).not.toBe(passed);
    expect(never).toContain('NEVER RAN');
    expect(never).not.toContain('PASSED');
    expect(passed).toContain('PASSED');
    expect(passed).not.toContain('NEVER RAN');
  });

  it('counts it as its own state in the at-a-glance grid, not in the pass count', () => {
    expect(render('never-ran')).toContain('1 never ran');
    expect(render('never-ran')).not.toContain('1 passed');
    expect(render('passed')).toContain('1 passed');
  });

  it('says on the page that never-ran is not a pass, for a reader who has never seen this tool', () => {
    expect(render('never-ran')).toMatch(/not\*{0,2} a pass/i);
  });

  it('renders a whole 402-ed run without a single pass mark', () => {
    // The run every cell of which failed at the provider. Rendering this green
    // would be a lie about a run that was paid for.
    const dead: CellResult[] = PLAN.cases.flatMap((caseId) => PLAN.instructions.map((arm) => ({
      cell: makeCell({ caseId, instructionsId: arm.id, id: `${caseId}|${arm.id}|Claude Opus 5|current|0` }),
      run: null,
      error: 'provider returned HTTP 402: insufficient credits',
    })));
    const out = renderReport(PLAN, dead, META);
    expect(out).not.toContain('✅');
    // The provider's real words, not a summary of them.
    expect(out).toContain('provider returned HTTP 402: insufficient credits');
    expect(out).toMatch(/0 of 4/);
  });
});

// --- item 2: all grades discarded reads as ungraded --------------------------

describe('a run whose grades were all discarded is ungraded, not clean', () => {
  const discarded = renderReport(PLAN, [ok({ judge: ALL_DISCARDED })], META);
  const graded = renderReport(PLAN, [ok({ judge: KEPT_GRADE })], META);

  it('says NOT GRADED and explains that an empty grade list is not "no issues found"', () => {
    // THE DISCRIMINATING ASSERTION. `grades: []` and a kept grade must not
    // produce the same page, and the discarded one must be positively labelled
    // — an assertion of the form "no grade line is printed" would also pass on
    // a renderer that printed nothing for either.
    expect(discarded).not.toBe(graded);
    expect(discarded).toContain('NOT GRADED');
    expect(discarded).toMatch(/discarded/i);
    expect(discarded).toMatch(/not "no issues found"|not \*\*"no issues found"/i);
    expect(graded).not.toContain('NOT GRADED');
  });

  it('marks the square as not graded in the grid instead of leaving it blank', () => {
    // Asserted against the GRID ROW, not the whole page: the legend explains
    // what `not graded` means on every report, so a page-wide `toContain`
    // passes even with the grid rendering an empty column — measured, this
    // test did exactly that until it was narrowed.
    const row = (page: string) => page.split('\n').find((l) => l.startsWith('| config-investigation |'))!;
    expect(row(discarded)).toMatch(/not graded/i);
    expect(row(graded)).not.toMatch(/not graded/i);
    expect(row(graded)).toContain('grades 4/5');
  });

  it('never prints a score total for a run with no kept grades', () => {
    expect(discarded).not.toMatch(/^Total:/m);
    expect(graded).toMatch(/^Total: 4\/5 \(1 of 2 rubric items kept\)\./m);
  });

  it('distinguishes "the judge never answered" from "the judge answered and was discarded"', () => {
    const unavailable = renderReport(PLAN, [ok({
      judge: { grades: [], warnings: [], attempted: 0, kept: 0, unavailable: 'The judge model failed: HTTP 402' },
    })], META);
    expect(unavailable).toContain('The judge model failed: HTTP 402');
    expect(unavailable).not.toMatch(/discarded/i);
  });

  // PREMISE FIX (fix pass 1, 2026-08-12 review, IMPORTANT 3). This test used to
  // pass `judge: undefined` — a shape the ORCHESTRATOR CANNOT PRODUCE, because
  // gradeCell always assigns the result of judgeRun. So it was green while the
  // real path printed "the judge returned no grades for this run": an assertion
  // about a call that was never made, on the page someone reads to decide how to
  // spend money. The fix is to stop hand-writing the shape and let the real
  // judgeRun produce it — `judge: null` means no judge, needs no network, no key
  // and no spend, and is exactly what gradeCell passes when a plan names none.
  it('says so when no judge was configured at all, on the shape the orchestrator really produces', async () => {
    const run = makeRun();
    const real = await judgeRun(run, RUBRIC, null, []);
    const out = renderReport({ ...PLAN, judge: null }, [ok({ run, judge: real })], META);
    // Scoped to the cell's grade block, not the page: the limits section and the
    // grid legend both talk about grading, so a page-wide match proves nothing.
    expect(gradeBlockOf(out)).toMatch(/no judge was configured/i);
    // The sentence that used to print here — about a judge that answered.
    expect(gradeBlockOf(out)).not.toMatch(/the judge returned no grades/i);
  });

  it('does not claim a judge answered when the case has no rubric', async () => {
    const run = makeRun();
    // A judge IS configured; the case has no rubric, so judgeRun makes no call.
    const real = await judgeRun(run, [], { modelId: 'x-ai/grok-4.5', factory: async () => { throw new Error('the judge must not be called'); } }, []);
    const block = gradeBlockOf(renderReport(PLAN, [ok({ run, judge: real })], META));
    expect(block).toMatch(/no judge call was made/i);
    expect(block).not.toMatch(/the judge returned no grades/i);
  });

  it('still says a judge answered with nothing when it really did', () => {
    // The other side of the same coin: `{"grades": []}` parses to attempted 0
    // with no `unavailable` and no `notAttempted`, and that sentence must
    // survive — it is the one case where a judge really did return nothing.
    const block = gradeBlockOf(renderReport(PLAN, [ok({
      judge: { grades: [], warnings: [], attempted: 0, kept: 0 },
    })], META));
    expect(block).toMatch(/the judge returned no grades/i);
  });

  it('reports a grading failure in the words of whatever failed', () => {
    const out = renderReport(PLAN, [ok({ judge: undefined, gradingError: 'EACCES: permission denied' })], META);
    expect(out).toContain('EACCES: permission denied');
  });

  it('does not let a grading failure delete grades the judge already returned', () => {
    // Fix pass 1 (2026-08-12 review, MINOR 2). gradeCell writes .grades.json
    // AFTER judgeRun, inside the same try — so a failed write landed in
    // `gradingError` and the whole block rendered NOT GRADED, throwing away
    // grades that had already been paid for.
    const out = renderReport(PLAN, [ok({ judge: KEPT_GRADE, gradingError: 'ENOSPC: no space left on device' })], META);
    const block = gradeBlockOf(out);
    // The grades survive, with their score and their quote…
    expect(block).toContain('**tradeoffs** — 4/5');
    expect(block).toContain('a lock is simpler to reason about');
    expect(block).not.toContain('NOT GRADED');
    // …and the failure is still on the page, in the real words, above them.
    expect(block).toContain('ENOSPC: no space left on device');
    expect(block.indexOf('ENOSPC')).toBeLessThan(block.indexOf('**tradeoffs**'));
  });

  it('still renders NOT GRADED when the grading failure left no grades at all', () => {
    // The control for the test above: suppressing NOT GRADED unconditionally
    // would be a worse bug than the one being fixed.
    const block = gradeBlockOf(renderReport(PLAN, [ok({
      judge: { grades: [], warnings: [], attempted: 0, kept: 0 }, gradingError: 'EACCES: permission denied',
    })], META));
    expect(block).toContain('NOT GRADED');
    expect(block).toContain('EACCES: permission denied');
  });
});

// --- IMPORTANT 4: checks that could not be evaluated are not a fact ----------

describe('checks that were never recorded are not "this case declares none"', () => {
  it('renders an absent check list differently from an empty one', () => {
    // gradeCell can leave `checks` undefined (anything in the grading step that
    // throws before they are recorded). Rendering that as "declares no checks"
    // states a definite fact about the CASE, invented from missing data — the
    // never-ran failure one level up.
    const notRecorded = renderReport(PLAN, [ok({ checks: undefined })], META);
    const declaresNone = renderReport(PLAN, [ok({ checks: [] })], META);
    expect(notRecorded).not.toBe(declaresNone);
    expect(checkBlockOf(notRecorded)).toMatch(/NOT RECORDED/);
    expect(checkBlockOf(notRecorded)).not.toMatch(/declares no mechanical checks/i);
    expect(checkBlockOf(declaresNone)).toMatch(/declares no mechanical checks/i);
    expect(checkBlockOf(declaresNone)).not.toMatch(/NOT RECORDED/);
  });

  it('says so in the grid square too, where a reader looks first', () => {
    const row = (page: string) => page.split('\n').find((l) => l.startsWith('| config-investigation |'))!;
    expect(row(renderReport(PLAN, [ok({ checks: undefined })], META))).toMatch(/checks not recorded/i);
    expect(row(renderReport(PLAN, [ok({ checks: [] })], META))).toMatch(/no checks/);
    expect(row(renderReport(PLAN, [ok({ checks: [] })], META))).not.toMatch(/not recorded/i);
  });
});

// --- IMPORTANT 2: builds are an axis, in the count AND in the missing list ---

describe('a plan with two build arms', () => {
  const TWO_BUILDS: EvalPlan = {
    ...PLAN,
    cases: ['config-investigation'],
    instructions: [{ id: 'none', file: null }],
    builds: [{ id: 'master', dist: '/abs/master' }, { id: 'branch', dist: '/abs/branch' }],
  };

  function resultFor(buildId: string): CellResult {
    return ok({
      cell: makeCell({ buildId, id: `config-investigation|none|Claude Opus 5|${buildId}|0` }),
    });
  }

  /** The `N of M` clause of the header line, on its own. */
  function headerCount(page: string): string {
    return page.split('\n').find((l) => l.startsWith('**Started**'))!;
  }

  it('counts both arms as planned cells', () => {
    // The bug: `planned` multiplied cases x instructions x models x repeats and
    // skipped `builds`, which expandPlan multiplies by — so two builds both
    // running printed "**2 of 1** planned cell produced a run".
    const out = renderReport(TWO_BUILDS, [resultFor('master'), resultFor('branch')], META);
    expect(headerCount(out)).toContain('**2 of 2** planned cells');
  });

  it('names the build arm that never ran instead of reporting a full house', () => {
    // The worse half: `missing` keyed on case x arm x model, which structurally
    // cannot see a build. A branch-vs-master run where the branch arm never
    // started printed "None — every combination produced at least one result".
    const out = renderReport(TWO_BUILDS, [resultFor('master')], META);
    expect(headerCount(out)).toContain('**1 of 2** planned cells');
    const section = out.slice(out.indexOf('## Combinations that did not run'), out.indexOf('## The answers'));
    expect(section).toContain('build branch');
    expect(section).not.toMatch(/^None —/m);
    // …and it does not invent a missing master arm, which did run.
    expect(section).not.toContain('build master');
  });

  it('leaves the build off the line when there is only one arm', () => {
    // Otherwise every line on every single-build report carries the same word.
    // The plan NAMES its one build: measured, a version of this test that used a
    // build-less plan did not discriminate, because breaking the label then
    // printed "build null" and the assertion below was looking for the id.
    const out = renderReport({ ...PLAN, builds: [{ id: 'current', dist: '/abs/dist' }] }, [], META);
    const section = out.slice(out.indexOf('## Combinations that did not run'), out.indexOf('## The answers'));
    expect(section).toContain('config-investigation · draft · Claude Opus 5');
    expect(section).not.toContain('build current');
  });
});

// --- MINOR 1: "None" must not print under a header that says 0 of 4 ----------

describe('the did-not-run list is keyed on a RUN, not on a result object', () => {
  it('lists every combination of an all-402 matrix instead of claiming a full house', () => {
    const dead: CellResult[] = PLAN.cases.flatMap((caseId) => PLAN.instructions.map((arm) => ({
      cell: makeCell({ caseId, instructionsId: arm.id, id: `${caseId}|${arm.id}|Claude Opus 5|current|0` }),
      run: null,
      error: 'provider returned HTTP 402: insufficient credits',
    })));
    const out = renderReport(PLAN, dead, META);
    const section = out.slice(out.indexOf('## Combinations that did not run'), out.indexOf('## The answers'));
    // The header says 0 of 4; this section used to say the opposite two screens
    // below it, because a 402'd CellResult counted as the combination "running".
    expect(out).toMatch(/\*\*0 of 4\*\*/);
    expect(section).not.toMatch(/None —/);
    expect(section).toContain('config-investigation · none · Claude Opus 5');
    // And it distinguishes the two ways a combination can be missing: this one
    // was attempted and billed, which is not the same as never starting.
    expect(section).toMatch(/attempted, but produced no run/);
    expect(section).not.toMatch(/never started/);
  });

  it('explains a shortfall that is only repeats, rather than leaving it contradicting the header', () => {
    const twoRepeats = { ...PLAN, cases: ['config-investigation'], instructions: [{ id: 'none', file: null }], repeats: 2 };
    const out = renderReport(twoRepeats, [ok()], META);
    const section = out.slice(out.indexOf('## Combinations that did not run'), out.indexOf('## The answers'));
    expect(section).toMatch(/None — every combination/);
    // Every combination ran, and the header still says 1 of 2. The page must
    // account for the gap rather than leaving two numbers disagreeing.
    expect(section).toMatch(/1 of the 2 planned cells still produced no run/);
    expect(section).toMatch(/repeats of combinations that did run/);
  });
});

// --- item 3: warnings above the grades, never inside a score -----------------

describe('judge warnings', () => {
  const CONTRADICTION = '⚠️ Contradiction — the judge\'s note says "it never searched the code", '
    + 'but the mechanical check calledTool:Grep PASSED (Grep was called).';

  const out = renderReport(PLAN, [ok({
    judge: { ...KEPT_GRADE, warnings: [CONTRADICTION] },
  })], META);

  it('prints above the grades, not folded into the score', () => {
    const warningAt = out.indexOf('Contradiction —');
    const gradeAt = out.indexOf('**tradeoffs**');
    expect(warningAt).toBeGreaterThan(-1);
    expect(gradeAt).toBeGreaterThan(-1);
    expect(warningAt).toBeLessThan(gradeAt);
    // The score is exactly what the judge gave. A warning must not have
    // discounted it.
    expect(out).toContain('**tradeoffs** — 4/5');
  });

  it('tells the reader the contradiction scan is heuristic and can be dismissed', () => {
    expect(out).toMatch(/heuristic/i);
  });

  it('surfaces the warning count in the grid so a warned square is visible at a glance', () => {
    expect(out).toMatch(/1 judge warning/);
  });
});

// --- item 4: self-grading ----------------------------------------------------

describe('self-grading', () => {
  it('is flagged on the rows it affects when the judge is also under test', () => {
    const out = renderReport(
      { ...PLAN, judge: 'anthropic/claude-opus-5' },
      [ok({ run: makeRun({ modelId: 'anthropic/claude-opus-5' }) })],
      META,
    );
    expect(out).toMatch(/self-grading/i);
    expect(out).toContain('anthropic/claude-opus-5');
  });

  it('is flagged even when the judge call itself failed, and not when the models differ', () => {
    // The warning judge.ts emits only exists when a call was made. Self-grading
    // is just as true on a row whose judge 402'd.
    const failed = renderReport(
      { ...PLAN, judge: 'anthropic/claude-opus-5' },
      [ok({
        run: makeRun({ modelId: 'anthropic/claude-opus-5:beta' }),
        judge: { grades: [], warnings: [], attempted: 0, kept: 0, unavailable: 'HTTP 402' },
      })],
      META,
    );
    expect(failed).toMatch(/self-grading/i);
    expect(renderReport(PLAN, [ok()], META)).not.toMatch(/self-grading/i);
  });
});

// --- item 5: every grade shows its quote -------------------------------------

describe('grades carry their evidence', () => {
  it('prints the verbatim quote next to every grade', () => {
    const out = renderReport(PLAN, [ok()], META);
    expect(out).toContain('a lock is simpler to reason about');
    // …and the answer it was taken from is on the same page, so the quote can
    // be found with Ctrl-F rather than by opening a transcript.
    expect(out).toContain(ANSWER);
  });

  it('prints the answer byte-for-byte even when it contains code fences and blank runs', () => {
    const awkward = 'Here is the fix:\n\n```ts\nconst x = 1;\n```\n\n\nAnd that is all.';
    const out = renderReport(PLAN, [ok({ run: makeRun({ review: awkward }) })], META);
    expect(out).toContain(awkward);
  });
});

// --- item 7: the stated limits, unconditionally ------------------------------

describe('the stated limits print unconditionally', () => {
  it('prints the no-resume note on a complete run and on a stopped one', () => {
    expect(renderReport(PLAN, [ok()], META)).toMatch(/no resume/i);
    expect(renderReport(PLAN, [], { ...META, stopReason: 'the cap tripped' })).toMatch(/no resume/i);
  });

  it('says plainly that a single small difference is not a finding', () => {
    expect(renderReport(PLAN, [ok()], META)).toMatch(/62 and another 58/);
  });

  it('still warns about the sample size when repeats is greater than 1', () => {
    const out = renderReport({ ...PLAN, repeats: 3 }, [ok()], META);
    expect(out).toMatch(/3 runs per combination/i);
    expect(out).toMatch(/noise, not a finding/i);
  });

  it('surfaces a stop reason at the top, in the words of whatever stopped it', () => {
    const out = renderReport(PLAN, [ok()], { ...META, stopReason: '--max-spend $8.00 reached' });
    expect(out).toContain('--max-spend $8.00 reached');
    expect(out.indexOf('--max-spend $8.00 reached')).toBeLessThan(out.indexOf('## At a glance'));
  });
});

// --- the grid, and the path to the transcripts -------------------------------

describe('the at-a-glance grid', () => {
  it('puts the instruction arms side by side on one row per task', () => {
    const results = PLAN.instructions.map((arm) => ok({
      cell: makeCell({ instructionsId: arm.id, id: `config-investigation|${arm.id}|Claude Opus 5|current|0` }),
    }));
    const out = renderReport(PLAN, results, META);
    const row = out.split('\n').find((l) => l.startsWith('| config-investigation |'));
    expect(row).toBeDefined();
    // Two arms means two data columns on the row: three `|` separators plus the
    // leading and trailing one.
    expect(row!.split('|').length - 2).toBe(3);
    expect(out).toContain('| task | none | draft |');
  });

  it('labels each run separately when a square holds more than one', () => {
    const results = [0, 1].map((repeat) => ok({
      cell: makeCell({ repeat, id: `config-investigation|none|Claude Opus 5|current|${repeat}` }),
    }));
    const out = renderReport({ ...PLAN, repeats: 2 }, results, META);
    expect(out).toContain('`current#0`');
    expect(out).toContain('`current#1`');
  });

  it('names each transcript with cellFilename, never the raw cell id', () => {
    const cell = makeCell();
    const out = renderReport(PLAN, [ok({ cell })], META);
    expect(out).toContain(`${cellFilename(cell)}.json`);
    // The raw id carries '|' (illegal on Windows) and spaces from roster
    // labels, so it must never appear as a filename.
    expect(out).not.toContain(`${cell.id}.json`);
  });

  it('carries the run facts, so a reader can see how much work a grade is based on', () => {
    const out = renderReport(PLAN, [ok()], META);
    expect(out).toContain('**Run facts:**');
    expect(out).toContain('**Tools actually used:** Grep, Read');
  });
});
