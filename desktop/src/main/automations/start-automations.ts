// start-automations.ts — puts the automations pieces together when the app starts (finishing Pages, step 4).
//
// WHY its own file: ipc-handlers.ts is at its line budget, and everything here is about automations only.
// Saved under ~/.youcoded/automations. Runs are never chats: the engine builds its session through the
// session host's createAutomationSession, which registers nothing a chat list, a phone or search reads.
import os from 'node:os';
import path from 'node:path';
import type { AutomationSummary } from '../../shared/automation-types';
import { log } from '../logger';
import { claudeEngine } from './claude-engine';
import { initAutomationsService, type AutomationsService } from './automations-service';
import { nativeEngine, type NativeEngineDeps } from './native-engine';

export function startAutomations(deps: {
  createSession: NativeEngineDeps['createSession'];
  /** Send the fresh list to every window and every phone. */
  broadcast: (jobs: AutomationSummary[]) => void;
}): AutomationsService {
  const dir = path.join(os.homedir(), '.youcoded', 'automations');
  const service: AutomationsService = initAutomationsService({
    dir: () => dir,
    engineFor: (job) => (job.runsOn?.runtime === 'claude' ? claude : native),
    broadcast: deps.broadcast,
  });
  const native = nativeEngine({
    createSession: deps.createSession,
    workDirFor: (id) => service.workDirFor(id),
    transcriptFor: (id, runId) => service.transcriptFor(id, runId),
  });
  const claude = claudeEngine({ dir: () => dir, workDirFor: (id) => service.workDirFor(id) });
  // WHY no wake-from-sleep listener: each 30-second check compares the clock with the last check, so the
  // first check after the computer wakes sees every time it slept through (and the phone's backend has
  // no such listener to offer).
  void service.startSchedule().catch((err) => log('WARN', 'Automations', 'the schedule did not start', { error: String(err) }));
  return service;
}
