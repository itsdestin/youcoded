// desktop/tests/model-chip.test.ts
import { describe, it, expect } from 'vitest';
import { modelChipFor, supportsAliasCycling } from '../src/renderer/components/model-chip';

const cc = (model?: string) => ({ provider: 'claude', model });
const native = (model?: string) => ({ provider: 'native', model });

describe('modelChipFor', () => {
  // The bug this whole module exists for: every native session rendered the red
  // "Model unknown" error chip, because an OpenRouter/GGUF id matches none of
  // the four Claude Code aliases and fell through to the 'unknown' sentinel.
  it('renders a native session from its bound model id, never as unknown', () => {
    expect(modelChipFor(native('anthropic/claude-sonnet-5'), 'unknown')).toEqual({
      kind: 'native', label: 'Sonnet 5', modelId: 'anthropic/claude-sonnet-5',
    });
  });

  it('keeps the raw id alongside the label so the chip can show it on hover', () => {
    const chip = modelChipFor(native('Qwen3-30B-A3B-Q4_K_M.gguf'), 'unknown');
    expect(chip).toEqual({ kind: 'native', label: 'Qwen3 30B A3B', modelId: 'Qwen3-30B-A3B-Q4_K_M.gguf' });
  });

  // A native session mid-create has no binding yet. That is not an error state,
  // so it must not borrow the error chip.
  it('renders no chip for a native session whose binding has not landed', () => {
    expect(modelChipFor(native(undefined), 'unknown')).toBeUndefined();
  });

  it('ignores the CC alias entirely for native sessions', () => {
    // currentModel is stale CC state; the native binding must win.
    expect(modelChipFor(native('google/gemini-3-pro'), 'sonnet')).toEqual({
      kind: 'native', label: 'Gemini 3 Pro', modelId: 'google/gemini-3-pro',
    });
  });

  it('renders Claude Code sessions from the alias', () => {
    expect(modelChipFor(cc('claude-sonnet-4-6'), 'sonnet')).toEqual({ kind: 'alias', alias: 'sonnet' });
    expect(modelChipFor(cc(), 'opus[1m]')).toEqual({ kind: 'alias', alias: 'opus[1m]' });
  });

  // The error chip must SURVIVE for CC sessions — this fix narrows what counts
  // as unknown, it does not delete the honest-error state.
  it('still renders unknown for a Claude Code session whose model is unconfirmed', () => {
    expect(modelChipFor(cc(), 'unknown')).toEqual({ kind: 'unknown' });
    expect(modelChipFor(undefined, 'unknown')).toEqual({ kind: 'unknown' });
  });
});

describe('supportsAliasCycling', () => {
  // Regression: Shift+Space on a native session used to relabel the chip with a
  // CC alias the session was not running (guardedPtySend discards sendInput's
  // false return, so the optimistic writes ran anyway) and wrote that alias to
  // the global model preference.
  it('refuses native sessions', () => {
    expect(supportsAliasCycling(native('anthropic/claude-sonnet-5'))).toBe(false);
    expect(supportsAliasCycling(native(undefined))).toBe(false);
  });

  it('allows Claude Code sessions and an absent session', () => {
    expect(supportsAliasCycling(cc('claude-sonnet-4-6'))).toBe(true);
    expect(supportsAliasCycling(undefined)).toBe(true);
  });
});
