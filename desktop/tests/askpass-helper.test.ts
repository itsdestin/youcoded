import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { spawn, type ChildProcess } from 'child_process';

// Exercises the REAL youcoded-askpass wrapper + askpass.cjs against a real unix-socket server, under the real
// Electron binary in ELECTRON_RUN_AS_NODE mode (exactly what the wrapper sets in production; askpass.cjs
// require()s koffi relative to its own location). Nothing in the helper is mocked.
const WRAPPER_PATH = path.join(__dirname, '..', 'scripts', 'askpass', 'youcoded-askpass');
const ASKPASS_CJS_PATH = path.join(__dirname, '..', 'scripts', 'askpass', 'askpass.cjs');
const ELECTRON_PATH = require('electron') as unknown as string;

// WHY these skips: the admin-password feature only starts on Linux. The suites below drive a REAL Unix-socket
// server and the /bin/sh wrapper; on Windows the listen is refused (the helper waits out its 30 s timeout), and
// on macOS the peer-pid self-test and the injected __CF_USER_TEXT_ENCODING make them fail for unreachable reasons.
const NOT_LINUX = process.platform !== 'linux';
const IS_WINDOWS = process.platform === 'win32';

interface HelperResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

/** Spawn the real wrapper (or a relocated copy) with a given extra env and socket path. */
function spawnHelper(
  socketPath: string,
  extraEnv: NodeJS.ProcessEnv = {},
  wrapperPath: string = WRAPPER_PATH,
): { child: ChildProcess; done: Promise<HelperResult> } {
  const child = spawn(wrapperPath, [], {
    // process.env is spread only so the wrapper's `dirname`/`cd`/`/usr/bin/env` can run; the wrapper's own
    // `env -i` is what matters for production.
    env: { ...process.env, ...extraEnv, YOUCODED_ASKPASS_SOCKET: socketPath, YOUCODED_ASKPASS_RUNTIME: ELECTRON_PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = new Promise<HelperResult>((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    child.stdout!.on('data', (d: Buffer) => { stdout = Buffer.concat([stdout, d]); });
    child.stderr!.on('data', (d: Buffer) => { stderr = Buffer.concat([stderr, d]); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway unix socket directory + path, removed after the test. */
function makeSocketDir(): { dir: string; socketPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-askpass-test-'));
  cleanupDirs.push(dir);
  return { dir, socketPath: path.join(dir, 'askpass.sock') };
}

/** A scratch `<root>/scripts/askpass/` holding a BYTE-FOR-BYTE copy of the shipped wrapper, so a test can swap
 *  in a stub for askpass.cjs without touching the real files other tests run concurrently. The wrapper resolves
 *  its directory from `$0`, so relocating it exercises its real logic unmodified. */
function makeScratchScriptsAskpassDir(): { root: string; wrapperCopy: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-askpass-scratch-'));
  cleanupDirs.push(root);
  const scriptsAskpassDir = path.join(root, 'scripts', 'askpass');
  fs.mkdirSync(scriptsAskpassDir, { recursive: true });
  const wrapperCopy = path.join(scriptsAskpassDir, 'youcoded-askpass');
  fs.copyFileSync(WRAPPER_PATH, wrapperCopy);
  fs.chmodSync(wrapperCopy, 0o755);
  return { root, wrapperCopy };
}

/**
 * A minimal fake AskpassServer speaking protocol v2: the app verifies the helper from OUTSIDE while it is still
 * readable, THEN tells it to harden, THEN sends the password. Drives the harden round trip itself ({"v":2} ->
 * {"harden":true} -> {"hardened":true}) and only then calls `onReady`, so a test body only decides the FINAL
 * reply. By then the helper has hardened (it writes {"hardened":true} only after hardenSelf() succeeded), so
 * /proc checks made inside `onReady` run at the right moment with no sleep.
 */
function startFakeServer(
  socketPath: string,
  onReady: (conn: net.Socket, handshakeLine: string) => void,
): net.Server {
  const server = net.createServer((conn) => {
    let buf = Buffer.alloc(0);
    let stage: 'awaiting-v' | 'awaiting-hardened' = 'awaiting-v';
    let handshakeLine = '';
    conn.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) return;
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 1);
        if (stage === 'awaiting-v') {
          handshakeLine = line;
          conn.write('{"harden":true}\n');
          stage = 'awaiting-hardened';
        } else {
          onReady(conn, handshakeLine);
          return;
        }
      }
    });
  });
  server.listen(socketPath);
  return server;
}

/** Run the real helper against `server` (already listening on `socketPath`) and return its result. */
async function runAgainst(server: net.Server, socketPath: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<HelperResult> {
  const { done } = spawnHelper(socketPath, extraEnv);
  const result = await done;
  server.close();
  return result;
}

/** Run the helper against a fake server whose final reply is chosen by `reply`. */
async function runWithReply(reply: (conn: net.Socket, handshakeLine: string) => void, extraEnv?: NodeJS.ProcessEnv) {
  const { socketPath } = makeSocketDir();
  return runAgainst(startFakeServer(socketPath, reply), socketPath, extraEnv);
}

const sentinelReply = (password: string) => (conn: net.Socket) => { conn.write(JSON.stringify({ ok: true, password }) + '\n'); };

describe.skipIf(IS_WINDOWS)('askpass helper: delivers the password on {ok:true}', () => {
  it('prints exactly the password, nothing else, and exits 0', async () => {
    const SENTINEL = 'sentinel-pw-6f3a9c';
    let handshakeLine = '';
    const result = await runWithReply((conn, line) => { handshakeLine = line; sentinelReply(SENTINEL)(conn); });
    // The first outbound message is the bare v2 handshake: no pid, no argv, nothing a spoofing peer could reuse.
    expect(handshakeLine).toBe('{"v":2}');
    expect(result.code).toBe(0);
    expect(result.stdout.toString('utf8')).toBe(SENTINEL + '\n');
    expect(result.stderr.toString('utf8')).toBe('');
  });
});

describe.skipIf(IS_WINDOWS)('askpass helper: refuses silently on anything else', () => {
  it.each([
    ['{ok:false}', (conn: net.Socket) => { conn.write(JSON.stringify({ ok: false }) + '\n'); }],
    ['a garbage (non-JSON) reply', (conn: net.Socket) => { conn.write('this is not json at all\n'); }],
    ['the socket closing with no reply', (conn: net.Socket) => { conn.end(); }],
  ])('prints nothing and exits 1 on %s', async (_label, reply) => {
    const result = await runWithReply(reply);
    expect(result.code).toBe(1);
    expect(result.stdout.length).toBe(0);
  });
});

describe.skipIf(IS_WINDOWS)('askpass helper: env -i blocks a caller-set loader hijack', () => {
  it('does not run a NODE_OPTIONS --require hook set by the spawning command', async () => {
    const { dir, socketPath } = makeSocketDir();
    const markerPath = path.join(dir, 'hijack-ran.marker');
    const hookPath = path.join(dir, 'hook.js');
    // If `env -i` failed to scrub NODE_OPTIONS this file would run inside the helper BEFORE the password is
    // read and leave evidence on disk (the NODE_OPTIONS='--require=evil.js' attack). Set it on the spawning
    // process, as the model's Bash command setting it ahead of `sudo` would.
    fs.writeFileSync(hookPath, `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran');`);
    const SENTINEL = 'sentinel-pw-env-i';
    const result = await runAgainst(startFakeServer(socketPath, sentinelReply(SENTINEL)), socketPath, { NODE_OPTIONS: `--require=${hookPath}` });
    expect(fs.existsSync(markerPath)).toBe(false);
    // Scrubbing NODE_OPTIONS must not also break the real runtime.
    expect(result.code).toBe(0);
    expect(result.stdout.toString('utf8')).toBe(SENTINEL + '\n');
  });
});

describe('askpass helper: makes itself non-dumpable before the password can arrive', () => {
  // PR_SET_DUMPABLE=0 closes same-uid ptrace/core-dump access while the helper holds the password. The same
  // ptrace_may_access() check gates opening /proc/<pid>/mem, so "can a same-uid process open it" is a direct
  // observable proxy for "is it dumpable". `onReady` fires after the helper's {"hardened":true}, i.e. hardened
  // but not yet holding the password; that ordering is the real signal, so no sleep.
  it.skipIf(process.platform !== 'linux')(
    '/proc/<helper-pid>/mem is not openable from this (same-uid) test process while the helper is alive',
    async () => {
      const { socketPath } = makeSocketDir();
      let memCheckResult: { openable: boolean; code: string | null } | null = null;
      const server = startFakeServer(socketPath, (conn) => {
        try {
          fs.closeSync(fs.openSync(`/proc/${child.pid}/mem`, 'r'));
          memCheckResult = { openable: true, code: null };
        } catch (err) {
          memCheckResult = { openable: false, code: (err as NodeJS.ErrnoException).code ?? null };
        }
        sentinelReply('sentinel-pw-dumpable')(conn);
      });
      const { child, done } = spawnHelper(socketPath);
      const result = await done;
      server.close();

      expect(memCheckResult).not.toBeNull();
      expect(memCheckResult!.openable).toBe(false);
      expect(memCheckResult!.code).toBe('EACCES');
      expect(result.code).toBe(0);   // the reply still reached a working helper
      expect(result.stdout.toString('utf8')).toBe('sentinel-pw-dumpable\n');
    },
  );

  // Control: an ordinary same-uid child's /proc/<pid>/mem IS openable, so the EACCES above comes from
  // askpass.cjs's own prctl() and not from some unrelated /proc sandboxing. Waits on the child's first stdout
  // write (proof it is running) rather than a sleep.
  it.skipIf(process.platform !== 'linux')(
    'control: /proc/<pid>/mem of an ordinary (dumpable) same-uid child IS openable',
    async () => {
      const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n'); setTimeout(() => {}, 5000);"], { stdio: ['ignore', 'pipe', 'ignore'] });
      try {
        await new Promise<void>((resolve) => { child.stdout!.once('data', () => resolve()); });
        fs.closeSync(fs.openSync(`/proc/${child.pid}/mem`, 'r'));
      } finally {
        child.kill();
      }
    },
  );
});

describe.skipIf(NOT_LINUX)('askpass wrapper: resulting environment is EXACTLY the two-variable allowlist', () => {
  // The helper's env must be exactly {ELECTRON_RUN_AS_NODE, YOUCODED_ASKPASS_SOCKET}. Reading the real helper's
  // /proc/<pid>/environ races its hardening (it is gated like /proc/<pid>/mem), so instead run a byte-for-byte
  // copy of the real wrapper with a stub standing in for askpass.cjs that just reports its own process.env.
  it('no other ambient variable (LD_PRELOAD, SSH_AUTH_SOCK, AWS-shaped, HOME, TERM, ...) survives into the child process env', async () => {
    const { root, wrapperCopy } = makeScratchScriptsAskpassDir();
    fs.writeFileSync(path.join(root, 'scripts', 'askpass', 'askpass.cjs'), "process.stdout.write(JSON.stringify(process.env));\n");

    const child = spawn(wrapperCopy, [], {
      env: {
        ...process.env,
        // Ambient variables a Bash command could carry, none in the allowlist (incl. a loader-hook-shaped one
        // other than NODE_OPTIONS, which the env -i test covers).
        LD_PRELOAD: '/tmp/youcoded-test-does-not-exist.so',
        SSH_AUTH_SOCK: '/tmp/youcoded-test-fake-agent.sock',
        AWS_ACCESS_KEY_ID: 'AKIA-YOUCODED-TEST-FAKE',
        TERM: 'xterm-256color',
        YOUCODED_ASKPASS_SOCKET: '/tmp/youcoded-test-unused.sock',
        YOUCODED_ASKPASS_RUNTIME: ELECTRON_PATH,
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const stdout = await new Promise<string>((resolve) => {
      let out = '';
      child.stdout!.on('data', (d: Buffer) => { out += d.toString('utf8'); });
      child.on('close', () => resolve(out));
    });

    const env = JSON.parse(stdout) as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(['ELECTRON_RUN_AS_NODE', 'YOUCODED_ASKPASS_SOCKET'].sort());
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(env.YOUCODED_ASKPASS_SOCKET).toBe('/tmp/youcoded-test-unused.sock');
  });
});

describe.skipIf(IS_WINDOWS)('askpass helper: the password only arrives after hardening — never before', () => {
  // The helper's own state machine must never accept a password sent before it was told to harden, and must
  // produce nothing if it is never told to harden at all.
  it.each([
    // Replies to the bare {"v":2} handshake with the password directly, skipping {"harden":true} (a buggy or hostile server).
    ['a server that sends the password without a harden step first', (conn: net.Socket) => { conn.on('data', () => { conn.write(JSON.stringify({ ok: true, password: 'should-never-print' }) + '\n'); }); }],
    // Closes right after the handshake, so the helper can never have written {"hardened":true}.
    ['a server that never sends {"harden":true} at all (closes instead)', (conn: net.Socket) => { conn.on('data', () => conn.end()); }],
  ])('%s: helper exits 1, prints nothing', async (_label, onConn) => {
    const { socketPath } = makeSocketDir();
    const server = net.createServer(onConn);
    server.listen(socketPath);
    const result = await runAgainst(server, socketPath);
    expect(result.code).toBe(1);
    expect(result.stdout.length).toBe(0);
  });
});

describe.skipIf(NOT_LINUX)('askpass wrapper: ulimit -c 0 actually zeroes the core-dump limit', () => {
  // `ulimit -c 0` in the wrapper must override an inherited `ulimit -c unlimited` (rlimits survive exec, so
  // `sh -c 'ulimit -c unlimited; exec "$0"'` reproduces it). /proc/<pid>/limits is not dumpable-gated, so it is
  // read inside `onReady`, an already-synchronized point.
  it('resulting process has "Max core file size" 0/0 even though the spawning shell set it unlimited', async () => {
    const { socketPath } = makeSocketDir();
    let limitsLine: string | undefined;
    const server = startFakeServer(socketPath, (conn) => {
      limitsLine = fs.readFileSync(`/proc/${child.pid}/limits`, 'utf8').split('\n').find((l) => l.includes('core file'));
      sentinelReply('sentinel-pw-ulimit')(conn);
    });

    const child = spawn('sh', ['-c', 'ulimit -c unlimited; exec "$0"', WRAPPER_PATH], {
      env: { ...process.env, YOUCODED_ASKPASS_SOCKET: socketPath, YOUCODED_ASKPASS_RUNTIME: ELECTRON_PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await new Promise<HelperResult>((resolve) => {
      let stdout = Buffer.alloc(0);
      child.stdout!.on('data', (d: Buffer) => { stdout = Buffer.concat([stdout, d]); });
      child.on('close', (code) => resolve({ code, stdout, stderr: Buffer.alloc(0) }));
    });
    server.close();

    expect(limitsLine).toBeDefined();
    expect(limitsLine).toMatch(/Max core file size\s+0\s+0\s/);
    expect(result.code).toBe(0);   // the wrapper still worked normally
    expect(result.stdout.toString('utf8')).toBe('sentinel-pw-ulimit\n');
  });
});

describe('askpass.cjs: isTraced() refuses when a tracer is already attached', () => {
  // A tracer attached BEFORE hardenSelf()'s prctl() is not retroactively severed, and reproducing that race
  // in a process-level test is not reliable, so this pins the pure parsing/decision logic (a regression in the
  // `!== '0'` comparison or the regex). require()'d: the require.main === module guard means no socket is opened.
  // WHY injection, not vi.spyOn(fs, ...): vitest makes the shared fs module's exports non-configurable.
  const askpass = require(ASKPASS_CJS_PATH) as { isTraced: (readStatus?: () => string) => boolean };

  // The TracerPid branch is Linux-only (other platforms return false before reading), so these skip elsewhere.
  it.skipIf(process.platform !== 'linux').each([
    ['refuses (returns true) when TracerPid is non-zero', () => 'Name:\tnode\nState:\tS (sleeping)\nTracerPid:\t4242\nUid:\t1000\t1000\t1000\t1000\n', true],
    ['allows (returns false) when TracerPid is 0', () => 'Name:\tnode\nState:\tR (running)\nTracerPid:\t0\nUid:\t1000\t1000\t1000\t1000\n', false],
    ['fails closed (returns true) when the status text has no TracerPid line at all', () => 'Name:\tnode\nState:\tR (running)\n', true],
    ['fails closed (returns true) when /proc/self/status is unreadable', () => { throw new Error('ENOENT: no such file or directory'); }, true],
  ])('%s', (_label, readStatus, expected) => {
    expect(askpass.isTraced(readStatus as () => string)).toBe(expected);
  });

  it('does not false-positive against this test process\'s own real, untraced /proc/self/status', () => {
    // No mock: vitest does not attach a ptrace-style tracer to its workers.
    expect(askpass.isTraced()).toBe(false);
  });
});

// Not tested here: the packaged-layout koffi resolution (askpass.cjs in app.asar.unpacked reaching the sibling
// node_modules/koffi). Proving it needs a real app.asar built with @electron/asar, which is not a devDependency;
// every test above already runs askpass.cjs from its shipped location with the same relative resolution.
