// start-automations.ts — puts the automations pieces together when the app starts (finishing Pages, step 4).
//
// WHY its own file: ipc-handlers.ts is at its line budget, and everything here is about automations only.
// Saved under ~/.youcoded/automations. Runs are never chats: the engine builds its session through the
// session host's createAutomationSession, which registers nothing a chat list, a phone or search reads.
import os from 'node:os';
import path from 'node:path';
import type { AutomationSummary } from '../../shared/automation-types';
import type { ModelBinding } from '../../shared/provider-types';
import type { TranscriptEvent } from '../../shared/types';
import { log } from '../logger';
import { getPagesService } from '../pages/pages-service';
import { PAGES_MCP_SERVER_ID, PAGES_ROOTS_ENV, writePagesMcpServer } from '../claude-code-pages-mcp';
import { createConnection } from '../harness/mcp/mcp-client';
import { watchProposals } from './propose';
import { claudeEngine } from './claude-engine';
import { initAutomationsService, type AutomationsService } from './automations-service';
import { nativeEngine, type NativeEngineDeps } from './native-engine';

let noteProposal: (event: TranscriptEvent) => void = () => {};
/** Called with every step of every chat (both kinds); acts only on a ProposeAutomation step. */
export function noteAutomationProposal(event: TranscriptEvent): void { noteProposal(event); }

export function startAutomations(deps: {
  createSession: NativeEngineDeps['createSession'];
  /** Send the fresh list to every window and every phone. */
  broadcast: (jobs: AutomationSummary[]) => void;
  /** The model a chat on one of the app's own models runs on (undefined for a Claude Code chat). */
  nativeBinding: (sessionId: string) => ModelBinding | undefined;
  /** Open the "Check this automation" popup on a draft the assistant proposed. */
  showProposal: (draft: AutomationSummary) => void;
}): AutomationsService {
  const dir = path.join(os.homedir(), '.youcoded', 'automations');
  const service: AutomationsService = initAutomationsService({
    dir: () => dir,
    engineFor: (job) => (job.runsOn?.runtime === 'claude' ? claude : native),
    broadcast: deps.broadcast,
  });
  const pageDir = async (pageId: string): Promise<string | null> => (await getPagesService()?.store.pageDir(pageId)) ?? null;
  const pagesProgram = (): Promise<string> => writePagesMcpServer(path.join(dir, 'page-tools'));
  const native = nativeEngine({
    pageDir,
    // The page-data program, started by the app for a run on one of its own models. It is the app's own
    // program run as plain node, so nothing else needs to be installed.
    pageTools: async (roots) => {
      const conn = createConnection({
        id: PAGES_MCP_SERVER_ID, label: 'Pages', enabled: true, origin: { kind: 'user' }, missingSecrets: [],
        transport: { type: 'stdio', command: process.execPath, args: [await pagesProgram()] },
        env: { [PAGES_ROOTS_ENV]: JSON.stringify(roots), ELECTRON_RUN_AS_NODE: '1' },
      });
      // A program that did not start is closed again before the run is told, so nothing is left running.
      try { await conn.connect(); } catch (err) { await conn.close().catch(() => {}); throw err; }
      if (conn.state !== 'ready') { await conn.close().catch(() => {}); throw new Error(conn.lastError ?? 'The page tools did not start.'); }
      return { tools: conn.listTools(), call: (tool, args, signal) => conn.callTool(tool, args, signal), close: () => conn.close() };
    },
    createSession: deps.createSession,
    workDirFor: (id) => service.workDirFor(id),
    transcriptFor: (id, runId) => service.transcriptFor(id, runId),
  });
  const claude = claudeEngine({ dir: () => dir, workDirFor: (id) => service.workDirFor(id), pageDir, pagesProgram });
  // WHY no wake-from-sleep listener: each 30-second check compares the clock with the last check, so the
  // first check after the computer wakes sees every time it slept through (and the phone's backend has
  // no such listener to offer).
  noteProposal = watchProposals({
    pages: async () => (await getPagesService()?.listAndWatch()) ?? [],
    modelFor: (sessionId) => {
      const b = deps.nativeBinding(sessionId);
      // A ChatGPT sign-in is a plan, not a bill (decided per model, never per engine: design-review finding 4).
      return b ? { name: b.modelId, runsOn: { runtime: 'native', providerId: b.providerId, modelId: b.modelId }, subscription: /chatgpt/i.test(b.providerId) } : null;
    },
    show: (draft) => deps.showProposal(draft),
  });
  void service.startSchedule().catch((err) => log('WARN', 'Automations', 'the schedule did not start', { error: String(err) }));
  return service;
}
