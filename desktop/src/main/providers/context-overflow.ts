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
  if (providerId === 'openrouter') return body.error?.metadata?.error_type === 'context_length_exceeded';
  if (providerId === 'local') return body.error?.type === 'exceed_context_size_error';
  // ChatGPT ordinary /responses only: do not accept a bare code without the
  // structured response error and endpoint evidence.
  if (providerId === 'chatgpt') return body.error?.code === 'context_length_exceeded'
    && typeof e.url === 'string' && /\/responses(?:\?|$)/.test(e.url);
  return false;
}
