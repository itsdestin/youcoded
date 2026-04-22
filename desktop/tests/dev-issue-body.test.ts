// desktop/tests/dev-issue-body.test.ts
import { describe, it, expect } from 'vitest';
import { buildIssueBody, smartTruncateLog } from '../src/main/dev-tools';

describe('buildIssueBody', () => {
  it('builds a bug body with the log details block', () => {
    const out = buildIssueBody({
      kind: 'bug',
      summary: 'App crashes on startup.',
      description: 'I clicked the icon and nothing happened.',
      log: 'line A\nline B',
      version: '2.3.2',
      platform: 'desktop',
      os: 'win32 10.0',
    });
    expect(out).toContain('App crashes on startup.');
    expect(out).toContain('I clicked the icon and nothing happened.');
    expect(out).toContain('YouCoded v2.3.2 · desktop · win32 10.0');
    expect(out).toContain('<details><summary>desktop.log</summary>');
    expect(out).toContain('line A\nline B');
    expect(out).not.toContain('last N lines');
    expect(out).toContain('**Logs:**');
  });

  it('builds a feature body without the log block', () => {
    const out = buildIssueBody({
      kind: 'feature',
      summary: 'Add dark mode for the input bar.',
      description: 'Currently the input bar stays light even on dark themes.',
      log: 'should not appear',
      version: '2.3.2',
      platform: 'android',
      os: 'Android 14',
    });
    expect(out).toContain('Add dark mode for the input bar.');
    expect(out).not.toContain('<details>');
    expect(out).not.toContain('should not appear');
  });
});

describe('smartTruncateLog', () => {
  it('returns the input unchanged when under the line limit', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    expect(smartTruncateLog(lines, 50)).toBe(lines);
  });

  it('keeps the last N lines and prepends an omission marker', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const out = smartTruncateLog(lines, 50);
    const outLines = out.split('\n');
    expect(outLines[0]).toBe('… (150 earlier lines omitted)');
    expect(outLines.at(-1)).toBe('line 199');
    expect(outLines.length).toBe(51); // marker + 50 kept lines
  });
});
