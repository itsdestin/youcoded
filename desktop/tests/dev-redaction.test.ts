// desktop/tests/dev-redaction.test.ts
import { describe, it, expect } from 'vitest';
import { redactLog } from '../src/main/dev-tools';

describe('redactLog', () => {
  it('replaces the user home dir with ~', () => {
    expect(redactLog('opened C:\\Users\\alice\\projects\\foo', 'C:\\Users\\alice'))
      .toBe('opened ~\\projects\\foo');
    expect(redactLog('opened /Users/alice/projects/foo', '/Users/alice'))
      .toBe('opened ~/projects/foo');
    expect(redactLog('opened /home/alice/projects/foo', '/home/alice'))
      .toBe('opened ~/projects/foo');
    expect(redactLog('opened /data/data/com.youcoded.app/files/home/x', '/data/data/com.youcoded.app/files/home'))
      .toBe('opened ~/x');
  });

  it('redacts gh tokens (all four prefixes)', () => {
    expect(redactLog('token=ghp_abcdefghij1234567890XYZ', '/h')).toContain('[REDACTED-GH-TOKEN]');
    expect(redactLog('token=gho_abcdefghij1234567890XYZ', '/h')).toContain('[REDACTED-GH-TOKEN]');
    expect(redactLog('token=ghs_abcdefghij1234567890XYZ', '/h')).toContain('[REDACTED-GH-TOKEN]');
    expect(redactLog('token=ghu_abcdefghij1234567890XYZ', '/h')).toContain('[REDACTED-GH-TOKEN]');
  });

  it('redacts Anthropic keys', () => {
    expect(redactLog('Bearer sk-ant-api03-AbCdEf_-12345678901234567890', '/h'))
      .toContain('[REDACTED-ANTHROPIC-KEY]');
  });

  it('handles multiple secrets on one line', () => {
    const input = 'a=ghp_abcdefghij1234567890XYZ b=sk-ant-api03-XYZ12345678901234567890';
    const out = redactLog(input, '/h');
    expect(out).toContain('[REDACTED-GH-TOKEN]');
    expect(out).toContain('[REDACTED-ANTHROPIC-KEY]');
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain('sk-ant');
  });

  it('does not false-positive on a 20-char hex hash', () => {
    const input = 'commit 0123456789abcdef0123456789abcdef';
    expect(redactLog(input, '/h')).toBe(input);
  });

  it('is idempotent', () => {
    const first = redactLog('token=ghp_abcdefghij1234567890XYZ', '/h');
    expect(redactLog(first, '/h')).toBe(first);
  });
});
