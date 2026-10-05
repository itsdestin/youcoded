export type FirstRunStep =
  | 'DETECT_PREREQUISITES'
  | 'INSTALL_PREREQUISITES'
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
  /** The native provider setup finished on (first-run local models, 2026-09-14):
   *  'local', a connected model app's provider id, or an API key's provider id.
   *  The renderer makes it the new-session default, as it does for ChatGPT. */
  setupProvider?: string;
  /** Error from the most recent failed step */
  lastError?: string;
}

export const INITIAL_PREREQUISITES: PrerequisiteState[] = [
  { name: 'node', displayName: 'Node.js', status: 'waiting' },
  { name: 'git', displayName: 'Git', status: 'waiting' },
  { name: 'claude', displayName: 'Claude Code', status: 'waiting' },
  { name: 'auth', displayName: 'Sign in', status: 'waiting' },
];

// WHY (2026-09-30 one-core R3-3): the shapes of the first-run:* channels' answers, in one place so
// the channel table's rows, preload and the strip above the message box read the same types
// (SetupDownloadStatus was declared twice, in main/first-run-local.ts and the renderer's strip).

/** The key services "Use an API key" accepts (first-run local models, F-1). */
export type NativeKeyService = 'anthropic' | 'openai' | 'google' | 'openrouter';

/** What the band above the message box shows about the download setup finished on. */
export interface SetupDownloadStatus {
  state: 'downloading' | 'stopped' | 'done';
  modelLabel: string;
  percent: number;
  minutesLeft: number | null;
}
