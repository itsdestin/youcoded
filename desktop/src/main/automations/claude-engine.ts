// claude-engine.ts — carries out an automation's run on the person's own Claude Code (finishing Pages,
// step 4; build plan decision 2, "Claude lane"; design-review ruling 2).
//
// The person's unchanged `claude` program runs once, hidden, and the APP answers every permission question:
//
//   claude -p --input-format stream-json --output-format stream-json --verbose
//          --restricted --strict-mcp-config --settings <file> --tools <the run's tools>
//          --permission-prompts host --permission-prompt-tool stdio
//          --no-session-persistence --model <model> --append-system-prompt-file <the run's rules> [--add-dir <folder>…]
//
// How every step reaches the app (measured against Claude Code 2.1.325 on 2026-11-14, see
// youcoded/docs/cc-dependencies.md → Automations):
//   - `--restricted` ignores the person's own settings and hooks, so nothing they allowed in a chat reaches
//     a run, and YouCoded's chat hooks do not fire for it.
//   - On its own Claude Code runs commands it judges harmless (`echo hi`) WITHOUT asking anyone. The run's
//     settings file therefore carries one hook that answers "ask" for every tool call; with
//     `--permission-prompts host` each call then arrives here as a `can_use_tool` request on stdout, and
//     nothing happens until this file answers it on stdin.
//   - The answer comes from the same job-decide.ts the app's own models use, so an automation behaves the
//     same on every model (Destin: "the underlying engine … should be easily interchangeable").
//
// WHY nothing is saved by Claude Code (`--no-session-persistence`), where the plan said "saved, kept apart":
// a saved session lands in ~/.claude/projects, which the chat list, Resume, the reconciler, chat search and
// sync all read (fifteen places on 2026-11-14). Keeping a run out of every one of them is exactly the kind
// of filter that gets missed once, and "runs never become chats" (plan decision 1) is the stronger promise.
// The cost: a Claude run cut off by closing the app starts over instead of picking up where it stopped.
//
// Rules of the road (plan-b#E-tos): the person signs in inside Claude Code; YouCoded never touches the
// login, never modifies the program and never resells usage. Runs count toward their plan's normal limits.
// A flag that this Claude Code does not know fails the run with the reason; it never runs unprotected.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { siteKeyFor } from '../../shared/site-key';
import type { EngineHandle, EngineRun, RunEngine } from './automation-runner';
import { buildJobDecide } from './job-decide';
import { firstMessage, readEnding, runBrief } from './run-brief';

/** The part of a child process this engine uses (so a test can stand in for `claude`). */
export interface ClaudeProcess {
  stdin: { write(text: string): unknown; end(): unknown };
  stdout: { on(event: 'data', fn: (chunk: Buffer | string) => void): unknown };
  stderr: { on(event: 'data', fn: (chunk: Buffer | string) => void): unknown };
  on(event: 'close', fn: (code: number | null) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  kill(): unknown;
}

export interface ClaudeEngineDeps {
  workDirFor: (jobId: string) => string;
  /** `~/.youcoded/automations` — the settings file every run shares lives here. */
  dir: () => string;
  /** Test injection. Production runs the person's `claude`. */
  spawnClaude?: (args: string[], opts: { cwd: string }) => ClaudeProcess;
}

/** The hook that hands every tool call to the app.
 *  WHY `echo` and not a script: it needs nothing installed beside Claude Code itself, and Claude Code runs
 *  hooks through a POSIX shell on every system it supports (Git Bash on Windows). */
const ASK = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'YouCoded decides this.' } });
export const RUN_SETTINGS = JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `echo '${ASK}'` }] }] } });

/** Claude Code's names for the tools a run may be given (a subset of native-engine's list: the same idea,
 *  the names Claude Code knows). */
export function claudeToolsFor(job: EngineRun['job']): string[] {
  const names = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite'];
  if (job.unlisted.commands === 'ask' || job.tools.some((t) => t.kind === 'command')) names.push('Bash');
  if (job.unlisted.sites === 'ask' || job.tools.some((t) => t.kind === 'site')) names.push('WebFetch');
  return names;
}

/** The folders a run's file tools may reach besides its work folder. `--restricted` confines them, so each
 *  folder the automation was given must be named; whether a file in it may be read or changed is still
 *  decided step by step. */
function addDirsFor(job: EngineRun['job'], home: string): string[] {
  const out = new Set<string>();
  for (const t of job.tools) {
    if (t.kind !== 'folder' || !t.exact) continue;
    const p = t.exact === '~' ? home : t.exact.startsWith('~/') ? path.join(home, t.exact.slice(2)) : t.exact;
    if (path.isAbsolute(p)) out.add(path.resolve(p));
  }
  return [...out];
}

/** What job-decide compares: the same subject each tool has in the app's own loop. */
function subjectOf(tool: string, input: Record<string, unknown>): string | undefined {
  const str = (k: string): string | undefined => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  if (tool === 'Bash') return str('command');
  if (tool === 'Read' || tool === 'Write' || tool === 'Edit') return str('file_path');
  if (tool === 'Glob' || tool === 'Grep') return str('path') ?? '.';
  if (tool === 'WebFetch') { const url = str('url'); return url ? (siteKeyFor(url) ?? url) : undefined; }
  return undefined;
}

function wordAsk(tool: string, input: Record<string, unknown>): { action: string; detail?: string } {
  const str = (k: string): string | undefined => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  switch (tool) {
    case 'Bash': return { action: 'Run a command', detail: str('command') };
    case 'Write': return { action: 'Write a file', detail: str('file_path') };
    case 'Edit': return { action: 'Change a file', detail: str('file_path') };
    case 'Read': return { action: 'Read a file', detail: str('file_path') };
    case 'Glob': case 'Grep': return { action: 'Look through a folder', detail: str('path') };
    case 'WebFetch': return { action: 'Visit a website', detail: str('url') };
    default: return { action: `Use ${tool}` };
  }
}

function defaultSpawn(args: string[], opts: { cwd: string }): ClaudeProcess {
  const env = { ...process.env };
  // WHY removed: these tell a `claude` it is running INSIDE another Claude Code session, which changes how
  // it behaves; an automation's run is its own session.
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
  // WHY shell on Windows: there `claude` is a .cmd shim, which only a shell can start.
  return spawn('claude', args, { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' }) as unknown as ClaudeProcess;
}

export function claudeEngine(deps: ClaudeEngineDeps): RunEngine {
  const spawnClaude = deps.spawnClaude ?? defaultSpawn;
  return (run: EngineRun): EngineHandle => {
    let proc: ClaudeProcess | undefined;
    let stopped = false;

    const done = (async (): Promise<{ summary: string; news?: boolean }> => {
      const on = run.job.runsOn;
      if (!on || on.runtime !== 'claude') throw new Error('No model is chosen for this automation.');
      const workDir = deps.workDirFor(run.job.id);
      await fs.mkdir(workDir, { recursive: true });
      const settingsFile = path.join(deps.dir(), 'claude-run-settings.json');
      await fs.mkdir(deps.dir(), { recursive: true });
      await fs.writeFile(settingsFile, RUN_SETTINGS);
      // WHY a file and not an argument: the rules run to many lines, and on Windows the program is started
      // through a shell, where a long quoted argument is easy to break.
      const briefFile = path.join(deps.dir(), 'work', `${run.job.id}.brief.txt`);
      await fs.writeFile(briefFile, runBrief(run.job));

      const home = os.homedir();
      const args = [
        '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--restricted', '--strict-mcp-config', '--settings', settingsFile,
        '--tools', ...claudeToolsFor(run.job),
        '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio',
        '--no-session-persistence', '--model', on.modelId,
        '--append-system-prompt-file', briefFile,
      ];
      const dirs = addDirsFor(run.job, home);
      if (dirs.length) args.push('--add-dir', ...dirs);
      if (stopped) throw new Error('stopped');
      const child = spawnClaude(args, { cwd: workDir });
      proc = child;

      let askingFor: string | undefined;
      const decide = buildJobDecide({ rules: run.current, workDir, home, onAsk: (id) => { askingFor = id; } });
      const reply = (requestId: string, response: Record<string, unknown>): void => {
        try { child.stdin.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })}\n`); }
        catch { /* the process ended while the person was deciding */ }
      };
      /** One permission question from Claude Code. Every tool call arrives here (see the header). */
      const permission = async (requestId: string, tool: string, input: Record<string, unknown>): Promise<void> => {
        askingFor = undefined;
        const d = await decide(tool, subjectOf(tool, input));
        if (d.action === 'allow') { reply(requestId, { behavior: 'allow', updatedInput: input }); return; }
        if (d.action === 'deny') { reply(requestId, { behavior: 'deny', message: d.message ?? 'This automation is not allowed to do that.' }); return; }
        const a = await run.ask({ ...wordAsk(tool, input), ...(askingFor ? { toolId: askingFor } : {}) });
        reply(requestId, a.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: a.note || 'The person said no. Carry on without it.' });
      };

      return await new Promise<{ summary: string; news?: boolean }>((resolve, reject) => {
        let buffer = '';
        let errors = '';
        let result: { ok: boolean; text: string } | undefined;
        child.stdout.on('data', (chunk) => {
          buffer += String(chunk);
          let at: number;
          while ((at = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, at).trim();
            buffer = buffer.slice(at + 1);
            if (!line) continue;
            let m: Record<string, any>;
            try { m = JSON.parse(line) as Record<string, any>; } catch { continue; }
            if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool' && typeof m.request_id === 'string') {
              // A failure to decide is a refusal, never a silent yes.
              void permission(m.request_id, String(m.request.tool_name ?? ''), (m.request.input ?? {}) as Record<string, unknown>)
                .catch(() => reply(m.request_id as string, { behavior: 'deny', message: 'This step could not be checked, so it was refused.' }));
            } else if (m.type === 'assistant' && m.message?.usage) {
              const u = m.message.usage as { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number };
              // A plan, not a bill: tokens only (plan decision 8). Text read back from the cache is left out; it
              // would count the same words again on every step.
              void run.spent(0, (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
            } else if (m.type === 'result') {
              result = { ok: m.is_error !== true && m.subtype === 'success', text: typeof m.result === 'string' ? m.result : '' };
              // The one message has been answered: closing stdin lets the program end by itself.
              try { child.stdin.end(); } catch { /* already closed */ }
            }
          }
        });
        child.stderr.on('data', (chunk) => { if (errors.length < 2000) errors += String(chunk); });
        child.on('error', (err) => reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'Claude Code is not installed on this computer.' : err.message)));
        child.on('close', (code) => {
          if (result?.ok) resolve(readEnding(result.text));
          else if (result) reject(new Error(result.text || 'Claude Code ended the run with an error.'));
          // Never an invented cause: what Claude Code itself printed, or only the fact that it stopped.
          else reject(new Error(errors.trim().split('\n').slice(-1)[0] || `Claude Code stopped before finishing (code ${code ?? 'unknown'}).`));
        });
        try { child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: firstMessage(run.instruction, run.eventData) } })}\n`); }
        catch (err) { reject(err instanceof Error ? err : new Error(String(err))); }
      });
    })();

    return {
      done,
      stop: () => { stopped = true; try { proc?.kill(); } catch { /* already ended */ } },
    };
  };
}
