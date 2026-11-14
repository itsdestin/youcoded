// Card #176 (deck C-7): worded "conversation too long" refusals from other providers get Summarise like Claude's.
// Provenance of each shape is in context-overflow.ts. In short: ONLY the openai-compatible code was captured from a real reply of ours;
// everything below marked DOC comes from provider documentation or a quoted community report, not a call we made (no paid runs).
import { describe, it, expect } from 'vitest';
import { isContextOverflow } from '../src/main/providers/context-overflow';
import { classifyFailure } from '../src/main/providers/provider-failure';

const api = (status: number, body: unknown) => ({ statusCode: status, responseBody: JSON.stringify(body) });

// DOC: DeepSeek reply as quoted in an n8n forum thread (65536 limit, 73149 requested).
const DEEPSEEK = api(400, { error: { message: "This model's maximum context length is 65536 tokens. However, you requested 73149 tokens (73149 in the messages, 0 in the completion). Please reduce the length of the messages or completion.", type: 'invalid_request_error', param: null, code: 'invalid_request_error' } });
// DOC: the same OpenAI wording passed through by OpenRouter, whose envelope carries the status as a number in error.code.
const OPENROUTER_WORDS = api(400, { error: { code: 400, message: "This endpoint's maximum context length is 131072 tokens. However, you requested about 140000 tokens (130000 of text input, 10000 of tool input). Please reduce the length of either one." } });
// DOC: Mistral reply quoted in a Google Cloud community post (code 3051).
const MISTRAL = api(400, { object: 'error', message: 'Prompt contains 65673 tokens and 0 draft tokens, too large for model with 32768 maximum context length', type: 'invalid_request_error', param: null, code: '3051' });
const MISTRAL_ENVELOPED = api(400, { error: { message: 'Prompt contains 65673 tokens, too large for model with 32768 maximum context length', type: 'invalid_request_error', code: '3051' } });

describe('worded context-too-long refusals', () => {
  it('a custom OpenAI-compatible endpoint (DeepSeek wording) is recovered', () => {
    expect(isContextOverflow(DEEPSEEK, '01HRANDOMID', 'openai-compatible')).toBe(true);
  });
  it('OpenRouter passing the same words through is recovered', () => {
    expect(isContextOverflow(OPENROUTER_WORDS, 'openrouter')).toBe(true);
  });
  it('Mistral wording is recovered (either envelope)', () => {
    expect(isContextOverflow(MISTRAL_ENVELOPED, '01HRANDOMID', 'openai-compatible')).toBe(true);
    // Mistral's bare body has no `error` wrapper; the message sits at the top, so it is read by the error card only.
    expect(classifyFailure(MISTRAL)).toEqual({ kind: 'too-long', code: 'context-too-long' });
  });
  it('the red card for each shape says too-long, which is what offers Summarise and continue', () => {
    for (const r of [DEEPSEEK, OPENROUTER_WORDS, MISTRAL_ENVELOPED]) expect(classifyFailure(r)).toEqual({ kind: 'too-long', code: 'context-too-long' });
  });
  it('does not widen: other 400s, other statuses, near-miss sentences and unknown providers are left alone', () => {
    const near = (msg: string, status = 400) => api(status, { error: { message: msg, type: 'invalid_request_error' } });
    expect(isContextOverflow(near('Invalid value for max_tokens'), '01HRANDOMID', 'openai-compatible')).toBe(false);
    expect(isContextOverflow(near("This model's maximum context length is 65536 tokens.", 500), '01HRANDOMID', 'openai-compatible')).toBe(false);
    expect(isContextOverflow(near('Please note: this model\'s maximum context length is 65536 tokens.'), '01HRANDOMID', 'openai-compatible')).toBe(false);
    // Same words from a provider the app does not know the type of: no guess.
    expect(isContextOverflow(DEEPSEEK, '01HRANDOMID', undefined)).toBe(false);
    expect(classifyFailure(near('Invalid value for max_tokens'))).toEqual({ kind: 'unknown', code: 'unknown' });
  });
});
