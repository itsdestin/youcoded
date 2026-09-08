import { describe, it, expect } from 'vitest';
import { KNOWN_MODELS, matchKnownModel } from '../src/main/harness/known-models';

describe('known-models registry', () => {
  it('every entry has a valid regex and a label', () => {
    for (const e of KNOWN_MODELS) {
      expect(() => new RegExp(e.match, 'i')).not.toThrow();
      expect(e.label.length).toBeGreaterThan(0);
    }
  });
  it('the named families each resolve (Qwen 3.5/3.6, Gemma 3n/4)', () => {
    expect(matchKnownModel('qwen3.6-35b-a3b-instruct-q4')?.label).toMatch(/Qwen 3\.6/);
    expect(matchKnownModel('qwen3.5-9b-instruct-q5')?.label).toMatch(/Qwen 3\.5/);
    expect(matchKnownModel('gemma-3n-e4b-it-q4')?.label).toMatch(/Gemma 3n/);
    expect(matchKnownModel('gemma-4-12b-it-q4')?.label).toMatch(/Gemma 4/);
  });
  it.each([
    'Qwen3.5-122B-A10B-Q4_K_M',
    'unsloth_Qwen3.5_122B_A10B_GGUF',
  ])('never lets the 122B-A10B family collide with the small-model regex: %s', (modelId) => {
    const small = KNOWN_MODELS.find((entry) => entry.label === 'Qwen 3.5 (small, ≤4B)')!;
    const large = KNOWN_MODELS.find((entry) => entry.label === 'Qwen 3.5 (large, MoE 122B-A10B)')!;
    expect(new RegExp(small.match, 'i').test(modelId)).toBe(false);
    expect(new RegExp(large.match, 'i').test(modelId)).toBe(true);
    const match = matchKnownModel(modelId);
    expect(match?.label).toBe(large.label);
    expect(match?.maxToolPresentation).toBe('full');
  });
  it('every entry carries a verified supportsTools boolean and a context ceiling', () => {
    for (const e of KNOWN_MODELS) {
      expect(typeof e.supportsTools).toBe('boolean');
      expect(e.maxContextWindow).toBeGreaterThan(0);
    }
  });
});
