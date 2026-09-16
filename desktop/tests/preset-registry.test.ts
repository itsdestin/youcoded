import { describe, it, expect } from 'vitest';
import { resolvePreset } from '../src/main/harness/preset-registry';

describe('resolvePreset', () => {
  it('resolves coder with auto-edit default mode and the coder body', () => {
    const p = resolvePreset('coder');
    expect(p.manifest.id).toBe('coder');
    expect(p.defaultMode).toBe('auto-edit');
    // 2026-09-05: the TodoWrite planning rule moved to prompts/shared-doctrine.ts
    // (said once for both presets); the coder body is recognised by its verify rule.
    expect(p.body).toContain('Verify your work');
    expect(p.presetRules).toEqual([]);
  });
  it('resolves assistant with ask default mode', () => {
    const p = resolvePreset('assistant');
    expect(p.defaultMode).toBe('ask');
    expect(p.body).toMatch(/WebSearch/);
  });
  it("maps legacy 'chat' AND unknown/undefined ids to assistant", () => {
    expect(resolvePreset('chat').manifest.id).toBe('assistant');
    expect(resolvePreset(undefined).manifest.id).toBe('assistant');
    expect(resolvePreset('bogus-future-id').manifest.id).toBe('assistant');
  });
  it('maps a Record permissionPolicy to presetRules (Phase 3 shape)', () => {
    const p = resolvePreset('coder', { ...resolvePreset('coder').manifest, permissionPolicy: { Bash: 'deny' } });
    expect(p.presetRules).toEqual([{ tool: 'Bash', action: 'deny' }]);
    expect(p.defaultMode).toBe('ask'); // Record form → conservative default
  });
});
