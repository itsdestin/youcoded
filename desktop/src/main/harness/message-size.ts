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
  // WHY: requestFixedTokens charges the EMPTY messages array, not the role and
  // envelope of each message inside it. Charge that framing once per message,
  // including a separator allowance so suffixes added to a measured anchor use
  // the same estimate as standalone history (the first separator is conservative).
  const frameChars = JSON.stringify({ role: m.role, content: null }).length - 'null'.length + 1;
  return (continuation?.tokens ?? Math.ceil(charSize(m.content) / APPROX_CHARS_PER_TOKEN))
    + Math.ceil(frameChars / APPROX_CHARS_PER_TOKEN);
}

/** A usage count describes the INPUT of one dispatched request, not an entire turn.
 * Its history snapshot and fixed-request identity fence it from rewrites and swaps. */
export function requestFixedTokens(system: string, tools: Record<string, { description?: string; inputSchema?: unknown }>): number {
  // WHY: the real streamText builder supplies system, messages and the selected
  // tools. Serialize that fixed request skeleton rather than summing content:
  // request-level keys/separators and tool declaration framing also occupy
  // input. Per-message role/envelope framing is charged by messageTokens.
  // Unwrap AI SDK schemas to size what is forwarded, not the wrapper.
  const declarations = Object.entries(tools).map(([name, definition]) => {
    const schema = definition.inputSchema as { jsonSchema?: unknown } | undefined;
    return { name, description: definition.description, parameters: schema?.jsonSchema ?? schema ?? {} };
  });
  return Math.ceil(JSON.stringify({ system, messages: [], tools: declarations }).length / APPROX_CHARS_PER_TOKEN);
}

export interface UsageAnchor {
  inputTokens: number;
  identity: string;
  revision: number;
  fixedCost: number;
  history: readonly ModelMessage[];
}

export function requestOccupancy(request: {
  history: readonly ModelMessage[];
  identity: string;
  revision: number;
  fixedCost: number;
  anchor?: UsageAnchor | null;
}): { tokens: number; measured: boolean } {
  const { history, anchor } = request;
  // Identity of the message objects is safe only alongside the monotonic revision:
  // a rebuilt/compacted history must not reuse a measurement of the old prefix.
  if (anchor && anchor.inputTokens > 0 && anchor.identity === request.identity
    && anchor.fixedCost === request.fixedCost && request.revision >= anchor.revision
    && history.length >= anchor.history.length
    && anchor.history.every((message, index) => history[index] === message)) {
    const addition = messagesTokens(history.slice(anchor.history.length));
    return { tokens: anchor.inputTokens + addition, measured: addition === 0 };
  }
  return { tokens: request.fixedCost + messagesTokens([...history]), measured: false };
}

export function messagesTokens(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) n += messageTokens(m);
  return n;
}
