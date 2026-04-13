import { ToolCallState } from '../../shared/types';

// Derived per-session task state built from Task* tool calls in chat state.
// Pure function — no reducer changes needed. Scan is O(N) across toolCalls;
// callers should memoize on the toolCalls Map reference (preserved across
// text streaming per chat-reducer invariants).
//
// KNOWN LIMITATION: TaskCreate returns its taskId in the response string, not
// the input. Parsing it out of freeform text is fragile, so for now we only
// index tasks that ever appear in a TaskUpdate (which always carries taskId
// in input). A TaskCreate with no subsequent TaskUpdate is still rendered by
// TaskCreateView on its own — it just doesn't get linked into tasksById.

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface TaskEvent {
  /** The toolUseId that produced this event — lets the UI scroll-link back. */
  toolUseId: string;
  toolName: string;
  status?: TaskStatus;
  patch?: Record<string, unknown>;
}

export interface TaskState {
  id: string;
  subject?: string;
  description?: string;
  priority?: string;
  status?: TaskStatus;
  /** Events in chronological order (insertion order of toolCalls Map). */
  events: TaskEvent[];
}

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskStop']);

export function buildTasksById(toolCalls: Map<string, ToolCallState>): Map<string, TaskState> {
  const tasks = new Map<string, TaskState>();

  for (const tool of toolCalls.values()) {
    if (!TASK_TOOLS.has(tool.toolName)) continue;
    const input = tool.input || {};
    const taskId = input.taskId as string | undefined;
    if (!taskId) continue; // TaskCreate without pre-assigned id — skip (see note above)

    const existing = tasks.get(taskId) || { id: taskId, events: [] };
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
      priority: (input.priority as string | undefined) ?? existing.priority,
      status: status ?? existing.status,
      events: [...existing.events, event],
    });
  }

  return tasks;
}

export const TASK_LIFECYCLE: TaskStatus[] = ['pending', 'in_progress', 'completed'];
