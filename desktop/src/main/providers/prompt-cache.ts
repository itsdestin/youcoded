// Prompt-cache request shaping for Anthropic (direct) and OpenRouter.
//
// WHY this exists (cache follow-ups item 1 + 6, 2026-09-10): Anthropic's cache
// is opt-in per request — without a `cache_control` marker every step of every
// Claude conversation is billed at full price for the whole prefix. OpenRouter
// keeps a conversation's cache on the upstream server that wrote it, and pins
// later requests to that server only once it has SEEN a cache hit — unless the
// caller sends a `session_id`, which pins from the first request and re-pins
// after a miss (openrouter.ai/docs/guides/best-practices/prompt-caching).
//
// WHY a middleware in the registry, not code in the harness: the harness is
// provider-ignorant and already hands the registry its session id as
// `cacheKey` for the ChatGPT branch's prompt_cache_key. Keying on the same
// value means a caller without one (session naming) gets nothing, for free.
//
// WHY the summary exception: the compaction summary request changes
// tool_choice, which invalidates Anthropic's MESSAGES cache while keeping the
// tools+system cache. A tail marker on that request would WRITE the whole
// history at the 1h premium (2x) for an entry nothing ever reads — worse than
// no marker. So a summary marks the system block only (direct), and asks for
// nothing on OpenRouter, where the top-level field is all-or-nothing.
//
// WHY one TTL: `1h` for every harness request. A read refreshes the timer, so
// 1h costs 2x (vs 1.25x) only on each turn's NEW tokens, and a single pause of
// 5–60 minutes between messages — ordinary for a human — would otherwise
// re-write the entire prefix. Mixed TTLs in one request must be ordered
// longer-first; one value removes that footgun (independent review 2026-09-10).
import type { LanguageModelMiddleware } from 'ai';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { currentChatGptRequest } from './chatgpt-request-diagnostics';

const MARKER = { type: 'ephemeral', ttl: '1h' } as const;

export type PromptCacheProvider = 'anthropic' | 'openrouter';

/** Pure: the params rewrite, exported so tests can pin it without a model. */
export function applyPromptCache(
  params: LanguageModelV4CallOptions,
  o: { provider: PromptCacheProvider; modelId: string; cacheKey: string; purpose?: string },
): LanguageModelV4CallOptions {
  const tail = o.purpose !== 'summary';
  if (o.provider === 'anthropic') {
    // One explicit breakpoint on the LAST system block (render order is tools →
    // system → messages, so it covers the tools too), plus Anthropic's
    // top-level automatic marker for the moving conversation tail. The system
    // breakpoint is not redundant: after a compaction the tail's 20-position
    // lookback finds no earlier entry, and without a system entry the tools
    // and system prompt would be re-written as well.
    let lastSystem = -1;
    params.prompt.forEach((m, i) => { if (m.role === 'system') lastSystem = i; });
    const prompt = params.prompt.map((m, i) => i === lastSystem
      ? { ...m, providerOptions: { ...m.providerOptions, anthropic: { ...m.providerOptions?.anthropic, cacheControl: MARKER } } }
      : m);
    const providerOptions = tail
      ? { ...params.providerOptions, anthropic: { ...params.providerOptions?.anthropic, cacheControl: MARKER } }
      : params.providerOptions;
    return { ...params, prompt, providerOptions };
  }
  // OpenRouter: @ai-sdk/openai-compatible spreads providerOptions.openrouter
  // verbatim into the request body. `session_id` pins the upstream; the
  // top-level `cache_control` is honored for Anthropic-provider models only, so
  // it is gated on the model id (DeepSeek, OpenAI, Gemini cache automatically).
  const claude = o.modelId.startsWith('anthropic/');
  return {
    ...params,
    providerOptions: {
      ...params.providerOptions,
      openrouter: {
        ...params.providerOptions?.openrouter,
        session_id: o.cacheKey,
        ...(tail && claude ? { cache_control: MARKER } : {}),
      },
    },
  };
}

export function promptCacheMiddleware(o: { provider: PromptCacheProvider; modelId: string; cacheKey: string }): LanguageModelMiddleware {
  return {
    // The request purpose rides the same async context the ChatGPT diagnostics
    // use (`withChatGptRequest`): the harness wraps its turn as 'chat' /
    // 'specialist' and the compaction summary as 'summary'. Anything else is
    // treated as an ordinary request.
    transformParams: async ({ params }) => applyPromptCache(params, { ...o, purpose: currentChatGptRequest()?.purpose }),
  };
}
