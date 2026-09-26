// admin-password-wiring.test.ts — task 5 review, T5-1/T5-2: the seam that
// broke and that nothing caught. `SUDO_ASKPASS` — the one variable sudo(8)
// itself execve()s when it needs a password with no tty — must be the
// executable wrapper `scripts/askpass/youcoded-askpass`, never the
// non-executable `askpass.cjs` it eventually execs into (that half stays
// the verifier's `helperScriptRealpath`, the argv[1] check). This test goes
// through the REAL production wiring — `resolveAskpassPaths()` +
// `NativeSessionHost.attachAdminPassword()` — against the real files on
// disk, so a future regression here fails fast with no Docker required.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { AskpassServer } from '../src/main/harness/askpass/askpass-server';
import { RunningCalls } from '../src/main/harness/askpass/running-calls';
import { verifyAskpassPeer, type VerifyResult } from '../src/main/harness/askpass/verify';
import { createProcReader } from '../src/main/harness/askpass/proc-info';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { EventEmitter } from 'node:events';
import { IPC } from '../src/shared/types';
import { WindowRegistry } from '../src/main/window-registry';

const DESKTOP_ROOT = path.resolve(__dirname, '..'); // desktop/ — where package.json lives

// `ipc-handlers.ts` imports `./main`, which runs module-scope side effects
// (`installCrashDiagnostics(app)`, an `app.on(...)` call) the instant it is
// imported — so a resolver-only `{isPackaged, getAppPath}` stub throws
// before `resolveAskpassPaths` is even reachable. Same comprehensive mock
// shape `tearoff-handoff.test.ts` already needs for the same reason, plus
// `getAppPath` for the resolver's own dev branch.
function mockElectron() {
  const BrowserWindowMock: any = vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }));
  BrowserWindowMock.getAllWindows = vi.fn(() => []);
  return {
    app: {
      isPackaged: false,
      getAppPath: () => DESKTOP_ROOT, // resolveAskpassPaths()'s own dev branch
      getPath: vi.fn(() => '/tmp'),
      getVersion: vi.fn(() => '0.0.0-test'),
      whenReady: vi.fn(() => new Promise(() => {})),
      on: vi.fn(),
      quit: vi.fn(),
      setAppUserModelId: vi.fn(),
      commandLine: { appendSwitch: vi.fn() },
      getGPUInfo: vi.fn(() => new Promise(() => {})),
    },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    BrowserWindow: BrowserWindowMock,
    Menu: { setApplicationMenu: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    dialog: { showOpenDialog: vi.fn() },
    clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) },
    nativeImage: {},
    shell: { openExternal: vi.fn() },
    powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
    screen: { getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })), getAllDisplays: vi.fn(() => []) },
    webContents: { fromId: vi.fn(() => null) },
  };
}

vi.mock('electron', mockElectron);

// Imported AFTER the electron mock (vi.mock is hoisted, but this keeps the
// dependency visible at the point of use).
async function importResolver() {
  const mod = await import('../src/main/ipc-handlers');
  return mod.resolveAskpassPaths;
}

const factory = async () =>
  new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [] }) }) }) as any;
const NO_CONTEXT = async () => ({ contextLength: null, totalSlots: null });

describe('resolveAskpassPaths — the one resolver both askpass paths come from', () => {
  it('resolves SUDO_ASKPASS to the executable wrapper, never the non-executable askpass.cjs it execs into', async () => {
    const resolveAskpassPaths = await importResolver();
    const paths = await resolveAskpassPaths();
    expect(paths).not.toBeNull();
    const { helperScriptRealpath, wrapperRealpath } = paths!;

    expect(path.basename(wrapperRealpath)).toBe('youcoded-askpass');
    expect(path.basename(helperScriptRealpath)).toBe('askpass.cjs');
    expect(wrapperRealpath).not.toBe(helperScriptRealpath);
    // Siblings — the wrapper is derived from helperScriptRealpath's OWN
    // real directory, never re-derived independently (T5-1's exact bug).
    expect(path.dirname(wrapperRealpath)).toBe(path.dirname(helperScriptRealpath));

    const stat = fs.statSync(wrapperRealpath);
    expect(stat.mode & 0o111).not.toBe(0); // executable by someone
    const contents = fs.readFileSync(wrapperRealpath, 'utf8');
    expect(contents.startsWith('#!/bin/sh')).toBe(true);
    expect(contents).toContain('env -i');

    // askpass.cjs itself is deliberately NOT executable/shebanged (design
    // §2.1) — sudo must never be pointed at it directly.
    const cjsStat = fs.statSync(helperScriptRealpath);
    expect(cjsStat.mode & 0o111).toBe(0);
  });

  it('returns null, never throws, when the app test-double lacks getAppPath (the exact shape several other test files\' fakes use)', async () => {
    // Mutates the ALREADY-mocked `electron` module in place (never
    // resetModules/doMock — ipc-handlers.ts transitively imports `./main`,
    // whose module-scope side effects only tolerate being triggered once
    // per this file's shared mock instance) and restores it immediately after.
    const electron: any = await import('electron');
    const original = electron.app.getAppPath;
    delete electron.app.getAppPath;
    try {
      const resolveAskpassPaths = await importResolver();
      await expect(resolveAskpassPaths()).resolves.toBeNull();
    } finally {
      electron.app.getAppPath = original;
    }
  });
});

describe('NativeSessionHost.attachAdminPassword — the real resolver feeding the real host', () => {
  let root: string;
  let host: NativeSessionHost;
  let server: AskpassServer | null;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-admin-wiring-'));
    host = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
  });

  afterAll(async () => {
    await server?.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('adminPasswordEnv.SUDO_ASKPASS ends in youcoded-askpass and is NOT helperScriptRealpath', async () => {
    const resolveAskpassPaths = await importResolver();
    const paths = await resolveAskpassPaths();
    expect(paths).not.toBeNull();
    const { helperScriptRealpath, wrapperRealpath } = paths!;

    server = new AskpassServer({
      execPath: process.execPath,
      helperScriptRealpath,
      runningCalls: host.runningCallsForAskpass(),
    });
    await server.start();
    expect(server.available).toBe(true); // the real peer-cred self-test, on this machine

    host.attachAdminPassword(server, wrapperRealpath);

    const env = host.adminPasswordEnv;
    expect(env).not.toBeNull();
    expect(env!.SUDO_ASKPASS).toBe(wrapperRealpath);
    expect(env!.SUDO_ASKPASS.endsWith('/youcoded-askpass')).toBe(true);
    expect(env!.SUDO_ASKPASS).not.toBe(helperScriptRealpath);
    expect(env!.YOUCODED_ASKPASS_SOCKET).toBe(server.socketPath);
    expect(env!.YOUCODED_ASKPASS_RUNTIME).toBe(process.execPath);
  });
});

describe('the real wrapper against a real AskpassServer (no sudo — refused at the parent check)', () => {
  it('reaches a verify attempt with the right argv, refused only for lacking a genuine sudo parent', async () => {
    const resolveAskpassPaths = await importResolver();
    const paths = await resolveAskpassPaths();
    expect(paths).not.toBeNull();
    const { helperScriptRealpath, wrapperRealpath } = paths!;

    const runningCalls = new RunningCalls();
    const captured: VerifyResult[] = [];
    const server = new AskpassServer({
      execPath: process.execPath,
      helperScriptRealpath,
      runningCalls,
      // Delegates to the REAL verifyAskpassPeer (real /proc reads) — only
      // observes the result, so this exercises the genuine chain end to
      // end, not a stub standing in for it.
      verify: async (pid, signal) => {
        const result = await verifyAskpassPeer(pid, {
          reader: createProcReader(),
          execPath: process.execPath,
          helperScriptRealpath,
          runningCalls,
          signal,
        });
        captured.push(result);
        return result;
      },
    });
    await server.start();
    expect(server.available).toBe(true);

    try {
      // Spawn the REAL wrapper directly (this test process — not a real
      // sudo — is its parent): proves the wrapper/env/socket wiring is
      // correct as far as verification will ever let it get without a
      // genuine setuid sudo ancestor.
      const child = spawn(wrapperRealpath, [], {
        env: { YOUCODED_ASKPASS_SOCKET: server.socketPath!, YOUCODED_ASKPASS_RUNTIME: process.execPath },
      });
      const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));

      expect(exitCode).toBe(1); // askpass.cjs exits 1 on any refusal
      expect(captured).toHaveLength(1);
      expect(captured[0].ok).toBe(false);
      if (!captured[0].ok) {
        // NOT a wrong-exe/wrong-argv/wrong-env-* reason — those are exactly
        // T5-1's class of bug (the wrapper/env pointed somewhere wrong).
        // Refused for lacking a genuine sudo parent instead, which proves
        // the helper's own identity check already passed.
        expect(['wrong-exe', 'wrong-argv', 'wrong-env-keys', 'wrong-env-value']).not.toContain(captured[0].reason);
        expect(captured[0].reason).toBe('parent-not-sudo-basename');
      }
    } finally {
      await server.stop();
    }
  }, 15_000);
});

// Task 4 review, T4-2: neither surface checked that `password` was actually
// a string before handing it to `Buffer.from` three calls deep (inside
// AdminPasswordService.submit()) — a non-string payload threw synchronously
// there. Fixed by type-checking on THIS hop, before nativeHost is ever
// reached; these tests exercise the REAL registered ipcMain.handle callback.
describe('native:submit-admin-password (IPC) — rejects a non-string/empty password without throwing', () => {
  async function buildHandlers() {
    const mockIpcMain = { handle: vi.fn(), on: vi.fn() };
    const sessionManager: any = new EventEmitter();
    sessionManager.listSessions = vi.fn(() => []);
    sessionManager.getSession = vi.fn(() => undefined);
    const mainWindow: any = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    const skillProvider: any = {
      configStore: { getPackages: vi.fn(() => ({})) },
      install: vi.fn(),
      installMany: vi.fn(),
      ensureBundledPluginsInstalled: vi.fn(),
      ensureMigrated: vi.fn(),
    };
    const registry = new WindowRegistry();

    // registerIpcHandlers itself is a plain function call, never memoized,
    // so each test gets its own fresh set of ipcMain.handle registrations
    // even though the module itself (with its module-scope side effects) is
    // only ever evaluated once, on the first import.
    const { registerIpcHandlers } = await import('../src/main/ipc-handlers');
    registerIpcHandlers(
      mockIpcMain as any,
      sessionManager as any,
      mainWindow as any,
      skillProvider as any,
      undefined as any, // commandProvider
      undefined as any, // hookRelay
      undefined as any, // remoteConfig
      undefined as any, // remoteServer
      registry as any,
    );

    const handler = (mockIpcMain.handle as any).mock.calls.find((c: any) => c[0] === IPC.NATIVE_SUBMIT_ADMIN_PASSWORD)[1];
    return handler as (event: unknown, payload: { requestId: string; password: unknown }) => Promise<boolean> | boolean;
  }

  it('returns false for a non-string password, without throwing', async () => {
    // The handler's fixed guard branch returns a plain `false` synchronously
    // (never a Promise) — `await` unwraps either shape the same way, so
    // this also proves the call never THROWS for any of these payloads.
    const handler = await buildHandlers();
    expect(await handler({}, { requestId: 'r1', password: 12345 as any })).toBe(false);
    expect(await handler({}, { requestId: 'r1', password: null as any })).toBe(false);
    expect(await handler({}, { requestId: 'r1', password: undefined as any })).toBe(false);
    expect(await handler({}, { requestId: 'r1', password: { toString: () => 'x' } as any })).toBe(false);
  });

  it('returns false for an empty string password, without throwing', async () => {
    const handler = await buildHandlers();
    expect(await handler({}, { requestId: 'r1', password: '' })).toBe(false);
  });

  it('never logs the requestId or the malformed password value anywhere', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const handler = await buildHandlers();
      const sentinelRequestId = 'sentinel-request-id-99182';
      await handler({}, { requestId: sentinelRequestId, password: { evil: 'not-a-string' } as any });
      for (const spy of [logSpy, warnSpy, errorSpy]) {
        for (const call of spy.mock.calls) {
          const joined = JSON.stringify(call);
          expect(joined).not.toContain(sentinelRequestId);
          expect(joined).not.toContain('not-a-string');
        }
      }
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
