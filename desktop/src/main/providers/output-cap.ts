// How many output tokens ONE reply step may use, per provider (2026-10-21).
//
// WHY per provider, not one number: the 16,000-token cap (harness-manifest
// DEFAULT_MAX_OUTPUT_TOKENS) was set to stop OPENROUTER reserving a model's full
// advertised output against the account balance on every request. It was then
// applied to every provider, so Claude Opus on a direct Anthropic key — which
// writes up to 128,000 — was cut off mid-write ("Response truncated") whenever
// it put a long plan or file into a single step, and repeating "continue" hit
// the same wall (85765071, three times on 2026-10-21).
//
// - Anthropic / OpenAI / Google (a user's own key): the model's published
//   maximum. These providers bill tokens produced, not tokens allowed, and
//   Anthropic documents that max_tokens does not count against rate limits
//   (platform.claude.com/docs/en/api/rate-limits), so a high cap costs nothing
//   until a reply is actually long. Capped at 128,000 (no published current
//   model writes more in one reply).
// - OpenRouter: 32,000 (Destin, 2026-10-21) — double the old cap, still a
//   fraction of a frontier model's advertised maximum for the up-front credit
//   reservation. Never above the model's own published maximum.
// - Everything else (local engine, custom endpoints, unknown): the manifest
//   default; local models are bounded by their context window anyway.
// - ChatGPT sign-in sends no cap at all (chatgpt-model.ts: the endpoint refuses one).
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../../shared/harness-manifest';
import type { ProfileProviderType } from '../harness/capability-profile';

const OPENROUTER_MAX_OUTPUT_TOKENS = 32_000;
const OWN_KEY_CEILING = 128_000;
const OWN_KEY_TYPES = new Set<ProfileProviderType>(['anthropic', 'openai', 'google']);

/** The per-step output cap for this provider type and (when published) model
 *  maximum; undefined for ChatGPT sign-in, whose endpoint refuses any cap. */
export function outputCapFor(type: ProfileProviderType | null | undefined, publishedMax: number | null | undefined): number | undefined {
  if (type === 'chatgpt') return undefined;
  const known = typeof publishedMax === 'number' && publishedMax > 0 ? publishedMax : null;
  if (type && OWN_KEY_TYPES.has(type)) return known ? Math.min(known, OWN_KEY_CEILING) : DEFAULT_MAX_OUTPUT_TOKENS;
  if (type === 'openrouter') return known ? Math.min(known, OPENROUTER_MAX_OUTPUT_TOKENS) : OPENROUTER_MAX_OUTPUT_TOKENS;
  return DEFAULT_MAX_OUTPUT_TOKENS;
}
