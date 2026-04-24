import { ToolCallState } from '../../shared/types';

// Derived per-session task state built from Task* tool calls in chat state.
// Scans toolCalls in insertion order. Pure function — memoize on the Map ref
// (preserved across streams per chat-reducer invariants).
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
 * this format ever changes in Claude Code, the Open Tasks chip degrades
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

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskStop', 'TaskList']);

export function buildTasksById(toolCalls: Map<string, ToolCallState>): Map<string, TaskState> {
  const tasks = new Map<string, TaskState>();

  // Scan in insertion order. `idx` gives us stable orderIndex values.
  let idx = 0;
  for (const tool of toolCalls.values()) {
    const i = idx++;
    if (!TASK_TOOLS.has(tool.toolName)) continue;
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

  return tasks;
}

export const TASK_LIFECYCLE: TaskStatus[] = ['pending', 'in_progress', 'completed'];
