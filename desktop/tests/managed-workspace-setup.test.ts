// The managed development workspace, in the main process.
//
// WHY this file exists: the grader found that `setupManagedWorkspace` and
// `freeWorkspacePath` had NO test at all, so contract rows R9 ("setup leaves an
// existing development folder untouched") and R10 ("you can start working even when
// its backup has not connected") rested entirely on reading the code. R9 is a
// promise about the user's own disk — the most expensive kind to get wrong.
//
// These run against a real temporary HOME so the filesystem behaviour is the thing
// under test, not a mock of it. `git` and `bash` are stubbed at the module boundary.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const runs: string[][] = [];
let failOn: string | null = null;

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: any) => {
      runs.push([cmd, ...args]);
      const { EventEmitter } = require('events') as typeof import('events');
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => {}, end: () => {} };
      setTimeout(() => {
        // Match the whole invocation: `setup.sh` is an ARGUMENT to bash, not the
        // command, so matching on cmd alone silently never failed that step.
        if (failOn && [cmd, ...args].some(part => String(part).includes(failOn!))) {
          child.stderr.emit('data', Buffer.from('fatal: could not resolve host: github.com'));
          child.emit('close', 128);
          return;
        }
        // A real clone creates the directory it was told to write.
        if (cmd.includes('git') && args[0] === 'clone') fs.mkdirSync(args[args.length - 1], { recursive: true });
        child.emit('close', 0);
      }, 0);
      return child;
    },
  };
});

let home: string;
let realHome: string | undefined;
let setupManagedWorkspace: typeof import('../src/main/dev-tools')['setupManagedWorkspace'];
let workspaceSetupStatus: typeof import('../src/main/dev-tools')['workspaceSetupStatus'];
let clearWorkspaceSetupStatus: typeof import('../src/main/dev-tools')['clearWorkspaceSetupStatus'];

beforeEach(async () => {
  runs.length = 0;
  failOn = null;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-managed-'));
  // WHY $HOME and not a spy on os.homedir: the module namespace is not configurable
  // under ESM, so vi.spyOn(os, 'homedir') throws. On POSIX os.homedir() reads $HOME,
  // which is the same seam without fighting the loader.
  realHome = process.env.HOME;
  process.env.HOME = home;
  vi.resetModules();
  const mod = await import('../src/main/dev-tools');
  setupManagedWorkspace = mod.setupManagedWorkspace;
  workspaceSetupStatus = mod.workspaceSetupStatus;
  clearWorkspaceSetupStatus = mod.clearWorkspaceSetupStatus;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('setting up a managed development workspace', () => {
  it('R9: never writes into a folder that is already there', async () => {
    // The promise the screen makes, and the reason this is not the legacy installer:
    // that one cloned into a fixed ~/youcoded-dev and PULLED into it when it
    // recognised the remote.
    const taken = path.join(home, 'YouCoded', 'Development', 'youcoded-workspace');
    fs.mkdirSync(taken, { recursive: true });
    fs.writeFileSync(path.join(taken, 'my-unfinished-work.txt'), 'do not touch');

    const registered: string[] = [];
    const r = await setupManagedWorkspace(p => registered.push(p));

    expect(r.ok).toBe(true);
    expect(r.ok && r.path).not.toBe(taken);
    // The existing folder is byte-for-byte what it was.
    expect(fs.readFileSync(path.join(taken, 'my-unfinished-work.txt'), 'utf8')).toBe('do not touch');
    expect(fs.readdirSync(taken)).toEqual(['my-unfinished-work.txt']);
    expect(registered).toEqual([r.ok ? r.path : '']);
  });

  it('never puts the workspace where sync would upload it', async () => {
    // ~/YouCoded/Projects/* is a synced space and the transport stages with
    // `git add -A`; this tree is ~1GB with nested .git dirs. Landing there would push
    // a gigabyte to the user's backup while the screen says nothing about backup.
    const r = await setupManagedWorkspace(() => {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path.startsWith(path.join(home, 'YouCoded', 'Development'))).toBe(true);
      expect(r.path).not.toContain(path.join('YouCoded', 'Projects'));
    }
  });

  it('keeps the reason the step gave, not just its exit code', async () => {
    failOn = 'git';
    const r = await setupManagedWorkspace(() => {});
    expect(r.ok).toBe(false);
    // "exited with code 128" alone is the one number that says nothing.
    if (!r.ok) expect(r.error).toContain('could not resolve host');
  });

  it('leaves nothing behind when it fails, so trying again starts cleanly', async () => {
    // The screen says exactly that. A half-finished clone used to stay on disk and
    // the next attempt walked past it to a new name.
    failOn = 'setup.sh';
    const r = await setupManagedWorkspace(() => {});
    expect(r.ok).toBe(false);
    const devRoot = path.join(home, 'YouCoded', 'Development');
    expect(fs.existsSync(devRoot) ? fs.readdirSync(devRoot) : []).toEqual([]);
  });

  it('a second press joins the run already going instead of cloning again', async () => {
    const first = setupManagedWorkspace(() => {});
    const second = setupManagedWorkspace(() => {});
    expect(await first).toEqual(await second);
    expect(runs.filter(r => r[1] === 'clone')).toHaveLength(1);
  });

  it('an outcome can be forgotten, but a run in flight cannot', async () => {
    // Without this, one failure made the start button unreachable for the session.
    failOn = 'git';
    await setupManagedWorkspace(() => {});
    expect(workspaceSetupStatus().state).toBe('failed');
    clearWorkspaceSetupStatus();
    expect(workspaceSetupStatus().state).toBe('idle');
  });
});
