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
      const propose = ctx.services?.plans?.propose;
      if (!propose) {
        return { text: 'propose_plan failed: no plan proposal service is wired for this session (configuration error).', isError: true };
      }
      if (ctx.signal.aborted) return { text: 'Canceled: the user interrupted this plan proposal.', isError: true };

      // Persistence belongs to Task 2. WHY the tool only calls this structural
      // callback: tests can prove invalid/aborted inputs never touch durable state,
      // and the future PlanService remains the sole journal writer.
      const plan = await propose({
        sessionId: ctx.sessionId,
        toolUseId: ctx.toolCallId ?? '',
        document: validated.document,
        maximumAttempts: validated.maximumAttempts,
        ceilingTokens: validated.ceilingTokens,
        maxFanOut: validated.maxFanOut,
      });
      return {
        text: `Plan proposed: ${plan.title}. Waiting for the user to approve or comment.`,
        isError: false,
        plan,
      };
    },
  });
}
