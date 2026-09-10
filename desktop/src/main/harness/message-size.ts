// Token sizing that understands binary parts. JSON.stringify on a Node Buffer
// yields {"type":"Buffer","data":[137,80,...]} — roughly 4-5 characters per
// BYTE — so the old chars/4 paths estimated a 1 MB screenshot at ~1.1M "tokens"
// and fitToContext dropped the entire prior conversation on any turn that
// carried an image (#290 follow-up fix 1, 2026-08-11 spec).
import type { ModelMessage } from 'ai';
import { continuationEstimate } from './openai-continuation';

export const APPROX_CHARS_PER_TOKEN = 4;

// What a provider actually bills for a screenshot-sized image (Anthropic is
// ~1.1-1.6k tokens at its 1092px resize ceiling; OpenAI-compatible data-URL
// paths land in the same range). A flat estimate deliberately beats byte math:
// base64 length wildly overestimates large images the provider downscales anyway.
export const IMAGE_PART_TOKEN_ESTIMATE = 1_600;

// Recursive char-equivalent walk. Buffers, any typed array (Uint8ClampedArray,
// Float32Array, ...), and bare ArrayBuffers all count as one image's worth of
// chars wherever they appear — user-message file parts hold a bare Buffer,
// tool-result content outputs hold { type:'data', data: Buffer } — so one rule
// covers both shapes without knowing message schemas. ArrayBuffer.isView()
// catches every typed-array/DataView flavor; a bare ArrayBuffer (no view) needs
// its own instanceof check since isView() is false for it — without that it fell
// through to the object branch, where Object.entries() on an ArrayBuffer is
// [] and it silently sized as 2 chars.
function charSize(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return 8;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return IMAGE_PART_TOKEN_ESTIMATE * APPROX_CHARS_PER_TOKEN;
  if (Array.isArray(value)) { let n = 2; for (const v of value) n += charSize(v); return n; }
  if (typeof value === 'object') {
    let n = 2;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) n += k.length + charSize(v);
    return n;
  }
  return 8;
}

export function messageTokens(m: ModelMessage): number {
  // WHY: accepted Responses reasoning carries opaque ciphertext whose byte
  // length has no token relationship. Its private per-step sizing tag is the
  // authority; ordinary messages retain the established recursive estimator.
  const continuation = continuationEstimate(m);
  return continuation?.tokens ?? Math.ceil(charSize((m as { content: unknown }).content) / APPROX_CHARS_PER_TOKEN);
}

export function messagesTokens(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) n += messageTokens(m);
  return n;
}
