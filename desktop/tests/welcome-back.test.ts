// Pure pieces of the Welcome back renderer state (design §5,
// docs/active/specs/2026-09-24-welcome-back-design.md in the workspace): the
// model-matching rules a batch resume needs, with no IPC involved. The
// IPC-backed halves (fetchReopenList/forgetReopenList) are exercised through
// ResumeBrowser-welcome-back.test.tsx and app-welcome-back-gating.test.tsx,
// which mount real components against a mocked window.claude.session.
import { describe, it, expect } from 'vitest';
import { resolveNativeBinding } from '../src/renderer/state/welcome-back';

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

  it('reuses a uniquely named ready custom endpoint even though typed models have no catalog', () => {
    const custom = { id: 'lab', type: 'openai-compatible', label: 'My endpoint', enabled: true, ready: true };
    expect(resolveNativeBinding({ modelId: 'typed-model', providerType: 'openai-compatible', providerLabel: 'My endpoint' }, [custom], []))
      .toEqual({ providerId: 'lab', modelId: 'typed-model' });
  });

  it('does not guess between custom endpoints or reuse a disabled/unready endpoint', () => {
    const ref = { modelId: 'typed-model', providerType: 'openai-compatible', providerLabel: 'My endpoint' };
    const custom = { id: 'a', type: 'openai-compatible', label: 'My endpoint', enabled: true, ready: true };
    expect(resolveNativeBinding(ref, [custom, { ...custom, id: 'b' }], [])).toBeNull();
    expect(resolveNativeBinding(ref, [{ ...custom, enabled: false }], [])).toBeNull();
    expect(resolveNativeBinding(ref, [{ ...custom, ready: false }], [])).toBeNull();
    expect(resolveNativeBinding(ref, [{ ...custom, label: 'A different endpoint' }], [])).toBeNull();
    expect(resolveNativeBinding({ ...ref, providerType: 'local-engine' }, [{ ...custom, type: 'local-engine' }], [])).toBeNull();
  });

  it('is null when no provider of the recorded type is configured on this device', () => {
    expect(resolveNativeBinding(
      { modelId: 'llama-4', providerType: 'ollama', providerLabel: 'Ollama' },
      providers, catalog,
    )).toBeNull();
  });
});
