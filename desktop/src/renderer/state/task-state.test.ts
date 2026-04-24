import { describe, it, expect } from 'vitest';
import { parseTaskCreateResult } from './task-state';

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
