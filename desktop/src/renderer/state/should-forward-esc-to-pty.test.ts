import { describe, it, expect } from 'vitest';
import { shouldForwardEscToPty } from './should-forward-esc-to-pty';

describe('shouldForwardEscToPty', () => {
  const base = {
    defaultPrevented: false,
    viewMode: 'chat' as const,
    hasActiveSession: true,
  };

  it('forwards when all conditions are met', () => {
    expect(shouldForwardEscToPty(base)).toBe(true);
  });

  it('does NOT forward when the event was defaultPrevented by an overlay', () => {
    expect(shouldForwardEscToPty({ ...base, defaultPrevented: true })).toBe(false);
  });

  it('does NOT forward when view mode is terminal', () => {
    expect(shouldForwardEscToPty({ ...base, viewMode: 'terminal' })).toBe(false);
  });

  it('does NOT forward when there is no active session', () => {
    expect(shouldForwardEscToPty({ ...base, hasActiveSession: false })).toBe(false);
  });

  it('returns false when multiple guards fail', () => {
    expect(shouldForwardEscToPty({
      defaultPrevented: true,
      viewMode: 'terminal',
      hasActiveSession: false,
    })).toBe(false);
  });
});
