import { ToolCallState } from '../../shared/types';

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
  if (toolName === 'TaskCreate' || toolName === 'TaskUpdate' || toolName === 'TodoWrite') return 'todo';
  if (toolName === 'max_steps' || toolName === 'doom_loop') return 'checkin';
  if (toolName.startsWith('mcp__')) return `mcp:${toolName.slice(5).split('__')[0] || ''}`;
  return toolName;
}

function phrasingFor(toolName: string): KindPhrasing {
  if (toolName.startsWith('mcp__')) return mcpPhrasing(toolName.slice(5).split('__')[0] || '');
  const key = kindKey(toolName);
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

/** A Task card whose helper is still working counts as running even though
 *  its own tool result (the launch ack) already landed — mirrors
 *  CollapsedToolGroup's stillWorking check so the two never disagree. */
function isRunning(t: ToolCallState): boolean {
  // WHY a Task card may remain `running` while its stopped helper's final tool
  // result is still unwinding. The ledger's terminal run status is authoritative
  // for that card, so it must clear the group spinner immediately.
  if (t.specialistRun) return t.specialistRun.status === 'running';
  return t.status === 'running';
}
function isDone(t: ToolCallState): boolean {
  return !isRunning(t) && (t.status === 'complete' || t.specialistRun?.status === 'completed');
}

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
    const key = kindKey(t.toolName);
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
      return phrasingFor(running[0].toolName).active(running.length);
    });
    const lead = capitalize(joinWithAnd(activePhrase)) || 'Working';

    const doneCount = tools.filter(isDone).length;
    const failedCount = tools.filter((t) => t.status === 'failed').length;
    if (failedCount > 0) return `${lead} (+${doneCount} completed, ${failedCount} failed)`;
    if (doneCount > 0) return `${lead} (+${doneCount} completed)`;
    return lead;
  }

  const namedKinds = order.slice(0, 2);
  const restKinds = order.slice(2);
  const namedPhrase = namedKinds.map((k) => {
    const items = buckets.get(k)!;
    return phrasingFor(items[0].toolName).done(items.length);
  });
  const lead = capitalize(joinWithAnd(namedPhrase)) || 'Did some work';
  return restKinds.length > 0 ? `${lead} (+${restKinds.length} more)` : lead;
}
