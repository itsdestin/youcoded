// Facts the native engine adds to its run records (coordinator, 2026-10-22; native branch
// session/bg-tracking-native). They are optional in shared/types.ts once that branch lands;
// they are READ here through these local shapes so this branch builds and tests without them
// and keeps working against a host that does not send them yet.
import type { ShellRunView, SpecialistRunView, ToolCallState } from '../../shared/types';

export interface SpecialistRunFacts {
  /** 1 for the original hire, +1 per resume. */
  runNumber?: number;
  /** The Task call whose card carries the LIVE run (the resume call after a resume). */
  activeToolCallId?: string;
  /** When the newest run began. */
  resumedAt?: number;
  /** The report on the ORIGINAL card belongs to an earlier run. */
  reportStale?: boolean;
  /** A finished background run whose report the assistant has not received yet. */
  reportPending?: 'waiting-for-turn' | 'held-after-stop';
}

export interface ShellRunFacts {
  command?: string;
  description?: string;
  /** Set when a signal ended it: exitCode is absent, status 'exited'. */
  signal?: string;
  /** The record came from disk after a restart; output no longer streams. */
  restored?: boolean;
  /** It ended while the app was not watching: the exit code is unknown. */
  exitUnknown?: boolean;
  /** Only with exitUnknown: the process may still be alive. No Stop is possible. */
  maybeStillRunning?: boolean;
}

export const specialistFacts = (run: SpecialistRunView): SpecialistRunView & SpecialistRunFacts => run;
export const shellFacts = (run: ShellRunView): ShellRunView & ShellRunFacts => run;

/** How a native shell run ended. A signal kill and an unknown exit are NOT failures
 *  ("Ended by SIGKILL", "ended, exit code unknown"); "may still be running" is still running. */
export function shellEndKind(run: ShellRunView): 'running' | 'completed' | 'failed' | 'stopped' {
  const f = shellFacts(run);
  if (f.maybeStillRunning) return 'running';
  if (run.status === 'running') return 'running';
  if (run.status === 'stopped') return 'stopped';
  if (f.signal || f.exitUnknown) return 'stopped';
  return run.exitCode === 0 ? 'completed' : 'failed';
}

/** The delivered report, unless the host says it belongs to an earlier run. */
export function liveReport(tool: ToolCallState): ToolCallState['specialistReport'] {
  return tool.specialistRun && specialistFacts(tool.specialistRun).reportStale ? undefined : tool.specialistReport;
}
