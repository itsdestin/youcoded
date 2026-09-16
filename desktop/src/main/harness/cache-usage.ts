// One reader for "how much of this step's prompt came from cache", across the
// three places providers put the answer (cache follow-ups item 8, 2026-09-10).
//
// WHY: the AI SDK's LanguageModelUsage carries cache reads/writes only when the
// provider package maps them. @ai-sdk/openai-compatible maps OpenRouter's
// `cached_tokens` (reads) but not `cache_write_tokens` (writes), and it never
// sees llama.cpp's `timings.cache_n`, which is the ONLY ground truth for local
// KV reuse. Those two ride providerMetadata (pricing.ts extractors) and are
// read here as fallbacks. The SDK's own number wins whenever it is non-zero.
import type { LanguageModelUsage } from 'ai';

export interface StepCacheTokens { cacheReadTokens: number; cacheCreationTokens: number }

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function cacheTokensForStep(
  usage: LanguageModelUsage | undefined,
  meta: Record<string, Record<string, unknown>> | undefined | null,
): StepCacheTokens {
  const sdkRead = count(usage?.inputTokenDetails?.cacheReadTokens);
  const sdkWrite = count(usage?.inputTokenDetails?.cacheWriteTokens);
  return {
    cacheReadTokens: sdkRead || count(meta?.local?.cacheReadTokens),
    cacheCreationTokens: sdkWrite || count(meta?.openrouter?.cacheWriteTokens),
  };
}
