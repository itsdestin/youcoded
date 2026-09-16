import { describe, expect, it } from 'vitest';
import { recogniseKey } from '../src/renderer/components/first-run/recognise-key';

// First-run "Use an API key" (F-1): the prefix names the service. The longer
// prefixes must win over OpenAI's bare `sk-`, or every Anthropic and OpenRouter
// key would be sent to OpenAI.
describe('recogniseKey', () => {
  it('recognises each supported service', () => {
    expect(recogniseKey('sk-ant-api03-abc')).toBe('anthropic');
    expect(recogniseKey('sk-or-v1-abc')).toBe('openrouter');
    expect(recogniseKey('AIzaSyAbc')).toBe('google');
    expect(recogniseKey('sk-proj-abc')).toBe('openai');
  });
  it('ignores surrounding spaces', () => {
    expect(recogniseKey('  sk-ant-api03-abc \n')).toBe('anthropic');
  });
  it('cannot place anything else', () => {
    expect(recogniseKey('x7Hq29LmPz04Rk')).toBeNull();
    expect(recogniseKey('')).toBeNull();
  });
});
