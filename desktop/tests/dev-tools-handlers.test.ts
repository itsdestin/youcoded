import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import { readLogTail } from '../src/main/dev-tools';

// WHY: dev-tools.ts now imports app from electron to call app.getVersion() when
// building the issue body in the main process. Mock it so tests don't need a
// full Electron environment (Fix 2 — submitIssue restructure).
vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '2.3.2') },
}));

vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
  existsSync: vi.fn(),
  // Synchronous readFileSync used by openDevSessionIn in dev-tools.ts.
  readFileSync: vi.fn(),
}));
// Mock os so home-dir redaction and tmpdir resolve predictably in tests.
// WHY: submitIssue now calls os.platform() and os.release() to build the
// Environment line in the issue body — those must be included in the mock.
vi.mock('os', () => {
  const api = {
    homedir: vi.fn(() => '/home/alice'),
    tmpdir: vi.fn(() => '/tmp'),
    platform: vi.fn(() => 'linux'),
    release: vi.fn(() => '5.15.0'),
  };
  // `default` too: the github-client import chain (logger.ts) uses the
  // default-import form (`import os from 'os'`), not named imports.
  return { ...api, default: api };
});
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
import { setGithubClient } from '../src/main/github-client';

// Phase 3 (2026-07-22): submitIssue posts through the shared github-client
// (REST) instead of the gh CLI. Tests drive it by registering a FAKE client
// singleton — the browser-prefill fallback remains the no-credential path.
function fakeGithubClient(opts: {
  token?: string | null;
  issueStatus?: number;
  issueUrl?: string;
  apiThrows?: boolean;
}) {
  const apiCalls: Array<{ method: string; path: string; body: any }> = [];
  const client: any = {
    getToken: async () => (opts.token === null ? null : { token: opts.token ?? 'gho_x', source: 'app' }),
    api: async (method: string, path: string, body?: any) => {
      apiCalls.push({ method, path, body });
      if (opts.apiThrows) throw new Error('boom');
      return {
        status: opts.issueStatus ?? 201,
        json: { html_url: opts.issueUrl ?? 'https://github.com/itsdestin/youcoded/issues/42' },
      };
    },
  };
  return { client, apiCalls };
}

// Minimal SubmitArgs using the new raw-fields contract (body is now built in
// the main process by buildIssueBody using app.getVersion() + os info).
const SUBMIT_BUG: import('../src/main/dev-tools').SubmitArgs = {
  kind: 'bug',
  title: 't',
  summary: 'summary text',
  description: 'description text',
  log: 'some log line',
  label: 'bug',
};
const SUBMIT_FEATURE: import('../src/main/dev-tools').SubmitArgs = {
  kind: 'feature',
  title: 't',
  summary: 'summary text',
  description: 'description text',
  label: 'enhancement',
};

describe('submitIssue', () => {
  it('returns the issue URL when a GitHub token exists and the REST create succeeds', async () => {
    const { client, apiCalls } = fakeGithubClient({});
    setGithubClient(client);
    const out = await submitIssue(SUBMIT_BUG);
    expect(out.ok).toBe(true);
    expect((out as any).url).toBe('https://github.com/itsdestin/youcoded/issues/42');
    // One REST POST to the issues endpoint, labels intact (the labels must
    // exist on itsdestin/youcoded — ipc-bridge rule).
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0].method).toBe('POST');
    expect(apiCalls[0].path).toBe('/repos/itsdestin/youcoded/issues');
    expect(apiCalls[0].body.labels).toEqual(['bug', 'youcoded-app:reported']);
  });

  it('returns a fallback URL when no GitHub credential exists anywhere', async () => {
    const { client } = fakeGithubClient({ token: null });
    setGithubClient(client);
    const out = await submitIssue(SUBMIT_BUG);
    expect(out.ok).toBe(false);
    expect((out as any).fallbackUrl).toContain('https://github.com/itsdestin/youcoded/issues/new');
    expect((out as any).fallbackUrl).toContain('labels=bug');
  });

  it('returns a fallback URL when no client singleton is registered at all', async () => {
    setGithubClient(null);
    const out = await submitIssue(SUBMIT_BUG);
    expect(out.ok).toBe(false);
    expect((out as any).fallbackUrl).toContain('labels=bug');
  });

  it('returns a fallback URL when the REST create fails', async () => {
    const { client } = fakeGithubClient({ apiThrows: true });
    setGithubClient(client);
    const out = await submitIssue(SUBMIT_FEATURE);
    expect(out.ok).toBe(false);
    expect((out as any).fallbackUrl).toContain('labels=enhancement');
  });

  it('builds the issue body in main using buildIssueBody (not navigator.userAgent)', async () => {
    const { client, apiCalls } = fakeGithubClient({});
    setGithubClient(client);
    await submitIssue(SUBMIT_BUG);
    // Body must contain the canonical "YouCoded vX.Y.Z · desktop · ..." format.
    const writtenBody = String(apiCalls[0].body.body);
    expect(writtenBody).toContain('**Environment:** YouCoded v');
    expect(writtenBody).toContain('desktop');
    // Must NOT contain the raw navigator.userAgent substring that the old renderer
    // build-body helper would have included.
    expect(writtenBody).not.toContain('navigator');
  });

  // The singleton outlives this describe — clear it so later suites (and other
  // files sharing the worker) never see a stale fake client.
  afterEach(() => setGithubClient(null));
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

import { openDevSessionIn } from '../src/main/dev-tools';

describe('openDevSessionIn — runtime handler logic', () => {
  const FAKE_INFO: SessionInfo = {
    id: 'session-xyz',
    name: 'Development',
    cwd: '/workspace/myproject',
    permissionMode: 'normal',
    skipPermissions: false,
    status: 'active',
    createdAt: 0,
    provider: 'claude',
  };

  function makeSessionManager(returnValue: SessionInfo = FAKE_INFO) {
    return { createSession: vi.fn(() => returnValue) };
  }

  it('passes args.cwd through to createSession', async () => {
    const fs = await import('fs');
    // Simulate missing defaults file so the catch path fires.
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const sm = makeSessionManager();
    openDevSessionIn(
      { cwd: '/workspace/myproject' },
      { defaultsPrefPath: '/home/alice/.claude/youcoded-defaults.json', sessionManager: sm, homedir: () => '/home/alice' },
    );
    expect(sm.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/workspace/myproject' }),
    );
  });

  it('passes args.initialInput through to createSession', async () => {
    const fs = await import('fs');
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const sm = makeSessionManager();
    openDevSessionIn(
      { cwd: '/workspace/myproject', initialInput: 'hello world' },
      { defaultsPrefPath: '/home/alice/.claude/youcoded-defaults.json', sessionManager: sm, homedir: () => '/home/alice' },
    );
    expect(sm.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ initialInput: 'hello world' }),
    );
  });

  it('falls back to skipPermissions:false and model "sonnet" when defaults file is absent', async () => {
    const fs = await import('fs');
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const sm = makeSessionManager();
    openDevSessionIn(
      { cwd: '/workspace/myproject' },
      { defaultsPrefPath: '/home/alice/.claude/youcoded-defaults.json', sessionManager: sm, homedir: () => '/home/alice' },
    );
    expect(sm.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ skipPermissions: false, model: 'sonnet' }),
    );
  });

  it('reads skipPermissions and model from the defaults file when present', async () => {
    const fs = await import('fs');
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ skipPermissions: true, model: 'opus' }) as any,
    );
    const sm = makeSessionManager();
    openDevSessionIn(
      { cwd: '/some/dir' },
      { defaultsPrefPath: '/home/alice/.claude/youcoded-defaults.json', sessionManager: sm, homedir: () => '/home/alice' },
    );
    expect(sm.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ skipPermissions: true, model: 'opus' }),
    );
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
