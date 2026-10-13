import { ToolCallState } from '../../shared/types';

// Derived per-session task state built from the session's to-do tool calls in chat state:
// Claude Code's TaskCreate / TaskUpdate / TaskGet / TaskList, and TodoWrite — the native
// harness's only task tool (main/harness/tools/todo-write.ts) and the one Claude Code uses in
// its todo-list mode. Scans toolCalls in insertion order. Pure function — memoize on the Map
// ref (preserved across streams per chat-reducer invariants).
//
// TaskCreate returns its numeric id ONLY in the response string (see
// parseTaskCreateResult). TaskList response is the authoritative per-session
// snapshot (see parseTaskListResult). Both are CC-coupled; see
// youcoded/docs/cc-dependencies.md.

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface TaskEvent {
  /** The toolUseId that produced this event — lets the UI scroll-link back. */
  toolUseId: string;
  toolName: string;
  status?: TaskStatus;
  /**
   * The tool input (for TaskCreate/TaskUpdate) or a synthesized row subset
   * (for TaskList). Shape varies by toolName. Consumers that need a uniform
   * view should branch on toolName.
   */
  patch?: Record<string, unknown>;
}

export interface TaskState {
  id: string;
  subject?: string;
  description?: string;
  activeForm?: string;           // Present-continuous label shown while in_progress
  priority?: string;
  status?: TaskStatus;
  /** Insertion index in toolCalls where this task first appeared — stable sort key. Always set by buildTasksById. */
  orderIndex: number;
  /** Events in chronological order (insertion order of toolCalls Map). */
  events: TaskEvent[];
  /** User-flagged-inactive in the UI. View-model only; not derived from tool calls. */
  markedInactive?: boolean;
}

/**
 * Parse Claude Code's TaskCreate response string to extract task id + subject.
 * Example input: "Task #1 created successfully: Sync youcoded master"
 *
 * The numeric id is NOT in the tool input — only in this response string. If
 * this format ever changes in Claude Code, the Open tasks chip degrades
 * gracefully: tasks appear only once TaskUpdate/TaskList mention them. See
 * youcoded/docs/cc-dependencies.md for the coupling.
 */
export function parseTaskCreateResult(text: string): { id: string; subject: string } | null {
  if (typeof text !== 'string') return null;
  const match = text.match(/^Task #(\d+) created successfully: (.+)$/);
  if (!match) return null;
  return { id: match[1], subject: match[2] };
}

/**
 * Parse Claude Code's TaskList response block into a per-task snapshot.
 * Example row: "#1 [completed] Task 1: Create worktree and branch"
 * The "Task N: " prefix is optional.
 *
 * Malformed lines are skipped silently — a format change degrades to "some
 * tasks missing from the snapshot" rather than a render crash.
 */
export function parseTaskListResult(text: string): Array<{ id: string; status: TaskStatus; subject: string }> {
  if (typeof text !== 'string' || text.length === 0) return [];
  const rows: Array<{ id: string; status: TaskStatus; subject: string }> = [];
  // 'deleted' is intentionally omitted — CC's TaskList never emits that status
  // in sampled transcripts. TaskStatus includes 'deleted' for TaskUpdate paths.
  const lineRegex = /^#(\d+) \[(pending|in_progress|completed)\] (?:Task \d+: )?(.+)$/;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(lineRegex);
    if (!match) continue;
    rows.push({ id: match[1], status: match[2] as TaskStatus, subject: match[3].trim() });
  }
  return rows;
}

// WHY TaskStop is NOT here (Open tasks investigation, 2026-10-13): it is Claude Code's "stop a
// background command or helper" tool, not a to-do tool. Listed here, a call written with
// `taskId` (real transcripts carry {"taskId":"bwo1mm03m"}) became a nameless task that counted
// as pending forever, so the chip said "1 pending" with nothing to do.
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList']);

/** Prefix for tasks that came from a TodoWrite list, so the next list can replace only those. */
const TODO_ID_PREFIX = 'todo:';

interface TodoItem { content: string; status: TaskStatus; activeForm?: string }

/** The usable items of a TodoWrite input. Malformed items are skipped, never thrown on. */
function readTodoItems(input: Record<string, unknown>): TodoItem[] {
  const raw = input.todos;
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { content, status, activeForm } = item as Record<string, unknown>;
    if (typeof content !== 'string' || content.trim() === '') continue;
    const st = status === 'in_progress' || status === 'completed' ? status : 'pending';
    out.push({ content, status: st, ...(typeof activeForm === 'string' && { activeForm }) });
  }
  return out;
}

/**
 * Apply one TodoWrite to the task map. A TodoWrite REPLACES the whole list (the native tool
 * empties and refills it; Claude Code's does the same), so earlier TodoWrite tasks that the new
 * list leaves out are dropped.
 *
 * WHY ids come from the item's words, not its position: the "Marked inactive" flag is stored by
 * id, and a model often inserts a step in front of others. A position id would move the flag
 * onto a different task; the words stay with the task while its status changes. A repeated
 * item gets "#2", "#3" so both show.
 */
function applyTodoWrite(tasks: Map<string, TaskState>, tool: ToolCallState, i: number): void {
  const items = readTodoItems(tool.input || {});
  const seen = new Map<string, number>();
  const kept = new Set<string>();
  items.forEach((item, pos) => {
    const n = (seen.get(item.content) ?? 0) + 1;
    seen.set(item.content, n);
    const id = `${TODO_ID_PREFIX}${item.content}${n > 1 ? `#${n}` : ''}`;
    kept.add(id);
    const existing = tasks.get(id);
    tasks.set(id, {
      id,
      subject: item.content,
      activeForm: item.activeForm ?? existing?.activeForm,
      status: item.status,
      // The list's own order is the order to show. Fractions keep every item of this write
      // between this tool call's index and the next one's.
      orderIndex: i + pos / (items.length + 1),
      events: [...(existing?.events ?? []), {
        toolUseId: tool.toolUseId,
        toolName: tool.toolName,
        status: item.status,
        patch: { ...item },
      }],
    });
  });
  for (const id of [...tasks.keys()]) {
    if (id.startsWith(TODO_ID_PREFIX) && !kept.has(id)) tasks.delete(id);
  }
}

export function buildTasksById(toolCalls: Map<string, ToolCallState>): Map<string, TaskState> {
  const tasks = new Map<string, TaskState>();

  // Scan in insertion order. `idx` gives us stable orderIndex values.
  let idx = 0;
  for (const tool of toolCalls.values()) {
    const i = idx++;
    const isTodoWrite = tool.toolName === 'TodoWrite';
    if (!isTodoWrite && !TASK_TOOLS.has(tool.toolName)) continue;
    // WHY: a call the tool rejected changed nothing (a TodoWrite that failed validation never
    // replaced the list; a failed TaskUpdate never moved the status), so it must not here either.
    if (tool.status === 'failed') continue;
    if (isTodoWrite) { applyTodoWrite(tasks, tool, i); continue; }
    const input = tool.input || {};

    // --- TaskList: authoritative snapshot, overwrites current tasks ---
    if (tool.toolName === 'TaskList' && typeof tool.response === 'string') {
      for (const row of parseTaskListResult(tool.response)) {
        const existing = tasks.get(row.id) || { id: row.id, events: [], orderIndex: i };
        tasks.set(row.id, {
          ...existing,
          subject: row.subject ?? existing.subject,
          status: row.status,
          events: [...existing.events, {
            toolUseId: tool.toolUseId,
            toolName: tool.toolName,
            status: row.status,
            patch: { taskId: row.id, subject: row.subject, status: row.status },
          }],
        });
      }
      continue;
    }

    // --- TaskCreate: derive id from the response string if the input lacks it ---
    let taskId = input.taskId as string | undefined;
    if (!taskId && tool.toolName === 'TaskCreate' && typeof tool.response === 'string') {
      const parsed = parseTaskCreateResult(tool.response);
      if (parsed) taskId = parsed.id;
    }
    if (!taskId) continue;
    // WHY: TaskGet only reads a task. For an id never seen it would otherwise invent an empty
    // "pending" task out of a lookup.
    if (tool.toolName === 'TaskGet' && !tasks.has(taskId)) continue;

    const existing = tasks.get(taskId) || { id: taskId, events: [], orderIndex: i };
    const status = input.status as TaskStatus | undefined;

    const event: TaskEvent = {
      toolUseId: tool.toolUseId,
      toolName: tool.toolName,
      ...(status && { status }),
      patch: { ...input },
    };

    tasks.set(taskId, {
      ...existing,
      // Merge known fields — last writer wins for scalars; a later update's
      // subject overrides earlier ones (matches TaskUpdate's patch semantics).
      subject: (input.subject as string | undefined) ?? existing.subject,
      description: (input.description as string | undefined) ?? existing.description,
      activeForm: (input.activeForm as string | undefined) ?? existing.activeForm,
      priority: (input.priority as string | undefined) ?? existing.priority,
      status: status ?? existing.status,
      events: [...existing.events, event],
    });
  }

  // WHY deleted tasks leave the list (Open tasks rework, 2026-10-13): Claude deleting a task
  // means it is no longer part of the plan — Claude Code's own list drops it too. Shown, it sat
  // under "Completed" with a hand-made "deleted" tag, reading as work that was done.
  for (const [id, t] of tasks) if (t.status === 'deleted') tasks.delete(id);

  return tasks;
}

export const TASK_LIFECYCLE: TaskStatus[] = ['pending', 'in_progress', 'completed'];
