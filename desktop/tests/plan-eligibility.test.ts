import { describe, expect, it } from 'vitest';
import { isPlanEligible } from '../src/main/harness/plans/eligibility';

const session = (overrides: Partial<Parameters<typeof isPlanEligible>[0]> = {}) => ({
  providerType: 'anthropic' as const,
  modelId: 'any-model',
  supportsTools: true,
  isSpecialistChild: false,
  ...overrides,
});

describe('plan eligibility', () => {
  it.each(['anthropic', 'openai', 'google', 'openrouter'] as const)('qualifies every cloud route with tools: %s', (providerType) => {
    expect(isPlanEligible(session({ providerType }))).toBe(true);
  });

  it('qualifies only reviewed 9B+ local registry entries', () => {
    expect(isPlanEligible(session({ providerType: 'local-engine', modelId: 'Qwen3.5-9B-Q8_0' }))).toBe(true);
    expect(isPlanEligible(session({ providerType: 'local-engine', modelId: 'Qwen3.5-27B-Q4' }))).toBe(true);
    expect(isPlanEligible(session({ providerType: 'local-engine', modelId: 'Qwen3.6-35B-A3B-Q4' }))).toBe(true);
  });

  it('fails closed for 2B, unreviewed 122B, Gemma, unknown local, tool-less, and child sessions', () => {
    expect(isPlanEligible(session({ providerType: 'local-engine', modelId: 'Qwen3.5-2B-Q8_0' }))).toBe(false);
    expect(isPlanEligible(session({ providerType: 'local-engine', modelId: 'Qwen3.5-122B-A10B-Q4_K_M' }))).toBe(false);
    expect(isPlanEligible(session({ providerType: 'local-engine', modelId: 'Qwen3.5-29B-Q4' }))).toBe(false);
    expect(isPlanEligible(session({ providerType: 'local-engine', modelId: 'unsloth_Qwen3.5_29B_GGUF' }))).toBe(false);
    expect(isPlanEligible(session({ providerType: 'local-engine', modelId: 'Qwen3.5-127B-Q4' }))).toBe(false);
    expect(isPlanEligible(session({ providerType: 'local-engine', modelId: 'unsloth_Qwen3.5_127B_GGUF' }))).toBe(false);
    expect(isPlanEligible(session({ providerType: 'local-engine', modelId: 'Gemma-4-27B-it-Q4' }))).toBe(false);
    expect(isPlanEligible(session({ providerType: 'local-engine', modelId: 'unreviewed-70b' }))).toBe(false);
    expect(isPlanEligible(session({ supportsTools: false }))).toBe(false);
    expect(isPlanEligible(session({ isSpecialistChild: true }))).toBe(false);
  });
});
