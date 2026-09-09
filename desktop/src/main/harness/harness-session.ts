// HarnessSession — the native runtime's multi-step agentic turn driver
// (spec §2.3/§2.4). Phase 2 (Task 9) replaced v0's single streamText call with a
// step LOOP: each step is one streamText consumption; tool-calls are validated,
// permission-gated, and executed serially; results feed the next step until the
// model stops (no tool calls) or a budget/interrupt ends the turn.
//
// The v0 outer shell survives verbatim: the re-entrancy guard, the abort-race
// stream iterator (providers can ignore abort signals — racing guarantees
// interrupt() always ends the turn), the delta partId semantics, and the
// catch → user-interrupt vs session-error split. The transcript-event emit
// surface is FROZEN — this driver emits ONLY the pre-existing TranscriptEventType
// values; max_steps and doom_loop surface as PERMISSION ASKS (askUser), never as
// new event types.
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { streamText, tool, zodSchema, jsonSchema, type LanguageModel, type ModelMessage } from 'ai';
import type { TranscriptEvent, InjectedMeta } from '../../shared/types';
import type { ModelBinding } from '../../shared/provider-types';
import type { HarnessManifest } from '../../shared/harness-manifest';
import type { PermissionDecision, PermissionRule } from '../../shared/permission-types';
import { bashGrantOptions, type GrantScope } from '../../shared/bash-grant-shapes';
import type { NativeTool, ServedRead, ToolContext, ToolResultPayload, ToolServices } from './tools/types';
import { checkPathGuard, workspaceMatchFor } from './tools/guards';
import { readImageFromDisk, MAX_IMAGES_PER_TURN, MAX_IMAGE_BYTES_PER_TURN, deliverableImageMediaType, MAX_ATTACHMENT_BYTES } from './image-support';

// Tools whose permission SUBJECT is not a filesystem path. Bash's is a command
// string; Skill's is a skill id. Both would be canonicalized against cwd and run
// through the credential denylist by checkPathGuard, and matched against rule
// globs by injectPathTriggers — neither is meaningful for a non-path.
//
// This used to be spelled inline as `toolName !== 'Bash'`, which silently gave
// Skill the wrong treatment the moment it was added (found in the 2026-07-28
// branch review). Naming the set means the next non-path-subject tool has one
// place to declare itself instead of inheriting file-tool behavior by default.
//
// Fix 4 (review round 1): Task's subject is a CHARTER-SCOPED CONSENT KEY
// (`${charter}:${work_dir}`, tools/task.ts's permissionSubject), not a bare
// path — the charter prefix exists precisely so a remembered "Always allow"
// for a read-only specialist can't silently cover a future read-write one at
// the same path (spec §5: the charter is the unit of envelope consent).
// Running that string through checkPathGuard/injectPathTriggers would try to
// canonicalize "read-only:/home/x/proj" AS a path, which is a category error
// exactly like Bash's command string or Skill's id above — workDir containment
// itself is already enforced inside NativeSessionHost.createChild.
const NON_PATH_SUBJECT_TOOLS = new Set(['Bash', 'Skill', 'Task',
  // WebSearch's subject is a search QUERY and WebFetch's is a URL. Neither is a
  // path, so canonicalizing them against the cwd is the same category error as
  // Bash's command string above — and it had a real bite: a URL is resolved to
  // `<cwd>/https:/host/path`, so fetching a page whose last segment looks like a
  // credential file (`/.env.example`, `/id_rsa.pub`) tripped the SECRET hard-deny
  // and the fetch was refused as "it looks like a credential or secret file".
  // Nothing about a web request is gated by the filesystem jail. (2026-08-18 spec.)
  'WebSearch', 'WebFetch']);

/** Tools that only LOOK at the filesystem. An outside-the-workspace path no
 *  longer forces an approval card for these — in ANY permission mode, Ask First
 *  included (Destin, 2026-09-05: "permissions boundaries should only really be
 *  for actions that change things").
 *
 *  WHY this is not a hole. Three reasons, in order of weight:
 *   1. Bash is exempt from this guard entirely (NON_PATH_SUBJECT_TOOLS above),
 *      so the model could already `cat` any of these bytes with no card. The
 *      prompt was charging the polite tools a toll the terminal walks past.
 *   2. Credential and secret paths are hard-DENIED inside checkPathGuard, above
 *      this point, and that deny is unchanged and still cannot be overridden.
 *   3. Reading changes nothing. Write and Edit are deliberately absent from this
 *      set and still raise the outside-the-workspace card exactly as before.
 *
 *  Every other harness draws the line in the same place: Codex and Hermes fence
 *  writes and leave reads open, Pi gates neither. */
const READ_ONLY_PATH_TOOLS = new Set(['Read', 'Grep', 'Glob']);
/** G-1: a poll is SUPPOSED to repeat, so BashOutput is exempt from the
 *  doom-loop signature window (spec §4.2); BASH_OUTPUT_READS_PER_TURN is the
 *  guard instead. */
const DOOM_LOOP_EXEMPT_TOOLS = new Set(['BashOutput']);
/** D7: flat cap on BashOutput calls per turn, regardless of result — a chatty
 *  build returns new output on every poll, which no empty-result counter catches. */
export const BASH_OUTPUT_READS_PER_TURN = 8;

// Tools whose target MUST already exist for the call to mean anything. Only
// these can have an external_directory ask short-circuited by
// workspaceMatchFor (2026-08-16): for them "nothing is there" is definitively
// a mistake, so recovering the workspace file the model meant is strictly
// better than an approval prompt about a fictional location.
//
// Write is deliberately ABSENT. "Doesn't exist yet" is its NORMAL case —
// creating a new file outside the workspace is a real request a user may well
// want to approve, and diverting it would refuse an action nobody rejected.
// Glob/Grep are absent too: their subject is a DIRECTORY to search, and this
// helper answers a file-shaped question.
const REQUIRES_EXISTING_TARGET = new Set(['Read', 'Edit']);

/** The disk question REQUIRES_EXISTING_TARGET tools are asking. Never throws —
 *  a permission error reading someone else's directory answers "not a file I
 *  can offer you", which is exactly the right answer here. */
function isExistingFile(absPath: string): boolean {
  try { return fs.statSync(absPath).isFile(); } catch { return false; }
}

/** The rule an "Always allow" persists.
 *
 *  The RENDERER never supplies a pattern — only a width selector — and this
 *  re-derives from the tool call the session already holds. A renderer that could
 *  name its own pattern could grant itself anything, because remembered rules are
 *  the final precedence layer, above the destructive deny-list.
 *
 *  Returns null when nothing may be remembered for this call.
 *
 *  Exported (Fix, Important 6, final review): this is the ONE function that
 *  decides both the confirm-sentence width (indirectly, via the caller
 *  reading `scope`) and the stored rule's pattern/match shape — a routed
 *  specialist ask (child-ask-router.ts) and a LATE routed answer
 *  (native-session-host.ts's onLateResponse) used to hand-build their own
 *  `{tool, pattern: subject, action:'allow', specialist}` object instead of
 *  calling this, which silently dropped every "never rememberable" case this
 *  function enforces (e.g. a bare `git push`, whose bashGrantOptions is empty
 *  — see below) and discarded the grant WIDTH the user actually picked,
 *  always storing an exact-match rule regardless of `grantScope`. Both call
 *  sites now go through here, merging in `specialist` themselves (this
 *  function has no concept of a specialist key — it's the same builder a
 *  root session's own ask uses). */
export function rememberedRuleFor(
  toolName: string,
  subject: string | undefined,
  scope: GrantScope | undefined,
): PermissionRule | null {
  if (toolName === 'Bash' && typeof subject === 'string') {
    // The subject is passed through untouched — bashGrantOptions does not trim,
    // so the exact rung is byte-identical to what the engine compares later.
    const options = bashGrantOptions(subject);
    // Empty means no grant of any width may be offered (a bare `git push`, whose
    // target is not in the command and changes underneath the grant). Fail closed.
    if (options.length === 0) return null;
    // Fall back to the NARROWEST option when the requested width was not offered
    // for this command — never widen past what bashGrantOptions produced.
    return (options.find((o) => o.scope === (scope ?? 'exact')) ?? options[0]).rule;
  }
  // Fix (Critical 1, final review): Task's subject is undefined ONLY for a
  // task_id management call (steer/resume/interrupt), which never carries a
  // charter/work_dir — every OTHER Task call has a real `${charter}:${workDir}`
  // subject (tools/task.ts's permissionSubject). Falling through to the
  // tool-wide branch below (built for genuinely subject-less tools like
  // TodoWrite) would let a single "Always allow" on a task_id call persist a
  // pattern-less `{tool:'Task', action:'allow'}` rule that then silently
  // pre-approves EVERY future Task call — including a brand-new read-write
  // spawn at any directory, which the user never saw or consented to. Fail
  // closed: no rule of ANY width is ever remembered for a subject-less Task
  // call — mirrors the existing "no grant possible" precedent (Bash commands
  // with no safe width, e.g. bare `git push`, above return null the same way).
  // The ask itself still resolves 'allow' for this one call either way.
  if (toolName === 'Task' && subject === undefined) return null;
  if (subject === undefined) return { tool: toolName, action: 'allow' };
  // Non-Bash subjects are literal paths / ids. match:'exact' makes them mean what
  // the confirm always claimed — a path containing '*' was a wildcard grant.
  return { tool: toolName, pattern: subject, action: 'allow', match: 'exact' };
}
import { formatAnswers } from './tools/ask-user-question';
import { formatArgErrors } from './tools/arg-errors';
import type { AskRequest, AskDecision } from './permission-broker';
import { CLOUD_DEFAULT, type CapabilityProfile } from './capability-profile';
import { adaptForWire } from './wire-adapter';
import { planCompaction, pruneToolOutputs, summarizePrompt, estimateTokens, countImageOutputs, type CompactionConfig } from './compaction';
import { toReport, type PrefillProgress } from '../providers/prefill-progress';
import { messageTokens, messagesTokens, APPROX_CHARS_PER_TOKEN } from './message-size';
import { createSkillTool } from './tools/skill';
import { createTaskTool } from './tools/task';
import { ModelSearchTool } from './tools/model-search';
import { BUILTIN_ROSTER, type SpecialistRoster } from './specialists/registry';
import type { ShellRegistry } from './shell-registry';
import { createSkillCatalog, type SkillCatalog } from './skills/skill-catalog';
import { fitInjection } from './injection/injection-budget';
import type { TriggerIndex } from './injection/path-triggers';
import { mcpToolsFor, estimateToolSchemaTokens } from './mcp/mcp-tools';
import type { ReadyServer } from './mcp/mcp-manager';
import {
  costForUsage, providerCostFromMetadata, costDisagreement,
  COST_DISAGREEMENT_THRESHOLD, addComparableTurn, sessionCostDisagreement,
  NO_SESSION_COST_TOTALS, COST_GAP_RELOG_FACTOR,
  type ModelPricing, type SessionCostTotals,
} from './pricing';
import { log } from '../logger';

export interface HarnessSessionOpts {
  sessionId: string; cwd: string; harness: HarnessManifest; binding: ModelBinding;
  /** Model context window (from the catalog); null → conservative 32k default. */
  contextLength?: number | null;
  /** Resolved price for the bound model, or null when none is published.
   *  Re-resolved on setBinding, so a mid-session model swap prices only the
   *  turns that run AFTER it — a turn is never repriced retroactively. */
  pricing?: ModelPricing | null;
  /** The bound model costs nothing to run (local engine, or a published rate
   *  card of all zeroes). Resolved by the host alongside `pricing`, because
   *  only the host knows the provider type. */
  free?: boolean;
  // --- Plan A (Task 9) additions — all injected by NativeSessionHost: ---
  /** The tool set this session may call. Absent/[] = v0 chat behavior (the
   *  Chat-preset path: plain text, no tool plumbing invoked). */
  tools?: NativeTool[];
  /** Pure permission decision for (tool, subject) — the configured layers
   *  (preset/mode/deny-list/remembered). Absent → every gated tool asks. */
  decide?: (tool: string, subject: string | undefined) => Promise<PermissionDecision>;
  /** Raise an interactive permission ask (broker.ask bound to this session).
   *  Also the surface for the max_steps / doom_loop budget asks. */
  askUser?: (req: AskRequest) => Promise<AskDecision>;
  /** System prompt assembled ONCE at init (Task 11); falls back to the
   *  harness's own systemPrompt for the Chat preset. */
  systemPrompt?: string;
  /** Runtime services threaded into every tool's ToolContext (spec §3.2).
   *  Injected by NativeSessionHost (e.g. { search } → WebSearch). */
  toolServices?: ToolServices;
  /** Test hook: step-level retry backoff (ms). Defaults to [1000, 2000, 4000]. */
  retryDelays?: number[];
  /** Test hook: streaming inactivity watchdog timings (ms). Silence past
   *  `stallWarningMs` warns the user; a further `stallCountdownMs` of silence
   *  triggers the auto-retry / session-error. Default 60_000 / 15_000. */
  stallWarningMs?: number;
  stallCountdownMs?: number;
  /** Test hook: the TIME-TO-FIRST-TOKEN budget, which is separate from (and much
   *  larger than) `stallWarningMs` because prefill on a local model legitimately
   *  runs to minutes. Defaults to prefillBudgetMs(promptTokens). */
  prefillWarningMs?: number;
  /** Resolved capability profile (Task 5): steers the doom-loop window and
   *  whether tools are attached at all. Absent → CLOUD_DEFAULT (full posture). */
  profile?: CapabilityProfile;
  /** Installed-skill source for the Skill tool (M3 item 1). Injected so tests can
   *  supply a fake instead of scanning the real ~/.claude — and so a machine with
   *  no skills is an expressible state rather than an environment accident.
   *  Absent → the real filesystem catalog. */
  skillCatalog?: SkillCatalog;
  /** Project rules + nested project instructions, indexed by path (M3 item 3).
   *  Absent → no path-triggered injection, which is exactly the pre-M3 behavior
   *  every existing caller and test relies on. */
  triggers?: TriggerIndex;
  /** The MCP servers this session may use (Task 6), acquired by
   *  NativeSessionHost from the process-level McpManager at create/resume.
   *  Absent/[] → no MCP tools attached, exactly the pre-Task-6 behavior. */
  mcpServers?: ReadyServer[];
  /** Set ONLY by NativeSessionHost.createChild (Task 6) — true for a
   *  specialist child session. Belt-and-suspenders against depth-2
   *  delegation: createChild already never puts 'Task' in a child's filtered
   *  tool set (no SpecialistDefinition.allowedTools lists it), so this is a
   *  SECOND, independent gate on syncTaskTool, not the only one — a bug in
   *  either check alone still cannot let a specialist spawn its own
   *  specialists. Absent/false for every ordinary (non-child) session. */
  isSpecialistChild?: boolean;
  /** Task 10 (plan 1b): directories checkPathGuard treats as internal to THIS
   *  session — readable without an external_directory ask, the same way
   *  Bash's own spillRoot() is (tools/guards.ts). Wired by NativeSessionHost
   *  (toolWiring) to exactly one root: this project's own
   *  sessions/<slug>/specialist-reports/ subdirectory (Important 5, final
   *  review — narrowed from the whole sessions/<slug>/ artifact directory,
   *  which also holds every OTHER conversation's transcript .jsonl and the
   *  delegation ledger sidecars; a model exempted from the ask for its own
   *  spill file must not get free read access to those too), where an
   *  oversized specialist report's spill file (NativeHome.writeSessionArtifact) lands —
   *  so the footer that tells the model "Read it if you need the rest"
   *  points at a path the guard will actually let it open. Absent → no
   *  exemption, which is the pre-Task-10 behavior every existing session (and
   *  every specialist CHILD, which never gets this wired) still gets. */
  internalReadRoots?: string[];
  /** Task 4 (plan 1c) — this project folder's per-cwd specialist roster
   *  (SpecialistCatalog.roster(cwd)), wired by NativeSessionHost.toolWiring
   *  for a ROOT session only. syncTaskTool rebuilds the Task tool from THIS
   *  roster at the start of every turn — never once at construction — so a
   *  file dropped into a specialists folder shows up without a session
   *  restart. Absent → BUILTIN_ROSTER (createTaskTool's own default), which
   *  is exactly the pre-Task-4 behavior every existing test relies on. A
   *  specialist CHILD never gets this wired (its own syncTaskTool call is a
   *  no-op — isSpecialistChild withholds Task entirely), so its own roster
   *  identity never matters. */
  specialistRoster?: SpecialistRoster;
  /** G-1 background Bash: the HOST-owned registry for this session's
   *  background/handed-off commands (NativeSessionHost.shellsFor). Reaches the
   *  tools as ctx.shells; absent in tests, where Bash refuses a background
   *  start and a time limit still kills. */
  shells?: ShellRegistry;
}
// The opts second arg carries per-turn model construction hints. `serialToolCalls`
// (Task 10 / spec §4.2) tells the local-engine factory to inject
// parallel_tool_calls:false; cloud factories ignore it. `cacheKey` is this
// session's id: the ChatGPT-plan factory sends it as the endpoint's
// prompt_cache_key so every step of one session shares a cached prefix
// (chatgpt backend design §4.2); every other factory ignores it.
export type ModelFactory = (
  binding: ModelBinding,
  opts?: { serialToolCalls?: boolean; onPrefillProgress?: (p: PrefillProgress) => void; cacheKey?: string },
) => Promise<LanguageModel>;

// One collected tool-call from a step's stream (input already PARSED to an
// object by streamText — see the ai@7 contract test).
interface ToolCall { toolCallId: string; toolName: string; input: any }
// Normalized per-step usage (v7's nested cache details flattened into our fixed
// transcript usage shape).
interface StepUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
// What one consumed step returns to the loop.
interface StepResult {
  text: string; toolCalls: ToolCall[]; usage: StepUsage;
  finishReason: string | undefined; interrupted: boolean;
  /** What the PROVIDER itself says this one request cost, in USD — OpenRouter
   *  reports it on every response (pricing.ts's openRouterCostExtractor).
   *  `undefined` means the provider reported nothing, which is every other
   *  provider and must never be read as $0. Deliberately NOT on StepUsage:
   *  that is the fixed transcript token shape, and this is a dollar figure
   *  from a different source. */
  providerCostUsd?: number;
  /** Milliseconds from this step's FIRST real output chunk to the end of its
   *  stream — i.e. time actually spent generating. Excludes prefill (before the
   *  first chunk) and everything outside the stream (tool execution, permission
   *  waits). 0 when the step produced no output. */
  generationMs: number;
  /** Preparing cards this step put on screen whose tool call never COMPLETED
   *  (tool-input-start with no matching 'tool-call' part — announced, then
   *  dropped as malformed/truncated). Carried out of the stream so the
   *  empty-step retry in the turn loop can withdraw them: the step re-runs
   *  INSIDE the same turn, so endTurn's reaping never fires and an orphaned
   *  card would spin beside the retry's own cards until the turn ends (the
   *  same reason the manual-Retry and stall-retry paths withdraw theirs). */
  pendingPreparing: { toolCallId: string; toolName: string; chars: number }[];
}

// v7 stream parts carry the chunk in .text (verified against ai@7.0.22:
// TextStreamTextDeltaPart / TextStreamReasoningDeltaPart both expose `.text`).
// Read through ONE accessor so any future field rename stays here. The
// `?? part.delta` fallback is for the RAW LanguageModelV4 stream-part shape
// (which uses `.delta`) — the transformed fullStream we iterate here only ever
// carries `.text`, so `.delta` never actually fires; it's belt-and-suspenders.
function deltaText(part: any): string { return part.text ?? part.delta ?? ''; }

// AI SDK finishReason -> CC transcript stopReason names (the bubble footer
// gate filters 'end_turn' as the normal case).
function mapStopReason(finishReason: string | undefined): string {
  switch (finishReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'content-filter': return 'refusal';
    default: return finishReason ?? 'unknown';
  }
}

// The finishReason shapes that mean "the provider claims an orderly finish" —
// the only shapes eligible for the empty-step retry (spec 2026-08-21). Kept
// HERE, next to mapStopReason, so the two finishReason vocabularies stay one
// list: a reason added to the switch above must be classified here too, or
// empty steps with that reason silently lose the retry.
// 'tool-calls' is deliberately included: with ZERO parsed calls it means the
// stream announced tool use but every call was dropped as malformed/truncated
// (fragments are discarded at the tool-input part handlers) — nothing ran,
// nothing rendered, so it is the same degenerate shape as a bare 'stop' and a
// retry is exactly right. 'length' (truncation) and 'content-filter' (refusal)
// stay excluded so their honest mappings are never masked by a retry.
const ORDERLY_EMPTY_FINISHES = new Set(['stop', 'unknown', 'other', 'tool-calls']);

/** Widening advice per tool, in that tool's OWN vocabulary.
 *
 *  WHY (2026-08-06, Task 18): this path appended "Re-run with offset/limit, or
 *  use Grep" to EVERY oversized tool result, including Bash and WebSearch,
 *  which accept neither parameter. It is the same defect the bounds contract
 *  removed from the defineTool path (tools/registry.ts) — and it fires
 *  precisely when output is largest, so it was the most likely advice a model
 *  would ever act on. Two models testing the harness followed it into a dead
 *  end. Tools absent from this map get a bare statement with no advice, which
 *  is the honest fallback per docs/error-message-standards.md — never a guess. */
const FIT_MORE_HINT: Record<string, string> = {
  Read: 'Re-run with a narrower offset/limit window',
  Bash: 'Re-run piping through head, tail, or wc -l',
  Grep: 'Re-run with a narrower pattern or output_mode: "count"',
  Glob: 'Re-run with a narrower glob pattern',
  WebSearch: 'Re-run with a narrower query',
  WebFetch: 'Fetch a more specific URL or section',
};

// Shrink a role:'tool' message's result text to fit `maxChars`, splitting the
// allowance evenly when one message carries several results. Used only by
// fitToContext's oversized-tail salvage — the ordinary path never rewrites
// content. The trailing notice matters: without it a model reads a hard-cut
// file as complete and confidently answers from a fragment. Exported so Task
// 18's tests can drive it directly without recreating a whole oversized
// history through fitToContext.
export function truncateToolMessage(msg: ModelMessage, maxChars: number): ModelMessage {
  if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;
  const parts = msg.content as any[];
  const results = parts.filter((p) => p?.type === 'tool-result');
  if (results.length === 0) return msg;
  const per = Math.max(500, Math.floor(maxChars / results.length));
  return {
    ...msg,
    content: parts.map((p: any) => {
      if (p?.type !== 'tool-result') return p;
      // Sibling of pruneToolOutputs' content branch (compaction.ts) — this is
      // the LAST-RESORT salvage path (fitToContext's oversized-tail fallback,
      // the step immediately before a provider 400), and until this branch
      // existed it was the one sizing path that could not reclaim anything
      // from an image: the `typeof value !== 'string'` check below let a
      // content-output tool result pass through completely untouched. Collapse
      // it the same way prune does — text kept, file part dropped, a named
      // note in its place — including the same guard (only claim an image was
      // dropped when a file part is actually present), so the two paths can't
      // silently drift on what counts as "an image output".
      if (p.output?.type === 'content' && Array.isArray(p.output.value)) {
        const text = p.output.value.filter((v: any) => v?.type === 'text').map((v: any) => v.text).join('\n');
        const hasFile = p.output.value.some((v: any) => v?.type === 'file');
        if (!hasFile) return { ...p, output: { type: 'text', value: text } };
        const note = `[image dropped — this result alone exceeds the model's context window; re-run ${p.toolName ?? 'the tool'} if you need to see it again]`;
        return { ...p, output: { type: 'text', value: text ? `${text}\n${note}` : note } };
      }
      const value = p.output?.value;
      if (typeof value !== 'string' || value.length <= per) return p;
      const dropped = value.length - per;
      // Derived from the RESULT'S OWN toolName, not a shared default — see
      // FIT_MORE_HINT above. Nothing is appended when the tool isn't in the map.
      const hint = FIT_MORE_HINT[p.toolName];
      return {
        ...p,
        output: {
          ...p.output,
          value: value.slice(0, per) +
            `\n\n[truncated — ${dropped.toLocaleString()} more characters were dropped because this result alone exceeds the model's context window.${hint ? ` ${hint}.` : ''}]`,
        },
      };
    }),
  } as ModelMessage;
}

// Turn a caught provider/SDK error into the most ACTIONABLE message we can show
// (docs/error-message-standards.md — surface the real detail, never a generic
// wrapper). The AI SDK wraps a provider HTTP failure as AI_APICallError (with
// `.statusCode` + a `.responseBody` JSON string) and its retry layer as
// AI_RetryError (with `.lastError`). The bare `.message` is useless
// ("Provider returned error" / "Failed after 3 attempts") — the real, usually
// user-fixable detail lives in the body. OpenRouter, for example, nests the
// upstream reason at `error.metadata.raw` (e.g. "<model> is temporarily
// rate-limited upstream. Please retry shortly, or add your own key…").
// A "message" that is blank, or is the literal text '[object Object]', carries
// zero information — the second case is what a naive `String(nonError)` or
// `${nonError}` template interpolation produces (confirmed: runStreamOnce used
// to do exactly that before the 2026-08-10 fix, and produced this literal
// string as a real session-error's ENTIRE text). Treat both as "no message"
// rather than parroting either back — error-message-standards.md requires
// every user-facing error to be specific+accurate OR general+non-committal;
// '[object Object]' is neither.
function isUsableMessage(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length > 0 && s.trim() !== '[object Object]';
}

export function describeProviderError(err: any): string {
  // A thrown value isn't always an object at all — `throw 'rate limited'` is
  // legal JS and describeProviderError must not turn that into the generic
  // fallback when the string itself is the real, useful detail.
  if (typeof err === 'string') {
    return isUsableMessage(err) ? err.trim() : 'The model request failed.';
  }
  const api = err?.lastError ?? err;            // unwrap the retry wrapper
  const status = api?.statusCode ?? api?.status;
  let detail: string | undefined;
  // responseBody is usually a JSON string; some providers pre-parse into `.data`.
  const parsedBody = (() => {
    if (api?.data && typeof api.data === 'object') return api.data;
    if (typeof api?.responseBody === 'string') {
      try { return JSON.parse(api.responseBody); } catch { /* non-JSON body */ }
    }
    return undefined;
  })();
  const errObj = parsedBody?.error ?? parsedBody;
  detail = errObj?.metadata?.raw ?? errObj?.message ?? parsedBody?.message;
  if (isUsableMessage(detail)) {
    return status ? `${detail.trim()} (provider error ${status})` : detail.trim();
  }
  // No structured detail (network error, etc.) — the SDK message beats nothing,
  // as long as it's not itself the poisoned '[object Object]' literal.
  const sdkMessage = api?.message ?? err?.message;
  return isUsableMessage(sdkMessage) ? sdkMessage.trim() : 'The model request failed.';
}
// Back-filled into a tool-result when a turn is interrupted mid-step (during a
// permission ask). Every collected tool-call MUST get a matching tool-result or
// the persisted history ends on a dangling tool_call that provider APIs reject.
const CANCELED_TOOL_TEXT = 'Canceled: the user interrupted this action.';

// Returned to the model when the user closes an AskUserQuestion card without
// answering. The OLD copy ("Continue with your best judgment") invited the model
// to guess and keep working — which is the behavior this replaces. This states
// the outcome instead: the user has taken the turn back. It is a real tool
// result (pairing holds); the driver stops the loop right after recording it.
// Spec: youcoded-dev/docs/archive/specs/2026-08-13-dismiss-ends-turn-design.md
const DISMISSED_TOOL_TEXT =
  'The user closed this question without answering and took over. Stop here and wait for their next message.';

// Returned when an interactive ask is refused by a POLICY rather than a person
// (childAskPolicy, the harness evaluator's fixture jail). Unlike a human
// dismissal this does NOT end the turn — the policy's meaning is "you may not
// ask, carry on and finish", and the evaluator's wrap-up turn depends on the
// model answering after exactly this refusal.
const REFUSED_ASK_TEXT =
  'The user dismissed the question without answering. Continue with your best judgment, or ask differently in plain text.';

// Back-filled into the still-un-executed calls of a step that ended because the
// user dismissed a question. Deliberately NOT CANCELED_TOOL_TEXT: that says "the
// user interrupted this action", and the user did not interrupt — a wrong cause
// in a message the model reads is worse than a vague one.
const NOT_RUN_TOOL_TEXT = 'Not run: the turn ended when the user closed the question.';

// stopReason for that orderly stop. AssistantTurnBubble maps it to the
// "Question closed — waiting for you." footer, so a dismissed turn can't be
// mistaken for a session that silently died.
const DISMISSED_STOP_REASON = 'question_dismissed';

/** Driver-private "record this result, THEN end the turn" wrapper.
 *
 *  WHY this is not a flag on ToolResultPayload: that type is what EVERY tool
 *  returns, so an `endsTurn` field there would let any tool end a turn — a far
 *  bigger promise than this change makes. Only runOneTool's interactive branch
 *  constructs this, and ToolResultPayload has no `kind` property, so the loop
 *  can narrow on `'kind' in payload` with no ambiguity. */
type EndTurnResult = { kind: 'end-turn'; payload: ToolResultPayload };

// Streaming inactivity watchdog (native runtime). The abort-race below only
// breaks the stream on a USER interrupt — a provider that holds the socket open
// but stops emitting (OpenRouter keep-alive pings while an upstream stalls, or a
// half-open connection after a network/suspend blip) sends no chunk, no finish,
// and no error, so the turn would hang forever with the "Thinking" spinner up
// and ESC the only escape. The watchdog bounds that silence: warn the user after
// STALL_WARNING_MS, then act after a further STALL_RETRY_COUNTDOWN_MS grace.
const STALL_WARNING_MS = 60_000;          // silence tolerated before we warn
const STALL_RETRY_COUNTDOWN_MS = 15_000;  // grace after the warning before acting
/** Min gap between argument-progress emits, PER tool call. The preparing card
 *  only has to prove the stream is alive; a per-chunk emit would spam desktop
 *  IPC, the remote WebSocket, and the Android bridge for no extra information.
 *  Same reasoning as the promptProcessing throttle (lastPrefillEmitAt). */
const TOOL_PREPARING_EMIT_MS = 300;
// consumeStep's retry sentinel. TWO producers return it, safe for different
// reasons: (1) the AUTOMATIC retry, whose guard is `!emittedAny &&
// isFirstAttempt` — nothing COUNTABLE (text, reasoning, or a completed tool
// call) has streamed on the first attempt. NOT the same as "nothing has
// streamed at all": tool-input-delta (argument fragments) deliberately never
// sets emittedAny, so a first-attempt stall after minutes of tool-argument
// text takes this branch too, even though real bytes did arrive — safe
// anyway, because nothing has EXECUTED and nothing is on screen or in
// emittedPartIds to collide with; (2) the MANUAL Retry, fired from a parked
// step where content already streamed — safe ONLY because that branch emits
// `dropPart` first, erasing the abandoned text before the re-run's deltas can
// land on the same partIds and merge with it.
const STALL_RETRY = Symbol('stall-retry');
// Thrown when silence outlasts the countdown AND a retry isn't safe (content
// already streamed, or the one allowed retry was already spent). Routes through
// send()'s catch → session-error. Message is specific + accurate (we KNOW it's a
// timeout — docs/error-message-standards.md: never guess an unverified cause).
export class StreamStallError extends Error {
  /** `phase` distinguishes the two very different silences this watchdog sees.
   *  Saying "stopped responding" while a local model is still reading a large
   *  prompt is a guessed cause — it never started, and nothing is wrong. */
  constructor(totalMs: number, phase: 'prefill' | 'streaming' = 'streaming', promptTokens = 0) {
    const secs = Math.round(totalMs / 1000);
    super(
      phase === 'prefill'
        ? `The model didn't begin responding within ${secs} seconds while reading a `
          + `${promptTokens.toLocaleString()}-token prompt. Local models process long prompts slowly; `
          + `a shorter prompt (read less of the file, or use Grep) will start faster.`
        : `The model stopped responding — no data received for ${secs} seconds. `
          + `The provider may be stalled; send your message again to retry.`,
    );
    this.name = 'StreamStallError';
  }
}

// Time-to-FIRST-token is a different animal from a mid-stream gap, and conflating
// them is what made a healthy local model look dead (Destin, 2026-07-26: a 25k-token
// ROADMAP.md prompt tripped the 75s watchdog while llama.cpp was still doing prefill).
//
// Prefill cost scales with prompt size and hardware. Rather than guess a throughput
// per backend, allow a floor plus a conservative per-token budget: PREFILL_MS_PER_TOKEN
// assumes only ~50 tokens/sec of prompt processing, far below what any real setup
// manages, so the watchdog stays a genuine liveness check without ever calling a
// working model dead. Bounded so a truly hung server still surfaces.
//
// Applied to EVERY provider, not just local: a cloud model with a small prompt lands
// at ~the old timeout anyway, and a huge cloud prompt legitimately takes longer too.
// One rule beats a provider branch that has to be kept in sync.
// Only ANNOUNCE prompt processing when the prompt is big enough that the wait
// could plausibly look like a hang. Emitting a "reading your prompt" heartbeat
// for a 30-token turn would flicker for a few hundred milliseconds and tell the
// user nothing, while adding an event to every single step of the FROZEN emit
// surface (pinned by harness-session-loop.test.ts's ordering contract).
const PROMPT_PROCESSING_NOTICE_TOKENS = 2_000;
// Covers the silent window BEFORE prefill even starts: llama-server loads the
// model on the first request, and a 122B Q4 is tens of gigabytes off disk. The
// harness gets no signal for that (nothing in here knows about model residency),
// so the base has to be generous enough to sit through it — Destin hit the
// watchdog on a 122B while it was still loading (2026-07-26).
//
// A generous base costs little now that ANY prefill progress re-arms the clock:
// the only genuinely silent window left is the load itself, and a truly dead
// server still surfaces once this elapses with nothing at all having happened.
const PREFILL_BASE_MS = 240_000;
const PREFILL_MS_PER_TOKEN = 20;          // ≈50 tok/s of prompt processing
const PREFILL_MAX_MS = 15 * 60_000;       // a hung server must still surface

export function prefillBudgetMs(promptTokens: number): number {
  const scaled = PREFILL_BASE_MS + Math.max(0, promptTokens) * PREFILL_MS_PER_TOKEN;
  return Math.min(scaled, PREFILL_MAX_MS);
}

// CONCURRENCY PRECONDITION: `send()` is NOT re-entrant. `abort`, `interrupted`,
// and `history` are single-slot per session — a second send() before the first
// resolves would corrupt turn state. Callers MUST serialize sends per session
// (NativeSessionHost does). send() hard-throws on overlap so a wiring bug
// surfaces loudly instead of silently scrambling history.
export class HarnessSession extends EventEmitter {
  private history: ModelMessage[] = [];
  private abort: AbortController | null = null;
  private interrupted = false;
  // Task 3 — queued mid-run course corrections (postSteer), drained as
  // history-only user messages at the top of the NEXT turn-loop iteration.
  // Anything left here when a turn ends (posted during the final step, too
  // late for another iteration to drain it) is a MISSED steer — surfaced via
  // drainUnappliedSteers() so a caller (runDelegation, Task 6) can report it
  // honestly instead of silently dropping it.
  private pendingSteers: string[] = [];
  // Prompt tokens as of the PREVIOUS step of this turn. Used to report how much
  // context is genuinely NEW — llama.cpp reuses the cached prefix, so only the
  // appended messages actually get prefilled. Reset per turn; 0 means "next step
  // is a full prefill" (first step, or history rewritten by compaction, which
  // invalidates the cached prefix).
  private lastStepPromptTokens = 0;
  /** Running pair for the SESSION-wide cost self-check (Task 30). The per-turn
   *  check can never fire on a cheap model — a whole turn there costs a
   *  fraction of the comparison floor — but these sums cross it, so a
   *  systematic pricing error shows up where no single turn could show it.
   *  Only turns that had BOTH figures are folded in, so the two sums always
   *  cover exactly the same turns (see pricing.ts for why that matters).
   *
   *  Deliberately NOT reset by /clear or resume: this measures OUR pricing
   *  arithmetic against the provider's bill, which is a property of the code,
   *  not of the conversation. On resume it simply starts again from the turns
   *  this process runs — the check is continuous, not a per-session report. */
  private sessionCostTotals: SessionCostTotals = NO_SESSION_COST_TOTALS;
  /** The gap the last session line reported, or null if none has been logged.
   *
   *  NOT a one-shot flag (which is what this was until the review of 51e8b80e).
   *  Once the sums disagree they keep disagreeing, so repeating an identical
   *  warning every turn would bury the finding — but stopping after one line
   *  goes permanently DEAF on a cheap model, where the per-turn line is below
   *  the comparison floor forever and can report nothing later either. Keeping
   *  the last figure lets the next line fire only when the gap has got
   *  materially WORSE (COST_GAP_RELOG_FACTOR), which is a different fault
   *  rather than a repeat of the reported one. */
  private lastLoggedSessionCostGap: number | null = null;
  binding: ModelBinding;

  // Tool runtime state (Task 9). readRegistry + todos are per-SESSION runtime
  // state — NOT persisted transcript. seedHistory() clears both on resume.
  private toolByName: Map<string, NativeTool>;
  private readRegistry = new Map<string, number>();  // canonical path → mtimeMs at last Read
  /** G-11 (2026-08-26 tools investigation) — what Read has already served this
   *  session (`path|offset|limit` → mtime + which call). Read answers a repeat
   *  of an unchanged slice with "the content you already have is current"
   *  instead of the content. That sentence is only true while the earlier
   *  result is still in the model's view, so this is cleared at EVERY site that
   *  discards or shrinks history: seedHistory (resume), clearHistory (/clear),
   *  maybeCompact (any prune — prune slices old tool outputs to 2,000 chars, so
   *  a long Read result may no longer be whole — or summarize), and compactNow.
   *  Same KNOWN GAP as shownImages below: fitToContext trims the OUTGOING
   *  request without touching `this.history`, so on a very small context window
   *  a Read result can scroll out of view while this map still vouches for it.
   *  Compaction fires at 75% of the window, well before fitToContext has to
   *  trim, so in practice the map is cleared first; the residual exposure is
   *  the same narrow tiny-window case documented for shownImages. */
  private servedReads = new Map<string, ServedRead>();
  /** 1-based running count of tool calls dispatched — lets Read say "N calls ago". */
  private toolCallCount = 0;
  private bashOutputReadsThisTurn = 0;   // G-1 per-turn cap, reset in beginTurn
  private todos: ToolContext['todos'] = [];
  /** Scoped-persistence shell cwd (ROADMAP 2026-07-17): where the next Bash call
   *  starts. null → the session root. Session runtime like readRegistry/todos —
   *  never persisted to the transcript, so it resets on resume. */
  private shellCwd: string | null = null;
  /** Opt-in env persistence (17/17 harness reviews, four rounds 2026-08-01
   *  through 2026-08-09): vars a `persistent_env: true` Bash call captured.
   *  Mirrors shellCwd exactly — same "session runtime, resets on resume"
   *  contract, same reason (never persisted to the transcript). */
  private shellEnv: Record<string, string> | null = null;
  private retryDelays: number[];
  // Resolved capability profile (Task 5). Drives the doom-loop window + tool
  // attachment; re-assigned by setBinding on a mid-session model swap.
  private profile: CapabilityProfile;
  /** Trigger ids already injected in this session. Survives across turns on
   *  purpose — a rule is a standing instruction, not a per-turn reminder. */
  private readonly injectedTriggerIds = new Set<string>();
  /** Delivered-image dedupe: canonical path → mtimeMs at delivery. A model that
   *  re-Reads the SAME unchanged file gets "already visible" text, not a second
   *  ~1.6k-token copy; a CHANGED file (new mtime) is delivered again. Cleared on
   *  every site that DISCARDS entries from `this.history` itself — resume
   *  (seedHistory, alongside readRegistry), /clear (clearHistory), compaction's
   *  summarize step (maybeCompact/compactNow), and compaction's PRUNE step when
   *  it actually collapses an image output (same two call sites, gated on a
   *  countImageOutputs before/after diff so an ordinary text-only prune doesn't
   *  pay for it) — because every one of those DROPS entries the cache is
   *  vouching for. A stale entry after a drop doesn't just cost a redundant
   *  re-Read: it makes the dedupe note ITSELF false ("already visible earlier
   *  in this conversation" when it no longer is), permanently, until an
   *  unrelated mtime change happens to reset it. The re-Read this forces after
   *  a clear is not free — a second ~1.6k-token copy of an image that may still
   *  be sitting in surviving history — but that is the safe failure direction:
   *  over-delivery costs tokens, the bug it replaces cost correctness.
   *
   *  KNOWN GAP (2026-08-11 review, deliberately NOT fixed in this pass): the
   *  list above is every site that discards from `this.history`. It is NOT
   *  exhaustive over every way the MODEL's effective view of history can
   *  shrink — fitToContext trims oldest messages for the OUTGOING REQUEST
   *  only, leaving `this.history` itself untouched, so an image can scroll out
   *  of what the model actually sees while this cache still vouches for it: a
   *  permanently false "already visible" note plus silent permanent
   *  non-delivery of that file.
   *
   *  Reachability, worked through so a future session doesn't have to re-derive
   *  it: compaction's trigger uses REAL last-step input tokens, but that value
   *  is 0 at the first step of every turn, so planCompaction falls back to
   *  estimating the UN-TRIMMED history at that moment — meaning at each turn
   *  boundary compaction sees the true size and fires. That's the load-bearing
   *  mitigation. For large context windows the two mechanisms then agree:
   *  anything old enough for fitToContext to trim is old enough that prune
   *  already collapsed it, tripping the countImageOutputs clear above. They
   *  disagree only when the prune-protected window is bigger than
   *  fitToContext's budget, which needs a context window under roughly 8,500
   *  tokens AND supportsVision: true — which for a local engine now happens
   *  whenever the router reports a paired vision projector (design §E5). It
   *  used to require an explicit registry entry, and NO registry entry has
   *  ever declared one, so this was unreachable on a local model until the
   *  catalog started answering. The live exposure is now any downloaded local
   *  vision model with a very small context window — do not read the old
   *  "narrow" framing off this comment when triaging it.
   *
   *  Intended eventual fix (deferred, not this pass): re-key this map to
   *  Map<path, { mtime, toolCallId }> and reconcile against the FITTED window
   *  after fitToContext runs, so the cache can only vouch for what the model
   *  actually just saw. Two narrower fixes were considered and rejected
   *  because fitToContext runs on EVERY request, not just ones near budget: an
   *  unconditional clear there defeats dedupe entirely, and a count-diff there
   *  (mirroring the prune sites) latches permanently true the moment history
   *  outgrows the context window, which is ordinary steady-state for a long
   *  conversation. */
  private shownImages = new Map<string, number>();
  /** Read-only view of the resolved profile. The host needs the injection budget
   *  to size a /skill-name body, and re-resolving it there would risk drifting
   *  from what this session actually runs with (setBinding can have changed it). */
  get profileSnapshot(): Readonly<CapabilityProfile> { return this.profile; }

  // How full this session's context window is right now, in tokens — the SAME
  // number the turn-complete usage payload reports (see the emit site near the
  // end of send()), kept on the instance so a caller can read it BETWEEN turns.
  //
  // WHY this exists (Task 7, specialists): sizing a specialist's report against
  // the parent's remaining headroom needs the parent's occupancy, and main has
  // no per-session usage cache — the old one was deliberately deleted
  // (ipc-handlers.ts, near the noteModelUsed wiring) and the StatusBar's own
  // context gauge is renderer-side, computed from the event it receives.
  //
  // WHY NOT usage.inputTokens: that field SUMS every step of the turn, so it
  // re-counts the whole history once per step (a 5-step turn reports ~5x the
  // real occupancy — Destin, 2026-07-28). The last step's prompt already
  // contains everything, so lastIn + lastOut is the honest "how full".
  private _contextUsedTokens: number | null = null;
  /** Tokens occupying this session's window after its last COMPLETED step. Mid-
   *  turn it is stale by at most one step, which is fine for a budget heuristic
   *  — the alternative is a per-step event nobody else needs.
   *
   *  Fix (Task 7 review): this used to return raw `_contextUsedTokens`, which
   *  stays null forever for a usage-silent provider (local models that don't
   *  report token counts) — that made the headroom report cap silently never
   *  fire for exactly the models that need it most. The turn-complete emit
   *  site (near :1528, in send()) already falls back to estimateContextTokens()
   *  in that case; mirror it here so this accessor and that payload never
   *  disagree. Only returns null if the estimate itself were ever unavailable
   *  (it isn't today — chars/4 always produces a number). */
  get contextUsedTokens(): number | null { return this._contextUsedTokens ?? this.estimateContextTokens(); }
  /** This session's resolved context window in tokens (null when no source
   *  could answer). Paired with contextUsedTokens: "remaining" needs both, and
   *  the session is the only place that tracks the CURRENT one — setBinding
   *  re-resolves it on a mid-session model swap. */
  get contextWindowTokens(): number | null { return this.opts.contextLength ?? null; }

  // Ids of MCP servers left off the LAST buildAiTools() pass for budget reasons
  // (Task 6) — recomputed every call, so a UI reading this after buildAiTools
  // always sees the CURRENT reason, not a stale one from a prior model/binding.
  private _droppedMcpServers: string[] = [];
  /** Read-only view for the UI (a later task wires the actual surface — this
   *  task only guarantees the field exists and is accurate). Empty when every
   *  configured MCP server fit the budget. */
  get droppedMcpServers(): readonly string[] { return this._droppedMcpServers; }

  // Tool names CURRENTLY attached by syncMcpTools (not merely name-prefixed
  // "mcp__*") — tracked rather than pattern-matched so a tool that HAPPENS to
  // be named like an MCP tool but was placed in toolByName some other way
  // (e.g. harness-raw-schema.test.ts injects one directly via `extraTools` to
  // test schema passthrough in isolation, with opts.mcpServers empty) is never
  // touched by this sync. Only opts.mcpServers is this method's domain.
  // (Fix pass 1 / Finding 5: moved up here with the rest of the Task 6 MCP
  // fields — it was declared mid-class, between unrelated methods.)
  private mcpToolNames = new Set<string>();
  /** Fix pass 1 / Finding 4: the (budget, servers-array-identity) pair
   *  syncMcpTools last computed itself against — its cheap dirty-check. undefined
   *  until the first sync runs. See syncMcpTools' header for why this exists. */
  private mcpSyncedFor: { budget: number; servers: ReadyServer[] | undefined } | undefined;

  constructor(private opts: HarnessSessionOpts, private modelFactory: ModelFactory) {
    super();
    this.binding = opts.binding;
    this.toolByName = new Map((opts.tools ?? []).map((t) => [t.name, t]));
    this.retryDelays = opts.retryDelays ?? [1000, 2000, 4000];
    this.profile = opts.profile ?? CLOUD_DEFAULT;
  }

  /** Resume path: NativeSessionHost rebuilds history from stored events. */
  seedHistory(messages: ModelMessage[]): void {
    this.history = messages;
    // Reset-on-resume (spec §2.5 — Task 10 relies on this): a resumed session
    // has NO live read-before-edit state and NO todo list. Those are process/
    // session runtime, never persisted to the transcript. Clearing here prevents
    // a stale mtime (or a leftover todo list) from a prior process from wrongly
    // satisfying the read-before-edit gate on the first edit after resume.
    this.readRegistry.clear();
    this.shownImages.clear();
    this.servedReads.clear(); // G-11: the earlier Read results are not in a resumed session's view
    this.todos.length = 0;
    this.shellCwd = null; // a resumed session starts back at the workspace root
    this.shellEnv = null; // same contract — a resumed session starts with a fresh env too
  }

  /** Mid-session model swap (next turn uses the new binding). A swap can cross
   *  capability tiers (e.g. cloud → small local), so the host re-resolves the
   *  profile and passes it in; applied only when provided. */
  setBinding(binding: ModelBinding, contextLength?: number | null, profile?: CapabilityProfile,
             pricing?: ModelPricing | null, free?: boolean): void {
    this.binding = binding;
    if (contextLength !== undefined) this.opts.contextLength = contextLength;
    if (profile) this.profile = profile;
    // Same applied-only-when-provided shape as contextLength: a swap to a
    // model with no published price must be able to CLEAR a price the old
    // model had, so `null` is a real value here and only `undefined` skips.
    if (pricing !== undefined) this.opts.pricing = pricing;
    if (free !== undefined) this.opts.free = free;
  }

  /** What this session's CURRENT model costs to run, as resolved when the
   *  session was created and re-resolved by every setBinding swap above.
   *
   *  WHY expose it rather than re-resolve: NativeSessionHost reads this off a
   *  FINISHED specialist to price its run for the parent (see emitSubagentUsage
   *  below). Re-asking the catalog would be a second, independent answer that
   *  could disagree with the rate the child's own turns were actually priced
   *  at; reading the child's own card makes the two agree by construction. It
   *  also carries `free`, which a bare price lookup cannot produce — telling a
   *  local engine apart from a metered model needs the provider type, which the
   *  host resolved once, here. */
  get priceCard(): { pricing: ModelPricing | null | undefined; free: boolean } {
    return { pricing: this.opts.pricing, free: this.opts.free ?? false };
  }

  /** Report a finished specialist's TOTAL spend on THIS (parent) session's
   *  stream. Goes through emitEvent so wire()'s existing listener persists it to
   *  the parent's record and forwards it to the renderer — no second
   *  persistence path, no new IPC channel. */
  emitSubagentUsage(data: {
    usage: {
      inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number;
      costUsd: number | null; free: boolean;
    };
    model: string;
    parentAgentToolUseId: string;
    agentId: string;
  }): void {
    this.emitEvent('subagent-usage', data);
  }

  /** Effective system prompt: the assembled one (Task 11) or the harness's own. */
  private get systemText(): string { return this.opts.systemPrompt ?? this.opts.harness.systemPrompt; }

  /** Chars/4 estimate of everything the model currently holds — system prompt plus
   *  the whole history. ONLY a fallback for when the provider reports no usage;
   *  a measured prompt-token count is always preferred. */
  private estimateContextTokens(): number {
    return Math.ceil(this.systemText.length / APPROX_CHARS_PER_TOKEN)
      + messagesTokens(this.history);   // binary-aware — see message-size.ts
  }

  private emitEvent(type: TranscriptEvent['type'], data: TranscriptEvent['data']): void {
    const event: TranscriptEvent = { type, sessionId: this.opts.sessionId, uuid: randomUUID(), timestamp: Date.now(), data };
    this.emit('transcript-event', event);
  }

  /**
   * Take down the "Preparing…" cards for calls the model announced and then
   * never actually made (a malformed or truncated call). `pendingPreparing` is
   * already the orphans-only set — a call that COMPLETED keeps its preparing
   * entry, because the card transitions in place under the same id, so the
   * filter that builds this list drops those.
   *
   * ROADMAP L241: both step-level withdrawal sites route through here rather
   * than repeating the emit. They were one shape written once, and the second
   * one was simply missing — the empty-step retry withdrew its orphans while a
   * step that ALSO contained a real tool call did not, leaving a card spinning
   * next to live ones until the turn ended. A shared method is what stops the
   * next path from missing it too.
   *
   * No-op in the common case (the list is empty). Not needed where the TURN is
   * ending — endTurn reaps everything still standing.
   */
  private withdrawOrphanedPreparing(orphans: StepResult['pendingPreparing']): void {
    for (const prep of orphans) {
      this.emitEvent('assistant-thinking', {
        toolPreparing: { toolCallId: prep.toolCallId, toolName: prep.toolName, chars: prep.chars, cleared: true },
      });
    }
  }

  /** Append any project rules / nested project instructions that the paths this
   *  step touched activate (M3 item 3).
   *
   *  As a MESSAGE, never a system-prompt edit. prompt-assembly.ts is byte-stable
   *  by construction and a mid-session change would discard the KV cache prefix
   *  every local model reuses, turning a cheap follow-up turn into a full
   *  re-prefill of the entire conversation.
   *
   *  ONCE per trigger per session. A rule re-sent after every Read of a matching
   *  file would dominate the conversation and blow the window it was sized
   *  against — and repetition does not make a model follow a rule harder.
   *
   *  Bash is skipped: its permission subject is a command string, not a path,
   *  so feeding it to a path matcher would be a category error.
   */
  private injectPathTriggers(calls: ToolCall[]): void {
    const index = this.opts.triggers;
    if (!index) return;
    for (const call of calls) {
      // Same reasoning as the path guard: matching a rule glob against a bash
      // command or a skill id is a category error, not a near-miss.
      if (NON_PATH_SUBJECT_TOOLS.has(call.toolName)) continue;
      const tool = this.toolByName.get(call.toolName);
      const subject = tool?.permissionSubject(call.input as any);
      if (!subject) continue;
      for (const t of index.match(subject)) {
        if (this.injectedTriggerIds.has(t.id)) continue;
        this.injectedTriggerIds.add(t.id);
        const fitted = fitInjection(t.body, this.profile.injectionBudgetTokens);
        this.history.push({
          role: 'user',
          content: `<project-rule source="${t.source}">\n${fitted.text}\n</project-rule>`,
        });
      }
    }
  }

  /** Add or remove the Skill tool to match the CURRENT profile (M3 item 1).
   *
   *  Skill is the one conditional tool: its description lists every offered
   *  skill's id and one-liner, and that rides the schema on every turn, so a
   *  small window cannot afford it. Those sessions still reach skills through
   *  the user-invoked /skill-name path.
   *
   *  Run per buildAiTools rather than once in the constructor because
   *  setBinding() re-resolves the profile on a model swap: a tool attached under
   *  a 128k model must come back OFF when the user switches to an 8k one, and
   *  back on when they switch back. The has()/delete() pair makes both
   *  directions idempotent, so the filesystem scan happens once per attachment,
   *  not once per turn.
   */
  private syncSkillTool(): void {
    const wanted = this.profile.exposeSkillCatalog;
    if (!wanted) { this.toolByName.delete('Skill'); return; }
    if (this.toolByName.has('Skill')) return;

    const catalog = this.opts.skillCatalog ?? createSkillCatalog();
    const allow = this.opts.harness.skills;
    // Per-preset allowlist (the manifest's `skills` field, dead until now):
    // Assistant may offer fewer skills than Coder. load() stays unscoped — an
    // allowlist decides what the model is TOLD about, and a request for anything
    // outside it can't arrive because it was never advertised.
    const scoped: SkillCatalog = allow
      ? { list: () => catalog.list().filter((s) => allow.includes(s.id)), load: (id) => catalog.load(id) }
      : catalog;

    // No offerable skills → no tool. A catalog that lists nothing still reads as
    // "you may load a skill", which invites the model to invent an id and burn a
    // step discovering it doesn't exist.
    if (scoped.list().length === 0) return;
    this.toolByName.set('Skill', createSkillTool(scoped));
  }

  /** Add or remove the Task tool — and, since Task 14, ModelSearch alongside
   *  it — to match the CURRENT profile + session kind (Task 6, spec decision 4).
   *
   *  Two independent gates, BOTH required:
   *   - profile.canDelegate: a weak/unverified orchestrator serial-collapses
   *     delegated work instead of actually parallelizing it — see
   *     capability-profile.ts's own WHY comment on the field.
   *   - !opts.isSpecialistChild: belt-and-suspenders against depth-2
   *     delegation (see isSpecialistChild's own comment on HarnessSessionOpts).
   *
   *  ModelSearch rides the IDENTICAL gate and never attaches alone: it exists
   *  to name a specific model for a Task delegation, so a session that
   *  cannot delegate has nothing for it to do (Task 14).
   *
   *  Run per buildAiTools (not once in the constructor), same reason
   *  syncSkillTool is: setBinding() re-resolves the profile on a model swap,
   *  so Task must come back OFF when a session swaps down to a weak local
   *  model and back ON when it swaps back up. The has()/delete() pair keeps
   *  both directions idempotent.
   */
  private syncTaskTool(): void {
    const wanted = this.profile.canDelegate && !this.opts.isSpecialistChild;
    if (!wanted) { this.toolByName.delete('Task'); this.toolByName.delete('ModelSearch'); return; }
    // Task 4 (plan 1c): Task is rebuilt UNCONDITIONALLY every turn (no
    // has()-guard, unlike ModelSearch below) — it has to be, since the
    // in-memory specialist catalog can change between turns (a file dropped
    // into a specialists folder) and this is the one place that shows up in
    // what the model reads. An UNCHANGED roster produces an identical
    // description string, so this costs nothing extra in the prompt cache;
    // a changed one produces a new one, with no version counter anywhere
    // that could drift out of sync with reality.
    //
    // WHY this comment was rewritten: the description string IS frozen for
    // the turn (buildAiTools only runs at the start of a turn), but the
    // roster it describes is NOT. `roster.resolve()`/`roster.list()`
    // (catalog.ts) read the catalog's in-memory state at CALL time, not at
    // buildAiTools time — and that state can change mid-turn: the renderer
    // calls `specialists:list`, which calls `specialistCatalog.reload()`,
    // on every hire-card mount and every Settings open, and the catalog
    // instance is shared across the host, the IPC handler, and the WS case.
    // So a model can read a description listing specialist X, then have its
    // `Task` call for X resolve against a roster where X was just removed.
    // This is safe, not merely tidy: an id that vanished from the live
    // roster falls back to `roster.resolve()` returning undefined, which
    // `task.ts` refuses outright ("Unknown specialist...") before doing
    // anything else — it never reaches a stale permission grant, because the
    // permission subject for an unresolved Task call is a bare path that
    // cannot match any remembered Task rule (see harness-session.ts's own
    // comment on Task's subject, above). Nothing here should be read as "the
    // roster is stable for the turn" — it isn't.
    this.toolByName.set('Task', createTaskTool(this.opts.specialistRoster ?? BUILTIN_ROSTER, this.opts.cwd));
    if (!this.toolByName.has('ModelSearch')) this.toolByName.set('ModelSearch', ModelSearchTool);
  }

  /** Add or remove MCP server tools to match the CURRENT profile's budget
   *  (Task 6, spec §6).
   *
   *  WHOLE SERVERS ONLY: a server whose search tool is attached but whose send
   *  tool is not is worse than an absent server — the model plans against a
   *  capability it then cannot complete. So this walks registry order
   *  accumulating cost, and the FIRST server that would push spend over
   *  budget stops the walk entirely (`break`, not `continue`) — every server
   *  from that point on is dropped too, which is what keeps the kept set a
   *  contiguous PREFIX of registry order (pinned by
   *  mcp-gating.test.ts "drops from the END…") rather than a scattered
   *  best-fit subset. Drop order is registry order from the END so the user
   *  controls what survives by ordering their own list.
   *
   *  Re-run per buildAiTools (not once in the constructor) for the same
   *  reason syncSkillTool is: setBinding() re-resolves the profile on a model
   *  swap, so a server attached under a 128k model must come back OFF on a
   *  swap to an 8k one, and back on when swapping back.
   *
   *  Fix pass 1 / Finding 4: buildAiTools() runs on every turn (see its own
   *  call site), and until this fix syncMcpTools rebuilt from scratch on
   *  EVERY one of those calls regardless of whether anything actually
   *  changed — mcpToolsFor() re-allocates every tool closure and
   *  estimateToolSchemaTokens() re-JSON.stringifies every server's raw schema,
   *  which is real, avoidable work on the common case (no binding swap this
   *  turn). syncSkillTool has a real dirty-check (`toolByName.has('Skill')`);
   *  this one didn't, despite the header above claiming the same "re-run
   *  per buildAiTools" reasoning. mcpSyncedFor restores that parity: only the
   *  budget VALUE and the mcpServers ARRAY REFERENCE are compared (not deep
   *  equality), because those are the only two things this method's output
   *  depends on — setBinding() always hands in a freshly resolved profile
   *  object when the budget changes (mcp-gating.test.ts's re-gate test below
   *  relies on exactly that), and opts.mcpServers only ever gets a new array
   *  reference from NativeSessionHost re-acquiring (create/resume), never
   *  mid-session. Clearing this sync's OWN previously-attached names first
   *  (on an actual re-sync) makes both directions idempotent. */
  private syncMcpTools(): void {
    const rawServers = this.opts.mcpServers;
    const budget = this.profile.mcpToolBudgetTokens;
    // Nothing this method reads has changed since the last sync — skip the
    // teardown/rebuild entirely. `rawServers` (not `servers` below) is the
    // comparison target: defaulting to `[]` here would allocate a NEW empty
    // array on every undefined-mcpServers call, which would never compare
    // equal to itself and defeat the whole point of the check.
    if (this.mcpSyncedFor && this.mcpSyncedFor.budget === budget && this.mcpSyncedFor.servers === rawServers) return;
    this.mcpSyncedFor = { budget, servers: rawServers };

    for (const name of this.mcpToolNames) this.toolByName.delete(name);
    this.mcpToolNames.clear();
    const servers = rawServers ?? [];
    this._droppedMcpServers = [];
    let spent = 0;
    for (let i = 0; i < servers.length; i++) {
      const server = servers[i];
      const tools = mcpToolsFor(server);
      const cost = estimateToolSchemaTokens(tools);
      if (spent + cost > this.profile.mcpToolBudgetTokens) {
        // Everything from HERE ON is dropped (see header) — not just this one
        // server — so the recorded list must cover the whole remaining tail,
        // or the UI would under-report what the user actually lost.
        this._droppedMcpServers = servers.slice(i).map((s) => s.id);
        // Fix (Finding 5): droppedMcpServers has had zero non-test consumers
        // since it was written — a UI reading it is still a later task, but
        // until one exists this is the ONLY place a dropped-for-budget server
        // is observable at all. One line naming the whole dropped tail.
        log('WARN', 'HarnessSession', 'MCP server(s) dropped from this session — over the tool budget', {
          sessionId: this.opts.sessionId, droppedServerIds: this._droppedMcpServers, mcpToolBudgetTokens: this.profile.mcpToolBudgetTokens,
        });
        break;
      }
      spent += cost;
      for (const t of tools) { this.toolByName.set(t.name, t); this.mcpToolNames.add(t.name); }
    }
  }

  /** NativeTool → ai `tool({description, inputSchema})` WITHOUT execute, keyed by
   *  name. No execute => the SDK emits 'tool-call' parts and finishes with
   *  'tool-calls' WITHOUT looping (verified ai@7 contract) — WE own the loop. */
  private buildAiTools(): Record<string, any> {
    // Plain-chat model (profile.supportsTools === false): attach NO tools so the
    // SDK never sends a tool schema. WHY: a small local model the registry marks
    // tool-less would otherwise emit malformed tool-calls we can't honor. Also
    // clear any stale drop list from a PRIOR (tool-capable) binding — "no tools
    // at all" is a different reason than "dropped for budget", and leaving the
    // old list around would misreport why MCP servers are unavailable.
    if (!this.profile.supportsTools) { this._droppedMcpServers = []; return {}; }
    this.syncSkillTool();
    this.syncTaskTool();
    this.syncMcpTools();
    // Simplified presentation (spec §4.2): small local models get each tool's
    // compact shortDescription (falling back to the full description when a tool
    // defines none) so the schema stays small enough for a weak model to follow.
    // The tool SET is identical either way — we only shrink the wording.
    const simplified = this.profile.maxToolPresentation === 'simplified';
    const out: Record<string, any> = {};
    for (const t of this.toolByName.values()) {
      // MCP tools carry the server's own JSON Schema; everything else is zod.
      const schema = t.rawInputSchema ? jsonSchema(t.rawInputSchema as any) : zodSchema(t.inputSchema);
      // descriptionFor lets a tool vary its wording by capability (Read + vision).
      // Simplified presentation still wins for small local models — shortDescription
      // stays the schema-size escape hatch.
      const full = t.descriptionFor?.({ supportsVision: this.profile.supportsVision }) ?? t.description;
      // Fix (2026-08-11 review): the simplified branch used to drop straight to the
      // static shortDescription, discarding the vision-aware wording above. That
      // silently reopened the Roo Code #10440 gap for exactly the tier — small
      // local models — simplified presentation targets: a vision model never told
      // Read handles images never tries. shortDescriptionFor mirrors descriptionFor
      // at short-text length; only falls through to the static text/full when a
      // tool doesn't define one (or the model has no vision).
      const shortDesc = t.shortDescriptionFor?.({ supportsVision: this.profile.supportsVision }) ?? t.shortDescription ?? full;
      out[t.name] = tool({ description: simplified ? shortDesc : full, inputSchema: schema });
    }
    return out;
  }

  /** Assistant history message: text part (if any) + one tool-call part per call.
   *  Shape pinned by the ai@7 contract test (input is the PARSED object). */
  private assistantMessage(text: string, toolCalls: ToolCall[]): ModelMessage {
    const content: any[] = [];
    if (text) content.push({ type: 'text', text });
    for (const c of toolCalls) content.push({ type: 'tool-call', toolCallId: c.toolCallId, toolName: c.toolName, input: c.input });
    return { role: 'assistant', content } as ModelMessage;
  }

  /** Tool-result history part. The `output: { type:'text', value }` shape is
   *  pinned (Task 1) — `result`/other field names throw AI_InvalidPromptError.
   *  `images` defaults to `[]` so every existing caller (including the interrupt
   *  back-fill, which passes only `text`) keeps emitting the byte-identical
   *  text-only shape. When images ARE present, the output becomes ai@7's
   *  'content' shape — @ai-sdk/anthropic maps it to native tool_result image
   *  blocks; every other wire is rewritten by adaptForWire (wire-adapter.ts). */
  private toolResultPart(call: ToolCall, text: string, images: Array<{ mediaType: string; data: Buffer; filename?: string }> = []): any {
    if (!images.length) {
      return { type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'text', value: text } };
    }
    return {
      type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName,
      output: {
        type: 'content',
        value: [
          { type: 'text', text },
          // Fix 3 (2026-08-11 review): filename rides through onto the file
          // part. wire-adapter.ts labels every image `f.filename ?? toolName`
          // — precisely so a multi-image result doesn't produce N identical
          // placeholders naming only the tool. Without this every image was
          // labelled "Read" regardless of which file it was.
          ...images.map((i) => ({ type: 'file', mediaType: i.mediaType, data: { type: 'data', data: i.data }, ...(i.filename ? { filename: i.filename } : {}) })),
        ],
      },
    };
  }

  /** Oldest-first truncation to fit the context window. Always keeps the
   *  newest user message; chars/4 is a deliberate estimate, not a tokenizer.
   *  WHY this matters for shownImages: this trims the OUTGOING REQUEST only —
   *  `this.history` itself is untouched — so an image can drop out of what the
   *  model actually sees while the dedupe cache still vouches for it. See the
   *  shownImages field comment's KNOWN GAP section for the reachability
   *  analysis and why that isn't fixed here. */
  private fitToContext(messages: ModelMessage[]): ModelMessage[] {
    const ctx = this.opts.contextLength ?? 32_768;
    const budgetTokens = ctx - (this.opts.harness.limits?.maxTokens ?? 4096) - 1024; // output + margin
    // Degenerate case: a tiny contextLength (a real Plan B possibility — a small
    // local model with, say, a 2k window) can make budgetTokens zero or negative.
    // The `kept.length > 0` gate below means we ALWAYS keep the newest message
    // regardless of budget, so history collapses to that single message rather
    // than erroring. That's intentional — one turn through a tiny model beats a
    // hard failure — so no clamp is applied here.
    const total0 = Math.ceil(this.systemText.length / APPROX_CHARS_PER_TOKEN);
    let total = total0;
    const kept: ModelMessage[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const size = messageTokens(messages[i]);   // binary-aware — see message-size.ts
      if (kept.length > 0 && total + size > budgetTokens) break;
      kept.unshift(messages[i]);
      total += size;
    }
    // Pair-aware front trim: oldest-first truncation can cut BETWEEN an
    // assistant(tool-call) and its paired tool result, leaving the window
    // starting on an orphaned role:'tool' message OR an assistant tool-call
    // whose result got dropped — both are unpaired tool_calls that provider
    // APIs 400 on. Drop leading messages until the window starts on a user or
    // plain-text-assistant message. (An assistant tool-call and its adjacent
    // tool result are dropped together as a pair.)
    while (kept.length > 0) {
      const first = kept[0];
      const isOrphanToolResult = first.role === 'tool';
      const isToolCallOpener = first.role === 'assistant' && Array.isArray(first.content)
        && first.content.some((p: any) => p && p.type === 'tool-call');
      if (isOrphanToolResult || isToolCallOpener) { kept.shift(); continue; }
      break;
    }
    // The two rules above are individually right and together could return NOTHING:
    // the size loop always keeps the newest message even when it alone blows the
    // budget ("history collapses to that single message rather than erroring"),
    // but if that survivor is a tool result, the pair-aware trim then drops it as
    // an orphan — and the driver sends an empty prompt, which providers reject
    // with "Invalid prompt: messages must not be empty".
    //
    // Found 2026-07-26 dogfooding: asking a local model to read ROADMAP.md
    // returned a 100 KB tool result (read.ts raises its own cap to 100_000 chars)
    // that exceeded the window on its own, and the turn died. Latent on master,
    // not introduced by Plan C — Plan C just made big local reads routine.
    if (kept.length === 0) return this.salvageOversizedTail(messages, budgetTokens, total0);
    return kept;
  }

  /** Last resort for fitToContext: the newest exchange doesn't fit even alone.
   *
   *  Rather than dropping the tool result (which leaves the model staring at its
   *  own unanswered request — it just re-runs the same call until the doom-loop
   *  guard trips) we keep the PAIR intact and shrink the result's text to the
   *  budget. Truncating tool output to fit is exactly what compaction's
   *  pruneToolOutputs does, so this is the established shape, not a new idea.
   *
   *  Returns [user?, assistant(tool-call), tool(truncated)] — a valid window that
   *  preserves the pairing invariant the front trim exists to protect. */
  private salvageOversizedTail(messages: ModelMessage[], budgetTokens: number, systemTokens: number): ModelMessage[] {
    const toolIdx = messages.map((m) => m.role).lastIndexOf('tool');
    // No tool message means the oversized survivor was a plain user/assistant
    // message, which the front trim never drops — keep the newest and move on.
    if (toolIdx < 0) return messages.slice(-1);

    const call = messages[toolIdx - 1];
    const hasCall = !!call && call.role === 'assistant';
    // The user turn that started this exchange, when there is one — it is what
    // tells the model WHY the tool ran, and it is small.
    let userIdx = -1;
    for (let i = (hasCall ? toolIdx - 2 : toolIdx - 1); i >= 0; i--) {
      if (messages[i].role === 'user') { userIdx = i; break; }
    }
    const head: ModelMessage[] = [];
    if (userIdx >= 0) head.push(messages[userIdx]);
    if (hasCall) head.push(call);

    // Whatever budget is left after the system prompt and the head goes to the
    // tool output. Floored at a usable amount so a hostile budget still yields a
    // readable fragment rather than an empty string.
    const usedTokens = systemTokens + head.reduce((n, m) => n + messageTokens(m), 0);   // binary-aware
    const availableChars = Math.max(2_000, (budgetTokens - usedTokens) * APPROX_CHARS_PER_TOKEN);
    return [...head, truncateToolMessage(messages[toolIdx], availableChars)];
  }

  // Below this many tokens a span isn't worth a model round-trip to summarize
  // (spends a call to save almost nothing). Also the thrash floor — see I3 note
  // in maybeCompact.
  private static readonly MIN_SUMMARIZE_SPAN_TOKENS = 500;

  /** Compaction thresholds scaled to the model window. Big models protect ~40k
   *  and only prune when it saves ≥20k; tiny local windows scale those down so
   *  the trigger/prune/protect bands are actually REACHABLE in an 8k (or smaller)
   *  window — otherwise a small model would never compact until it 400'd.
   *  CAVEAT (very small windows, ctx ~4–8k): fitToContext's own budget
   *  (ctx − maxTokens − 1024) can land at or below protectedTokens here, so a
   *  freshly-written summary may be largely re-truncated by fitToContext anyway.
   *  Accepted — one degraded turn beats a hard 400 — but documented so it isn't
   *  mistaken for a bug. */
  private compactionConfig(): CompactionConfig {
    const ctx = this.opts.contextLength ?? 32_768;
    const big = ctx >= 100_000;
    return { contextLength: ctx, triggerRatio: 0.75, protectedTokens: big ? 40_000 : Math.floor(ctx * 0.4), minPruneSavings: big ? 20_000 : Math.floor(ctx * 0.1), pruneToChars: 2000 };
  }

  /** Two-stage compaction (spec §4.4). PRUNE first (nearly lossless, shrinks the
   *  summarize span too); if pruning can't get under budget, SUMMARIZE the condensed
   *  span, keeping the last 2 user-delimited turns verbatim, and emit compact-summary.
   *  FAIL-SAFE: a summary that throws or comes back empty leaves the pruned history —
   *  fitToContext (in consumeStep) is the hard floor, so the turn never bricks. */
  private async maybeCompact(model: LanguageModel, lastInputTokens: number): Promise<void> {
    const cfg = this.compactionConfig();
    const decision = planCompaction(this.history, cfg, lastInputTokens);
    if (decision.action === 'none') return;
    // Prune can now collapse an image 'content' output to text (compaction.ts)
    // outside its protected window — a THIRD path (besides /clear and
    // summarize) that discards a delivered image. Diff the image count across
    // the call to catch it regardless of what decision.action turns out to be
    // below, including the plain 'prune' early-return two lines down.
    const imagesBeforePrune = countImageOutputs(this.history);
    this.history = pruneToolOutputs(this.history, cfg);   // always prune first
    if (countImageOutputs(this.history) < imagesBeforePrune) this.shownImages.clear();
    // G-11: prune may have sliced an old Read result down to 2,000 chars (and
    // summarize below discards it outright) — forget what was served so Read
    // never claims the model still has content it no longer does. Cleared on
    // every non-'none' action rather than diffed, because a text prune has no
    // cheap before/after signal the way images do; the cost of over-clearing
    // is one redundant re-read, the cost of under-clearing is a false notice.
    this.servedReads.clear();
    if (decision.action === 'prune') return;
    const cut = this.summarizeCutIndex();
    if (cut <= 0) return;                                  // nothing safely condensable → pruned history stands
    const keep = this.history.slice(cut);
    const span = this.history.slice(0, cut);              // already pruned
    // I3 thrash guard: if the last-2-turns `keep` span ALONE exceeds the trigger
    // (e.g. a fresh 6k-token tool result in an 8k window), the condensable `span`
    // is tiny yet planCompaction keeps saying 'summarize' every step. Re-summarizing
    // a near-empty span burns a model call + emits a dead compact-summary each step
    // (~25/turn). Bail when the span is trivial — the pruned history stands and
    // fitToContext remains the floor.
    if (span.length <= 1 || estimateTokens(span) < HarnessSession.MIN_SUMMARIZE_SPAN_TOKENS) return;
    let summary = '';
    try { summary = await this.generateSummary(model, span); } catch { summary = ''; }
    if (!summary.trim()) return;                          // FAIL-SAFE: no summary → leave pruned history
    // Existing frozen event (no new type). `summary` is the canonical field the
    // renderer reads (types.ts / App.tsx / BubbleFeed.tsx). `autoCompaction` tags
    // this as a SPONTANEOUS native compaction so the renderer surfaces the marker
    // even though the manual-/compact `compactionPending` flag was never set —
    // CC's own compact-summary events never carry it, so the manual path is
    // untouched.
    this.emitEvent('compact-summary', { summary, autoCompaction: true });
    // Fix 2 (2026-08-11): the summarized-away span can still contain a
    // delivered image. pruneToolOutputs (above) now DOES collapse 'content'
    // (image) outputs too, but only ones OUTSIDE its own token-budget
    // protected window — see the imagesBeforePrune diff above, which handles
    // that case. An image can sit INSIDE that window (survive prune) yet
    // still fall in THIS summarize span (older than the turn-based last-2
    // cut) and get flattened into `summary` here. An un-cleared shownImages
    // would then keep vouching for an image no longer in history — the same
    // false "already visible" bug /clear had (Fix 1), reachable here
    // automatically at 75% context instead of only on an explicit /clear.
    this.shownImages.clear();
    this.history = [{ role: 'user', content: `[Earlier conversation summary]\n${summary}` } as ModelMessage, ...keep];
  }

  // Live prefill progress from llama.cpp, forwarded onto the SAME
  // assistant-thinking notice the size-only estimate already drives — the UI
  // upgrades in place from "reading N tokens" to a real fraction + countdown.
  //
  // Throttled: llama-server reports roughly once per batch, but a small batch on
  // fast hardware can produce a burst, and every emit crosses IPC and re-renders
  // the indicator. One update per 400ms is well past the eye's ability to read a
  // changing number. The FINAL reading always goes through, so the bar cannot be
  // left stranded at 87%.
  private lastPrefillEmitAt = 0;
  /** Re-arm hook for the CURRENT step's stall watchdog, installed by
   *  runStreamOnce. Prefill progress is proof of life and must reset the clock —
   *  without this a slow-but-healthy prefill trips the watchdog, gets KILLED and
   *  RETRIED from scratch, which is what made progress appear to reset itself
   *  (Destin, 2026-07-26). */
  private rearmStallWatchdog: (() => void) | null = null;
  /** True once THIS turn has parked on a stall the user was told about.
   *  WHY it outlives the step: a manual Retry re-runs the step from the top,
   *  which lands back on the FIRST-BYTE clock (Clock 1). Without this flag a
   *  retry against a dead provider would sit for the full prefill budget and
   *  then kill the turn with Clock 1's "didn't begin responding" error — the
   *  exact ending this design exists to remove, arriving four minutes after the
   *  user asked for the opposite. Cleared at the start of every turn.
   *  Its one LIVE effect already, before any Retry button exists: inside a
   *  turn that has already parked once, a LATER step's own Clock-1 stall
   *  (e.g. a fresh tool-call step that never gets a first byte) parks too
   *  instead of ending the turn — see the `willRetry` guard in armWatchdog. */
  private turnEverParked = false;
  /** Resolver for the CURRENT step's manual-retry signal, installed when the
   *  step parks and cleared the moment it un-parks or the step ends. Null means
   *  nothing is parked, which is the entire race guard for the Retry button. */
  private resolveRetry: (() => void) | null = null;
  private emitPrefillProgress(p: PrefillProgress): void {
    // Prefill progress after the first token would be describing work the user
    // can already see the result of; the notice is a pre-output affordance only.
    if (this.abort == null) return;
    // Proof of life FIRST, before any throttling — a throttled-away report must
    // still reset the stall clock, or the throttle itself could cause a stall.
    this.rearmStallWatchdog?.();
    // Same local-only gate as the opening estimate below — one rule for the
    // whole affordance, so a hosted provider that ever started reporting
    // progress still can't put a prefill readout on a cloud session. Deliberately
    // BELOW the re-arm above: a report is proof of life whether or not we render
    // it, and gating the re-arm too would let a healthy stream trip the watchdog.
    if (!this.profile.announcePrefill) return;
    const report = toReport(p);
    const isFinal = report.newProcessed >= report.newTotal;
    const now = Date.now();
    if (!isFinal && now - this.lastPrefillEmitAt < 400) return;
    this.lastPrefillEmitAt = now;
    this.emitEvent('assistant-thinking', {
      promptProcessing: {
        // NEW work, not the whole prompt — matching the pre-progress notice's own
        // `newTokens` estimate, so the denominator does not jump (and the
        // percentage fall) the moment the first live report replaces it.
        promptTokens: report.newTotal,
        budgetMs: 0,
        source: this.prefillSource,
        processed: report.newProcessed,
        cached: report.cache,
        etaMs: report.etaMs,
        // The renderer extrapolates between these sparse per-batch reports and
        // needs the measured rate, which is processed/timeMs.
        timeMs: report.timeMs,
      },
    });
  }

  /** What grew the context for the CURRENT step — set when the step opens so the
   *  async progress callbacks can label themselves without re-deriving it. */
  private prefillSource: 'prompt' | 'tool-output' = 'prompt';

  /** USER-INITIATED compaction (the /compact command and the Context popup's
   *  "Compact conversation" button), as opposed to maybeCompact's automatic,
   *  threshold-driven one.
   *
   *  Differences from maybeCompact, all deliberate:
   *   - No `planCompaction` trigger check and no MIN_SUMMARIZE_SPAN thrash guard.
   *     Those exist to stop the AUTOMATIC path burning model calls on its own
   *     initiative; when the user explicitly asks, "you're not full enough yet"
   *     would be the app second-guessing an explicit instruction.
   *   - Emits `compact-summary` WITHOUT `autoCompaction`. That flag exists purely
   *     to let a spontaneous compaction bypass the renderer's `compactionPending`
   *     guard. The manual path already sets `compactionPending` (the dispatcher
   *     does it before calling us), so it must take the ORDINARY route — setting
   *     `auto` here would make the manual marker skip its own pending state.
   *   - Returns a REASON on refusal rather than resolving silently, so the caller
   *     can tell the user why nothing happened (docs/error-message-standards.md).
   *     A silent no-op is what this whole milestone exists to delete.
   *
   *  Takes `this.abort` for the duration: that makes the summary stream
   *  interruptible via interrupt() exactly like a turn's, and makes a concurrent
   *  send() hit the existing re-entrancy guard instead of mutating history
   *  underneath us. Cleared in a finally so a throw can't brick the session. */
  async compactNow(): Promise<{ ok: true } | { ok: false; reason: 'turn-in-flight' | 'nothing-to-compact' | 'summary-failed' }> {
    if (this.abort) return { ok: false, reason: 'turn-in-flight' };
    this.abort = new AbortController();
    try {
      const cfg = this.compactionConfig();
      // Prune first — same order as the automatic path, and it shrinks the span
      // the model has to read before we pay for a summary. Same image-collapse
      // diff as maybeCompact's prune call — see its comment for why this is
      // keyed on an actual count decrease, not on whether summarize runs next.
      const imagesBeforePrune = countImageOutputs(this.history);
      this.history = pruneToolOutputs(this.history, cfg);
      if (countImageOutputs(this.history) < imagesBeforePrune) this.shownImages.clear();
      this.servedReads.clear(); // G-11: same reasoning as maybeCompact — prune may have cut a served Read
      const cut = this.summarizeCutIndex();
      // <2 user turns means there is no boundary we can cut on without risking
      // splitting a tool-call/result pair, so there is genuinely nothing to do.
      if (cut <= 0) return { ok: false, reason: 'nothing-to-compact' };
      const keep = this.history.slice(cut);
      const span = this.history.slice(0, cut);
      if (span.length === 0) return { ok: false, reason: 'nothing-to-compact' };
      let summary = '';
      try {
        const model = await this.modelFactory(this.binding, {
          serialToolCalls: this.profile.constrainToolArgs && !this.profile.supportsParallelToolCalls,
          cacheKey: this.opts.sessionId,
        });
        summary = await this.generateSummary(model, span);
      } catch {
        summary = '';
      }
      // FAIL-SAFE, same as the automatic path: a failed or empty summary leaves
      // the PRUNED history in place rather than discarding anything. The user
      // still gets a real (if smaller) reduction, and never a lost conversation.
      if (!summary.trim()) return { ok: false, reason: 'summary-failed' };
      this.emitEvent('compact-summary', { summary });
      // Fix 2 (2026-08-11): same reasoning as maybeCompact above — the manual
      // /compact path discards the summarized span exactly the same way, so
      // the dedupe cache must be cleared here too or it keeps vouching for
      // images this summary just removed.
      this.shownImages.clear();
      this.history = [{ role: 'user', content: `[Earlier conversation summary]\n${summary}` } as ModelMessage, ...keep];
      return { ok: true };
    } finally {
      this.abort = null;
    }
  }

  /** /clear as a CONTEXT BARRIER (M3 item 2, Destin's call 2026-07-26).
   *
   *  The session JSONL is append-only with a write-once header, so "clear"
   *  genuinely cannot erase history. Instead it drops the model's in-memory
   *  history and appends a `context-clear` marker; `rebuildHistory` treats that
   *  marker as a barrier on resume, so the model never sees anything before it
   *  while the conversation keeps its file, its id and its full readable
   *  scrollback. Chosen over "start a new session" so a reset doesn't scatter
   *  half-conversations through the user's history.
   *
   *  Refuses while a turn is in flight rather than yanking history out from
   *  under a running turn — the same reasoning (and the same honest coded
   *  refusal) as compactNow. */
  clearHistory(): { ok: true } | { ok: false; reason: 'turn-in-flight' } {
    if (this.abort) return { ok: false, reason: 'turn-in-flight' };
    this.history = [];
    // Fix 1 (CRITICAL, 2026-08-11): the dedupe cache must not outlive the
    // history it was vouching for. Left alive, a model that re-Reads an
    // unchanged file after /clear gets "already visible earlier in this
    // conversation" — now FALSE, since that earlier delivery is gone — paired
    // with no image ever being attached again for the rest of the session
    // (barring an unrelated mtime change). Clearing here makes the next Read
    // of that file deliver for real, matching what "already visible" claims.
    this.shownImages.clear();
    this.servedReads.clear(); // G-11: same contract — the served Read results are gone with the history
    // Emitted (not just persisted) so the store appends it through the host's
    // normal chain AND every attached surface — other windows, the remote web
    // client — learns the conversation was cleared. On replay this same event
    // resets the visible timeline, keeping what the user sees after a restart
    // identical to what they saw when they cleared.
    this.emitEvent('context-clear', {});
    return { ok: true };
  }

  /** Index where the last 2 user-message-delimited turns begin (0 if <2 turns).
   *  Injected rule messages are role:'user' but are NOT turns — counting them
   *  shrank the protected window to "the last 2 injections" when a step
   *  touched several rule-matched paths (2026-08-11, compaction accounting).
   *  Detected by content shape rather than a flag: injectPathTriggers (above)
   *  pushes them as `<project-rule source="...">...`, and that's the only
   *  thing this method has to go on — synthetic wire messages never enter
   *  history at all, so they were already immune by construction.
   *  (The per-turn `<specialists-status>` block that once shared this
   *  exclusion was retired 2026-09-09; Task `list: true` replaced it.) */
  private summarizeCutIndex(): number {
    const userIdx: number[] = [];
    this.history.forEach((m, i) => {
      const c = (m as any).content;
      const isSyntheticInjection = typeof c === 'string'
        && c.startsWith('<project-rule ');
      if ((m as any).role === 'user' && !isSyntheticInjection) userIdx.push(i);
    });
    return userIdx.length < 2 ? 0 : userIdx[userIdx.length - 2];
  }

  /** Model-generated summary of the condensed span. Bounds the span first so the
   *  summary call itself can't overflow (hard-trim oldest messages until it fits ~60%
   *  of the window). The caller wraps this in try/catch (fail-safe).
   *
   *  C1 — the summary runs on the SAME (possibly stalled) local model this whole
   *  branch targets, so we consume it EXACTLY like consumeStep does: an explicit
   *  iterator raced against BOTH the turn's abort signal AND a wall-clock timeout.
   *  A plain `for await` would block forever on a provider that stops emitting
   *  without honoring abort — ESC could not break it, send() would never resolve,
   *  and this.abort would stay non-null, bricking every future send() via the
   *  re-entrancy guard. On abort OR timeout we stop consuming and return whatever
   *  partial text we have (the fail-safe tolerates ''): the summary never wedges
   *  the turn. */
  private async generateSummary(model: LanguageModel, span: ModelMessage[]): Promise<string> {
    const cfg = this.compactionConfig();
    let bounded = span;
    while (estimateTokens(bounded) > cfg.contextLength * 0.6 && bounded.length > 1) bounded = bounded.slice(1);
    // Summaries are text about text: images are ALWAYS stripped here, regardless
    // of the session's actual profile — the summarizer may be a non-vision local
    // model, and pixels add nothing to a compression prompt.
    const result = streamText({ model, system: 'You compress conversation history. Be faithful and concise.', messages: [...adaptForWire(bounded, { nativeImageToolResults: false, supportsVision: false }), { role: 'user', content: summarizePrompt() } as ModelMessage], abortSignal: this.abort!.signal });

    // Race iterator.next() against the abort signal AND a 30s wall-clock floor —
    // the same hardening consumeStep uses, since a stalled local stream honors
    // neither on its own.
    const iterator = (result.textStream as AsyncIterable<string>)[Symbol.asyncIterator]();
    const abortSignal = this.abort!.signal;
    const stopPromise = new Promise<'stop'>((resolve) => {
      if (abortSignal.aborted) { resolve('stop'); return; }
      const timer = setTimeout(() => resolve('stop'), 30_000);
      abortSignal.addEventListener('abort', () => { clearTimeout(timer); resolve('stop'); }, { once: true });
    });

    let text = '';
    while (true) {
      const nextPromise = iterator.next();
      const chunk = await Promise.race([nextPromise, stopPromise]);
      if (chunk === 'stop') {
        // Abort or timeout won: release the reader/socket (a provider that ignores
        // abort would otherwise leak it) and stop with the partial text so far.
        nextPromise.catch(() => {});
        iterator.return?.().catch(() => {});
        break;
      }
      if (chunk.done) break;
      if (chunk.value) text += chunk.value;
    }
    // WHY the summary call's tokens are NOT folded into turnUsage: awaiting
    // result.usage would only settle once the stream ends cleanly — on the
    // abort/timeout break above it may never settle, which would reintroduce the
    // exact hang C1 exists to prevent. Under-reporting the (small) summary-call
    // tokens is the accepted trade for a summary that can never wedge the turn.
    return text.trim();
  }

  /** Run a user-invoked skill (/skill-name, M3 item 1).
   *
   *  Same turn machinery as send(), with ONE difference that matters: the
   *  transcript event is `skill-invoked`, not `user-message`. The model's history
   *  gets the full instructions; the UI gets a compact card. Sending the body as
   *  a user message rendered 26k characters of SKILL.md as a chat bubble
   *  (Destin, 2026-07-28) — the timeline should show what the user DID.
   *
   *  The body is persisted on the event so `rebuildHistory` can restore the same
   *  model history on resume. Without it a resumed conversation would replay a
   *  turn whose opening move has no visible cause.
   */
  async runSkill(inv: { skillId: string; displayName: string; body: string; args?: string; skillPath?: string }): Promise<void> {
    const historyText = inv.args ? `${inv.body}\n\n${inv.args}` : inv.body;
    return this.beginTurn(historyText, () => this.emitEvent('skill-invoked', {
      skillId: inv.skillId, displayName: inv.displayName, args: inv.args,
      body: inv.body, skillPath: inv.skillPath,
    }));
  }

  /** `attachments` are absolute paths to files the user attached in the composer.
   *  Image ones become image parts on the user message when the model can see
   *  them; everything else is ignored here and reaches the model as the path
   *  text the composer already put in `text`.
   *
   *  WHY images ride ALONGSIDE the text rather than replacing it: `text` is the
   *  dedup key. The renderer's optimistic bubble is confirmed by an EXACT match
   *  against the `user-message` event's text (see native-send.ts), so the string
   *  must stay byte-identical to what the composer built. The paths therefore
   *  remain in the text AND the pixels are attached — the model gets both, and
   *  the bubble still resolves. */
  async send(text: string, attachments: string[] = []): Promise<void> {
    // Attachments ride the persisted event (paths only — events carry no binary)
    // so rebuildHistory can restore the pixels on resume. Emitted only when
    // present to keep the no-attachment event byte-identical to before (#290
    // follow-up fix 2).
    return this.beginTurn(text, () => this.emitEvent('user-message', attachments.length ? { text, attachments } : { text }), attachments);
  }

  /** Task 4 (native specialists, background execution) — inject a background
   *  specialist's finished report (or typed failure) as a full, real turn.
   *  Same turn machinery as send()/runSkill(), with ONE difference: the
   *  `user-message` event carries `data.injected: 'specialist-report'` — a
   *  data-field extension (shared/types.ts), never a new event type, so a
   *  renderer that doesn't know the field yet still shows a plain message.
   *
   *  WHY a real turn and not a history-only splice: the model needs to
   *  actually SEE and reason about the report on its next step, which means
   *  it has to go through the model exactly like any other turn — this is
   *  not a status update, it is new information the parent must act on.
   *  Callers (NativeSessionHost.runTurns) are responsible for only calling
   *  this at an idle boundary — beginTurn's own re-entrancy guard would throw
   *  if it were called mid-turn, by design (never splice into a running turn:
   *  role alternation + the local prompt cache both depend on it). */
  async runNotice(text: string, meta?: InjectedMeta): Promise<void> {
    // G-1: the discriminant tells the renderer which card folds this turn —
    // a Task card (specialist report) or a Bash card (shell-complete).
    const injected = meta?.kind === 'shell' ? 'shell-complete' : 'specialist-report';
    return this.beginTurn(text, () => this.emitEvent('user-message', {
      text, injected,
      // Structured header data for the renderer's SpecialistReportCard —
      // optional so every existing caller/test that passes text alone is
      // unchanged; the card falls back to the prose when it's absent.
      ...(meta ? { injectedMeta: meta } : {}),
    }));
  }

  /** The quiet twin of runNotice: the same text and the same `user-message`
   *  transcript event, but NO model turn — the report goes into history and
   *  the model reads it at the start of the next turn the user begins.
   *  Used only after a Stop (NativeSessionHost.holdDeliveries): the user asked
   *  for silence, so a finished helper must not be the thing that breaks it.
   *  Consecutive user-role history entries are a shape every provider we ship
   *  already accepts: the retired per-turn `<specialists-status>` block ran it
   *  in production for weeks, and `<project-rule>` injections still do.
   *  Same idle-only precondition as runNotice: never mid-turn. */
  async spliceNotice(text: string, meta?: InjectedMeta): Promise<void> {
    if (this.abort) {
      throw new Error('HarnessSession: spliceNotice called while a turn is in flight — callers must only splice at an idle boundary.');
    }
    const injected = meta?.kind === 'shell' ? 'shell-complete' : 'specialist-report';
    this.emitEvent('user-message', { text, injected, ...(meta ? { injectedMeta: meta } : {}) });
    this.history.push({ role: 'user', content: text });
  }

  /** Image parts for a user message, or [] when the model cannot see images / none
   *  were attached. Unreadable or oversized files are SKIPPED rather than thrown:
   *  a turn must not die because one attachment went missing between the composer
   *  and the send, and the path is still in the message text either way. */
  private imagePartsFor(attachments: string[]): Array<{ type: 'file'; mediaType: string; data: Buffer }> {
    if (!attachments.length || !this.profile.supportsVision) return [];
    const parts: Array<{ type: 'file'; mediaType: string; data: Buffer }> = [];
    for (const p of attachments) {
      const img = readImageFromDisk(p);   // shared reader — one table, one cap (fix 3)
      if (img) parts.push({ type: 'file', mediaType: img.mediaType, data: img.data });
    }
    return parts;
  }

  /** Resolve a tool's promised image paths into deliverable parts, charging the
   *  per-turn budget and the per-session dedupe, and AMENDING the result text
   *  with a named note for every skip — the note rides the same text the model
   *  and the transcript see, so promise and delivery can never disagree.
   *  `budget` is a beginTurn-scoped local shared across every tool call in the
   *  turn (mutated in place), which is what makes the count/byte caps PER-TURN
   *  rather than per-call.
   *
   *  No `!this.profile.supportsVision` check here, unlike imagePartsFor's
   *  sibling gate above — deliberately, not an oversight (2026-08-11 review).
   *  It's already double-covered: the Read tool gates on vision before it ever
   *  PROMISES a path, and wire-adapter.ts strips/relabels images for
   *  non-vision caps at request-build time. A third gate here would be
   *  redundant, not safer. */
  private resolveToolImages(
    payload: ToolResultPayload,
    budget: { count: number; bytes: number },
  ): { text: string; images: Array<{ path: string; mediaType: string; data: Buffer; filename: string }> } {
    const paths = payload.images ?? [];
    if (!paths.length) return { text: payload.text, images: [] };
    let text = payload.text;
    const images: Array<{ path: string; mediaType: string; data: Buffer; filename: string }> = [];
    for (const p of paths) {
      // The tool already stat'd this file before promising it (resolve-before-
      // promise, Task 4) — but time passed between that stat and this delivery,
      // so it can have vanished. Re-stat rather than trust the promise. Kept
      // (not just its mtime) so a later null-from-readImageFromDisk can be
      // diagnosed against this SAME stat instead of a second, possibly-stale one.
      let mtime: number;
      let st: fs.Stats;
      try { st = fs.statSync(p); mtime = st.mtimeMs; } catch {
        text += `\n[image not attached: ${p} is no longer readable]`; continue;
      }
      if (this.shownImages.get(p) === mtime) {
        text += `\n[image not re-attached: ${p} is unchanged and already visible earlier in this conversation]`; continue;
      }
      if (budget.count >= MAX_IMAGES_PER_TURN) {
        text += `\n[image not attached: over the ${MAX_IMAGES_PER_TURN}-images-per-turn budget — ask again next turn if you still need it]`; continue;
      }
      const img = readImageFromDisk(p);
      if (!img) {
        // readImageFromDisk collapses three distinct causes to null. The old
        // text guessed "vanished" for all of them — near-impossible here since
        // the stat four lines up already succeeded — which is exactly the
        // unverified-cause error message this repo's standard forbids. Name
        // the real one instead: undeliverable FORMAT, oversized (the stat we
        // already have is trustworthy for this), or — the one genuine
        // "vanished/unreadable" case — a read that threw between the stat and
        // here.
        if (!deliverableImageMediaType(p)) {
          text += `\n[image not attached: ${p} is not a deliverable image format]`;
        } else if (st.size > MAX_ATTACHMENT_BYTES) {
          text += `\n[image not attached: ${p} exceeds the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB per-image size limit]`;
        } else {
          text += `\n[image not attached: ${p} could not be read]`;
        }
        continue;
      }
      if (budget.bytes + img.data.length > MAX_IMAGE_BYTES_PER_TURN) {
        text += `\n[image not attached: over the ${MAX_IMAGE_BYTES_PER_TURN / (1024 * 1024)} MB-per-turn image budget]`; continue;
      }
      budget.count += 1; budget.bytes += img.data.length;
      this.shownImages.set(p, mtime);
      // Fix 3 (2026-08-11 review): carry the file's own basename through so
      // toolResultPart can label the part with it instead of the tool's name —
      // see that method for why an unset filename defeats the point.
      images.push({ path: p, mediaType: img.mediaType, data: img.data, filename: path.basename(p) });
    }
    return { text, images };
  }

  /** The turn driver. `emit` names how this turn ENTERED the conversation — a
   *  typed message, or a skill invocation — which is the only thing that differs
   *  between send() and runSkill(). Everything downstream is identical. */
  private async beginTurn(text: string, emit: () => void, attachments: string[] = []): Promise<void> {
    // Re-entrancy guard: a non-null abort means a turn is already streaming.
    // Throw loudly rather than corrupt the single-slot turn state (see the
    // class-level CONCURRENCY PRECONDITION note).
    if (this.abort) {
      throw new Error('HarnessSession: a turn is already in flight — callers must serialize send()/runSkill() per session.');
    }
    this.interrupted = false;
    this.bashOutputReadsThisTurn = 0;   // G-1 (D7): the cap is per TURN, notice turns included
    emit();
    // A plain string when there are no image parts — that is the byte-identical
    // shape every existing test and rebuildHistory() already assert on, so the
    // no-attachment path must not become a one-element parts array.
    const imageParts = this.imagePartsFor(attachments);
    this.history.push(imageParts.length
      ? { role: 'user', content: [{ type: 'text', text }, ...imageParts] } as any
      : { role: 'user', content: text });
    this.abort = new AbortController();
    this.turnEverParked = false;   // cleared at the start of every turn — see field WHY
    this.lastStepPromptTokens = 0;   // a new turn always begins with a full prefill

    const startedAt = Date.now();
    const turnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    // The PROVIDER's own bill for this turn, summed over the same steps
    // turnUsage covers, so the two figures are comparable.
    //
    // WHY the two counters: the provider bills per REQUEST while costForUsage
    // prices a whole TURN of N steps. Summing both is only honest while both
    // sums cover the SAME steps. A turn where some steps reported a cost and
    // some did not (a mid-turn model swap to a provider that reports nothing,
    // or a response that simply omitted the field) would otherwise publish
    // part of a bill next to all of a turn — a fake disagreement, silently, in
    // the cheap direction. When the counts differ, the turn reports no
    // provider figure at all.
    let turnProviderCostUsd: number | undefined;
    let stepsCounted = 0;
    let stepsWithProviderCost = 0;
    // Time spent GENERATING, summed over the turn's steps. Not wall-clock: a turn
    // includes prefill, tool execution and permission waits, and dividing output
    // tokens by all of that reports a decode speed several times slower than the
    // model's real one (found in the 2026-07-28 audit).
    let generationMs = 0;
    const recentCalls: string[] = [];           // doom-loop window (turn-level)
    const imageBudget = { count: 0, bytes: 0 };  // per-turn image delivery budget (spec "Budgets")
// WHY: specialist work is bounded by its narrow tool set, parent-managed
    // lifecycle controls, and the delegation spawn backstop—not an arbitrary
    // per-child action count. Root sessions preserve any explicit step limit.
    const maxSteps = this.opts.isSpecialistChild
      ? undefined
      : this.opts.harness.limits?.maxSteps;
    let stepsSinceApproval = 0;
    // Consecutive contentless steps (empty-step recovery, spec 2026-08-21).
    // The single silent retry is allowed only at count 1; any real step resets
    // it, so an all-empty turn costs exactly two provider calls.
    let consecutiveEmptySteps = 0;
    let stopReason = 'end_turn';
    // Latest step's partial text — the ONLY thing the catch pushes to history
    // (earlier steps already pushed their assistant + tool messages). Reset per
    // step; an immediate-error retry never touches it (it emits nothing before
    // it throws), and a manual Retry (runStreamOnce's 'retry' branch) clears it
    // itself via reportPartial('') — see that branch for why.
    let partialAssistantText = '';

    try {
      // Serial-only when the profile constrains args AND the model can't do parallel
      // tool calls (spec §4.2 — small local models): the factory injects
      // parallel_tool_calls:false on the local-engine branch. Cloud factories ignore it.
      const model = await this.modelFactory(this.binding, {
        serialToolCalls: this.profile.constrainToolArgs && !this.profile.supportsParallelToolCalls,
        // Live prefill progress → the same assistant-thinking notice the estimate
        // already drives, so the UI upgrades from "reading N tokens" to a real
        // percentage and countdown without a second event type.
        onPrefillProgress: (p) => this.emitPrefillProgress(p),
        cacheKey: this.opts.sessionId,
      });
      const aiTools = this.buildAiTools();       // {} when no tools → v0 chat path

      // Tracks the LAST step's real input-token count (from provider usage) so
      // the next iteration's compaction check triggers on ACTUAL context pressure
      // rather than a chars/4 estimate. 0 on the first iteration → maybeCompact
      // falls back to an estimate (usually well under trigger for a fresh turn).
      let lastInputTokens = 0;
      // Paired with lastInputTokens to answer "how full is the window?". The LAST
      // step's prompt already contains the whole conversation (system + every
      // prior message + every tool result), so lastIn + lastOut is what the next
      // turn's prompt starts from. The summed turnUsage below CANNOT answer this:
      // it re-counts the entire history once per step, so a 5-step turn reports
      // roughly 5x the real occupancy (Destin, 2026-07-28).
      let lastOutputTokens = 0;
      turnLoop: while (true) {
        // WHY: steering (spec §3) applies at the child's next iteration boundary — a
        // tool call is never cut. History-only, like injectPathTriggers: not a
        // transcript event, so it costs nothing on the frozen emit surface.
        if (this.pendingSteers.length > 0) {
          for (const s of this.pendingSteers.splice(0)) {
            this.history.push({ role: 'user', content: `<steer>\n${s}\n</steer>` });
          }
        }
        // Two-stage compaction FIRST (spec §4.4) — prune, then summarize only if
        // pruning can't get under budget. Inert (returns immediately) below the
        // trigger, so the existing loop behavior is unchanged for normal turns.
        await this.maybeCompact(model, lastInputTokens);
        // Reset per STEP (not per retry attempt inside withRetry): the required
        // immediate-error retry never needs this reset itself, since it emits
        // nothing before it throws. A manual Retry is the opposite case — it CAN
        // emit before parking — so that branch clears this on its own
        // (reportPartial('') in runStreamOnce's 'retry' case) rather than relying
        // on this per-step reset to have caught it.
        partialAssistantText = '';
        // One step = one streamText consumption. withRetry wraps the whole
        // CONSUMPTION (not just the streamText call): the SDK surfaces provider
        // errors as {type:'error'} fullStream parts AND rejected promises, so
        // only wrapping the call would miss them (verified ai@7 facts).
        const step = await this.withRetry(() =>
          this.consumeStep(model, aiTools, (t) => { partialAssistantText = t; }),
        );

        lastInputTokens = step.usage.inputTokens;   // feed the NEXT compaction check
        lastOutputTokens = step.usage.outputTokens;
        // Publish the same how-full number the turn-complete payload below
        // reports, one step at a time, so `contextUsedTokens` is readable
        // between turns (and mid-turn, stale by one step) instead of only
        // existing inside this closure. Guarded on inputTokens > 0 for the same
        // reason the emit site is: a provider that reports nothing must not
        // overwrite a real reading with a zero.
        if (lastInputTokens > 0) this._contextUsedTokens = lastInputTokens + lastOutputTokens;

        // Accumulate this step's usage into the turn total.
        turnUsage.inputTokens += step.usage.inputTokens;
        turnUsage.outputTokens += step.usage.outputTokens;
        turnUsage.cacheReadTokens += step.usage.cacheReadTokens;
        turnUsage.cacheCreationTokens += step.usage.cacheCreationTokens;
        stepsCounted++;
        if (step.providerCostUsd !== undefined) {
          stepsWithProviderCost++;
          turnProviderCostUsd = (turnProviderCostUsd ?? 0) + step.providerCostUsd;
        }
        generationMs += step.generationMs;

        // v0 interrupt semantics: push the partial, emit user-interrupt, return.
        // (An interrupted turn NEVER completes as a normal turn-complete.)
        if (step.interrupted || this.interrupted || this.abort.signal.aborted) {
          // trim() gate: same emptiness class as stepHasText below — a
          // whitespace-only partial is no partial at all, and recording it
          // leaves a junk assistant message in history for every later turn.
          if (step.text && step.text.trim().length > 0) this.history.push({ role: 'assistant', content: step.text });
          this.emitEvent('user-interrupt', {});
          return;
        }

        // ONE emptiness predicate for BOTH the history push and the retry gate
        // below. Whitespace-only text counts as empty for both: if the push
        // used truthiness while the retry used trim(), a '\n\n' step would be
        // pushed to history AND retried — the re-run's request would end in a
        // dangling whitespace assistant message (which Anthropic-shaped
        // endpoints reject with a 400), breaking the "history gained nothing"
        // invariant the retry rests on.
        const stepHasText = !!step.text && step.text.trim().length > 0;

        // Record the assistant message (text + any tool-call parts). Skip an
        // empty one (no real text and no calls) so we never push a content-less
        // turn.
        if (stepHasText || step.toolCalls.length > 0) {
          this.history.push(this.assistantMessage(step.text, step.toolCalls));
        }

        // Empty-step recovery (spec: docs/archive/specs/2026-08-21-empty-final-
        // step-turn-recovery-design.md). A degenerate step — no text, no tool
        // calls, yet an orderly finish — used to fall straight into the natural-
        // stop break below and end the turn as a silent 'end_turn', which the
        // user experiences as the assistant simply never answering (observed
        // 3x live, 2026-08-20/21). Re-run it ONCE silently: the push above
        // skipped an empty step, so HISTORY gained nothing and the re-run sends
        // the same conversation — modulo the loop top, which may drain pending
        // steers and run compaction first (deliberate: a steer posted during
        // the dead step should reach the retry, and it stays in history for the
        // next turn either way; tool-call/result pairing holds throughout).
        // A SECOND consecutive empty step ends the turn honestly instead.
        // Reasoning-only steps count as empty BY DECISION (StepResult carries
        // no reasoning; the user-visible outcome is identical to silence).
        const isEmptyStep =
          !step.interrupted &&
          step.toolCalls.length === 0 &&
          !stepHasText;
        // Gate on the "provider claims an orderly finish" shapes ONLY (single
        // list next to mapStopReason — see ORDERLY_EMPTY_FINISHES for why
        // 'tool-calls' is in and 'length'/'content-filter' are out). Without
        // this gate the retry would mask real stop reasons behind
        // 'empty_response'.
        const orderlyFinish = step.finishReason === undefined
          || ORDERLY_EMPTY_FINISHES.has(step.finishReason);
        if (isEmptyStep && orderlyFinish) {
          consecutiveEmptySteps++;
          if (consecutiveEmptySteps === 1) {
            // Withdraw any preparing card the dead step left on screen — the
            // 'tool-calls' empty shape (announced call, dropped as malformed)
            // almost always put one up. The step re-runs INSIDE the same turn,
            // so endTurn's reaping never fires and the orphan would spin beside
            // the retry's own cards until the turn ends. (Same reason the
            // manual-Retry and stall-retry paths withdraw theirs; the
            // empty_response break below needs no withdrawal — the turn ends
            // there and endTurn reaps.)
            this.withdrawOrphanedPreparing(step.pendingPreparing);
            // One structured log line so the silent retry is diagnosable from
            // ~/.claude/desktop.log (console.error reaches nobody in a packaged
            // build) — deliberately NOT a transcript event (emit surface frozen).
            log('WARN', 'HarnessSession', 'empty step (no text, no tool calls) — retrying once', {
              sessionId: this.opts.sessionId, finishReason: step.finishReason ?? 'undefined',
            });
            continue turnLoop;
          }
          // Second consecutive empty step: an orderly completion with an honest
          // reason. Set HERE, not in mapStopReason — 'empty_response' is a
          // loop-level judgment about two steps, not a mapping of one
          // provider finishReason.
          stopReason = 'empty_response';
          break;
        }
        consecutiveEmptySteps = 0;   // any real step re-arms the single retry

        if (step.toolCalls.length === 0) {
          // Natural stop. finishReason 'length' (truncated output, including a
          // truncated tool-call) collapses to 'max_tokens' via mapStopReason.
          stopReason = mapStopReason(step.finishReason);
          break;
        }

        // Emit ALL of this step's tool-use events FIRST (one per call, in order),
        // THEN execute serially — so the persisted event stream mirrors the
        // STEP-GROUPED history we push below (assistant[text?, c1, c2] then
        // tool[r1, r2]). If we interleaved use→result→use→result instead,
        // rebuildHistory (pure event-adjacency, Task 10) would wrongly split a
        // multi-call step into assistant[c1]/tool[r1]/assistant[c2]/tool[r2] and
        // NO longer deep-equal live history — and a textless second call would be
        // indistinguishable from a new step. Renderer impact is benign: all tool
        // cards appear up front, results attach by toolUseId (CC's parallel-call
        // behavior). The frozen emit surface is untouched — same event types and
        // fields, only intra-step ordering changes.
        // ROADMAP L241: a step can hold BOTH a real tool call and an
        // announced-then-dropped one (a malformed second call). The empty-step
        // retry above is the only place that used to withdraw an orphan, and
        // endTurn's reaping only runs at turn end — so on this path the dead
        // "Preparing…" card span beside real tool execution for the rest of the
        // turn. Withdraw before the live cards go up, so the orphan never
        // shares the screen with them.
        this.withdrawOrphanedPreparing(step.pendingPreparing);

        for (const call of step.toolCalls) {
          this.emitEvent('tool-use', { toolUseId: call.toolCallId, toolName: call.toolName, toolInput: call.input });
        }

        // Execute tool calls SERIALLY; collect their results for the next step.
        const resultParts: any[] = [];
        for (let i = 0; i < step.toolCalls.length; i++) {
          const call = step.toolCalls[i];
          const payload = await this.runOneTool(call, recentCalls);   // NEVER throws
          if (payload === 'interrupted') {
            // Interrupt during a permission ask. Back-fill canceled tool-results
            // for THIS call AND every remaining un-executed call in the step
            // (earlier calls already have real results in resultParts + emitted
            // events). Every call's tool-use event was already emitted up front,
            // so each still gets a matching tool-result event here. Without this,
            // the assistant(tool-call) message has no matching tool message — a
            // dangling tool_call that provider APIs hard-reject (HTTP 400) on the
            // NEXT send, bricking the session (the bad message persists in history
            // across sends). CC does the same canceled back-fill. The synthesized
            // tool-result events keep the persisted transcript in agreement with
            // the model-facing history.
            for (let j = i; j < step.toolCalls.length; j++) {
              const rem = step.toolCalls[j];
              this.emitEvent('tool-result', { toolUseId: rem.toolCallId, toolName: rem.toolName, toolResult: CANCELED_TOOL_TEXT, isError: true });
              resultParts.push(this.toolResultPart(rem, CANCELED_TOOL_TEXT));
            }
            this.history.push({ role: 'tool', content: resultParts });
            this.emitEvent('user-interrupt', {});
            return;
          }
          // The user dismissed a question → end the turn ORDERLY. Record THIS
          // call's real result, then mark every remaining un-executed call in the
          // step as not-run (same dangling-tool_call hazard the interrupt branch
          // above guards against). `turn-complete` rather than `user-interrupt`
          // on purpose: usage should be reported, and anything the user queued
          // while the turn ran should drain — typing during the turn IS taking
          // over. The max_steps gate below is the existing precedent for a
          // driver-decided orderly stop.
          if ('kind' in payload) {
            this.emitEvent('tool-result', {
              toolUseId: call.toolCallId, toolName: call.toolName,
              toolResult: payload.payload.text, isError: true,
            });
            resultParts.push(this.toolResultPart(call, payload.payload.text));
            for (let j = i + 1; j < step.toolCalls.length; j++) {
              const rem = step.toolCalls[j];
              this.emitEvent('tool-result', { toolUseId: rem.toolCallId, toolName: rem.toolName, toolResult: NOT_RUN_TOOL_TEXT, isError: true });
              resultParts.push(this.toolResultPart(rem, NOT_RUN_TOOL_TEXT));
            }
            this.history.push({ role: 'tool', content: resultParts });
            stopReason = DISMISSED_STOP_REASON;
            break turnLoop;
          }
          // Turn the tool's promised image paths into deliverable parts, charging
          // the per-turn budget/dedupe and amending the text with a named note
          // for every skip (Task 5 — the driver never promises silently).
          const delivered = this.resolveToolImages(payload, imageBudget);
          this.emitEvent('tool-result', {
            toolUseId: call.toolCallId, toolName: call.toolName,
            toolResult: delivered.text, isError: payload.isError ?? false,
            ...(payload.structuredPatch ? { structuredPatch: payload.structuredPatch } : {}),
            // Paths only — events carry no binary; resume re-reads (history-rebuild.ts).
            ...(delivered.images.length ? { images: delivered.images.map((i) => i.path) } : {}),
          });
          resultParts.push(this.toolResultPart(call, delivered.text, delivered.images));
        }
        this.history.push({ role: 'tool', content: resultParts });
        // Path-triggered content (M3 item 3): a project rule or a nested
        // AGENTS.md/CLAUDE.md governing a path this step just touched. Appended
        // AFTER the tool results so the model reads the rule alongside what it
        // just learned, and before it decides the next step.
        this.injectPathTriggers(step.toolCalls);

        stepsSinceApproval++;
        // Budget gate (spec §2.4) — surfaces as a permission ASK, not a new
        // event. Allow resets the counter and continues; anything else ends the
        // turn with stopReason 'max_steps'; canceled is an interrupt.
        if (maxSteps !== undefined && stepsSinceApproval >= maxSteps) {
          const d = await this.opts.askUser?.({ sessionId: this.opts.sessionId, toolName: 'max_steps', toolInput: { steps: stepsSinceApproval }, denyListed: false });
          if (d?.behavior === 'canceled') { this.emitEvent('user-interrupt', {}); return; }
          if (d?.behavior !== 'allow') { stopReason = 'max_steps'; break turnLoop; }
          stepsSinceApproval = 0;
        }
      }

      // Denominator is GENERATION time, not the turn's wall-clock. Falls back to
      // wall-clock only when no step ever produced output, where the ratio is 0
      // either way and the fallback just avoids dividing by zero.
      const seconds = Math.max((generationMs || (Date.now() - startedAt)) / 1000, 0.001);
      // Hoisted out of the emit below so the same number can be checked against
      // the provider's own before it ships.
      const costUsd = this.opts.free ? null : costForUsage(turnUsage, this.opts.pricing);
      // Published ONLY when every counted step reported one — see the counters'
      // declaration for why a partially-covered turn reports nothing.
      const providerCostUsd = stepsCounted > 0 && stepsWithProviderCost === stepsCounted
        ? turnProviderCostUsd
        : undefined;
      // Our arithmetic, checked against the only authority there is. This is a
      // DIAGNOSTIC line in ~/.claude/desktop.log and nothing else: a gap is a
      // bug for us to fix, not something to put in front of a user, so no
      // transcript event and no UI. `costDisagreement` returns null — never a
      // number — whenever there is nothing honest to compare (no provider
      // figure, no rate card of ours, or a bill too small for the ratio to
      // mean anything), so silence here is never a claim that the two agreed.
      // The message states only what was observed; it names no cause, because
      // none has been established (docs/error-message-standards.md).
      const costGap = costDisagreement(costUsd, providerCostUsd);
      if (costGap !== null && costGap > COST_DISAGREEMENT_THRESHOLD) {
        log('WARN', 'HarnessSession', 'our cost figure and the provider\u2019s own disagree for this turn', {
          sessionId: this.opts.sessionId,
          model: this.binding.modelId,
          ourCostUsd: costUsd,
          providerCostUsd,
          relativeGap: Number(costGap.toFixed(4)),
        });
      }
      // ...and the same comparison across the whole session (Task 30). The
      // per-turn line above localises a fault to ONE turn but is silent
      // forever on a cheap model, where a whole turn costs a third of the
      // floor; these sums cross the floor after a handful of turns, so a
      // systematic pricing error finally becomes visible. Only turns that had
      // BOTH figures are in either sum, so a session that mixed a reporting
      // provider with a silent one never puts part of a bill next to all of
      // our arithmetic. Same rules as above: diagnostic only, no UI, and the
      // message states what was observed without naming a cause.
      this.sessionCostTotals = addComparableTurn(this.sessionCostTotals, costUsd, providerCostUsd);
      const sessionCostGap = sessionCostDisagreement(this.sessionCostTotals);
      // Logged the first time the sums cross the threshold, and again only once
      // the gap has multiplied since the last line — see the field and
      // COST_GAP_RELOG_FACTOR for why neither "every turn" nor "once, ever" is
      // safe here.
      if (sessionCostGap !== null && sessionCostGap > COST_DISAGREEMENT_THRESHOLD
          && (this.lastLoggedSessionCostGap === null
              || sessionCostGap >= this.lastLoggedSessionCostGap * COST_GAP_RELOG_FACTOR)) {
        this.lastLoggedSessionCostGap = sessionCostGap;
        log('WARN', 'HarnessSession', 'our cost figures and the provider\u2019s own disagree across this session', {
          sessionId: this.opts.sessionId,
          // The LATEST turn's model, not "the model these totals are for": a
          // session can swap models mid-flight, so the sums may span several.
          modelOfLatestTurn: this.binding.modelId,
          comparableTurns: this.sessionCostTotals.turns,
          ourCostUsd: this.sessionCostTotals.ourUsd,
          providerCostUsd: this.sessionCostTotals.theirUsd,
          relativeGap: Number(sessionCostGap.toFixed(4)),
        });
      }
      this.emitEvent('turn-complete', {
        model: this.binding.modelId,
        stopReason,
        // Carry the session's REAL context window (Task 4/5) on the usage payload so
        // the renderer's StatusBar can compute context % without a separate IPC. It's
        // a session constant, but co-locating it with per-turn usage keeps the whole
        // native-chip payload on one existing event (Task 12). null when unknown.
        usage: {
          ...turnUsage,
          tokensPerSecond: Math.round(turnUsage.outputTokens / seconds),
          contextLength: this.opts.contextLength ?? null,
          // How full the window actually is — NOT the same as turnUsage (see the
          // lastOutputTokens declaration). Falls back to a chars/4 estimate when
          // the provider reports nothing, so a server that ignores
          // stream_options still drives a roughly-right gauge instead of
          // reporting an empty window forever.
          contextUsedTokens: lastInputTokens > 0
            ? lastInputTokens + lastOutputTokens
            : this.estimateContextTokens(),
          // Priced HERE, where the model that ran this turn is known. A
          // mid-session swap re-resolves opts.pricing, so already-counted turns
          // keep the price they actually ran at (spec §5).
          //
          // `free` WINS over any rate card (Task 22): the two facts are
          // resolved from different sources — the provider type says free, the
          // catalog says the price — and nothing else stopped them
          // contradicting each other. A local-engine binding whose model id
          // happens to carry a published rate would otherwise ship
          // {"costUsd": 7, "free": true}: a turn billed $7 that also cost
          // nothing to run. Free means free; a bill is never stamped on it.
          costUsd,
          // Reported separately from costUsd because "free to run" and "no
          // published price" are different facts with different wording — see
          // the field comment in shared/types.ts. Defaults to false: never
          // claim a turn was free without having established it.
          free: this.opts.free ?? false,
          // Spread, so a turn the provider said nothing about carries no key at
          // all. A `providerCostUsd: 0` would read as "the provider agrees this
          // was free", which is the exact confusion pricing.ts exists to
          // prevent — and it would be wrong for every non-OpenRouter provider,
          // which is most of them.
          ...(providerCostUsd === undefined ? {} : { providerCostUsd }),
        },
      });
    } catch (err: any) {
      // v0's catch, unchanged: push any in-flight partial, then split
      // interrupt vs error. withRetry has already exhausted retries for a
      // transient provider error before it lands here.
      if (partialAssistantText) this.history.push({ role: 'assistant', content: partialAssistantText });
      if (this.interrupted || err?.name === 'AbortError' || this.abort?.signal.aborted) {
        this.emitEvent('user-interrupt', {});
      } else {
        this.emitEvent('session-error', { text: describeProviderError(err) });
      }
    } finally {
      this.abort = null;
    }
  }

  /** Consume ONE step's stream. Emits assistant-text / assistant-thinking deltas
   *  as they arrive, collects tool-calls + usage, and returns the step result.
   *  Throws on an 'error' stream part or a rejected result promise (→ withRetry).
   *  reportPartial receives the running assistant text so send()'s catch can push
   *  the in-flight partial if the step later throws. */
  private async consumeStep(
    model: LanguageModel,
    aiTools: Record<string, any>,
    reportPartial: (text: string) => void,
  ): Promise<StepResult> {
    // Attempt 0 stalls with nothing streamed → runStreamOnce returns
    // STALL_RETRY → we re-run. That AUTOMATIC retry is available once per step:
    // every attempt after the first passes isFirstAttempt=false, so a later
    // silent stall never re-runs behind the user's back. What it does instead
    // is decided by the park guard in armWatchdog, which parks when EITHER of
    // these is true:
    //   - this attempt streamed something before going quiet (sawFirstChunk) —
    //     Clock 2, and it does NOT matter whether the turn parked before; or
    //   - the turn has already parked once (turnEverParked), which is what
    //     stops a manually-retried step from dying on the first-byte clock.
    // Neither true → Clock 1 alone, and the turn still ends with the
    // "didn't begin responding" error.
    // The loop is no longer bounded at two iterations — a MANUAL Retry also
    // returns STALL_RETRY, and the user may press it as often as they like.
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.runStreamOnce(model, aiTools, reportPartial, attempt === 0);
      if (outcome !== STALL_RETRY) return outcome;
      // Re-running after EITHER a silent stall (nothing streamed) or a manual
      // Retry (content streamed, then erased via dropPart): clear the on-screen
      // stall warning back to a plain "Thinking" heartbeat so the countdown
      // doesn't linger at 0 while the fresh stream spins up.
      this.emitEvent('assistant-thinking', {});
    }
  }

  /** Consume ONE stream attempt with an inactivity watchdog. Returns a normal
   *  StepResult, or the STALL_RETRY sentinel when the stream went silent past
   *  the countdown with nothing streamed on a first attempt (caller re-runs).
   *  Throws StreamStallError when a stall isn't safely retryable. */
  private async runStreamOnce(
    model: LanguageModel,
    aiTools: Record<string, any>,
    reportPartial: (text: string) => void,
    isFirstAttempt: boolean,
  ): Promise<StepResult | typeof STALL_RETRY> {
    const streamArgs: any = {
      model,
      system: this.systemText,
      // Wire adaptation runs on the FITTED view, per request, not once at push
      // time — this is what closes the mid-session model-swap leak: an image
      // pushed to history under a vision model is stripped here at build time
      // if the NEXT request targets a model that can't carry or can't see it,
      // rather than riding along stale from whenever it was written.
      messages: adaptForWire(this.fitToContext(this.history), {
        nativeImageToolResults: this.profile.nativeImageToolResults,
        supportsVision: this.profile.supportsVision,
      }),
      maxOutputTokens: this.opts.harness.limits?.maxTokens,
      abortSignal: this.abort!.signal,
      // Fix (2026-08-10 incident): streamText's DEFAULT onError is
      // `({ error }) => console.error(error)` — Node's console.error on a raw
      // Error/object prints its FULL shape (stack, statusCode, responseBody,
      // and responseHeaders — which can include a set-cookie value) as a
      // multi-line dump. That is exactly what the live roster run's CLI
      // printed to the console for an OpenRouter 402: dozens of lines where
      // one would do. describeProviderError() already extracts the real,
      // bounded, actionable detail from ANY error shape (see below) — reuse
      // it here so a stream failure logs ONE legible line instead of the
      // SDK's raw dump. Not silenced: the failure is still visible, and the
      // SAME error still reaches session-error via the 'error' case below.
      onError: ({ error }: { error: unknown }) => {
        console.error(`[harness] stream error: ${describeProviderError(error)}`);
      },
    };
    // Only pass tools when there are any — keeps the no-tools path byte-identical
    // to v0 (no tool plumbing reaches the SDK).
    if (Object.keys(aiTools).length > 0) streamArgs.tools = aiTools;
    const result = streamText(streamArgs);

    let assistantText = '';
    let outputChars = 0;
    const toolCalls: ToolCall[] = [];
    let interrupted = false;
    // Any delta/tool-call this attempt means a retry would DUPLICATE output, so
    // a later stall must fail rather than re-run.
    let emittedAny = false;

    // Consume the stream via an explicit iterator raced against the abort
    // signal. A plain `for await` blocks forever if the underlying provider
    // stream stops emitting without honoring the abort — racing guarantees
    // interrupt() always ends the turn (covers thrown-AbortError AND stream-hang).
    const iterator = (result.fullStream as AsyncIterable<any>)[Symbol.asyncIterator]();
    const abortSignal = this.abort!.signal;
    const abortPromise = new Promise<'aborted'>((resolve) => {
      if (abortSignal.aborted) resolve('aborted');
      else abortSignal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });

    // Inactivity watchdog, raced alongside each chunk read. Stage 1 (silence for
    // STALL_WARNING_MS) emits the stall-warning heartbeat that drives the UI
    // countdown; stage 2 (a further STALL_RETRY_COUNTDOWN_MS of silence) resolves
    // the race with 'stall'. Re-armed on every real chunk so it fires ONLY on a
    // genuinely silent stream — an actively-streaming reasoning model never trips it.
    const warnMs = this.opts.stallWarningMs ?? STALL_WARNING_MS;
    const countdownMs = this.opts.stallCountdownMs ?? STALL_RETRY_COUNTDOWN_MS;
    // PREFILL vs MID-STREAM: until the first chunk arrives the model is reading the
    // prompt, which on a local model legitimately takes minutes. Only once tokens
    // have started does a 60s gap mean something is actually wrong. A test that
    // pins its own stallWarningMs opts out of the scaling and keeps its exact timing.
    // Binary-aware: JSON.stringify on a Buffer is ~4-5 chars per BYTE, so an image
    // turn reported a ~700x inflated prompt-token count to the user.
    const promptTokens = messagesTokens(streamArgs.messages as ModelMessage[])
      + Math.ceil(this.systemText.length / APPROX_CHARS_PER_TOKEN);
    // How much of that is genuinely NEW work. llama.cpp reuses the cached prefix,
    // so a step that appends a 100 KB tool result only prefills the tool result —
    // reporting the whole context would wildly overstate the wait. A SHRINKING
    // total means compaction rewrote history, which invalidates the cached prefix,
    // so that step really is a full prefill again.
    const newTokens = this.lastStepPromptTokens > 0 && promptTokens >= this.lastStepPromptTokens
      ? promptTokens - this.lastStepPromptTokens
      : promptTokens;
    this.lastStepPromptTokens = promptTokens;
    // The BUDGET deliberately scales on the TOTAL, not the increment: cache reuse
    // is an optimistic assumption (a busy slot can evict it), and being generous
    // here only risks a late stall report, whereas being tight risks resurrecting
    // the false "model stopped responding" this whole change exists to kill.
    const firstChunkMs = this.opts.prefillWarningMs ?? this.opts.stallWarningMs ?? prefillBudgetMs(promptTokens);
    // Name what is actually being read, so the copy is true at any step. After a
    // tool call the new context IS the tool output — "your prompt" would be plain
    // wrong there (Destin, 2026-07-26).
    const lastMsg = (streamArgs.messages as ModelMessage[])[streamArgs.messages.length - 1];
    const source: 'prompt' | 'tool-output' = lastMsg?.role === 'tool' ? 'tool-output' : 'prompt';
    this.prefillSource = source;
    this.lastPrefillEmitAt = 0;   // fresh throttle window per step
    let sawFirstChunk = false;
    let firstChunkAt = 0;   // when generation actually began (see StepResult.generationMs)
    let warned = false;
    let parked = false;
    let stageTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveStall: (v: 'stall') => void;
    const stallPromise = new Promise<'stall'>((resolve) => { resolveStall = resolve; });
    // Manual-retry racer — a SEPARATE signal from abortSignal on purpose: abort
    // ends the whole turn, which is the opposite of what Retry means.
    let signalRetry!: () => void;
    const retryPromise = new Promise<'retry'>((resolve) => { signalRetry = () => resolve('retry'); });
    const armWatchdog = () => {
      clearTimeout(stageTimer);
      stageTimer = setTimeout(() => {
        warned = true;
        // willRetry: safe to silently re-run only when nothing COUNTABLE has
        // streamed (text, reasoning, or a completed tool call — see the
        // `!emittedAny` expression this mirrors) AND this is the first
        // attempt. Argument fragments deliberately don't count: a stall
        // mid-tool-arguments still qualifies even though real bytes arrived.
        // When false, the guard below decides what happens instead: a PARK
        // once a real chunk has arrived this attempt (sawFirstChunk) or the
        // turn has already parked once (turnEverParked) — otherwise (nothing
        // has arrived THIS attempt, and the turn never parked) the countdown
        // still ends the turn with a session-error.
        const willRetry = !emittedAny && isFirstAttempt;
        this.emitEvent('assistant-thinking', { stallWarning: { retryInMs: countdownMs, willRetry } });
        stageTimer = setTimeout(() => {
          // PARK — but ONLY when `!willRetry` (the auto-retry guard above
          // didn't already claim this stall) AND EITHER a real chunk has
          // arrived this attempt (sawFirstChunk) or the turn has already
          // parked once (turnEverParked: the user was shown the card and hit
          // Retry, so that retry must never die on its own even if it lands
          // back on a silent attempt). Note willRetry checks emittedAny, not
          // sawFirstChunk: a FIRST-attempt stall after nothing but tool-
          // argument fragments has sawFirstChunk===true (real bytes did
          // arrive) but still takes the auto-retry branch above instead of
          // parking here, because nothing COUNTABLE was emitted. Only once
          // willRetry is false — attempt 2+, or something countable already
          // streamed — does sawFirstChunk alone decide: real bytes THIS
          // attempt → park; a genuinely silent attempt (sawFirstChunk still
          // false) with a turn that never parked before stays OUT OF SCOPE
          // for this project: a model that never sent a first byte hasn't
          // "stalled" the way this feature means it, it just never began, so
          // the turn still ends with the "didn't begin responding" session-error.
          // Do NOT resolve the stall race for the park case: nothing is torn
          // down, the reader stays open, and a chunk arriving minutes later
          // still lands in the loop below and continues the turn. This
          // return IS the feature.
          //
          // EXCEPT for a specialist child (Fix, C1 whole-branch review,
          // 2026-08-16): a parked child has no UI to park INTO. wireChildLive
          // re-emits only SUBAGENT_DISPLAY_TYPES (tool-use/tool-result/
          // assistant-text) into the parent's view — the parked signal rides
          // `assistant-thinking`, which is filtered out, so a stalled child
          // shows no card, no red dot, no Retry, no Stop, just a spinning
          // Agent card forever. Worse: the child's send() never settles, so
          // the parent's Task tool call never returns, and nothing else caps
          // a specialist run — the parent hangs too, invisibly. Falling
          // through to the ordinary stall path below lets the child keep
          // throwing StreamStallError, which the parent's Task tool already
          // catches and reports as a failed run — the exact recovery this
          // branch removed for children. Surfacing the stalled card inside
          // the parent's own Agent card is a real feature; it is deliberately
          // not attempted here.
          if (!this.opts.isSpecialistChild && (sawFirstChunk || this.turnEverParked) && !willRetry) {
            parked = true;
            this.turnEverParked = true;
            this.resolveRetry = signalRetry;
            this.emitEvent('assistant-thinking', { stalled: true });
            return;
          }
          resolveStall('stall');
        }, countdownMs);
      }, sawFirstChunk ? warnMs : firstChunkMs);
    };
    this.rearmStallWatchdog = armWatchdog;
    // Tell the UI the model is READING, not hanging. Without this the user stares
    // at an idle spinner for minutes with nothing to distinguish it from a hang —
    // which is exactly what made the false stall so alarming. Gated on prompt size
    // so ordinary turns keep their existing event sequence exactly.
    // Gate on the NEW tokens: a step that adds almost nothing to a huge cached
    // context returns instantly and needs no explanation, however big the total.
    // AND on the provider: this whole affordance exists for local prefill, which
    // is a minutes-long silence on the user's own hardware. A hosted model
    // reaches first token in seconds and reports no progress to upgrade the
    // notice with, so on cloud it was pure noise in place of the ordinary
    // spinner (Destin, 2026-08-16). See CapabilityProfile.announcePrefill.
    if (this.profile.announcePrefill && newTokens >= PROMPT_PROCESSING_NOTICE_TOKENS) {
      this.emitEvent('assistant-thinking', {
        promptProcessing: { promptTokens: newTokens, budgetMs: firstChunkMs, source },
      });
    }
    armWatchdog();

    // Argument-generation progress, keyed by the provider's tool call id. Per
    // STEP, not per session: a retry re-enters this function with a fresh map.
    // Display-only — the card the renderer draws from this never reaches disk.
    const preparing = new Map<string, { toolName: string; chars: number; lastEmitAt: number }>();
    // Every streaming part id THIS attempt has written. A manual Retry hands
    // these to the renderer and the store so the abandoned text is removed
    // rather than appended to.
    const emittedPartIds = new Set<string>();

    try {
      while (true) {
        const nextPromise = iterator.next();
        const chunk = await Promise.race([nextPromise, abortPromise, stallPromise, retryPromise]);
        if (chunk === 'aborted') {
          // The abort won the race; swallow the pending read's late rejection and
          // release the underlying reader/socket (a provider that IGNORES the abort
          // would otherwise leak it until GC — the exact case this race exists for).
          nextPromise.catch(() => {});
          iterator.return?.().catch(() => {});
          this.interrupted = true;
          interrupted = true;
          break;
        }
        if (chunk === 'retry') {
          // Manual Retry from the stalled card. Same teardown as the stall path
          // — the reader really is dead this time, the user said so.
          nextPromise.catch(() => {});
          iterator.return?.().catch(() => {});
          void Promise.resolve(result.usage).catch(() => {});
          void Promise.resolve(result.finishReason).catch(() => {});
          this.resolveRetry = null;
          // Retract the erased text from the model's own memory, not just the
          // screen: partialAssistantText is reset per STEP (not per attempt), so
          // without this, a re-run that throws before emitting anything would
          // leave send()'s catch pushing the ABANDONED half-sentence — text the
          // user just watched get erased via dropPart — silently back into
          // this.history as an assistant message.
          reportPartial('');
          // Withdraw any preparing card: the step re-runs INSIDE the same turn,
          // so endTurn's reaping never fires and the card would spin forever
          // beside the one the re-run mints. (Same reason as the auto-retry path.)
          for (const [prepId, entry] of preparing) {
            this.emitEvent('assistant-thinking', {
              toolPreparing: { toolCallId: prepId, toolName: entry.toolName, chars: entry.chars, cleared: true },
            });
          }
          // Erase what the abandoned attempt put on screen BEFORE re-running.
          if (emittedPartIds.size > 0) {
            this.emitEvent('assistant-thinking', { dropPart: { partIds: [...emittedPartIds] } });
          }
          return STALL_RETRY;
        }
        if (chunk === 'stall') {
          // No chunk for the full warn+countdown window. Release the dead reader
          // (same teardown as the abort path), then retry-or-fail. Cancelling the
          // reader can reject the terminal promises with nothing awaiting them —
          // swallow so they don't surface as unhandled rejections.
          nextPromise.catch(() => {});
          iterator.return?.().catch(() => {});
          void Promise.resolve(result.usage).catch(() => {});
          void Promise.resolve(result.finishReason).catch(() => {});
          if (!emittedAny && isFirstAttempt) {
            // The step re-runs INSIDE the same turn, so endTurn's reaping never
            // fires. Withdraw any preparing card explicitly or it spins for the
            // rest of the turn while the retry mints a second card beside it.
            for (const [prepId, entry] of preparing) {
              this.emitEvent('assistant-thinking', {
                toolPreparing: { toolCallId: prepId, toolName: entry.toolName, chars: entry.chars, cleared: true },
              });
            }
            return STALL_RETRY;
          }
          // Name the phase honestly: a model that never STARTED (prefill) has not
          // "stopped responding", and telling the user it did sends them chasing a
          // provider fault that isn't there.
          throw new StreamStallError(
            (sawFirstChunk ? warnMs : firstChunkMs) + countdownMs,
            sawFirstChunk ? 'streaming' : 'prefill',
            promptTokens,
          );
        }
        if (chunk.done) break;
        // A real chunk arrived → the model is past prefill, so every LATER gap is
        // judged by the strict mid-stream budget rather than the generous one.
        //
        // "Real" EXCLUDES the SDK's synthetic lifecycle parts. streamText emits
        // `start` about 8ms after the stream opens — before the provider has done
        // anything at all — and `start-step` likewise. Counting those flipped this
        // flag almost immediately, which abandoned the prefill budget on every
        // stream and left prompt processing judged by the strict 60s mid-stream
        // window. That is why the stall warning kept firing mid-prefill on a slow
        // local model even after the prefill budget was added (Destin, 2026-07-26):
        // the budget was never actually in force. Verified by logging fullStream
        // part timings against a mock that delays its first real part by 800ms.
        if (chunk.value?.type !== 'start' && chunk.value?.type !== 'start-step') {
          // Stamp the first REAL chunk: generation starts here. Everything before
          // it is prefill, and tok/s must not be diluted by it.
          if (!sawFirstChunk) firstChunkAt = Date.now();
          sawFirstChunk = true;
        }
        // A real chunk arrived → clear any shown warning/card and re-arm.
        if (warned || parked) {
          warned = false;
          parked = false;
          this.resolveRetry = null;
          this.emitEvent('assistant-thinking', {});
        }
        armWatchdog();
        const part = chunk.value;
        switch (part.type) {
          case 'text-delta': {
            const t = deltaText(part);
            if (!t) break;
            emittedAny = true;
            assistantText += t; outputChars += t.length;
            reportPartial(assistantText);
            // partId = the SDK's part id (fresh per streamText call). A tool-group
            // segment always separates consecutive text STEPS in the reducer, so a
            // repeated id across steps can't wrongly merge two bubbles.
            emittedPartIds.add(part.id ?? 'text-0');
            this.emitEvent('assistant-text', { text: t, partId: part.id ?? 'text-0' });
            break;
          }
          case 'reasoning-delta': {
            const t = deltaText(part);
            if (!t) break;
            emittedAny = true;
            outputChars += t.length;
            // assistant-thinking WITH data.text → the reducer's reasoning path;
            // payload-less would stay a heartbeat.
            emittedPartIds.add(part.id ?? 'reasoning-0');
            this.emitEvent('assistant-thinking', { text: t, partId: part.id ?? 'reasoning-0' });
            break;
          }
          case 'tool-input-start': {
            // The model has begun COMPOSING a tool call — nothing has executed.
            // Emitted unthrottled on purpose: this is the event that makes the
            // card appear, and every ms of delay here is visible generic-spinner
            // time, which is the entire problem this exists to fix.
            //
            // NOTE the field names: on fullStream this part is
            // { id, toolName } (TextStreamToolInputStartPart) — NOT the
            // { toolCallId, ... } UIMessageChunk variant of the same name.
            // `id` is the same string the completed 'tool-call' below carries as
            // toolCallId, which is what lets the card transition IN PLACE.
            const prepId = typeof part.id === 'string' ? part.id : '';
            const prepName = typeof part.toolName === 'string' ? part.toolName : '';
            if (!prepId || !prepName) break;
            preparing.set(prepId, { toolName: prepName, chars: 0, lastEmitAt: Date.now() });
            this.emitEvent('assistant-thinking', {
              toolPreparing: { toolCallId: prepId, toolName: prepName, chars: 0 },
            });
            break;
          }
          case 'tool-input-delta': {
            // Argument fragments. Counted for the card's liveness counter and
            // otherwise DISCARDED — the completed 'tool-call' part carries the
            // real parsed input, and buffering a second copy of a whole file
            // here would double the turn's peak memory for no gain.
            //
            // Deliberately does NOT set emittedAny: that flag gates whether a
            // stall may auto-retry, and flipping it here would disable the retry
            // for every turn whose stall lands mid-arguments. Nothing has
            // executed at that point, so re-running the step is exactly the safe
            // case the retry exists for.
            const deltaId = typeof part.id === 'string' ? part.id : '';
            const entry = preparing.get(deltaId);
            if (!entry) break;
            entry.chars += typeof part.delta === 'string' ? part.delta.length : 0;
            const nowMs = Date.now();
            if (nowMs - entry.lastEmitAt < TOOL_PREPARING_EMIT_MS) break;
            entry.lastEmitAt = nowMs;
            this.emitEvent('assistant-thinking', {
              toolPreparing: { toolCallId: deltaId, toolName: entry.toolName, chars: entry.chars },
            });
            break;
          }
          case 'tool-call':
            // input is the PARSED object here (streamText parses the raw JSON-string
            // args — verified ai@7 contract). Collected; executed by the loop.
            emittedAny = true;
            toolCalls.push({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
            break;
          case 'abort':
            // The SDK can surface an interrupt as a clean 'abort' part (instead of
            // a thrown AbortError). Mark it so the loop emits user-interrupt.
            this.interrupted = true;
            interrupted = true;
            break;
          case 'error':
            // Fix (2026-08-10 Kimi K3 incident): a fullStream 'error' part's
            // `.error` is NOT guaranteed to be an Error instance — the AI SDK
            // hands back whatever the provider layer produced. The old
            // fallback, `new Error(String(part.error))`, threw every useful
            // field away: String() on a plain object always yields the
            // literal text '[object Object]', which is exactly what reached
            // the user as the session's ENTIRE error message that day — a
            // real OpenRouter 402 ("This request requires more credits...")
            // whose statusCode/message/data were already sitting on the
            // object, just never read before being stringified into oblivion.
            // Preserve them instead: copy the object's own fields onto a real
            // Error (so downstream code that expects `instanceof Error` still
            // works, e.g. withRetry's statusCode-based retry check) rather
            // than collapsing it to a string first. describeProviderError()
            // (send()'s catch, below) already knows how to read
            // statusCode/responseBody/data/message off ANY shape.
            throw part.error instanceof Error
              ? part.error
              : (part.error && typeof part.error === 'object'
                ? Object.assign(new Error(), part.error as object)
                : new Error(String(part.error)));
        }
      }
    } finally {
      // Always release the watchdog timers — on done/throw/return alike.
      clearTimeout(stageTimer);
      // Stop late progress callbacks from re-arming a watchdog for a step that
      // has already ended (the tee outlives the iterator on an interrupt).
      this.rearmStallWatchdog = null;
      // A step that has ended can never be retried — drop the resolver so a
      // late click on a card the renderer has not torn down yet is a no-op.
      this.resolveRetry = null;
      // Fix (I3, whole-branch review 2026-08-16): `if (chunk.done) break;`
      // sits ABOVE the "a real chunk arrived → clear the card" block, so a
      // provider that closes the stream WHILE parked used to leave the red
      // card up (and the countdown label live) even though the turn keeps
      // going — reachable whenever the step had already emitted a complete
      // tool call before going silent (that sets emittedAny, which routes the
      // stall into a park instead of an auto-retry). Guaranteeing the
      // clearing heartbeat HERE, in the finally, covers every exit from a
      // parked state in one place (done/throw/interrupt alike) rather than
      // duplicating the same emit on each of them. A no-op when `parked` is
      // already false, which is every case except the one this fixes.
      if (parked) this.emitEvent('assistant-thinking', {});
    }

    if (interrupted || this.interrupted || abortSignal.aborted) {
      // Don't await usage/finishReason on the interrupt path — the stream was
      // torn down; those promises may never settle.
      return { text: assistantText, toolCalls, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, finishReason: undefined, interrupted: true, generationMs: firstChunkAt ? Date.now() - firstChunkAt : 0, pendingPreparing: [] };
    }

    const usage = await result.usage;
    // Sibling promise of result.usage. Carries OpenRouter's own dollar figure
    // for THIS request when the provider reported one; undefined otherwise.
    const providerCostUsd = providerCostFromMetadata(await result.providerMetadata);
    const finishReason = await result.finishReason;
    // `preparing` entries are NOT deleted when their call completes (the card
    // transitions in place under the same id), so filter by completed
    // toolCalls to find the truly orphaned ones. Empty in the common case.
    const pendingPreparing = [...preparing]
      .filter(([prepId]) => !toolCalls.some((c) => c.toolCallId === prepId))
      .map(([prepId, entry]) => ({ toolCallId: prepId, toolName: entry.toolName, chars: entry.chars }));
    return {
      text: assistantText,
      toolCalls,
      pendingPreparing,
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? Math.ceil(outputChars / APPROX_CHARS_PER_TOKEN),
        // v7 LanguageModelUsage exposes cache tokens under inputTokenDetails.
        cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
        cacheCreationTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
      },
      finishReason,
      interrupted: false,
      // Spread so a provider that reported nothing leaves the key ABSENT
      // rather than present-and-undefined — the turn accumulator counts
      // reporting steps, and "present but undefined" would muddy that.
      ...(providerCostUsd === undefined ? {} : { providerCostUsd }),
      generationMs: firstChunkAt ? Date.now() - firstChunkAt : 0,
    };
  }

  /** Run one tool call through the EXACT permission sequence (spec §2.1/§2.4):
   *  validate → doom-loop → guards → decide → (ask) → execute. NEVER throws —
   *  every failure mode is a tool RESULT the model can repair from, except a
   *  user cancel which returns the 'interrupted' sentinel, and a dismissed
   *  question which returns EndTurnResult — both let the loop unwind. */
  private async runOneTool(call: ToolCall, recentCalls: string[]): Promise<ToolResultPayload | 'interrupted' | EndTurnResult> {
    const tool = this.toolByName.get(call.toolName);
    if (!tool) return { text: `Unknown tool ${call.toolName}. Available: ${[...this.toolByName.keys()].join(', ')}.`, isError: true };

    // 1. Validate (zod) — invalid args are a RESULT the model repairs from, not
    //    a crash, and precede permissions (never ask about garbage).
    let parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success && typeof call.input === 'string') {
      // Weak-model hardening (Task 12, spec §3): the ai@7 SDK already parses a
      // provider tool-call's stringified args into an object for us (see
      // harness-sdk-toolcall-contract.test.ts), but a weak local model
      // sometimes puts its WHOLE args object as a STRING one level further in
      // — e.g. it emits `"{\"prompt\": ...}"` where a real object belongs. If
      // the raw string itself JSON.parses to an object, give it ONE recovery
      // attempt before falling back to the normal arg error — never a general
      // coercion layer (YAGNI: one attempt, then the ordinary failure path).
      try {
        const recovered: unknown = JSON.parse(call.input);
        if (recovered && typeof recovered === 'object') {
          const reparsed = tool.inputSchema.safeParse(recovered);
          if (reparsed.success) parsed = reparsed;
        }
      } catch { /* not JSON — fall through to the normal arg error below */ }
    }
    if (!parsed.success) {
      // Worded in arg-errors.ts (ledger D-2): names the unknown / missing /
      // mistyped parameter and, for an unknown one, the parameters that exist —
      // the strict schemas below make that the common case for CC-trained models.
      return { text: formatArgErrors(call.toolName, parsed.error, tool.inputSchema), isError: true };
    }
    const args = parsed.data;

    // G-1: per-turn BashOutput cap (D7) — checked AFTER validation so a
    // malformed call never spends a read, and BEFORE the doom loop, which it
    // replaces for this tool.
    if (call.toolName === 'BashOutput') {
      this.bashOutputReadsThisTurn += 1;
      if (this.bashOutputReadsThisTurn > BASH_OUTPUT_READS_PER_TURN) {
        return { text: `You have read background output ${BASH_OUTPUT_READS_PER_TURN} times this turn. Do NOT use this tool again without instruction from the user. Do NOT attempt to continuously poll for outputs — the finished notice arrives automatically.`, isError: true };
      }
    }

    // 2. Doom loop (BEFORE permissions — a stuck model shouldn't spam asks).
    //    `args` is parsed.data (zod-NORMALIZED), so the signature is canonical:
    //    two calls that differ only in JSON key order still count as identical.
    const sig = `${call.toolName}:${JSON.stringify(args)}`;
    // Window length = the profile's doom-loop threshold (Task 5): small local
    // models (threshold 2) trip sooner than cloud models (default 3). Trip when
    // the last `threshold` calls are all identical; an allow resets the window.
    // G-1: BashOutput never enters the window — see DOOM_LOOP_EXEMPT_TOOLS.
    const threshold = this.profile.doomLoopThreshold;
    if (!DOOM_LOOP_EXEMPT_TOOLS.has(call.toolName)) {
      recentCalls.push(sig);
      if (recentCalls.length > threshold) recentCalls.shift();
      if (recentCalls.length === threshold && recentCalls.every((s) => s === sig)) {
        const d = await this.opts.askUser?.({ sessionId: this.opts.sessionId, toolName: 'doom_loop', toolInput: { repeated: call.toolName }, denyListed: false });
        if (d?.behavior === 'canceled') return 'interrupted';
        // Threshold-accurate: the doom-loop window length varies by profile (2 for
        // small local models, 3 for cloud), so quote the ACTUAL threshold, not a
        // hardcoded "three". Model-facing corrective text, not a user-facing error.
        if (d?.behavior !== 'allow') return { text: `Stopped: this exact call has been repeated ${threshold} times. Try a different approach.`, isError: true };
        recentCalls.length = 0;   // allow resets the window
      }
    }

    // 2.5 Interactive tools (AskUserQuestion): the ask IS the execution. Skip
    //     guards/decide — there is no side effect to gate; the ask rail supplies
    //     pause/cancel semantics. The card's answers come back via updatedInput
    //     (broker passthrough), formatted here into the tool result. Kept BELOW
    //     the doom-loop check on purpose: a model re-asking the identical question
    //     three times IS a doom loop and should still trip.
    if (tool.interactive) {
      if (!this.opts.askUser) return { text: `No user-interaction handler is wired for this session; ${call.toolName} cannot run. This is a configuration error.`, isError: true };
      const d = await this.opts.askUser({ sessionId: this.opts.sessionId, toolName: call.toolName, toolInput: call.input as any, denyListed: false });
      if (d.behavior === 'canceled') return 'interrupted';
      // A HUMAN dismissal ENDS THE TURN: closing the card is the user taking the
      // turn back, not permission to guess. Still a real tool result so
      // call/result pairing holds — the loop stops right after recording it.
      // `dismissed` is stamped only by PermissionBroker.respond (see its WHY):
      // the OTHER askUser implementations are policies with no human behind
      // them, and for them a deny means "you may not ask, carry on and finish".
      if (d.behavior === 'deny' && d.dismissed) return { kind: 'end-turn', payload: { text: DISMISSED_TOOL_TEXT, isError: true } };
      if (d.behavior !== 'allow') return { text: REFUSED_ASK_TEXT, isError: true };
      return { text: formatAnswers(args as any, d.updatedInput) };
    }

    // 3. Tool-layer guards (below ALL configuration) — PATH-subject tools only.
    //    See NON_PATH_SUBJECT_TOOLS: Bash's subject is a command string and
    //    Skill's is a skill id; TodoWrite's is undefined and skipped by the
    //    `subject !== undefined` test.
    const subject = tool.permissionSubject(args);
    let externalAsk = false;
    if (subject !== undefined && !NON_PATH_SUBJECT_TOOLS.has(call.toolName)) {
      const verdict = checkPathGuard(subject, this.opts.cwd, this.opts.internalReadRoots);
      if (verdict.kind === 'deny') return { text: verdict.reason, isError: true };
      if (verdict.kind === 'external') {
        // Before raising the ask: did the model INVENT this outside path for a
        // file that actually lives in the workspace? (2026-08-16 stuck-session
        // investigation — a local model turned Glob's workspace-relative
        // "ROADMAP.md" into "/youcoded-dev/ROADMAP.md" and the turn hung on an
        // approval prompt for a location that exists nowhere.) Answering with
        // the real path is both more useful and less alarming than asking the
        // user to authorize fiction. Only fires for tools whose target must
        // pre-exist, only when the outside path is confirmed absent, and only
        // when the replacement is confirmed present INSIDE the cwd jail — so
        // it can never widen what the model may reach.
        const match = REQUIRES_EXISTING_TARGET.has(call.toolName)
          ? workspaceMatchFor(subject, this.opts.cwd, isExistingFile)
          : null;
        if (match !== null) {
          return {
            text: `${call.toolName} rejected: nothing exists at ${subject}, and that path is outside the workspace. `
              + `The file is at ${match} inside the workspace — retry with that path.`,
            isError: true,
          };
        }
        // A read tool looking outside the workspace no longer forces a card —
        // see READ_ONLY_PATH_TOOLS for why this is not a hole. Falling THROUGH
        // (rather than returning 'ok' early) is deliberate: decide() still runs
        // below, so an explicit deny/ask rule the user set for Read still wins,
        // and — because the ask is no longer synthetic — an "Always allow" on
        // one of those rule-driven asks is now a promise the engine can keep.
        if (!READ_ONLY_PATH_TOOLS.has(call.toolName)) {
          externalAsk = true;   // external_directory → force an ask (writes only)
        }
      }
    }

    // 4. Configured decision. An external-directory path forces 'ask' regardless
    //    of rules; otherwise consult decide() (default: ask — never silent-allow).
    const decision: PermissionDecision = externalAsk
      ? { action: 'ask', denyListed: false }
      : await (this.opts.decide?.(call.toolName, subject) ?? Promise.resolve<PermissionDecision>({ action: 'ask', denyListed: false }));
    // A deny may carry its own model-facing reason (PermissionDecision.message):
    // the specialist caps (child-permissions.ts) refuse with "not available to
    // this specialist" / "read-only charter", which tells the model what to do
    // instead. Without the reason a refused child reads the generic copy and
    // retries the identical call until its step budget is gone. The generic
    // sentence stays the default for every decide() that supplies no message.
    if (decision.action === 'deny') return { text: decision.message ?? `The ${call.toolName} call was blocked by a permission rule.`, isError: true };
    if (decision.action === 'ask') {
      // An ABSENT handler is a WIRING gap, not a user cancel — surface it as a
      // decline RESULT (the model can't proceed) instead of the 'interrupted'
      // sentinel, so a misconfiguration never masquerades as an ESC/interrupt.
      if (!this.opts.askUser) return { text: `No approval handler is wired for this session; the ${call.toolName} call cannot be approved. This is a configuration error.`, isError: true };
      // `external` tells the renderer this ask was forced by the path guard, so
      // ToolCard hides "Always allow" (see the guarded emit below for why).
      // `subject` (Task 11) is the SAME value the remember-rule emit below uses
      // as `pattern` — threaded through so a routed CHILD ask (child-ask-
      // router.ts, which has no other way to reach it) can persist the exact
      // same rule a root session's own remember-rule listener would.
      const d = await this.opts.askUser({ sessionId: this.opts.sessionId, toolName: call.toolName, toolInput: call.input as any, denyListed: decision.denyListed, external: externalAsk, subject });
      if (d.behavior === 'canceled') return 'interrupted';
      // Task 8: d.message carries specific copy for a deny that ISN'T a real
      // user decline — e.g. a routed specialist ask that timed out with no
      // answer (ASK_REDIRECT_MESSAGE), which must not read as "the user said
      // no" when no user ever answered. Falls back to the real-decline copy
      // (still accurate for an actual respond({behavior:'deny'})).
      if (d.behavior !== 'allow') return { text: d.message ?? 'The user declined this action. Ask what they would like instead, or try a different approach.', isError: true };
      // "Always allow" → emit a rule for the host to persist (PermissionStore).
      // Plain EventEmitter event, NOT a transcript event — the frozen emit
      // surface is untouched.
      //
      // Only remember when the decision came from decide(). An external-directory
      // path forced this ask and SKIPS decide() on every future call, so a stored
      // rule can never fire — recording one promises the user something the
      // engine will not honor. See spec 2026-08-11, finding 3.
      if (d.always && !externalAsk) {
        // The card sent a width, not a pattern — rememberedRuleFor derives the
        // rule here, in main. null means this command may not be remembered at
        // any width, so nothing is emitted.
        const rule = rememberedRuleFor(call.toolName, subject, d.grantScope);
        if (rule) this.emit('remember-rule', rule);
      }
    }

    // 5. Execute (defineTool owns truncation + the actionable-error catch).
    this.toolCallCount += 1;
    return tool.execute(args, {
      sessionId: this.opts.sessionId,
      cwd: this.opts.cwd,
      signal: this.abort!.signal,
      // Task 6/7: the Task tool's own call id, threaded through as
      // createChild's future parentToolCallId so the host can stamp the
      // child's display events with the launch card they belong under.
      toolCallId: call.toolCallId,
      // Task 14: this session's CURRENT binding — the `parent` fallback
      // resolveDelegatedBinding needs for a tier that isn't set (or a bare
      // "run on this conversation's model" request). Reads this.binding, not
      // opts.binding, so a mid-session setBinding() swap is reflected on the
      // very next tool call, same as every other live-state field here.
      binding: this.binding,
      readRegistry: this.readRegistry,
      servedReads: this.servedReads,      // G-11 re-read dedupe (see the field's WHY)
      toolCallIndex: this.toolCallCount,
      shellCwd: this.shellCwd ?? this.opts.cwd,
      setShellCwd: (next: string) => {
        this.shellCwd = next;
      },
      shellEnv: this.shellEnv ?? {},
      setShellEnv: (next: Record<string, string>) => {
        this.shellEnv = next;
      },
      // G-1: the session's shell registry (host-owned — see
      // NativeSessionHost.shellsFor). Spread so an unwired session leaves
      // ctx.shells genuinely absent rather than explicitly undefined.
      ...(this.opts.shells ? { shells: this.opts.shells } : {}),
      todos: this.todos,
      supportsVision: this.profile.supportsVision,
      ...(this.opts.toolServices ? { services: this.opts.toolServices } : {}),
    });
  }

  /** Exponential backoff for transient provider errors (429/5xx/network),
   *  honoring retry-after. Layers ON TOP of the SDK's internal retry (this is
   *  step-level resilience). Exhaustion rethrows → the session-error path. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const delays = this.retryDelays;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const status = err?.statusCode ?? err?.status;
        const retryable = status === 429 || (status >= 500 && status < 600) || err?.code === 'ECONNRESET';
        if (!retryable || attempt >= delays.length || this.abort?.signal.aborted) throw err;
        const ra = Number(err?.responseHeaders?.['retry-after']) * 1000;
        await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? ra : delays[attempt]));
      }
    }
  }

  interrupt(): void {
    this.interrupted = true;
    this.abort?.abort();
  }

  /** Manual Retry from the stalled card. Re-runs the PARKED step — it does not
   *  re-send the user's message, so every completed tool call and its result
   *  earlier in this turn stays exactly where it is.
   *
   *  Returns false when nothing is parked: the stream resumed between the click
   *  and this call, so the card is already gone and the click means nothing.
   *  That is the whole race guard — a parked step is either still listening
   *  (the resolver is live) or has moved on (the resolver is null). */
  retryStalledStep(): boolean {
    const resolve = this.resolveRetry;
    if (!resolve) return false;
    this.resolveRetry = null;
    resolve();
    return true;
  }

  /** Queue a mid-run course correction (spec §3). Drains as a history-only
   *  user message at the top of the NEXT turn-loop iteration — never
   *  mid-step, so an in-flight tool call is never cut. Returns whether a
   *  turn is actually in flight to receive it (`this.abort !== null` is the
   *  turn-in-flight invariant — set in beginTurn, nulled in its finally);
   *  when false, nothing is queued and the caller should record a missed
   *  steer itself (there is no turn for drainUnappliedSteers to report it
   *  against). */
  postSteer(text: string): boolean {
    const inFlight = this.abort !== null;
    if (inFlight) this.pendingSteers.push(text);
    return inFlight;
  }

  /** Steers that were queued but never drained into history — posted during
   *  a turn's FINAL step, after the last iteration-boundary check already
   *  ran. Empties the queue. A later task (6) folds this into the
   *  delegation ledger's missedSteers so a postSteer that returned `true`
   *  is still honestly reported as un-applied when the turn ended first. */
  drainUnappliedSteers(): string[] {
    return this.pendingSteers.splice(0);
  }

  destroy(): void { this.abort?.abort(); this.removeAllListeners(); }
}
