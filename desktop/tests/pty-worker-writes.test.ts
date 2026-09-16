// How pty-worker actually writes to the PTY (2026-09-05).
//
// This exists because a fix aimed at ONE write changed every write. The shell
// session's initial command carries no trailing `\r` (the user presses Enter),
// so it takes the passthrough path — and chunking that path to protect the
// command turned an ordinary 10 KB terminal paste into 179 writes 30 ms apart,
// ~5.4 s with the input queue blocked behind it. A source-text pin would not
// have caught that: the cost is in the NUMBER of writes, so the number of
// writes is what this file counts.
//
// HOW: pty-worker.js is a plain CommonJS script with no exports — it just
// registers process listeners. Rather than importing it (which attaches
// listeners to the real process, and whose `require('node-pty')` escapes
// vi.mock and spawns a REAL shell), the real file is read and evaluated with a
// fake `require` and a fake `process`. Nothing is spawned, nothing global is
// touched, and the code under test is the shipped file byte for byte.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

// The leading `#!/usr/bin/env node` is legal in a script and illegal inside a
// Function body, so it is the one thing dropped from the real file.
const WORKER_SRC = fs
  .readFileSync(path.join(__dirname, '..', 'src', 'main', 'pty-worker.js'), 'utf8')
  .replace(/^#![^\n]*\n/, '');

/** Load the real pty-worker with a fake node-pty, and spawn its PTY. */
function loadWorker(subagentModel?: string) {
  const writes: string[] = [];
  let spawnedEnv: Record<string, string | undefined> = {};
  const fakePty = {
    pid: 1234,
    write: (d: string) => { writes.push(d); },
    resize: vi.fn(),
    kill: vi.fn(),
    onData: () => ({ dispose() { /* no data in these tests */ } }),
    onExit: () => undefined,
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
  return { deliver, writes, spawnedEnv };
}

/** Let the worker's promise-based input queue, and its inter-chunk timers, run
 *  out. Real timers: the chunk gap is 30 ms and these strings are short. */
const drain = (ms = 400) => new Promise((r) => setTimeout(r, ms));

describe('Claude Code specialist model launch default', () => {
  it('defaults subagents to Sonnet instead of inheriting an expensive conversation model', () => {
    expect(loadWorker().spawnedEnv.CLAUDE_CODE_SUBAGENT_MODEL).toBe('sonnet');
  });

  it('preserves an explicit subagent model from the launch environment', () => {
    expect(loadWorker('sonnet').spawnedEnv.CLAUDE_CODE_SUBAGENT_MODEL).toBe('sonnet');
  });
});

describe('pty-worker writes', () => {
  let deliver: (msg: any) => void;
  let writes: string[];

  beforeEach(() => { ({ deliver, writes } = loadWorker()); });

  it('a 10 KB paste is ONE write, as it always was', async () => {
    // A terminal paste ends in the bracketed-paste terminator, not \r, so it
    // takes the passthrough. Chunking it there was the regression: 179 writes,
    // 30 ms apart, with everything else queued behind them.
    const paste = '\x1b[200~' + 'x'.repeat(10_000) + '\x1b[201~';
    deliver({ type: 'input', data: paste });
    await drain();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(paste);
  });

  it('a keystroke is still one write', async () => {
    deliver({ type: 'input', data: 'a' });
    await drain(50);
    expect(writes).toEqual(['a']);
  });

  it('an arrow key escape is not split', async () => {
    deliver({ type: 'input', data: '\x1b[A' });
    await drain(50);
    expect(writes).toEqual(['\x1b[A']);
  });

  it('a short submit is still one atomic write', async () => {
    deliver({ type: 'input', data: 'hello\r' });
    await drain(50);
    expect(writes).toEqual(['hello\r']);
  });

  // 2026-09-16 (claude-code-integration.md): the thresholds are BYTES on the pipe,
  // and the checks counted UTF-16 units. 30 CJK characters is 90 bytes — over the
  // 64-byte paste threshold — so the atomic path would have turned its Enter into
  // a literal newline. It must take the echo-driven path: the body goes first
  // (chunked under 56 bytes apiece), and the `\r` waits for the echo.
  it('a short-looking non-ASCII submit that is over 56 BYTES is not written atomically', async () => {
    const body = '你好世界'.repeat(8);        // 32 chars, 96 bytes
    deliver({ type: 'input', data: body + '\r' });
    await drain(300);
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.join('')).toBe(body);      // the \r is held for the echo, which never comes here
    for (const w of writes) expect(Buffer.byteLength(w, 'utf8')).toBeLessThanOrEqual(56);
  });

  it('a submit that is short in BYTES stays atomic even with non-ASCII in it', async () => {
    const text = 'héllo wörld\r';          // 14 bytes
    deliver({ type: 'input', data: text });
    await drain(50);
    expect(writes).toEqual([text]);
  });

  describe('the chunked channel, which only a shell session\'s initial command uses', () => {
    it('splits a long command so ConPTY cannot truncate it', async () => {
      const command = 'sudo install '.repeat(40);   // ~520 chars
      deliver({ type: 'input-chunked', data: command });
      await drain(1200);
      expect(writes.length).toBeGreaterThan(1);
      expect(writes.join('')).toBe(command);
      for (const w of writes) expect(w.length).toBeLessThanOrEqual(56);
    });

    it('a short command is still a single write', async () => {
      deliver({ type: 'input-chunked', data: 'sudo pacman -S rocm' });
      await drain(50);
      expect(writes).toEqual(['sudo pacman -S rocm']);
    });

    it('never splits a surrogate pair', async () => {
      // slice() cuts UTF-16 code units. A boundary inside an emoji or a non-BMP
      // path character would send two broken halves, and the shell would show
      // garbage in the command the user is about to press Enter on.
      const command = 'x'.repeat(55) + '\u{1F600}'.repeat(30);
      deliver({ type: 'input-chunked', data: command });
      await drain(1200);
      expect(writes.join('')).toBe(command);
      for (const w of writes) {
        const last = w.charCodeAt(w.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);   // no trailing lone high half
        const first = w.charCodeAt(0);
        expect(first >= 0xdc00 && first <= 0xdfff).toBe(false); // no leading lone low half
      }
    });
  });
});
