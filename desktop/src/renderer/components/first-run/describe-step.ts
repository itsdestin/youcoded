import type { FirstRunState, PrerequisiteState } from '../../../shared/first-run-types';

// WHY: on a Mac, Git arrives with Apple's developer tools, which open their own
// window that must be answered; setup waits for it (installGit, 2026-10-02).
const MAC_GIT_LINE = 'If macOS asks to install developer tools, click Install. It can take a few minutes.';

// WHY one plain line and no tool names (first-run decks L-1, first-run-4 P4-1): "Step 1
// of 2" and "Installing Node.js — …" named things a new user can't place. Tool names
// appear only when one fails, in the stopped card's sentence.
const INSTALL_LINE = 'Setting up the tools your assistant needs. This can take a few minutes.';

function onMac(): boolean {
  return typeof navigator !== 'undefined' && /^Mac/.test(navigator.platform);
}

function activePrerequisite(prereqs: PrerequisiteState[]): PrerequisiteState | undefined {
  return prereqs.find(
    (p) => p.status === 'installing' || p.status === 'checking',
  );
}

/**
 * Is "Try again" the right answer to the message currently on screen?
 *
 * WHY it exists: `lastError` is the only channel the wizard has for saying
 * anything to the user, and one CLICK reaches it without anything breaking —
 * a refused OpenRouter key, or a sign-in that timed out. Try again there
 * re-runs the whole Node/Git/Claude install pass on a machine where nothing is
 * wrong, and "Something went wrong. You can retry the last step." would be two
 * false statements in one sentence.
 *
 * The test: a failed prerequisite always earns a retry. Otherwise it depends on
 * whether the user has another way forward — on the sign-in step the three
 * sign-in buttons are right there, so a message needs no button of its own;
 * on every other step (a failed download, no disk space) Try again is the only
 * control on the screen and must stay.
 *
 * FirstRunView shows the button on exactly this test, so the headline and the
 * button always agree.
 */
function canRetry(state: FirstRunState): boolean {
  if (state.prerequisites.some((p) => p.status === 'failed')) return true;
  return state.currentStep !== 'AUTHENTICATE';
}

/** Is setup stopped on a failure it can retry? The stopped card replaces the bar then. */
export function isStopped(state: FirstRunState): boolean {
  return !!state.lastError && canRetry(state);
}

/**
 * The heading and grey line for the current step (brand rebuild, decks first-run-1…7).
 * The heading is empty while stopped: the stopped card carries its own title.
 */
export function describeStep(state: FirstRunState, isMac: boolean = onMac()): { heading: string; line: string | null } {
  if (isStopped(state)) return { heading: '', line: null };
  switch (state.currentStep) {
    case 'DETECT_PREREQUISITES':
      return { heading: 'Getting things ready', line: "Checking what's already on this computer…" };
    case 'INSTALL_PREREQUISITES': {
      const active = activePrerequisite(state.prerequisites);
      return { heading: 'Getting things ready', line: active?.name === 'git' && isMac ? MAC_GIT_LINE : INSTALL_LINE };
    }
    case 'AUTHENTICATE':
      return { heading: 'Choose how your assistant runs', line: null };
    case 'LAUNCH_WIZARD':
    case 'COMPLETE':
      return { heading: "You're all set", line: null };
    default: {
      // Exhaustiveness check — a new FirstRunStep fails to compile here.
      // @ts-ignore — TS6133: the binding IS the exhaustiveness check
      const _exhaustive: never = state.currentStep;
      return { heading: '', line: null };
    }
  }
}

/** The stopped card's one plain sentence: the failed tool by name, else the step. */
export function stoppedSentence(state: FirstRunState): string {
  const failed = state.prerequisites.find((p) => p.status === 'failed');
  if (failed?.name === 'auth') return "Signing in didn't finish.";
  if (failed) return `${failed.displayName} couldn't be installed.`;
  return "This step didn't finish.";
}
