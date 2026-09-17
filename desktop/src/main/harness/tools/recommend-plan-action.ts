// Specialists plans, Task 9b — recommend_plan_action (pause handoff design §2).
//
// When a plan pauses on something that needs a decision, the host hands it to
// the assistant first: the plan card greys out, and a notice turn tells the
// assistant what happened. This tool is how the assistant answers — it puts the
// button it recommends on the card, with a short reason. It never presses the
// button: resuming, stopping and adding budget stay the user's (Destin,
// decision 13). Offered exactly where propose_plan is, never to specialists.
import { z } from 'zod';
import { defineTool } from './registry';
import type { NativeTool, ToolContext, ToolEffect, ToolResultPayload } from './types';

/** Pause handoff §1: it only writes this conversation's plan file. */
export const RECOMMEND_PLAN_ACTION_TOOL_EFFECT: ToolEffect = 'local';

const InputSchema = z.object({
  planId: z.string(),
  handoffId: z.string(),
  action: z.string(),
  addTokens: z.number().optional(),
  message: z.string(),
}).strict();
type RecommendInput = z.infer<typeof InputSchema>;

/** What the model sees (strict, like every native schema). The action enum is
 *  listed here for the model; the service is what enforces it per pause. */
const RAW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['planId', 'handoffId', 'action', 'message'],
  properties: {
    planId: { type: 'string', description: 'The "Plan id" from the plan pause notice.' },
    handoffId: { type: 'string', description: 'The "Handoff id" from the plan pause notice.' },
    action: {
      type: 'string', enum: ['add_budget', 'continue', 'stop'],
      description: 'The button you recommend. Only the actions the notice lists are accepted.',
    },
    addTokens: {
      type: 'integer', minimum: 1,
      description: 'add_budget only: how many tokens to add, within the range the notice gives.',
    },
    message: {
      type: 'string', maxLength: 280,
      description: 'One or two plain sentences for the user saying why (280 characters at most).',
    },
  },
} as const;

export const RECOMMEND_PLAN_ACTION_DESCRIPTION =
  'Only for answering a plan pause notice ("[Plan paused]"). Puts the button you recommend (add_budget, continue or stop) '
  + 'on the paused plan card, with a short message saying why. It does not press the button: the user decides. '
  + 'Use the plan id and handoff id from the notice. If it is refused, give your advice in chat instead.';

export function createRecommendPlanActionTool(): NativeTool<RecommendInput> {
  return defineTool<RecommendInput>({
    name: 'recommend_plan_action',
    effect: RECOMMEND_PLAN_ACTION_TOOL_EFFECT,
    description: RECOMMEND_PLAN_ACTION_DESCRIPTION,
    shortDescription: 'Recommend a button for a paused plan (answers a plan pause notice).',
    inputSchema: InputSchema,
    rawInputSchema: RAW_SCHEMA as unknown as Record<string, unknown>,
    // WHY no permission ask: it changes nothing but the card's suggestion; the
    // user's own button press is the consent (same reasoning as propose_plan).
    permissionSubject: () => undefined,
    async execute(input, ctx: ToolContext): Promise<ToolResultPayload> {
      const recommend = ctx.services?.plans?.recommend;
      if (!recommend) {
        return { text: 'recommend_plan_action failed: no plan service is wired for this session (configuration error). Give your advice to the user in chat instead.', isError: true };
      }
      const res = await recommend({
        sessionId: ctx.sessionId,
        planId: input.planId,
        handoffId: input.handoffId,
        action: input.action,
        ...(input.addTokens !== undefined ? { addTokens: input.addTokens } : {}),
        message: input.message,
      });
      if (!res.ok) {
        return { text: `Couldn't record that recommendation: ${res.error} Give your advice to the user in chat instead.`, isError: true };
      }
      return {
        text: 'Recommendation recorded. The plan card now shows the button you recommended; the user decides whether to press it. Tell the user briefly what you found.',
        isError: false,
      };
    },
  });
}
