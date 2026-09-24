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

// WHY v2, with no reader for v1 (spending rework stage 1, design §2,
// decision 33.4 / open question 7 "resolved here"): the reservation/ceiling
// shapes v1 journals hold (`budgetTokens`, `ceilingTokens`, `tranches`,
// `baseTokens`/`addedTokens`/`reservedTokens`, the five-phase attempt state)
// have no v2 equivalent to migrate INTO — there is nothing left to convert a
// per-step token ceiling to. `PlanJournal`'s strict version check
// (`parseJournal`) already refuses to read a mismatched `v`; the host's
// startup path renames a `v: 1` file to `<file>.v1-retired` and starts a
// fresh empty v2 journal for that conversation, showing no failed card —
// "all of the existing plans are demos" (decision 33's `summary` note
// applies here too; Destin accepted this explicitly for the rework).
export const PLAN_JOURNAL_VERSION = 2 as const;

/**
 * Final review F6: a proposal refused for a reason written for people (the
 * plan names a specialist this project doesn't have, no safe model could be
 * confirmed, …). The failed card shows its message as the reason. Any other
 * error is unexpected: the card says so generally and keeps the text for the
 * bug report, because a system message is not a reason a person can act on.
 */
export class PlanProposalError extends Error {}

/** One specialist whose provider cannot run as things stand, with the
 *  provider's OWN sentence about what to fix. */
export interface PlanNotReadySpecialist {
  id: string;
  /** How Settings → Providers names that provider. Kept for any surface that
   *  wants it; the sentence below deliberately does not repeat it (see WHY). */
  label: string;
  message: string;
}

/**
 * Review findings 2, 9 and 11 (decisions 25 + 26). Thrown by
 * `resolveManifest`, which the PROPOSAL, Approve and Continue all reach — so
 * the sentence carries NO ending about what happened to the plan. Each caller
 * adds its own: a proposal was never created, but an Approve or a Continue is
 * pressed on a plan that is plainly on screen, and telling that person "the
 * plan wasn't created" reads as "my plan is gone".
 *
 * WHY every specialist, grouped by sentence (finding 9): throwing at the first
 * one meant the person fixed that provider, asked again, and was refused for
 * the second. One trip to Settings should fix them all.
 *
 * WHY the provider's label is not in the sentence (finding 11): the ChatGPT
 * row is labelled "ChatGPT Plan", so "would run on ChatGPT Plan" put two
 * meanings of "plan" in one sentence about a plan. Every sentence the registry
 * returns already names what to fix ("Sign in with ChatGPT…", "<label> needs
 * an API key…"), so the label adds nothing the reader needs.
 */
export class PlanSpecialistsNotReadyError extends Error {
  constructor(readonly specialists: readonly PlanNotReadySpecialist[]) {
    super(notReadySentence(specialists));
  }
}

function notReadySentence(list: readonly PlanNotReadySpecialist[]): string {
  const byMessage = new Map<string, string[]>();
  for (const s of list) byMessage.set(s.message, [...(byMessage.get(s.message) ?? []), s.id]);
  return [...byMessage].map(([message, ids]) => {
    const quoted = ids.map((id) => `"${id}"`);
    const names = quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
    return `The ${names} ${ids.length === 1 ? 'specialist' : 'specialists'} can't run right now: ${message}`;
  }).join(' ');
}

const TOOL_EFFECTS = ['read', 'local', 'external'] as const satisfies readonly ToolEffect[];
const PLAN_RECOVERY_CAUSES = ['launch-failed', 'specialist-error', 'invalid-report', 'unknown-request', 'unknown-outcome'] as const satisfies readonly PlanRecoveryCause[];
// WHY only two actions now (spending rework stage 1, decision 34): nothing is
// rationed per step or per plan any more, so there is no "add_budget" to
// recommend or to press — see shared/types.ts PlanPauseAction.
const PLAN_PAUSE_ACTIONS = ['continue', 'stop'] as const satisfies readonly PlanPauseAction[];

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
 *
 * WHY the binding/pricing live per-STEP now, not per-specialist (spending
 * rework stage 1, design §2/§5, decision 35): a per-step model override
 * means two steps naming the SAME specialist can freeze two different
 * bindings — `specialists[id]` can no longer hold one binding for all of
 * them. `steps[leafStepId]` is keyed by every LEAF step id in the document
 * (map/verify/combine — a repeat's body steps included), each resolved once
 * by `resolveManifest` (T4) and frozen: the binding it runs on, the card's
 * label, its pricing snapshot, and whether that binding came from the
 * specialist's own `default`, the plan `document`'s per-step `model`, or a
 * `user` override via Plan settings (design §5's three-step resolution
 * order). `specialists[id]` keeps only what is genuinely per-specialist:
 * its definition fingerprint, still compared to catch a roster change
 * between proposal and Approve/Continue.
 */
const ExecutionManifestSchema = z.object({
  /** The label the card shows under the plan. */
  modelLabel: z.string(),
  /** Keyed by specialist id — one entry per distinct specialist the plan names. */
  specialists: z.record(z.string(), z.object({
    definitionFingerprint: z.string().min(1),
  }).strict()),
  /** Keyed by every leaf step id (design §5). */
  steps: z.record(z.string(), z.object({
    binding: FrozenBindingSchema,
    label: z.string().min(1),
    /** A PlanPricingSnapshot (plan-spend.ts owns its meaning, T2): priced
     *  rates, free, or local. null means "no published price", never "free".
     *  WHY still unknown here: an unrecognized snapshot must not quarantine
     *  the whole journal — plan-spend reads it strictly and treats anything
     *  it can't parse as "no published price". */
    pricing: z.unknown().nullable(),
    source: z.enum(['default', 'document', 'user']),
  }).strict()),
  permissionFingerprint: z.string().min(1),
}).strict();
export type ExecutionManifest = z.infer<typeof ExecutionManifestSchema>;

// WHY only three phases now (spending rework stage 1, design §2/§3): plan
// children use the ordinary request path, so there is no separate in-flight
// request state to phase through — see shared/types.ts's matching note.
const ATTEMPT_PHASES = ['prepared', 'launched', 'committed'] as const;
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
  // WHY baseTokens/addedTokens/reservedTokens/requestInputBound/
  // requestReservedInput/requestPrefix/lastRequest/softLimit/
  // ambiguityReported are ALL GONE (spending rework stage 1, design §1/§3,
  // decision 34): every one of them named the reservation system's
  // bookkeeping for an ALLOWANCE held against a request before it was sent —
  // `afterReply` (plan-spend.ts, T2) instead records what a reply actually
  // cost AFTER the fact, so there is nothing to reserve, no settlement window
  // to detect an input-side breach in, and no soft/hard adapter distinction.
  /** What this attempt has cost so far, in the estimate's own unit
   *  (`billedEquivalentTokens`, design §3) — summed into `plan.usedTokens`
   *  by the SAME journal write that records it. */
  spentTokens: nonNegativeInt,
  /** Design §3: this attempt's priced spend, summed into `plan.usedUsd`.
   *  Absent exactly when `spentTokens` is priced by no known rate yet
   *  (free/local/no-published-price), matching `usedUsd`'s own optionality. */
  spentUsd: z.number().min(0).optional(),
  phase: z.enum(ATTEMPT_PHASES),
  /** Task 9a (pause handoff §1): a report-only retry after an invalid report.
   *  It continues the failed attempt's specialist session (`childId` is set
   *  when it is reserved), with one dedicated message (`brief`), tools
   *  switched off, and a reply capped at PLAN_REPORT_ONLY_REPLY_TOKENS. Its
   *  allowance is what the failed attempt left unspent. Kept on the record so
   *  a crash before or during that turn restarts it the same way. */
  reportOnly: z.literal(true).optional(),
  /** Review R2: the durable, minimal replacement for the deleted
   *  `ambiguityReported` flag (same mechanism, carried over unchanged by the
   *  spending rework: the phase it used to ride on, `'ambiguous'`, is gone,
   *  but the flag's own meaning is not spend-related). Set on the ONE
   *  attempt an `unknown-outcome` pause names, in the SAME write that makes
   *  the pause visible (`settle`'s `finalWrite`) — the ONLY way this plan
   *  runs again from `paused` is `PlanService.resume`, i.e. the person's own
   *  Continue, so marking it here already means "Continue will mean this".
   *  `recoverAttempt` reads and clears it on that next start: set → skip the
   *  pause and restart with the check-first turn (`planRestartBrief`);
   *  absent (a fresh crash — `interrupted` status carries no `paused`, so no
   *  attempt is ever marked from it) → classify and pause exactly as
   *  before. Single use, so a later, genuinely new dangling call still
   *  pauses. */
  pauseAcknowledged: z.literal(true).optional(),
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

// WHY Add budget's authorization record is GONE (spending rework stage 1,
// design §1, decision 34): there is no per-step or per-plan token allowance
// left to enlarge. Spend limit changes go through `PlanService.setLimit`
// (design §7, T6) and land directly on `plan.spendLimit` — no tranche ledger.

const JOURNAL_PLAN_STATUSES =['proposed', 'running', 'paused', 'interrupted', 'completed', 'stopped', 'failed'] as const;
export type JournalPlanStatus = (typeof JOURNAL_PLAN_STATUSES)[number];

/** Design §2/§7: a plan's spend limit, or the limit a `spend-limit` pause
 *  hit — dollars for a priced plan, tokens for one with no priced step (the
 *  same pricing-class rule as `estimate`, design §4). */
const PlanSpendLimitSchema = z.union([
  z.object({ usd: z.number().min(0) }).strict(),
  z.object({ tokens: nonNegativeInt }).strict(),
]);

/** Design §4: `estimatePlan`'s output (T5 builds the function; the shape is
 *  fixed now so the record can carry it from `propose` onward). Dollars when
 *  every specialist is priced; tokens plus a plain unpriced note otherwise
 *  (decision 34 Q-5). */
const PlanEstimateSchema = z.union([
  z.object({ lowUsd: z.number().min(0), highUsd: z.number().min(0) }).strict(),
  z.object({ tokens: nonNegativeInt, unpricedNote: z.string().min(1) }).strict(),
]);
export type PlanEstimate = z.infer<typeof PlanEstimateSchema>;

const PlanRecordSchema = z.object({
  planId: z.string().min(1),
  toolUseId: z.string(),
  document: PlanDocumentSchema,
  maximumAttempts: nonNegativeInt,
  maxFanOut: nonNegativeInt,
  // WHY ceilingTokens/ceilingUsd are GONE (spending rework stage 1, design
  // §1/§2, decision 34): there is no per-step token budget left to sum into
  // a worst-case ceiling. `spendLimit`/`estimate` below are what the card
  // reads instead.
  usedTokens: nonNegativeInt,
  /** Design §3: absent means no priced spend yet (a plan whose specialists
   *  are all free/local/unpublished never gets a number here). */
  usedUsd: z.number().min(0).optional(),
  /** Design §2/§7: the plan's own optional spend limit, off by default, set
   *  or changed by `PlanService.setLimit` (T6) before or while the plan
   *  runs. */
  spendLimit: PlanSpendLimitSchema.optional(),
  /** Design §4: a range/tokens estimate from past runs of these specialists,
   *  computed at propose, on `setStepModel`, and on re-freeze (T5), and
   *  stored here so projection (`projectPlan`) stays pure. */
  estimate: PlanEstimateSchema.optional(),
  /** Design §5: user-set per-step model overrides ONLY — keyed by leaf step
   *  id, absent for a step still on its specialist's default or the
   *  document's own `model`. `PlanService.setStepModel` (T4) writes this and
   *  re-resolves that step's `manifest.steps[id]` entry in the same write. */
  stepModels: z.record(z.string(), FrozenBindingSchema).optional(),
  status: z.enum(JOURNAL_PLAN_STATUSES),
  /** Visible ordering stamp — bumped by every mutation that changes this plan. */
  seq: z.number().int().min(1),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  autoApproved: z.boolean().optional(),
  paused: z.object({
    stepId: z.string(), reason: z.string(), attemptId: z.string().optional(),
    /** Task 12 review fix 2: the system's own text behind a general `reason`,
     *  for Report bug / Diagnose only — never drawn on the card. */
    report: z.string().min(1).optional(),
    /** Design §2/§7: the spend limit THIS pause hit ("Reached your $5
     *  limit."), for a `spend-limit` pause — same shape as `spendLimit`
     *  above (decision 37 R-4). */
    limit: PlanSpendLimitSchema.optional(),
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
     *  retried, but Continue is offered — signing in is the fix.
     *  WHY `.catch` (review finding 5): this list has been widened twice
     *  without a journal version bump, and a strict enum makes a value a LATER
     *  build writes fail the WHOLE-file parse on this one — which quarantines
     *  every plan for that folder, not just the one. `~/.youcoded/` is synced
     *  between machines, so that is reachable by a rollback or by a second
     *  machine on the previous build. An unknown value now reads as absent,
     *  which is the same as a journal written before the field existed: the
     *  pause falls back to Continue · Stop (PlanCard's default case). This is
     *  the tolerance every future widening of this field relies on. */
    launch: z.enum(['refused', 'drift', 'not-ready']).optional().catch(() => undefined),
    retried: z.literal(true).optional(),
    toolEffect: z.enum(TOOL_EFFECTS).optional(),
    // WHY reportOnlyOf/budgetRequests are GONE here (spending rework stage 1,
    // decision 34): both named an Add budget request against this pause —
    // "the report turn this tranche funds" and "requests already applied" —
    // and there is no Add budget any more to fund or to dedupe.
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
      // WHY addTokens is gone (decision 34): action is 'continue'|'stop'
      // only now — there is no add-budget recommendation to size.
      recommendation: z.object({
        action: z.enum(PLAN_PAUSE_ACTIONS),
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
  // WHY tranches/disabledAdapters/approximateLimit are ALL GONE (spending
  // rework stage 1, design §1, decisions 5/34): there is no Add budget
  // ledger, no adapter to disable, and no per-specialist "replies can't be
  // capped" warning once nothing is capped in advance — design §3 accepts
  // one reply's overshoot past the plan's own spend limit for every running
  // specialist, not just an uncapped route.
  revisionOf: z.string().optional(),
  revisedBy: z.string().optional(),
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
