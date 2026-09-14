export type FirstRunStep =
  | 'DETECT_PREREQUISITES'
  | 'INSTALL_PREREQUISITES'
  | 'ENABLE_DEVELOPER_MODE'
  | 'AUTHENTICATE'
  | 'LAUNCH_WIZARD'
  | 'COMPLETE';

export type PrerequisiteStatus = 'waiting' | 'checking' | 'installing' | 'installed' | 'failed' | 'skipped';

export interface PrerequisiteState {
  name: string;
  displayName: string;
  status: PrerequisiteStatus;
  version?: string;
  error?: string;
}

export interface FirstRunState {
  currentStep: FirstRunStep;
  prerequisites: PrerequisiteState[];
  overallProgress: number; // 0-100
  statusMessage: string;
  /** Auth mode the user is currently in */
  // 'chatgpt': the Sign-in-with-ChatGPT browser round-trip is in flight
  // (design 2026-09-04). 'oauth' stays Claude's, unrenamed, because main and
  // the Android bridge both write the literal.
  // 'local': the run-a-model-on-this-computer setup is open (design
  // 2026-09-14-first-run-local-models, Q-1/Q-2) — no account, no browser.
  authMode: 'none' | 'oauth' | 'apikey' | 'chatgpt' | 'openrouter' | 'local';
  /** Whether auth completed successfully */
  authComplete: boolean;
  /** Error from the most recent failed step */
  lastError?: string;
  /** Whether Windows Developer Mode needs enabling */
  needsDevMode: boolean;
}

export const INITIAL_PREREQUISITES: PrerequisiteState[] = [
  { name: 'node', displayName: 'Node.js', status: 'waiting' },
  { name: 'git', displayName: 'Git', status: 'waiting' },
  { name: 'claude', displayName: 'Claude Code', status: 'waiting' },
  { name: 'auth', displayName: 'Sign in', status: 'waiting' },
];
