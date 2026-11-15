// native-engine.ts — carries out an automation's run on any model the app talks to itself (finishing
// Pages, step 4; build plan decision 2, "native lane").
//
// It is the app's ordinary assistant loop (HarnessSession) with three things swapped:
//   - its permission check is the automation's own list (job-decide.ts), never a chat's;
//   - a question goes to the runner, which waits or skips as the automation says, instead of to a chat card;
//   - it is never registered as a chat (plan decision 1: runs never become chats), so it appears in no
//     chat list, on no phone, and in no search.
// The session itself is built by the app's session host (it owns model access and prices); this file only
// says what the run needs and listens to what it does.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ModelBinding } from '../../shared/provider-types';
import type { PermissionDecision } from '../../shared/permission-types';
import type { ModelMessage } from 'ai';
import type { TranscriptEvent } from '../../shared/types';
import { hasUnpairedToolCalls, rebuildHistory } from '../harness/history-rebuild';
import type { AskDecision, AskRequest } from '../harness/permission-broker';
import { confirmStartOver, type EngineHandle, type EngineRun, type RunEngine } from './automation-runner';
import { buildJobDecide } from './job-decide';
import { firstMessage, readEnding, runBrief } from './run-brief';
import { PAGE_CHANGE_TOOL, PAGE_READ_TOOL, PAGE_REFUSED, describePages, pageArgAllowed, runPagesFor } from './run-pages';
import { PAGES_MCP_SERVER_ID } from '../claude-code-pages-mcp';
import type { ReadyServer } from '../harness/mcp/mcp-manager';

/** The part of the assistant loop this engine uses. */
interface RunSession {
  /** Put a saved conversation back before the next message (a picked-up run). */
  seedHistory(messages: ModelMessage[]): void;
  send(text: string): Promise<void>;
  on(event: 'transcript-event', listener: (e: TranscriptEvent) => void): unknown;
  interrupt(): void;
}

export interface NativeEngineDeps {
  /** Build an idle session that is NOT a chat. Implemented by NativeSessionHost.createAutomationSession. */
  createSession: (opts: {
    runId: string; workDir: string; binding: ModelBinding; systemPrompt: string; toolNames: string[];
    decide: (tool: string, subject: string | undefined) => Promise<PermissionDecision>;
    askUser: (req: AskRequest) => Promise<AskDecision>;
    /** What each step used, the moment it finishes. */
    onStepUsage: (u: { tokens: number; costUsd: number | null }) => Promise<void>;
    /** The page tools, already limited to this run's pages (run-pages.ts). Absent = no page tools. */
    mcpServers?: ReadyServer[];
  }) => Promise<{ session: RunSession; dispose: () => Promise<void> }>;
  /** `~/.youcoded/automations/work/<jobId>` — the run's own folder. */
  workDirFor: (jobId: string) => string;
  /** The folder of a page, or null when it is gone. */
  pageDir: (pageId: string) => Promise<string | null>;
  /** Start the page-data program for these Pages folders (the same one a chat is given). */
  pageTools: (roots: string[]) => Promise<PageToolsConnection>;
  /** Where a run's full conversation is kept (`runs/<jobId>/<runId>.jsonl`), for resuming and for looking back. */
  transcriptFor: (jobId: string, runId: string) => string;
}

interface PageToolsConnection {
  tools: ReadyServer['tools'];
  call: ReadyServer['call'];
  close: () => Promise<void>;
}

/** The tools a run is given. WHY a tool it may never use is left out entirely, not just refused
 *  (plan#S-allowed): a model offered a tool tries it, and every refused try is a wasted step. */
export function toolNamesFor(job: EngineRun['job']): string[] {
  // Files in its own work folder are always allowed, so the file tools are always present.
  const names = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite'];
  if (job.unlisted.commands === 'ask' || job.tools.some((t) => t.kind === 'command')) names.push('Bash', 'BashOutput', 'KillShell');
  if (job.unlisted.sites === 'ask' || job.tools.some((t) => t.kind === 'site')) names.push('WebFetch');
  return names;
}

/** What the person is asked, in words (the screen's amber notice shows these two lines). */
export function wordAsk(req: AskRequest): { action: string; detail?: string } {
  const input = req.toolInput as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  // The two page tools (plain ifs: their names are built from the page program's id).
  if (req.toolName === `mcp__${PAGES_MCP_SERVER_ID}__${PAGE_READ_TOOL}`) return { action: 'Read a page’s information', detail: str('page') };
  if (req.toolName === `mcp__${PAGES_MCP_SERVER_ID}__${PAGE_CHANGE_TOOL}`) return { action: 'Change a page’s information', detail: str('page') };
  switch (req.toolName) {
    case 'Bash': return { action: 'Run a command', detail: str('command') };
    case 'Write': return { action: 'Write a file', detail: str('file_path') };
    case 'Edit': return { action: 'Change a file', detail: str('file_path') };
    case 'Read': return { action: 'Read a file', detail: str('file_path') };
    case 'Glob': case 'Grep': return { action: 'Look through a folder', detail: str('path') };
    case 'WebFetch': return { action: 'Visit a website', detail: str('url') };
    // The loop's own safety stops (too many steps, repeating itself) also arrive as questions.
    case 'max_steps': return { action: 'Keep going past its usual number of steps' };
    case 'doom_loop': return { action: 'Keep going though it is repeating itself' };
    default: return { action: `Use ${req.toolName}` };
  }
}

/** A run's saved conversation, split into what finished and the step that was cut off mid-way.
 *  null = nothing usable was saved, so the run starts over. */
async function savedRun(file: string): Promise<{ messages: ModelMessage[]; cutOff: { action: string; detail?: string }[] } | null> {
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); } catch { return null; }
  const events: TranscriptEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // A last line cut off mid-write is simply left out.
    try { events.push(JSON.parse(line) as TranscriptEvent); } catch { /* skip */ }
  }
  if (!events.some((e) => e.type === 'user-message')) return null;
  // A step that was asked for but has no result: the app closed while it ran (or before it began).
  const finished = new Set(events.filter((e) => e.type === 'tool-result').map((e) => (e.data as { toolUseId?: string }).toolUseId));
  const cut = events.filter((e) => e.type === 'tool-use' && !finished.has((e.data as { toolUseId?: string }).toolUseId));
  const kept = events.filter((e) => !cut.includes(e));
  try {
    const messages = rebuildHistory(kept);
    if (messages.length === 0 || hasUnpairedToolCalls(messages)) return null;
    return {
      messages,
      cutOff: cut.map((e) => {
        const d = e.data as { toolName?: string; toolInput?: Record<string, unknown> };
        return wordAsk({ sessionId: '', toolName: d.toolName ?? 'a tool', toolInput: d.toolInput ?? {}, denyListed: false });
      }),
    };
  } catch { return null; }
}

/** What a picked-up run is told. The half-done step asks the person first (Destin, 2026-11-14: "okay to
 *  ask"): an email may already have been sent, a file already moved. */
async function resumeMessage(run: EngineRun, cutOff: { action: string; detail?: string }[]): Promise<string> {
  const lines = ['This run was cut off when YouCoded was closed and is now continuing. Carry on from where you stopped. Do not repeat steps that already finished.'];
  for (const step of cutOff) {
    const what = step.detail ? `${step.action}: ${step.detail}` : step.action;
    const a = await run.ask({ action: 'Run a step again that may have already run', detail: what });
    lines.push(a.allow
      ? `The step you were on when it stopped (${what}) may or may not have finished. The person says to run it again.`
      : `The step you were on when it stopped (${what}) may or may not have finished. Do not run it again; carry on without it.${a.note ? ` ${a.note}` : ''}`);
  }
  return lines.join('\n');
}

export function nativeEngine(deps: NativeEngineDeps): RunEngine {
  return (run: EngineRun): EngineHandle => {
    let stopped = false;
    let session: RunSession | undefined;
    let dispose: (() => Promise<void>) | undefined;
    let pageConnection: PageToolsConnection | undefined;

    const done = (async (): Promise<{ summary: string; news?: boolean; startedOver?: boolean }> => {
      const on = run.job.runsOn;
      if (!on || on.runtime !== 'native') throw new Error('No model is chosen for this automation.');
      const workDir = deps.workDirFor(run.job.id);
      await fs.mkdir(workDir, { recursive: true });
      const transcript = deps.transcriptFor(run.job.id, run.runId);
      await fs.mkdir(path.dirname(transcript), { recursive: true });
      // A picked-up run: its saved conversation, or null when there is nothing to continue from.
      const saved = run.resume ? await savedRun(transcript) : null;
      // Nothing to continue from: starting over could repeat steps, so the person is asked first.
      if (run.resume && !saved) { await confirmStartOver(run); await fs.rm(transcript, { force: true }); }

      // The pages it is linked to, and the page tools limited to them.
      const pages = await runPagesFor(run.job, deps.pageDir);
      let pageServer: ReadyServer | undefined;
      if (pages.pages.length > 0) {
        const conn = await deps.pageTools(pages.roots);
        pageConnection = conn;
        pageServer = {
          id: PAGES_MCP_SERVER_ID, label: 'Pages',
          tools: conn.tools.filter((t) => t.name === PAGE_READ_TOOL || t.name === PAGE_CHANGE_TOOL),
          // Which page: checked here, where the call's own `page` value is visible.
          call: async (tool, args, signal) => (pageArgAllowed(pages, (args as { page?: unknown } | null)?.page)
            ? conn.call(tool, args, signal) : { text: PAGE_REFUSED, isError: true }),
        };
      }

      // The permission a question falls under, remembered between the check and the question that follows it.
      // Which permission each question falls under. WHY keyed by the step itself (tool + what it acts on): the
      // loop checks a step and asks about it in two separate calls, and two steps can be in flight at once.
      const askedUnder = new Map<string, string>();
      const stepKey = (tool: string, subject: string | undefined): string => `${tool}\u0000${subject ?? ''}`;
      const decide = buildJobDecide({ rules: run.current, workDir });
      const built = await deps.createSession({
        runId: run.runId, workDir,
        binding: { providerId: on.providerId, modelId: on.modelId },
        ...(pageServer ? { mcpServers: [pageServer] } : {}),
        systemPrompt: runBrief(run.job, describePages(pages)),
        toolNames: toolNamesFor(run.job),
        decide: async (tool, subject) => {
          const d = await decide(tool, subject);
          if (d.action === 'ask' && d.toolId) askedUnder.set(stepKey(tool, subject), d.toolId); else askedUnder.delete(stepKey(tool, subject));
          return d;
        },
        askUser: async (req) => {
          const toolId = askedUnder.get(stepKey(req.toolName, req.subject));
          const a = await run.ask({ ...wordAsk(req), ...(toolId ? { toolId } : {}) });
          return a.allow ? { behavior: 'allow' } : { behavior: 'deny', message: a.note };
        },
        // The runner adds it up and, at the monthly limit, stops the run (which interrupts the session).
        onStepUsage: async (u) => { await run.spent(u.costUsd ?? 0, u.tokens); },
      });
      session = built.session; dispose = built.dispose;
      if (stopped) throw new Error('stopped');

      let lastReply = '';
      let replyPart = '';
      let failure: string | undefined;
      let writing: Promise<void> = Promise.resolve();
      session.on('transcript-event', (e) => {
        // One line per event, in order. A failed write must not stop the run; the run list still gets its summary.
        writing = writing.then(() => fs.appendFile(transcript, `${JSON.stringify(e)}\n`)).catch(() => {});
        if (e.type === 'assistant-text') {
          const d = e.data as { text?: string; partId?: string };
          // A new part is a new reply; the same part is more of the same one.
          if (d.partId !== replyPart) { replyPart = d.partId ?? ''; lastReply = ''; }
          lastReply += d.text ?? '';
        } else if (e.type === 'session-error') {
          failure = (e.data as { text?: string }).text ?? 'The model stopped answering.';
        }
      });

      if (saved) {
        session.seedHistory(saved.messages);
        await session.send(await resumeMessage(run, saved.cutOff));
      } else {
        await session.send(firstMessage(run.instruction, run.eventData));
      }
      await writing;
      if (failure) throw new Error(failure);
      return { ...readEnding(lastReply), ...(run.resume && !saved ? { startedOver: true } : {}) };
    })().finally(() => { void dispose?.().catch(() => {}); void pageConnection?.close().catch(() => {}); });

    return {
      done,
      stop: () => { stopped = true; try { session?.interrupt(); } catch { /* already ended */ } },
    };
  };
}
