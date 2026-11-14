// Card #176 (Destin, overnight deck C-7, 2026-11-13: keep the 250k guess, but "handle the potential failure cases"):
// providers that refuse a too-long chat in their own WORDS rather than with the standard code. Each shape is anchored to the whole
// sentence and needs a 400, so no other invalid request can trigger a summary. Where each came from (tests/context-overflow-shapes.test.ts
// pins every one):
//  - OpenAI-style "This model's / endpoint's maximum context length is N tokens. However, you requested ..." — the wording DeepSeek,
//    OpenAI's older models, Groq, vLLM and OpenRouter's upstream passthrough use. DOCUMENTATION / COMMUNITY REPORT only (a DeepSeek reply
//    quoted in an n8n forum thread, 65536 / 73149 tokens); not captured from a real reply of ours.
//  - Mistral "Prompt contains N tokens ..., too large for model with M maximum context length" (code 3051). Community report only.
// Confirmed from real replies: only the openai-compatible `context_length_exceeded` code (captured 2026-10-21). OpenRouter's
// `metadata.error_type: context_length_exceeded` is in OpenRouter's own error table (documentation), as is Anthropic's message.
const OPENAI_STYLE = /^This (?:model's|endpoint's) maximum context length is \d+ tokens\./;
const MISTRAL_STYLE = /^Prompt contains \d+ tokens\b.*\btoo large for model with \d+ maximum context length/;
/** True for a 400 whose message is one of the worded refusals above. */
export function isWordedContextOverflow(status: unknown, message: unknown): boolean {
  if (status !== 400) return false;
  const m = String(message ?? '').trim();
  return OPENAI_STYLE.test(m) || MISTRAL_STYLE.test(m);
}

// Intentionally narrow: never infer overflow from HTTP status or prose. The
// adapters differ in which structured upstream details they retain.
export function isContextOverflow(error: unknown, providerId: string, providerType?: string): boolean {
  const e = (error as any)?.lastError ?? error as any;
  if (!e || typeof e !== 'object') return false;
  if ([401, 402, 403, 429].includes(e.statusCode ?? e.status)) return false;
  let body: any;
  try { body = typeof e.responseBody === 'string' ? JSON.parse(e.responseBody) : e.data; }
  catch { return false; }
  if (!body || typeof body !== 'object') return false;
  // Anthropic (a user's own API key; its provider id is user-chosen, so match
  // the envelope, not the id). Its overflow has no code — only this documented
  // 400 message, "prompt is too long: <n> tokens > <max> maximum". Anchored to
  // that exact form so no other invalid_request_error can trigger a summary.
  // Not yet confirmed against a captured live response (a paid call).
  if (body.type === 'error' && body.error?.type === 'invalid_request_error'
      && (e.statusCode ?? e.status) === 400
      && /^prompt is too long: \d+ tokens > \d+ maximum$/.test(String(body.error?.message ?? ''))) return true;
  // The worded refusals: only for OpenRouter and custom OpenAI-compatible endpoints (where DeepSeek, Groq, Mistral and the like live).
  const worded = isWordedContextOverflow(e.statusCode ?? e.status ?? (typeof body.error?.code === 'number' ? body.error.code : undefined), body.error?.message);
  if (worded && (providerId === 'openrouter' || providerType === 'openai-compatible')) return true;
  if (providerId === 'openrouter') return body.error?.metadata?.error_type === 'context_length_exceeded';
  if (providerId === 'local') return body.error?.type === 'exceed_context_size_error';
  // ChatGPT ordinary /responses only: do not accept a bare code without the
  // structured response error and endpoint evidence.
  if (providerId === 'chatgpt') return body.error?.code === 'context_length_exceeded'
    && typeof e.url === 'string' && /\/responses(?:\?|$)/.test(e.url);
  // A custom endpoint (OpenAI-compatible, user-chosen id): the standard OpenAI envelope only — a 400
  // whose body is { error: { code: 'context_length_exceeded' } }. Captured 2026-10-21 through
  // @ai-sdk/openai-compatible: an unwrapped APICallError with statusCode 400 and that JSON in
  // responseBody. WHY gated on the TYPE: the id is random; WHY the exact code: this branch must never
  // turn another 400 into a summary.
  if (providerType === 'openai-compatible') return (e.statusCode ?? e.status) === 400 && body.error?.code === 'context_length_exceeded';
  return false;
}
