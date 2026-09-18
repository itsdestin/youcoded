// Specialists plans (Task 2) — the durable journal's record shapes and the
// result shapes every plan action returns.
//
// WHY the records are Zod schemas rather than bare interfaces: the journal
// reads a file that another process, an older build, or a hand edit may have
// written. Every read is checked against these exact shapes, and anything
// that does not match is quarantined instead of being "healed" by a write
// that could erase approved budgets or finished reports. One definition gives
// both the TypeScript type and that check, so the two can never drift.
import { z } from 'zod';
import { PlanDocumentSchema } from './schema';
import { PLAN_PAUSE_KINDS, PLAN_QUESTION_MAX_CHARS, type PlanView } from '../../../shared/types';
import type { ToolEffect } from '../tools/types';
import type { PlanPauseAction, PlanRecoveryCause } from './pause-routing';

export const PLAN_JOURNAL_VERSION = 1 as const;

/**
 * Final review F6: a proposal refused for a reason written for people (the
 * plan names a specialist this project doesn't have, no safe model could be
 * confirmed, …). The failed card shows its message as the reason. Any other
 * error is unexpected: the card says so generally and keeps the text for the
 * bug report, because a system message is not a reason a person can act on.
 */
export class PlanProposalError extends Error {}

const TOOL_EFFECTS = ['read', 'local', 'external'] as const satisfies readonly ToolEffect[];
const PLAN_RECOVERY_CAUSES = ['launch-failed', 'specialist-error', 'invalid-report', 'unknown-request', 'unknown-outcome'] as const satisfies readonly PlanRecoveryCause[];
const PLAN_PAUSE_ACTIONS = ['add_budget', 'continue', 'stop'] as const satisfies readonly PlanPauseAction[];

const nonNegativeInt = z.number().int().min(0);

/** Final review F1: an Add budget request id is at most this long. */
export const PLAN_BUDGET_REQUEST_ID_MAX_CHARS = 128;
/** Final review F1: how many applied request ids one pause remembers (the
 *  oldest is dropped first; a person never presses this many times). */
export const PLAN_BUDGET_REQUESTS_KEPT = 16;

/** A frozen model binding for one specialist, captured when the plan is proposed. */
const FrozenBindingSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
}).strict();

/**
 * Everything the user implicitly agreed to when they approved the card.
 * Frozen at proposal time and compared again before Approve/Continue: a
 * change to any of these means the approved plan no longer describes what
 * would run, so it must be re-proposed instead of silently widening consent
 * or repricing (design §2/§3).
 */
const ExecutionManifestSchema = z.object({
  /** The label the card shows under the plan. */
  modelLabel: z.string(),
  /** Keyed by specialist id — one entry per distinct specialist the plan names. */
  specialists: z.record(z.string(), z.object({
    definitionFingerprint: z.string().min(1),
    binding: FrozenBindingSchema,
    /** A PlanPricingSnapshot (plan-budget.ts owns its meaning): priced rates,
     *  free, or local. null means "no published price", never "free".
     *  WHY still unknown here: an unrecognized snapshot must not quarantine the
     *  whole journal — plan-budget reads it strictly and treats anything it
     *  can't parse as "no published price". */
    pricing: z.unknown().nullable(),
    /** Decision 4: this specialist's fixed starting cost — its system prompt,
     *  tool schemas and framing at the budget adapter's certified bound
     *  (budget-adapter.ts `setupBound`). Counted on top of each step's
     *  budget_tokens in the ceiling and in every attempt's allowance. */
    setupTokens: nonNegativeInt,
    /** Decision 5: this specialist runs on a route whose replies can't be
     *  capped (ChatGPT), so the plan's limit is approximate. */
    approximateLimit: z.boolean().optional(),
  }).strict()),
  permissionFingerprint: z.string().min(1),
}).strict();
export type ExecutionManifest = z.infer<typeof ExecutionManifestSchema>;

/** Revision 5: a request's prompt, named by its prefix-chain link
 *  (budget-adapter.ts `planRequestPrefix`). */
const PrefixLinkSchema = z.object({ messages: nonNegativeInt, hash: z.string().min(1) }).strict();

const ATTEMPT_PHASES = ['prepared', 'request-sent', 'response-persisted', 'committed', 'ambiguous'] as const;
type AttemptPhase = (typeof ATTEMPT_PHASES)[number];

/** One specialist launch (or safe relaunch) inside a step. */
const PlanAttemptSchema = z.object({
  attemptId: z.string().min(1),
  /** Which map item / iteration this attempt serves (0-based). */
  itemIndex: nonNegativeInt,
  iteration: nonNegativeInt,
  childId: z.string().min(1).optional(),
  /** Task 4 review item 6: what the plan card's specialist row shows — the
   *  name minted at launch, when it started, and the brief it was sent. */
  childTitle: z.string().optional(),
  startedAt: z.number().optional(),
  brief: z.string().optional(),
  /** The spawn-time manifest entry actually used (Task 4 fills it). */
  manifest: ExecutionManifestSchema.optional(),
  baseTokens: nonNegativeInt,
  addedTokens: nonNegativeInt,
  reservedTokens: nonNegativeInt,
  spentTokens: nonNegativeInt,
  phase: z.enum(ATTEMPT_PHASES),
  /** While a request is unsettled: the certified input bound it was reserved
   *  with, so settlement can detect an input-side breach (Task 3 review). */
  requestInputBound: nonNegativeInt.optional(),
  /** Revision 5 (decision 22), while a request is unsettled: the smaller
   *  input side it reserved because the provider's cache was warm (absent =
   *  the full bound above was reserved). */
  requestReservedInput: nonNegativeInt.optional(),
  /** Revision 5, while a request is unsettled: the prompt it sent. */
  requestPrefix: PrefixLinkSchema.optional(),
  /** Revision 5: the last request of this attempt that completed with a
   *  usage report — when, and the prompt it sent. The next request is
   *  reserved warm only if it starts with that same prompt within the
   *  route's cache window. */
  lastRequest: PrefixLinkSchema.extend({ at: z.number() }).strict().optional(),
  /** Set once a request went out through a soft (uncapped) adapter. */
  softLimit: z.boolean().optional(),
  /** Task 4: set in the SAME write that paused the plan to tell the user this
   *  attempt's last request/action has an unknown outcome. WHY a flag: an
   *  attempt also becomes `ambiguous` silently (the pausing path charges an
   *  unsettled sibling in full). Only an ambiguity the user has actually been
   *  shown may be picked up again by Continue; an unshown one pauses first. */
  ambiguityReported: z.boolean().optional(),
  /** Task 9a (pause handoff §1): a report-only retry after an invalid report.
   *  It continues the failed attempt's specialist session (`childId` is set
   *  when it is reserved), with one dedicated message (`brief`), tools
   *  switched off, and a reply capped at PLAN_REPORT_ONLY_REPLY_TOKENS. Its
   *  allowance is what the failed attempt left unspent. Kept on the record so
   *  a crash before or during that turn restarts it the same way. */
  reportOnly: z.literal(true).optional(),
  terminal: z.enum(['completed', 'failed', 'stopped']).optional(),
  reportText: z.string().optional(),
  reportPath: z.string().optional(),
  /** Set exactly once, by the commit that makes this attempt immutable. */
  completedAt: z.number().optional(),
}).strict();
export type PlanAttemptRecord = z.infer<typeof PlanAttemptSchema>;

const PlanStepRecordSchema = z.object({
  /** Every step id in the document, including steps inside a repeat body. */
  id: z.string().min(1),
  status: z.enum(['pending', 'running', 'done', 'paused', 'failed', 'skipped']),
  attempts: z.array(PlanAttemptSchema),
}).strict();
export type PlanStepRecord = z.infer<typeof PlanStepRecordSchema>;

/**
 * The executor's claim on a plan. Present ONLY while an executor is actively
 * advancing it; a paused/interrupted/stopped plan never holds one.
 */
const PlanLeaseSchema = z.object({
  /** Random per process — unguessable and never reused after a restart. */
  instanceId: z.string().min(1),
  pid: z.number().int(),
  heartbeatAt: z.number(),
  expiresAt: z.number(),
  epoch: z.number().int().min(1),
  /** The token every executor write must present. */
  fence: z.string().min(1),
}).strict();
export type PlanLease = z.infer<typeof PlanLeaseSchema>;

/** One Add budget authorization (design §4). */
const PlanTrancheSchema = z.object({
  trancheId: z.string().min(1),
  stepId: z.string().min(1),
  attemptId: z.string().min(1).optional(),
  tokens: z.number().int().min(1),
  at: z.number(),
  /** Task 4 review item 1: added while the pause named no specialist (a plan
   *  limit shortfall). It raises the plan limit only and is never claimed by
   *  a new attempt — an allowance that grew with the limit could never fit. */
  ceilingOnly: z.literal(true).optional(),
  /** Final review F4: added while the pause was a report turn that had too
   *  little allowance. Claimed only by the report turn for that failed
   *  attempt, never by any other specialist. */
  reportOnlyOf: z.string().min(1).optional(),
}).strict();
type PlanTranche = z.infer<typeof PlanTrancheSchema>;

const JOURNAL_PLAN_STATUSES =['proposed', 'running', 'paused', 'interrupted', 'completed', 'stopped', 'failed'] as const;
export type JournalPlanStatus = (typeof JOURNAL_PLAN_STATUSES)[number];

const PlanRecordSchema = z.object({
  planId: z.string().min(1),
  toolUseId: z.string(),
  document: PlanDocumentSchema,
  maximumAttempts: nonNegativeInt,
  maxFanOut: nonNegativeInt,
  /** Worst-case tokens the user approved (grows only through Add budget). */
  ceilingTokens: nonNegativeInt,
  ceilingUsd: z.number().min(0).nullable(),
  usedTokens: nonNegativeInt,
  usedUsd: z.number().min(0).nullable().optional(),
  status: z.enum(JOURNAL_PLAN_STATUSES),
  /** Visible ordering stamp — bumped by every mutation that changes this plan. */
  seq: z.number().int().min(1),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  autoApproved: z.boolean().optional(),
  /** attemptId (Task 3): which attempt an Add budget tranche enlarges. Absent
   *  when the pause happened before that step had an attempt. */
  paused: z.object({
    stepId: z.string(), reason: z.string(), attemptId: z.string().optional(),
    /** Task 12 review fix 2: the system's own text behind a general `reason`,
     *  for Report bug / Diagnose only — never drawn on the card. */
    report: z.string().min(1).optional(),
    /** Task 4: the smallest Add budget that lets the paused specialist send
     *  its next request (its fresh resume prompt plus any soft overshoot).
     *  Add budget lowers it by what was added; the service refuses less. */
    minimumAddTokens: nonNegativeInt.optional(),
    /** Task 12 follow-up 1: the smaller minimum that holds while the paused
     *  specialist's prompt is still in the provider's cache (only the part
     *  added since its last request must fit), valid until `until` (main's
     *  clock: that request's time + the cache window). `minimumAddTokens` is
     *  then the COLD minimum (the whole conversation re-sent). Add budget
     *  lowers both; 0 means "already met" and is kept until it expires. */
    warmMinimum: z.object({ tokens: nonNegativeInt, until: z.number() }).strict().optional(),
    /** Task 4 round 2: the pause was the plan limit being too small for the
     *  next wave, not one specialist running out. Add budget then raises the
     *  limit only — even if the step has unfinished specialists — because an
     *  allowance that grows with the limit could never make the wave fit. */
    ceilingShortfall: z.literal(true).optional(),
    /** 5b follow-up: why it paused, and the facts the card words it from
     *  (shared/types.ts PLAN_PAUSE_KINDS). Optional so a journal written
     *  before these fields still reads. */
    kind: z.enum(PLAN_PAUSE_KINDS).optional(),
    tool: z.string().min(1).optional(),
    repeat: z.object({ rounds: nonNegativeInt, until: z.string() }).strict().optional(),
    note: z.string().min(1).optional(),
    /** Task 9a: facts the routing (pause-routing.ts) reads back. `launch`: the
     *  start was refused or the specialist changed since approval (never
     *  retried); `retried`: this is the failure after an automatic recovery;
     *  `toolEffect`: what the unanswered `tool` could change. */
    /** Task 13 (decision 26): `not-ready` = the specialist's provider could
     *  not run (signed out, no key, endpoint or engine missing). Also never
     *  retried, but Continue is offered — signing in is the fix. */
    launch: z.enum(['refused', 'drift', 'not-ready']).optional(),
    retried: z.literal(true).optional(),
    toolEffect: z.enum(TOOL_EFFECTS).optional(),
    /** Final review F1: the request ids of the Add budget presses THIS pause
     *  already applied. WHY on the pause: a lost reply followed by Retry (or a
     *  second press of the same button) sends the same id again and must add
     *  nothing; a new pause is a new object, so an old id never blocks it. */
    /** Final review F4: the pause is a report turn (for this failed attempt)
     *  that its unspent allowance can't fund — Add budget funds exactly it. */
    reportOnlyOf: z.string().min(1).optional(),
    budgetRequests: z.array(z.string().min(1).max(PLAN_BUDGET_REQUEST_ID_MAX_CHARS)).max(PLAN_BUDGET_REQUESTS_KEPT).optional(),
    /** Task 9b (pause handoff §2): this pause was handed to the assistant.
     *  `pending` = the card is greyed out while the assistant looks into it;
     *  `answered` = the card has its buttons again (with the assistant's
     *  recommendation when it made one). `id` is unguessable and tags the
     *  notice, so a stale notice or recommendation can never land on a newer
     *  pause. `revisionTurnId` is this pause's pending revision: the id of the
     *  notice turn whose propose_plan may replace this plan. It lives HERE, on
     *  the plan, so a Comment on another plan can't overwrite it; any user
     *  action or the end of that turn deletes it.
     *  Task 11 (design §6): a handoff only exists because the user pressed
     *  "Ask the assistant". `waiting: 'reply'` = the question is queued
     *  behind a reply already in progress (the card says so); delivery
     *  starting removes it. `problem` = the question was cleared without an
     *  answer because it never started in time (`no-start`, the backstop) or
     *  its turn failed (`reply-failed`, with the real error) — the card then
     *  shows an error line with Retry instead of silently returning its
     *  buttons. Asking again replaces the whole object. */
    handoff: z.object({
      id: z.string().min(1),
      state: z.enum(['pending', 'answered']),
      at: z.number(),
      revisionTurnId: z.string().min(1).optional(),
      waiting: z.literal('reply').optional(),
      /** Decision 20: what the user typed in the Ask box (trimmed, at most
       *  PLAN_QUESTION_MAX_CHARS). Absent when they left it blank. Review
       *  fix 3: the same constant the Ask box checks, so they can't drift. */
      question: z.string().min(1).max(PLAN_QUESTION_MAX_CHARS).optional(),
      recommendation: z.object({
        action: z.enum(PLAN_PAUSE_ACTIONS),
        addTokens: z.number().int().min(1).optional(),
        message: z.string().min(1).max(280),
      }).strict().optional(),
      problem: z.object({
        kind: z.enum(['no-start', 'reply-failed']),
        detail: z.string().min(1).optional(),
      }).strict().optional(),
    }).strict().optional(),
  }).strict().optional(),
  /** Task 9a (pause handoff §1): every automatic recovery, journalled with the
   *  fence BEFORE the relaunch. One per step, iteration, item and cause — so a
   *  crash between this write and the relaunch can never yield a second one. */
  recoveries: z.array(z.object({
    stepId: z.string().min(1),
    iteration: nonNegativeInt,
    itemIndex: nonNegativeInt,
    cause: z.enum(PLAN_RECOVERY_CAUSES),
    at: z.number(),
    /** Review fix 3: set in the launch write of the retry itself, so the card
     *  says "Retried after an error" only for a retry that really ran. */
    relaunched: z.literal(true).optional(),
    /** Review fix 4 (controller decision): the user's own Continue resumed
     *  this unfinished work, so this recovery no longer counts — the next
     *  hiccup gets its one automatic retry again. Kept (not deleted) so the
     *  card can still say the specialist was retried. */
    reset: z.literal(true).optional(),
  }).strict()).optional(),
  /** Task 3: every Add budget, in order. A tranche without attemptId is
   *  waiting for the step's next attempt and is applied when it is reserved. */
  tranches: z.array(PlanTrancheSchema).optional(),
  /** Task 3: budget adapters whose certified bound a real response broke.
   *  Nothing more is sent through them for this plan (design §4). */
  disabledAdapters: z.array(z.object({ adapterId: z.string().min(1), detail: z.string() }).strict()).optional(),
  revisionOf: z.string().optional(),
  revisedBy: z.string().optional(),
  /** Decision 5: some specialist's replies can't be capped, so the limit is
   *  approximate (one reply may overshoot before the plan pauses). */
  approximateLimit: z.boolean().optional(),
  /** Decision 6: the real reason a failed plan failed, shown verbatim. */
  failure: z.object({ detail: z.string().min(1) }).strict().optional(),
  /** Set when a Comment retired this proposal; the replacement may not exist yet. */
  revisedByComment: z.boolean().optional(),
  /** Task 9b: the assistant replaced this paused plan with a revised one from
   *  the pause's notice turn (the card must not say "after your comment"). */
  revisedOnPause: z.literal(true).optional(),
  manifest: ExecutionManifestSchema,
  steps: z.array(PlanStepRecordSchema),
  /** Highest fencing epoch ever issued — survives lease release, so a later
   *  executor always gets a strictly larger epoch than any stale one. */
  fenceEpoch: nonNegativeInt,
  lease: PlanLeaseSchema.optional(),
}).strict();
export type PlanRecord = z.infer<typeof PlanRecordSchema>;

/**
 * App-issued link between a Comment and the follow-up turn it queued. Only
 * the plan service creates or consumes it — never model input (design §2).
 */
const PendingRevisionSchema = z.object({
  token: z.string().min(1),
  /** The queued comment turn the replacement proposal must come from. */
  turnId: z.string().min(1),
  oldPlanId: z.string().min(1),
  createdAt: z.number(),
}).strict();
type PendingRevision = z.infer<typeof PendingRevisionSchema>;

export const PlanJournalFileSchema = z.object({
  v: z.literal(PLAN_JOURNAL_VERSION),
  plans: z.array(PlanRecordSchema),
  pendingRevision: PendingRevisionSchema.optional(),
}).strict();
export type PlanJournalFile = z.infer<typeof PlanJournalFileSchema>;

/** Where one parent session's journal lives. */
export interface PlanRef {
  cwd: string;
  sessionId: string;
}

/** One journal write → one of these per plan it visibly changed. */
export interface PlanEvent {
  sessionId: string;
  plan: PlanView;
}

// ---- Results every plan action returns (design §5) ----
// WHY three explicit forms: the renderer must be able to tell "this device
// cannot do plans" (hide/disable, no retry) from "this attempt failed"
// (show the real error). Nothing here ever implies success optimistically.
// Task 5a: the forms now live in shared/types.ts (the renderer types its
// bridge with them); re-exported so main keeps one definition.
export type {
  PlanUnsupported, PlanActionResult, PlanAutoApproveRead, PlanSettingsWriteResult,
} from '../../../shared/types';
