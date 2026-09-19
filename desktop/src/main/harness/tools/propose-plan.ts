import { defineTool } from './registry';
import type { NativeTool, ToolContext, ToolEffect, ToolResultPayload } from './types';
import { PLAN_DOCUMENT_JSON_SCHEMA, PlanDocumentSchema, type PlanDocumentV1 } from '../plans/schema';
import { validatePlanDocument } from '../plans/validator';
import type { SpecialistRoster } from '../specialists/registry';
import type { PlanView } from '../../../shared/types';
import { PlanProposalError } from '../plans/types';

/** Pause handoff §1: exported so tools/index.ts can name this factory-built
 *  tool's effect without building one (nativeToolEffect). */
export const PROPOSE_PLAN_TOOL_EFFECT: ToolEffect = 'local';

/**
 * The transient card uses the provider's tool id as its identity. WHY it is a
 * PlanView rather than another event: tool-use/tool-result already own transcript
 * pairing, while the plan field is the renderer's established card projection seam.
 */
/** Final review F18/F19: when the plan began being written (the header's
 *  clock), and whether a model on this computer is writing it (only then does
 *  the card say it can take minutes). */
export interface PlanShellFacts { startedAt?: number; local?: boolean }

export function writingPlanProjection(toolUseId: string, modelLabel: string, facts: PlanShellFacts = {}): PlanView {
  return {
    planId: `writing:${toolUseId}`,
    toolUseId,
    // Final review F20: a shell has no title of its own — the card names the
    // plan from the tool call's `goal`, and says "a plan" only without one.
    title: '',
    status: 'writing',
    steps: [],
    ceilingTokens: 0,
    ceilingUsd: null,
    model: { label: modelLabel, ...(facts.local ? { local: true } : {}) },
    ...(facts.startedAt !== undefined ? { startedAt: facts.startedAt } : {}),
    seq: 0,
  };
}

/** Final review F6: `failure.detail` is a reason written for people (shown on
 *  the card); `failure.report` is an unexpected error's own text (for the bug
 *  report only). Neither → the card's general line. */
export function failedPlanProjection(toolUseId: string, modelLabel: string, failure?: PlanView['failure'], facts: PlanShellFacts = {}): PlanView {
  return {
    ...writingPlanProjection(toolUseId, modelLabel, facts), status: 'failed', seq: 1,
    ...(failure && (failure.detail || failure.report) ? { failure } : {}),
  };
}

export function stoppedPlanProjection(toolUseId: string, modelLabel: string, facts: PlanShellFacts = {}): PlanView {
  return { ...writingPlanProjection(toolUseId, modelLabel, facts), status: 'stopped', seq: 1 };
}

/** Final review F6: the card's reason for a plan that failed validation. */
export const PLAN_INVALID_DETAIL = "The assistant's plan wasn't in a form the app can use.";
/** …for a propose_plan call the assistant never finished writing. */
export const PLAN_UNFINISHED_DETAIL = 'The assistant stopped before it finished writing the plan.';
/** …for a second plan sent in the same reply as an invalid one. */
export const PLAN_SIBLING_DETAIL = 'The assistant sent more than one plan at once, so this one wasn\'t used.';
const PLAN_NO_SERVICE_DETAIL = "Plans aren't available in this conversation.";

export function createProposePlanTool(roster: SpecialistRoster): NativeTool<PlanDocumentV1> {
  return defineTool<PlanDocumentV1>({
    name: 'propose_plan',
    // Pause handoff §1 (WHY): only writes this conversation's plan file; it changes this computer only, so a plan restart checks first.
    effect: PROPOSE_PLAN_TOOL_EFFECT,
    description:
      'Propose a bounded specialist plan for the user to approve. Use this when the work benefits from multiple independent specialists. '
      + 'Every step names a specialist and a hard per-child token budget. The proposal does not start work; it creates the approval card. '
      // Decision 30 (2026-09-18): the card's row was the first line of `task`,
      // a prompt written for a machine, so nothing in the plan ever addressed
      // the person pressing Approve. This is the only plan-writing instruction
      // besides the schema's own field descriptions, so it says it here too.
      + 'Give every step a `summary`: one plain sentence, in everyday words, telling the person approving the plan what that step does. '
      // Decision 33 (2026-09-18): the validator refuses a document whose whole
      // worst case is one specialist run, so the model must be told here too —
      // otherwise it reaches for a plan it cannot have and burns its one repair
      // on a shape no repair can fix.
      + 'A plan must be more than one specialist doing one thing: if the whole job is a single specialist run, hire a specialist directly instead of proposing a plan.',
    shortDescription: 'Propose a bounded multi-specialist plan for user approval.',
    inputSchema: PlanDocumentSchema,
    // Model-facing constrained decoding must stay byte-for-byte on the completed
    // grammar probe even though runtime Zod accepts custom live-roster ids.
    rawInputSchema: PLAN_DOCUMENT_JSON_SCHEMA as unknown as Record<string, unknown>,
    permissionSubject: () => undefined,
    async execute(input, ctx: ToolContext): Promise<ToolResultPayload> {
      const validated = validatePlanDocument(input, roster);
      if (!validated.ok) {
        return {
          text: `Plan validation failed:\n${validated.issues.map((issue) => `- ${issue}`).join('\n')}`,
          isError: true,
          planArgsInvalid: true,
          plan: failedPlanProjection(ctx.toolCallId ?? '', ctx.binding?.modelId ?? 'Unknown model', { detail: PLAN_INVALID_DETAIL }),
        };
      }
      const toolUseId = ctx.toolCallId ?? '';
      const modelLabel = ctx.binding?.modelId ?? 'Unknown model';
      const propose = ctx.services?.plans?.propose;
      if (!propose) {
        return {
          text: 'propose_plan failed: no plan proposal service is wired for this session (configuration error).',
          isError: true,
          plan: failedPlanProjection(toolUseId, modelLabel, { detail: PLAN_NO_SERVICE_DETAIL }),
        };
      }
      if (ctx.signal.aborted) {
        return {
          text: 'Canceled: the user interrupted this plan proposal.',
          isError: true,
          plan: stoppedPlanProjection(toolUseId, modelLabel),
        };
      }

      // Persistence belongs to Task 2. The service may prepare asynchronously,
      // but its durable write must be immediately preceded by this one-shot guard.
      // JavaScript's run-to-completion makes the abort check + latch atomic with
      // respect to an AbortSignal event: once interrupt wins, commit cannot.
      let committed = false;
      const commit = (): boolean => {
        if (committed || ctx.signal.aborted) return false;
        committed = true;
        return true;
      };
      let plan: PlanView;
      try {
        plan = await propose({
          sessionId: ctx.sessionId,
          toolUseId,
          document: validated.document,
          maximumAttempts: validated.maximumAttempts,
          ceilingTokens: validated.ceilingTokens,
          maxFanOut: validated.maxFanOut,
          signal: ctx.signal,
          commit,
        });
      } catch (err: any) {
        return {
          text: ctx.signal.aborted
            ? 'Canceled: the user interrupted this plan proposal.'
            : `propose_plan failed: ${err?.message ?? String(err)}`,
          isError: true,
          plan: ctx.signal.aborted
            ? stoppedPlanProjection(toolUseId, modelLabel)
            // Final review F6: a refusal worded for people is the card's
            // reason; anything else is general, its text kept for the report.
            : failedPlanProjection(toolUseId, modelLabel, err instanceof PlanProposalError
              ? { detail: err.message }
              : { report: String(err?.message ?? err) }),
        };
      }
      // WHY `committed` alone decides (Task 4, from the Task 2 review): once the
      // latch was taken the service wrote the plan durably, so a Stop that
      // lands afterwards must not relabel a real, approvable plan "Canceled" —
      // the card would contradict the journal. Only an uncommitted call fails.
      if (!committed) {
        return {
          text: ctx.signal.aborted
            ? 'Canceled: the user interrupted this plan proposal.'
            : 'propose_plan failed: the proposal service did not commit the plan.',
          isError: true,
          plan: ctx.signal.aborted
            ? stoppedPlanProjection(toolUseId, modelLabel)
            : failedPlanProjection(toolUseId, modelLabel, { report: 'propose_plan: the proposal service did not commit the plan.' }),
        };
      }
      return {
        text: `Plan proposed: ${plan.title}. Waiting for the user to approve or comment.`,
        isError: false,
        plan,
      };
    },
  });
}
