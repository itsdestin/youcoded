import { matchKnownModel } from '../known-models';
import type { ProfileProviderType } from '../capability-profile';

export interface PlanEligibilitySession {
  providerType: ProfileProviderType;
  modelId: string;
  supportsTools: boolean;
  isSpecialistChild: boolean;
}

const CLOUD_PROVIDERS: ReadonlySet<ProfileProviderType> = new Set(['anthropic', 'openai', 'google', 'openrouter']);

/**
 * Reviewed local families only. WHY this is deliberately narrower than generic
 * tool support: grammar evidence exists for Qwen 3.5 9B and Qwen 3.6 35B, and
 * the reviewed 27B local entry; unknown/Gemma entries must fail closed until
 * model-information metadata supplies an explicit big-local classification.
 */
const REVIEWED_LOCAL_9B_PLUS: ReadonlySet<string> = new Set([
  'Qwen 3.5 9B',
  'Qwen 3.5 27B',
  'Qwen 3.6 MoE',
]);

export function isPlanEligible(session: PlanEligibilitySession): boolean {
  // WHY children never receive plan authoring: depth-by-omission prevents a
  // specialist from spawning more specialists through a nested plan.
  if (session.isSpecialistChild || !session.supportsTools) return false;
  if (CLOUD_PROVIDERS.has(session.providerType)) return true;
  if (session.providerType !== 'local-engine') return false;

  const known = matchKnownModel(session.modelId);
  return known?.supportsTools === true && REVIEWED_LOCAL_9B_PLUS.has(known.label);
}
