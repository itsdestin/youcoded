import { describe, it, expect } from 'vitest';
import { parseTaskCreateResult, parseTaskListResult, buildTasksById } from './task-state';
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
