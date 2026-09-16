# Harness evaluator — internals

Depth doc for `.claude/rules/harness-evaluator.md` (workspace repo). Read this when you are
changing `src/main/harness/eval/**` or the two CLIs themselves; the rule carries what you
need to merely *use* the evaluator.

Code: `desktop/src/main/harness/eval/` · CLI: `desktop/test-engine/harness-eval.mjs` +
`harness-eval-worker.mjs` · Legacy CLI: `desktop/test-engine/review-harness.mjs` · Tests:
`desktop/tests/harness-eval-*.test.ts`, `desktop/tests/harness-review-runner.test.ts`,
`desktop/tests/harness-review-fixture.test.ts`

## The process split, and why it exists

The orchestrator (`harness-eval.mjs`) expands a plan into cells and spawns
`harness-eval-worker.mjs` **once per cell**. One process per cell is not tidiness: a cell
names a `dist/` to run the harness from, and two builds of `HarnessSession` cannot coexist
in one Node process.

The consequence that is easy to get wrong: **only the worker loads the cell's `dist`.** The
orchestrator loads the *graders* — `matrix.js`, `cases/index.js`, `assertions.js`,
`judge.js`, `report.js` — from its own build, always. Otherwise "compare my branch against
master" quietly compares two graders as well as two harnesses, and the result means
nothing. `paths.ts` exists to make that impossible to mix up: `graderRoot()` ignores its
argument entirely (hence the `_cell` parameter name) and `harnessRoot(cell)` returns the
cell's dist.
<!-- verify: {"path": "youcoded/desktop/src/main/harness/eval/paths.ts", "contains": "graderRoot ignores its argument entirely"} -->

Worker config travels over **stdin as one JSON object** — never argv, never environment.
See "The credential" below for why.

## Two `HarnessSession` quirks the runner leans on

**`send()` never rejects on a mid-run provider error.** `HarnessSession` emits a
`'session-error'` transcript event and *resolves* the promise. So the runner detects
provider failure by scanning the event stream, not by catching. That scan must be scoped
per-`send()` call — the wrap-up turn is a second `send()`, and an unscoped scan makes a run
that recovered and produced a report `outcome: 'error'`.
<!-- verify: {"path": "youcoded/desktop/src/main/harness/eval/run-case.ts", "contains": "session-error"} -->

**`tool-use` fires before `decide()`.** The event is emitted when the model *requests* a
tool, not when the call is permitted, so `metrics.toolsUsed` records **attempted** calls.
Two consequences: the fabrication check in `run-facts.ts` compares claims against attempts
(fine — a model that never attempted a tool certainly never used it), and the wrap-up turn
must be excluded from the tally, or a whole turn of denied calls pollutes the exact field
that check treats as ground truth.

The `send()`-never-rejects half is pinned (`harness-session.test.ts` → "a factory/stream failure
emits session-error (never a hang)"); the `tool-use`-before-`decide()` half is still a candidate.

## The wrap-up turn

Three triggers, each a **fact** rather than a heuristic: step-budget exhaustion, the wall
clock, and `stopped-early` (the turn ended on its own with no text after the last tool
result). Each sends a second turn carrying `WRAP_UP_PROMPT` with every tool call denied —
including a genuine `AskUserQuestion`, which is `interactive: true` and so bypasses
`decide()`; `askUser` denies it during wrap-up so the prompt's claim holds.

Do not add a fourth trigger that infers distress. One was tried (counting repeated
identical calls) and deleted 2026-08-11 after truncating 13 paid runs, every trip exactly
one over threshold, because the battery's own tasks require repeats.

## Extracting the answer from the transcript

**The answer is the text after the last tool result, not every `assistant-text` delta.**
Deltas stream for the whole run; joining them glues narration onto the answer — Kimi K3's
first appended review was 36% running commentary.

The wrap-up window has one exception: if the tool-result-anchored slice is empty, fall back
to the whole window. That covers the model answering and then making one last (denied)
call, which would otherwise leave the anchor past the answer text.

The order matters and has bitten once. Dropping the anchor for the *whole* wrap-up window
rescues "answer, then attempt one more tool" but breaks "narrate, attempt a tool, then
answer" — the narration comes back as the answer. Anchored slice first, unanchored only as
fallback.
<!-- verify: {"path": "youcoded/desktop/src/main/harness/eval/run-case.ts", "contains": "pickReview"} -->

## The credential

`delete process.env.OPENROUTER_API_KEY` does **not** hide the key from the models being
run. `delete` compiles to `unsetenv`, which edits the in-heap environ array; it never
rewrites the `mm->env_start..env_end` region the kernel exposes at `/proc/<pid>/environ`,
which every same-uid descendant can read — and the Bash tool the model drives is exactly
such a descendant. Measured 2026-08-12: the child's own `env` reads clean (`inherited-env:
0`) while `/proc/$PPID/environ` reads `1`. The obvious probes all pass, which is why it
survived four rounds of review.

`harness-eval.mjs` closes it three ways: it **refuses to start** if `OPENROUTER_API_KEY` is
in its own environment, it reads the key from `--key-file`, and it hands worker config to
the child over stdin with an allowlisted environment. `redactKey()` covers captured stderr.
Guard: `harness-eval-key-leak.test.ts` — note its **negative control**, which must report
LEAKED; a leak detector that cannot fail is not a detector.
<!-- verify: {"path": "youcoded/desktop/test-engine/harness-eval.mjs", "contains": "OPENROUTER_API_KEY"} -->

**`review-harness.mjs` still has the original bug.** It is otherwise superseded — it now
imports its runner logic from `dist/main/harness/eval/`. Retiring it is an open decision
(workspace `docs/roadmap/dev-workspace.md`, status `decision`).

## Grading

Two independent halves, and neither may quietly stand in for the other.

`assertions.ts` reads the event stream and returns **three** states per check —
`passed` / `failed` / `never-ran`. A check whose precondition never fired measured nothing;
rendering that as a pass is the failure mode this design exists to prevent. The first
version keyed "never ran" on an empty event list, which is unreachable in production
(`beginTurn` emits `user-message` synchronously), so a provider 402 was scored as a model
failure.

`judge.ts` scores prose against a case's rubric. **Every grade must quote the answer
verbatim**, and a grade whose quote is not literally present is discarded rather than
trusted. Contradiction warnings (a judge praising a tool the transcript never shows) key on
`called-tool:` check ids, not on the judge's free text — an earlier version scanned the
prose and so read "the model never used Edit" as proof that it did.

`JUDGE_SCALE_MAX` is one system-wide constant baked into the judge prompt, score validation
and two report sites. Changing the scale means changing all four together.

## Purity boundaries

`report.ts`, `estimate.ts`, `matrix.ts` and `appendReview` are pure — no filesystem, no
network, no clock. That is what makes "never disturbs another model's review" and "renders
`never ran` differently from `passed`" testable at all; the CLI does all reading and
writing, and passes in the clock. Guard: `harness-review-runner.test.ts` → "leaves every
existing review byte-identical".

Corollary for the CLI: **every exit path that has results must write both the report and
the summary.** An earlier version wrote them only on the paths that returned normally, so
the whole class of failures that rejected out of `runMatrix` left no record of cells that
had already been paid for.

## What the estimate is worth

`estimate.ts` runs before anything is spent, and the run is capped by `--max-spend`, which
is re-checked against OpenRouter's own billing between cells. Input dominates output
heavily because the whole conversation is resent every step — but the ratio is not stable
(10× to 206× across the measured rows; `estimate.ts` refuses a single multiplier for that
reason), so never price from one).

**It is biased high on purpose, and you need to know by how much.** A cell is priced from
the **MAX** of that case's measured samples, never the mean: under-predicting spends money
the operator did not agree to, and a single agentic run's cost is not stable — Qwen 3.8 Max
used 342,207 input tokens on one `config-investigation` run against a 189,087 mean across
three. That deliberate bias costs about **2.2×**: the six-cell calibration plan estimates
$3.29 against a real bill of $1.52 (~$0.25 a cell including its judge call). Since `ebc59c35`
(2026-09-01) the evaluator also reads OpenRouter's own per-request cost into
`metrics.providerCostUsd` and prints it per cell beside the estimate, so the gap is measured
on every paid run rather than hand-copied from one calibration.

It was **~8× high** until 2026-08-13, because the tables were keyed by model alone and every
number in them came from whole-battery runs (40–63 tool calls) while the prose cases run
9–19. `MEASURED_CASE_TOKENS` now keys on case *and* model.

**A case with no measured row is still priced as a battery run.** That is the old ~8× error,
scoped to the rows it applies to — so those rows are listed separately in the estimate output
as battery-priced and labelled HIGH. `harness-battery` is exempt: for that case the battery
figures *are* a measurement. Never let a battery-priced row read as a measurement of the
case; a wrong number is survivable, a guess wearing a measurement's clothes is not.
<!-- verify: {"path": "youcoded/desktop/src/main/harness/eval/estimate.ts", "contains": "MEASURED_CASE_TOKENS"} -->

Adding measured rows means re-reading `run.metrics.inputTokens` / `.outputTokens` from the
saved transcripts of a real run; those files are git-ignored, so the numbers are transcribed
into the table rather than read at run time. That is the drift risk.

## Invariants that used to live in the rule

Moved out of `.claude/rules/harness-evaluator.md` on 2026-09-05 when it went over its
600-word budget. Each is about **changing** the evaluator, which is what this document is
for; the rule kept what you need to **run** one. None is retired — every guard still runs.

- **The grader always loads from the orchestrator's own build; only the worker loads the
  cell's `dist`** — else a branch-vs-master run silently compares two *graders* too.
  `paths.ts`: `graderRoot()` (ignores its argument on purpose) vs `harnessRoot(cell)`.
  Guard: `harness-eval-orchestrator.test.ts`.
- **A check has three states, and `never-ran` is not `passed`** — nothing was measured, and
  the report must render it visibly differently. The first version keyed it on an empty
  event list, unreachable in production, so a provider billing failure scored as a model
  failure. Guards: `harness-eval-assertions.test.ts` (discrimination-tested),
  `harness-eval-report.test.ts`.
- **Every run ends in an answer or a labelled failure** — three FACT triggers each send a
  second `WRAP_UP_PROMPT` turn with every tool denied. Scope per-turn scans to the *testing*
  turn; an unscoped scan sees the wrap-up and mislabels a run that recovered. `runCase` never
  throws for a run that produced events — round 5 lost four transcripts to a rejected promise.
