import { describe, it, expect } from 'vitest';
import { parseTaskCreateResult, parseTaskListResult, buildTasksById, toolIdsBeforeLastClear } from './task-state';
import type { ToolCallState } from '../../shared/types';

function makeCall(overrides: Partial<ToolCallState> & { toolUseId: string; toolName: string }): ToolCallState {
  return {
    status: 'complete',
    input: {},
    ...overrides,
  } as ToolCallState;
}

describe('parseTaskCreateResult', () => {
  it('parses the canonical "Task #N created successfully: <subject>" form', () => {
    const result = parseTaskCreateResult('Task #1 created successfully: Sync youcoded master');
    expect(result).toEqual({ id: '1', subject: 'Sync youcoded master' });
  });

  it('handles multi-digit IDs', () => {
    const result = parseTaskCreateResult('Task #42 created successfully: Do the thing');
    expect(result).toEqual({ id: '42', subject: 'Do the thing' });
  });

  it('preserves colons inside subjects', () => {
    const result = parseTaskCreateResult('Task #3 created successfully: Verified: all tests pass');
    expect(result).toEqual({ id: '3', subject: 'Verified: all tests pass' });
  });

  it('returns null for malformed strings (no "created successfully")', () => {
    expect(parseTaskCreateResult('Task #1 was definitely made: Hello')).toBeNull();
  });

  it('returns null for the empty string', () => {
    expect(parseTaskCreateResult('')).toBeNull();
  });

  it('returns null when the ID is missing', () => {
    expect(parseTaskCreateResult('Task # created successfully: Hello')).toBeNull();
  });

  it('does not throw on non-string-looking input', () => {
    expect(() => parseTaskCreateResult('\n\n\n')).not.toThrow();
    expect(parseTaskCreateResult('\n\n\n')).toBeNull();
  });
});

describe('parseTaskListResult', () => {
  it('parses a standard TaskList block with mixed statuses', () => {
    const input = [
      '#1 [completed] Task 1: Create worktree and branch',
      '#2 [in_progress] Task 2: Plugin grouping utility',
      '#3 [pending] Task 3: Wire it into the UI',
    ].join('\n');
    const result = parseTaskListResult(input);
    expect(result).toEqual([
      { id: '1', status: 'completed', subject: 'Create worktree and branch' },
      { id: '2', status: 'in_progress', subject: 'Plugin grouping utility' },
      { id: '3', status: 'pending', subject: 'Wire it into the UI' },
    ]);
  });

  it('tolerates missing "Task N:" prefix (subject only)', () => {
    const input = '#7 [pending] Some subject without the prefix';
    const result = parseTaskListResult(input);
    expect(result).toEqual([
      { id: '7', status: 'pending', subject: 'Some subject without the prefix' },
    ]);
  });

  it('skips blank lines and non-matching lines silently', () => {
    const input = [
      '',
      'Here are the open tasks:',
      '#1 [completed] Task 1: First',
      '',
      'garbage line',
      '#2 [pending] Task 2: Second',
    ].join('\n');
    const result = parseTaskListResult(input);
    expect(result).toEqual([
      { id: '1', status: 'completed', subject: 'First' },
      { id: '2', status: 'pending', subject: 'Second' },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseTaskListResult('')).toEqual([]);
  });

  it('does not throw on whitespace-only input', () => {
    expect(() => parseTaskListResult('\n\n\n')).not.toThrow();
    expect(parseTaskListResult('\n\n\n')).toEqual([]);
  });

  it('skips a non-matching single line without throwing', () => {
    expect(() => parseTaskListResult('not a task line at all')).not.toThrow();
    expect(parseTaskListResult('not a task line at all')).toEqual([]);
  });
});

describe('buildTasksById (extended)', () => {
  it('indexes a TaskCreate-only task via the response string', () => {
    const toolCalls = new Map<string, ToolCallState>();
    toolCalls.set('t1', makeCall({
      toolUseId: 't1',
      toolName: 'TaskCreate',
      input: { subject: 'Do the thing', description: 'Detail', activeForm: 'Doing the thing' },
      response: 'Task #5 created successfully: Do the thing',
    }));

    const tasks = buildTasksById(toolCalls);
    const task = tasks.get('5');
    expect(task).toBeDefined();
    expect(task!.id).toBe('5');
    expect(task!.subject).toBe('Do the thing');
    expect(task!.description).toBe('Detail');
    expect(task!.activeForm).toBe('Doing the thing');
    expect(task!.orderIndex).toBe(0);
    expect(task!.status).toBeUndefined();
  });

  it('lets a TaskList snapshot overwrite a stale TaskUpdate status', () => {
    const toolCalls = new Map<string, ToolCallState>();
    toolCalls.set('t1', makeCall({
      toolUseId: 't1',
      toolName: 'TaskCreate',
      input: { subject: 'S', description: 'D' },
      response: 'Task #1 created successfully: S',
    }));
    toolCalls.set('t2', makeCall({
      toolUseId: 't2',
      toolName: 'TaskUpdate',
      input: { taskId: '1', status: 'in_progress' },
    }));
    toolCalls.set('t3', makeCall({
      toolUseId: 't3',
      toolName: 'TaskList',
      input: {},
      response: '#1 [completed] Task 1: S',
    }));

    const task = buildTasksById(toolCalls).get('1');
    expect(task!.status).toBe('completed');
  });

  it('preserves existing TaskUpdate-only indexing (backward compatibility)', () => {
    const toolCalls = new Map<string, ToolCallState>();
    toolCalls.set('t1', makeCall({
      toolUseId: 't1',
      toolName: 'TaskUpdate',
      input: { taskId: '9', status: 'pending' },
    }));
    const task = buildTasksById(toolCalls).get('9');
    expect(task).toBeDefined();
    expect(task!.status).toBe('pending');
  });

  it('sets orderIndex from the first toolCalls index the task appears at', () => {
    const toolCalls = new Map<string, ToolCallState>();
    toolCalls.set('a', makeCall({
      toolUseId: 'a', toolName: 'Bash', input: { command: 'ls' },
    }));
    toolCalls.set('b', makeCall({
      toolUseId: 'b', toolName: 'TaskCreate',
      input: { subject: 'X' }, response: 'Task #3 created successfully: X',
    }));
    toolCalls.set('c', makeCall({
      toolUseId: 'c', toolName: 'TaskUpdate',
      input: { taskId: '3', status: 'in_progress' },
    }));

    const task = buildTasksById(toolCalls).get('3');
    expect(task!.orderIndex).toBe(1);
  });

  it('tolerates unknown input keys without throwing', () => {
    const toolCalls = new Map<string, ToolCallState>();
    toolCalls.set('t1', makeCall({
      toolUseId: 't1', toolName: 'TaskCreate',
      input: { subject: 'S', owner: 'agent-x', metadata: { foo: 1 } },
      response: 'Task #1 created successfully: S',
    }));
    const result = buildTasksById(toolCalls);
    expect(result.get('1')).toBeDefined();
  });
});

// WHY (Open tasks investigation, 2026-10-13): the native harness's only task tool is TodoWrite
// (desktop/src/main/harness/tools/todo-write.ts), and Claude Code uses TodoWrite instead of
// TaskCreate in some modes — but buildTasksById ignored it, so a native session's Open tasks
// chip never appeared. Each TodoWrite replaces the whole list, so the latest one is the truth.
describe('buildTasksById — TodoWrite (native harness and Claude Code todo lists)', () => {
  const todoWrite = (toolUseId: string, todos: Array<{ content: string; status: string; activeForm?: string }>, status: ToolCallState['status'] = 'complete') =>
    makeCall({ toolUseId, toolName: 'TodoWrite', input: { todos: todos.map((t) => ({ activeForm: `${t.content}…`, ...t })) }, status });

  it('derives one task per item of a TodoWrite list, in list order', () => {
    const toolCalls = new Map<string, ToolCallState>();
    toolCalls.set('w1', todoWrite('w1', [
      { content: 'Read the file', status: 'completed' },
      { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
      { content: 'Run the tests', status: 'pending' },
    ]));
    const tasks = [...buildTasksById(toolCalls).values()].sort((a, b) => a.orderIndex - b.orderIndex);
    expect(tasks.map((t) => [t.subject, t.status])).toEqual([
      ['Read the file', 'completed'],
      ['Fix the bug', 'in_progress'],
      ['Run the tests', 'pending'],
    ]);
    expect(tasks[1].activeForm).toBe('Fixing the bug');
  });

  it('lets the latest TodoWrite replace the list: statuses move on, dropped items go', () => {
    const toolCalls = new Map<string, ToolCallState>();
    toolCalls.set('w1', todoWrite('w1', [
      { content: 'A', status: 'in_progress' },
      { content: 'B', status: 'pending' },
      { content: 'C', status: 'pending' },
    ]));
    toolCalls.set('w2', todoWrite('w2', [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress' },
    ]));
    const tasks = [...buildTasksById(toolCalls).values()];
    expect(tasks.map((t) => [t.subject, t.status]).sort()).toEqual([['A', 'completed'], ['B', 'in_progress']]);
  });

  it('keeps a task\'s id across writes so a "Marked inactive" flag stays on the same task', () => {
    const toolCalls = new Map<string, ToolCallState>();
    toolCalls.set('w1', todoWrite('w1', [{ content: 'A', status: 'pending' }, { content: 'B', status: 'pending' }]));
    const before = [...buildTasksById(toolCalls).values()].find((t) => t.subject === 'B')!.id;
    // A new item inserted in front of B must not hand B's id to it.
    toolCalls.set('w2', todoWrite('w2', [{ content: 'New first', status: 'pending' }, { content: 'A', status: 'pending' }, { content: 'B', status: 'pending' }]));
    const after = [...buildTasksById(toolCalls).values()].find((t) => t.subject === 'B')!.id;
    expect(after).toBe(before);
  });

  it('ignores a TodoWrite the tool rejected (the list was not replaced)', () => {
    const toolCalls = new Map<string, ToolCallState>();
    toolCalls.set('w1', todoWrite('w1', [{ content: 'A', status: 'pending' }]));
    toolCalls.set('w2', todoWrite('w2', [{ content: 'A', status: 'completed' }], 'failed'));
    expect([...buildTasksById(toolCalls).values()].map((t) => t.status)).toEqual(['pending']);
  });

  it('tolerates a malformed TodoWrite input without throwing', () => {
    const toolCalls = new Map<string, ToolCallState>();
    toolCalls.set('w1', makeCall({ toolUseId: 'w1', toolName: 'TodoWrite', input: { todos: 'nope' } }));
    toolCalls.set('w2', makeCall({ toolUseId: 'w2', toolName: 'TodoWrite', input: { todos: [null, { status: 'pending' }, { content: 'Ok', status: 'pending' }] } }));
    expect([...buildTasksById(toolCalls).values()].map((t) => t.subject)).toEqual(['Ok']);
  });
});

// WHY (Open tasks investigation, 2026-10-13): TaskStop is Claude Code's "stop a background
// command or helper" tool, not a to-do tool. When Claude called it with `taskId` (seen in real
// transcripts: {"taskId":"bwo1mm03m"}) a nameless "pending" task appeared and never went away.
describe('buildTasksById — tools that are not to-dos', () => {
  it('never makes a task from TaskStop', () => {
    const toolCalls = new Map<string, ToolCallState>();
    toolCalls.set('s1', makeCall({ toolUseId: 's1', toolName: 'TaskStop', input: { taskId: 'bwo1mm03m' } }));
    expect(buildTasksById(toolCalls).size).toBe(0);
  });

  it('never makes a task from a TaskGet of an id it has not seen (TaskGet only reads)', () => {
    const toolCalls = new Map<string, ToolCallState>();
    toolCalls.set('g1', makeCall({ toolUseId: 'g1', toolName: 'TaskGet', input: { taskId: '4' } }));
    expect(buildTasksById(toolCalls).size).toBe(0);
  });

  it('drops a deleted task from the list (Claude removed it; it is not a finished task)', () => {
    const toolCalls = new Map<string, ToolCallState>();
    toolCalls.set('t1', makeCall({ toolUseId: 't1', toolName: 'TaskCreate', input: { subject: 'X' }, response: 'Task #1 created successfully: X' }));
    toolCalls.set('t2', makeCall({ toolUseId: 't2', toolName: 'TaskUpdate', input: { taskId: '1', status: 'deleted' } }));
    expect(buildTasksById(toolCalls).size).toBe(0);
  });
});

// Final review F6: what counts as "before the clear".
describe('toolIdsBeforeLastClear', () => {
  const turn = (turnId: string) => ({ kind: 'assistant-turn', turnId });
  const marker = (variant: string) => ({ kind: 'system-marker', marker: { variant } });
  const session = (timeline: any[]) => ({
    timeline,
    assistantTurns: new Map([
      ['a', { segments: [{ type: 'tool-group', groupId: 'g1' }, { type: 'text' }] }],
      ['b', { segments: [{ type: 'tool-group', groupId: 'g2' }] }],
      ['c', { segments: [{ type: 'tool-group', groupId: 'g3' }] }],
    ]),
    toolGroups: new Map([['g1', { toolIds: ['t1', 't2'] }], ['g2', { toolIds: ['t3'] }], ['g3', { toolIds: ['t4'] }]]),
  });

  it('is empty with no clear, and ignores a compact divider', () => {
    expect([...toolIdsBeforeLastClear(session([turn('a'), marker('compact'), turn('b')]))]).toEqual([]);
  });

  it('takes every tool before the LAST clear, none after it', () => {
    expect([...toolIdsBeforeLastClear(session([turn('a'), marker('clear'), turn('b'), marker('clear'), turn('c')]))].sort())
      .toEqual(['t1', 't2', 't3']);
  });

  it('buildTasksById ignores the calls it is given as before the clear', () => {
    const calls = new Map([['t1', { toolUseId: 't1', toolName: 'TodoWrite', status: 'complete', input: { todos: [{ content: 'Old', status: 'pending' }] } } as any]]);
    expect(buildTasksById(calls).size).toBe(1);
    expect(buildTasksById(calls, new Set(['t1'])).size).toBe(0);
  });
});
