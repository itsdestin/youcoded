// Pure pieces of the Welcome back renderer state (design §5,
// docs/active/specs/2026-09-24-welcome-back-design.md in the workspace): the
// model-matching rules a batch resume needs, with no IPC involved. The
// IPC-backed halves (fetchReopenList/forgetReopenList) are exercised through
// ResumeBrowser-welcome-back.test.tsx and app-welcome-back-gating.test.tsx,
// which mount real components against a mocked window.claude.session.
import { describe, it, expect } from 'vitest';
import { resolveNativeBinding, claudeModelFor } from '../src/renderer/state/welcome-back';

describe('resolveNativeBinding', () => {
  const providers = [
    { id: 'ulid-openrouter', type: 'openrouter' },
    { id: 'ulid-anthropic', type: 'anthropic' },
  ];
  const catalog = [
    { id: 'gpt-5', providerId: 'ulid-openrouter' },
    { id: 'claude-x', providerId: 'ulid-anthropic' },
  ];

  it('is null when the row records no last-used model', () => {
    expect(resolveNativeBinding(undefined, providers, catalog)).toBeNull();
  });

  it('matches a model whose provider TYPE and id both exist on this device', () => {
    expect(resolveNativeBinding(
      { modelId: 'gpt-5', providerType: 'openrouter', providerLabel: 'OpenRouter' },
      providers, catalog,
    )).toEqual({ providerId: 'ulid-openrouter', modelId: 'gpt-5' });
  });

  it('is null when the model id is not in the catalog at all', () => {
    expect(resolveNativeBinding(
      { modelId: 'gpt-4-nonexistent', providerType: 'openrouter', providerLabel: 'OpenRouter' },
      providers, catalog,
    )).toBeNull();
  });

  it('is null when the model id exists but under a DIFFERENT provider type — a same-named model on the wrong provider is not a match', () => {
    // catalog has 'gpt-5' under openrouter only; asking for it under anthropic
    // must not cross-match just because the id string is the same.
    expect(resolveNativeBinding(
      { modelId: 'gpt-5', providerType: 'anthropic', providerLabel: 'Anthropic' },
      providers, catalog,
    )).toBeNull();
  });

  it('is null when no provider of the recorded type is configured on this device', () => {
    expect(resolveNativeBinding(
      { modelId: 'llama-4', providerType: 'ollama', providerLabel: 'Ollama' },
      providers, catalog,
    )).toBeNull();
  });
});

describe('claudeModelFor', () => {
  it('maps a recorded Claude family model to its alias', () => {
    expect(claudeModelFor({ modelId: 'claude-opus-5', providerType: 'claude-code', providerLabel: 'Claude Code' }, 'sonnet')).toBe('opus[1m]');
  });

  it('falls back to the given default when the row records no model (native row, unresolved binding)', () => {
    expect(claudeModelFor(undefined, 'haiku')).toBe('haiku');
  });

  it('falls back to the given default for a model id outside the four Claude families', () => {
    expect(claudeModelFor({ modelId: '<synthetic>', providerType: 'claude-code', providerLabel: 'Claude Code' }, 'sonnet')).toBe('sonnet');
  });

  it('falls back to "sonnet" when there is neither a mapped alias nor a caller-supplied default', () => {
    expect(claudeModelFor(undefined, undefined)).toBe('sonnet');
  });
});
