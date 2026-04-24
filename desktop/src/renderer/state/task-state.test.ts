import { describe, it, expect } from 'vitest';
import { parseTaskCreateResult, parseTaskListResult } from './task-state';

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

  it('does not throw on non-string-like garbage', () => {
    expect(() => parseTaskListResult('')).not.toThrow();
  });
});
