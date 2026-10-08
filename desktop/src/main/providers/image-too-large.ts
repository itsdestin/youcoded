// Intentionally narrow, like context-overflow.ts: the ONE structured rejection
// an oversized picture produces on OpenAI's wire, matched by status AND exact
// wording. Never infer from a bare 400 or from prose that merely mentions
// images. Provider-agnostic on purpose: OpenRouter relays OpenAI's message
// verbatim, so the body, not the provider id, is the evidence.
// WHY three envelopes: the sentence was read off a screenshot of the ChatGPT
// route (2026-10-06); the live error OBJECT was never captured. OpenAI's JSON
// API puts it in error.message; the Codex route answers refusals with a
// `detail` field (chatgpt-oauth.ts ~661 reads json.detail); a proxy may flatten
// it to a top-level message. All three are accepted; any other shape is not.
export interface ImageTooLarge { requiredPatches: number; limitPatches: number }

const PATCHES_RE = /requires (\d+) patches after processing, exceeding the limit of (\d+)/;

export function imageTooLarge(error: unknown): ImageTooLarge | null {
  // WHY unwrap lastError: the step-retry wrapper hides the provider error one level down.
  const e = (error as any)?.lastError ?? error as any;
  if (!e || typeof e !== 'object') return null;
  if ((e.statusCode ?? e.status) !== 400) return null;
  let body: any;
  try { body = typeof e.responseBody === 'string' ? JSON.parse(e.responseBody) : e.data; } catch { return null; }
  if (!body || typeof body !== 'object') return null;
  for (const candidate of [body.error?.message, body.detail, body.message]) {
    const m = typeof candidate === 'string' ? PATCHES_RE.exec(candidate) : null;
    if (m) return { requiredPatches: Number(m[1]), limitPatches: Number(m[2]) };
  }
  return null;
}
