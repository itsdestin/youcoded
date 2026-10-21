// The ONE answer to "what kind of failure was this, and what may we do about it?"
// for a native turn's provider error (2026-10-21). Before this, three places
// decided independently: withRetry retried any 429/5xx and one network code,
// describeProviderError worded it, classifyProviderError named two sign-in
// cases. A spend cap was retried as if it were a rate limit, "Cannot connect
// to API" (a DNS or connect failure) was never retried at all, and every
// unrecognised error ended the turn with no way forward but a new message.
//
// WHY rules on documented shapes only (never on prose that merely mentions a
// word): a wrong "temporary" verdict retries something that can only fail
// again, and a wrong "account" verdict hides a retryable error behind a
// settings button. Anything unrecognised is 'unknown' — shown in the
// provider's own words, offered a Retry — which is never worse than today.
//
// Sources (each rule cites its own): Anthropic errors + rate limits
// (platform.claude.com/docs/en/api/errors, /api/rate-limits), OpenAI error
// codes (developers.openai.com/api/docs/guides/error-codes), OpenRouter errors
// (openrouter.ai/docs/api_reference/errors-and-debugging), Gemini API errors
// (ai.google.dev/gemini-api/docs/api-errors), and the AI SDK's own wrappers
// (@ai-sdk/provider-utils handleFetchError: "Cannot connect to API: …",
// "Failed to process successful response").

import { log } from '../logger';

type FailureKind =
  /** Overload, rate limit, server error, network. Retried with backoff. */
  | 'temporary'
  /** Key, sign-in, credits, quota, spend cap, permission. Never retried. */
  | 'account'
  /** The request is too big for the model (context window / request bytes). */
  | 'too-long'
  /** Provider policy refused the request. Never retried unchanged. */
  | 'blocked'
  /** Not recognised. Not retried automatically; the user may Retry. */
  | 'unknown';

export interface ProviderFailure {
  kind: FailureKind;
  /** Stable machine code for the chat card (renderer picks wording/buttons). */
  code: string;
  /** Seconds the provider asked us to wait, when it said (retry-after). */
  retryAfterSec?: number;
}

/** Step-level retry waits for a temporary failure, when the provider names none:
 *  1, 2, 4, 8, 15, 30 s — about a minute in all. WHY this long (was 1/2/4 s): an
 *  Anthropic overload or a network blip routinely outlasts seven seconds, and
 *  ending the turn there threw away a turn a short wait would have finished. */
export const TEMPORARY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
/** The longest provider-requested wait we honour inside a turn. Longer, and the
 *  turn ends with the provider's words and a Retry instead of hanging silently. */
export const MAX_RETRY_AFTER_MS = 60_000;

/** How long to wait before retry number `attempt`, or null to give up: only a
 *  TEMPORARY failure is retried (an account, too-long or blocked one can only
 *  fail again), at most delays.length times, honouring the provider's
 *  retry-after up to MAX_RETRY_AFTER_MS. */
export function retryWaitMs(error: unknown, attempt: number, delays: readonly number[]): number | null {
  const failure = classifyFailure(error);
  if (failure.kind !== 'temporary' || attempt >= delays.length) return null;
  return failure.retryAfterSec !== undefined ? Math.min(failure.retryAfterSec * 1000, MAX_RETRY_AFTER_MS) : delays[attempt];
}

/** setTimeout that ends early (without throwing) when `signal` aborts — so Stop
 *  during a retry wait takes effect at once rather than after the wait. */
export function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

function parseBody(e: any): any {
  if (e?.data && typeof e.data === 'object') return e.data;
  if (typeof e?.responseBody === 'string') { try { return JSON.parse(e.responseBody); } catch { /* not JSON */ } }
  return undefined;
}

function header(e: any, name: string): string | undefined {
  const h = e?.responseHeaders;
  if (!h || typeof h !== 'object') return undefined;
  const hit = Object.keys(h).find((k) => k.toLowerCase() === name);
  return hit && typeof h[hit] === 'string' ? h[hit] : undefined;
}

/** retry-after in seconds, or undefined. Accepts both the delta-seconds and
 *  the HTTP-date forms (RFC 9110); a past or absurd value is ignored. */
export function retryAfterSeconds(e: any, now = Date.now()): number | undefined {
  const raw = header(e?.lastError ?? e, 'retry-after');
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n)) return n > 0 && n < 86_400 ? n : undefined;
  const at = Date.parse(raw);
  const s = Number.isFinite(at) ? (at - now) / 1000 : NaN;
  return s > 0 && s < 86_400 ? s : undefined;
}

function networkCodeOf(e: any): string | undefined {
  for (let x = e, depth = 0; x && depth < 4; x = x.cause, depth++) {
    if (typeof x.code === 'string' && NETWORK_CODES.has(x.code)) return x.code;
  }
  return undefined;
}

export function classifyFailure(error: unknown): ProviderFailure {
  const e: any = (error as any)?.lastError ?? error;
  if (!e || typeof e !== 'object') return { kind: 'unknown', code: 'unknown' };
  // Codes an earlier layer already decided (OpenRouter's ProviderAccountError,
  // ChatGPT sign-in) — those layers read the provider's real answer.
  if (typeof e.errorCode === 'string') return { kind: 'account', code: e.errorCode };

  const status: number | undefined = e.statusCode ?? e.status;
  const body = parseBody(e);
  const err = body?.error ?? body;
  const type = typeof err?.type === 'string' ? err.type : undefined;
  const codeField = typeof err?.code === 'string' ? err.code : typeof err?.status === 'string' ? err.status : undefined;
  const message = String(err?.message ?? body?.message ?? e.message ?? '');
  const orType = typeof err?.metadata?.error_type === 'string' ? err.metadata.error_type : undefined;
  const retryAfterSec = retryAfterSeconds(e);
  const temporary = (code: string): ProviderFailure => ({ kind: 'temporary', code, ...(retryAfterSec !== undefined ? { retryAfterSec } : {}) });

  // ── Too long ──────────────────────────────────────────────────────────
  // Anthropic 400 "prompt is too long", 413 request_too_large; OpenAI/OpenRouter
  // context_length_exceeded; llama.cpp exceed_context_size_error.
  if (status === 413 || type === 'request_too_large') return { kind: 'too-long', code: 'request-too-large' };
  if (codeField === 'context_length_exceeded' || orType === 'context_length_exceeded'
    || type === 'exceed_context_size_error' || /^prompt is too long: \d+ tokens > \d+ maximum$/.test(message)) {
    return { kind: 'too-long', code: 'context-too-long' };
  }

  // ── Account ───────────────────────────────────────────────────────────
  // Anthropic spend cap: 429 rate_limit_error WITHOUT retry-after, details code
  // enforced_spend_limit_reached; a user-set limit is a 400 "You have reached
  // your specified … API usage limits". OpenAI insufficient_quota (also a 429).
  if (err?.details?.error_code === 'enforced_spend_limit_reached') return { kind: 'account', code: 'spend-limit' };
  if (/^You have reached your specified (workspace )?API usage limits/.test(message)) return { kind: 'account', code: 'spend-limit' };
  if (codeField === 'insufficient_quota' || type === 'insufficient_quota') return { kind: 'account', code: 'quota-exhausted' };
  if (status === 402 || type === 'billing_error') return { kind: 'account', code: 'out-of-credits' };
  if (status === 401 || type === 'authentication_error' || codeField === 'invalid_api_key') return { kind: 'account', code: 'key-rejected' };
  // OpenRouter 403 is also its moderation block — told apart by metadata.reasons.
  if (status === 403 && Array.isArray(err?.metadata?.reasons)) return { kind: 'blocked', code: 'moderation' };
  if (status === 403 || type === 'permission_error' || codeField === 'PERMISSION_DENIED') return { kind: 'account', code: 'no-access' };
  if (status === 404 || type === 'not_found_error' || codeField === 'model_not_found') return { kind: 'account', code: 'model-unavailable' };

  // ── Blocked ───────────────────────────────────────────────────────────
  if (codeField === 'content_filter' || codeField === 'content_policy_violation' || orType === 'moderation') {
    return { kind: 'blocked', code: 'policy' };
  }

  // ── Temporary ─────────────────────────────────────────────────────────
  if (status === 529 || type === 'overloaded_error') return temporary('overloaded');
  if (status === 429 || type === 'rate_limit_error' || codeField === 'RESOURCE_EXHAUSTED') return temporary('rate-limited');
  if (status === 408 || status === 409) return temporary('provider-timeout');
  if (status !== undefined && status >= 500 && status < 600) return temporary('server-error');
  // OpenRouter delivers a mid-stream upstream failure as an SSE error chunk on a
  // 200 response; its envelope carries error.code as a NUMBER (the upstream status).
  if (typeof err?.code === 'number' && (err.code === 429 || err.code === 408 || err.code === 529 || (err.code >= 500 && err.code < 600))) {
    return temporary('upstream-error');
  }
  // The AI SDK's own network wrapper, and raw network codes from fetch/undici.
  if (/^Cannot connect to API:/.test(String(e.message ?? '')) || networkCodeOf(e)) return temporary('network');
  // A 2xx whose body the SDK could not parse — a cut-off or garbled response.
  // Seen in the app log on background specialists (2026-10-20). Retrying the
  // same request is safe (nothing was accepted) and usually succeeds.
  if (e.message === 'Failed to process successful response') return temporary('garbled-response');

  return { kind: 'unknown', code: 'unknown' };
}

/** Sort a turn-ending failure and leave one line in ~/.claude/desktop.log.
 *  WHY (2026-10-21): `session-error` is display-only — never written to the
 *  transcript — so a reported "stuck conversation" left no trace to diagnose; the
 *  session that fixed it found the conversation only by elimination. Kind, code
 *  and HTTP status only: never the message, which can quote the conversation. */
export function logTurnFailure(sessionId: string, error: unknown): ProviderFailure {
  const failure = classifyFailure(error);
  const e: any = (error as any)?.lastError ?? error;
  log('WARN', 'HarnessSession', 'turn ended with a provider error', { sessionId, kind: failure.kind, code: failure.code, status: e?.statusCode ?? e?.status });
  return failure;
}
