import { describe, it, expect } from 'vitest';
import { imageTooLarge, manyImageEdgeLimit } from '../src/main/providers/image-too-large';

const MESSAGE = 'The image you provided requires 49868 patches after processing, exceeding the limit of 30000.';
const HIT = { requiredPatches: 49_868, limitPatches: 30_000 };

describe('imageTooLarge recognises the one captured sentence in any of three envelopes, status 400 only', () => {
  it('error.message (OpenAI JSON error envelope)', () => {
    expect(imageTooLarge({ statusCode: 400, responseBody: JSON.stringify({ error: { message: MESSAGE, type: 'invalid_request_error', code: null } }) })).toEqual(HIT);
  });
  it('detail (the Codex route answers refusals with a `detail` field — chatgpt-oauth.ts)', () => {
    expect(imageTooLarge({ statusCode: 400, responseBody: JSON.stringify({ detail: MESSAGE }) })).toEqual(HIT);
  });
  it('top-level message', () => {
    expect(imageTooLarge({ status: 400, data: { message: MESSAGE } })).toEqual(HIT);
  });
  it('unwraps the step-retry wrapper like describeProviderError', () => {
    expect(imageTooLarge({ lastError: { statusCode: 400, responseBody: JSON.stringify({ error: { message: MESSAGE } }) } })).toEqual(HIT);
  });
  it('is null for every other 400, any other status, prose-only partial matches and junk', () => {
    expect(imageTooLarge({ statusCode: 400, responseBody: JSON.stringify({ error: { message: 'messages: text content blocks must be non-empty' } }) })).toBeNull();
    expect(imageTooLarge({ statusCode: 413, responseBody: JSON.stringify({ error: { message: MESSAGE } }) })).toBeNull();
    expect(imageTooLarge({ statusCode: 400, responseBody: JSON.stringify({ error: { message: 'patches after processing' } }) })).toBeNull();
    expect(imageTooLarge({ statusCode: 400, responseBody: 'not json' })).toBeNull();
    expect(imageTooLarge(new Error(MESSAGE))).toBeNull();
    expect(imageTooLarge(null)).toBeNull();
    expect(imageTooLarge('rate limited')).toBeNull();
  });
});

describe('manyImageEdgeLimit recognises Anthropic\'s many-image rejection, status 400 only', () => {
  const EDGE = 'messages.21.content.91.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels';
  it('reads the named pixel cap from the Anthropic error envelope and through the retry wrapper', () => {
    expect(manyImageEdgeLimit({ statusCode: 400, responseBody: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: EDGE } }) })).toBe(2000);
    expect(manyImageEdgeLimit({ lastError: { statusCode: 400, responseBody: JSON.stringify({ error: { message: EDGE } }) } })).toBe(2000);
  });
  it('is null for the OpenAI patch sentence, other statuses and junk', () => {
    expect(manyImageEdgeLimit({ statusCode: 400, responseBody: JSON.stringify({ error: { message: MESSAGE } }) })).toBeNull();
    expect(manyImageEdgeLimit({ statusCode: 413, responseBody: JSON.stringify({ error: { message: EDGE } }) })).toBeNull();
    expect(manyImageEdgeLimit(new Error(EDGE))).toBeNull();
    expect(imageTooLarge({ statusCode: 400, responseBody: JSON.stringify({ error: { message: EDGE } }) })).toBeNull();
  });
});
