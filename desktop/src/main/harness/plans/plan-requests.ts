import type {
  PlanActionResult, PlanAutoApproveRead, PlanFailure, PlanSettingsWriteResult,
} from '../../../shared/types';

/**
 * Specialists plans, Task 6 (design §5) — the ONE handler behind the eight
 * plan request channels (Task 11 added "Ask the assistant", pause handoff §6), shared by desktop IPC (ipc-handlers.ts) and the
 * remote WebSocket (remote-server.ts).
 *
 * WHY one shared function rather than two copies: the design promises that a
 * click on a phone and the same click on the computer reach the same plan
 * service and get the same answer back. Two hand-written copies drift — one
 * forgets a guard, or turns a thrown error into a different shape — and the
 * card then behaves differently depending on which screen you used. Both
 * transports now pass the raw payload straight here.
 *
 * Android has no native runtime and answers the same eight channels with a
 * typed `unsupported` refusal of its own (SessionService.kt → PlansBridge.kt).
 */

export const PLAN_REQUEST_CHANNELS = [
  'plans:approve',
  'plans:comment',
  'plans:add-budget',
  'plans:resume',
  'plans:stop',
  // Task 11 (pause handoff §6): the paused card's "Ask the assistant".
  'plans:ask-assistant',
  'plans:get-auto-approve',
  'plans:set-auto-approve',
] as const;

export type PlanRequestChannel = (typeof PLAN_REQUEST_CHANNELS)[number];

/** The push: `{ sessionId, plan: PlanView }`, one per visible journal change. */
export const PLANS_EVENT_CHANNEL = 'plans:event';

/** The slice of NativeSessionHost these channels need (Task 4 host API). */
export interface PlanRequestHost {
  approvePlan(sessionId: string, planId: string): Promise<PlanActionResult>;
  commentOnPlan(sessionId: string, planId: string, text: string): Promise<PlanActionResult>;
  addPlanBudget(sessionId: string, planId: string, tokens: number): Promise<PlanActionResult>;
  resumePlan(sessionId: string, planId: string): Promise<PlanActionResult>;
  stopPlan(sessionId: string, planId: string): Promise<PlanActionResult>;
  askAssistantAboutPlan(sessionId: string, planId: string, question?: string): Promise<PlanActionResult>;
  getPlanAutoApprove(): Promise<PlanAutoApproveRead>;
  setPlanAutoApprove(underTokens: unknown): Promise<PlanSettingsWriteResult>;
}

export type PlanRequestAnswer = PlanActionResult | PlanAutoApproveRead | PlanSettingsWriteResult;

// General and non-committal on purpose (docs/error-message-standards.md): these
// fire when we do NOT know what went wrong, so no cause is named. Same words the
// card already uses for an answer it can't read (plan-bridge.ts), so no new copy.
const ACTION_FAILED = "Couldn't update the plan. Please try again.";
const READ_FAILED = "Couldn't read the plan settings. Please try again.";
const WRITE_FAILED = "Couldn't save the plan settings. Please try again.";
/** The runtime isn't wired yet (a remote client that connected during startup).
 *  A plain failure, NOT `unsupported`: the card caches unsupported for the life
 *  of the window and disables itself, and this is only momentary. */
const NOT_CONNECTED = 'The assistant runtime isn’t connected.';

const fail = (error: string): PlanFailure => ({ ok: false, error });

function generalFailure(channel: PlanRequestChannel): PlanFailure {
  if (channel === 'plans:get-auto-approve') return fail(READ_FAILED);
  if (channel === 'plans:set-auto-approve') return fail(WRITE_FAILED);
  return fail(ACTION_FAILED);
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Run one plan request. Never throws and always answers one of the host's
 * three forms, whatever the payload or the host does.
 *
 * Only the ids are checked here: the text, the token amount and the settings
 * value are passed through untouched, because the plan service already
 * refuses bad ones with the exact reason the card shows.
 */
export async function handlePlanRequest(
  host: PlanRequestHost | null | undefined,
  channel: PlanRequestChannel,
  payload: unknown,
): Promise<PlanRequestAnswer> {
  if (!host) return fail(NOT_CONNECTED);
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  let answer: unknown;
  try {
    switch (channel) {
      case 'plans:get-auto-approve':
        answer = await host.getPlanAutoApprove();
        break;
      case 'plans:set-auto-approve':
        answer = await host.setPlanAutoApprove(p.underTokens);
        break;
      default: {
        // A card action with no session or plan id comes from a broken caller;
        // it must never reach the journal with `undefined` as a path part.
        if (!nonEmpty(p.sessionId) || !nonEmpty(p.planId)) return fail(ACTION_FAILED);
        const { sessionId, planId } = p;
        // `text` and `tokens` are cast, not checked: PlanService.comment and
        // .addBudget are the validators (empty or over-long comment, a token
        // amount that isn't a positive whole number, below the paused minimum)
        // and answer with the exact reason the card shows. Checking here too
        // would put a second, drifting copy of those rules in the transport.
        if (channel === 'plans:approve') answer = await host.approvePlan(sessionId, planId);
        else if (channel === 'plans:comment') answer = await host.commentOnPlan(sessionId, planId, p.text as string);
        else if (channel === 'plans:add-budget') answer = await host.addPlanBudget(sessionId, planId, p.tokens as number);
        else if (channel === 'plans:resume') answer = await host.resumePlan(sessionId, planId);
        // Decision 20: the typed question is passed through; the plan
        // service trims it and refuses one that is too long.
        else if (channel === 'plans:ask-assistant') answer = await host.askAssistantAboutPlan(sessionId, planId, p.question as string);
        else answer = await host.stopPlan(sessionId, planId);
      }
    }
  } catch (e) {
    // The host's own methods answer refusals as values; a throw here is
    // unexpected, so it is logged for whoever debugs it and the user gets the
    // general line rather than a raw system message.
    console.error(`[plans] ${channel} failed`, e);
    return generalFailure(channel);
  }
  // Anything that is not one of the three forms reads as a failure, never as
  // a success and never as a crash in the renderer.
  if (!answer || typeof answer !== 'object' || typeof (answer as { ok?: unknown }).ok !== 'boolean') {
    return generalFailure(channel);
  }
  return answer as PlanRequestAnswer;
}
