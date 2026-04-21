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
  // spawn mock default: stub with no-op streams. Tests that exercise spawn
  // (summarizeIssue, installWorkspace) override with mockImplementationOnce.
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn() },
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

import { execFile, spawn } from 'child_process';
import { summarizeIssue } from '../src/main/dev-tools';

// Helper: build a fake spawned process for summarizeIssue tests.
// After stdin.end() fires, emits the configured stdout data and close event.
function makeFakeSpawn(opts: { stdoutData?: string; exitCode?: number; error?: Error }) {
  const handlers: Record<string, Array<(...args: any[]) => void>> = {};
  const stdout = { on: (event: string, cb: any) => { (handlers[`stdout:${event}`] ||= []).push(cb); } };
  const stderr = { on: (event: string, cb: any) => { (handlers[`stderr:${event}`] ||= []).push(cb); } };
  let stdinBuffer = '';
  const stdin = {
    write: (chunk: string) => { stdinBuffer += chunk; },
    end: () => {
      // After stdin closes, fire simulated stdout + close on next tick.
      setImmediate(() => {
        if (opts.error) {
          (handlers['proc:error'] || []).forEach((cb) => cb(opts.error));
          return;
        }
        if (opts.stdoutData) {
          (handlers['stdout:data'] || []).forEach((cb) => cb(Buffer.from(opts.stdoutData!)));
        }
        (handlers['proc:close'] || []).forEach((cb) => cb(opts.exitCode ?? 0));
      });
    },
    get capturedInput() { return stdinBuffer; },
  };
  const proc: any = {
    stdout, stderr, stdin,
    on: (event: string, cb: any) => { (handlers[`proc:${event}`] ||= []).push(cb); },
  };
  return proc;
}

describe('summarizeIssue', () => {
  it('parses the JSON envelope returned by claude -p', async () => {
    const json = JSON.stringify({
      title: 'App crashes on startup',
      summary: 'Clicking the icon does nothing.',
      flagged_strings: ['/Users/alice/secret-project'],
    });
    const fakeProc = makeFakeSpawn({ stdoutData: json });
    vi.mocked(spawn).mockImplementationOnce((..._args: any[]) => fakeProc);
    const out = await summarizeIssue({
      kind: 'bug',
      description: 'I clicked the icon and nothing happened.',
      log: 'line A',
    });
    expect(out.title).toBe('App crashes on startup');
    expect(out.summary).toContain('Clicking the icon');
    expect(out.flagged_strings).toEqual(['/Users/alice/secret-project']);
    // Verify the prompt was piped via stdin, not passed as a CLI arg.
    expect(fakeProc.stdin.capturedInput).toContain('I clicked the icon');
  });

  it('returns a fallback envelope when claude -p errors', async () => {
    vi.mocked(spawn).mockImplementationOnce((..._args: any[]) =>
      makeFakeSpawn({ error: new Error('not authenticated') }),
    );
    const out = await summarizeIssue({
      kind: 'bug',
      description: 'something',
    });
    expect(out.title).toBe('something'.slice(0, 80));
    expect(out.summary).toBe('something');
    expect(out.flagged_strings).toEqual([]);
  });

  it('omits the log block from the prompt when kind is feature', async () => {
    const fakeProc = makeFakeSpawn({
      stdoutData: JSON.stringify({ title: 't', summary: 's', flagged_strings: [] }),
    });
    vi.mocked(spawn).mockImplementationOnce((..._args: any[]) => fakeProc);
    await summarizeIssue({
      kind: 'feature',
      description: 'I want X',
      log: 'should not appear in prompt',
    });
    // Prompt should reference the description but never the log.
    expect(fakeProc.stdin.capturedInput).toContain('I want X');
    expect(fakeProc.stdin.capturedInput).not.toContain('should not appear in prompt');
  });
});

import { submitIssue } from '../src/main/dev-tools';

describe('submitIssue', () => {
  it('returns the issue URL when gh is authed and create succeeds', async () => {
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], _o: any, cb: any) => {
      // First call: gh auth status — exit 0
      if (args[0] === 'auth' && args[1] === 'status') {
        cb(null, 'Logged in', '');
      } else if (args[0] === 'issue' && args[1] === 'create') {
        cb(null, 'https://github.com/itsdestin/youcoded/issues/42\n', '');
      }
      return {} as any;
    }) as any);
    const out = await submitIssue({ title: 't', body: 'b', label: 'bug' });
    expect(out.ok).toBe(true);
    expect((out as any).url).toBe('https://github.com/itsdestin/youcoded/issues/42');
  });

  it('returns a fallback URL when gh auth status fails', async () => {
    vi.mocked(execFile).mockImplementation(((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'auth' && args[1] === 'status') {
        cb(new Error('not authenticated'), '', 'You are not logged in');
      }
      return {} as any;
    }) as any);
    const out = await submitIssue({ title: 't', body: 'b', label: 'bug' });
    expect(out.ok).toBe(false);
    expect((out as any).fallbackUrl).toContain('https://github.com/itsdestin/youcoded/issues/new');
    expect((out as any).fallbackUrl).toContain('labels=bug');
  });

  it('returns a fallback URL when gh issue create fails after auth check', async () => {
    vi.mocked(execFile).mockImplementation(((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'auth') cb(null, 'Logged in', '');
      else cb(new Error('rate limited'), '', '');
      return {} as any;
    }) as any);
    const out = await submitIssue({ title: 't', body: 'b', label: 'enhancement' });
    expect(out.ok).toBe(false);
    expect((out as any).fallbackUrl).toContain('labels=enhancement');
  });
});

import { installWorkspace, _resetInstallGuard } from '../src/main/dev-tools';
// Type-level import for the dev:open-session-in contract (Task 10).
import type { CreateSessionOpts } from '../src/main/session-manager';
import type { SessionInfo } from '../src/shared/types';

describe('CreateSessionOpts.initialInput (dev:open-session-in contract)', () => {
  it('accepts initialInput as an optional string — compile-time type check', () => {
    // This is a pure type test: if TypeScript compiles this file, the optional
    // field exists on the interface and the contract is satisfied.
    const opts: CreateSessionOpts = {
      name: 'Development',
      cwd: '/tmp',
      skipPermissions: false,
      initialInput: 'hello from dev panel',
    };
    expect(opts.initialInput).toBe('hello from dev panel');
  });

  it('allows initialInput to be omitted — field is truly optional', () => {
    const opts: CreateSessionOpts = {
      name: 'Development',
      cwd: '/tmp',
      skipPermissions: false,
    };
    expect(opts.initialInput).toBeUndefined();
  });

  it('SessionInfo accepts initialInput as an optional string', () => {
    // Verify the SessionInfo shape carries the field so the session-created
    // event (and the renderer) can pick it up.
    const info: SessionInfo = {
      id: 'abc',
      name: 'dev',
      cwd: '/tmp',
      permissionMode: 'normal',
      skipPermissions: false,
      status: 'active',
      createdAt: Date.now(),
      provider: 'claude',
      initialInput: 'some prefill',
    };
    expect(info.initialInput).toBe('some prefill');
  });
});

describe('installWorkspace concurrency', () => {
  beforeEach(() => _resetInstallGuard());

  it('rejects a second concurrent call', async () => {
    // First call: leave a long-running clone unresolved.
    vi.mocked(execFile).mockImplementation(((..._args: any[]) => {
      // Never call cb — simulates an in-flight install.
      return {} as any;
    }) as any);

    const first = installWorkspace(() => undefined);
    const second = installWorkspace(() => undefined);
    await expect(second).rejects.toThrow(/already in progress/i);
    // first stays pending; we don't await it
    void first;
  });
});
