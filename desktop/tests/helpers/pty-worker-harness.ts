// Loads the REAL pty-worker.js against a fake node-pty and a fake process, so
// a test exercises the shipped submit/chunking logic byte for byte without
// spawning anything real. Extracted from pty-worker-writes.test.ts (T7, doc
// comments build) so compose-ref.test.ts's PTY round-trip test can reuse it
// instead of re-deriving the same loader — test-suite-hygiene.md: "Shared
// setup lives in tests/helpers/".
//
// HOW: pty-worker.js is a plain CommonJS script with no exports — it just
// registers process listeners. Rather than importing it (which attaches
// listeners to the real process, and whose `require('node-pty')` escapes
// vi.mock and spawns a REAL shell), the real file is read and evaluated with a
// fake `require` and a fake `process`. Nothing is spawned, nothing global is
// touched, and the code under test is the shipped file byte for byte.
import { vi, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

const WORKER_SRC = fs
  .readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'pty-worker.js'), 'utf8')
  // The leading `#!/usr/bin/env node` is legal in a script and illegal inside
  // a Function body, so it is the one thing dropped from the real file.
  .replace(/^#![^\n]*\n/, '');

/** Load the real pty-worker with a fake node-pty, and spawn its PTY. */
export function loadWorker(subagentModel?: string) {
  const writes: string[] = [];
  let spawnedEnv: Record<string, string | undefined> = {};
  let onExit: ((result: { exitCode: number }) => void) | undefined;
  const fakePty = {
    pid: 1234,
    write: (d: string) => { writes.push(d); },
    resize: vi.fn(),
    kill: vi.fn(),
    onData: () => ({ dispose() { /* no data in these tests */ } }),
    onExit: (cb: (result: { exitCode: number }) => void) => { onExit = cb; },
  };
  const fakeProcess: any = new EventEmitter();
  Object.assign(fakeProcess, {
    env: { ...process.env, CLAUDE_CODE_SUBAGENT_MODEL: subagentModel },
    platform: process.platform,
    pid: 4242,
    hrtime: process.hrtime,
    send: vi.fn(),
    exit: vi.fn(),
  });
  const fakeRequire = (id: string) => {
    if (id === 'node-pty') return { spawn: (_shell: string, _args: string[], opts: { env: Record<string, string | undefined> }) => {
      spawnedEnv = opts.env;
      return fakePty;
    } };
    if (id === 'path') return path;
    if (id === 'fs') return fs;
    if (id === 'os') return os;
    throw new Error(`pty-worker asked for an unexpected module: ${id}`);
  };
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', 'process', '__dirname', '__filename', WORKER_SRC)(
    fakeRequire, module, module.exports, fakeProcess, __dirname, __filename,
  );

  const listeners = fakeProcess.listeners('message');
  expect(listeners).toHaveLength(1);
  const deliver = listeners[0] as (msg: any) => void;
  deliver({ type: 'spawn', command: '/bin/sh', args: [], cwd: '/tmp', cols: 120, rows: 30, sessionId: 'test-claude-session' });
  writes.length = 0;   // drop anything the spawn itself wrote
  return { deliver, writes, spawnedEnv, fakePty, fakeProcess, exitPty: () => onExit?.({ exitCode: 0 }) };
}

/** Let the worker's promise-based input queue, and its inter-chunk timers, run
 *  out. Real timers: the chunk gap is 30 ms and these strings are short. */
export const drain = (ms = 400) => new Promise((r) => setTimeout(r, ms));
