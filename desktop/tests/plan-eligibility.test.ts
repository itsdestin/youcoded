import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { isPlanEligible } from '../src/main/harness/plans/eligibility';
import { HarnessSession } from '../src/main/harness/harness-session';
import { BUILTIN_ROSTER } from '../src/main/harness/specialists/registry';
import { CLOUD_DEFAULT, resolveProfile } from '../src/main/harness/capability-profile';
import { HARNESS, EMPTY_SKILL_CATALOG, FAKE_SESSION_CWD } from './helpers/harness-fakes';

const session = (overrides: Partial<Parameters<typeof isPlanEligible>[0]> = {}) => ({
  providerType: 'anthropic' as const,
  modelId: 'any-model',
  supportsTools: true,
  isSpecialistChild: false,
  ...overrides,
});

describe('plan eligibility', () => {
  it.each(['anthropic', 'openai', 'google', 'openrouter', 'chatgpt'] as const)('qualifies every cloud route with tools: %s', (providerType) => {
    expect(isPlanEligible(session({ providerType }))).toBe(true);
  });

  it('qualifies hosted OpenAI-compatible endpoints from provider-config provenance', () => {
    expect(isPlanEligible(session({
      providerType: 'openai-compatible',
      providerBaseUrl: 'https://api.groq.com/openai/v1',
    }))).toBe(true);
  });

  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:1234/v1',
    'http://192.168.1.40:8000/v1',
    'http://10.0.0.8:8080/v1',
    'http://172.20.0.2:9000/v1',
  ])('rejects local OpenAI-compatible endpoint %s regardless of model name', (providerBaseUrl) => {
    expect(isPlanEligible(session({
      providerType: 'openai-compatible',
      providerBaseUrl,
      modelId: 'cloud-sounding-model',
    }))).toBe(false);
  });

  it('fails closed for an OpenAI-compatible endpoint without config provenance', () => {
    expect(isPlanEligible(session({ providerType: 'openai-compatible' }))).toBe(false);
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

// Final review F28 (R1): the rule above is what a real session applies. A
// session the rule refuses is not given propose_plan (syncPlanTool), and one
// it accepts is — so an ineligible model can never be offered a plan.
describe('a real session applies it (syncPlanTool)', () => {
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [] }) }) });
  const toolsOf = (over: Record<string, unknown>) => {
    const s = new HarnessSession({
      sessionId: 's-elig', cwd: FAKE_SESSION_CWD, harness: HARNESS,
      binding: { providerId: 'openrouter', modelId: 'model' }, providerType: 'openrouter',
      profile: CLOUD_DEFAULT, tools: [], skillCatalog: EMPTY_SKILL_CATALOG, mcpServers: [],
      specialistRoster: BUILTIN_ROSTER, toolServices: { plans: { propose: async () => { throw new Error('unused'); } } },
      decide: async () => ({ action: 'allow', denyListed: false }), retryDelays: [],
      ...over,
    } as any, async () => model as any);
    return Object.keys((s as any).buildAiTools());
  };
  const local = (modelId: string) => ({
    providerType: 'local-engine', binding: { providerId: 'local', modelId },
    profile: resolveProfile({ providerType: 'local-engine', modelId, contextLength: 32_768 }),
  });

  it('a cloud session is offered propose_plan', () => {
    expect(toolsOf({})).toContain('propose_plan');
  });

  it.each([
    ['a small local model', local('Qwen3.5-2B-Q8_0')],
    ['a specialist', { isSpecialistChild: true }],
    ['a session with no provider provenance', { providerType: undefined }],
    ['a local OpenAI-compatible endpoint', { providerType: 'openai-compatible', providerBaseUrl: 'http://127.0.0.1:1234/v1' }],
  ])('%s is refused propose_plan', (_what, over) => {
    const tools = toolsOf(over);
    expect(tools).not.toContain('propose_plan');
    expect(tools).not.toContain('recommend_plan_action');
  });

  it('a reviewed 9B local model is offered it', () => {
    expect(toolsOf(local('Qwen3.5-9B-Q4_K_M'))).toContain('propose_plan');
  });
});
