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
      { name: 'toolkit', displayName: 'YouCoded Toolkit', status: 'waiting' },
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
        { name: 'toolkit', displayName: 'YouCoded Toolkit', status: 'waiting' },
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
        { name: 'toolkit', displayName: 'YouCoded Toolkit', status: 'waiting' },
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
        { name: 'toolkit', displayName: 'YouCoded Toolkit', status: 'waiting' },
        { name: 'auth', displayName: 'Sign in', status: 'waiting' },
      ],
    });
    expect(describeStep(s)).toBe(
      'Installing Claude Code — the AI that powers YouCoded.',
    );
  });

  it('names the toolkit when toolkit is installing', () => {
    const s = state({
      currentStep: 'CLONE_TOOLKIT',
      prerequisites: [
        { name: 'node', displayName: 'Node.js', status: 'installed' },
        { name: 'git', displayName: 'Git', status: 'installed' },
        { name: 'claude', displayName: 'Claude Code', status: 'installed' },
        { name: 'toolkit', displayName: 'YouCoded Toolkit', status: 'installing' },
        { name: 'auth', displayName: 'Sign in', status: 'waiting' },
      ],
    });
    expect(describeStep(s)).toBe(
      'Installing the YouCoded toolkit — skills, themes, and sync.',
    );
  });

  it('describes the auth step', () => {
    expect(describeStep(state({ currentStep: 'AUTHENTICATE' })))
      .toBe('Sign in with your Claude account to finish setup.');
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

  it('describes an error state when lastError is set', () => {
    const s = state({
      currentStep: 'INSTALL_PREREQUISITES',
      lastError: 'Could not download Node.js',
    });
    expect(describeStep(s)).toBe(
      'Something went wrong. You can retry the last step or skip for now.',
    );
  });

  it('falls back to the generic install message when nothing specific is installing', () => {
    expect(describeStep(state({ currentStep: 'INSTALL_PREREQUISITES' })))
      .toBe('Getting the next piece ready…');
  });
});
