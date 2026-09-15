import { describe, expect, it } from 'vitest';
import { cloudContextLength } from '../src/main/providers/cloud-context';
import type { CatalogModel, ProviderType } from '../src/shared/provider-types';

const standard = { openrouter: 'standard', chatgpt: 'standard' } as const;
const long = { openrouter: 'long', chatgpt: 'long' } as const;
const model = (contextLength?: number, maxContextLength?: number): CatalogModel => ({
  id: 'test-model', label: 'Test', providerId: 'custom-provider', contextLength, maxContextLength,
});

describe('cloud context operating budgets', () => {
  it.each(['openrouter', 'chatgpt'] as const)('never raises a smaller %s model beyond its supported window', (type) => {
    expect(cloudContextLength(type, model(128000), standard)).toBe(128000);
    expect(cloudContextLength(type, model(128000), long)).toBe(128000);
  });

  it('uses the separate ChatGPT maximum only for long context and respects lower caps', () => {
    expect(cloudContextLength('chatgpt', model(272000, 872000), standard)).toBe(272000);
    expect(cloudContextLength('chatgpt', model(272000, 872000), long)).toBe(872000);
    expect(cloudContextLength('chatgpt', model(272000), long)).toBe(272000);
    expect(cloudContextLength('chatgpt', model(272000, 128000), standard)).toBe(128000);
    expect(cloudContextLength('chatgpt', model(272000, 128000), long)).toBe(128000);
    expect(cloudContextLength('chatgpt', model(undefined, 872000), standard)).toBe(272000);
    expect(cloudContextLength('chatgpt', model(undefined, 872000), long)).toBe(872000);
  });

  it('caps OpenRouter at the selected approximate tier, not a hardcoded model name', () => {
    expect(cloudContextLength('openrouter', model(1048576), standard)).toBe(272000);
    expect(cloudContextLength('openrouter', model(1048576), long)).toBe(1048576);
    expect(cloudContextLength('openrouter', model(1200000), long)).toBe(1200000);
    expect(cloudContextLength('openrouter', model(2000000), long)).toBe(1200000);
    expect(cloudContextLength('openrouter', model(1048576, 128000), long)).toBe(1048576);
  });

  it('keeps preferences independent', () => {
    const preferences = { openrouter: 'long', chatgpt: 'standard' } as const;
    expect(cloudContextLength('openrouter', model(1048576), preferences)).toBe(1048576);
    expect(cloudContextLength('chatgpt', model(272000, 872000), preferences)).toBe(272000);
  });

  it.each([undefined, 0, -1, NaN, Infinity, 1.5])('does not invent a supported window from invalid metadata (%s)', (invalid) => {
    for (const type of ['openrouter', 'chatgpt'] as const) {
      expect(cloudContextLength(type, model(invalid, invalid), long)).toBeNull();
      expect(cloudContextLength(type, undefined, long)).toBeNull();
    }
  });

  it.each([undefined, 0, -1, NaN, Infinity, 1.5])('falls back independently when one ChatGPT window is invalid (%s)', (invalid) => {
    expect(cloudContextLength('chatgpt', model(272000, invalid), standard)).toBe(272000);
    expect(cloudContextLength('chatgpt', model(272000, invalid), long)).toBe(272000);
    expect(cloudContextLength('chatgpt', model(invalid, 872000), standard)).toBe(272000);
    expect(cloudContextLength('chatgpt', model(invalid, 872000), long)).toBe(872000);
  });

  it.each(['local-engine', 'openai-compatible', 'anthropic', 'openai', 'google', undefined] satisfies (ProviderType | undefined)[])(
    'does not apply these settings to %s', (type) => {
      expect(cloudContextLength(type, model(2000000, 8000), standard)).toBe(2000000);
      expect(cloudContextLength(type, model(2000000, 8000), long)).toBe(2000000);
    },
  );
});
