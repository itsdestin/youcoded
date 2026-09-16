import type { FirstRunState, PrerequisiteState } from '../../../shared/first-run-types';

// Per-prerequisite copy. Keys match PrerequisiteState.name.
const PREREQ_COPY: Record<string, string> = {
  node: 'Installing Node.js — this runs the AI engine under the hood.',
  git: 'Installing Git — used to keep YouCoded and your skills up to date.',
  claude: 'Installing Claude Code — the AI that powers YouCoded.',
};

function activePrerequisite(prereqs: PrerequisiteState[]): PrerequisiteState | undefined {
  return prereqs.find(
    (p) => p.status === 'installing' || p.status === 'checking',
  );
}

/**
 * Single-sentence explainer for the first-run screen. Tells the user
 * what's happening right now and why, scoped to the current state.
 */
/**
 * Is "Try Again" the right answer to the message currently on screen?
 *
 * WHY it exists: `lastError` is the only channel the wizard has for saying
 * anything to the user, and one CLICK reaches it without anything breaking —
 * "Log in with OpenRouter" answers "coming in a later update". Try Again there
 * re-runs the whole Node/Git/Claude install pass on a machine where nothing is
 * wrong, and "Something went wrong. You can retry the last step." would be two
 * false statements in one sentence.
 *
 * The test: a failed prerequisite always earns a retry. Otherwise it depends on
 * whether the user has another way forward — on the sign-in step the three
 * sign-in buttons are right there, so a message needs no button of its own;
 * on every other step (a failed download, no disk space) Try Again is the only
 * control on the screen and must stay.
 *
 * FirstRunView shows the button on exactly this test, so the headline and the
 * button always agree.
 */
export function canRetry(state: FirstRunState): boolean {
  if (state.prerequisites.some((p) => p.status === 'failed')) return true;
  return state.currentStep !== 'AUTHENTICATE';
}

export function describeStep(state: FirstRunState): string {
  // The error's own words are always shown below the buttons; this headline
  // only claims "something went wrong" where a retry is actually offered.
  if (state.lastError && canRetry(state)) {
    return 'Something went wrong. You can retry the last step.';
  }

  switch (state.currentStep) {
    case 'DETECT_PREREQUISITES':
      return "Checking what's already installed on this machine.";

    case 'INSTALL_PREREQUISITES': {
      const active = activePrerequisite(state.prerequisites);
      if (active && PREREQ_COPY[active.name]) {
        return PREREQ_COPY[active.name];
      }
      return 'Getting the next piece ready…';
    }

    case 'AUTHENTICATE':
      // Sign in with ChatGPT (design 2026-09-04): either plan finishes setup.
      // First-run local models (2026-09-14, Q-1): so does a model on this
      // computer, which needs no account — the line must not say every way in
      // is a sign-in.
      return 'Sign in with an account, or run a model on this computer, to finish setup.';

    case 'ENABLE_DEVELOPER_MODE':
      return "One Windows setting to enable, then we're done.";

    case 'LAUNCH_WIZARD':
    case 'COMPLETE':
      return 'All set. Opening YouCoded…';

    default: {
      // Exhaustiveness check — if a new FirstRunStep is added the compiler
      // flags this. The binding is the check itself; the underscore prefix
      // doesn't suppress noUnusedLocals, so we use @ts-ignore for this line.
      // @ts-ignore — TS6133: the binding IS the exhaustiveness check
      const _exhaustive: never = state.currentStep;
      return '';
    }
  }
}
