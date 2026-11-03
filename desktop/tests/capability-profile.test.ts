import { describe, it, expect } from 'vitest';
import { resolveProfile, effectiveContextForModel, CLOUD_DEFAULT, IMAGE_LIMITS_OPENAI, type DiscoveredModel } from '../src/main/harness/capability-profile';
import type { KnownModelEntry } from '../src/main/harness/known-models';
import { HOSTED_MAX_CONCURRENT_SPECIALISTS } from '../src/main/harness/specialists/limits';
import type { ProviderType } from '../src/shared/provider-types';

const MOE: KnownModelEntry[] = [{ match: 'qwen3\\.6.*35b.*moe', label: 'Qwen 3.6 35B MoE', maxToolPresentation: 'full', supportsTools: true }];
const local = (modelId: string, contextLength: number | null): DiscoveredModel => ({ providerType: 'local-engine', modelId, contextLength });

describe('resolveProfile — Layer selection', () => {
  it('cloud provider → full presentation, variant by type, no local constraint', () => {
    const a = resolveProfile({ providerType: 'anthropic', modelId: 'x', contextLength: 200_000 });
    expect(a.maxToolPresentation).toBe('full');
    expect(a.promptVariant).toBe('anthropic');
    expect(a.constrainToolArgs).toBe(false);
    expect(a.supportsTools).toBe(true);
    expect(resolveProfile({ providerType: 'openai', modelId: 'x', contextLength: 128_000 }).promptVariant).toBe('gpt');
    expect(resolveProfile({ providerType: 'openrouter', modelId: 'x', contextLength: 128_000 }).promptVariant).toBe('default');
  });

  it('unknown local model → conservative fallback tiered by REAL context window', () => {
    const small = resolveProfile(local('mystery-3b', 8_192));
    expect(small.maxToolPresentation).toBe('simplified');
    expect(small.promptVariant).toBe('local-small');
    expect(small.doomLoopThreshold).toBe(2);
    expect(small.supportsParallelToolCalls).toBe(false);
    expect(small.constrainToolArgs).toBe(true);

    const large = resolveProfile(local('mystery-120b', 131_072));
    expect(large.maxToolPresentation).toBe('full');
    expect(large.promptVariant).toBe('default');
    expect(large.doomLoopThreshold).toBe(3);
  });

  it('a KNOWN local model overlays registry tuning on the fallback (MoE ≠ dense at the same window)', () => {
    const registry: KnownModelEntry[] = [
      { match: 'qwen3\\.6.*35b.*moe', label: 'Qwen 3.6 35B MoE', maxToolPresentation: 'full', doomLoopThreshold: 3, supportsTools: true },
      { match: 'qwen3\\.5.*9b',       label: 'Qwen 3.5 9B',      maxToolPresentation: 'simplified', doomLoopThreshold: 2, supportsTools: true },
    ];
    const moe = resolveProfile(local('qwen3.6-35b-moe-q4', 32_768), registry);
    const dense = resolveProfile(local('qwen3.5-9b-q4', 32_768), registry);
    expect(moe.maxToolPresentation).toBe('full');
    expect(dense.maxToolPresentation).toBe('simplified');
    expect(moe.constrainToolArgs).toBe(true);
  });

  it('a registry entry marking supportsTools:false runs the model as plain chat', () => {
    const registry: KnownModelEntry[] = [{ match: 'no-tools-model', label: 'X', supportsTools: false }];
    expect(resolveProfile(local('no-tools-model', 8_192), registry).supportsTools).toBe(false);
  });

  it('null/unknown context is treated as small (conservative)', () => {
    expect(resolveProfile(local('x', null)).maxToolPresentation).toBe('simplified');
  });
});

describe('effectiveContextForModel', () => {
  const reg = [{ match: 'tiny-model', label: 'Tiny', maxContextWindow: 8192, supportsTools: true }];
  it('clamps a loaded window down to a known model ceiling', () => {
    expect(effectiveContextForModel(32_768, 'tiny-model-q4', reg)).toBe(8192);
  });
  it('passes through when loaded is under the ceiling or the model is unknown', () => {
    expect(effectiveContextForModel(4096, 'tiny-model-q4', reg)).toBe(4096);
    expect(effectiveContextForModel(32_768, 'unknown-model', reg)).toBe(32_768);
  });
  it('uses the ceiling when the loaded window is unknown', () => {
    expect(effectiveContextForModel(null, 'tiny-model-q4', reg)).toBe(8192);
    expect(effectiveContextForModel(null, 'unknown-model', reg)).toBe(null);
  });
});

// nativeImageToolResults is a PROVIDER-TYPE fact (can the wire carry an image inside a tool_result?): only direct Anthropic can.
// Every ProfileProviderType is listed so a new provider type must be triaged here.
describe('nativeImageToolResults', () => {
  it('is true only for the direct Anthropic provider', () => {
    expect(resolveProfile({ providerType: 'anthropic', modelId: 'claude-opus-5', contextLength: 200_000 }).nativeImageToolResults).toBe(true);
    for (const providerType of ['openai', 'google', 'openrouter', 'openai-compatible', 'local-engine', 'chatgpt'] as const) {
      expect(resolveProfile({ providerType, modelId: 'x', contextLength: 32_768 }).nativeImageToolResults, providerType).toBe(false);
    }
  });

  it('a KNOWN local model cannot override it — the registry has no such field', () => {
    expect(resolveProfile(local('qwen3.6-35b-moe-q4', 32_768), MOE).nativeImageToolResults).toBe(false);
  });
});

// canDelegate gates whether the Task tool is attached at all (a weak orchestrator serial-collapses delegated work).
describe('canDelegate', () => {
  it('frontier/cloud providers default to true', () => {
    expect(CLOUD_DEFAULT.canDelegate).toBe(true);
    expect(resolveProfile({ providerType: 'anthropic', modelId: 'claude-opus-5', contextLength: 200_000 }).canDelegate).toBe(true);
    expect(resolveProfile({ providerType: 'openai', modelId: 'x', contextLength: 128_000 }).canDelegate).toBe(true);
    expect(resolveProfile({ providerType: 'openrouter', modelId: 'x', contextLength: 128_000 }).canDelegate).toBe(true);
  });

  it('the conservative fallback for an UNKNOWN local model cannot delegate, even at a large window', () => {
    expect(resolveProfile(local('mystery-3b', 8_192)).canDelegate).toBe(false);
    expect(resolveProfile(local('mystery-120b', 131_072)).canDelegate).toBe(false);
  });

  it('a known local model tuned to simplified presentation cannot delegate', () => {
    const registry: KnownModelEntry[] = [
      { match: 'qwen3\\.5.*9b', label: 'Qwen 3.5 9B', maxToolPresentation: 'simplified', doomLoopThreshold: 2, supportsTools: true },
    ];
    expect(resolveProfile(local('qwen3.5-9b-q4', 32_768), registry).canDelegate).toBe(false);
  });

  it('a known local model tuned to full presentation CAN delegate', () => {
    const registry: KnownModelEntry[] = [
      { match: 'qwen3\\.6.*35b.*moe', label: 'Qwen 3.6 35B MoE', maxToolPresentation: 'full', doomLoopThreshold: 3, supportsTools: true },
    ];
    expect(resolveProfile(local('qwen3.6-35b-moe-q4', 32_768), registry).canDelegate).toBe(true);
  });
});

describe('capability profile — injection sizing (M3 item 5)', () => {
  it('a large local window gets the skill catalog and a generous budget', () => {
    const p = resolveProfile(local('qwen3.6-122b', 128_000));
    expect(p.exposeSkillCatalog).toBe(true);
    expect(p.injectionBudgetTokens).toBeGreaterThan(10_000);
  });

  it('a small local window does NOT — the catalog rides every single turn', () => {
    const p = resolveProfile(local('gemma-3n', 8_192));
    expect(p.exposeSkillCatalog).toBe(false);
    expect(p.injectionBudgetTokens).toBeLessThan(4_000);
  });

  it('a mid local window gets the catalog but a tighter injection budget', () => {
    const p = resolveProfile(local('some-35b', 64_000));
    expect(p.exposeSkillCatalog).toBe(true);
    expect(p.injectionBudgetTokens).toBeLessThan(10_000);
  });

  it('an UNMEASURED local window is treated as small — never assume room', () => {
    const p = resolveProfile(local('mystery', null));
    expect(p.exposeSkillCatalog).toBe(false);
  });

  it('an openai-compatible endpoint is sized like local — it is usually Ollama', () => {
    // provider-registry documents this type as "Ollama / LM Studio run keyless".
    // Treating an unmeasured one as roomy would hand a 4k model a skill catalog.
    const p = resolveProfile({ providerType: 'openai-compatible', modelId: 'whatever', contextLength: null });
    expect(p.exposeSkillCatalog).toBe(false);
  });

  it('a FRONTIER provider stays generous even with no measured window', () => {
    // We never discover Anthropic's window, so null there means "not measured",
    // not "small" — sizing it down would break the main use case.
    for (const providerType of ['anthropic', 'openai', 'google', 'openrouter', 'chatgpt'] as const) {
      const p = resolveProfile({ providerType, modelId: 'm', contextLength: null });
      expect(p.exposeSkillCatalog, providerType).toBe(true);
      expect(p.injectionBudgetTokens, providerType).toBeGreaterThan(10_000);
    }
  });

  it('the registry ceiling sizes a model loaded past its real window', () => {
    // A 8k model loaded at -c 128000 must not be judged roomy: sizing runs on the
    // EFFECTIVE window, the same clamp the rest of the profile uses.
    const reg = [{ match: 'tiny-model', label: 'Tiny', maxContextWindow: 8192, supportsTools: true }];
    const p = resolveProfile(local('tiny-model-q4', 128_000), reg);
    expect(p.exposeSkillCatalog).toBe(false);
  });

  it('the cloud default carries the catalog and a large budget', () => {
    expect(CLOUD_DEFAULT.exposeSkillCatalog).toBe(true);
    expect(CLOUD_DEFAULT.injectionBudgetTokens).toBeGreaterThan(10_000);
  });
});

// WHY: Qwen 3.5 2B with `-c 128000` got the full Skill catalog and spent its turn reciting all twelve skills; window size answers "can it afford the catalog?", not "should it choose skills?".
describe('capability gating — a big window does not make a small model capable', () => {
  it('a 2B model with a 128k window does NOT get the skill catalog', () => {
    const p = resolveProfile(local('Qwen3.5-2B-Q8_0', 128_000));
    expect(p.maxToolPresentation).toBe('simplified');
    expect(p.exposeSkillCatalog).toBe(false);
  });

  it('a model marked simplified never gets it, however much room it has', () => {
    const reg = [{ match: 'weak-model', label: 'Weak', maxToolPresentation: 'simplified' as const, supportsTools: true }];
    expect(resolveProfile(local('weak-model-q8', 1_000_000), reg).exposeSkillCatalog).toBe(false);
  });

  it('a capable local model with room still gets it', () => {
    const reg = [{ match: 'strong-model', label: 'Strong', maxToolPresentation: 'full' as const, supportsTools: true }];
    expect(resolveProfile(local('strong-model-q8', 128_000), reg).exposeSkillCatalog).toBe(true);
  });

  it('a capable model with a SMALL window still does not — room is still required', () => {
    const reg = [{ match: 'strong-model', label: 'Strong', maxToolPresentation: 'full' as const, supportsTools: true }];
    expect(resolveProfile(local('strong-model-q8', 8_192), reg).exposeSkillCatalog).toBe(false);
  });

  it('the injection BUDGET still tracks the window, not capability', () => {
    // A weak model with a big window can still be handed a long skill body by
    // /skill-name — it just is not trusted to pick one unprompted.
    const p = resolveProfile(local('Qwen3.5-2B-Q8_0', 128_000));
    expect(p.injectionBudgetTokens).toBeGreaterThan(10_000);
  });

  it('cloud models are unaffected', () => {
    expect(resolveProfile({ providerType: 'anthropic', modelId: 'm', contextLength: null }).exposeSkillCatalog).toBe(true);
  });
});

// Pin the exact mcpToolBudgetTokens integers per tier (mcp-gating.test.ts only asserts which servers survive), plus the frontier shortcut and registry-ceiling clamp.
describe('mcpToolBudgetTokens ladder', () => {
  it.each([
    ['an unmeasured/null window', null, 750],
    ['a small window (< 32,768)', 8_192, 750],
    ['a mid window (>= 32,768, < 100,000)', 64_000, 4_000],
    ['a large window (>= 100,000)', 128_000, 20_000],
  ])('%s gets its tier', (_n, window, tokens) => {
    expect(resolveProfile(local('m', window)).mcpToolBudgetTokens).toBe(tokens);
  });

  it('a FRONTIER provider with an unmeasured window stays at CLOUD_DEFAULT, not the small tier', () => {
    for (const providerType of ['anthropic', 'openai', 'google', 'openrouter', 'chatgpt'] as const) {
      expect(resolveProfile({ providerType, modelId: 'm', contextLength: null }).mcpToolBudgetTokens, providerType)
        .toBe(CLOUD_DEFAULT.mcpToolBudgetTokens);
    }
  });

  it('a MEASURED small window on a hosted (non-frontier-exempt) provider is gated exactly like local', () => {
    // openai-compatible is deliberately not a FRONTIER_PROVIDER (it's the
    // Ollama/LM Studio shape), so a real measured 8k window there must land
    // on the same small tier a local model would.
    const p = resolveProfile({ providerType: 'openai-compatible', modelId: 'm', contextLength: 8_000 });
    expect(p.mcpToolBudgetTokens).toBe(750);
  });

  it('the registry ceiling clamps the window for EVERY provider, not only local-engine', () => {
    // WHY: mcpBudgetSizing once clamped only for local-engine, so an openai-compatible endpoint with a big declared window and a tiny-model id got 20,000 tokens of tool schema on an 8k model.
    const reg: KnownModelEntry[] = [{ match: 'tiny-model', label: 'Tiny', maxContextWindow: 8192, supportsTools: true }];
    const p = resolveProfile({ providerType: 'openai-compatible', modelId: 'tiny-model-q4', contextLength: 131_072 }, reg);
    expect(p.mcpToolBudgetTokens).toBe(750);                 // clamped to the 8192 ceiling -> smallest tier
    expect(p.injectionBudgetTokens).toBeLessThan(10_000);     // the clamp injectionSizing already applied
  });
});

// supportsVision precedence: (1) KNOWN_MODELS registry, (2) the catalog's discovered value, (3) VISION_PROVIDERS provider default.
describe('supportsVision — three-level precedence (registry > discovered > provider default)', () => {
  it('a discovered true from the catalog wins over the provider default (openrouter has no default)', () => {
    const d: DiscoveredModel = { providerType: 'openrouter', modelId: 'some/vision-model', contextLength: 128_000, supportsVision: true };
    expect(resolveProfile(d).supportsVision).toBe(true);
  });

  it('a discovered false from the catalog wins over the provider default', () => {
    // anthropic IS in VISION_PROVIDERS (default true), so only a real "discovered false overrides" path passes (an openrouter binding passes with the feature deleted).
    const d: DiscoveredModel = { providerType: 'anthropic', modelId: 'some/model', contextLength: 128_000, supportsVision: false };
    expect(resolveProfile(d).supportsVision).toBe(false);
  });

  it('an UNDEFINED discovered value leaves today\'s behavior exactly as it was (provider-default fallback)', () => {
    const d: DiscoveredModel = { providerType: 'openrouter', modelId: 'some/unknown-model', contextLength: 128_000 };
    // No registry opinion, no discovered opinion -> VISION_PROVIDERS.has('openrouter') -> false.
    expect(resolveProfile(d).supportsVision).toBe(false);
    // Same for a provider VISION_PROVIDERS DOES claim, to prove the fallback path is unchanged.
    const anthropicD: DiscoveredModel = { providerType: 'anthropic', modelId: 'claude-opus-5', contextLength: 200_000 };
    expect(resolveProfile(anthropicD).supportsVision).toBe(true);
  });

  it('the KNOWN_MODELS registry beats a discovered value in either direction', () => {
    const registryVisionTrue: KnownModelEntry[] = [{ match: 'special-vision-model', label: 'X', supportsVision: true }];
    const registryVisionFalse: KnownModelEntry[] = [{ match: 'special-novision-model', label: 'X', supportsVision: false }];
    // Registry says true, discovered says false -> registry wins.
    expect(resolveProfile(
      { providerType: 'openrouter', modelId: 'special-vision-model', contextLength: 128_000, supportsVision: false },
      registryVisionTrue,
    ).supportsVision).toBe(true);
    // Registry says false, discovered says true -> registry wins.
    expect(resolveProfile(
      { providerType: 'openrouter', modelId: 'special-novision-model', contextLength: 128_000, supportsVision: true },
      registryVisionFalse,
    ).supportsVision).toBe(false);
  });
});

// Local specialist concurrency comes from the engine's measured slot count (clamped to [1, 4]); an UNKNOWN local model gets the floor unconditionally; hosted gets the flat spec constant.
describe('maxConcurrentSpecialists — local concurrency from the engine, hosted from the profile', () => {
  it('hosted/cloud providers get the flat spec constant', () => {
    // WHY pin the literal 4: comparing CLOUD_DEFAULT to the imported constant alone is a symbol compared with itself and survives a nonsense value; the equality below still catches a hardcoded literal.
    expect(HOSTED_MAX_CONCURRENT_SPECIALISTS).toBe(4);
    expect(CLOUD_DEFAULT.maxConcurrentSpecialists).toBe(HOSTED_MAX_CONCURRENT_SPECIALISTS);
    for (const providerType of ['anthropic', 'openai', 'google', 'openrouter', 'chatgpt'] as const) {
      expect(resolveProfile({ providerType, modelId: 'x', contextLength: 128_000 }).maxConcurrentSpecialists, providerType)
        .toBe(HOSTED_MAX_CONCURRENT_SPECIALISTS);
    }
  });

  it('an UNKNOWN local model gets the conservative floor of 1, even when a live slot count is provided', () => {
    expect(resolveProfile(local('mystery-3b', 8_192)).maxConcurrentSpecialists).toBe(1);
    expect(resolveProfile({ providerType: 'local-engine', modelId: 'mystery-3b', contextLength: 8_192, totalSlots: 4 }).maxConcurrentSpecialists).toBe(1);
  });

  it.each([[4, 4], [2, 2], [8, 4], [0, 1]])('a KNOWN local model reporting %s slots gets %s specialists (clamped to 1-4)', (totalSlots, expected) => {
    expect(resolveProfile({ providerType: 'local-engine', modelId: 'qwen3.6-35b-moe-q4', contextLength: 32_768, totalSlots }, MOE).maxConcurrentSpecialists).toBe(expected);
  });

  it('a KNOWN local model with NO slot count on this build falls back to 1, not the ceiling', () => {
    // totalSlots absent entirely (the DiscoveredModel never set it).
    expect(resolveProfile(local('qwen3.6-35b-moe-q4', 32_768), MOE).maxConcurrentSpecialists).toBe(1);
    // totalSlots explicitly null (the /props read ran but reported nothing).
    expect(resolveProfile({ providerType: 'local-engine', modelId: 'qwen3.6-35b-moe-q4', contextLength: 32_768, totalSlots: null }, MOE).maxConcurrentSpecialists).toBe(1);
  });
});

// announcePrefill ("Reading your prompt") is for models on the user's OWN hardware, where prefill is a minutes-long silence; a provider-type fact no registry entry overrides.
describe('announcePrefill — the prompt-reading notice is local-only', () => {
  it('is false for every hosted provider', () => {
    for (const providerType of ['anthropic', 'openai', 'google', 'openrouter', 'chatgpt'] as const) {
      expect(resolveProfile({ providerType, modelId: 'x', contextLength: 128_000 }).announcePrefill, providerType).toBe(false);
    }
    expect(CLOUD_DEFAULT.announcePrefill).toBe(false);
  });

  it('is true for the local engine, known model or not', () => {
    expect(resolveProfile(local('mystery-3b', 8_192)).announcePrefill).toBe(true);
    expect(resolveProfile(local('qwen3.6-35b-moe-q4', 131_072), MOE).announcePrefill).toBe(true);
  });

  it('is true for openai-compatible — the Ollama / LM Studio shape is a local model in disguise', () => {
    // Same reasoning FRONTIER_PROVIDERS uses to exclude this type from the
    // "assume a roomy window" shortcut.
    expect(resolveProfile({ providerType: 'openai-compatible', modelId: 'llama3.3:70b', contextLength: null }).announcePrefill).toBe(true);
  });
});

// WHY: the harness once had no 'chatgpt' provider kind, so a plan model fell through to the "unmeasured local model" path and behaved like a small local model.
describe("Sign in with ChatGPT — the harness knows the 'chatgpt' provider", () => {
  it('a plan GPT-5.6 with no measured window gets frontier sizing, the GPT prompt and vision', () => {
    // contextLength: null is the real production shape — the plan's manifest
    // may not report a window, and null must mean "not measured", never "small".
    const p = resolveProfile({ providerType: 'chatgpt', modelId: 'gpt-5.6', contextLength: null });
    expect(p.exposeSkillCatalog).toBe(true);
    // 20,000 is CLOUD_DEFAULT.injectionBudgetTokens — the frontier tier every
    // hosted provider gets; asserted literally so the pinned §4.8 number holds.
    expect(p.injectionBudgetTokens).toBe(20_000);
    expect(p.promptVariant).toBe('gpt');
    expect(p.supportsVision).toBe(true);
    // The rest of the hosted defaults come along too — same as any frontier provider.
    expect(p.mcpToolBudgetTokens).toBe(CLOUD_DEFAULT.mcpToolBudgetTokens);
    expect(p.canDelegate).toBe(true);
    expect(p.supportsParallelToolCalls).toBe(true);
    expect(p.maxToolPresentation).toBe('full');
  });

  it('is identical to the direct OpenAI-key profile for the same GPT model — same models, same wire', () => {
    for (const modelId of ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini']) {
      for (const contextLength of [null, 272_000]) {
        // WHY outputCap is set aside: the plan's endpoint refuses any output cap (chatgpt-model.ts),
        // so it carries none; a direct key gets its policy cap. providerType just echoes the input.
        const { outputCap: _keyCap, ...viaKey } = resolveProfile({ providerType: 'openai', modelId, contextLength });
        expect(resolveProfile({ providerType: 'chatgpt', modelId, contextLength }), `${modelId} @ ${contextLength}`)
          .toEqual({ ...viaKey, providerType: 'chatgpt' });
      }
    }
  });

  it('matches the OpenRouter profile for the same GPT model except where OpenRouter is only a transport', () => {
    // Sizing must equal OpenRouter's; the deliberate differences are the GPT prompt overlay and vision (OpenRouter's comes from its catalog fact).
    const viaPlan = resolveProfile({ providerType: 'chatgpt', modelId: 'gpt-5.6', contextLength: null });
    const viaOpenRouter = resolveProfile({ providerType: 'openrouter', modelId: 'openai/gpt-5.6', contextLength: null, supportsVision: true });
    expect(viaPlan.injectionBudgetTokens).toBe(viaOpenRouter.injectionBudgetTokens);
    // WHY imageLimits differs: it is a provider-TYPE fact and the plan rides
    // OpenAI's wire (30,000-patch budget), while OpenRouter keeps the default.
    // …and the output cap: OpenRouter's is its own policy (32k), the plan sends none.
    const { outputCap: _orCap, ...openRouterRest } = viaOpenRouter;
    expect(viaPlan).toEqual({ ...openRouterRest, promptVariant: 'gpt', imageLimits: IMAGE_LIMITS_OPENAI, providerType: 'chatgpt' });
    // And without the catalog fact, OpenRouter alone falls to "no vision" — the
    // plan does not, because it is not a transport.
    expect(resolveProfile({ providerType: 'openrouter', modelId: 'openai/gpt-5.6', contextLength: null }).supportsVision).toBe(false);
    expect(viaPlan.supportsVision).toBe(true);
  });

  it('every provider kind the app knows resolves a profile without a cast (the two unions agree)', () => {
    // A Record keyed on the shared union fails to COMPILE the day a provider is added to provider-types.ts and the harness is forgotten.
    const every: Record<ProviderType, true> = {
      'local-engine': true, 'openai-compatible': true, 'openrouter': true,
      'anthropic': true, 'openai': true, 'google': true, 'chatgpt': true,
    };
    for (const providerType of Object.keys(every) as ProviderType[]) {
      const p = resolveProfile({ providerType, modelId: 'x', contextLength: null });
      expect(typeof p.injectionBudgetTokens, providerType).toBe('number');
    }
  });
});

describe('resolveProfile — imageLimits is a provider-type fact', () => {
  it('OpenAI and Sign-in-with-ChatGPT share the one verified patch budget', () => {
    for (const providerType of ['openai', 'chatgpt'] as const) {
      expect(resolveProfile({ providerType, modelId: 'x', contextLength: null }).imageLimits).toEqual({ maxEdgePx: 8192, maxPatches: 30_000 });
    }
  });
  it('every other provider type gets the conservative default sizes, local and registry-matched included', () => {
    for (const providerType of ['google', 'openai-compatible'] as const) {
      expect(resolveProfile({ providerType, modelId: 'x', contextLength: null }).imageLimits).toEqual({ maxEdgePx: 4096, maxPatches: 16_384 });
    }
    expect(resolveProfile(local('mystery-3b', 8_192)).imageLimits).toEqual({ maxEdgePx: 4096, maxPatches: 16_384 });
    expect(resolveProfile(local('qwen2.5-7b-instruct', 32_768)).imageLimits).toEqual({ maxEdgePx: 4096, maxPatches: 16_384 });
  });
  it('Anthropic and OpenRouter add the 100-pictures-per-request cap; nobody else does', () => {
    for (const providerType of ['anthropic', 'openrouter'] as const) {
      expect(resolveProfile({ providerType, modelId: 'x', contextLength: null }).imageLimits).toEqual({ maxEdgePx: 4096, maxPatches: 16_384, maxImagesPerRequest: 100 });
    }
  });
  it('CLOUD_DEFAULT carries the conservative default, never the OpenAI budget', () => {
    expect(CLOUD_DEFAULT.imageLimits).toEqual({ maxEdgePx: 4096, maxPatches: 16_384 });
  });
});

describe('resolveProfile — the per-step output cap is a provider policy over the published maximum', () => {
  it('a user\'s own key gets the model\'s published maximum (capped at 128k); unknown → 16k', () => {
    expect(resolveProfile({ providerType: 'anthropic', modelId: 'claude-opus-5-5', contextLength: 1_000_000, maxOutputTokens: 128_000 }).outputCap).toBe(128_000);
    expect(resolveProfile({ providerType: 'openai', modelId: 'o3', contextLength: 200_000, maxOutputTokens: 100_000 }).outputCap).toBe(100_000);
    expect(resolveProfile({ providerType: 'google', modelId: 'g', contextLength: null, maxOutputTokens: 1_000_000 }).outputCap).toBe(128_000);
    expect(resolveProfile({ providerType: 'anthropic', modelId: 'unlisted', contextLength: null }).outputCap).toBe(16_000);
  });
  it('OpenRouter is 32k, never above the model\'s own maximum', () => {
    expect(resolveProfile({ providerType: 'openrouter', modelId: 'anthropic/claude-opus-5.5', contextLength: null, maxOutputTokens: 128_000 }).outputCap).toBe(32_000);
    expect(resolveProfile({ providerType: 'openrouter', modelId: 'small', contextLength: null, maxOutputTokens: 8_192 }).outputCap).toBe(8_192);
    expect(resolveProfile({ providerType: 'openrouter', modelId: 'unlisted', contextLength: null }).outputCap).toBe(32_000);
  });
  it('ChatGPT sign-in and local models carry no cap of their own', () => {
    expect(resolveProfile({ providerType: 'chatgpt', modelId: 'gpt-5.6', contextLength: null, maxOutputTokens: 128_000 }).outputCap).toBeUndefined();
    expect(resolveProfile(local('qwen2.5-7b-instruct', 32_768)).outputCap).toBeUndefined();
  });
});

describe('the assumed window for an unknown model', () => {
  const d = (providerType: DiscoveredModel['providerType'], onThisComputer?: boolean, modelId = 'm'): DiscoveredModel =>
    ({ providerType, modelId, contextLength: null, onThisComputer });
  it('is 250k for cloud providers, including a custom endpoint elsewhere', () => {
    for (const t of ['openrouter', 'anthropic', 'openai', 'google', 'chatgpt', 'openai-compatible'] as const) {
      expect(resolveProfile(d(t, false)).assumedContextWindow, t).toBe(250_000);
    }
  });
  it('is 32k for the local engine and for a custom endpoint on this computer', () => {
    expect(resolveProfile(d('local-engine')).assumedContextWindow).toBe(32_768);
    expect(resolveProfile(d('openai-compatible', true)).assumedContextWindow).toBe(32_768);
  });
  it('a known-model entry never changes it, local or hosted', () => {
    const reg: KnownModelEntry[] = [{ match: '^known', label: 'Known', maxToolPresentation: 'full', maxContextWindow: 8192 } as KnownModelEntry];
    expect(resolveProfile(d('local-engine', undefined, 'known-1'), reg).assumedContextWindow).toBe(32_768);
    expect(resolveProfile(d('openrouter', undefined, 'known-1'), reg).assumedContextWindow).toBe(250_000);
  });
  it('the profile names the provider type it was resolved for', () => {
    expect(resolveProfile(d('openai-compatible')).providerType).toBe('openai-compatible');
  });
});
