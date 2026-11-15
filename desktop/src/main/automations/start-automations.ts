// start-automations.ts — puts the automations pieces together when the app starts (finishing Pages, step 4).
//
// WHY its own file: ipc-handlers.ts is at its line budget, and everything here is about automations only.
// Saved under ~/.youcoded/automations. Runs are never chats: the engine builds its session through the
// session host's createAutomationSession, which registers nothing a chat list, a phone or search reads.
import os from 'node:os';
import path from 'node:path';
import type { AutomationSummary } from '../../shared/automation-types';
import { log } from '../logger';
import type { RunEngine } from './automation-runner';
import { initAutomationsService, type AutomationsService } from './automations-service';
import { nativeEngine, type NativeEngineDeps } from './native-engine';

export function startAutomations(deps: {
  createSession: NativeEngineDeps['createSession'];
  /** Send the fresh list to every window and every phone. */
  broadcast: (jobs: AutomationSummary[]) => void;
}): AutomationsService {
  const service: AutomationsService = initAutomationsService({
    dir: () => path.join(os.homedir(), '.youcoded', 'automations'),
    engineFor: (job) => (job.runsOn?.runtime === 'claude' ? claude : native),
    broadcast: deps.broadcast,
  });
  const native = nativeEngine({
    createSession: deps.createSession,
    workDirFor: (id) => service.workDirFor(id),
    transcriptFor: (id, runId) => service.transcriptFor(id, runId),
  });
  // Not built yet: an automation set to a Claude model says so in its run list instead of doing nothing.
  const claude: RunEngine = () => ({ done: Promise.reject(new Error('Automations cannot run on Claude models yet. Choose another model for now.')), stop: () => {} });
  // WHY no wake-from-sleep listener: each 30-second check compares the clock with the last check, so the
  // first check after the computer wakes sees every time it slept through (and the phone's backend has
  // no such listener to offer).
  void service.startSchedule().catch((err) => log('WARN', 'Automations', 'the schedule did not start', { error: String(err) }));
  return service;
}
