import { describe, it, expect } from 'vitest';
import { describeStep, isStopped, stoppedSentence } from '../src/renderer/components/first-run/describe-step';
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
    ...overrides,
  };
}

const INSTALL_LINE = 'Setting up the tools your assistant needs. This can take a few minutes.';

describe('describeStep — the heading and grey line per step (brand rebuild)', () => {
  it('describes the detect phase', () => {
    expect(describeStep(state({ currentStep: 'DETECT_PREREQUISITES' })))
      .toEqual({ heading: 'Getting things ready', line: "Checking what's already on this computer…" });
  });

  // Deck first-run-4 P4-1: no "Step 1 of 2", no tool names while things go well.
  it('says the same plain line whichever tool is installing', () => {
    for (const name of ['node', 'git', 'claude']) {
      const s = state({
        currentStep: 'INSTALL_PREREQUISITES',
        prerequisites: [{ name, displayName: name, status: 'installing' }],
      });
      expect(describeStep(s, false)).toEqual({ heading: 'Getting things ready', line: INSTALL_LINE });
    }
    expect(describeStep(state({ currentStep: 'INSTALL_PREREQUISITES' }), false).line).toBe(INSTALL_LINE);
  });

  it('tells a Mac user to answer Apple’s window while Git installs', () => {
    const s = state({
      currentStep: 'INSTALL_PREREQUISITES',
      prerequisites: [{ name: 'git', displayName: 'Git', status: 'installing' }],
    });
    expect(describeStep(s, true).line).toMatch(/click Install/);
  });

  it('heads the sign-in step with the question and no line', () => {
    expect(describeStep(state({ currentStep: 'AUTHENTICATE' })))
      .toEqual({ heading: 'Choose how your assistant runs', line: null });
  });

  it('describes the completion step', () => {
    expect(describeStep(state({ currentStep: 'COMPLETE' })).heading).toBe("You're all set");
  });
});

describe('isStopped / stoppedSentence — the failure card', () => {
  it('a failed tool stops setup and is named in the sentence', () => {
    const s = state({
      currentStep: 'INSTALL_PREREQUISITES',
      lastError: 'Error: HTTP 503 downloading …PortableGit…',
      prerequisites: [{ name: 'git', displayName: 'Git', status: 'failed' }],
    });
    expect(isStopped(s)).toBe(true);
    expect(stoppedSentence(s)).toBe("Git couldn't be installed.");
    // The card carries its own title, so the page heading steps aside.
    expect(describeStep(s)).toEqual({ heading: '', line: null });
  });

  // A refused OpenRouter key sets lastError with nothing failed, on the sign-in step:
  // the three ways in are still there, so it is a message, not a stop.
  it('a refused key on the sign-in step is not a stop', () => {
    const s = state({ currentStep: 'AUTHENTICATE', lastError: "OpenRouter didn't accept this key." });
    expect(isStopped(s)).toBe(false);
    expect(describeStep(s).heading).toBe('Choose how your assistant runs');
  });

  it('an off-step failure (no disk space) stops with a general sentence', () => {
    const s = state({ currentStep: 'INSTALL_PREREQUISITES', lastError: 'Insufficient disk space' });
    expect(isStopped(s)).toBe(true);
    expect(stoppedSentence(s)).toBe("This step didn't finish.");
  });

  it('a timed-out sign-in stops with its own sentence', () => {
    const s = state({
      currentStep: 'AUTHENTICATE',
      lastError: 'Sign-in timed out. Try again?',
      prerequisites: [{ name: 'auth', displayName: 'Sign in', status: 'failed' }],
    });
    expect(isStopped(s)).toBe(true);
    expect(stoppedSentence(s)).toBe("Signing in didn't finish.");
  });
});
