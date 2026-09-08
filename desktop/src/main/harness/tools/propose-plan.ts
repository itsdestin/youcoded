import { defineTool } from './registry';
import type { NativeTool, ToolContext, ToolResultPayload } from './types';
import { PLAN_DOCUMENT_JSON_SCHEMA, PlanDocumentSchema, type PlanDocumentV1 } from '../plans/schema';
import { validatePlanDocument } from '../plans/validator';
import type { SpecialistRoster } from '../specialists/registry';
import type { PlanView } from '../../../shared/types';

/**
 * The transient card uses the provider's tool id as its identity. WHY it is a
 * PlanView rather than another event: tool-use/tool-result already own transcript
 * pairing, while the plan field is the renderer's established card projection seam.
 */
export function writingPlanProjection(toolUseId: string, modelLabel: string): PlanView {
  return {
    planId: `writing:${toolUseId}`,
    toolUseId,
    title: 'a plan',
    status: 'writing',
    steps: [],
    ceilingTokens: 0,
    ceilingUsd: null,
    model: { label: modelLabel },
    seq: 0,
  };
}

export function failedPlanProjection(toolUseId: string, modelLabel: string): PlanView {
  return { ...writingPlanProjection(toolUseId, modelLabel), status: 'failed', seq: 1 };
}

export function stoppedPlanProjection(toolUseId: string, modelLabel: string): PlanView {
  return { ...writingPlanProjection(toolUseId, modelLabel), status: 'stopped', seq: 1 };
}

export function createProposePlanTool(roster: SpecialistRoster): NativeTool<PlanDocumentV1> {
  return defineTool<PlanDocumentV1>({
    name: 'propose_plan',
    description:
      'Propose a bounded specialist plan for the user to approve. Use this when the work benefits from multiple independent specialists. '
      + 'Every step names a specialist and a hard per-child token budget. The proposal does not start work; it creates the approval card.',
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
        };
      }
      const toolUseId = ctx.toolCallId ?? '';
      const modelLabel = ctx.binding?.modelId ?? 'Unknown model';
      const propose = ctx.services?.plans?.propose;
      if (!propose) {
        return {
          text: 'propose_plan failed: no plan proposal service is wired for this session (configuration error).',
          isError: true,
          plan: failedPlanProjection(toolUseId, modelLabel),
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
            : failedPlanProjection(toolUseId, modelLabel),
        };
      }
      if (ctx.signal.aborted || !committed) {
        return {
          text: ctx.signal.aborted
            ? 'Canceled: the user interrupted this plan proposal.'
            : 'propose_plan failed: the proposal service did not commit the plan.',
          isError: true,
          plan: ctx.signal.aborted
            ? stoppedPlanProjection(toolUseId, modelLabel)
            : failedPlanProjection(toolUseId, modelLabel),
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
