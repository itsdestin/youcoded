// Intentionally narrow, like context-overflow.ts: the structured rejections an
// oversized picture produces, matched by status AND exact wording. Never infer
// from a bare 400 or from prose that merely mentions images. Provider-agnostic
// on purpose: OpenRouter relays the upstream message verbatim, so the body, not
// the provider id, is the evidence.
// WHY three envelopes: the OpenAI sentence was read off a screenshot of the
// ChatGPT route (2026-10-06); the live error OBJECT was never captured. OpenAI's
// JSON API puts it in error.message; the Codex route answers refusals with a
// `detail` field (chatgpt-oauth.ts ~661 reads json.detail); a proxy may flatten
// it to a top-level message. All three are accepted; any other shape is not.
export interface ImageTooLarge { requiredPatches: number; limitPatches: number }

const PATCHES_RE = /requires (\d+) patches after processing, exceeding the limit of (\d+)/;
// Anthropic's many-image rejection (2026-10-20, it bricked a conversation):
// "messages.21.content.91.image.source.base64.data: At least one of the image
// dimensions exceed max allowed size for many-image requests: 2000 pixels".
const MANY_IMAGE_EDGE_RE = /exceed max allowed size for many-image requests: (\d+) pixels/;

/** The provider's message strings from a 400, in any of the three envelopes. */
function rejectionMessages(error: unknown): string[] {
  // WHY unwrap lastError: the step-retry wrapper hides the provider error one level down.
  const e = (error as any)?.lastError ?? error as any;
  if (!e || typeof e !== 'object') return [];
  if ((e.statusCode ?? e.status) !== 400) return [];
  let body: any;
  try { body = typeof e.responseBody === 'string' ? JSON.parse(e.responseBody) : e.data; } catch { return []; }
  if (!body || typeof body !== 'object') return [];
  return [body.error?.message, body.detail, body.message].filter((c): c is string => typeof c === 'string');
}

export function imageTooLarge(error: unknown): ImageTooLarge | null {
  for (const candidate of rejectionMessages(error)) {
    const m = PATCHES_RE.exec(candidate);
    if (m) return { requiredPatches: Number(m[1]), limitPatches: Number(m[2]) };
  }
  return null;
}

/** The per-side pixel cap Anthropic names when a request holding many pictures
 *  carries one wider or taller than it, else null. */
export function manyImageEdgeLimit(error: unknown): number | null {
  for (const candidate of rejectionMessages(error)) {
    const m = MANY_IMAGE_EDGE_RE.exec(candidate);
    if (m && Number(m[1]) > 0) return Number(m[1]);
  }
  return null;
}
