// desktop/src/shared/recommended-models.ts
//
// The model switcher's bottom bands: Claude Code's own aliases, the ChatGPT
// plan's named families, and a short curated list of OpenRouter endpoints.
//
// WHY a static list for the OpenRouter recommendations: the picker already
// intersects every id against the LIVE catalog (rows the provider no longer
// lists cannot resolve, so they never render — `unavailableReason` answers
// "No longer in the model list"). Dead endpoints therefore drop out of the
// switcher on their own; this list only decides what is WORTH offering.
// Renames are the residual risk, tracked for a weekly endpoint-health runner
// in the workspace roadmap (docs/roadmap/dev-workspace.md) rather than built
// here.
//
// WHY the `~` prefix on some ids is real: OpenRouter publishes its
// auto-updating "latest" aliases with a literal `~` at the start of the id
// (verified against GET /api/v1/models, 2026-09-20 — e.g. `~openai/gpt-luna-latest`).
// The picker matches catalog ids by exact equality, so these strings must be
// byte-identical to what the catalog serves. Stripping the `~` would match
// nothing.

/**
 * Recommended OpenRouter endpoints, in display order. Every id was verified
 * live (tools-capable, non-empty context) on 2026-09-20. Order is curation,
 * not rank: DeepSeek → GLM → GPT → Kimi → Grok → Gemini.
 */
export const RECOMMENDED_OPENROUTER_MODELS = [
  '~deepseek/deepseek-pro-latest',
  '~deepseek/deepseek-flash-latest',
  '~z-ai/glm-flash-latest',
  '~openai/gpt-luna-latest',
  '~openai/gpt-terra-latest',
  '~openai/gpt-astra-latest',
  '~openai/gpt-sol-latest',
  '~moonshotai/kimi-latest',
  'moonshotai/kimi-k3',
  '~x-ai/grok-latest',
  '~google/gemini-flash-latest',
  '~google/gemini-pro-latest',
] as const;

const RECOMMENDED_SET: ReadonlySet<string> = new Set(RECOMMENDED_OPENROUTER_MODELS);

/** True when this catalog id is one of the curated OpenRouter recommendations. */
export function isRecommendedOpenRouterModel(modelId: string): boolean {
  return RECOMMENDED_SET.has(modelId);
}

/**
 * The ChatGPT plan's named model families, in display order (Destin's order).
 *
 * Matched on the FAMILY word, never a pinned id: the plan's manifest is
 * fetched live and re-versioned server-side (gpt-5.5 → gpt-5.6-luna → …), so
 * "gpt-5.6-luna" would strand the band at the next bump. Only plan-provider
 * rows are run through this matcher — the same word inside an OpenRouter id
 * (`openai/gpt-6-astra`) is a different endpoint in a different band.
 */
const CHATGPT_PLAN_FAMILIES = ['luna', 'terra', 'sol', 'astra'] as const;
export type ChatGptPlanFamily = typeof CHATGPT_PLAN_FAMILIES[number];

/** The plan family a ChatGPT catalog id belongs to, or null when it is none
 *  of the four (base models, mini, codex tooling — searchable, not banded). */
export function chatgptPlanFamily(modelId: string): ChatGptPlanFamily | null {
  const id = modelId.toLowerCase();
  for (const family of CHATGPT_PLAN_FAMILIES) {
    // WHY match slug tokens: a model named `gpt-console` contains `sol` but
    // is not a Sol model and must not displace Sol's OpenRouter fallback.
    if (id.split('-').includes(family)) return family;
  }
  return null;
}

/**
 * The replacement rule (Destin, 2026-09-20): a connected first-party plan
 * REPLACES the plan-shaped OpenRouter recommendations it duplicates — never
 * the other providers' rows. "claude/gpt openrouter recommendations" are the
 * claude ones and the gpt ones; DeepSeek, GLM, Kimi, Grok and Gemini are
 * recommended to everyone with OpenRouter, plan or not. Replacement is per
 * family: the plan's manifest must actually list the family before its
 * OpenRouter endpoint stands down.
 */

/** The recommended OpenRouter ids naming the ChatGPT plan's own families
 *  (gpt luna/terra/sol/astra latest). */
export function isGptFamilyRecommendation(modelId: string): boolean {
  return modelId.startsWith('~openai/gpt-')
    && CHATGPT_PLAN_FAMILIES.some((f) => modelId.includes(`-${f}-`));
}

/** The plan family a GPT recommendation covers, or null. The picker uses this
 *  to stand down exactly the endpoint whose family the plan lists. */
export function gptFamilyRecommendationFor(modelId: string): ChatGptPlanFamily | null {
  if (!isGptFamilyRecommendation(modelId)) return null;
  const id = modelId.toLowerCase();
  return CHATGPT_PLAN_FAMILIES.find((f) => id.includes(`-${f}-`)) ?? null;
}

/** The recommended OpenRouter ids naming Claude Code's own models. OpenRouter
 *  lists claude "latest" alias rows, but none is recommended today — the
 *  predicate exists so the CC replacement rule is written against the family,
 *  not the current list, and a future claude recommendation is replaced by a
 *  connected Claude Code too. */
export function isClaudeFamilyRecommendation(modelId: string): boolean {
  return modelId.startsWith('~anthropic/claude-');
}

/**
 * Assistant settings → General's toggle. Absent (the default) means shown;
 * `'1'` means a power user hid the recommendations. Same localStorage, no
 * backend, as the close-session-prompt toggle this mirrors.
 */
export const RECOMMENDED_MODELS_HIDDEN_KEY = 'youcoded-recommended-models-hidden';
