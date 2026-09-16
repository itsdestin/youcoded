import { describe, it, expect } from 'vitest';
import { resolveProfile, effectiveContextForModel, CLOUD_DEFAULT, type DiscoveredModel } from '../src/main/harness/capability-profile';
import type { KnownModelEntry } from '../src/main/harness/known-models';
import { HOSTED_MAX_CONCURRENT_SPECIALISTS } from '../src/main/harness/specialists/limits';
import type { ProviderType } from '../src/shared/provider-types';

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

// ---------------------------------------------------------------------------
// M3 item 5 — capability-gated injection.
//
// Two new fields decide how much the model may be handed mid-session: whether
// the Skill tool's catalog (which rides the tool schema on EVERY turn) is
// affordable at all, and how many tokens a single injection may occupy.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Task 6b — nativeImageToolResults is a PROVIDER-TYPE fact (can this wire
// carry an image inside a tool_result block?), not a model fact. Only the
// direct-Anthropic provider can; every other provider type — including a
// KNOWN local model, whose registry entry has no such field to override it
// with — gets the wire-adapter split instead. Covers every ProfileProviderType
// so a new provider type added later must be triaged here, not silently
// default to whatever object spread happens to produce.
// ---------------------------------------------------------------------------
describe('nativeImageToolResults (Task 6b)', () => {
  it('is true only for the direct Anthropic provider', () => {
    expect(resolveProfile({ providerType: 'anthropic', modelId: 'claude-opus-5', contextLength: 200_000 }).nativeImageToolResults).toBe(true);
    for (const providerType of ['openai', 'google', 'openrouter', 'openai-compatible', 'local-engine', 'chatgpt'] as const) {
      expect(resolveProfile({ providerType, modelId: 'x', contextLength: 32_768 }).nativeImageToolResults, providerType).toBe(false);
    }
  });

  it('a KNOWN local model cannot override it — the registry has no such field', () => {
    const registry: KnownModelEntry[] = [
      { match: 'qwen3\\.6.*35b.*moe', label: 'Qwen 3.6 35B MoE', maxToolPresentation: 'full', supportsTools: true },
    ];
    expect(resolveProfile(local('qwen3.6-35b-moe-q4', 32_768), registry).nativeImageToolResults).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 6 — canDelegate gates whether the model-invoked Task tool is attached
// at all (spec decision 4: a weak/unverified orchestrator serial-collapses
// delegated work rather than parallelizing it, so the gate is on the TOOL,
// never on NativeSessionHost.createChild directly).
// ---------------------------------------------------------------------------
describe('canDelegate (Task 6, spec decision 4)', () => {
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

// ---------------------------------------------------------------------------
// Capability vs room. Destin ran Qwen 3.5 2B with `-c 128000`, and it got the
// full Skill catalog and spent its turn reciting all twelve skills. Window size
// answers "can it afford the catalog?", not "should it be choosing skills?".
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Fix pass 1 / Finding 2 — nothing previously pinned an exact
// mcpToolBudgetTokens value, so the whole ladder (and the local-clamp branch)
// could silently drift. mcp-gating.test.ts only ever asserts on WHICH servers
// survive, never on the raw budget number, so a tier constant could change
// (e.g. 750 -> 200) without any test noticing as long as the surviving-server
// math still worked out for that suite's fixtures. These assert the exact
// integers from every tier plus the frontier/null shortcut and the
// registry-ceiling clamp Finding 1 fixed.
// ---------------------------------------------------------------------------
describe('mcpToolBudgetTokens ladder (Task 6 / fix pass 1, Finding 2)', () => {
  it('an unmeasured/null window gets the smallest tier', () => {
    expect(resolveProfile(local('mystery', null)).mcpToolBudgetTokens).toBe(750);
  });

  it('a small window (< 32,768) gets the smallest tier', () => {
    expect(resolveProfile(local('small-model', 8_192)).mcpToolBudgetTokens).toBe(750);
  });

  it('a mid window (>= 32,768, < 100,000) gets the middle tier', () => {
    expect(resolveProfile(local('mid-model', 64_000)).mcpToolBudgetTokens).toBe(4_000);
  });

  it('a large window (>= 100,000) gets the largest tier', () => {
    expect(resolveProfile(local('big-model', 128_000)).mcpToolBudgetTokens).toBe(20_000);
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

  it('regression (Finding 1): the registry ceiling clamps the window for EVERY provider, not only local-engine', () => {
    // Before the fix, mcpBudgetSizing only ran effectiveContextForModel for
    // providerType === 'local-engine'. An openai-compatible endpoint (the
    // Ollama/LM Studio shape) launched with a large declared window whose
    // model id happens to match a small registry entry skipped the clamp
    // entirely and landed on the 20,000 tier here, while injectionBudgetTokens
    // (which already clamps every non-frontier provider) correctly sized it
    // down — 20,000 tokens of tool schema on a model whose real window is 8k.
    const reg: KnownModelEntry[] = [{ match: 'tiny-model', label: 'Tiny', maxContextWindow: 8192, supportsTools: true }];
    const p = resolveProfile({ providerType: 'openai-compatible', modelId: 'tiny-model-q4', contextLength: 131_072 }, reg);
    expect(p.mcpToolBudgetTokens).toBe(750);                 // clamped to the 8192 ceiling -> smallest tier
    expect(p.injectionBudgetTokens).toBeLessThan(10_000);     // the clamp injectionSizing already applied
  });
});

// ---------------------------------------------------------------------------
// supportsVision precedence — OpenRouter is a transport, so a discovered
// per-model fact (from the catalog's architecture.input_modalities) must be
// able to answer where the registry has none. Precedence, most to least
// authoritative: (1) KNOWN_MODELS registry opinion, (2) DiscoveredModel's own
// supportsVision (the catalog value, when defined), (3) VISION_PROVIDERS
// fallback (today's provider-type-only behavior).
// ---------------------------------------------------------------------------
describe('supportsVision — three-level precedence (registry > discovered > provider default)', () => {
  it('a discovered true from the catalog wins over the provider default (openrouter has no default)', () => {
    const d: DiscoveredModel = { providerType: 'openrouter', modelId: 'some/vision-model', contextLength: 128_000, supportsVision: true };
    expect(resolveProfile(d).supportsVision).toBe(true);
  });

  it('a discovered false from the catalog wins over the provider default', () => {
    // Regression guard for a test that used to assert this same claim with an
    // openrouter binding — whose VISION_PROVIDERS default is ALREADY false, so
    // that version passed even with the whole discovered-value feature deleted.
    // anthropic IS in VISION_PROVIDERS (default true), so only a real "discovered
    // false overrides it" path can make this one pass.
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

// ---------------------------------------------------------------------------
// Task 13 — maxConcurrentSpecialists: the per-parent specialist concurrency
// ceiling moves from the flat HOSTED_MAX_CONCURRENT_SPECIALISTS constant onto
// the profile. Hosted/cloud stays the flat spec constant (CLOUD_DEFAULT); a
// local session's ceiling is derived from the ENGINE's own measured slot
// count (DiscoveredModel.totalSlots, read from the same /props call that
// already supplies contextLength — see engine-dependencies.md § "Parallel
// slots"), clamped to [1, 4]. An UNKNOWN local model (Layer 3) gets the
// conservative floor unconditionally — same posture as canDelegate, which is
// already false for it, so the Task tool is never even attached.
// ---------------------------------------------------------------------------
describe('maxConcurrentSpecialists (Task 13 — local concurrency from the engine, hosted from the profile)', () => {
  it('hosted/cloud providers get the flat spec constant', () => {
    // Final-review fix (Finding 5): `expect(CLOUD_DEFAULT.maxConcurrentSpecialists)
    // .toBe(HOSTED_MAX_CONCURRENT_SPECIALISTS)` alone can never fail from a
    // regression in the VALUE this feature is supposed to produce —
    // capability-profile.ts sets CLOUD_DEFAULT.maxConcurrentSpecialists to
    // exactly that same imported binding (line ~122), so the comparison is
    // between a symbol and itself; it would keep passing even if
    // HOSTED_MAX_CONCURRENT_SPECIALISTS's own value drifted to something
    // nonsensical (0, -1, 9999), since both sides would still agree. Pin the
    // actual spec number (limits.ts's own comment: "spec §5 Global
    // Constraints", currently 4) so a change to the constant itself is a
    // failure, not a silent pass. The symbol-equality check below is kept
    // TOO — it still catches the OTHER real regression, a hardcoded literal
    // replacing the import in capability-profile.ts.
    expect(HOSTED_MAX_CONCURRENT_SPECIALISTS).toBe(4);
    expect(CLOUD_DEFAULT.maxConcurrentSpecialists).toBe(HOSTED_MAX_CONCURRENT_SPECIALISTS);
    for (const providerType of ['anthropic', 'openai', 'google', 'openrouter', 'chatgpt'] as const) {
      expect(resolveProfile({ providerType, modelId: 'x', contextLength: 128_000 }).maxConcurrentSpecialists, providerType)
        .toBe(HOSTED_MAX_CONCURRENT_SPECIALISTS);
    }
  });

  it('an UNKNOWN local model gets the conservative floor of 1, even when a live slot count is provided', () => {
    // Layer 3 is unconditional — an unvetted model's real behavior under
    // concurrent load is unknown regardless of what the engine reports, the
    // same reasoning canDelegate already applies to this layer.
    expect(resolveProfile(local('mystery-3b', 8_192)).maxConcurrentSpecialists).toBe(1);
    expect(resolveProfile({ providerType: 'local-engine', modelId: 'mystery-3b', contextLength: 8_192, totalSlots: 4 }).maxConcurrentSpecialists).toBe(1);
  });

  it('a KNOWN local model with a live slot reading clamps to it (within 1-4)', () => {
    const registry: KnownModelEntry[] = [{ match: 'qwen3\\.6.*35b.*moe', label: 'Qwen 3.6 35B MoE', maxToolPresentation: 'full', supportsTools: true }];
    expect(resolveProfile({ providerType: 'local-engine', modelId: 'qwen3.6-35b-moe-q4', contextLength: 32_768, totalSlots: 4 }, registry).maxConcurrentSpecialists).toBe(4);
    expect(resolveProfile({ providerType: 'local-engine', modelId: 'qwen3.6-35b-moe-q4', contextLength: 32_768, totalSlots: 2 }, registry).maxConcurrentSpecialists).toBe(2);
  });

  it('a KNOWN local model clamps a slot reading ABOVE 4 down to the ceiling', () => {
    const registry: KnownModelEntry[] = [{ match: 'qwen3\\.6.*35b.*moe', label: 'Qwen 3.6 35B MoE', maxToolPresentation: 'full', supportsTools: true }];
    expect(resolveProfile({ providerType: 'local-engine', modelId: 'qwen3.6-35b-moe-q4', contextLength: 32_768, totalSlots: 8 }, registry).maxConcurrentSpecialists).toBe(4);
  });

  it('a KNOWN local model clamps a slot reading of 0 up to the floor of 1', () => {
    const registry: KnownModelEntry[] = [{ match: 'qwen3\\.6.*35b.*moe', label: 'Qwen 3.6 35B MoE', maxToolPresentation: 'full', supportsTools: true }];
    expect(resolveProfile({ providerType: 'local-engine', modelId: 'qwen3.6-35b-moe-q4', contextLength: 32_768, totalSlots: 0 }, registry).maxConcurrentSpecialists).toBe(1);
  });

  it('a KNOWN local model with NO slot count on this build falls back to 1, not the ceiling', () => {
    const registry: KnownModelEntry[] = [{ match: 'qwen3\\.6.*35b.*moe', label: 'Qwen 3.6 35B MoE', maxToolPresentation: 'full', supportsTools: true }];
    // totalSlots absent entirely (the DiscoveredModel never set it).
    expect(resolveProfile(local('qwen3.6-35b-moe-q4', 32_768), registry).maxConcurrentSpecialists).toBe(1);
    // totalSlots explicitly null (the /props read ran but reported nothing).
    expect(resolveProfile({ providerType: 'local-engine', modelId: 'qwen3.6-35b-moe-q4', contextLength: 32_768, totalSlots: null }, registry).maxConcurrentSpecialists).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// announcePrefill (Destin, 2026-08-16) — the "Reading your prompt — N tokens"
// heartbeat is for models running on the user's OWN hardware, where llama.cpp
// prefill is a minutes-long silence that looks like a hang. It shipped on every
// provider, so cloud/OpenRouter turns got it in place of the ordinary spinner.
// A PROVIDER-TYPE fact: no registry entry may override it either way.
// ---------------------------------------------------------------------------
describe('announcePrefill — the prompt-reading notice is local-only', () => {
  it('is false for every hosted provider', () => {
    for (const providerType of ['anthropic', 'openai', 'google', 'openrouter', 'chatgpt'] as const) {
      expect(resolveProfile({ providerType, modelId: 'x', contextLength: 128_000 }).announcePrefill, providerType).toBe(false);
    }
    expect(CLOUD_DEFAULT.announcePrefill).toBe(false);
  });

  it('is true for the local engine, known model or not', () => {
    expect(resolveProfile(local('mystery-3b', 8_192)).announcePrefill).toBe(true);
    const registry: KnownModelEntry[] = [{ match: 'qwen3\\.6.*35b.*moe', label: 'Qwen 3.6 35B MoE', maxToolPresentation: 'full', supportsTools: true }];
    expect(resolveProfile(local('qwen3.6-35b-moe-q4', 131_072), registry).announcePrefill).toBe(true);
  });

  it('is true for openai-compatible — the Ollama / LM Studio shape is a local model in disguise', () => {
    // Same reasoning FRONTIER_PROVIDERS uses to exclude this type from the
    // "assume a roomy window" shortcut.
    expect(resolveProfile({ providerType: 'openai-compatible', modelId: 'llama3.3:70b', contextLength: null }).announcePrefill).toBe(true);
  });
});

// Sign in with ChatGPT — design §4.8 / review R3-1. The user's own ChatGPT plan
// serves GPT-5.x models, and before this the harness had never heard of the
// 'chatgpt' provider kind: a plan model fell through to the "unmeasured local
// model" path and silently behaved like a small local model.
describe("Sign in with ChatGPT — the harness knows the 'chatgpt' provider (design §4.8)", () => {
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
        expect(resolveProfile({ providerType: 'chatgpt', modelId, contextLength }), `${modelId} @ ${contextLength}`)
          .toEqual(resolveProfile({ providerType: 'openai', modelId, contextLength }));
      }
    }
  });

  it('matches the OpenRouter profile for the same GPT model except where OpenRouter is only a transport', () => {
    // Design §4.8's comparison point: "a 2k injection budget where OpenRouter's
    // GPT-5.6 gets 20k". Sizing must now be equal. Two DELIBERATE differences
    // remain, both because OpenRouter serves any model and so cannot assume
    // anything about this one: (1) OpenRouter gets the generic prompt overlay,
    // the plan gets the GPT one; (2) OpenRouter's vision answer has to come
    // from its catalog (the discovered per-model fact), the plan's is known
    // by construction. With that fact supplied, only the prompt differs.
    const viaPlan = resolveProfile({ providerType: 'chatgpt', modelId: 'gpt-5.6', contextLength: null });
    const viaOpenRouter = resolveProfile({ providerType: 'openrouter', modelId: 'openai/gpt-5.6', contextLength: null, supportsVision: true });
    expect(viaPlan.injectionBudgetTokens).toBe(viaOpenRouter.injectionBudgetTokens);
    expect(viaPlan).toEqual({ ...viaOpenRouter, promptVariant: 'gpt' });
    // And without the catalog fact, OpenRouter alone falls to "no vision" — the
    // plan does not, because it is not a transport.
    expect(resolveProfile({ providerType: 'openrouter', modelId: 'openai/gpt-5.6', contextLength: null }).supportsVision).toBe(false);
    expect(viaPlan.supportsVision).toBe(true);
  });

  it('every provider kind the app knows resolves a profile without a cast (the two unions agree)', () => {
    // A Record keyed on the SHARED union: tsc refuses this literal if a
    // ProviderType is missing from it, and refuses the resolveProfile call if
    // that ProviderType is missing from ProfileProviderType. So this test
    // fails to COMPILE — not just to run — the day someone adds a provider to
    // shared/provider-types.ts and forgets the harness. The type-level guard
    // in capability-profile.ts says the same thing; this is its runnable twin.
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
