import { describe, it, expect } from 'vitest';
import { unavailableReason, type AvailabilityData } from '../src/renderer/components/model/availability';
import type { ModelChoice } from '../src/renderer/components/model/ModelPicker';
import type { ClaudeAccountStatus } from '../src/shared/claude-account-types';

// THE BUG, pinned (2026-09-09). Destin: "it says my claude code models are
// unavailable in the model switcher because I'm not signed in, but I definitely
// am signed in and I can still use Opus fine when it's the pre-filled default."
//
// Cause: this file's Claude branch read the SETUP WIZARD's saved notes, and on
// every launch after the first main answers that call with a bare
// `{currentStep:'COMPLETE'}` — no auth fields at all. The menu read the blank as
// "signed out". It now reads Claude Code's own live answer, and these tests pin
// the part that must never regress: only a DEFINITE no greys anything out.

const OPUS: ModelChoice = { runtime: 'claude', alias: 'opus[1m]' };

const data = (claudeStatus: ClaudeAccountStatus | null): AvailabilityData =>
  ({ providers: [], catalog: [], claudeStatus });

describe('the model menu and Claude Code', () => {
  it('a signed-in install can run Opus', () => {
    expect(unavailableReason(OPUS, data({ state: 'signed-in', plan: 'max', apiKey: false }))).toBeNull();
  });

  it('an API-key install can run Opus too', () => {
    expect(unavailableReason(OPUS, data({ state: 'signed-in', apiKey: true }))).toBeNull();
  });

  it('THE REGRESSION: no answer yet must not grey out a working install', () => {
    // Null is the first-frames state, before the probe returns. Greying here is
    // what the user saw and reported.
    expect(unavailableReason(OPUS, data(null))).toBeNull();
  });

  it('THE REGRESSION: an unreadable answer must not grey out a working install', () => {
    expect(unavailableReason(OPUS, data({ state: 'unknown' }))).toBeNull();
  });

  it('a definite signed-out greys the row and says why', () => {
    expect(unavailableReason(OPUS, data({ state: 'signed-out' }))).toBe('Sign in to use');
  });

  it('a missing binary gets its own words — signing in would not fix it', () => {
    expect(unavailableReason(OPUS, data({ state: 'not-installed' }))).toBe('Claude Code not installed');
  });

  it('a retired alias is still reported as retired, whatever the sign-in says', () => {
    const gone: ModelChoice = { runtime: 'claude', alias: 'opus-3' };
    expect(unavailableReason(gone, data({ state: 'signed-in', apiKey: false }))).toBe('No longer available');
  });

  it('Claude Code\'s sign-in has no bearing on another provider\'s models', () => {
    // Regression guard for the reverse mistake: a signed-out Claude must not
    // grey out an OpenRouter or local model.
    const other: ModelChoice = { runtime: 'native', providerId: 'openrouter', modelId: 'x/y' };
    const d: AvailabilityData = {
      providers: [{ id: 'openrouter', type: 'openrouter', label: 'OpenRouter', ready: true }],
      catalog: [{ id: 'x/y', providerId: 'openrouter', label: 'Y' }],
      claudeStatus: { state: 'signed-out' },
    };
    expect(unavailableReason(other, d)).toBeNull();
  });
});
