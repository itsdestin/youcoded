// askpass-server.test.ts — design §9: a REAL unix socket in a temp dir,
// with `verify()` injected (so this exercises AskpassServer's OWN protocol
// logic — the 5-step handshake, byte cap, attempt counting, deliver/
// refuse/withdraw — independent of real /proc state or a real sudo).
// `resolvePeerPid` is left at its REAL implementation: the test client and
// this server run in the SAME process, so the kernel's own SO_PEERCRED
// genuinely reports `process.pid` for every connection here, which is also
// what proves the startup self-test (peer-cred.ts's `selfTest`) for real.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { AskpassServer, type AskpassAskEvent } from '../src/main/harness/askpass/askpass-server';
import { selfTest as peerCredSelfTest } from '../src/main/harness/askpass/peer-cred';
import { RunningCalls } from '../src/main/harness/askpass/running-calls';
import type { ProcReader, ProcStat, PidHandle } from '../src/main/harness/askpass/proc-info';
import type { VerifyResult } from '../src/main/harness/askpass/verify';

/** Only the three methods AskpassServer's own post-harden re-check calls
 *  directly (startTime, tracerPid, environ) matter here — `verify()` itself
 *  is injected per test, so this reader never feeds the identity chain.
 *  Every connection in this file is this SAME test process talking to
 *  itself, so there's only ever one real pid in play; the fake ignores
 *  which pid it's asked about and answers "still the same untraced,
 *  now-hardened process" unconditionally, which is exactly the state a
 *  real hardened helper would be in when everything is healthy. */
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
  };
}

/** A pin whose closed-ness is observable from the test. */
interface TrackedPin {
  closed: boolean;
}

/** Wraps a reader so every `pidfdOpen` call returns a real, trackable
 *  handle instead of null — the fake readers elsewhere in this file never
 *  return one, which means the server's own pin-holding logic (kept open
 *  through the harden round-trip, closed only by deliver/refuse/withdraw)
 *  is otherwise completely untested from this side. */
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

/** Drives the client half of the real protocol: connect, send the v:2
 *  handshake, read lines back with a small helper. Used by every test
 *  below instead of duplicating socket plumbing per test. */
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

/** Runs steps 1–4 of the real protocol (handshake, verify, harden
 *  round-trip) and returns once the server has emitted 'ask' — i.e. right
 *  where a test wants to take over and call deliver()/refuse(), or close
 *  the client to exercise withdrawal. */
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
  callRoot: 222,
  via: undefined,
  ...overrides,
});

describe('AskpassServer: happy path', () => {
  it('delivers a password: writes {"ok":true,"password":…} exactly once and zeroes the caller Buffer', async () => {
    const { server, runningCalls, setVerifyResult } = await startTestServer();
    runningCalls.register(222, 1, { sessionId: 'sess-1', toolCallId: 'tool-1' });
    setVerifyResult(OK_VERIFY_RESULT());

    const { client, ask } = await driveToAsk(server, server.socketPath!);
    expect(ask.sudoPid).toBe(111);
    expect(ask.callRoot).toBe(222);
    expect(ask.sessionId).toBe('sess-1');
    expect(ask.toolCallId).toBe('tool-1');
    expect(ask.attempt).toBe(0);

    const password = Buffer.from('sentinel-pw-deliver', 'utf8');
    const delivered = server.deliver(ask.askId, password);
    expect(delivered).toBe(true);
    expect(password.every((b) => b === 0)).toBe(true); // zeroed immediately after write

    const reply = await client.nextLine();
    expect(JSON.parse(reply)).toEqual({ ok: true, password: 'sentinel-pw-deliver' });

    // A second deliver for the same (already-resolved) askId is a no-op.
    expect(server.deliver(ask.askId, Buffer.from('x'))).toBe(false);

    client.destroy();
    await server.stop();
  });

  it('refuses: writes {"ok":false} and the askId cannot be reused', async () => {
    const { server, runningCalls, setVerifyResult } = await startTestServer();
    runningCalls.register(222, 1, { sessionId: 'sess-1', toolCallId: 'tool-1' });
    setVerifyResult(OK_VERIFY_RESULT());

    const { client, ask } = await driveToAsk(server, server.socketPath!);
    expect(server.refuse(ask.askId)).toBe(true);
    const reply = await client.nextLine();
    expect(JSON.parse(reply)).toEqual({ ok: false });
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

  it('emits "withdrawn" when the client closes before deliver/refuse', async () => {
    const { server, runningCalls, setVerifyResult } = await startTestServer();
    runningCalls.register(222, 1, { sessionId: 'sess-1', toolCallId: 'tool-1' });
    setVerifyResult(OK_VERIFY_RESULT());

    const { client, ask } = await driveToAsk(server, server.socketPath!);
    const withdrawnPromise = new Promise<string>((resolve) => server.once('withdrawn', resolve));
    client.destroy();
    const withdrawnAskId = await withdrawnPromise;
    expect(withdrawnAskId).toBe(ask.askId);

    // The withdrawn ask is gone from the pending set — refuse/deliver on it
    // now both report "expired".
    expect(server.refuse(ask.askId)).toBe(false);

    await server.stop();
  });

  it('counts attempts per sudo pid: 0 on the first ask, 1 on a retry from the same sudo pid', async () => {
    const { server, runningCalls, setVerifyResult } = await startTestServer();
    runningCalls.register(222, 1, { sessionId: 'sess-1', toolCallId: 'tool-1' });
    setVerifyResult(OK_VERIFY_RESULT({ sudoPid: 777 }));

    const first = await driveToAsk(server, server.socketPath!);
    expect(first.ask.attempt).toBe(0);
    server.refuse(first.ask.askId); // wrong password — sudo will retry under the SAME sudo pid
    first.client.destroy();

    const second = await driveToAsk(server, server.socketPath!);
    expect(second.ask.attempt).toBe(1);
    expect(second.ask.sudoPid).toBe(777);

    server.deliver(second.ask.askId, Buffer.from('correct'));
    second.client.destroy();
    await server.stop();
  });

  it('resolves "via" straight through from verify() onto the ask event', async () => {
    const { server, runningCalls, setVerifyResult } = await startTestServer();
    runningCalls.register(222, 1, { sessionId: 'sess-1', toolCallId: 'tool-1', specialist: 'reviewer' });
    setVerifyResult(OK_VERIFY_RESULT({ via: 'install.sh' }));

    const { client, ask } = await driveToAsk(server, server.socketPath!);
    expect(ask.via).toBe('install.sh');
    expect(ask.specialist).toBe('reviewer');

    server.refuse(ask.askId);
    client.destroy();
    await server.stop();
  });
});

describe('AskpassServer: refusals before an ask is ever raised', () => {
  it('refuses when verify() itself fails — no ask is emitted', async () => {
    const { server, setVerifyResult } = await startTestServer();
    setVerifyResult({ ok: false, reason: 'wrong-exe' });

    const client = new TestClient(server.socketPath!);
    await client.connect();
    let askFired = false;
    server.once('ask', () => {
      askFired = true;
    });
    client.send({ v: 2 });
    const reply = await client.nextLine();
    expect(JSON.parse(reply)).toEqual({ ok: false });
    expect(askFired).toBe(false);

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
    const { server, setVerifyResult } = await startTestServer();
    // No runningCalls.register() call at all — callRoot 222 is unknown.
    setVerifyResult(OK_VERIFY_RESULT());

    const client = new TestClient(server.socketPath!);
    await client.connect();
    client.send({ v: 2 });
    const reply = await client.nextLine();
    expect(JSON.parse(reply)).toEqual({ ok: false });

    client.destroy();
    await server.stop();
  });
});

describe('AskpassServer: the helper pin stays open through the harden round-trip', () => {
  it('is still open right when the ask is raised, and closes on deliver', async () => {
    const { reader, pins } = withTrackablePins(makeHealthyReader());
    const { server, runningCalls, setVerifyResult } = await startTestServer({ reader });
    runningCalls.register(222, 1, { sessionId: 'sess-1', toolCallId: 'tool-1' });
    setVerifyResult(OK_VERIFY_RESULT());

    const { client, ask } = await driveToAsk(server, server.socketPath!);
    // By the time 'ask' fires, verify() AND the whole harden round-trip
    // (steps 3-5) are already done — if the pin only covered verify()'s own
    // chain (T3-1's original gap), it would already be closed here.
    expect(pins.length).toBe(1);
    expect(pins[0].closed).toBe(false);

    server.deliver(ask.askId, Buffer.from('pw'));
    expect(pins[0].closed).toBe(true);

    client.destroy();
    await server.stop();
  });

  it('closes on refuse', async () => {
    const { reader, pins } = withTrackablePins(makeHealthyReader());
    const { server, runningCalls, setVerifyResult } = await startTestServer({ reader });
    runningCalls.register(222, 1, { sessionId: 'sess-1', toolCallId: 'tool-1' });
    setVerifyResult(OK_VERIFY_RESULT());

    const { client, ask } = await driveToAsk(server, server.socketPath!);
    server.refuse(ask.askId);
    expect(pins[0].closed).toBe(true);

    client.destroy();
    await server.stop();
  });

  it('closes when the client withdraws before deliver/refuse', async () => {
    const { reader, pins } = withTrackablePins(makeHealthyReader());
    const { server, runningCalls, setVerifyResult } = await startTestServer({ reader });
    runningCalls.register(222, 1, { sessionId: 'sess-1', toolCallId: 'tool-1' });
    setVerifyResult(OK_VERIFY_RESULT());

    const { client, ask } = await driveToAsk(server, server.socketPath!);
    const withdrawnPromise = new Promise<string>((resolve) => server.once('withdrawn', resolve));
    client.destroy();
    await withdrawnPromise;
    expect(pins[0].closed).toBe(true);

    await server.stop();
  });

  it('closes right away when verify() fails, before any ask is ever raised', async () => {
    const { reader, pins } = withTrackablePins(makeHealthyReader());
    const { server, setVerifyResult } = await startTestServer({ reader });
    setVerifyResult({ ok: false, reason: 'wrong-exe' });

    const client = new TestClient(server.socketPath!);
    await client.connect();
    client.send({ v: 2 });
    await client.nextLine();
    expect(pins.length).toBe(1);
    expect(pins[0].closed).toBe(true);

    client.destroy();
    await server.stop();
  });
});

describe('AskpassServer: attempt counting checks the sudo pid actually IS the same process', () => {
  it('treats a reused sudo pid number under a different, still-alive call root as a brand-new attempt', async () => {
    // sudo pid 555 shows up twice with two DIFFERENT recorded start times —
    // the second occurrence is a genuinely different process that happens
    // to share the pid number, not a retry of the first.
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
    expect(second.ask.attempt).toBe(0); // NOT 1 — this is not a continuation of call 222's tries
    expect(second.ask.callRoot).toBe(333);

    server.deliver(second.ask.askId, Buffer.from('pw-b'));
    second.client.destroy();
    await server.stop();
  });
});

describe('AskpassServer: protocol timeouts and the line-length cap', () => {
  it('destroys the connection when the handshake line never arrives', async () => {
    const { server } = await startTestServer({ handshakeTimeoutMs: 30 });
    const client = new TestClient(server.socketPath!);
    await client.connect();
    // Sends nothing at all.
    await expect(client.nextLine(2000)).rejects.toThrow();
    await server.stop();
  });

  it('destroys the connection when the harden confirmation never arrives', async () => {
    const { server, runningCalls, setVerifyResult } = await startTestServer({ hardenTimeoutMs: 30 });
    runningCalls.register(222, 1, { sessionId: 'sess-1', toolCallId: 'tool-1' });
    setVerifyResult(OK_VERIFY_RESULT());

    const client = new TestClient(server.socketPath!);
    await client.connect();
    client.send({ v: 2 });
    const hardenLine = await client.nextLine();
    expect(JSON.parse(hardenLine)).toEqual({ harden: true });
    // Never replies with {"hardened":true}.
    await expect(client.nextLine(2000)).rejects.toThrow();

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
        return new Promise<VerifyResult>(() => {}); // simulates a hung ancestor walk — never settles
      },
    });
    await server.start();

    const client = new TestClient(server.socketPath!);
    await client.connect();
    client.send({ v: 2 });
    const reply = await client.nextLine(2000);
    expect(JSON.parse(reply)).toEqual({ ok: false });
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

describe('AskpassServer: startup self-test (real, on Linux)', () => {
  it.skipIf(process.platform !== 'linux')('start() succeeds and available becomes true via a REAL peer-cred self-test', async () => {
    const { server } = await startTestServer();
    expect(server.available).toBe(true);
    await server.stop();
  });

  it.skipIf(process.platform !== 'linux')('peer-cred.selfTest() independently reports true for the server\'s own socket', async () => {
    const { server } = await startTestServer();
    const ok = await peerCredSelfTest(server.socketPath!);
    expect(ok).toBe(true);
    await server.stop();
  });
});
