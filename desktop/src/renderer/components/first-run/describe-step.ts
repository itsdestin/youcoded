import type { FirstRunState, PrerequisiteState } from '../../../shared/first-run-types';

// Per-prerequisite copy. Keys match PrerequisiteState.name.
const PREREQ_COPY: Record<string, string> = {
  node: 'Installing Node.js — this runs the AI engine under the hood.',
  git: 'Installing Git — used to keep YouCoded and your skills up to date.',
  claude: 'Installing Claude Code — the AI that powers YouCoded.',
  toolkit: 'Installing the YouCoded toolkit — skills, themes, and sync.',
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
export function describeStep(state: FirstRunState): string {
  if (state.lastError) {
    return 'Something went wrong. You can retry the last step or skip for now.';
  }

  switch (state.currentStep) {
    case 'DETECT_PREREQUISITES':
      return "Checking what's already installed on this machine.";

    case 'INSTALL_PREREQUISITES':
    case 'CLONE_TOOLKIT': {
      const active = activePrerequisite(state.prerequisites);
      if (active && PREREQ_COPY[active.name]) {
        return PREREQ_COPY[active.name];
      }
      return 'Getting the next piece ready…';
    }

    case 'AUTHENTICATE':
      return 'Sign in with your Claude account to finish setup.';

    case 'ENABLE_DEVELOPER_MODE':
      return "One Windows setting to enable, then we're done.";

    case 'LAUNCH_WIZARD':
    case 'COMPLETE':
      return 'All set. Opening YouCoded…';

    default: {
      // Exhaustiveness check — if a new FirstRunStep is added the compiler flags this.
      const _exhaustive: never = state.currentStep;
      return '';
    }
  }
}
