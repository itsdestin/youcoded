// Cache-token readings the AI SDK does not surface on its own (cache follow-ups
// item 8, backend half):
//   - llama.cpp reports how many prompt tokens it REUSED from its KV cache as
//     `timings.cache_n` on the final frame — the only ground truth for whether
//     the local prefix stayed still. The SDK's usage never sees it.
//   - OpenRouter reports cache WRITES as `prompt_tokens_details.cache_write_tokens`
//     for explicit-cache models (Claude); @ai-sdk/openai-compatible maps only
//     `cached_tokens` (reads), so writes read as 0 today.
// Both ride the SDK's metadataExtractor hook into providerMetadata, and one
// reader turns SDK usage + metadata into the step's cache numbers.
import { describe, it, expect } from 'vitest';
import { localTimingsExtractor, openRouterCostExtractor } from '../src/main/harness/pricing';
import { cacheTokensForStep } from '../src/main/harness/cache-usage';

describe('localTimingsExtractor', () => {
  it('carries llama.cpp cache_n off the final frame as cacheReadTokens', async () => {
    const x = localTimingsExtractor.createStreamExtractor();
    x.processChunk({ choices: [{ delta: { content: 'hi' } }] });
    x.processChunk({ choices: [], usage: { prompt_tokens: 251, completion_tokens: 24 }, timings: { cache_n: 236, prompt_n: 15, prompt_ms: 178.45 } });
    expect(x.buildMetadata()).toEqual({ local: { cacheReadTokens: 236 } });
  });
  it('reports NOTHING — not zero — when no frame carried timings', async () => {
    const x = localTimingsExtractor.createStreamExtractor();
    x.processChunk({ choices: [{ delta: { content: 'hi' } }] });
    expect(x.buildMetadata()).toBeUndefined();
  });
  it('a zero cache_n is a real reading (a cold prompt), kept as 0', async () => {
    const x = localTimingsExtractor.createStreamExtractor();
    x.processChunk({ timings: { cache_n: 0, prompt_n: 15 } });
    expect(x.buildMetadata()).toEqual({ local: { cacheReadTokens: 0 } });
  });
  it('non-streaming: reads the same block off the whole body', async () => {
    expect(await localTimingsExtractor.extractMetadata({ parsedBody: { timings: { cache_n: 9 } } })).toEqual({ local: { cacheReadTokens: 9 } });
    expect(await localTimingsExtractor.extractMetadata({ parsedBody: { usage: {} } })).toBeUndefined();
  });
});

describe('openRouterCostExtractor cache writes', () => {
  it('carries cache_write_tokens beside the cost, and only when present', async () => {
    const x = openRouterCostExtractor.createStreamExtractor();
    x.processChunk({ usage: { cost: 0.5, prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 40 } } });
    expect(x.buildMetadata()).toEqual({ openrouter: { costUsd: 0.5, cacheWriteTokens: 40 } });
    const y = openRouterCostExtractor.createStreamExtractor();
    y.processChunk({ usage: { cost: 0.5, prompt_tokens_details: { cached_tokens: 100 } } });
    expect(y.buildMetadata()).toEqual({ openrouter: { costUsd: 0.5 } });
  });
});

describe('cacheTokensForStep', () => {
  it('prefers the SDK usage when it carries cache numbers', () => {
    expect(cacheTokensForStep({ inputTokenDetails: { cacheReadTokens: 10, cacheWriteTokens: 3 } } as any, { local: { cacheReadTokens: 99 } }))
      .toEqual({ cacheReadTokens: 10, cacheCreationTokens: 3 });
  });
  it('falls back to llama.cpp cache_n when the SDK saw no cached_tokens', () => {
    expect(cacheTokensForStep({ inputTokenDetails: { cacheReadTokens: 0 } } as any, { local: { cacheReadTokens: 236 } }))
      .toEqual({ cacheReadTokens: 236, cacheCreationTokens: 0 });
  });
  it('falls back to OpenRouter cache_write_tokens for writes', () => {
    expect(cacheTokensForStep({ inputTokenDetails: { cacheReadTokens: 100, cacheWriteTokens: 0 } } as any, { openrouter: { costUsd: 0.5, cacheWriteTokens: 40 } }))
      .toEqual({ cacheReadTokens: 100, cacheCreationTokens: 40 });
  });
  it('zeros when nothing reported anything', () => {
    expect(cacheTokensForStep(undefined, undefined)).toEqual({ cacheReadTokens: 0, cacheCreationTokens: 0 });
  });
});
