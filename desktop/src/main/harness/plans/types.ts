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
import type { PlanView } from '../../../shared/types';

export const PLAN_JOURNAL_VERSION = 1 as const;

const nonNegativeInt = z.number().int().min(0);

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
  }).strict()),
  permissionFingerprint: z.string().min(1),
}).strict();
export type ExecutionManifest = z.infer<typeof ExecutionManifestSchema>;

const ATTEMPT_PHASES = ['prepared', 'request-sent', 'response-persisted', 'committed', 'ambiguous'] as const;
export type AttemptPhase = (typeof ATTEMPT_PHASES)[number];

/** One specialist launch (or safe relaunch) inside a step. */
const PlanAttemptSchema = z.object({
  attemptId: z.string().min(1),
  /** Which map item / iteration this attempt serves (0-based). */
  itemIndex: nonNegativeInt,
  iteration: nonNegativeInt,
  childId: z.string().min(1).optional(),
  /** The spawn-time manifest entry actually used (Task 4 fills it). */
  manifest: ExecutionManifestSchema.optional(),
  baseTokens: nonNegativeInt,
  addedTokens: nonNegativeInt,
  reservedTokens: nonNegativeInt,
  spentTokens: nonNegativeInt,
  phase: z.enum(ATTEMPT_PHASES),
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
}).strict();
export type PlanTranche = z.infer<typeof PlanTrancheSchema>;

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
  paused: z.object({ stepId: z.string(), reason: z.string(), attemptId: z.string().optional() }).strict().optional(),
  /** Task 3: every Add budget, in order. A tranche without attemptId is
   *  waiting for the step's next attempt and is applied when it is reserved. */
  tranches: z.array(PlanTrancheSchema).optional(),
  /** Task 3: budget adapters whose certified bound a real response broke.
   *  Nothing more is sent through them for this plan (design §4). */
  disabledAdapters: z.array(z.object({ adapterId: z.string().min(1), detail: z.string() }).strict()).optional(),
  revisionOf: z.string().optional(),
  revisedBy: z.string().optional(),
  /** Set when a Comment retired this proposal; the replacement may not exist yet. */
  revisedByComment: z.boolean().optional(),
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
export type PendingRevision = z.infer<typeof PendingRevisionSchema>;

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
export type PlanUnsupported = { ok: false; unsupported: true; error: string };
export type PlanFailure = { ok: false; unsupported?: undefined; error: string };

export type PlanActionResult = { ok: true; plan: PlanView } | PlanFailure | PlanUnsupported;
export type PlanAutoApproveRead = { ok: true; underTokens: number } | PlanFailure | PlanUnsupported;
export type PlanSettingsWriteResult = { ok: true } | PlanFailure | PlanUnsupported;
