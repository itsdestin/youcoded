// Intentionally narrow: never infer overflow from HTTP status or prose. The
// adapters differ in which structured upstream details they retain.
export function isContextOverflow(error: unknown, providerId: string): boolean {
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
  if (providerId === 'openrouter') return body.error?.metadata?.error_type === 'context_length_exceeded';
  if (providerId === 'local') return body.error?.type === 'exceed_context_size_error';
  // ChatGPT ordinary /responses only: do not accept a bare code without the
  // structured response error and endpoint evidence.
  if (providerId === 'chatgpt') return body.error?.code === 'context_length_exceeded'
    && typeof e.url === 'string' && /\/responses(?:\?|$)/.test(e.url);
  return false;
}
