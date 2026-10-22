import { browserToolOf } from '../../shared/browser-types';
import { ToolCallState } from '../../shared/types';
import { toolOutcome } from './tool-outcome';

// Plain-language headline for a collapsed tool group (2+ tool calls sharing
// one bubble). Replaces the raw "N tools (Bash, Write) — all complete" line
// with a sentence naming what actually happened, per Destin's 2026-09-06
// tool-group-readability questions deck (Q1-Q5, all picked their recommended
// option — see docs/active/design/2026-09-06-tool-group-readability/).

interface KindPhrasing {
  /** Everything in this bucket has finished (success or failure) — past tense. */
  done: (count: number) => string;
  /** At least one item in this bucket is still running — gerund. */
  active: (count: number) => string;
}

// Q4a: name the outside service when we already show a friendly name for it
// elsewhere in the app; a slug with no entry here still gets title-cased
// rather than falling to the generic "a tool" (that's reserved for a
// genuinely nameless server).
const FRIENDLY_MCP_SERVER: Record<string, string> = {
  gmail: 'Gmail',
  'google-services': 'Google',
  todoist: 'Todoist',
  'windows-control': 'your computer',
};

function titleCaseServer(slug: string): string {
  return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const KIND_TABLE: Record<string, KindPhrasing> = {
  Bash: {
    done: (n) => (n === 1 ? 'ran a command' : `ran ${n} commands`),
    active: (n) => (n === 1 ? 'running a command' : `running ${n} commands`),
  },
  Read: {
    done: (n) => (n === 1 ? 'read a file' : `read ${n} files`),
    active: (n) => (n === 1 ? 'reading a file' : `reading ${n} files`),
  },
  Write: {
    done: (n) => (n === 1 ? 'created a file' : `created ${n} files`),
    active: (n) => (n === 1 ? 'creating a file' : `creating ${n} files`),
  },
  Edit: {
    done: (n) => (n === 1 ? 'edited a file' : `edited ${n} files`),
    active: (n) => (n === 1 ? 'editing a file' : `editing ${n} files`),
  },
  Grep: {
    done: (n) => (n === 1 ? 'searched the code' : `ran ${n} code searches`),
    active: (n) => (n === 1 ? 'searching the code' : `running ${n} code searches`),
  },
  Glob: {
    done: (n) => (n === 1 ? 'looked for files' : `ran ${n} file searches`),
    active: (n) => (n === 1 ? 'looking for files' : `running ${n} file searches`),
  },
  WebSearch: {
    done: (n) => (n === 1 ? 'searched the web' : `ran ${n} web searches`),
    active: (n) => (n === 1 ? 'searching the web' : `running ${n} web searches`),
  },
  WebFetch: {
    done: (n) => (n === 1 ? 'opened a webpage' : `opened ${n} webpages`),
    active: (n) => (n === 1 ? 'opening a webpage' : `opening ${n} webpages`),
  },
  Task: {
    done: (n) => (n === 1 ? 'brought in a specialist' : `brought in ${n} specialists`),
    active: (n) => (n === 1 ? 'bringing in a specialist' : `bringing in ${n} specialists`),
  },
  Agent: {
    done: (n) => (n === 1 ? 'ran a sub-agent' : `ran ${n} sub-agents`),
    active: (n) => (n === 1 ? 'running a sub-agent' : `running ${n} sub-agents`),
  },
  // Managing helpers and background work (2026-10-22, Destin: a status check or a note
  // "still reports as 'hiring specialist', which makes it seem like were adding a new
  // subagent when we arent"). Each management call is its own kind (callKindKey below).
  'specialist-check': {
    done: (n) => (n === 1 ? 'checked on its specialists' : `checked on its specialists ${n} times`),
    active: () => 'checking on its specialists',
  },
  'specialist-note': {
    done: (n) => (n === 1 ? 'sent a note to a specialist' : `sent ${n} notes to specialists`),
    active: (n) => (n === 1 ? 'sending a note to a specialist' : `sending ${n} notes to specialists`),
  },
  'specialist-resume': {
    done: (n) => (n === 1 ? 'resumed a specialist' : `resumed ${n} specialists`),
    active: (n) => (n === 1 ? 'resuming a specialist' : `resuming ${n} specialists`),
  },
  'specialist-stop': {
    done: (n) => (n === 1 ? 'stopped a specialist' : `stopped ${n} specialists`),
    active: (n) => (n === 1 ? 'stopping a specialist' : `stopping ${n} specialists`),
  },
  'helper-message': {
    done: (n) => (n === 1 ? 'sent a note to a sub-agent' : `sent ${n} notes to sub-agents`),
    active: (n) => (n === 1 ? 'sending a note to a sub-agent' : `sending ${n} notes to sub-agents`),
  },
  'background-check': {
    done: (n) => (n === 1 ? 'checked on a background task' : `checked on background tasks ${n} times`),
    active: () => 'checking on a background task',
  },
  'background-stop': {
    done: (n) => (n === 1 ? 'stopped a background task' : `stopped ${n} background tasks`),
    active: (n) => (n === 1 ? 'stopping a background task' : `stopping ${n} background tasks`),
  },
  Monitor: {
    done: (n) => (n === 1 ? 'ran a watcher' : `ran ${n} watchers`),
    active: (n) => (n === 1 ? 'running a watcher' : `running ${n} watchers`),
  },
  ScheduleWakeup: {
    done: () => 'set a time to check back',
    active: () => 'setting a time to check back',
  },
  Workflow: {
    done: (n) => (n === 1 ? 'ran a workflow' : `ran ${n} workflows`),
    active: (n) => (n === 1 ? 'running a workflow' : `running ${n} workflows`),
  },
  AskUserQuestion: {
    done: (n) => (n === 1 ? 'asked you a question' : `asked you ${n} questions`),
    active: (n) => (n === 1 ? 'asking you a question' : `asking you ${n} questions`),
  },
  ExitPlanMode: {
    done: () => 'put together a plan',
    active: () => 'putting together a plan',
  },
  // TaskCreate/TaskUpdate share one bucket (kindKey below) — "updated its
  // to-do list" twice in one sentence would read like a bug, not two facts.
  todo: {
    done: () => 'updated its to-do list',
    active: () => 'updating its to-do list',
  },
  // max_steps/doom_loop: synthetic permission asks, not real tool calls
  // (harness-session.ts) — share a bucket for the same reason as the to-do pair.
  checkin: {
    done: () => 'checked in with you',
    active: () => 'checking in with you',
  },
  // The Browser (2026-10-13): every Browser step, native or Claude Code's
  // random-id MCP name, is one plain kind — never "Youcoded Browser F990aa15".
  browser: {
    done: (n) => (n === 1 ? 'used the browser' : `used the browser ${n} times`),
    active: (n) => (n === 1 ? 'using the browser' : `using the browser ${n} times`),
  },
};

function mcpPhrasing(server: string): KindPhrasing {
  const name = FRIENDLY_MCP_SERVER[server] ?? (server ? titleCaseServer(server) : 'a tool');
  return {
    done: (n) => (n === 1 ? `used ${name}` : `used ${name} ${n} times`),
    active: (n) => (n === 1 ? `using ${name}` : `using ${name} ${n} times`),
  };
}

// The bucket a tool call's headline phrase belongs to. Distinct from
// toolName so TaskCreate/TaskUpdate and max_steps/doom_loop collapse into one
// phrase each, and so every mcp__<server>__* action groups with same-server
// siblings while still reading as its own kind next to Gmail, Todoist, etc.
function kindKey(toolName: string): string {
  if (toolName === 'TaskCreate' || toolName === 'TaskUpdate' || toolName === 'TodoWrite'
    || toolName === 'TaskList' || toolName === 'TaskGet') return 'todo';
  if (toolName === 'TaskOutput' || toolName === 'BashOutput') return 'background-check';
  if (toolName === 'TaskStop' || toolName === 'KillShell') return 'background-stop';
  if (toolName === 'SendMessage') return 'helper-message';
  if (toolName === 'max_steps' || toolName === 'doom_loop') return 'checkin';
  if (browserToolOf(toolName)) return 'browser';
  if (toolName.startsWith('mcp__')) return `mcp:${toolName.slice(5).split('__')[0] || ''}`;
  return toolName;
}

/** A CALL's bucket: the native Task tool is a hire only when it names no `task_id` and
 *  does not ask for the `list` — otherwise it manages an existing specialist, and its
 *  own result says whether a `task_id` prompt was a note ("Steer delivered to …") or a
 *  resume (tools/task.ts). */
function callKindKey(t: Pick<ToolCallState, 'toolName' | 'input' | 'response' | 'status'>): string {
  if (t.toolName !== 'Task') return kindKey(t.toolName);
  const input = t.input ?? {};
  if (input.list === true && !input.task_id) return 'specialist-check';
  if (!input.task_id) return 'Task';
  if (input.interrupt === true) return 'specialist-stop';
  const resp = t.status === 'complete' ? (t.response ?? '') : '';
  return resp && !resp.startsWith('Steer delivered') ? 'specialist-resume' : 'specialist-note';
}

function phrasingFor(toolName: string, key = kindKey(toolName)): KindPhrasing {
  if (browserToolOf(toolName)) return KIND_TABLE.browser;
  if (toolName.startsWith('mcp__')) return mcpPhrasing(toolName.slice(5).split('__')[0] || '');
  return (
    KIND_TABLE[key] ??
    // Unknown/future tool — Q4's generic fallback applies here too.
    { done: (n) => (n === 1 ? 'used a tool' : `used tools ${n} times`), active: (n) => (n === 1 ? 'using a tool' : `using tools ${n} times`) }
  );
}

function joinWithAnd(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * The same plain-language verb a tool group uses, for a SINGLE (ungrouped)
 * tool card's label — "Ran a command" once it's done, "Running a command"
 * while it's still going. Callers move the specific detail (which file, which
 * command) into the card's detail line rather than baking it into the label,
 * matching how the group headline names the action, not the argument.
 */
export function toolActionLabel(toolName: string, active: boolean): string {
  const phrasing = phrasingFor(toolName);
  return capitalize(active ? phrasing.active(1) : phrasing.done(1));
}

// Running / done / failed all come from toolOutcome (utils/tool-outcome.ts), the
// one rule the group header's icon and "— N failed" suffix also read, so the
// headline and the header can never disagree about a background helper.
const isRunning = (t: ToolCallState): boolean => toolOutcome(t) === 'running';
const isDone = (t: ToolCallState): boolean => toolOutcome(t) === 'completed';

/**
 * The plain-language headline for a tool group — everything before the
 * "— N failed" / "— waiting on you" suffixes CollapsedToolGroup still owns
 * (Q3a: those stay exactly as they read today).
 *
 * Q1a/Q2a (settled — nothing running): name the first 2 distinct kinds, each
 * with its own count ("created 2 files and ran 3 commands"), fold any
 * further kinds into "(+N more)".
 *
 * Q1 note/Q5a (something still running): name EVERY kind with a running
 * item (there are rarely more than a couple at once, so no cap), then fold
 * whatever has already finished into "(+N completed)", splitting out an
 * already-failed item immediately rather than waiting for the group to
 * settle ("(+N completed, M failed)").
 */
export function buildToolGroupHeadline(tools: ToolCallState[]): string {
  const order: string[] = [];
  const buckets = new Map<string, ToolCallState[]>();
  for (const t of tools) {
    const key = callKindKey(t);
    if (!buckets.has(key)) {
      order.push(key);
      buckets.set(key, []);
    }
    buckets.get(key)!.push(t);
  }

  if (tools.some(isRunning)) {
    const activeKinds = order.filter((k) => buckets.get(k)!.some(isRunning));
    const activePhrase = activeKinds.map((k) => {
      const running = buckets.get(k)!.filter(isRunning);
      return phrasingFor(running[0].toolName, k).active(running.length);
    });
    const lead = capitalize(joinWithAnd(activePhrase)) || 'Working';

    const doneCount = tools.filter(isDone).length;
    const failedCount = tools.filter((t) => toolOutcome(t) === 'failed').length;
    // Nothing finished yet but something failed: "(+1 failed)", never "(+0 completed, 1 failed)".
    if (failedCount > 0) return doneCount > 0 ? `${lead} (+${doneCount} completed, ${failedCount} failed)` : `${lead} (+${failedCount} failed)`;
    if (doneCount > 0) return `${lead} (+${doneCount} completed)`;
    return lead;
  }

  const namedKinds = order.slice(0, 2);
  const restKinds = order.slice(2);
  const namedPhrase = namedKinds.map((k) => {
    const items = buckets.get(k)!;
    return phrasingFor(items[0].toolName, k).done(items.length);
  });
  const lead = capitalize(joinWithAnd(namedPhrase)) || 'Did some work';
  return restKinds.length > 0 ? `${lead} (+${restKinds.length} more)` : lead;
}
