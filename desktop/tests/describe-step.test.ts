import { describe, it, expect } from 'vitest';
import { describeStep } from '../src/renderer/components/first-run/describe-step';
import type { FirstRunState } from '../src/shared/first-run-types';

function state(overrides: Partial<FirstRunState> = {}): FirstRunState {
  return {
    currentStep: 'DETECT_PREREQUISITES',
    prerequisites: [
      { name: 'node', displayName: 'Node.js', status: 'waiting' },
      { name: 'git', displayName: 'Git', status: 'waiting' },
      { name: 'claude', displayName: 'Claude Code', status: 'waiting' },
      { name: 'auth', displayName: 'Sign in', status: 'waiting' },
    ],
    overallProgress: 0,
    statusMessage: '',
    authMode: 'none',
    authComplete: false,
    needsDevMode: false,
    ...overrides,
  };
}

describe('describeStep', () => {
  it('describes the detect phase when nothing is installing yet', () => {
    expect(describeStep(state({ currentStep: 'DETECT_PREREQUISITES' })))
      .toBe("Checking what's already installed on this machine.");
  });

  it('names the currently-installing prerequisite (Node.js)', () => {
    const s = state({
      currentStep: 'INSTALL_PREREQUISITES',
      prerequisites: [
        { name: 'node', displayName: 'Node.js', status: 'installing' },
        { name: 'git', displayName: 'Git', status: 'waiting' },
        { name: 'claude', displayName: 'Claude Code', status: 'waiting' },
        { name: 'auth', displayName: 'Sign in', status: 'waiting' },
      ],
    });
    expect(describeStep(s)).toBe(
      'Installing Node.js — this runs the AI engine under the hood.',
    );
  });

  it('names Git when Git is installing', () => {
    const s = state({
      currentStep: 'INSTALL_PREREQUISITES',
      prerequisites: [
        { name: 'node', displayName: 'Node.js', status: 'installed', version: 'v20.11.0' },
        { name: 'git', displayName: 'Git', status: 'installing' },
        { name: 'claude', displayName: 'Claude Code', status: 'waiting' },
        { name: 'auth', displayName: 'Sign in', status: 'waiting' },
      ],
    });
    expect(describeStep(s)).toBe(
      'Installing Git — used to keep YouCoded and your skills up to date.',
    );
  });

  it('names Claude Code when Claude is installing', () => {
    const s = state({
      currentStep: 'INSTALL_PREREQUISITES',
      prerequisites: [
        { name: 'node', displayName: 'Node.js', status: 'installed' },
        { name: 'git', displayName: 'Git', status: 'installed' },
        { name: 'claude', displayName: 'Claude Code', status: 'installing' },
        { name: 'auth', displayName: 'Sign in', status: 'waiting' },
      ],
    });
    expect(describeStep(s)).toBe(
      'Installing Claude Code — the AI that powers YouCoded.',
    );
  });

  it('describes the auth step', () => {
    expect(describeStep(state({ currentStep: 'AUTHENTICATE' })))
      .toBe('Sign in with an account, or run a model on this computer, to finish setup.');
  });

  it('describes the developer-mode step', () => {
    expect(describeStep(state({ currentStep: 'ENABLE_DEVELOPER_MODE' })))
      .toBe("One Windows setting to enable, then we're done.");
  });

  it('describes the completion step', () => {
    expect(describeStep(state({ currentStep: 'LAUNCH_WIZARD' })))
      .toBe('All set. Opening YouCoded…');
    expect(describeStep(state({ currentStep: 'COMPLETE' })))
      .toBe('All set. Opening YouCoded…');
  });

  it('describes an error state when a prerequisite actually failed', () => {
    const s = state({
      currentStep: 'INSTALL_PREREQUISITES',
      lastError: 'Could not download Node.js',
      prerequisites: [
        { name: 'node', displayName: 'Node.js', status: 'failed', error: 'network' },
        { name: 'git', displayName: 'Git', status: 'waiting' },
        { name: 'claude', displayName: 'Claude Code', status: 'waiting' },
        { name: 'auth', displayName: 'Sign in', status: 'waiting' },
      ],
    });
    // No "or skip for now": the skip link was removed from this screen
    // (review 2026-09-05 P-6), so the copy offered an escape that is not there.
    expect(describeStep(s)).toBe('Something went wrong. You can retry the last step.');
    expect(describeStep(s)).not.toContain('skip');
  });

  // A refused OpenRouter key sets lastError without any prerequisite failing
  // (first-run.ts handleNativeApiKey). There is no Try Again button beside it,
  // so the headline must stay the step's own line — the sentence is rendered
  // underneath on its own.
  it('keeps the step headline when lastError is set but no prerequisite failed', () => {
    const s = state({
      currentStep: 'AUTHENTICATE',
      lastError: "OpenRouter didn't accept this key. Check that you copied all of it.",
    });
    expect(describeStep(s)).toBe(
      'Sign in with an account, or run a model on this computer, to finish setup.',
    );
  });

  // Nothing failed and there is no other control on the screen (no sign-in
  // buttons on the install step) — Try Again is the only way forward, so the
  // headline that introduces it stays.
  it('describes an error state when the run itself failed off-step (no disk space)', () => {
    const s = state({
      currentStep: 'INSTALL_PREREQUISITES',
      lastError: 'Insufficient disk space: 210 MB available (need >= 500 MB)',
    });
    expect(describeStep(s)).toBe('Something went wrong. You can retry the last step.');
  });

  // A ChatGPT / Claude sign-in that times out DOES mark the auth prerequisite
  // failed, so that case keeps the error headline and its Try Again button.
  it('describes an error state when a sign-in failed', () => {
    const s = state({
      currentStep: 'AUTHENTICATE',
      lastError: 'Sign-in timed out. Try again?',
      prerequisites: [
        { name: 'node', displayName: 'Node.js', status: 'installed' },
        { name: 'git', displayName: 'Git', status: 'installed' },
        { name: 'claude', displayName: 'Claude Code', status: 'installed' },
        { name: 'auth', displayName: 'Sign in', status: 'failed', error: 'Timed out' },
      ],
    });
    expect(describeStep(s)).toBe('Something went wrong. You can retry the last step.');
  });

  it('falls back to the generic install message when nothing specific is installing', () => {
    expect(describeStep(state({ currentStep: 'INSTALL_PREREQUISITES' })))
      .toBe('Getting the next piece ready…');
  });
});
