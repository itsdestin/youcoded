// askpass-server.test.ts — design §9: a REAL unix socket in a temp dir,
// with `verify()` injected (so this exercises AskpassServer's OWN protocol
// logic — the 5-step handshake, byte cap, attempt counting, deliver/
// refuse/withdraw — independent of real /proc state or a real sudo).
// `resolvePeerPid` is left at its REAL implementation: the test client and
// this server run in the SAME process, so the kernel's own SO_PEERCRED
// genuinely reports `process.pid` for every connection here, which is also
// what proves the startup self-test (peer-cred.ts's `selfTest`) for real.
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { spawn } from 'child_process';
import { AskpassServer, type AskpassAskEvent } from '../src/main/harness/askpass/askpass-server';
import { selfTest as peerCredSelfTest } from '../src/main/harness/askpass/peer-cred';
import { RunningCalls } from '../src/main/harness/askpass/running-calls';
import type { ProcReader, ProcStat, PidHandle } from '../src/main/harness/askpass/proc-info';
import type { VerifyResult } from '../src/main/harness/askpass/verify';

/** Answers "still the same untraced, now-hardened process" for any pid: every connection here is this test process talking to itself. */
function makeHealthyReader(): ProcReader {
  const FIXED_START_TIME = 4242;
  return {
    exePath: async () => null,
    cmdline: async () => null,
    environ: async () => null, // "now EACCES" — the step 5 proof of hardening
    ppid: async () => null,
    startTime: async () => FIXED_START_TIME, // unchanged across pre/post-harden reads
    tracerPid: async () => 0,
    statPath: async (_p: string): Promise<ProcStat | null> => null,
    pidfdOpen: async (): Promise<PidHandle | null> => null,
    uids: async () => null,
    comm: async () => null,
  };
}

/** A pin whose closed-ness is observable from the test. */
interface TrackedPin {
  closed: boolean;
}

/** Makes every pidfdOpen return a trackable handle, so the server's pin-holding logic is observable. */
function withTrackablePins(base: ProcReader): { reader: ProcReader; pins: TrackedPin[] } {
  const pins: TrackedPin[] = [];
  const reader: ProcReader = {
    ...base,
    pidfdOpen: async (): Promise<PidHandle | null> => {
      const tracked: TrackedPin = { closed: false };
      pins.push(tracked);
      return {
        close(): void {
          tracked.closed = true;
        },
      };
    },
  };
  return { reader, pins };
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-askpass-server-test-'));
  cleanupDirs.push(dir);
  return dir;
}

interface TestServer {
  server: AskpassServer;
  runningCalls: RunningCalls;
  setVerifyResult: (result: VerifyResult) => void;
}

interface TestServerOptions {
  reader?: ProcReader;
  handshakeTimeoutMs?: number;
  hardenTimeoutMs?: number;
  verifyTimeoutMs?: number;
}

async function startTestServer(options?: TestServerOptions): Promise<TestServer> {
  const runningCalls = new RunningCalls();
  let verifyResult: VerifyResult = { ok: false, reason: 'peer-unresolvable' };
  const server = new AskpassServer({
    execPath: '/fake/execPath',
    helperScriptRealpath: '/fake/askpass.cjs',
    runningCalls,
    reader: options?.reader ?? makeHealthyReader(),
    platform: 'linux',
    socketDirOverride: makeTempDir(),
    handshakeTimeoutMs: options?.handshakeTimeoutMs,
    hardenTimeoutMs: options?.hardenTimeoutMs,
    verifyTimeoutMs: options?.verifyTimeoutMs,
    verify: async () => verifyResult,
  });
  await server.start();
  expect(server.available).toBe(true);
  return {
    server,
    runningCalls,
    setVerifyResult: (result: VerifyResult) => {
      verifyResult = result;
    },
  };
}

/** The client half of the real protocol: connect, send the v:2 handshake, read lines back. */
class TestClient {
  readonly socket: net.Socket;
  private buffer = Buffer.alloc(0);

  constructor(socketPath: string) {
    this.socket = net.createConnection({ path: socketPath });
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });
  }

  send(obj: unknown): void {
    this.socket.write(JSON.stringify(obj) + '\n');
  }

  nextLine(timeoutMs = 3000): Promise<string> {
    return new Promise((resolve, reject) => {
      const tryExtract = (): string | null => {
        const nl = this.buffer.indexOf(0x0a);
        if (nl === -1) return null;
        const line = this.buffer.subarray(0, nl).toString('utf8');
        this.buffer = this.buffer.subarray(nl + 1);
        return line;
      };
      const already = tryExtract();
      if (already !== null) {
        resolve(already);
        return;
      }
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off('data', onData);
        this.socket.off('close', onClose);
      };
      const onData = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const line = tryExtract();
        if (line !== null) {
          cleanup();
          resolve(line);
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error('socket closed before a line arrived'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timed out waiting for a line'));
      }, timeoutMs);
      this.socket.on('data', onData);
      this.socket.once('close', onClose);
    });
  }

  destroy(): void {
    try {
      this.socket.destroy();
    } catch {
      // already gone
    }
  }
}

function waitForAsk(server: AskpassServer): Promise<AskpassAskEvent> {
  return new Promise((resolve) => server.once('ask', resolve));
}

/** Runs handshake, verify and the harden round-trip; returns once the server has emitted 'ask'. */
async function driveToAsk(server: AskpassServer, socketPath: string): Promise<{ client: TestClient; ask: AskpassAskEvent }> {
  const client = new TestClient(socketPath);
  await client.connect();
  const askPromise = waitForAsk(server);
  client.send({ v: 2 });
  const hardenLine = await client.nextLine();
  expect(JSON.parse(hardenLine)).toEqual({ harden: true });
  client.send({ hardened: true });
  const ask = await askPromise;
  return { client, ask };
}

const OK_VERIFY_RESULT = (overrides?: Partial<Extract<VerifyResult, { ok: true }>>): VerifyResult => ({
  ok: true,
  sudoPid: 111,
  sudoArgv: ['sudo', 'apt', 'update'],
  sudoExePath: '/usr/bin/sudo',
  callRoot: 222,
  via: undefined,
  ...overrides,
});

// WHY these platform skips: the admin-password feature only ever starts on Linux; on Windows the socket listen is refused (EACCES)
// and on macOS the kernel peer-pid self-test and the OS-injected __CF_USER_TEXT_ENCODING make these fail for reasons no user can reach.
const NOT_LINUX = process.platform !== 'linux';

/** A started server with call root 222 registered and a healthy verify result — the setup most tests share. */
async function askSetup(opts: TestServerOptions & { verify?: Partial<Extract<VerifyResult, { ok: true }>>; specialist?: string } = {}) {
  const t = await startTestServer(opts);
  t.runningCalls.register(222, 1, { sessionId: 'sess-1', toolCallId: 'tool-1', ...(opts.specialist ? { specialist: opts.specialist } : {}) });
  t.setVerifyResult(OK_VERIFY_RESULT(opts.verify));
  return t;
}

/** Connects, sends the handshake and returns the first reply line (no harden step). */
async function handshake(server: AskpassServer): Promise<{ client: TestClient; reply: unknown }> {
  const client = new TestClient(server.socketPath!);
  await client.connect();
  client.send({ v: 2 });
  return { client, reply: JSON.parse(await client.nextLine()) };
}

describe.skipIf(NOT_LINUX)('AskpassServer: happy path', () => {
  it('delivers a password: writes {"ok":true,"password":…} exactly once and zeroes the caller Buffer', async () => {
    const { server } = await askSetup();
    const { client, ask } = await driveToAsk(server, server.socketPath!);
    expect(ask).toMatchObject({ sudoPid: 111, callRoot: 222, sessionId: 'sess-1', toolCallId: 'tool-1', attempt: 0 });

    const password = Buffer.from('sentinel-pw-deliver', 'utf8');
    expect(server.deliver(ask.askId, password)).toBe(true);
    expect(password.every((b) => b === 0)).toBe(true);
    expect(JSON.parse(await client.nextLine())).toEqual({ ok: true, password: 'sentinel-pw-deliver' });
    // A second deliver for the same (already-resolved) askId is a no-op.
    expect(server.deliver(ask.askId, Buffer.from('x'))).toBe(false);

    client.destroy();
    await server.stop();
  });

  it('refuses: writes {"ok":false} and the askId cannot be reused', async () => {
    const { server } = await askSetup();
    const { client, ask } = await driveToAsk(server, server.socketPath!);
    expect(server.refuse(ask.askId)).toBe(true);
    expect(JSON.parse(await client.nextLine())).toEqual({ ok: false });
    expect(server.refuse(ask.askId)).toBe(false);

    client.destroy();
    await server.stop();
  });

  it('an unknown askId always returns false from deliver/refuse', async () => {
    const { server } = await startTestServer();
    expect(server.deliver('does-not-exist', Buffer.from('x'))).toBe(false);
    expect(server.refuse('does-not-exist')).toBe(false);
    await server.stop();
  });

  it('emits "withdrawn" when the client closes before deliver/refuse, and the ask is gone', async () => {
    const { server } = await askSetup();
    const { client, ask } = await driveToAsk(server, server.socketPath!);
    const withdrawn = new Promise<string>((resolve) => server.once('withdrawn', resolve));
    client.destroy();
    expect(await withdrawn).toBe(ask.askId);
    expect(server.refuse(ask.askId)).toBe(false);
    await server.stop();
  });

  it('counts attempts per sudo pid: 0 on the first ask, 1 on a retry from the same sudo pid', async () => {
    const { server } = await askSetup({ verify: { sudoPid: 777 } });
    const first = await driveToAsk(server, server.socketPath!);
    expect(first.ask.attempt).toBe(0);
    server.refuse(first.ask.askId); // wrong password — sudo retries under the SAME sudo pid
    first.client.destroy();

    const second = await driveToAsk(server, server.socketPath!);
    expect(second.ask.attempt).toBe(1);
    expect(second.ask.sudoPid).toBe(777);

    server.deliver(second.ask.askId, Buffer.from('correct'));
    second.client.destroy();
    await server.stop();
  });

  it('resolves "via" straight through from verify() onto the ask event', async () => {
    const { server } = await askSetup({ verify: { via: 'install.sh' }, specialist: 'reviewer' });
    const { client, ask } = await driveToAsk(server, server.socketPath!);
    expect(ask.via).toBe('install.sh');
    expect(ask.specialist).toBe('reviewer');

    server.refuse(ask.askId);
    client.destroy();
    await server.stop();
  });
});

describe.skipIf(NOT_LINUX)('AskpassServer: refusals before an ask is ever raised', () => {
  it('refuses when verify() itself fails — no ask is emitted', async () => {
    const { server, setVerifyResult } = await startTestServer();
    setVerifyResult({ ok: false, reason: 'wrong-exe' });
    let askFired = false;
    server.once('ask', () => { askFired = true; });
    const { client, reply } = await handshake(server);
    expect(reply).toEqual({ ok: false });
    expect(askFired).toBe(false);

    client.destroy();
    await server.stop();
  });

  it('after a refusal, names the Bash call it belonged to so the command can explain it', async () => {
    const { server, runningCalls, setVerifyResult } = await startTestServer();
    setVerifyResult({ ok: false, reason: 'parent-not-setuid' });
    // The kernel peer is this test process; register it as a call root with the healthy reader's start time.
    runningCalls.register(process.pid, 4242, { sessionId: 'sess-9', toolCallId: 'tool-9' });
    const refused: unknown[] = [];
    server.on('refused', (e) => refused.push(e));

    const { client, reply } = await handshake(server);
    expect(reply).toEqual({ ok: false });
    await vi.waitFor(() => expect(refused).toEqual([{ toolCallId: 'tool-9', sessionId: 'sess-9', reason: 'parent-not-setuid' }]));

    client.destroy();
    await server.stop();
  });

  it('after a refusal from an unregistered process, reports nothing (no call to explain it on)', async () => {
    const { server, setVerifyResult } = await startTestServer();
    setVerifyResult({ ok: false, reason: 'parent-not-setuid' });
    const refused: unknown[] = [];
    server.on('refused', (e) => refused.push(e));

    const { client, reply } = await handshake(server);
    expect(reply).toEqual({ ok: false });
    await new Promise((r) => setImmediate(r)); // settle
    expect(refused).toEqual([]);

    client.destroy();
    await server.stop();
  });

  it('destroys the connection on a malformed handshake (not v:2)', async () => {
    const { server } = await startTestServer();
    const client = new TestClient(server.socketPath!);
    await client.connect();
    client.send({ v: 1 }); // the OLD protocol version — no longer accepted
    await expect(client.nextLine(1000)).rejects.toThrow();
    await server.stop();
  });

  it('refuses when the call root is not (or no longer) registered', async () => {
    const { server, setVerifyResult } = await startTestServer(); // nothing registered: callRoot 222 is unknown
    setVerifyResult(OK_VERIFY_RESULT());
    const { client, reply } = await handshake(server);
    expect(reply).toEqual({ ok: false });

    client.destroy();
    await server.stop();
  });
});

describe.skipIf(NOT_LINUX)('AskpassServer: the helper pin stays open through the harden round-trip', () => {
  // WHY: if the pin only covered verify()'s own chain, it would already be closed when 'ask' fires.
  it.each([
    ['deliver', (s: AskpassServer, id: string) => s.deliver(id, Buffer.from('pw'))],
    ['refuse', (s: AskpassServer, id: string) => s.refuse(id)],
  ])('is still open when the ask is raised, and closes on %s', async (_n, finish) => {
    const { reader, pins } = withTrackablePins(makeHealthyReader());
    const { server } = await askSetup({ reader });
    const { client, ask } = await driveToAsk(server, server.socketPath!);
    expect(pins.length).toBe(1);
    expect(pins[0].closed).toBe(false);
    finish(server, ask.askId);
    expect(pins[0].closed).toBe(true);

    client.destroy();
    await server.stop();
  });

  it('closes when the client withdraws before deliver/refuse', async () => {
    const { reader, pins } = withTrackablePins(makeHealthyReader());
    const { server } = await askSetup({ reader });
    const { client } = await driveToAsk(server, server.socketPath!);
    const withdrawn = new Promise<string>((resolve) => server.once('withdrawn', resolve));
    client.destroy();
    await withdrawn;
    expect(pins[0].closed).toBe(true);

    await server.stop();
  });

  it('closes right away when verify() fails, before any ask is ever raised', async () => {
    const { reader, pins } = withTrackablePins(makeHealthyReader());
    const { server, setVerifyResult } = await startTestServer({ reader });
    setVerifyResult({ ok: false, reason: 'wrong-exe' });
    const { client } = await handshake(server);
    expect(pins.length).toBe(1);
    expect(pins[0].closed).toBe(true);

    client.destroy();
    await server.stop();
  });
});

describe.skipIf(NOT_LINUX)('AskpassServer: attempt counting checks the sudo pid actually IS the same process', () => {
  it('treats a reused sudo pid number under a different, still-alive call root as a brand-new attempt', async () => {
    // sudo pid 555 shows up twice with two DIFFERENT start times: a different process sharing the pid number, not a retry.
    const startTimesForSudoPid555 = [100, 200];
    let sudoReadCount = 0;
    const reader: ProcReader = {
      ...makeHealthyReader(),
      startTime: async (pid: number) => {
        if (pid === process.pid) return 4242; // keeps the harden pre/post check happy
        if (pid === 555) return startTimesForSudoPid555[sudoReadCount++] ?? null;
        return null;
      },
    };
    const { server, runningCalls, setVerifyResult } = await startTestServer({ reader });
    runningCalls.register(222, 1, { sessionId: 'sess-A', toolCallId: 'tool-A' });
    runningCalls.register(333, 2, { sessionId: 'sess-B', toolCallId: 'tool-B' });

    setVerifyResult(OK_VERIFY_RESULT({ sudoPid: 555, callRoot: 222 }));
    const first = await driveToAsk(server, server.socketPath!);
    expect(first.ask.attempt).toBe(0);
    server.deliver(first.ask.askId, Buffer.from('pw-a'));
    first.client.destroy();

    setVerifyResult(OK_VERIFY_RESULT({ sudoPid: 555, callRoot: 333 }));
    const second = await driveToAsk(server, server.socketPath!);
    expect(second.ask.attempt).toBe(0); // NOT 1 — not a continuation of call 222's tries
    expect(second.ask.callRoot).toBe(333);

    server.deliver(second.ask.askId, Buffer.from('pw-b'));
    second.client.destroy();
    await server.stop();
  });
});

describe.skipIf(NOT_LINUX)('AskpassServer: protocol timeouts and the line-length cap', () => {
  it('destroys the connection when the handshake line never arrives', async () => {
    const { server } = await startTestServer({ handshakeTimeoutMs: 30 });
    const client = new TestClient(server.socketPath!);
    await client.connect();
    await expect(client.nextLine(2000)).rejects.toThrow();
    await server.stop();
  });

  it('destroys the connection when the harden confirmation never arrives', async () => {
    const { server } = await askSetup({ hardenTimeoutMs: 30 });
    const { client, reply } = await handshake(server);
    expect(reply).toEqual({ harden: true });
    await expect(client.nextLine(2000)).rejects.toThrow(); // never replies {"hardened":true}

    client.destroy();
    await server.stop();
  });

  it('refuses and actually aborts a verify() still mid-flight when its own timeout elapses', async () => {
    let capturedSignal: AbortSignal | undefined;
    const server = new AskpassServer({
      execPath: '/fake/execPath',
      helperScriptRealpath: '/fake/askpass.cjs',
      runningCalls: new RunningCalls(),
      reader: makeHealthyReader(),
      platform: 'linux',
      socketDirOverride: makeTempDir(),
      verifyTimeoutMs: 30,
      verify: (_pid: number, signal?: AbortSignal) => {
        capturedSignal = signal;
        return new Promise<VerifyResult>(() => {}); // a hung ancestor walk — never settles
      },
    });
    await server.start();
    const { client, reply } = await handshake(server);
    expect(reply).toEqual({ ok: false });
    expect(capturedSignal?.aborted).toBe(true);

    client.destroy();
    await server.stop();
  });

  it('destroys the connection when a line exceeds the byte cap', async () => {
    const { server } = await startTestServer();
    const client = new TestClient(server.socketPath!);
    await client.connect();
    client.socket.write(Buffer.alloc(4096, 'a'.charCodeAt(0))); // no newline anywhere, well over the cap
    await expect(client.nextLine(2000)).rejects.toThrow();
    await server.stop();
  });
});

describe.skipIf(NOT_LINUX)('AskpassServer: startup self-test (real, on Linux)', () => {
  it('start() makes the server available, and peer-cred.selfTest() independently agrees', async () => {
    const { server } = await startTestServer();
    expect(server.available).toBe(true);
    expect(await peerCredSelfTest(server.socketPath!)).toBe(true);
    await server.stop();
  });
});

// WHY: a crashed app, or a test that never stopped a real AskpassServer, left askpass-<pid>.sock files behind (11 found in the real
// $XDG_RUNTIME_DIR). start() sweeps its own directory; this runs ONLY against a temp dir, never the real socket dir.
describe.skipIf(NOT_LINUX)('AskpassServer: start() sweeps dead askpass-<pid>.sock files from its own directory', () => {
  it('removes a dead pid\'s socket file, keeps a live pid\'s and an unrelated file untouched', async () => {
    const dir = makeTempDir();
    // A genuinely dead pid (a child that has exited) and a live one that is NOT this process: the sweep must check the pid in the FILENAME.
    const pidOf = (child: ReturnType<typeof spawn>, wait: 'close' | 'spawn'): Promise<number> => new Promise((resolve, reject) => {
      child.once('spawn', () => {
        const pid = child.pid;
        if (pid === undefined) { reject(new Error('child never got a pid')); return; }
        if (wait === 'spawn') resolve(pid); else child.once('close', () => resolve(pid));
      });
      child.once('error', reject);
    });
    const deadPid = await pidOf(spawn(process.execPath, ['-e', '']), 'close');
    const liveChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    const livePid = await pidOf(liveChild, 'spawn');

    const deadSocketPath = path.join(dir, `askpass-${deadPid}.sock`);
    const liveSocketPath = path.join(dir, `askpass-${livePid}.sock`);
    const unrelatedPath = path.join(dir, 'not-a-socket.txt');
    for (const f of [deadSocketPath, liveSocketPath, unrelatedPath]) fs.writeFileSync(f, '');

    const server = new AskpassServer({
      execPath: '/fake/execPath',
      helperScriptRealpath: '/fake/askpass.cjs',
      runningCalls: new RunningCalls(),
      reader: makeHealthyReader(),
      platform: 'linux',
      socketDirOverride: dir,
    });
    try {
      await server.start();
      expect(server.available).toBe(true);
      expect(fs.existsSync(deadSocketPath)).toBe(false);
      expect(fs.existsSync(liveSocketPath)).toBe(true);
      expect(fs.existsSync(unrelatedPath)).toBe(true);
    } finally {
      await server.stop();
      liveChild.kill();
    }
  });
});

// Cross-file discipline: the 11 leaked sockets came from test code building a real AskpassServer against the real default dir.
// Isolation is `socketDirOverride`, or an `XDG_RUNTIME_DIR` redirect for tests that trigger the production wiring indirectly.
describe('AskpassServer: no test file constructs one without isolating its socket dir', () => {
  it('every "new AskpassServer(" in tests/ shares its file with socketDirOverride or an XDG_RUNTIME_DIR override', () => {
    const testsDir = path.resolve(__dirname);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.test.ts') && !entry.name.endsWith('.test.tsx')) continue;
        const contents = fs.readFileSync(full, 'utf8');
        if (!contents.includes('new AskpassServer(')) continue;
        if (!contents.includes('socketDirOverride') && !contents.includes('XDG_RUNTIME_DIR')) offenders.push(path.relative(testsDir, full));
      }
    };
    walk(testsDir);
    expect(offenders).toEqual([]);
  });
});

// WHY: every native session's Bash env carries one askpass socket path for the whole run; a deleted file is re-created (socket-repair.ts).
describe.skipIf(NOT_LINUX)('AskpassServer.ensureListening', () => {
  it('re-creates a deleted socket file that clients can reach again', async () => {
    const { server } = await startTestServer();
    const p = server.socketPath!;
    fs.unlinkSync(p);
    await server.ensureListening();
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    await new Promise<void>((resolve, reject) => {
      const c = net.createConnection(p, () => { c.end(); resolve(); });
      c.on('error', reject);
    });
    await server.stop();
    expect(fs.existsSync(p)).toBe(false);
  });
});
