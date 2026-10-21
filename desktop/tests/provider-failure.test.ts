import { describe, it, expect, vi } from 'vitest';
import { classifyFailure, retryAfterSeconds, retryWaitMs, abortableDelay, MAX_RETRY_AFTER_MS } from '../src/main/providers/provider-failure';

/** An AI SDK APICallError-shaped object, as the providers throw them. */
const api = (statusCode: number | undefined, body?: unknown, extra: Record<string, unknown> = {}) =>
  ({ statusCode, responseBody: body === undefined ? undefined : JSON.stringify(body), ...extra });
const anthropic = (status: number, type: string, message: string, more: Record<string, unknown> = {}) =>
  api(status, { type: 'error', error: { type, message, ...more } });

describe('classifyFailure sorts provider errors by their documented shape', () => {
  it.each([
    ['Anthropic overloaded (529)', anthropic(529, 'overloaded_error', 'Overloaded'), 'temporary', 'overloaded'],
    ['Anthropic rate limit (429 with retry-after)', { ...anthropic(429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit'), responseHeaders: { 'retry-after': '12' } }, 'temporary', 'rate-limited'],
    ['Anthropic server error (500)', anthropic(500, 'api_error', 'Internal server error'), 'temporary', 'server-error'],
    ['OpenAI 503', api(503, { error: { message: 'The server is overloaded', type: 'server_error' } }), 'temporary', 'server-error'],
    ['Gemini 429 RESOURCE_EXHAUSTED', api(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }), 'temporary', 'rate-limited'],
    ['OpenRouter 408 upstream timeout', api(408, { error: { code: 408, message: 'Timed out' } }), 'temporary', 'provider-timeout'],
    ['OpenRouter mid-stream upstream failure (200 with error chunk)', { message: 'Provider returned error', code: 502, error: { code: 502 }, data: { error: { code: 502, message: 'Upstream error' } } }, 'temporary', 'upstream-error'],
    ['the AI SDK network wrapper', { message: 'Cannot connect to API: getaddrinfo EAI_AGAIN chatgpt.com' }, 'temporary', 'network'],
    ['a raw socket reset several causes deep', { message: 'fetch failed', cause: { message: 'other side closed', cause: { code: 'UND_ERR_SOCKET' } } }, 'temporary', 'network'],
    ['a garbled 2xx the SDK could not parse', { message: 'Failed to process successful response', statusCode: 200 }, 'temporary', 'garbled-response'],
  ])('%s → temporary', (_name, err, kind, code) => {
    expect(classifyFailure(err)).toMatchObject({ kind, code });
  });

  it.each([
    ['Anthropic spend cap (429, no retry-after, enforced_spend_limit_reached)', anthropic(429, 'rate_limit_error', 'You have reached your monthly spend cap', { details: { error_code: 'enforced_spend_limit_reached' } }), 'spend-limit'],
    ['Anthropic user-set spend limit (400)', anthropic(400, 'invalid_request_error', 'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.'), 'spend-limit'],
    ['OpenAI insufficient_quota (429)', api(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }), 'quota-exhausted'],
    ['OpenRouter out of credits (402)', api(402, { error: { code: 402, message: 'This request requires more credits' } }), 'out-of-credits'],
    ['Anthropic bad key (401)', anthropic(401, 'authentication_error', 'invalid x-api-key'), 'key-rejected'],
    ['OpenAI bad key', api(401, { error: { code: 'invalid_api_key', message: 'Incorrect API key provided' } }), 'key-rejected'],
    ['Anthropic permission (403)', anthropic(403, 'permission_error', 'Your API key does not have permission'), 'no-access'],
    ['model not found (404)', anthropic(404, 'not_found_error', 'model: claude-x'), 'model-unavailable'],
  ])('%s → account (never retried)', (_name, err, code) => {
    expect(classifyFailure(err)).toMatchObject({ kind: 'account', code });
  });

  it('keeps a code an earlier layer already decided (OpenRouter key check, ChatGPT sign-in)', () => {
    expect(classifyFailure({ message: 'Your OpenRouter key was rejected', errorCode: 'openrouter-key-rejected' })).toEqual({ kind: 'account', code: 'openrouter-key-rejected' });
    // …including through the step-retry wrapper.
    expect(classifyFailure({ lastError: { errorCode: 'chatgpt-signin-expired' } })).toEqual({ kind: 'account', code: 'chatgpt-signin-expired' });
  });

  it.each([
    ['Anthropic prompt is too long', anthropic(400, 'invalid_request_error', 'prompt is too long: 210000 tokens > 200000 maximum'), 'context-too-long'],
    ['OpenAI context_length_exceeded', api(400, { error: { code: 'context_length_exceeded', message: 'This model\'s maximum context length is 128000 tokens' } }), 'context-too-long'],
    ['OpenRouter context_length_exceeded', api(400, { error: { message: 'too long', metadata: { error_type: 'context_length_exceeded' } } }), 'context-too-long'],
    ['llama.cpp exceed_context_size_error', api(400, { error: { type: 'exceed_context_size_error', message: 'the request exceeds the available context size' } }), 'context-too-long'],
    ['Anthropic request_too_large (413)', anthropic(413, 'request_too_large', 'Request exceeds the maximum allowed number of bytes'), 'request-too-large'],
  ])('%s → too-long', (_name, err, code) => {
    expect(classifyFailure(err)).toMatchObject({ kind: 'too-long', code });
  });

  it('OpenRouter moderation (403 with reasons) is blocked, not an account problem', () => {
    expect(classifyFailure(api(403, { error: { code: 403, message: 'flagged', metadata: { reasons: ['violence'], flagged_input: '…' } } }))).toMatchObject({ kind: 'blocked', code: 'moderation' });
  });

  it('anything unrecognised is unknown — a plain 400, prose that merely mentions a word, junk', () => {
    expect(classifyFailure(anthropic(400, 'invalid_request_error', 'messages: text content blocks must be non-empty'))).toEqual({ kind: 'unknown', code: 'unknown' });
    expect(classifyFailure(new Error('the network team is overloaded with tickets'))).toEqual({ kind: 'unknown', code: 'unknown' });
    expect(classifyFailure(null)).toEqual({ kind: 'unknown', code: 'unknown' });
    expect(classifyFailure('rate limited')).toEqual({ kind: 'unknown', code: 'unknown' });
  });
});

describe('retry-after and the wait before each retry', () => {
  it('reads delta-seconds and HTTP-date forms, case-insensitively; ignores junk and absurd values', () => {
    expect(retryAfterSeconds({ responseHeaders: { 'Retry-After': '7' } })).toBe(7);
    expect(retryAfterSeconds({ responseHeaders: { 'retry-after': new Date(1_000_000 + 30_000).toUTCString() } }, 1_000_000)).toBe(30);
    expect(retryAfterSeconds({ responseHeaders: { 'retry-after': 'soon' } })).toBeUndefined();
    expect(retryAfterSeconds({ responseHeaders: { 'retry-after': '999999' } })).toBeUndefined();
    expect(retryAfterSeconds({})).toBeUndefined();
  });

  it('retries only temporary failures, honours retry-after up to the cap, and stops when the delays run out', () => {
    const delays = [100, 200];
    const overloaded = anthropic(529, 'overloaded_error', 'Overloaded');
    expect(retryWaitMs(overloaded, 0, delays)).toBe(100);
    expect(retryWaitMs(overloaded, 1, delays)).toBe(200);
    expect(retryWaitMs(overloaded, 2, delays)).toBeNull();
    expect(retryWaitMs({ ...overloaded, responseHeaders: { 'retry-after': '5' } }, 0, delays)).toBe(5_000);
    expect(retryWaitMs({ ...overloaded, responseHeaders: { 'retry-after': '3600' } }, 0, delays)).toBe(MAX_RETRY_AFTER_MS);
    // A spend cap is never retried, even though it is a 429.
    expect(retryWaitMs(anthropic(429, 'rate_limit_error', 'cap', { details: { error_code: 'enforced_spend_limit_reached' } }), 0, delays)).toBeNull();
    expect(retryWaitMs(anthropic(401, 'authentication_error', 'bad key'), 0, delays)).toBeNull();
  });

  it('abortableDelay ends at once when Stop is pressed, without the timer ever firing', async () => {
    vi.useFakeTimers();
    try {
      const stop = new AbortController();
      let done = false;
      const waiting = abortableDelay(10_000, stop.signal).then(() => { done = true; });
      await Promise.resolve();
      expect(done).toBe(false);          // still waiting: no time has passed
      stop.abort();
      await waiting;                     // resolves with the fake clock never advanced
      expect(done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);   // and it cleared its own timer
    } finally { vi.useRealTimers(); }
  });
});

describe('logTurnFailure leaves a content-free trace of a turn that ended in a provider error', () => {
  it('logs the kind, code and status — never the provider message', async () => {
    const logger = await import('../src/main/logger');
    const spy = vi.spyOn(logger, 'log').mockImplementation(() => {});
    try {
      const { logTurnFailure } = await import('../src/main/providers/provider-failure');
      const r = logTurnFailure('s-1', anthropic(529, 'overloaded_error', 'secret conversation text'));
      expect(r).toMatchObject({ kind: 'temporary', code: 'overloaded' });
      expect(spy).toHaveBeenCalledWith('WARN', 'HarnessSession', 'turn ended with a provider error', { sessionId: 's-1', kind: 'temporary', code: 'overloaded', status: 529 });
      expect(JSON.stringify(spy.mock.calls)).not.toContain('secret conversation text');
    } finally { spy.mockRestore(); }
  });
});
