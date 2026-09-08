// Shared contracts for the native tool framework (spec §2.3). Every native tool
// implements NativeTool<A>; the driver (Task 9) owns validation + permission
// gating, and defineTool() (registry.ts) wraps execute with truncation + errors.
import type { z } from 'zod';
import type { StructuredPatchHunk, SpecialistRunView } from '../../../shared/types';
import type { CatalogModel, ModelBinding } from '../../../shared/provider-types';
import type { SpecialistDefinition } from '../specialists/registry';
import type { DelegatedModels } from '../specialists/delegated-models';
import type { ShellRegistry } from '../shell-registry';
import type { PlanView } from '../../../shared/types';
import type { PlanDocumentV1 } from '../plans/schema';

/** Task 6 — what the Task tool's execute() hands the host to actually run a
 *  specialist. Structural, mirroring the rest of ToolServices: the tool never
 *  imports NativeSessionHost, it only calls the callback the host injected. */
export interface SpecialistSpawnOpts {
  specialist: SpecialistDefinition;
  // Task 14 — the RESOLVED binding (already run through resolveDelegatedBinding
  // by tools/task.ts) to launch the child on. Absent means "no override was
  // requested" — createChild falls back to the parent's own binding, exactly
  // the pre-Task-14 behavior, so every caller that never resolves a model
  // keeps working unchanged.
  binding?: ModelBinding;
  prompt: string;
  workDir: string;
  parentToolCallId: string;
  // Task 1 (plan 1b) — the reservation this spawn is spending. spawnSpecialist
  // binds it to the real childId once createChild mints one (see
  // NativeSessionHost.bindReservation); the tool is what releases it, in its
  // own `finally`, once the spawn settles either way.
  token: SpecialistReservation;
  // Task 4 (plan 1b) — the Task tool's own per-call `description` argument
  // (a short label, e.g. "Find the auth bug"), threaded through so the ledger
  // record's `description` is the parent's real brief rather than the
  // specialist's static registered blurb — which is all spawnSpecialist could
  // fall back to before this field existed, and is useless in a background
  // completion's preamble ("the task you delegated (\"...\")").
  description: string;
  // Task 5 (plan 1c) — the model this run actually launched on, computed by
  // tools/task.ts from the SAME resolution that produced `binding` above
  // (absent here means "no binding was wired at all" — a bare test
  // construction, never a real session; see task.ts's own WHY). Threaded
  // through so the ledger record (and the run view the renderer reads) can
  // say what actually ran, not just what the parent's own conversation is on.
  model?: SpecialistRunView['model'];
}

/** Task 1 (plan 1b) — the receipt reserveSpecialist() hands back. Opaque to the
 *  tool beyond passing it to spawn() and release(): `childId` starts unset and
 *  is filled in by bindReservation() once the child exists, so a reservation
 *  that never reaches spawn (an early refusal) still releases cleanly. */
export interface SpecialistReservation {
  parentId: string;
  writer: boolean;
  childId?: string;
}

/** Task 6 — the outcome of steering or interrupting a specialist child by
 *  task_id. 'not-yours' covers BOTH "belongs to a different parent" and
 *  "doesn't exist at all" — deliberately indistinguishable to the caller, so
 *  the refusal can never be used to probe for another session's child ids
 *  (own-children-only, spec §5). `title`/`description` on 'ok' are the
 *  ledger's own recorded fields for that child (or the persisted header's
 *  title alone when no ledger is wired) — never invented, so the result can
 *  always say WHO it acted on without guessing. `agentType` on 'not-running'
 *  is what lets the caller (tools/task.ts) resolve the specialist's charter
 *  and size a fresh reservation's writer flag BEFORE calling
 *  resumeSpecialist — the same way a brand-new spawn sizes one from the
 *  resolved specialist. */
export type SpecialistManageOutcome =
  | { status: 'ok'; title: string; description?: string }
  | { status: 'not-yours' }
  | { status: 'not-running'; agentType: string };

/** Task 6 — the outcome of resuming a finished/interrupted specialist child
 *  by task_id. Two 'ok' shapes (never both) mirror spawn/spawnBackground's
 *  own split: 'ok' carries the report (the resumed run's tool result,
 *  foreground), 'ok-background' carries only the launch ack (the run
 *  continues detached, same as spawnBackground). 'not-yours'/'still-running'
 *  are a defense-in-depth re-check — tools/task.ts already confirmed
 *  ownership and non-live status via steerSpecialist before ever reaching
 *  here, but two Task calls racing the SAME task_id in one model turn can
 *  still hit either between that check and this one. */
export type SpecialistResumeOutcome =
  | { status: 'ok'; childId: string; report: string }
  | { status: 'ok-background'; childId: string; title: string }
  | { status: 'not-yours' }
  | { status: 'still-running' }
  /** D2 fix (review Critical): the definition FILE changed since this child was
   *  spawned, so resuming would run tools the user never approved. A resume
   *  carries no work_dir and therefore no permission subject, which means no
   *  consent card can render for it — refusing here is the only place this can
   *  be caught. The parent is told to hire again, which DOES go through a card. */
  | { status: 'definition-changed'; agentType: string };

// Runtime services injected into tools that need process-level collaborators
// (spec §3.2). WebSearch reads services.search — the chain-walking SearchService.
// Structural (not the concrete class) so tests inject fakes and the tool never
// imports the service implementation.
export interface ToolServices {
  search?: { search(query: string, signal: AbortSignal): Promise<{ results: Array<{ title: string; url: string; snippet?: string }>; source: string }> };
  /** Task 6 — the Task tool's host-side collaborators. Per-parent slot and
   *  single-writer state live on NativeSessionHost (spec §5 Global
   *  Constraints scope decision: PER-PARENT, never host-global), so the tool
   *  can only reach them through these injected callbacks — same pattern as
   *  `search` above. Absent on a session where the Task tool cannot possibly
   *  be attached (e.g. a specialist child); present whenever profile.canDelegate
   *  gates the tool on (harness-session.ts's syncTaskTool). */
  specialists?: {
    /** Task 1 (plan 1b) — reserve one of this parent's concurrent-specialist
     *  slots (the parent's resolved CapabilityProfile.maxConcurrentSpecialists
     *  ceiling, per-parent — see the Task 13 paragraph below; NOT the flat
     *  HOSTED_MAX_CONCURRENT_SPECIALISTS constant, which only the cloud/hosted
     *  layer of that profile actually uses) AND, for a
     *  writer request, the single-writer lock (spec §5: two concurrent
     *  write-capable children could race edits to the same files) — both in
     *  ONE synchronous call. Replaces 1a's tryReserveSlot/isWriterBusy pair:
     *  that split let a caller check isWriterBusy, then set the lock after an
     *  await elsewhere, which two parallel Task calls could both slip through.
     *  `ok: false` never spawns; a successful reservation MUST be paired with
     *  exactly one release() call, however the spawn turns out.
     *
     *  Task 13: the 'at-capacity' refusal carries `max`, the RESOLVED ceiling
     *  that was actually enforced (profile-derived for a local session, the
     *  flat hosted constant otherwise) — tools/task.ts renders it directly
     *  into the refusal copy so the number the model sees always matches the
     *  number that was checked, never a hardcoded constant that could read
     *  differently from what a local session's engine-measured cap allows. */
    reserve(parentId: string, opts: { writer: boolean }):
      { ok: true; token: SpecialistReservation }
      | { ok: false; reason: 'at-capacity'; max: number }
      | { ok: false; reason: 'writer-busy' };
    release(token: SpecialistReservation): void;
    /** Task 12, item 3 — spend one unit of this parent's LIFETIME spawn
     *  budget (SPECIALIST_SPAWN_BUDGET_PER_SESSION, specialists/limits.ts).
     *  false = budget exhausted, the caller must not spawn. Unlike
     *  reserve(), a spend is never released — it is a runaway-loop
     *  backstop, not a concurrency gate. */
    trySpendSpawnBudget(parentId: string): boolean;
    /** Mint + (eventually, Task 7) run the child, returning its final report. */
    spawn(parentId: string, opts: SpecialistSpawnOpts): Promise<{ childId: string; report: string }>;
    /** Task 4 — background execution. Resolves at LAUNCH (createChild + the
     *  ledger's 'running' row), not at completion: the run continues detached,
     *  and its eventual report (or typed failure) is injected into the
     *  parent's OWN conversation as a synthetic user-role turn at the next
     *  idle boundary (harness-session.ts's runNotice, driven from
     *  NativeSessionHost.runTurns) — never returned through this promise.
     *  Reservation-release ownership transfers to that detached chain the
     *  moment this call returns; ONLY a thrown launch (the promise rejects)
     *  means ownership never transferred, and the caller (tools/task.ts)
     *  still has to release. */
    spawnBackground(parentId: string, opts: SpecialistSpawnOpts): Promise<{ childId: string; title: string }>;
    /** Task 6 — steer a RUNNING child: queues `text` as a <steer> history line
     *  drained at its next turn-loop boundary (never mid-tool-call). A miss
     *  (no turn in flight right now) still returns 'ok' — the host records it
     *  to the delegation ledger's missedSteers instead of losing it, and a
     *  later resumeSpecialist call prepends it to the next brief. */
    steerSpecialist(parentId: string, childId: string, text: string): SpecialistManageOutcome;
    /** Task 6 — cancel a RUNNING child outright: aborts its in-flight stream
     *  via the same interrupt() path the Stop button uses, scoped to this ONE
     *  child (its own foreground/background caller still owns releasing its
     *  reservation once the aborted run unwinds — this does not release
     *  anything itself). */
    interruptSpecialist(parentId: string, childId: string): SpecialistManageOutcome;
    /** Task 6 — resume a FINISHED or INTERRUPTED own child: its state is
     *  rebuilt COLD from its own JSONL transcript (spec §2.5 — never carries
     *  live in-memory state across), then `opts.prompt` is delivered as its
     *  next brief exactly like a fresh spawn's first turn, foreground or
     *  background per `opts.background`. `opts.reservation` MUST be a fresh
     *  token from `reserve()` — a resumed child re-takes its concurrency slot
     *  (and, for a read-write specialist, the writer lock) exactly like a
     *  brand-new spawn; nothing about a resume is exempt from either
     *  invariant. */
    resumeSpecialist(parentId: string, opts: {
      childId: string;
      prompt: string;
      background?: boolean;
      parentToolCallId: string;
      reservation: SpecialistReservation;
    }): Promise<SpecialistResumeOutcome>;
  };
  /** Task 14 fix pass — the raw catalog-fetch closure ipc-handlers.ts injects
   *  at construction (same shape as the context/slots and vision-support
   *  closures already threaded into NativeSessionHost there: `providerRegistry
   *  .list()` then `modelCatalog.get(providers)`). This lives as its OWN
   *  top-level field, separate from `models` below, because `models.designated`
   *  is built host-internally from NativeHome (mirrors `this.ledger`) while
   *  this needs the live ModelCatalog/ProviderRegistry that only
   *  ipc-handlers.ts holds — NativeSessionHost.toolWiring() recombines the two
   *  into `services.models`. Tools never read this field directly; they read
   *  `services.models.catalog()`. Absent → toolWiring() falls back to a
   *  `null`-returning catalog, the same safe "not loaded" default as before
   *  this fix pass. */
  /** Specialists stage two: plan persistence remains host-owned. WHY this is a
   *  structural callback: propose_plan can validate without importing Task 2's
   *  journal/service, and invalid/aborted calls provably never cross this seam. */
  plans?: {
    propose(proposal: {
      sessionId: string;
      toolUseId: string;
      document: PlanDocumentV1;
      maximumAttempts: number;
      ceilingTokens: number;
      maxFanOut: number;
      /** The turn's live cancellation signal. A service must stop preparation
       * promptly when it aborts and call commit() immediately before its durable
       * write; commit is one-shot and fails after cancellation. */
      signal: AbortSignal;
      commit(): boolean;
    }): Promise<PlanView>;
  };
  modelCatalog?(): Promise<CatalogModel[] | null>;
  /** Task 14 — delegated model tiers + user-directed per-hire override.
   *  `designated` is the on-disk budget/frontier bindings (the Settings UI,
   *  1c, is the only writer); `catalog` returns the live model catalog for
   *  validating a specific model id, or null when it isn't loaded —
   *  resolveDelegatedBinding treats a null catalog the same as "id not
   *  found" (never trust an override it can't confirm). Read by both
   *  tools/task.ts (the `model` input's resolution) and ModelSearch. Absent
   *  is a real, expected state (task.ts only reaches for it when a tier or
   *  specific id was actually requested — see resolveRequestedModel) unlike
   *  `specialists` above, which every production session wires unconditionally. */
  models?: {
    designated: DelegatedModels;
    catalog(): Promise<CatalogModel[] | null>;
  };
}

/** What an earlier Read served (G-11): the file's mtime at that moment, which
 *  tool call did it, and the line range it showed. */
export interface ServedRead {
  mtimeMs: number;
  callIndex: number;
  from: number;
  to: number;
}

export interface ToolContext {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  /** Task 14 — this session's CURRENT model binding, needed as the `parent`
   *  fallback for resolveDelegatedBinding (a tier that isn't set, or a bare
   *  "run on this conversation's model" request, both resolve to this).
   *  Optional so pre-existing test/one-off ToolContext constructions that
   *  never touch model resolution keep compiling; the real driver
   *  (harness-session.ts) always sets it from the session's own binding. */
  binding?: ModelBinding;
  /** The Task-tool call's own toolCallId (Task 6/7), when the driver knows
   *  one — used as createChild's parentToolCallId so the host can later stamp
   *  the child's display events with the launch card they belong under.
   *  Absent for every non-driver test construction (harness-tools-core.test.ts
   *  and friends never set it), which is fine: those never drive the Task tool. */
  toolCallId?: string;
  /** read-before-edit registry: canonical path → mtimeMs at last Read. RESETS on resume (spec §2.5). */
  readRegistry: Map<string, number>;
  /** G-11 (2026-08-26 tools investigation) — re-read dedupe. Key is
   *  `${canonical}|${offset}|${limit}`; a second Read of the SAME slice with an
   *  unchanged mtime gets a short "unchanged since your earlier Read" notice
   *  instead of the content again. Absent → no dedupe (test/one-off contexts).
   *  The session owns it and FORGETS it wherever history is discarded or
   *  shrunk (resume, /clear, compaction) — see harness-session.ts — because the
   *  notice claims the model still HAS the earlier content. */
  servedReads?: Map<string, ServedRead>;
  /** 1-based count of tool calls this session has dispatched, including this
   *  one — what lets Read say "N calls ago". Absent in test contexts. */
  toolCallIndex?: number;
  /** Scoped-persistence shell cwd: the directory the NEXT Bash call starts in.
   *  Absent → Bash falls back to `cwd` (stateless, the pre-2026-07-18 behavior),
   *  which is what test/one-off contexts get for free. */
  shellCwd?: string;
  /** Bash reports the post-command directory here when it resolved INSIDE `cwd`.
   *  The session owns the state; the tool never mutates ctx directly. */
  setShellCwd?(next: string): void;
  /** Opt-in env persistence (17/17 four-round harness reviews asked for this,
   *  2026-08-01 through 2026-08-09): the accumulated vars a `persistent_env: true`
   *  Bash call captured. Absent/empty → every call is a fresh shell env, which is
   *  still the default (Opus 5's dissent in the same review round: cwd should stay
   *  the only sticky thing UNLESS a call opts in). Mirrors shellCwd's pattern
   *  exactly — the session owns the state, the tool only reads/writes through the
   *  accessor below. */
  shellEnv?: Record<string, string>;
  /** Bash calls this after a persistent_env:true call to merge newly-captured vars
   *  (or drop ones the command unset) into the session's running set. */
  setShellEnv?(next: Record<string, string>): void;
  /** per-session todo list (TodoWrite state) */
  todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }>;
  /** Injected runtime services (e.g. WebSearch's SearchService). Absent for tools
   *  that need none; a tool depending on one must handle its absence as a config error. */
  services?: ToolServices;
  /** Whether the SESSION's current model can see images (profile.supportsVision).
   *  Optional so test/one-off contexts default to the conservative false. */
  supportsVision?: boolean;
  /** G-1 background Bash: this session's shell registry — where a
   *  run_in_background start or a handed-off command lives, and what
   *  BashOutput/KillShell read. Absent in test/one-off contexts, in which
   *  case Bash refuses run_in_background and a time limit still kills. */
  shells?: ShellRegistry;
}

/** What a tool omitted from its own result, and how to see more.
 *
 *  WHY this is structured instead of a string the tool writes itself: the single
 *  shared advice string in truncate.ts used to tell EVERY tool's caller to "use
 *  offset/limit" — advice that is correct for Read and meaningless for Bash and
 *  WebSearch, which have no such parameters. A tool now declares the FACT and the
 *  pipeline renders the prose, so a tool structurally cannot suggest a parameter
 *  it does not accept. See the 2026-08-01 multi-model harness review. */
export interface ResultBounds {
  /** Units actually represented in `text`. */
  shown: number;
  /** Units that exist. `null` = genuinely unknown, e.g. a walk that stopped early.
   *  Rendered as "at least N" — never as a number we did not measure. */
  total: number | null;
  // 'pages' — Read on a PDF (ledger G-6) pages by document page, not by line.
  unit: 'lines' | 'chars' | 'bytes' | 'files' | 'matches' | 'results' | 'pages';
  /** How to widen, in THIS tool's vocabulary: "| head -n 100", "offset=2390",
   *  "narrow the glob". The pipeline never supplies a default. */
  moreHint: string;
}

export interface ToolResultPayload {
  /** What the model sees (post-truncation). */
  text: string;
  isError?: boolean;
  /** Edit/Write attach jsdiff hunks so the existing diff card renders. */
  structuredPatch?: StructuredPatchHunk[];
  /** Declared by any tool that bounded its own output. Rendered by defineTool —
   *  never hand-written into `text`, or advice drifts from capability again. */
  bounds?: ResultBounds;
  /** Absolute paths of images this result delivers (Read on an image file). The
   *  DRIVER turns paths into content parts, applies per-turn budgets + dedupe,
   *  and amends `text` with a named note for anything it skips — the tool only
   *  ever promises what it has already stat'd (resolve-before-promise). */
  images?: string[];
  /** propose_plan only: attached to the existing tool-result event so the durable
   *  projection replaces writing without inventing a transcript event type. */
  plan?: PlanView;
  /** Driver-private validation classification. WHY structured: exactly one
   *  plan-specific repair is counted without brittle parsing of error prose. */
  planArgsInvalid?: boolean;
  /** Driver-private: the one plan repair has already been consumed, so the
   *  current turn ends after recording this paired terminal result. */
  planRepairExhausted?: boolean;
}

export interface NativeTool<A = any> {
  name: string;
  description: string;
  /** Compact one-line description used for SIMPLIFIED tool presentation on small
   *  local models (spec §4.2). When the resolved profile is 'simplified',
   *  buildAiTools() hands the model this instead of the full `description` to keep
   *  the tool schema small enough for a weak model to follow. Tools without one
   *  fall back to `description`. */
  shortDescription?: string;
  inputSchema: z.ZodType<A>;
  /** JSON Schema straight from an MCP server, when this tool came from one.
   *  buildAiTools() sends THIS to the model instead of translating inputSchema,
   *  because converting JSON Schema → zod is lossy and a lossy conversion that
   *  rejects a valid call would be a bug we invented. `inputSchema` stays
   *  required and permissive for MCP tools: it keeps the driver's single
   *  validation path (harness-session.ts safeParse) intact, and the SERVER is
   *  the authority on its own arguments. */
  rawInputSchema?: Record<string, unknown>;
  /** The permission SUBJECT for rule matching: Bash → command string; file
   *  tools → the file path; undefined → tool-name-only matching. */
  permissionSubject(args: A): string | undefined;
  /** Interactive tools (AskUserQuestion) are routed by the DRIVER straight to
   *  askUser() — guards/decide are skipped (asking permission to ask a question
   *  is absurd) and execute() never runs. */
  interactive?: boolean;
  /** How to widen THIS tool's output, in its own vocabulary — a static property,
   *  independent of whether the tool or the pipeline did the cutting.
   *
   *  WHY static (2026-08-06): `bounds.moreHint` only exists when the TOOL bounded its
   *  own output. The pipeline cap in defineTool is a separate event that fires on its
   *  own schedule — for content-mode Grep it is the common one — and without a hint to
   *  fall back on the model was told content vanished and given no way to get it back. */
  moreHint?: string;
  /** Capability-dependent description override. Returning undefined falls back to
   *  `description`. WHY: a model is never told about image reading it doesn't
   *  have — and a vision model that isn't told never tries (Roo Code #10440). */
  descriptionFor?(caps: { supportsVision: boolean }): string | undefined;
  /** Capability-dependent SHORT description override, for simplified presentation
   *  (spec §4.2 — small local models get shortDescription instead of description
   *  to keep schema budget down). Returning undefined falls back to the static
   *  `shortDescription`. WHY: without this a small local vision model never learns
   *  Read handles images at all — descriptionFor's fix only reaches models on the
   *  non-simplified path, leaving the exact Roo Code #10440 gap open for the tier
   *  simplification exists to serve. */
  shortDescriptionFor?(caps: { supportsVision: boolean }): string | undefined;
  execute(args: A, ctx: ToolContext): Promise<ToolResultPayload>;
}
