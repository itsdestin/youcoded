// HarnessSession v0 — the native runtime's turn loop (Phase 1 Plan A, Task 8).
// A plain Vercel AI SDK streamText call (NO tools) that emits the EXACT
// transcript-event protocol the chat reducer already consumes. These tests pin
// the emit surface — it's the contract Phase 2's tool agent must not move.
import { describe, it, expect, vi } from 'vitest';
import { HarnessSession, describeProviderError } from '../src/main/harness/harness-session';
import { ASSISTANT_PRESET } from '../src/shared/harness-manifest';
import type { TranscriptEvent } from '../src/shared/types';
// MockLanguageModelV4 + simulateReadableStream confirmed present in ai@7.0.22
// (node_modules/ai/dist/test/index.d.ts).
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { EMPTY_SKILL_CATALOG } from './helpers/harness-fakes';

function mockModel(parts: any[]) {
  return new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: parts }) }),
  });
}

// RAW provider (LanguageModelV4StreamPart) chunk shape — verified against
// @ai-sdk/provider in ai@7.0.22: deltas carry the chunk in `delta` (NOT `text`,
// which is the *transformed* fullStream field my implementation reads), and
// `finish.usage` is the nested V4 shape ({ inputTokens: { total }, outputTokens:
// { total } }). streamText transforms both into the flat forms the code consumes.
const TEXT_FINISH = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 'p1' },
  { type: 'text-delta', id: 'p1', delta: 'Hel' },
  { type: 'text-delta', id: 'p1', delta: 'lo!' },
  { type: 'text-end', id: 'p1' },
  // V4 finish reason is an object ({ unified, raw }); a plain 'stop' string
  // normalizes to 'other'. streamText re-flattens .finishReason back to 'stop'.
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 12 }, outputTokens: { total: 4 } } },
];

function collect(session: HarnessSession): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  return events;
}

describe('HarnessSession', () => {
  // skillCatalog: without it buildAiTools scans the REAL ~/.claude and the
  // attached tool set depends on the machine (Ubuntu CI found skills, macOS and
  // Windows did not — 2026-07-29).
  const opts = { sessionId: 's-1', cwd: 'C:/x', harness: ASSISTANT_PRESET, binding: { providerId: 'openrouter', modelId: 'm' }, skillCatalog: EMPTY_SKILL_CATALOG };

  it('send() emits user-message, merged-partId assistant-text deltas, and turn-complete with usage', async () => {
    const session = new HarnessSession(opts, async () => mockModel(TEXT_FINISH) as any);
    const events = collect(session);
    await session.send('hi');
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('user-message');
    expect(events[0].data.text).toBe('hi');
    const textEvents = events.filter((e) => e.type === 'assistant-text');
    expect(textEvents.length).toBeGreaterThanOrEqual(2);            // streamed as deltas, not one block
    expect(textEvents.every((e) => e.data.partId)).toBe(true);      // every delta carries the partId
    expect(textEvents.map((e) => e.data.text).join('')).toBe('Hello!');
    const done = events.find((e) => e.type === 'turn-complete')!;
    expect(done.data.usage).toMatchObject({ inputTokens: 12, outputTokens: 4 });
    expect(done.data.model).toBe('m');
    expect(typeof done.data.usage!.tokensPerSecond).toBe('number');
    expect(done.data.stopReason).toBe('end_turn');                  // 'stop' maps to CC's normal-completion name
  });

  it('a factory/stream failure emits session-error (never a hang) and ends the turn', async () => {
    const session = new HarnessSession(opts, async () => { throw new Error('OpenRouter needs an API key — add one in Settings → Providers.'); });
    const events = collect(session);
    await session.send('hi');
    const err = events.find((e) => e.type === 'session-error')!;
    expect(err.data.text).toMatch(/API key/);
    expect(events.find((e) => e.type === 'turn-complete')).toBeUndefined();
  });

  it('interrupt() aborts and emits user-interrupt instead of session-error', async () => {
    const never = new ReadableStream({ start() { /* never enqueues, never closes */ } });
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: never as any }) });
    const session = new HarnessSession(opts, async () => model as any);
    const events = collect(session);
    const sendP = session.send('hi');
    await new Promise((r) => setTimeout(r, 30));
    session.interrupt();
    await sendP;
    expect(events.some((e) => e.type === 'user-interrupt')).toBe(true);
    expect(events.some((e) => e.type === 'session-error')).toBe(false);
  });

  it('conversation history accumulates across turns (second call sees first exchange)', async () => {
    const seen: any[] = [];
    const factory = async () => new MockLanguageModelV4({
      doStream: async (req: any) => { seen.push(req.prompt); return { stream: simulateReadableStream({ chunks: TEXT_FINISH }) }; },
    }) as any;
    const session = new HarnessSession(opts, factory);
    collect(session);
    await session.send('first');
    await session.send('second');
    const secondPrompt = JSON.stringify(seen[1]);
    expect(secondPrompt).toContain('first');
    expect(secondPrompt).toContain('Hello!');
    expect(secondPrompt).toContain('second');
  });

  it('reasoning-delta emits assistant-thinking WITH text (the reducer reasoning path)', async () => {
    const REASON_THEN_TEXT = [
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'thinking...' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-start', id: 'p1' },
      { type: 'text-delta', id: 'p1', delta: 'Answer' },
      { type: 'text-end', id: 'p1' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
    ];
    const session = new HarnessSession(opts, async () => mockModel(REASON_THEN_TEXT) as any);
    const events = collect(session);
    await session.send('hi');
    const think = events.find((e) => e.type === 'assistant-thinking')!;
    expect(think.data.text).toBe('thinking...');
    expect(think.data.partId).toBeTruthy();
  });

  it('an error PART mid-stream emits session-error and ends the turn (distinct from a factory throw)', async () => {
    const ERROR_MIDSTREAM = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'p1' },
      { type: 'text-delta', id: 'p1', delta: 'partial ' },
      { type: 'error', error: new Error('upstream 502 from the provider') },
    ];
    const session = new HarnessSession(opts, async () => mockModel(ERROR_MIDSTREAM) as any);
    const events = collect(session);
    await session.send('hi');
    const err = events.find((e) => e.type === 'session-error')!;
    expect(err.data.text).toMatch(/502/);
    expect(events.some((e) => e.type === 'user-interrupt')).toBe(false);   // an error is not an interrupt
    expect(events.find((e) => e.type === 'turn-complete')).toBeUndefined();
  });

  // 2026-08-10 incident: the live roster run's Kimi K3 session died after 37
  // tool calls with session-error text literally '[object Object]' — the
  // ENTIRE error the user got, even though a *different* model's 402 (same
  // run, same cause: OpenRouter out of credits) surfaced perfectly via the
  // 'a wrapped provider error...' test below. Root cause: the AI SDK's
  // fullStream can hand back an 'error' part whose `.error` is a plain object
  // rather than an Error instance (confirmed via node_modules/ai's own
  // eventProcessor, which treats `part.error` as opaque). The old handler did
  // `new Error(String(part.error))` — String() on a plain object always
  // yields the literal text '[object Object]', discarding statusCode/message/
  // data before describeProviderError ever got a chance to read them.
  it('an error PART carrying a plain (non-Error) object surfaces its real detail, not [object Object]', async () => {
    const ERROR_MIDSTREAM_PLAIN_OBJECT = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'p1' },
      { type: 'text-delta', id: 'p1', delta: 'partial ' },
      {
        type: 'error',
        // A plain object, NOT `new Error(...)` — this is the shape that broke.
        error: {
          name: 'AI_APICallError',
          statusCode: 402,
          message: 'This request requires more credits, or fewer max_tokens. '
            + 'You requested up to 65536 tokens, but can only afford 29029.',
          data: {
            error: {
              message: 'This request requires more credits, or fewer max_tokens. '
                + 'You requested up to 65536 tokens, but can only afford 29029.',
              code: 402,
            },
          },
        },
      },
    ];
    const session = new HarnessSession(opts, async () => mockModel(ERROR_MIDSTREAM_PLAIN_OBJECT) as any);
    const events = collect(session);
    await session.send('hi');
    const err = events.find((e) => e.type === 'session-error')!;
    expect(err.data.text).not.toBe('[object Object]');
    expect(err.data.text).toMatch(/more credits/);
    expect(err.data.text).toMatch(/402/);
  });

  // Same incident, second half: the AI SDK's streamText has a DEFAULT
  // `onError` of `({ error }) => console.error(error)` — printing the raw
  // error object (stack + statusCode + responseHeaders, which can include a
  // set-cookie value, + responseBody) as a multi-line dump. Confirmed by
  // reading node_modules/ai/dist/index.js: any fullStream 'error' part
  // ALSO triggers `await onError({ error })` independent of the throw our
  // switch/case does — the SAME event this file's HarnessSession never
  // opted out of. This is "the CLI printed a giant raw error object" half of
  // the bug report: the harness's streamText call passed no `onError`, so a
  // stream failure — for EVERY model, not just the one whose text field
  // showed '[object Object]' — dumped its full raw shape to the console
  // instead of one bounded line.
  it('a stream error never lets the SDK dump the raw object to console — logging stays bounded and string-only', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const ERROR_MIDSTREAM = [
        { type: 'stream-start', warnings: [] },
        {
          type: 'error',
          error: {
            statusCode: 402,
            message: 'This request requires more credits, or fewer max_tokens.',
            responseHeaders: { 'set-cookie': 'sess=abc123; Path=/; HttpOnly; Secure' },
          },
        },
      ];
      const session = new HarnessSession(opts, async () => mockModel(ERROR_MIDSTREAM) as any);
      await session.send('hi');
      expect(spy).toHaveBeenCalled();   // still visible — never silenced entirely
      for (const call of spy.mock.calls) {
        expect(call.length).toBe(1);
        expect(typeof call[0]).toBe('string');       // never the raw object
        expect(call[0]).not.toContain('set-cookie');  // never a response header
        expect(call[0].length).toBeLessThan(500);     // bounded, not a multi-line dump
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('a wrapped provider error surfaces the ACTIONABLE detail, not the generic wrapper', async () => {
    // The exact shape captured from OpenRouter during live acceptance: an
    // AI_RetryError wrapping an AI_APICallError whose responseBody nests the
    // upstream reason at error.metadata.raw. The bare .message is useless
    // ("Provider returned error" / "Failed after 3 attempts").
    const apiErr: any = new Error('Provider returned error');
    apiErr.name = 'AI_APICallError';
    apiErr.statusCode = 429;
    apiErr.responseBody = JSON.stringify({
      error: {
        message: 'Provider returned error', code: 429,
        metadata: { raw: 'moonshotai/kimi-k3 is temporarily rate-limited upstream. Please retry shortly, or add your own key.' },
      },
    });
    const retryErr: any = new Error('Failed after 3 attempts. Last error: Provider returned error');
    retryErr.name = 'AI_RetryError';
    retryErr.lastError = apiErr;

    const session = new HarnessSession(opts, async () => { throw retryErr; });
    const events = collect(session);
    await session.send('hi');
    const err = events.find((e) => e.type === 'session-error')!;
    expect(err.data.text).toMatch(/rate-limited upstream/);
    expect(err.data.text).toMatch(/add your own key/);
    expect(err.data.text).toMatch(/429/);
    expect(err.data.text).not.toMatch(/Failed after 3 attempts/); // the useless wrapper is gone
  });

  describe('describeProviderError', () => {
    it('unwraps AI_RetryError → responseBody error.metadata.raw (OpenRouter)', () => {
      const api: any = new Error('Provider returned error');
      api.statusCode = 402;
      api.responseBody = JSON.stringify({ error: { metadata: { raw: 'Insufficient credits.' } } });
      const retry: any = new Error('Failed after 3 attempts.'); retry.lastError = api;
      expect(describeProviderError(retry)).toBe('Insufficient credits. (provider error 402)');
    });
    it('falls back to error.message when there is no metadata.raw', () => {
      const api: any = new Error('x'); api.statusCode = 400;
      api.responseBody = JSON.stringify({ error: { message: 'model not found' } });
      expect(describeProviderError(api)).toBe('model not found (provider error 400)');
    });
    it('reads a pre-parsed .data body', () => {
      const api: any = new Error('x'); api.statusCode = 401;
      api.data = { error: { message: 'invalid api key' } };
      expect(describeProviderError(api)).toBe('invalid api key (provider error 401)');
    });
    it('falls back to the raw message for a non-HTTP error (network, etc.)', () => {
      expect(describeProviderError(new Error('fetch failed'))).toBe('fetch failed');
      expect(describeProviderError(undefined)).toBe('The model request failed.');
    });

    // 2026-09-18: Destin saw "Plan proposal failed: Failed to process successful
    // response" on a plan card AND a red banner. That sentence is the ai SDK's
    // own wrapper for "something threw while I was reading a 200 response body"
    // — it names nothing a person can act on, so error-message-standards.md
    // forbids shipping it verbatim. Prefer the wrapped cause; otherwise say
    // what is actually known, without guessing why.
    it('never ships the SDK\'s opaque "Failed to process successful response" verbatim', () => {
      const api: any = new Error('Failed to process successful response');
      api.statusCode = 200;
      expect(describeProviderError(api)).toBe("The model's reply could not be read to the end.");
    });
    it('prefers the real cause the SDK wrapped, when it carries one', () => {
      const api: any = new Error('Failed to process successful response');
      api.statusCode = 200;
      api.cause = new Error('Unexpected end of JSON input');
      expect(describeProviderError(api)).toBe("Unexpected end of JSON input (while reading the model's reply)");
    });
    it('still prefers a structured provider body over the opaque wrapper', () => {
      const api: any = new Error('Failed to process successful response');
      api.statusCode = 502;
      api.responseBody = JSON.stringify({ error: { message: 'upstream timed out' } });
      expect(describeProviderError(api)).toBe('upstream timed out (provider error 502)');
    });
  });

  it('distinct text partIds are preserved per delta (deltas are not all merged under one id)', async () => {
    const TWO_PARTS = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'p1' },
      { type: 'text-delta', id: 'p1', delta: 'one' },
      { type: 'text-end', id: 'p1' },
      { type: 'text-start', id: 'p2' },
      { type: 'text-delta', id: 'p2', delta: 'two' },
      { type: 'text-end', id: 'p2' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
    ];
    const session = new HarnessSession(opts, async () => mockModel(TWO_PARTS) as any);
    const events = collect(session);
    await session.send('hi');
    const textEvents = events.filter((e) => e.type === 'assistant-text');
    expect(textEvents.map((e) => ({ id: e.data.partId, t: e.data.text }))).toEqual([
      { id: 'p1', t: 'one' },
      { id: 'p2', t: 'two' },
    ]);
  });

  it('send() while a turn is in flight rejects (callers must serialize)', async () => {
    const never = new ReadableStream({ start() { /* never closes — first turn stays in flight */ } });
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: never as any }) });
    const session = new HarnessSession(opts, async () => model as any);
    collect(session);
    const first = session.send('first');   // deliberately NOT awaited — stays in flight
    await expect(session.send('second')).rejects.toThrow(/serialize/i);
    // Clean up the dangling first turn so it doesn't leak into other tests.
    session.interrupt();
    await first;
  });
});
