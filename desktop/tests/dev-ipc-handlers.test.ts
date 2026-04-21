import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import { readLogTail } from '../src/main/dev-tools';

vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
  existsSync: vi.fn(),
}));
// Mock os so home-dir redaction and tmpdir resolve predictably in tests.
vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/alice'),
  tmpdir: vi.fn(() => '/tmp'),
}));
vi.mock('child_process', () => ({
  execFile: vi.fn(),
  // spawn mock returns an EventEmitter-like object with stdout/stderr stubs.
  // Individual tests override execFile; spawn is only used by installWorkspace.
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
  })),
}));

describe('readLogTail', () => {
  it('returns empty string when log file is missing', async () => {
    const fs = await import('fs');
    vi.mocked(fs.promises.readFile).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    expect(await readLogTail(200)).toBe('');
  });

  it('redacts home dir and tokens before returning', async () => {
    const fs = await import('fs');
    const raw =
      'opened /home/alice/projects/foo\n' +
      'token=ghp_abcdefghij1234567890XYZ\n';
    vi.mocked(fs.promises.readFile).mockResolvedValue(raw as any);
    const out = await readLogTail(200);
    expect(out).toContain('~/projects/foo');
    expect(out).toContain('[REDACTED-GH-TOKEN]');
    expect(out).not.toContain('ghp_');
  });

  it('returns only the last N lines', async () => {
    const fs = await import('fs');
    const raw = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    vi.mocked(fs.promises.readFile).mockResolvedValue(raw as any);
    const out = await readLogTail(50);
    const lines = out.split('\n');
    expect(lines.length).toBe(50);
    expect(lines.at(-1)).toBe('line 499');
  });
});

import { execFile } from 'child_process';
import { summarizeIssue } from '../src/main/dev-tools';

describe('summarizeIssue', () => {
  it('parses the JSON envelope returned by claude -p', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], _opts: any, cb: any) => {
      const json = JSON.stringify({
        title: 'App crashes on startup',
        summary: 'Clicking the icon does nothing.',
        flagged_strings: ['/Users/alice/secret-project'],
      });
      cb(null, json, '');
      return {} as any;
    }) as any);
    const out = await summarizeIssue({
      kind: 'bug',
      description: 'I clicked the icon and nothing happened.',
      log: 'line A',
    });
    expect(out.title).toBe('App crashes on startup');
    expect(out.summary).toContain('Clicking the icon');
    expect(out.flagged_strings).toEqual(['/Users/alice/secret-project']);
  });

  it('returns a fallback envelope when claude -p errors', async () => {
    vi.mocked(execFile).mockImplementation(((_c: string, _a: string[], _o: any, cb: any) => {
      cb(new Error('not authenticated'), '', '');
      return {} as any;
    }) as any);
    const out = await summarizeIssue({
      kind: 'bug',
      description: 'something',
    });
    expect(out.title).toBe('something'.slice(0, 80));
    expect(out.summary).toBe('something');
    expect(out.flagged_strings).toEqual([]);
  });

  it('omits the log block from the prompt when kind is feature', async () => {
    let capturedArgs: string[] = [];
    vi.mocked(execFile).mockImplementation(((_c: string, args: string[], _o: any, cb: any) => {
      capturedArgs = args;
      cb(null, JSON.stringify({ title: 't', summary: 's', flagged_strings: [] }), '');
      return {} as any;
    }) as any);
    await summarizeIssue({
      kind: 'feature',
      description: 'I want X',
      log: 'should not appear in prompt',
    });
    const promptArg = capturedArgs.find((a) => a.includes('I want X'));
    expect(promptArg).toBeDefined();
    expect(promptArg).not.toContain('should not appear in prompt');
  });
});
