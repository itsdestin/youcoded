import { matchKnownModel } from '../known-models';
import type { ProfileProviderType } from '../capability-profile';

export interface PlanEligibilitySession {
  providerType: ProfileProviderType;
  /** Provider-registry provenance for compatible endpoints. The binding itself
   * carries no locality fact, so eligibility must inspect the configured URL. */
  providerBaseUrl?: string;
  modelId: string;
  supportsTools: boolean;
  isSpecialistChild: boolean;
}

const CLOUD_PROVIDERS: ReadonlySet<ProfileProviderType> = new Set(['anthropic', 'openai', 'google', 'openrouter']);

/** Classify only from provider configuration, never from a model id. Loopback,
 * link-local and RFC1918 hosts are local; an unparseable/missing URL fails closed. */
function isHostedCompatibleEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname === '::1' || hostname.endsWith('.localhost')) return false;
    if (/^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname)) return false;
    const v4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
    if (v4) {
      if (v4.some((octet) => octet > 255)) return false;
      if (v4[0] === 169 && v4[1] === 254) return false;
      if (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) return false;
      if (v4[0] === 0) return false;
    }
    // Unique-local and link-local IPv6 ranges. Other globally routable IPv6
    // endpoints are hosted just like public DNS names.
    if (/^(?:fc|fd)/.test(hostname) || /^fe[89ab]/.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

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
  if (session.providerType === 'openai-compatible') {
    return isHostedCompatibleEndpoint(session.providerBaseUrl);
  }
  if (session.providerType !== 'local-engine') return false;

  const known = matchKnownModel(session.modelId);
  return known?.supportsTools === true && REVIEWED_LOCAL_9B_PLUS.has(known.label);
}
