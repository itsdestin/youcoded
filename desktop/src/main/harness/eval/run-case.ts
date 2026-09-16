// Drive one model through the battery inside a disposable fixture.
//
// WHY no Electron: HarnessSession takes an injected modelFactory, decide, and
// askUser, so the whole loop runs in plain Node. That keeps the runner clear of
// the live app entirely — no userData, no ~/.youcoded writes, no safeStorage.
import * as fs from 'fs';
import { HarnessSession, type ModelFactory } from '../harness-session';
import { ASSISTANT_PRESET } from '../../../shared/harness-manifest';
import { CORE_TOOLS } from '../tools';
import { seedFixtureWorkspace } from './fixture-workspace';
import { assembleSystemPrompt } from '../prompt-assembly';
import { resolvePreset } from '../preset-registry';
import { BATTERY_PROMPT } from './battery';
import type { TranscriptEvent } from '../../../shared/types';
import type { AskRequest, AskDecision } from '../permission-broker';
import type { SkillCatalog } from '../skills/skill-catalog';
import type { ToolServices, NativeTool } from '../tools/types';
import { ddgBackend } from '../search/backends/ddg';

export type CaseOutcome = 'complete' | 'wrapped-up' | 'no-review' | 'error';

export interface CaseMetrics {
  wallClockMs: number;
  toolCalls: number;
  asks: number;
  stepGates: number;
  /** COUNT of assistant-thinking events, not a token figure — StepUsage
   *  (harness-session.ts:109) has no reasoning field. Still the number that
   *  makes a provider-side reasoning shift visible: the same model on the same
   *  commit went 232 -> 1,691 between two runs 4.5 hours apart on 2026-08-10,
   *  and nothing in the old output showed it. */
  thinkingEvents: number;
  inputTokens: number;
  outputTokens: number;
  /** USD the PROVIDER ITSELF billed for this run — OpenRouter's `usage.cost`,
   *  read off the wire by openRouterCostExtractor (openrouter-factory.ts) and
   *  summed here across every turn-complete. Present ONLY when every turn
   *  carried one; a run where any turn reported nothing is `undefined`, never
   *  a partial sum and never 0 (same rule as shared/types.ts's
   *  providerCostUsd). This is the figure the retired MEASURED_ROSTER_SPEND_USD
   *  anchor stood in for: per cell, per round, from the biller. */
  providerCostUsd?: number;
  /** One per turn-complete, in order. A budget-triggered wrap-up has two (the
   *  testing turn's 'max_steps', then the wrap-up turn's own finish reason);
   *  a timeout-triggered one usually has one, since interrupt() ends the
   *  testing turn via 'user-interrupt' (no turn-complete), not a finish. */
  stopReasons: string[];
  /** Distinct tool names actually invoked, sorted. The evidence a review's
   *  claims are checked against (run-facts.ts). */
  toolsUsed: string[];
  /** (toolName, input) pairs seen at least REPEAT_REPORT_FLOOR times.
   *  DIAGNOSTIC ONLY — nothing acts on this; see REPEAT_REPORT_FLOOR. */
  repeats: { key: string; count: number }[];
}

export interface CaseRun {
  label: string;
  modelId: string;
  review: string;
  events: TranscriptEvent[];
  toolCalls: number;
  asks: number;
  // How many times the max_steps budget gate fired (allowed or denied). See
  // STEP_GATE_ALLOWANCE below for what "allowed" means. A gated run's review
  // is still worth reading, but a reviewer interpreting it should know the
  // model needed extra room — this was invisible until the run either
  // finished quietly or failed outright (the Opus 5 incident this field
  // exists to surface).
  stepGates: number;
  fixtureRoot: string;
  /** How the run ended. `wrapUpReason` being set WINS over every other case
   *  below (Fix pass 2, Finding 5) — 'wrapped-up' means only "a wrap-up turn
   *  ran," not "it produced a review": a wrap-up turn that itself errored, or
   *  that ran and still produced nothing, both still report 'wrapped-up',
   *  because the run being cut short is the fact a caller most needs to see.
   *  Callers that care whether the wrap-up actually delivered must check
   *  `review` (or `error`) separately, as the CLI does
   *  (test-engine/review-harness.mjs). Only when wrapUpReason is undefined do
   *  the remaining cases apply: 'error' — the provider or session threw; see
   *  `error`. 'complete' — the (single) testing turn finished on its own with
   *  a non-empty review. 'no-review' — the testing turn finished with empty
   *  final text and nothing else went wrong. */
  outcome: CaseOutcome;
  /** Which trigger sent the run to a wrap-up turn, if any. Undefined means the
   *  testing turn ended on its own. 'budget' and 'timeout' fire on the testing
   *  turn's own outcome (max_steps exhaustion, wall clock); 'stopped-early'
   *  fires when the turn ended on its own having produced no review at all.
   *  A fourth value, 'restart', existed until 2026-08-11 — REPEAT_REPORT_FLOOR
   *  records why it was deleted rather than retuned. */
  wrapUpReason?: 'budget' | 'timeout' | 'stopped-early';
  /** The REAL error message, never a substitute (error-message-standards.md). */
  error?: string;
  metrics: CaseMetrics;
}

// Root-cause fix (2026-08-09): the first full-roster live run denied EVERY
// max_steps gate outright, on the reasoning (stated in a prior version of
// this file, and in the plan brief that requested that denial) that the
// ~40-item battery would stay well under the then-current guard. That
// prediction was empirically wrong. Real full-roster numbers: Kimi K3 56 tool calls,
// Deepseek v4 flash 0731 47, Grok 4.5 37, GPT 5.6 Luna 47 — all finished
// fine — while long evaluator runs still need their own explicit cap and allowance; denial at the gate lost the
// entire review after a paid run produced nothing (harness-session.ts:1100-
// 1102: a non-'allow' answer sets stopReason='max_steps' and breaks the turn
// loop outright — unlike doom_loop, which only fails the one repeated call
// and lets the run continue). Opus was simply the most thorough model, not a
// runaway one.
//
// WHY 1, not 4: the evaluator now owns a 100-step budget, above every healthy
// run measured, so reaching the gate is signal rather than routine. BATTERY_STEP_BUDGET
// below sets 100 directly, above every healthy run ever measured (round 4: Kimi
// K3 56 tool calls, Deepseek 47, Grok 37, GPT 47, Opus 80), so reaching the gate
// at all is now real signal. One continuation is grace for an unusually thorough
// run; past that the testing turn ends and a wrap-up turn (below) asks for the
// review instead of losing it outright, which is what cost Opus 5 its entire
// review on 2026-08-09.
// Ceiling math: 2 windows * 100 = 200 steps, then a final wrap-up turn.
export const STEP_GATE_ALLOWANCE = 1;

// Sent as a SECOND turn on the same session when the testing phase is cut short.
// WHY a second turn and not a bigger budget: the failure is not "the model needed
// more room", it is "the model never got asked for the deliverable". Round 5's
// Qwen 3.5 122B (127 calls) and Qwen 3.8 Max (157 calls) both ended on max_steps
// with no final text — paid runs that produced nothing readable. Reusing the same
// session keeps the model's whole history, so it reviews what it actually did.
export const WRAP_UP_PROMPT =
  'Your testing budget is spent. Do not run any more tools — any tool call you ' +
  'make now will be denied. Write your review of the harness now, covering ' +
  'whatever you managed to test.';

// The wrap-up turn's own ceiling. Much smaller than the testing phase: it is one
// message, and a model that cannot produce it in two minutes is not going to.
export const WRAP_UP_TIMEOUT_MS = 120_000;

/** Assistant text in `events` from `sliceFrom` onward, keeping only what sits
 *  after index `anchor` (window-local). Hoisted to module scope because the
 *  'stopped-early' trigger has to ask "did the testing turn produce anything?"
 *  BEFORE the wrap-up decision, while the final extraction asks the same
 *  question of the wrap-up window afterwards — one definition, two callers, so
 *  the two can never drift into disagreeing about what counts as a review. */
function pickReview(events: TranscriptEvent[], sliceFrom: number, anchor: number): string {
  return events
    .slice(sliceFrom)
    .filter((e, i) => e.type === 'assistant-text' && i > anchor)
    .map((e) => e.data.text ?? '')
    .join('')
    .trim();
}

// DIAGNOSTIC ONLY. Repeated calls at or above this count are reported in
// `metrics.repeats`; nothing acts on them.
//
// There WAS a 'restart' wrap-up trigger here, and deleting it — rather than
// retuning it a third time — is the point of this constant's existence.
//
// The history, because it is the whole argument: the trigger was built from a
// single observation (Qwen 3.8 Max, `Glob **/*` 14 times across 157 calls,
// 2026-08-10) and never validated against a healthy run. At 5 it tripped ALL
// EIGHT models in the roster, every one at exactly 6, truncating them mid-
// battery — Opus 5's trip was `Bash pwd; ls -la` six times, its own description
// reading "verify cwd persistence", which is battery area 1 verbatim. Raised to
// 12, it tripped five of eight, every one at exactly 13.
//
// That "always exactly one over the line" signature is the tell: repeats
// accumulate steadily with run length, so ANY threshold sits in the middle of
// legitimate behaviour rather than above it. And the behaviour is not merely
// legitimate, it is MANDATED — the battery asks the model to "verify cwd
// persistence across calls" (identical `pwd` calls) and the harness enforces
// read-before-edit (an identical `Read` before each `Edit`). Grok 4.5's 13x
// Read of each of four files, across 270 calls in which it reached all ten
// tools, is that contract being honoured, not a restart.
//
// Counting identical calls cannot separate a restarting model from a thorough
// one. The remaining three triggers do not guess: the step counter, the wall
// clock, and an empty final message are each a fact. All three end in the same
// wrap-up turn, so a genuine loop still yields a review — it just costs a
// longer run instead of a truncated one. That trade is the right way round.
//
export const REPEAT_REPORT_FLOOR = 5;

// Default wall-clock ceiling for the TESTING phase. Raised from 900_000 because
// at the 8.6s/step measured on 2026-08-10, 900s buys ~105 steps — which made the
// deadline, not BATTERY_STEP_BUDGET, the binding constraint. Now that a blown
// deadline triggers a wrap-up turn instead of killing the run, the raise costs
// little and leaves real testing room before wrap-up.
export const BATTERY_TIMEOUT_MS = 1_200_000;

// Fix (2026-08-10 incident): HarnessSession passes `harness.limits?.maxTokens`
// straight through to streamText's `maxOutputTokens` (harness-session.ts) with
// NO fallback when it's unset — and ASSISTANT_PRESET (the shared preset every
// real app session also uses) leaves `limits` undefined. With no explicit
// ceiling, the OpenRouter request omits `max_tokens` entirely, and OpenRouter
// falls back to reserving the MODEL's own advertised max output against the
// account balance up front — 65,536 for Claude Opus 5. That is not "out of
// credits": the account failed twice with "You requested up to 65536 tokens,
// but can only afford 63293" while Opus's last SUCCESSFUL battery run used
// only 8,379 output tokens in total, across the entire run. Real per-run
// totals measured from live transcripts (turn-complete's data.usage.output-
// Tokens, which HarnessSession accumulates across every step of the whole
// run — see harness-session.ts's turnUsage): Opus 8,379 (prior successful
// run), Qwen 3.8 Max 11,766, Deepseek v4 Flash 0731 9,530, GPT 5.6 Luna
// 4,098, Grok 4.5 3,662 — and even each run's own final free-form review
// message (the longest single step) never exceeded ~2,200 estimated tokens.
// WHY 8,000 and not the 32,000 this was until 2026-08-11: 32,000 silently gave
// every model AMNESIA, and every strange result from rounds 5-7 traces to it.
//
// fitToContext (harness-session.ts) sizes history as
//     ctx (opts.contextLength ?? 32_768) - limits.maxTokens - 1024
// and runCase passed no contextLength, so the sum was
//     32_768 - 32_000 - 1_024 = -256
// — a NEGATIVE history budget, measured, on every request. With a non-positive
// budget the size loop keeps exactly one message (its own comment: "history
// collapses to that single message rather than erroring"), and the pair-aware
// front trim then splits two ways: mid-turn the survivor is a tool result, so
// salvageOversizedTail rebuilt [battery prompt, last tool-call, last result] —
// the instructions plus ONE exchange, no record of anything else the model had
// done; on the wrap-up turn the survivor is the new user message, so the model
// got the wrap-up prompt ALONE. Four models said so in their reviews ("this
// message is the first one in our session") after 67-309 tool calls.
//
// That is the real source of the "restart" behaviour that cost two rounds of
// threshold-tuning: a model re-reading the full battery every step with no
// memory of its progress re-runs `pwd`, re-Globs, and never finishes.
//
// A smaller ceiling also serves this constant's ORIGINAL purpose better, not
// worse. It exists because OpenRouter reserves the requested max_tokens against
// the account balance up front, and an unset value let it reserve a model's full
// hosted max — 65,536 for Opus 5, which failed twice with "You requested up to
// 65536 tokens, but can only afford 63293". Measured real spend: the longest
// SINGLE step in any run (its own final review message) never exceeded ~2,200
// tokens, and whole-run output totals ran 3,662-11,766. 8,000 is ~3.6x the
// largest single step, and reserves a quarter of what 32,000 did.
//
// WHY here, not on ASSISTANT_PRESET: ASSISTANT_PRESET is shared configuration
// used by every real app session (see harness-manifest.ts), so raising or
// lowering it globally would change Destin's live app behavior — out of
// scope for a battery-runner defect. Verified tree-wide that NOTHING else sets
// `limits` at all, so a real session leaves maxTokens undefined and takes
// fitToContext's own `?? 4096` fallback (budget 27,648 — healthy). This bug was
// runner-only by construction.
export const BATTERY_MAX_OUTPUT_TOKENS = 8_000;

// Used when a roster entry declares no contextLength. Deliberately the same
// 32_768 fitToContext already defaults to: a conservative wrong answer costs
// earlier compaction, while an optimistic one overflows the model and 400s
// mid-run.
export const DEFAULT_BATTERY_CONTEXT_LENGTH = 32_768;

// Ceiling on how much of a model's real window the battery will actually use.
//
// WHY cap at all, when the roster now carries real windows (262k-1M)? Cost.
// History rides on EVERY request, so an uncapped 1M window turns a 300-call run
// into hundreds of enormous prompts. 64,000 comfortably holds a whole battery's
// worth of exchanges (~60 calls) while bounding per-request spend, and anything
// past it is compaction's job — which is exactly what compaction is for.
//
// This is the one number to raise if a round shows models losing context to
// compaction before finishing.
export const BATTERY_CONTEXT_CAP = 64_000;

/** Reserve fitToContext subtracts on top of maxTokens (harness-session.ts). */
const FIT_TO_CONTEXT_RESERVE = 1_024;

/** The share of the window that must survive as history for a run to be worth
 *  paying for. */
const MIN_HISTORY_SHARE = 0.5;

/** Throw BEFORE spending money if the output ceiling has eaten the history
 *  budget. This is the guard that did not exist when a -256 budget shipped and
 *  silently ran three paid rounds against models that could not remember their
 *  own work. It names both numbers so the fix is obvious from the message. */
export function assertHistoryBudget(contextLength: number): void {
  const budget = contextLength - BATTERY_MAX_OUTPUT_TOKENS - FIT_TO_CONTEXT_RESERVE;
  const share = budget / contextLength;
  if (share < MIN_HISTORY_SHARE) {
    throw new Error(
      `Battery misconfigured: a ${contextLength}-token window minus a `
      + `${BATTERY_MAX_OUTPUT_TOKENS}-token output ceiling minus a `
      + `${FIT_TO_CONTEXT_RESERVE}-token reserve leaves ${budget} tokens for history `
      + `(${Math.round(share * 100)}% of the window; at least `
      + `${Math.round(MIN_HISTORY_SHARE * 100)}% required). Lower `
      + `BATTERY_MAX_OUTPUT_TOKENS or raise the roster entry's contextLength.`,
    );
  }
}

// WHY explicit: evaluator runs need a deterministic budget independent of app
// preferences. The battery is the same job whichever model runs it, and 100 is
// above every healthy run measured to date. HarnessSession gates only explicit
// maxSteps, so this runner-owned manifest is the complete evaluator policy.
export const BATTERY_STEP_BUDGET = 100;

// A battery-only harness: same shape as ASSISTANT_PRESET (tools, permission
// posture, prompt) but with explicit output and step ceilings layered on top via a
// fresh object — ASSISTANT_PRESET itself is a shared module-level const, so
// mutating it in place would leak the override into every other consumer
// (real app sessions included). Spreading `limits` too, not just replacing
// it, keeps this forward-compatible if ASSISTANT_PRESET ever gains a
// maxSteps override of its own.
export const BATTERY_HARNESS = {
  ...ASSISTANT_PRESET,
  limits: {
    ...ASSISTANT_PRESET.limits,
    maxTokens: BATTERY_MAX_OUTPUT_TOKENS,
    maxSteps: BATTERY_STEP_BUDGET,
  },
};

export interface RunCaseOpts {
  modelFactory: ModelFactory;
  modelId: string;
  label: string;
  /** The task prompt. WHY optional: every existing caller (test-engine/
   *  review-harness.mjs, the 69 pinning tests) predates the evaluator and
   *  must keep running the battery unchanged. Defaults to BATTERY_PROMPT. */
  prompt?: string;
  /** Sent as the forced-final-answer turn when the run is cut short. WHY
   *  per-task: WRAP_UP_PROMPT literally says "write your review of the
   *  harness", which is wrong for every task that is not the harness review.
   *  Defaults to WRAP_UP_PROMPT. */
  wrapUpPrompt?: string;
  /** Tool set attached to the session. WHY a tool-set input: a task can ask
   *  "is Grep earning its context slot?" by running with it detached.
   *  Defaults to CORE_TOOLS. */
  tools?: NativeTool[];
  /** Wall-clock ceiling for one model's whole battery. */
  timeoutMs?: number;
  /** Keep the fixture on disk for debugging. Default false. */
  keepFixture?: boolean;
  /** The model's real context window, from the roster. Omitted falls back to
   *  DEFAULT_BATTERY_CONTEXT_LENGTH; the value used is capped at
   *  BATTERY_CONTEXT_CAP. Without this the session takes fitToContext's own
   *  32_768 default, which is what produced the 2026-08-11 amnesia bug. */
  contextLength?: number;
  /** Markdown written into the fixture as CLAUDE.md before the session starts,
   *  so assembleSystemPrompt's real disk-read path picks it up as project
   *  instructions. `null`/absent means no file — the no-instructions arm of an
   *  instruction A/B. See fixture-workspace.ts's seedFixtureWorkspace for why
   *  this has to be a real file rather than text handed to the session
   *  directly. */
  instructions?: string | null;
}

// No skills, no path-triggered rule injection: the fixture has neither, and
// injecting the real machine's skills would make runs machine-dependent (the
// same reasoning tests/helpers/harness-fakes.ts documents for
// EMPTY_SKILL_CATALOG — a review that reached ~/.claude would not be a review
// of the ten CORE_TOOLS, it would be a review of whoever's machine ran it).
// SkillCatalog.list() is synchronous (skill-catalog.ts) — the brief's
// `{ list: async () => [] }` returns a Promise where a plain array is
// expected, which happened to type-check only because of its `as any` cast.
const EMPTY_SKILL_CATALOG: SkillCatalog = {
  list: () => [],
  load: (id: string) => {
    throw new Error(`no skills installed (review fixture): ${id}`);
  },
};

// Defect 2 fix: runCase previously never passed `toolServices` at all, so
// WebSearchTool's `if (!ctx.services?.search)` guard always tripped and every
// live run reported "Web search is not wired for this session" — a false
// finding, not a real harness limitation, and it left battery area 6 (Web)
// permanently untestable.
//
// WHY the keyless DDG backend and not the full SearchService
// (search-service.ts): SearchService wants a chain resolver + a key store,
// neither of which this disposable Node-only fixture has any business
// touching (constructing one would mean reading the app's saved
// provider keys — exactly the live-app boundary this runner exists to stay
// outside of, per the file's top-of-file WHY comment). The runner's only
// credential is OPENROUTER_API_KEY, so the backend must need none — ddg is
// the one entry in the chain (search/backends/) that qualifies. `ToolServices`
// (tools/types.ts) is structural, so a minimal adapter satisfying
// `search(query, signal): Promise<{results, source}>` is enough; ddgBackend's
// real signature is `search(query, { key, signal, fetchImpl? })` returning
// `SearchResult[]` directly, so the adapter is a plain shape translation, not
// a workaround — `key: null` because ddg needs none, `fetchImpl` left
// undefined so it falls through to ddgBackend's own default (the real global
// `fetch`) in production, and is the one seam tests inject to avoid a live
// DuckDuckGo request.
//
// Errors are NOT caught here. A DDG failure (rate-limit, network, markup
// drift — see ddg.ts) throws SearchBackendError, which is not a
// SearchUnavailableError, so WebSearchTool's own catch re-throws it and
// defineTool's outer catch (registry.ts) turns it into
// "WebSearch failed: <ddg's real message>" — DDG's own honest failure text,
// never a guessed-at substitute (error-message-standards.md).
export function makeReviewSearchServices(fetchImpl?: typeof fetch): ToolServices {
  return {
    search: {
      async search(query: string, signal: AbortSignal) {
        const results = await ddgBackend.search(query, { key: null, signal, fetchImpl });
        return { results, source: ddgBackend.id };
      },
    },
  };
}

export async function runCase(opts: RunCaseOpts): Promise<CaseRun> {
  // Resolved and CHECKED before the fixture is seeded or a single token is
  // spent — a misconfigured window is a config error, not a run to salvage.
  const contextLength = Math.min(
    opts.contextLength ?? DEFAULT_BATTERY_CONTEXT_LENGTH,
    BATTERY_CONTEXT_CAP,
  );
  assertHistoryBudget(contextLength);
  // Defaults preserve battery behavior exactly (see the WHY comments on
  // RunCaseOpts.prompt/wrapUpPrompt above) — every pre-evaluator caller omits
  // these and gets the same prompt/wrap-up text runCase always sent.
  const prompt = opts.prompt ?? BATTERY_PROMPT;
  const wrapUpPrompt = opts.wrapUpPrompt ?? WRAP_UP_PROMPT;

  const fixtureRoot = seedFixtureWorkspace(opts.instructions);
  const events: TranscriptEvent[] = [];
  let toolCalls = 0;
  let asks = 0;
  let stepGates = 0;
  // Salvage metrics (round 5 fix): collected alongside the existing counters
  // above so a run that errors or times out still has something to write —
  // see the try/catch below and the outcome/metrics on the return value.
  const startedAt = Date.now();
  let thinkingEvents = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  // Provider-billed cost (ROADMAP L161). Two counters so a turn that reported
  // no cost makes the whole figure absent rather than silently short.
  let turnsCompleted = 0;
  let turnsWithProviderCost = 0;
  let providerCostUsd = 0;
  const stopReasons: string[] = [];
  const toolsUsed = new Set<string>();

  // Set for the duration of the wrap-up turn (declared above the
  // HarnessSession so both decide() and askUser below can close over it).
  // While true, every tool call is denied and every max_steps gate is
  // denied, so the model cannot resume testing — it answers in prose or not
  // at all. WHY a second turn instead of a bigger budget: see WRAP_UP_PROMPT's
  // WHY comment above.
  let wrappingUp = false;
  let wrapUpReason: CaseRun['wrapUpReason'];
  // Keyed on tool name + exact input. Reporting only — see REPEAT_REPORT_FLOOR.
  const repeatCounts = new Map<string, number>();

  const session = new HarnessSession(
    {
      sessionId: `review-${Date.now()}`,
      cwd: fixtureRoot,
      harness: BATTERY_HARNESS,
      // Fix (2026-08-12): without this, HarnessSession falls through to
      // opts.harness.systemPrompt — which harness-manifest.ts:12 documents as a
      // "fallback one-liner" and which is literally one sentence. Every harness
      // review to date ran on that sentence rather than the app's real prompt, so
      // the battery has never tested the shipped prompt at all. Calling the real
      // assembleSystemPrompt also gives us the <project-instructions> block, which
      // is what makes a CLAUDE.md A/B possible.
      //
      // KNOWN FIDELITY GAP (Task 3 review, Fix 4): this passes only the three
      // required PromptInputs fields (presetBody, cwd, appVersion). The one
      // production caller, native-session-host.ts (`assembleSystemPrompt({
      // ..., promptVariant: profile.promptVariant, hasTools: profile.supportsTools,
      // instructionBudgetTokens: profile.injectionBudgetTokens })`), also passes
      // promptVariant, hasTools, and instructionBudgetTokens, all sourced from the
      // session's resolved CapabilityProfile. Omitting them here means this
      // evaluator always assembles the prompt with NO variant overlay and
      // prompt-assembly.ts's default 20,000-token instruction budget
      // (DEFAULT_INSTRUCTION_BUDGET_TOKENS), regardless of which model is being
      // tested — not the profile the real app would resolve for that model.
      //
      // Currently safe: tests/prompt-assembly.test.ts:118-120 pins the
      // default/anthropic/gpt variants as byte-identical to no variant at all,
      // and only the local-small variant appends text — the OpenRouter roster
      // this evaluator drives never resolves to local-small. 20k tokens has also
      // been enough for every CLAUDE.md used in an eval run to date.
      //
      // Stops being safe when: (1) a local/small model that resolves to the
      // local-small prompt variant is added to the roster this evaluator runs
      // against, so the review would silently omit the plan-then-execute
      // steering the real app would give that model; or (2) an instruction A/B
      // is run with a CLAUDE.md/AGENTS.md long enough to exceed 20k tokens,
      // which fitProjectInstructions (injection-budget.ts) would then silently
      // truncate to a budget the real profile might not have used. Wiring a
      // resolved CapabilityProfile through `runCase` is out of scope for this
      // fix — see the Task 3 Fix pass 1 report.
      systemPrompt: assembleSystemPrompt({
        presetBody: resolvePreset('assistant').body,
        cwd: fixtureRoot,
        appVersion: 'eval',
      }),
      // Load-bearing (2026-08-11): omitted, HarnessSession takes fitToContext's
      // own 32_768 default, which against this harness's output ceiling left a
      // NEGATIVE history budget and gave every model amnesia. See
      // BATTERY_MAX_OUTPUT_TOKENS. assertHistoryBudget below refuses to spend
      // money if that relationship is ever broken again.
      contextLength,
      binding: { providerId: 'openrouter', modelId: opts.modelId },
      // No `pricing`/`free` passed on purpose, so every eval turn goes out with
      // costUsd: null, free: false. That is not an oversight: the evaluator
      // prices its own runs from the live OpenRouter price catalog
      // (eval/estimate.ts, driven by test-engine/harness-eval.mjs), which is
      // where the spend cap and the per-cell dollar figures come from. Handing
      // HarnessSession a second rate card here would produce a second answer
      // that could disagree with the one the CLI reports. The per-turn price
      // card is a live-session concern — it feeds the app's status bar, which
      // no eval run has.
      tools: opts.tools ?? CORE_TOOLS,
      // Auto-approve everything decide() is consulted about — EXCEPT during the
      // wrap-up turn, where every tool call is refused so the model must answer.
      // NOTE: PermissionDecision (shared/permission-types.ts:17) carries only
      // `action` and `denyListed` — there is no message field, so the model sees
      // the generic tool-denial result. WRAP_UP_PROMPT is what explains why.
      // (The fixture jail does NOT rest on this — see askUser below.) WHY this
      // does NOT by itself hold the fixture jail: the tool-layer path guard
      // (harness-session.ts checkPathGuard, called from runOneTool step 3) sits
      // BELOW decide and, for any path-subject tool (Read/Write/Edit) pointed
      // outside the session cwd, forces `{ action: 'ask' }` BEFORE decide() is
      // even called (harness-session.ts:1469-1471 — `externalAsk ? {action:'ask'} :
      // decide()`). So decide() being fully permissive (outside wrap-up) is
      // irrelevant to those calls; askUser below is what actually has to hold
      // the line.
      // Plan correction: this field IS spelled `action` (PermissionDecision,
      // shared/permission-types.ts:17-22) — unlike askUser below, which is not.
      decide: async () => ({ action: wrappingUp ? 'deny' : 'allow', denyListed: false }),
      // Deterministic answerer for the ONE ask kind this fixture is meant to
      // reach: a genuine AskUserQuestion tool call. WHY that matters —
      // AskUserQuestion was the one tool no reviewer reached (Kimi K3 finding
      // #6), because a human had to be present to answer it. A fixed answer
      // makes it reachable and keeps runs reproducible.
      //
      // WHY every OTHER ask kind is denied — with ONE bounded exception below —
      // and not allowed: HarnessSession routes three unrelated ask kinds
      // through this SAME callback, and none of them carry a `questions`
      // field —
      //   - harness-session.ts:1478 — the forced 'ask' described above (Write/
      //     Read/Edit pointed outside the fixture root, e.g. Write("/home/x")).
      //     Allowing this unconditionally is a real local-file write/read
      //     against the machine running the CLI, not the fixture — the exact
      //     hole a Critical finding caught (the fixture jail did not hold).
      //     Still ALWAYS denied. Unchanged by this fix. Has its own test.
      //   - harness-session.ts:1432 — the doom_loop guard's ask. Still ALWAYS
      //     denied: harness-session.ts:1437 turns a non-allow into a
      //     model-facing error result for just the one repeated call, and the
      //     run continues — denying here is harmless and correct.
      //   - harness-session.ts:1100 — the max_steps guard's ask. See
      //     STEP_GATE_ALLOWANCE above the function: unlike doom_loop, a
      //     non-'allow' answer here ends the WHOLE turn (stopReason=
      //     'max_steps', harness-session.ts:1102), which is what cost a paid
      //     Opus 5 run its entire review on 2026-08-09. Now bounded-allowed
      //     instead of always-denied.
      // A prior version of this callback answered ALL of these with `allow`
      // (its `questions` loop ran zero times on the ones above, then fell
      // through to an unconditional allow) — silently disabling both spend
      // guards and letting Write/Read escape the fixture. Denying
      // external-directory and doom_loop is not just safer, it is CORRECT: a
      // properly scoped battery run should never produce an external-
      // directory ask or a doom loop, so a denial turns a regression into a
      // loud error result in the transcript instead of quietly executing
      // outside the fixture or spinning on a stuck model. max_steps is
      // different — a long battery legitimately NEEDS more than one budget
      // window — hence the bounded allowance instead of an outright deny.
      // NOT `{ behavior: 'canceled' }` for any of these: harness-session.ts:
      // 1479 treats 'canceled' as a user interrupt that aborts the whole
      // turn — these are policy decisions, not aborts.
      // `asks` counts every ask that reaches this callback, answered or
      // denied — it is "how many times something needed a human," which is
      // exactly what a denied doom-loop/external-path ask, OR an
      // auto-allowed max-steps continuation, still is: a real spend/policy
      // decision was made on the model's behalf, just not by a human this
      // time. `stepGates` (below) is the narrower, max_steps-only count the
      // CLI surfaces per-model — `asks` alone can't tell a reviewer "this
      // model needed extra room" from "this model asked a real question."
      askUser: async (req: AskRequest): Promise<AskDecision> => {
        asks++;
        if (req.toolName === 'max_steps') {
          stepGates++;
          // During wrap-up there is no more testing to fund: deny outright.
          if (wrappingUp) return { behavior: 'deny' };
          // Bounded allowance (see STEP_GATE_ALLOWANCE's WHY comment above
          // the function for the value and its justification). Past the cap,
          // deny — the turn ends with stopReason 'max_steps', which is what
          // sends the run to the wrap-up turn below instead of losing the
          // review outright (the correct outcome for a genuine runaway).
          return stepGates <= STEP_GATE_ALLOWANCE
            ? { behavior: 'allow' }
            : { behavior: 'deny' };
        }
        // Fix pass 2, Finding 2: WRAP_UP_PROMPT tells the model "any tool call
        // you make now will be denied" — but AskUserQuestion is declared
        // `interactive: true` (ask-user-question.ts), and harness-session.ts
        // (runOneTool step 2.5) routes interactive tools AROUND guards AND
        // decide() entirely, straight to this callback. `decide` returning
        // 'deny' during wrap-up (above) never touches it, so denying it has
        // to happen HERE, or the prompt's promise is false for the one tool
        // most likely to keep a wrap-up turn looping — bounded only by
        // WRAP_UP_TIMEOUT_MS — instead of answering. The TESTING turn still
        // allows it below: reaching AskUserQuestion at all is something the
        // battery specifically wants models to do (Kimi K3 finding #6 — no
        // model ever got there).
        if (wrappingUp && req.toolName === 'AskUserQuestion') return { behavior: 'deny' };
        const questions = req.toolName === 'AskUserQuestion'
          ? (req.toolInput?.questions as
              | Array<{ question: string; options?: { label: string }[] }>
              | undefined)
          : undefined;
        if (!Array.isArray(questions)) return { behavior: 'deny' };
        const answers: Record<string, string> = {};
        for (const q of questions) answers[q.question] = q.options?.[0]?.label ?? 'yes';
        return { behavior: 'allow', updatedInput: { questions, answers } };
      },
      skillCatalog: EMPTY_SKILL_CATALOG,
      // Defect 2 fix: without this, WebSearchTool's execute() always hits its
      // `!ctx.services?.search` guard (harness-session.ts:1498 only spreads
      // `services` when `toolServices` is set) — see makeReviewSearchServices'
      // WHY comment above for the rest of the reasoning.
      toolServices: makeReviewSearchServices(),
      // triggers absent → no path-triggered injection, same as every other
      // pre-M3 caller (HarnessSessionOpts.triggers doc comment).
    },
    opts.modelFactory,
  );

  session.on('transcript-event', (e: TranscriptEvent) => {
    events.push(e);
    // Fix pass 1, Finding 2: HarnessSession emits 'tool-use' for a step BEFORE
    // execution and BEFORE decide() is consulted, so a call denied during
    // wrap-up would otherwise still land here. That matters because
    // CaseMetrics.toolsUsed is documented as "the evidence a review's
    // claims are checked against" (run-facts.ts consumes it that way — it
    // flags a review that names a tool absent from toolsUsed) — a denied
    // wrap-up attempt injecting a tool name into toolsUsed would silently
    // defeat that check for real. A wrap-up turn is a WHOLE turn of denied
    // calls, so exclude it entirely rather than leaving the leak incidental;
    // toolCalls is gated the same way so the two stay paired. Fix pass 2,
    // Finding 7: `asks` and `stepGates` (askUser above) are NOT gated by
    // wrappingUp — a wrapped-up run's asks/stepGates counts include wrap-up
    // denials (the AskUserQuestion denial above, a redundant max_steps deny)
    // while toolCalls/toolsUsed do not, so the two families are not meant to
    // reconcile 1:1; they answer different questions ("what did the model
    // attempt" vs. "how many times did something need a human/policy call").
    //
    // Fix pass 2, Finding 3: excluding the wrap-up turn narrows the leak, it
    // does not close it. `toolsUsed` records tools the model ATTEMPTED, never
    // a proof any of them EXECUTED — the 'tool-use' event (harness-session.ts
    // ~:1096) still fires before every other gate in runOneTool
    // (harness-session.ts:1487-1560): zod input validation, the path guard's
    // hard `deny`, the doom-loop denial, the external-directory ask denial,
    // and the canceled back-fill after an interrupt. A model that calls Edit
    // with malformed arguments never runs Edit, but Edit still lands in
    // toolsUsed — so a review that falsely claims Edit behavior it never
    // exercised would NOT be flagged by run-facts.ts's unbacked-claims check.
    // Filtering on `isError` would be wrong, not a fix: the battery
    // deliberately exercises error paths, and a genuine Edit duplicate-string
    // refusal IS an error result that SHOULD count as "Edit was used."
    // Anyone trusting the unbacked-claims check needs to know this is its
    // floor: it catches a tool with ZERO attempts of any kind, not a tool
    // that was attempted-but-never-executed. (The same leak exists, unfixed,
    // for calls denied during the TESTING turn — e.g. a Write pointed outside
    // the fixture — pre-existing and out of scope here.)
    if (e.type === 'tool-use' && !wrappingUp) {
      toolCalls++;
      // toolName is the field name on TranscriptEvent.data (shared/types.ts:148),
      // not `name` — the tool-use payload mirrors CC's transcript shape.
      if (e.data.toolName) toolsUsed.add(e.data.toolName);
      // Repeat counting is now DIAGNOSTIC ONLY — it reports, it never acts.
      // See REPEAT_REPORT_FLOOR for why the trigger that used to live here was
      // deleted rather than retuned. Keyed on tool name + exact input, inside
      // the same `!wrappingUp` guard so denied wrap-up calls never inflate it.
      const key = `${e.data.toolName ?? '?'} ${JSON.stringify(e.data.toolInput ?? {})}`;
      repeatCounts.set(key, (repeatCounts.get(key) ?? 0) + 1);
    }
    if (e.type === 'assistant-thinking') thinkingEvents++;
    if (e.type === 'turn-complete') {
      if (e.data.stopReason) stopReasons.push(e.data.stopReason);
      inputTokens += e.data.usage?.inputTokens ?? 0;
      outputTokens += e.data.usage?.outputTokens ?? 0;
      turnsCompleted++;
      const billed = e.data.usage?.providerCostUsd;
      if (typeof billed === 'number' && Number.isFinite(billed)) {
        turnsWithProviderCost++;
        providerCostUsd += billed;
      }
    }
  });

  // Fix pass 1, Finding 3: the whole post-setup body is now one try/finally so
  // teardown (session.destroy() + fixture rmSync, at the bottom) is guaranteed
  // again — it used to be two bare statements after the wrap-up block, and
  // every path between the testing turn and those lines happened to be total,
  // but nothing enforced that. A future throw anywhere in this stretch (e.g.
  // in the review extraction) would otherwise leak a tmpdir fixture and a
  // live session holding an abort controller and listeners. Nothing inside
  // changes: the review extraction and the return value still see exactly
  // what they saw before — `finally` runs after the return expression is
  // built but before the function actually returns to the caller.
  try {
    const timeoutMs = opts.timeoutMs ?? BATTERY_TIMEOUT_MS;
    // Deviation from the brief's variable name only: `error` (not `err`) is the
    // outer binding read by the outcome/return logic below; the caught value is
    // still carried through as-is, never replaced with a guessed cause.
    let error: string | undefined;

    // The deadline INTERRUPTS rather than rejecting. interrupt()
    // (harness-session.ts:1598) ends the in-flight turn cleanly and lets send()
    // resolve with everything gathered — the old Promise.race abandoned a live
    // promise and discarded the whole run, which is how round 5 lost four
    // models. `.unref()` keeps the process from hanging on this timer; it fires
    // at most once (the testing turn either finishes and clears it below, or
    // this callback runs and there is nothing left to clear it early).
    const deadline = setTimeout(() => {
      wrapUpReason ??= 'timeout';
      session.interrupt();
    }, timeoutMs);
    deadline.unref();

    // WHY: captured immediately before send() so the session-error scan below
    // can be scoped to THIS turn only. The wrap-up turn below is a second
    // send() on this same session, which appends more events to this same
    // array — an unscoped scan would find a 'session-error' left over from a
    // failed first turn and mislabel a wrap-up turn that actually succeeded
    // (or vice versa).
    const eventsBeforeSend = events.length;
    try {
      await session.send(prompt);
    } catch (err) {
      // Salvage, don't discard. A provider error still leaves a transcript
      // worth writing — round 5 threw four of them away and left the failures
      // undiagnosable. The REAL message is carried through, never a guess.
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(deadline);
    }

    // Deviation from the brief's snippet, found by running its own test: a
    // provider error that survives HarnessSession's internal retries does NOT
    // reject send() at all — beginTurn's own catch (harness-session.ts:1176-1188)
    // swallows it and emits a 'session-error' transcript event instead, then
    // returns normally. So the try/catch above only ever fires for a genuinely
    // thrown error; a mid-run model error would otherwise fall through as a
    // false 'no-review' with the real failure silently dropped, defeating the
    // whole point of this task. Checked only when send() itself didn't already
    // report an error, so a genuine throw keeps its own message.
    if (!error) {
      // WHY: scan only the events THIS send() produced (events.slice, not the
      // full array) — see eventsBeforeSend's WHY comment above.
      const sessionError = events
        .slice(eventsBeforeSend)
        .find((e) => e.type === 'session-error');
      // Defensive fallback: `data.text` is typed as possibly undefined. If a
      // 'session-error' event is ever emitted without text, fall back to a
      // factual placeholder rather than silently losing the error (which would
      // mislabel the run 'complete' or 'no-review' despite a real failure).
      // The fallback states only that a message was missing — it does not
      // guess at why the error occurred.
      if (sessionError) error = sessionError.data.text ?? 'session error (no message provided)';
    }

    // A denied budget gate ends the turn with stopReason 'max_steps'
    // (harness-session.ts:1102). WHY read the stopReason rather than set a flag
    // in askUser: at the callback a denied gate and a turn that was about to
    // finish anyway are indistinguishable — the stopReason is the only place
    // the difference is recorded. `!wrapUpReason` guards against overwriting a
    // 'timeout' the deadline callback above already set; `!error` skips this
    // when the turn threw instead of finishing (an error takes priority — see
    // the outcome expression below).
    if (!wrapUpReason && !error && stopReasons.at(-1) === 'max_steps') wrapUpReason = 'budget';

    // Fourth trigger: the turn ENDED ON ITS OWN and left no review.
    //
    // The other three all watch for a run being CUT SHORT. None of them fires
    // for a model that simply stopped — and that is a real, observed outcome,
    // not a hypothetical: on 2026-08-11 Qwen 3.6 27B made six tool calls, ended
    // on 'end_turn' with empty final text, repeated nothing, and blew no
    // budget. No trigger fired, so nothing ever asked it for a review, and a
    // paid run produced none. It was the only model in the roster that was
    // perfectly willing to answer and was never asked.
    //
    // WHY this needs no interrupt, unlike the other three: the turn is already
    // over. This runs after send() resolved, so it just decides to send once
    // more.
    //
    // WHY it asks with the SAME anchored test the final extraction uses, rather
    // than "did the model emit any text at all": mid-run narration is not a
    // review. A model that says "Now let me check the config…" between two tool
    // calls and then stops has produced text but no deliverable, and the loose
    // test would see that text and decline to ask — missing exactly the case
    // this trigger exists for. Anchoring both to the last tool result keeps one
    // definition of "has a review" on both sides of the decision.
    if (!wrapUpReason && !error) {
      const endedWithoutReview = !pickReview(
        events,
        0,
        events.reduce((last, e, i) => (e.type === 'tool-result' ? i : last), -1),
      );
      if (endedWithoutReview) wrapUpReason = 'stopped-early';
    }

    // Everything the testing turn emitted. The wrap-up review is sliced from
    // here onward so trailing narration from the interrupted turn cannot leak
    // into it (see lastToolResultIndex's WHY comment below).
    let sliceFrom = 0;

    if (wrapUpReason) {
      wrappingUp = true;
      sliceFrom = events.length;
      // Own marker + own deadline, same reasoning as the testing turn's above:
      // this is a SECOND send() on the same session, appending to the same
      // `events` array, so its error scan must stay scoped to just this turn.
      const wrapEventsBeforeSend = events.length;
      const wrapDeadline = setTimeout(() => session.interrupt(), WRAP_UP_TIMEOUT_MS);
      wrapDeadline.unref();
      try {
        await session.send(wrapUpPrompt);
      } catch (err) {
        // A failed wrap-up is not fatal: the testing transcript is still worth
        // writing, and outcome stays 'wrapped-up' with an empty review.
        error ??= err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(wrapDeadline);
      }
      // Same non-rejecting-send() gap as the testing turn: a wrap-up-turn
      // model error surfaces as a 'session-error' event, not a thrown
      // exception. Scoped to wrapEventsBeforeSend, not eventsBeforeSend, so a
      // testing-turn error that already resolved above is never re-attributed
      // to a wrap-up turn that actually succeeded.
      if (!error) {
        const wrapSessionError = events
          .slice(wrapEventsBeforeSend)
          .find((e) => e.type === 'session-error');
        if (wrapSessionError) error = wrapSessionError.data.text ?? 'session error (no message provided)';
      }
    }

    // Defect 1 fix: `assistant-text` events are streaming DELTAS emitted
    // throughout the WHOLE run, not one-per-message — the old comment here
    // ("the model's final assistant text") was simply false about what the code
    // below it did. It joined EVERY assistant-text event, so a live run's
    // turn-by-turn narration ("I'll start by getting oriented...", "Now let me
    // try...") got glued onto the front of the actual review with no separator
    // (confirmed on the Kimi K3 run: 2,501 assistant-text events, 36% of the
    // joined text was pre-review commentary).
    //
    // The model's real final message is whatever assistant-text it emits AFTER
    // its last tool call finishes — verified against that same transcript:
    // taking only the text after the last tool-result event yields exactly the
    // review's true start ("I ran the full battery...") through its true end,
    // nothing more. `data.text` is already typed `string | undefined`
    // (shared/types.ts) — the brief's `(e.data as any)?.text` cast was
    // unnecessary.
    //
    // Edge case: a model that answers without ever calling a tool has no
    // tool-result to anchor on. `lastToolResultIndex` is then -1, and `i > -1`
    // is true for every index, so the filter falls back to "every assistant-text
    // event" — which in a no-tool-call run IS the whole (and only) message.
    //
    // Only the wrap-up turn's events when one ran (wrapUpReason is set); the
    // whole run otherwise. `wrapUpReason`, not `sliceFrom > 0`, is the actual
    // signal — the old check only worked because send() happens to emit a
    // 'user-message' event synchronously, guaranteeing events.length >= 1
    // before a wrap-up ever starts. That is an unstated invariant of send(),
    // not something this function should have to lean on to know its own
    // state (Fix pass 2, Finding 6).
    const isWrapUpWindow = wrapUpReason !== undefined;
    const reviewWindow = events.slice(sliceFrom);
    // Fix pass 1, Finding 1 / Fix pass 2, Finding 1: the "after the last tool
    // result" anchor exists to strip narration BETWEEN REAL tool calls — but
    // inside the wrap-up window no tool call is ever real (decide() denies
    // every one above), so a model that writes its review and then attempts
    // one more (denied) tool call pushes a tool-result to a later index than
    // the review text, and an unconditional anchor would discard it. That is
    // exactly the tool-happy failure population wrap-up exists to rescue (127
    // and 157 calls in the round-5 incident).
    //
    // But a wrap-up turn is often multi-step: the model narrates, attempts a
    // tool, gets denied (a tool-result is still emitted), THEN writes the
    // review. Dropping the anchor entirely for the whole wrap-up window (the
    // pass-1 fix) glued that narration onto the front of the review with no
    // separator — the exact defect the anchor was built to fix in the first
    // place, for precisely the tool-happy models wrap-up exists to rescue.
    //
    // So: try the anchored pick FIRST — correct for a single-turn run (what it
    // was built for) AND for a wrap-up turn that narrates-then-answers (the
    // anchor lands right before the real review). Fall back to the whole
    // window ONLY when the anchored pick comes back empty, which happens ONLY
    // in the wrap-up window's "answered, then tried one more tool" shape —
    // never for a single-turn run, where an empty anchored pick means the
    // model produced no text at all and joining the (also-empty) whole window
    // changes nothing.
    const lastToolResultIndex = reviewWindow.reduce(
      (last, e, i) => (e.type === 'tool-result' ? i : last),
      -1,
    );
    const review = pickReview(events, sliceFrom, lastToolResultIndex)
      || (isWrapUpWindow ? pickReview(events, sliceFrom, -1) : '');

    // wrapUpReason takes priority: a wrap-up turn that itself errors still
    // reports 'wrapped-up' (with an empty review, per the brief's WHY comment
    // above the wrap-up try/catch) — the run was cut short and asked for its
    // review, which is the fact a caller most needs to see, over the
    // secondary fact that the wrap-up attempt also failed. Otherwise an error
    // takes priority over a review the model may have partially produced
    // before failing.
    const outcome: CaseOutcome =
      wrapUpReason ? 'wrapped-up'
      : error ? 'error'
      : review ? 'complete'
      : 'no-review';

    return {
      label: opts.label, modelId: opts.modelId, review, events,
      toolCalls, asks, stepGates, fixtureRoot,
      outcome, wrapUpReason, error,
      metrics: {
        wallClockMs: Date.now() - startedAt,
        toolCalls, asks, stepGates, thinkingEvents, inputTokens, outputTokens,
        // Absent unless EVERY turn reported a figure — see CaseMetrics.
        ...(turnsCompleted > 0 && turnsWithProviderCost === turnsCompleted
          ? { providerCostUsd }
          : {}),
        stopReasons,
        toolsUsed: [...toolsUsed].sort(),
        // Only calls at or above REPEAT_REPORT_FLOOR — a run with zero
        // restart-shaped repeats reports [], not every key ever seen once.
        repeats: [...repeatCounts.entries()]
          .filter(([, count]) => count >= REPEAT_REPORT_FLOOR)
          .map(([key, count]) => ({ key, count }))
          .sort((a, b) => b.count - a.count),
      },
    };
  } finally {
    // Guaranteed teardown (Finding 3). Runs after the wrap-up turn (if any) has
    // already completed above — destroying the session or removing the fixture
    // any earlier would make the wrap-up turn's own send() fail outright (no
    // session left to send on, no cwd left for its tools).
    session.destroy();
    if (!opts.keepFixture) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
