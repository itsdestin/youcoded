import { describe, it, expect } from 'vitest';
import { buildSessionCreateArgs } from '../src/shared/session-create-args';

// The four native/claude conditionals every `session.create` caller used to
// hand-write. Each bullet below was a real defect in the buddy floater's copy
// before 2026-09-10, so these are regressions-in-waiting, not documentation.

describe('buildSessionCreateArgs', () => {
  it('a claude session carries its alias and its skip-permissions flag', () => {
    const args = buildSessionCreateArgs({
      name: 'New Session', cwd: '/p', runtime: 'claude', model: 'opus[1m]', skipPermissions: true,
    });
    expect(args).toMatchObject({
      name: 'New Session', cwd: '/p', provider: 'claude', model: 'opus[1m]', skipPermissions: true,
    });
    expect(args.binding).toBeUndefined();
    expect(args.preset).toBeUndefined();
  });

  it('a native session NEVER carries a Claude alias', () => {
    // The buddy form kept whatever alias was last selected and sent it alongside
    // provider:'native'. The harness ignores `model` and runs binding.modelId, so
    // the payload claimed one model and ran another.
    const args = buildSessionCreateArgs({
      name: 'New Session', cwd: '/p', runtime: 'native', model: 'sonnet',
      binding: { providerId: 'openrouter', modelId: 'gpt-5' }, preset: 'coder',
    });
    expect(args.model).toBeUndefined();
    expect(args.provider).toBe('native');
    expect(args.binding).toEqual({ providerId: 'openrouter', modelId: 'gpt-5' });
    expect(args.preset).toBe('coder');
  });

  it('a native session can never be created with skipPermissions true', () => {
    // Native has no PTY and no permission flow, so a true here is a promise the
    // runtime cannot keep. Forced false rather than trusted from the caller.
    const args = buildSessionCreateArgs({
      name: 'New Session', cwd: '/p', runtime: 'native', skipPermissions: true,
      binding: { providerId: 'p', modelId: 'm' },
    });
    expect(args.skipPermissions).toBe(false);
  });

  it('a claude session never carries a binding or a preset', () => {
    // Both are native-only. A stale binding riding along on a Claude create is
    // how a payload starts describing a session that is not the one being made.
    const args = buildSessionCreateArgs({
      name: 'New Session', cwd: '/p', runtime: 'claude', model: 'sonnet',
      binding: { providerId: 'p', modelId: 'm' }, preset: 'coder',
    });
    expect(args.binding).toBeUndefined();
    expect(args.preset).toBeUndefined();
  });

  it('carries resumeSessionId through untouched, on both runtimes', () => {
    expect(buildSessionCreateArgs({
      name: 'Resuming...', cwd: '/p', runtime: 'claude', model: 'sonnet', resumeSessionId: 'abc',
    }).resumeSessionId).toBe('abc');
    expect(buildSessionCreateArgs({
      name: 'Resuming…', cwd: '/p', runtime: 'native',
      binding: { providerId: 'p', modelId: 'm' }, resumeSessionId: 'abc',
    }).resumeSessionId).toBe('abc');
  });

  it('defaults skipPermissions to false rather than leaving it undefined', () => {
    // session-manager reads it as a boolean; an undefined would be falsy today
    // and is one refactor away from not being.
    expect(buildSessionCreateArgs({ name: 'n', cwd: '/p', runtime: 'claude' }).skipPermissions).toBe(false);
  });
});
