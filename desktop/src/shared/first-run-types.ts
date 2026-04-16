export type FirstRunStep =
  | 'DETECT_PREREQUISITES'
  | 'INSTALL_PREREQUISITES'
  | 'CLONE_TOOLKIT'
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
  authMode: 'none' | 'oauth' | 'apikey';
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
  { name: 'toolkit', displayName: 'YouCoded Toolkit', status: 'waiting' },
  { name: 'auth', displayName: 'Sign in', status: 'waiting' },
];
