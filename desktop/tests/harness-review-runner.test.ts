import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { makeOpenRouterFactory } from '../src/main/harness/eval/openrouter-factory';
import { appendReview } from '../src/main/harness/eval/append-review';
import { runCase, STEP_GATE_ALLOWANCE, BATTERY_MAX_OUTPUT_TOKENS, BATTERY_STEP_BUDGET, BATTERY_HARNESS, WRAP_UP_PROMPT, REPEAT_REPORT_FLOOR, assertHistoryBudget, DEFAULT_BATTERY_CONTEXT_LENGTH, BATTERY_CONTEXT_CAP } from '../src/main/harness/eval/run-case';
import { collectRunFacts, claimedTools, renderRunFacts, MIN_TOOL_CALLS } from '../src/main/harness/eval/run-facts';
import { scriptModel, type ScriptStep } from './helpers/harness-fakes';
import { textChunks, toolCallChunk, finishChunk, stream } from './helpers/scripted-model';

// runCase's OWN wall-clock deadline, for the tests where the deadline is not the
// subject — which is all of them but one (the `timeoutMs: 200` case below, whose
// whole point is `wrapUpReason === 'timeout'`).
//
// Set far ABOVE vitest's per-test budget on purpose. These tests had their own
// 5s/30s/60s deadlines, which meant two independent clocks racing to end the same
// run — and under load the wrong one won: six concurrent full suites produced
// `expected 'timeout' to be 'budget'`, i.e. runCase's 60s deadline beat the STEP
// budget the test was actually asserting about. That reports as a wrong VALUE,
// which reads like a logic bug in the wrap-up reasoning, rather than as "this was
// slow". With a single authority, a genuine hang is always reported by vitest as
// a timeout and never disguised as a wrong-value assertion.
const NOT_THE_DEADLINE_MS = 10 * 60_000;


// Per-test budget for the full-budget runs in this file. It is a named constant
// rather than a literal repeated at ten call sites because it has now been
// raised twice for the same reason, and the next person needs one place to
// change and a record of what the number is measured against.
//
// Measured 2026-08-28 on a 32-core box: this file takes 25s of test time in
// isolation, by far the heaviest in the suite — each of these tests drives 200
// tool calls through a real HarnessSession, and none of that time is sleeping
// (run-case.ts has no artificial delay; it is genuine CPU work). Under three
// concurrent full-suite runs the slowest of them took 30,289ms and failed
// against its old 30,000ms budget — a false red on code that was fine. 120s is
// ~4x the worst figure actually observed under contention.
//
// The cost of a generous budget is that a genuinely hung test here takes two
// minutes to report. That is the right trade: this file's timeouts have never
// once caught a real hang, and have three times been mistaken for logic bugs.
const HEAVY_RUN_TIMEOUT_MS = 120_000;

// FILE-WIDE, not per-test (2026-09-02). The budget above was applied by hand to
// each heavy `it()`, and the note further down says "EVERY test below ... needs
// an explicit `}, HEAVY_RUN_TIMEOUT_MS)`". Relying on every author to remember
// that is what failed: `survives the max_steps gate up to STEP_GATE_ALLOWANCE`
// sits ABOVE that note, drives (STEP_GATE_ALLOWANCE * BATTERY_STEP_BUDGET) tool
// calls through a real HarnessSession, and had no budget at all — so it ran on
// the suite-wide 30s. Measured 2026-09-02: with eight full suites running at
// once it timed out at 30,000ms in 4 of 8 runs, and passed 11/11 when the suite
// ran alone or 6-way concurrent. Setting it here covers every test in the file,
// including ones nobody has written yet. The explicit `}, HEAVY_RUN_TIMEOUT_MS)`
// arguments below are now redundant; they are left in place because they also
// document, at the test, that it is one of the heavy ones.
vi.setConfig({ testTimeout: HEAVY_RUN_TIMEOUT_MS, hookTimeout: HEAVY_RUN_TIMEOUT_MS });


describe('makeOpenRouterFactory', () => {
  it('refuses to build without a key, naming the env var to set', () => {
    expect(() => makeOpenRouterFactory('', 'x/y')).toThrow(/OPENROUTER_API_KEY/);
  });

  it('returns a factory that resolves a model without touching Electron', async () => {
    // The whole point: no app.whenReady(), no safeStorage, no userData. If this
    // ever needs Electron, the runner stops being a plain Node script.
    const factory = makeOpenRouterFactory('sk-test', 'moonshotai/kimi-k3');
    const model = await factory({ providerId: 'openrouter', modelId: 'moonshotai/kimi-k3' });
    expect(model).toBeTruthy();
  });
});

// Regression test for the 2026-08-10 incident: OpenRouter reserves the FULL
// requested max_tokens against the account balance up front, regardless of
// actual usage. Leaving harness-session's maxOutputTokens unset (the
// ASSISTANT_PRESET default) lets the provider fall back to the MODEL's own
// max output — 65,536 for Claude Opus 5 — and the account failed twice with
// "requested up to 65536 tokens, but can only afford 63293" even though
// Opus's last successful battery run used only 8,379 output tokens total.
// runCase must send an explicit, proportionate ceiling instead of
// inheriting that undefined-maximum behavior. Real HarnessSession.opts.harness
// (ai/test's MockLanguageModelV4 records every doStream call's options in
// doStreamCalls, which is how this proves the SENT value, not an inferred one).
describe('runCase output ceiling (2026-08-10 incident)', () => {
  it('caps maxOutputTokens instead of leaving it unset (which lets OpenRouter reserve the model max)', async () => {
    const model = scriptModel([{ text: 'Final review.' }]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.review).toBe('Final review.');
    expect(model.doStreamCalls.length).toBeGreaterThan(0);
    for (const call of model.doStreamCalls) {
      expect(call.maxOutputTokens).toBe(BATTERY_MAX_OUTPUT_TOKENS);
    }
    // The measured ceiling must stay well under a model's typical hosted max
    // (65,536 was the number that broke Opus) so the upfront reservation is
    // never absurd relative to real usage.
    expect(BATTERY_MAX_OUTPUT_TOKENS).toBeLessThan(65_536);
  });
});

describe('battery step budget', () => {
  it('keeps an explicit evaluator maxSteps of 100', () => {
    expect(BATTERY_STEP_BUDGET).toBe(100);
    expect(BATTERY_HARNESS.limits?.maxSteps).toBe(100);
  });

  it('allows exactly one budget continuation before the gate means something', () => {
    expect(STEP_GATE_ALLOWANCE).toBe(1);
  });
});

const DOC = `# Native Agent Harness Reviews

Intro text.

---

## Review: Existing Model — 2026-08-01

Body of an existing review.

---

## Prompt for other agents

Prompt block here.
`;

// Fix (2026-08-10 incident): appendReview used to take a day-granularity
// `dateISO` (e.g. '2026-08-06'). The battery ran three times in one day and
// produced byte-identical-looking headings for the same model — the doc
// couldn't say which review came from which run. The third argument is now a
// full ISO timestamp; tests below use a fixed instant so heading assertions
// stay deterministic.
const RUN_AT = '2026-08-06T09:15:00.000Z';

// Regression fixture for the 2026-08-10 incident: 14 tool calls (13 Read, one
// Glob, one Bash), a review describing Edit/replace_all tests that never
// happened, appended as a genuine review with nothing checking it against the
// transcript. These tests drive run-facts.ts, the module that now does.
const BASE_METRICS = {
  wallClockMs: 230_000, toolCalls: 58, asks: 2, stepGates: 0, thinkingEvents: 232,
  inputTokens: 100_000, outputTokens: 8_379, stopReasons: ['end_turn'],
  toolsUsed: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'], repeats: [],
};
const baseRun = (over: Partial<any> = {}) => ({
  label: 'Fake', modelId: 'fake/model', review: 'A review.', events: [],
  toolCalls: 58, asks: 2, stepGates: 0, fixtureRoot: '/tmp/x',
  outcome: 'complete' as const, metrics: BASE_METRICS, ...over,
});

describe('claimedTools', () => {
  it('finds tool names named in the review', () => {
    expect(claimedTools('I tested Edit and Grep, then Read the file.'))
      .toEqual(['Edit', 'Grep', 'Read']);
  });

  it('matches whole words only, so prose is not mistaken for a tool name', () => {
    // "Reading", "edited", "globbing" must NOT count as Read / Edit / Glob.
    expect(claimedTools('Reading the file, I edited it while globbing.')).toEqual([]);
  });

  it('does not mistake TodoWrite for Write, a compound name in the real roster', () => {
    expect(claimedTools('TodoWrite ran fine')).not.toContain('Write');
  });
});

describe('collectRunFacts', () => {
  it('flags a tool the review claims but the transcript never shows', () => {
    // The exact Qwen 3.6 35B A3B shape: 14 calls, none of them Edit, review
    // describing Edit tests in detail.
    const facts = collectRunFacts(baseRun({
      review: 'Edit refused a duplicate string, and replace_all worked as documented.',
      toolCalls: 14,
      metrics: { ...BASE_METRICS, toolCalls: 14, toolsUsed: ['Bash', 'Glob', 'Read'] },
    }));
    expect(facts.unbackedClaims).toEqual(['Edit']);
  });

  it('does not flag a tool the review claims AND the transcript shows', () => {
    const facts = collectRunFacts(baseRun({ review: 'Edit and Read both behaved.' }));
    expect(facts.unbackedClaims).toEqual([]);
  });

  it('flags a run below the tool-call floor', () => {
    // Qwen 3.6 27B made two calls. Whatever follows two calls is not a review
    // of ten tools.
    const facts = collectRunFacts(baseRun({
      toolCalls: 2, metrics: { ...BASE_METRICS, toolCalls: 2, toolsUsed: ['Read'] },
    }));
    expect(facts.belowFloor).toBe(true);
    expect(MIN_TOOL_CALLS).toBe(10);
  });
});

describe('renderRunFacts', () => {
  it('states what the run actually did', () => {
    const out = renderRunFacts(collectRunFacts(baseRun()));
    expect(out).toContain('58 tool calls');
    expect(out).toContain('232 thinking');
    expect(out).toContain('Bash, Edit, Glob, Grep, Read, Write');
  });

  it('leads with a warning blockquote when a claim is unbacked', () => {
    const out = renderRunFacts(collectRunFacts(baseRun({
      review: 'Edit refused a duplicate string.',
      metrics: { ...BASE_METRICS, toolsUsed: ['Read'] },
    })));
    expect(out.startsWith('> ')).toBe(true);
    expect(out).toContain('Edit');
    // Flags, does not judge — the wording must not assert the review is false.
    expect(out.toLowerCase()).not.toContain('fabricat');
  });

  it('has no warning blockquote for a clean run', () => {
    expect(renderRunFacts(collectRunFacts(baseRun())).startsWith('> ')).toBe(false);
  });

  // ROADMAP L161: the biller's own figure replaces the hand-copied roster
  // average. It is printed only when the run carries one — a run where the
  // provider reported nothing must not read as free.
  it('prints what the provider billed when the run carries it, and nothing when it does not', () => {
    const billed = renderRunFacts(collectRunFacts(baseRun({
      metrics: { ...BASE_METRICS, providerCostUsd: 0.2731 },
    })));
    expect(billed).toContain('provider billed $0.27');
    const silent = renderRunFacts(collectRunFacts(baseRun()));
    expect(silent).not.toContain('provider billed');
    expect(silent).not.toContain('$0');
  });
});

describe('appendReview', () => {
  it('inserts the new section above the prompt block, not at the end of the file', () => {
    // Subject here is insertion position, not the facts block, so runFacts is
    // left blank per the brief's guidance for these tests.
    const out = appendReview(
      DOC,
      { label: 'New Model', modelId: 'v/new', review: 'My review.', buildSha: 'abc1234', runFacts: '' },
      RUN_AT,
    );
    expect(out.indexOf('## Review: New Model')).toBeLessThan(out.indexOf('## Prompt for other agents'));
  });

  it('leaves every existing review byte-identical', () => {
    const out = appendReview(
      DOC,
      { label: 'New Model', modelId: 'v/new', review: 'My review.', buildSha: 'abc1234', runFacts: '' },
      RUN_AT,
    );
    expect(out).toContain('## Review: Existing Model — 2026-08-01\n\nBody of an existing review.');

    // A substring-presence check only proves that text exists SOMEWHERE in the
    // output — it would still pass if the new section duplicated the existing
    // one, reordered content, or corrupted the intro/separators outside that one
    // substring. Prove byte-identity for real: the output must equal the
    // original document with exactly one contiguous block inserted at exactly
    // one point (right above the prompt heading). Splitting the original at that
    // point and comparing both halves against the corresponding slices of `out`
    // establishes nothing outside the inserted block changed, in either direction.
    const insertAt = DOC.indexOf('## Prompt for other agents');
    expect(out.slice(0, insertAt)).toBe(DOC.slice(0, insertAt));
    expect(out.slice(out.indexOf('## Prompt for other agents'))).toBe(DOC.slice(insertAt));
  });

  it('signs the section with the model label, id, and heading timestamp', () => {
    const out = appendReview(
      DOC,
      { label: 'New Model', modelId: 'v/new', review: 'My review.', buildSha: 'abc1234', runFacts: '' },
      RUN_AT,
    );
    // Minute-precision time is now part of the heading — see the fix comment
    // on `stamp` in append-review.ts for why day-granularity alone caused the
    // 2026-08-10 duplicate-heading incident.
    expect(out).toContain('## Review: New Model — 2026-08-06 09:15');
    expect(out).toContain('v/new');
    // Build identity is verbose (a git SHA), so it lives on the metadata line
    // rather than the heading — still greppable, just not at heading level.
    expect(out).toContain('abc1234');
  });

  it('refuses to write an empty review rather than adding a hollow section', () => {
    expect(() =>
      appendReview(DOC, { label: 'X', modelId: 'v/x', review: '   ', buildSha: 'abc1234', runFacts: '' }, RUN_AT),
    ).toThrow(/empty/i);
  });

  it('appends at the end when the doc has no prompt block', () => {
    const out = appendReview('# Doc\n', { label: 'X', modelId: 'v/x', review: 'r', buildSha: 'abc1234', runFacts: '' }, RUN_AT);
    expect(out).toContain('## Review: X — 2026-08-06 09:15');
  });

  it('two runs of the same model on the same day get distinguishable headings, not identical ones', () => {
    // Root cause reproduction: the battery ran three times in one day and the
    // heading only carried a DATE, so Grok 4.5 / GPT 5.6 Luna / Deepseek v4
    // flash 0731 each produced two byte-identical-looking "## Review: <label>
    // — <date>" headings with nothing distinguishing which run was which.
    // Appending twice for the same model on the same calendar day but at
    // different times (as two real runs on the same day would) must now
    // produce two DIFFERENT headings, checkable via `grep '^## Review:'`
    // without opening either body.
    const firstRunDoc = appendReview(
      DOC,
      { label: 'Grok 4.5', modelId: 'x-ai/grok-4.5', review: 'First run review.', buildSha: 'aaa1111', runFacts: '' },
      '2026-08-10T09:00:00.000Z',
    );
    const bothRunsDoc = appendReview(
      firstRunDoc,
      { label: 'Grok 4.5', modelId: 'x-ai/grok-4.5', review: 'Second run review.', buildSha: 'bbb2222', runFacts: '' },
      '2026-08-10T15:30:00.000Z',
    );

    const headings = [...bothRunsDoc.matchAll(/^## Review: Grok 4\.5 — .+$/gm)].map((m) => m[0]);
    expect(headings).toHaveLength(2);
    expect(headings[0]).not.toBe(headings[1]);
    expect(headings).toContain('## Review: Grok 4.5 — 2026-08-10 09:00');
    expect(headings).toContain('## Review: Grok 4.5 — 2026-08-10 15:30');
  });

  it('inserts at the real heading, not one quoted inside a fenced code block or review prose', () => {
    // The battery is self-referential: every model reviews this harness, so an
    // existing review's body can legitimately contain the literal string
    // "## Prompt for other agents" — inside a code fence quoting the doc's own
    // convention, or in prose discussing it. `indexOf` would match that
    // occurrence FIRST (it appears earlier in the doc) and splice the new
    // section into the middle of that review instead of above the real
    // heading at the end.
    const docWithQuotedHeading = `# Native Agent Harness Reviews

Intro text.

---

## Review: Existing Model — 2026-08-01

This model even quoted the doc's own heading back at me:

\`\`\`
## Prompt for other agents
\`\`\`

which is not the real thing.

---

## Prompt for other agents

Prompt block here.
`;
    const out = appendReview(
      docWithQuotedHeading,
      { label: 'New Model', modelId: 'v/new', review: 'My review.', buildSha: 'abc1234', runFacts: '' },
      RUN_AT,
    );
    // The new section must land above the REAL heading (the last one in the
    // doc), not the quoted one inside the fence (the first occurrence).
    const newSectionIndex = out.indexOf('## Review: New Model');
    const fencedHeadingIndex = out.indexOf('```\n## Prompt for other agents');
    expect(newSectionIndex).toBeGreaterThan(fencedHeadingIndex);
    expect(newSectionIndex).toBeLessThan(out.lastIndexOf('## Prompt for other agents'));
    // Sanity: the quoted heading inside the existing review is untouched and
    // still appears exactly where it did before.
    expect(out).toContain('```\n## Prompt for other agents\n```');
  });

  it('carries the run-facts block under the heading, above the review body', () => {
    const out = appendReview(DOC, {
      label: 'Fake', modelId: 'fake/model', review: 'Body text.',
      buildSha: 'abc123', runFacts: '**Run facts:** complete · 58 tool calls',
    }, RUN_AT);

    const headingAt = out.indexOf('## Review: Fake');
    const factsAt = out.indexOf('**Run facts:**');
    const bodyAt = out.indexOf('Body text.');
    expect(headingAt).toBeLessThan(factsAt);
    expect(factsAt).toBeLessThan(bodyAt);
  });
});

// Destin's ruling (overrides the plan brief): the brief's three runCase
// tests each had an assertion that could never fail (e.g.
// `expect(run.asks).toBeGreaterThanOrEqual(0)`, true of every possible
// implementation including a broken one). Same test names/intent, but each
// assertion below is wired to something that would actually break if the
// driver regressed.
describe('runCase', () => {
  it('auto-approves tool use so the battery never blocks on a permission prompt', async () => {
    // Script a REAL tool call (Read of the fixture's own README.md) followed by
    // the model's final text. If decide()/askUser were wired wrong, this call
    // would stall on an unanswered permission ask and the 5s timeout below
    // would fire, failing the test — unlike the brief's vacuous assertion.
    const run = await runCase({
      modelFactory: async () =>
        scriptModel([
          { toolCalls: [{ name: 'Read', input: { file_path: 'README.md' } }] },
          { text: 'The README describes a Fixture Project.' },
        ]) as any,
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.toolCalls).toBe(1);
    const toolResult = run.events.find((e) => e.type === 'tool-result' && e.data.toolName === 'Read');
    expect(toolResult).toBeDefined();
    expect(toolResult!.data.isError).toBeFalsy();
    // Proves the tool actually ran against the real fixture tree, not a stub.
    expect(toolResult!.data.toolResult).toContain('Fixture Project');
    expect(run.review).toBe('The README describes a Fixture Project.');
  });

  it('answers AskUserQuestion deterministically instead of hanging', async () => {
    // No reviewer ever exercised AskUserQuestion (Kimi K3 finding #6) because a
    // human had to answer it. The real proof isn't that the run finished — it's
    // that the fixed answerer picked the FIRST option every time, which is what
    // makes runs reproducible across models. Read the tool-result text the
    // driver's answer actually produced (formatAnswers' "Q: ...\nA: ..." shape)
    // rather than asserting only `asks > 0`.
    const run = await runCase({
      modelFactory: async () =>
        scriptModel([
          {
            toolCalls: [
              {
                name: 'AskUserQuestion',
                input: {
                  questions: [
                    {
                      question: 'Which color?',
                      header: 'Color',
                      options: [{ label: 'Red' }, { label: 'Blue' }],
                      multiSelect: false,
                    },
                  ],
                },
              },
            ],
          },
          { text: 'Picked a color and moved on.' },
        ]) as any,
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.asks).toBe(1);
    const askResult = run.events.find((e) => e.type === 'tool-result' && e.data.toolName === 'AskUserQuestion');
    expect(askResult).toBeDefined();
    expect(askResult!.data.toolResult).toContain('A: Red');
    expect(askResult!.data.toolResult).not.toContain('A: Blue');
  });

  it('denies a Write outside the fixture instead of rubber-stamping it (Critical fix)', async () => {
    // HarnessSession funnels FOUR ask kinds through the single askUser callback
    // (harness-session.ts:1478 external-path forced ask, :1432 doom_loop,
    // :1100 max_steps, :1449 real AskUserQuestion). A prior version of
    // run-case's askUser answered all of them with `allow` because its
    // `questions` loop silently ran zero times on anything that wasn't a real
    // AskUserQuestion. That let a scripted Write escape the fixture and write
    // to a real path on the machine running the CLI — this test is the one
    // that would have caught it.
    //
    // The target lives under os.tmpdir() but is NOT inside the fixture root
    // (a separate mkdtemp'd sibling directory), so the assertion "the file was
    // never created" can't be satisfied by accident just because the fixture
    // itself happens to live in tmpdir.
    const outsideDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'yc-harness-review-test-outside-'));
    const outsideFile = path.join(outsideDir, 'pwned.txt');
    try {
      const run = await runCase({
        modelFactory: async () =>
          scriptModel([
            { toolCalls: [{ name: 'Write', input: { file_path: outsideFile, content: 'pwned' } }] },
            { text: 'Tried to write outside the fixture.' },
          ]) as any,
        modelId: 'fake/model',
        label: 'Fake',
        timeoutMs: NOT_THE_DEADLINE_MS,
      });

      // (a) The write never actually happened on disk.
      expect(fs.existsSync(outsideFile)).toBe(false);

      // The tool call still ran through the loop (doom-loop/decide/guard), it
      // just got a deny result instead of executing — a coherent tool-result
      // the model can read, not a stall or a crash.
      const writeResult = run.events.find((e) => e.type === 'tool-result' && e.data.toolName === 'Write');
      expect(writeResult).toBeDefined();
      expect(writeResult!.data.isError).toBe(true);

      // (b) `asks` counts this: run-case's askUser increments `asks` for
      // EVERY ask that reaches it, answered or denied, because the field means
      // "how many times something needed a human" — a denied external-path
      // ask is still one of those. See the WHY comment on askUser in
      // run-case.ts for the reasoning.
      expect(run.asks).toBe(1);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('cleans up the fixture directory when the run finishes, after actually creating it', async () => {
    let seenDuringRun: string[] = [];
    const run = await runCase({
      modelFactory: async () => {
        // modelFactory only runs mid-send(), strictly after the fixture is
        // seeded — snapshotting os.tmpdir() here proves the directory really
        // existed WHILE the run was in flight. Without this, "gone afterward"
        // would be satisfied equally by a driver that never created it at all.
        seenDuringRun = fs
          .readdirSync(fs.realpathSync(os.tmpdir()))
          .filter((d) => d.startsWith('yc-harness-review-'));
        return scriptModel([{ text: 'All checks passed.' }]) as any;
      },
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(seenDuringRun.some((d) => run.fixtureRoot.endsWith(d))).toBe(true);
    expect(fs.existsSync(run.fixtureRoot)).toBe(false);
    expect(run.review).toBe('All checks passed.');
  });

  it('keeps the fixture directory when keepFixture is true', async () => {
    const run = await runCase({
      modelFactory: async () => scriptModel([{ text: 'kept' }]) as any,
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: NOT_THE_DEADLINE_MS,
      keepFixture: true,
    });
    try {
      expect(fs.existsSync(run.fixtureRoot)).toBe(true);
    } finally {
      // The option under test leaves the fixture on disk on purpose — clean it
      // up ourselves so the test suite leaves no residue in /tmp.
      fs.rmSync(run.fixtureRoot, { recursive: true, force: true });
    }
  });

  it('returns label, modelId, a trimmed review, and a fixtureRoot inside the OS tmpdir', async () => {
    const run = await runCase({
      modelFactory: async () => scriptModel([{ text: '  Final review text.  ' }]) as any,
      modelId: 'fake/model-x',
      label: 'Fake X',
      timeoutMs: NOT_THE_DEADLINE_MS,
    });
    expect(run.label).toBe('Fake X');
    expect(run.modelId).toBe('fake/model-x');
    expect(run.review).toBe('Final review text.');
    expect(run.fixtureRoot.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    expect(run.fixtureRoot).toContain('yc-harness-review-');
  });

  it('review is the FINAL assistant message, not every assistant-text delta in the run (Defect 1)', async () => {
    // The live Kimi K3 run emitted 2,501 assistant-text events across the whole
    // battery — streaming deltas for every turn's narration, not just the last
    // one. The old code joined ALL of them, so the appended review began with
    // run commentary ("I'll start by getting oriented...") glued directly onto
    // the real review with no separator. Script a model that narrates BEFORE a
    // tool call, then writes a distinct final message after — the review must
    // contain only the latter.
    const run = await runCase({
      modelFactory: async () =>
        scriptModel([
          {
            text: 'Pre-tool narration that must not leak into the review.',
            toolCalls: [{ name: 'Read', input: { file_path: 'README.md' } }],
          },
          { text: 'This is the actual final review.' },
        ]) as any,
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.review).toBe('This is the actual final review.');
    expect(run.review).not.toContain('Pre-tool narration');
  });

  it('review is still the whole answer when the model never calls a tool (Defect 1 edge case)', async () => {
    // There is no tool-result to anchor on when a model just answers — every
    // assistant-text event in the run IS the final message, so the "after the
    // last tool-result" rule must not collapse to an empty string here.
    const run = await runCase({
      modelFactory: async () => scriptModel([{ text: 'No tools needed, here is my review.' }]) as any,
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.review).toBe('No tools needed, here is my review.');
  });

  it('wires WebSearch to the keyless DDG backend instead of leaving it unconfigured (Defect 2)', async () => {
    // The live run got "Web search is not wired for this session; this is a
    // configuration error" because runCase never passed toolServices.
    // Stub global fetch with the captured DDG fixture (tests/search-backends.test.ts
    // uses the same file) so this proves real end-to-end wiring — model calls
    // WebSearch, the tool reaches ctx.services.search, the adapter calls the
    // real ddgBackend parser — without making an actual network request.
    const fixtureHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'search', 'ddg-response.html'), 'utf8');
    const fetchSpy = vi.fn(async () => new Response(fixtureHtml));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const run = await runCase({
        modelFactory: async () =>
          scriptModel([
            { toolCalls: [{ name: 'WebSearch', input: { query: 'node lts version' } }] },
            { text: 'Search worked.' },
          ]) as any,
        modelId: 'fake/model',
        label: 'Fake',
        timeoutMs: NOT_THE_DEADLINE_MS,
      });

      const searchResult = run.events.find((e) => e.type === 'tool-result' && e.data.toolName === 'WebSearch');
      expect(searchResult).toBeDefined();
      expect(searchResult!.data.isError).toBeFalsy();
      expect(searchResult!.data.toolResult).not.toContain('not wired');
      expect(searchResult!.data.toolResult).toContain('via ddg');
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Root cause (2026-08-09 live run): run-case's askUser used to deny
  // EVERY max_steps ask outright. harness-session.ts:1100-1102 turns a
  // non-'allow' answer to that specific ask into stopReason='max_steps' and
  // ENDS THE TURN — unlike doom_loop, which only fails the one repeated call.
  // A real full-roster run needed 37-80 tool calls per model; 'fake/model'
  // The evaluator manifest has an explicit 100-step budget, so driving the gate means scripting more than 100
  // consecutive tool-call steps — done here with a generated script rather
  // than typed out by hand. Prefers the real path (per the task brief) over
  // faking the askUser decision directly, since it also proves toolCalls/
  // asks/stepGates all still line up correctly across a real gate crossing.
  // `offset: i` makes every call's input unique so no 3 consecutive calls
  // share an identical signature (harness-session.ts:1424's doom-loop sig is
  // `toolName:JSON.stringify(args)`, threshold 3 for the openrouter/cloud
  // profile — capability-profile.ts) — a constant-input Read call WOULD
  // legitimately trip that guard on call 3 and then again on every call after
  // (denial never resets the window, only 'allow' does — harness-session.ts:
  // 1438), inflating `asks` with doom_loop hits unrelated to what this test
  // is proving about max_steps. Unique-per-call (not merely alternating
  // between two values) ALSO keeps this run under REPEAT_LIMIT (run-case.ts)
  // — an alternating two-value script run for 100+ steps would otherwise trip
  // the restart-detection wrap-up before max_steps ever gets the chance to,
  // which is what this test exists to prove.
  function toolCallSteps(count: number): ScriptStep[] {
    return Array.from({ length: count }, (_, i) => ({
      toolCalls: [{ name: 'Read', input: { file_path: 'README.md', offset: i } }],
    }));
  }

  it('survives the max_steps gate up to STEP_GATE_ALLOWANCE and still produces a review', async () => {
    // One full step-budget window per allowed gate hit, THEN a final text step
    // that only runs if every one of those gate hits was actually allowed.
    // Against the pre-fix code (deny everything) this fails at the very first
    // gate — the run ends with stopReason='max_steps' before the text step is
    // ever reached, so `review` comes back empty instead of the real string.
    const steps: ScriptStep[] = [
      ...toolCallSteps(STEP_GATE_ALLOWANCE * BATTERY_STEP_BUDGET),
      { text: 'Final review after surviving every step gate.' },
    ];
    const run = await runCase({
      modelFactory: async () => scriptModel(steps) as any,
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.review).toBe('Final review after surviving every step gate.');
    // Proves the run actually crossed the 100-step budget boundary STEP_GATE_ALLOWANCE
    // times, not just once — a run that stalled at the first gate could never
    // reach this many tool calls.
    expect(run.toolCalls).toBe(STEP_GATE_ALLOWANCE * BATTERY_STEP_BUDGET);
    expect(run.stepGates).toBe(STEP_GATE_ALLOWANCE);
    // Design choice (see the WHY comment on run-case.ts's askUser): a
    // bounded max_steps allowance still counts as an `asks` — it's a real
    // spend/policy decision made on the model's behalf, same as a denied
    // doom_loop or external-path ask. All gate hits here were the ONLY
    // asks in the run (no AskUserQuestion, no external-path Write), so `asks`
    // must equal `stepGates` exactly.
    expect(run.asks).toBe(STEP_GATE_ALLOWANCE);
    // Pins the distinction from the wrap-up-turn tests below: an
    // allowance-sized run finishes on its own and never wraps up.
    expect(run.outcome).toBe('complete');
    expect(run.wrapUpReason).toBeUndefined();
  });
});

// EVERY test below that drives a full-budget run needs an explicit
// `}, HEAVY_RUN_TIMEOUT_MS)` (defined at the top of this file) — the suite-wide
// budget in vitest.config.ts does not fit them.
// A full run is (STEP_GATE_ALLOWANCE + 1) * BATTERY_STEP_BUDGET = 200 tool calls
// through a real HarnessSession against a real seeded fixture. BATTERY_STEP_BUDGET
// uses a uniform explicit 100-step evaluator cap,
// which doubled that work and pushed these tests over the old 5,000ms default —
// they went red on Windows CI (the slowest runner) from that commit onward and
// intermittently on Ubuntu, always at exactly 5,000ms, which is the tell. The
// failure looks like a logic bug (wrong `wrapUpReason`, missing review) because
// the timeout cuts the run mid-flight, so it cost a ROADMAP entry and two
// sessions to attribute. If you add a test here that calls toolCallSteps(),
// give it the timeout too.
describe('wrap-up turn', () => {
  function toolCallSteps(count: number): ScriptStep[] {
    // Unique `offset` per call so consecutive calls are never byte-identical
    // (which would trip the doom_loop guard, harness-session.ts:1432 — a
    // different mechanism that would muddy what these tests prove) AND so no
    // call recurs at all across the whole run. Recurring between just two
    // alternating values would, at this function's typical call counts
    // (100+), cross REPEAT_LIMIT (run-case.ts) and send the run to a
    // 'restart' wrap-up before the budget/timeout trigger these tests are
    // actually exercising ever fires — restart detection has its own
    // dedicated tests below.
    return Array.from({ length: count }, (_, i) => ({
      toolCalls: [{ name: 'Read', input: { file_path: 'README.md', offset: i } }],
    }));
  }

  it('asks for the review when the step budget is exhausted, instead of ending the turn empty', async () => {
    // One window more than the allowance permits, so the last gate is denied and
    // the testing turn ends on stopReason 'max_steps'. The trailing text step is
    // the WRAP-UP turn's response — reached only if a second send() happens.
    //
    // The model is hoisted OUT of the factory on purpose: modelFactory is called
    // once per send() (harness-session.ts:1020), so an inline
    // `async () => scriptModel(steps)` would hand the wrap-up turn a fresh model
    // replaying from step 0 — it would call tools again, not answer.
    const model = scriptModel([
      ...toolCallSteps((STEP_GATE_ALLOWANCE + 1) * BATTERY_STEP_BUDGET),
      { text: 'Review written after being asked to wrap up.' },
    ]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.outcome).toBe('wrapped-up');
    expect(run.wrapUpReason).toBe('budget');
    expect(run.review).toBe('Review written after being asked to wrap up.');
    expect(run.metrics.stopReasons).toContain('max_steps');
  }, HEAVY_RUN_TIMEOUT_MS);

  it('denies tool calls during the wrap-up turn so the model cannot resume testing', async () => {
    const model = scriptModel([
      ...toolCallSteps((STEP_GATE_ALLOWANCE + 1) * BATTERY_STEP_BUDGET),
      // The model tries to keep testing on the wrap-up turn...
      { toolCalls: [{ name: 'Bash', input: { command: 'echo still going' } }] },
      // ...and only then answers.
      { text: 'Fine, here is the review.' },
    ]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.review).toBe('Fine, here is the review.');
    // The Bash call was ATTEMPTED (it is in the transcript) but denied, so it
    // never reached the tool layer and never ran a command. harness-session.ts:1556
    // returns `{ isError: true }` for a denied decide, and :1131 emits it as a
    // tool-result carrying toolName.
    const bashResults = run.events.filter(
      (e) => e.type === 'tool-result' && e.data.toolName === 'Bash',
    );
    // Assert non-empty FIRST — `.every` on an empty array is vacuously true, so
    // without this the test would also pass if the wrap-up turn never ran.
    expect(bashResults.length).toBeGreaterThan(0);
    expect(bashResults.every((e) => e.data.isError)).toBe(true);
  }, HEAVY_RUN_TIMEOUT_MS);

  it('denies a genuine AskUserQuestion during wrap-up, so WRAP_UP_PROMPT\'s "every tool call will be denied" claim is true (Fix pass 2, Finding 2)', async () => {
    // AskUserQuestion is declared `interactive: true` (ask-user-question.ts)
    // and harness-session.ts routes interactive tools AROUND decide()
    // entirely, straight to askUser. Before this fix, run-case's askUser
    // allowed any genuine AskUserQuestion unconditionally — including during
    // wrap-up — so a model could keep calling it, bounded only by
    // WRAP_UP_TIMEOUT_MS, while WRAP_UP_PROMPT told it every tool call would
    // be denied.
    const model = scriptModel([
      ...toolCallSteps((STEP_GATE_ALLOWANCE + 1) * BATTERY_STEP_BUDGET),
      // Wrap-up turn, step 1: try AskUserQuestion instead of answering. Full
      // valid shape (header, >=2 options, multiSelect) so the zod schema
      // accepts it and this exercises the wrap-up denial in askUser, not a
      // validation failure that would be denied for an unrelated reason.
      {
        toolCalls: [{
          name: 'AskUserQuestion',
          input: {
            questions: [{
              question: 'Which color?',
              header: 'Color',
              options: [{ label: 'Red' }, { label: 'Blue' }],
              multiSelect: false,
            }],
          },
        }],
      },
      // Wrap-up turn, step 2: the ask was denied, so the model gives up and answers.
      { text: 'Fine, here is the review.' },
    ]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: NOT_THE_DEADLINE_MS,
    });

    const askResults = run.events.filter(
      (e) => e.type === 'tool-result' && e.data.toolName === 'AskUserQuestion' && !e.data.isError,
    );
    // The ONLY successful AskUserQuestion allowed anywhere in this run must be
    // the one the fake model issued during the TESTING phase's normal budget
    // gate — none during wrap-up. Since this script has no such testing-phase
    // ask, zero successful AskUserQuestion results must exist at all.
    expect(askResults.length).toBe(0);
    const deniedAsk = run.events.find(
      (e) => e.type === 'tool-result' && e.data.toolName === 'AskUserQuestion' && e.data.isError,
    );
    expect(deniedAsk).toBeDefined();
    expect(run.review).toBe('Fine, here is the review.');
  }, HEAVY_RUN_TIMEOUT_MS);

  it('takes only the wrap-up turn text as the review, not narration from the interrupted turn', async () => {
    // The testing turn emits trailing narration after its last tool call. Under
    // the old single-turn extractor that text would BE the review. It must not
    // leak into the wrapped-up review — this is the exact defect the
    // "text after the last tool result" rule was written to fix.
    const steps = toolCallSteps((STEP_GATE_ALLOWANCE + 1) * BATTERY_STEP_BUDGET);
    steps[steps.length - 1] = {
      text: 'Now let me try one more thing...',
      toolCalls: [{ name: 'Read', input: { file_path: 'README.md', offset: 9 } }],
    };
    const model = scriptModel([...steps, { text: 'The actual review.' }]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.review).toBe('The actual review.');
    expect(run.review).not.toContain('one more thing');
  }, HEAVY_RUN_TIMEOUT_MS);

  it('keeps the wrap-up review even if the model answers and then tries one more tool call', async () => {
    // Fix pass 1, Finding 1 regression: inside the wrap-up window every tool
    // call is denied, so a tool-result there is never a real narration
    // boundary — but the OLD extractor anchored on "text after the last
    // tool-result" unconditionally, so a model that writes its review and
    // THEN attempts one more (denied) tool call had that review discarded:
    // the denial's tool-result landed at a later index than the review text,
    // and the filter excluded everything at or before it. This is exactly
    // the tool-happy failure population wrap-up exists to rescue (127 and 157
    // tool calls in the round-5 incident).
    const model = scriptModel([
      ...toolCallSteps((STEP_GATE_ALLOWANCE + 1) * BATTERY_STEP_BUDGET),
      // Wrap-up turn, step 1: answer AND try one more tool call in the same step.
      {
        text: 'My review is done.',
        toolCalls: [{ name: 'Bash', input: { command: 'echo one more' } }],
      },
      // Wrap-up turn, step 2: the step above's tool call was denied (not an
      // ask), so the turn loops once more — the model gives up here.
      {},
    ]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.outcome).toBe('wrapped-up');
    expect(run.review).toBe('My review is done.');
  }, HEAVY_RUN_TIMEOUT_MS);

  it('strips wrap-up narration that precedes a denied tool attempt, instead of concatenating it onto the review (Fix pass 2, Finding 1)', async () => {
    // The pass-1 fix (dropping the anchor entirely inside the wrap-up window)
    // fixed "answer, then try one more tool" but broke the more common
    // multi-step shape: narrate -> attempt a tool -> get denied (a tool-result
    // is still emitted) -> THEN write the review. Unconditionally joining
    // every assistant-text event in the window glues the narration onto the
    // front of the real review with no separator — "Let me verify one thing
    // first.The actual review..." — which is exactly what gets appended to
    // the shared reviews doc. This is the tool-happy population (127/157
    // calls in the round-5 incident) wrap-up exists to rescue.
    const model = scriptModel([
      ...toolCallSteps((STEP_GATE_ALLOWANCE + 1) * BATTERY_STEP_BUDGET),
      // Wrap-up turn, step 1: narrate AND attempt a tool in the same step.
      {
        text: 'Let me verify one thing first.',
        toolCalls: [{ name: 'Bash', input: { command: 'echo verify' } }],
      },
      // Wrap-up turn, step 2: the tool attempt was denied, so the model gives
      // up testing and writes the real review.
      { text: 'The actual review text.' },
    ]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.outcome).toBe('wrapped-up');
    expect(run.review).toBe('The actual review text.');
    expect(run.review).not.toContain('verify');
  }, HEAVY_RUN_TIMEOUT_MS);

  it('asks for the review when the wall clock elapses, instead of throwing the run away', async () => {
    // Fix pass 1, Finding 4: the old version of this test scripted a fixed
    // array (60 windows of tool calls, THEN one text step) and relied on the
    // interrupted testing turn resuming mid-script for the wrap-up turn. That
    // trailing text step was dead code — the wrap-up turn resumes wherever the
    // 200ms deadline caught the testing turn (a handful of tool-call steps
    // in), then needs up to its OWN ~100-step budget to work through the
    // REST of the 6,000 scripted tool-call steps before ever reaching the
    // text step at the end — so it never got there, and the test proved only
    // that the trigger fired, not that the mechanism delivers a review.
    //
    // Fixed by making the model's response depend on what it's actually being
    // asked, not on a step index: keep emitting (alternating, non-doom-loop)
    // tool calls until WRAP_UP_PROMPT shows up as the latest user turn in its
    // own prompt, then answer in prose immediately. That makes delivery
    // deterministic regardless of exactly how many steps the 200ms deadline
    // let the testing turn consume, while still keeping the testing turn
    // permanently tool-happy (never naturally finishing) so the deadline is
    // what ends it, not the script running out.
    //
    // timeoutMs is deliberately tight: this fake model has no real per-step
    // latency, so STEP_GATE_ALLOWANCE's own natural 'max_steps' denial
    // (measured ~1.1s for 200 steps against this fixture) would otherwise win
    // the race and report 'budget' instead of the 'timeout' this test exists
    // to prove — 200ms leaves a wide margin under that.
    //
    // Fix pass 1, Finding 5: the risk direction here is a FASTER machine (or
    // CI runner), not a slower one — a slower machine only makes the 200-step
    // budget path take longer, widening this test's margin. If this ever
    // flakes, the fix is to LOWER timeoutMs (more headroom for the deadline to
    // win), never to raise it — raising it hands the budget path more time to
    // finish first, which is the opposite of what's needed. (A prior draft of
    // this file's own report had this backwards; corrected there too.)
    const seenPrompts: unknown[] = [];
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async (req: any) => {
        seenPrompts.push(req.prompt);
        const isWrapUpTurn = JSON.stringify(req.prompt).includes(WRAP_UP_PROMPT);
        call++;
        const chunks = isWrapUpTurn
          ? stream(...textChunks(`t${call}`, 'Review after the clock ran out.'), finishChunk('stop'))
          : stream(
              // `offset: call` (not alternating between two values): unique
              // per call so this never itself crosses REPEAT_LIMIT and reports
              // 'restart' instead of the 'timeout' this test exists to prove —
              // same reasoning as the wrap-up describe block's toolCallSteps.
              toolCallChunk(`c${call}`, 'Read', { file_path: 'README.md', offset: call }),
              finishChunk('tool-calls'),
            );
        return { stream: simulateReadableStream({ chunks }) };
      },
    });

    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: 200,
    });

    expect(run.wrapUpReason).toBe('timeout');
    expect(run.outcome).toBe('wrapped-up');
    expect(run.error).toBeUndefined();   // a deadline is not an error any more
    // The mechanism, not just the trigger: the wrap-up turn actually delivered
    // a review, proving the second-turn machinery works end to end.
    expect(run.review).toBe('Review after the clock ran out.');
    // Fix pass 1, Finding 6: prove the wrap-up turn's outgoing message really
    // carried WRAP_UP_PROMPT — the fake model above only branches on this, so
    // this assertion is exercising the real content, not just the import.
    expect(seenPrompts.some((p) => JSON.stringify(p).includes(WRAP_UP_PROMPT))).toBe(true);
  }, HEAVY_RUN_TIMEOUT_MS);
});

describe('what the model actually receives (2026-08-11 amnesia bug)', () => {
  // BATTERY_MAX_OUTPUT_TOKENS was 32_000 against fitToContext's 32_768 default
  // window, leaving 32768 - 32000 - 1024 = -256 tokens for history. Every
  // request collapsed to a single message; mid-turn the model saw only the
  // battery prompt plus its most recent exchange, and the WRAP-UP turn saw the
  // wrap-up prompt alone. Four live models reported "this message is the first
  // one in our session" after 67-309 tool calls, and it also produced the
  // phantom "restart" behaviour that cost two rounds of threshold-tuning.
  //
  // 48 tests were green throughout, because every one of them asserted on what
  // runCase RETURNS and none on what reaches the model. These assert on the
  // transmitted prompt.
  function recordingModel(prompts: any[]) {
    let call = 0;
    return new MockLanguageModelV4({
      doStream: async (o: any) => {
        prompts.push(o.prompt);
        call++;
        // Turn 1: one tool call, then a bare stop with no text ('stopped-early').
        if (call === 1) {
          return { stream: simulateReadableStream({
            chunks: [toolCallChunk('c1', 'Read', { file_path: 'README.md' }), finishChunk('tool-calls')],
          }) };
        }
        // Calls 2 AND 3 are empty: the harness silently retries a single empty
        // step (empty-step recovery, spec 2026-08-21), so "a bare stop" now
        // takes a consecutive pair to actually end the testing turn.
        if (call === 2 || call === 3) return { stream: simulateReadableStream({ chunks: [finishChunk('stop')] }) };
        return { stream: simulateReadableStream({
          chunks: [...textChunks('t', 'The review.'), finishChunk('stop')],
        }) };
      },
    });
  }

  it('the wrap-up turn carries the testing turn — its prompt, its calls, its results', async () => {
    const prompts: any[] = [];
    const run = await runCase({
      modelFactory: async () => recordingModel(prompts) as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.wrapUpReason).toBe('stopped-early');
    const wrapUp = JSON.stringify(prompts[prompts.length - 1]);
    // Under the bug this was `system,user` and contained none of the three.
    expect(wrapUp).toContain('You are testing the YouCoded native agent harness');
    expect(wrapUp).toContain('README');
    expect(wrapUp).toContain(WRAP_UP_PROMPT.slice(0, 40));
  });

  it('keeps history through the testing turn, not just the newest exchange', async () => {
    const prompts: any[] = [];
    await runCase({
      modelFactory: async () => recordingModel(prompts) as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: NOT_THE_DEADLINE_MS,
    });

    // Second step of turn 1: system + user + assistant(tool-call) + tool(result).
    expect(prompts[1].map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  });

  it('refuses to spend money when the output ceiling has eaten the history budget', async () => {
    // A window barely above the output ceiling — the shape that shipped.
    await expect(runCase({
      modelFactory: async () => scriptModel([{ text: 'x' }]) as any,
      modelId: 'fake/model', label: 'Fake', contextLength: BATTERY_MAX_OUTPUT_TOKENS + 2_000,
    })).rejects.toThrow(/Battery misconfigured/);
  });

  it('assertHistoryBudget passes the default window and fails a swallowed one', () => {
    expect(() => assertHistoryBudget(DEFAULT_BATTERY_CONTEXT_LENGTH)).not.toThrow();
    expect(() => assertHistoryBudget(BATTERY_MAX_OUTPUT_TOKENS + 2_000))
      .toThrow(/tokens for history/);
  });

  it('caps a huge roster window so history does not ride unbounded on every request', async () => {
    const model = scriptModel([{ text: 'Review.' }]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: NOT_THE_DEADLINE_MS,
      contextLength: 1_000_000,   // Qwen 3.8 Max's real window
    });

    // turn-complete carries the session's resolved window on its usage payload.
    const turn = run.events.find((e) => e.type === 'turn-complete');
    expect(turn?.data.usage?.contextLength).toBe(BATTERY_CONTEXT_CAP);
  });
});

describe('repeat reporting (diagnostic only)', () => {
  // A 'restart' trigger used to live here and interrupt a run once a
  // (toolName, input) pair recurred past a threshold. It was deleted on
  // 2026-08-11 after truncating eight paid runs at a threshold of 5 and five
  // more at 12 — every trip landing exactly one over whatever line was drawn,
  // because the battery ("verify cwd persistence across calls") and the
  // harness (read-before-edit) both REQUIRE repeated identical calls. These
  // tests pin the replacement contract: observe, never act.
  function repeatingSteps(times: number): ScriptStep[] {
    // Interleaved with distinct Reads so no two IDENTICAL calls are adjacent —
    // otherwise doom_loop (a different, consecutive-only mechanism) is what
    // would fire, and these tests would prove nothing about repeat handling.
    const steps: ScriptStep[] = [];
    for (let i = 0; i < times; i++) {
      steps.push({ toolCalls: [{ name: 'Glob', input: { pattern: '**/*' } }] });
      steps.push({ toolCalls: [{ name: 'Read', input: { file_path: `f${i}.ts` } }] });
    }
    return steps;
  }

  it('never cuts a run short for repeating a call, however many times', async () => {
    // Four times the old threshold. Under either previous value this run was
    // interrupted mid-battery; it must now run to its own natural end.
    const model = scriptModel([
      ...repeatingSteps(48),
      { text: 'Finished on my own terms.' },
    ]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.wrapUpReason).toBeUndefined();
    expect(run.outcome).toBe('complete');
    expect(run.review).toBe('Finished on my own terms.');
  }, HEAVY_RUN_TIMEOUT_MS);

  it('still REPORTS the repeats, so a real loop stays visible in the transcript', async () => {
    // Deleting the trigger must not delete the evidence: reading metrics.repeats
    // off saved transcripts is how the false-positive bug was diagnosed in the
    // first place.
    const model = scriptModel([...repeatingSteps(8), { text: 'Done.' }]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.metrics.repeats[0]).toMatchObject({ count: 8 });
    expect(run.metrics.repeats[0].key).toContain('Glob');
  }, HEAVY_RUN_TIMEOUT_MS);

  it('reports nothing for a run whose repeats stay under the reporting floor', async () => {
    const model = scriptModel([...repeatingSteps(REPEAT_REPORT_FLOOR - 1), { text: 'Done.' }]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.metrics.repeats).toEqual([]);
  });
});

describe('runCase salvage', () => {
  it('returns the run with the real error instead of throwing, when the model errors mid-run', async () => {
    // WHY this matters: round 5 lost four models entirely. runCase threw, the
    // CLI caught, and no transcript was written - so the failures were not even
    // diagnosable after the fact.
    const model = scriptModel([
      { toolCalls: [{ name: 'Read', input: { file_path: 'README.md' } }] },
      { throwError: 'provider exploded' },
    ]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.outcome).toBe('error');
    expect(run.error).toContain('provider exploded');
    // The whole point: the events survive the failure.
    expect(run.events.length).toBeGreaterThan(0);
    expect(run.metrics.toolCalls).toBe(1);
  });

  it('asks a model that simply stopped, rather than writing it off with no review', async () => {
    // The 2026-08-11 Qwen 3.6 27B case: six tool calls, ended on 'end_turn'
    // with empty final text, nothing repeated, no budget spent. None of the
    // three cut-short triggers fires for a run that just STOPS, so nothing
    // ever asked it for a review and a paid run produced none.
    const model = scriptModel([
      { toolCalls: [{ name: 'Read', input: { file_path: 'README.md' } }] },
      // An EMPTY step is a clean stop with no text — this is what ends the
      // testing turn. It has to be here: the driver keeps looping inside one
      // send() until the model stops calling tools, so a text step here would
      // simply finish the first turn and there would be nothing to rescue.
      // TWO of them, because the harness silently retries the first (empty-step
      // recovery, spec 2026-08-21) — a single {} would hand the retry the
      // review script and finish the testing turn WITH a review.
      {},
      {},
      // Reached only by the SECOND send() the trigger issues.
      { text: 'Asked, so here is my review.' },
    ]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.wrapUpReason).toBe('stopped-early');
    expect(run.outcome).toBe('wrapped-up');
    expect(run.review).toBe('Asked, so here is my review.');
  });

  it('does not spend a second turn on a run that already produced a review', async () => {
    // The trigger must not fire for a healthy run — that would double the cost
    // of every successful model in the roster.
    const model = scriptModel([
      { toolCalls: [{ name: 'Read', input: { file_path: 'README.md' } }] },
      { text: 'A complete review.' },
    ]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.wrapUpReason).toBeUndefined();
    expect(run.outcome).toBe('complete');
    expect(run.review).toBe('A complete review.');
  });

  it('treats mid-run narration as no review, since narration is not a deliverable', async () => {
    // A model that narrates between tool calls and then stops HAS emitted
    // assistant text — but not a review. Testing "did it emit any text" instead
    // of "is there text after the last tool result" would see the narration and
    // decline to ask, missing the exact case the trigger exists for.
    const model = scriptModel([
      { text: 'Now let me check the config…', toolCalls: [{ name: 'Read', input: { file_path: 'a.toml' } }] },
      // Doubled: the harness retries one empty step (empty-step recovery,
      // spec 2026-08-21); the pair ends the testing turn narration-only.
      {},
      {},
      { text: 'Asked anyway.' },
    ]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.wrapUpReason).toBe('stopped-early');
    expect(run.review).toBe('Asked anyway.');
    expect(run.review).not.toContain('check the config');
  });

  it('reports complete and records metrics when the model finishes normally', async () => {
    const model = scriptModel([
      { toolCalls: [{ name: 'Glob', input: { pattern: '**/*' } }] },
      { toolCalls: [{ name: 'Read', input: { file_path: 'README.md' } }] },
      { text: 'The review.' },
    ]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: NOT_THE_DEADLINE_MS,
    });

    expect(run.outcome).toBe('complete');
    expect(run.review).toBe('The review.');
    expect(run.metrics.toolCalls).toBe(2);
    expect(run.metrics.toolsUsed).toEqual(['Glob', 'Read']);   // distinct, sorted
    expect(run.metrics.stopReasons).toContain('end_turn');
    expect(run.metrics.wallClockMs).toBeGreaterThan(0);
    expect(run.metrics.outputTokens).toBeGreaterThan(0);
  });
});
