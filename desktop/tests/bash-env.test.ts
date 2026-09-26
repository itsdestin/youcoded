// bash-env.test.ts — admin-password design §2.3/§11 task 5: the Bash tool's
// own half of the sudo wiring — SUDO_ASKPASS/YOUCODED_ASKPASS_SOCKET/
// YOUCODED_ASKPASS_RUNTIME applied AFTER shellEnv/persistent_env, never
// persisted, and the NODE_OPTIONS-class drop. No real askpass server or
// sudo runs here — just env-var plumbing through a real `bash -c`.
//
// Review fix (task 5 review, T5-1/T5-2): `ADMIN_ENV.SUDO_ASKPASS` used to be
// hand-written to a value pointing at `askpass.cjs` — the exact wrong value
// the real wiring shipped with (SUDO_ASKPASS must be the executable wrapper
// `youcoded-askpass`, never the non-executable `askpass.cjs` it eventually
// execs into). Built from the REAL production resolver
// (`ipc-handlers.ts`'s `resolveAskpassPaths`) instead, so this fixture can
// never silently diverge from what the app actually wires again.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BashTool, setAdminPasswordAvailable } from '../src/main/harness/tools/bash';
import type { ToolContext } from '../src/main/harness/tools/types';

// `ipc-handlers.ts` imports `./main`, which runs module-scope side effects
// (`installCrashDiagnostics(app)`, an `app.on(...)` call) the instant it is
// imported — a resolver-only `{isPackaged, getAppPath}` stub throws before
// `resolveAskpassPaths` is even reachable (observed: passes run alone,
// fails when other files' fuller electron mocks share this worker's module
// registry first). Same comprehensive shape `tearoff-handoff.test.ts` and
// `admin-password-wiring.test.ts` already need for the same reason.
vi.mock('electron', () => {
  const BrowserWindowMock: any = vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }));
  BrowserWindowMock.getAllWindows = vi.fn(() => []);
  return {
    app: {
      isPackaged: false,
      getAppPath: () => path.resolve(__dirname, '..'), // desktop/ — resolveAskpassPaths' own dev branch
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
});

let dir: string;
const TEST_SESSION_ID = `test-bash-env-${process.pid}`;

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: TEST_SESSION_ID,
    cwd: dir,
    signal: new AbortController().signal,
    readRegistry: new Map(),
    todos: [],
    ...over,
  };
}

let ADMIN_ENV: { SUDO_ASKPASS: string; YOUCODED_ASKPASS_SOCKET: string; YOUCODED_ASKPASS_RUNTIME: string };

beforeAll(async () => {
  const { resolveAskpassPaths } = await import('../src/main/ipc-handlers');
  const paths = await resolveAskpassPaths();
  if (!paths) throw new Error('resolveAskpassPaths() found nothing on disk — scripts/askpass/ moved?');
  ADMIN_ENV = {
    SUDO_ASKPASS: paths.wrapperRealpath,
    YOUCODED_ASKPASS_SOCKET: '/run/user/1000/youcoded/askpass-123.sock',
    YOUCODED_ASKPASS_RUNTIME: process.execPath,
  };
  // The one assertion T5-1 was missing, right at the fixture's own source:
  // this MUST be the wrapper, never the non-executable askpass.cjs it execs
  // into (admin-password-wiring.test.ts pins the full resolver contract).
  if (!ADMIN_ENV.SUDO_ASKPASS.endsWith('youcoded-askpass')) {
    throw new Error(`SUDO_ASKPASS fixture is not the wrapper: ${ADMIN_ENV.SUDO_ASKPASS}`);
  }
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-env-'));
});
afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  } catch {
    /* best-effort */
  }
});

// admin-password design section 2.3 — the SUDO_ASKPASS/socket/runtime vars.
describe('Bash env — the sudo askpass variables', () => {
  it('sets SUDO_ASKPASS / YOUCODED_ASKPASS_SOCKET / YOUCODED_ASKPASS_RUNTIME when the askpass server is available', async () => {
    const ctx = makeCtx({ adminPasswordEnv: ADMIN_ENV });
    const r = await BashTool.execute({ command: 'echo "$SUDO_ASKPASS|$YOUCODED_ASKPASS_SOCKET|$YOUCODED_ASKPASS_RUNTIME"' }, ctx);
    expect(r.text).toContain(`${ADMIN_ENV.SUDO_ASKPASS}|${ADMIN_ENV.YOUCODED_ASKPASS_SOCKET}|${ADMIN_ENV.YOUCODED_ASKPASS_RUNTIME}`);
  });

  it('is absent entirely when the askpass server never started (ctx.adminPasswordEnv unset) — sudo fails exactly as before', async () => {
    const ctx = makeCtx();
    const r = await BashTool.execute({ command: 'echo "[$SUDO_ASKPASS][$YOUCODED_ASKPASS_SOCKET][$YOUCODED_ASKPASS_RUNTIME]"' }, ctx);
    expect(r.text).toContain('[][][]');
  });

  it('wins over a persisted shellEnv value from an earlier persistent_env call (applied AFTER shellEnv)', async () => {
    const ctx = makeCtx({ adminPasswordEnv: ADMIN_ENV, shellEnv: { SUDO_ASKPASS: '/evil/askpass' } });
    const r = await BashTool.execute({ command: 'echo "$SUDO_ASKPASS"' }, ctx);
    expect(r.text).toContain(ADMIN_ENV.SUDO_ASKPASS);
    expect(r.text).not.toContain('/evil/askpass');
  });

  it('is NEVER persisted, even when the command exports a different value under persistent_env:true', async () => {
    let captured: Record<string, string> | undefined;
    const ctx = makeCtx({
      adminPasswordEnv: ADMIN_ENV,
      setShellEnv: (next) => {
        captured = next;
      },
    });
    const r = await BashTool.execute({ command: 'export SUDO_ASKPASS=/evil/askpass', persistent_env: true }, ctx);
    expect(r.isError).toBeFalsy();
    expect(captured).toBeDefined();
    expect(captured?.SUDO_ASKPASS).toBeUndefined();
    expect(captured?.YOUCODED_ASKPASS_SOCKET).toBeUndefined();
    expect(captured?.YOUCODED_ASKPASS_RUNTIME).toBeUndefined();
  });

  it('drops NODE_OPTIONS / NODE_REPL_EXTERNAL_MODULE / NODE_V8_COVERAGE / ELECTRON_RUN_AS_NODE inherited from the app, for every call', async () => {
    const saved = {
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      NODE_REPL_EXTERNAL_MODULE: process.env.NODE_REPL_EXTERNAL_MODULE,
      NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE,
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
    };
    process.env.NODE_OPTIONS = '--require=/tmp/evil.js';
    process.env.NODE_REPL_EXTERNAL_MODULE = '/tmp/evil.js';
    process.env.NODE_V8_COVERAGE = '/tmp/cov';
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      const ctx = makeCtx();
      const r = await BashTool.execute(
        { command: 'echo "[$NODE_OPTIONS][$NODE_REPL_EXTERNAL_MODULE][$NODE_V8_COVERAGE][$ELECTRON_RUN_AS_NODE]"' },
        ctx,
      );
      expect(r.text).toContain('[][][][]');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
        else process.env[key] = value;
      }
    }
  });

  it('a command CAN still override the vars for its own process — the app is simply never asked', async () => {
    // `export` (not a prefix assignment) so the SAME shell's own expansion
    // of $SUDO_ASKPASS below sees the new value — a prefix assignment
    // (`VAR=x cmd "$VAR"`) is expanded by the shell BEFORE it applies to
    // cmd's own environment, which would test bash semantics, not this code.
    const ctx = makeCtx({ adminPasswordEnv: ADMIN_ENV });
    const r = await BashTool.execute({ command: 'export SUDO_ASKPASS=/its/own/helper\necho "$SUDO_ASKPASS"' }, ctx);
    expect(r.text).toContain('/its/own/helper');
  });

  it('run_in_background starts share the SAME spawnEnv, so the vars reach a backgrounded command too', async () => {
    const started: any[] = [];
    const shells = {
      start: (spec: any) => {
        started.push(spec);
        return { ok: false as const, reason: 'spawn-failed' as const, detail: 'not actually started in this test' };
      },
    };
    const ctx = makeCtx({ adminPasswordEnv: ADMIN_ENV, shells: shells as any });
    await BashTool.execute({ command: 'sleep 1', run_in_background: true }, ctx);
    expect(started).toHaveLength(1);
    expect(started[0].env.SUDO_ASKPASS).toBe(ADMIN_ENV.SUDO_ASKPASS);
    expect(started[0].env.YOUCODED_ASKPASS_SOCKET).toBe(ADMIN_ENV.YOUCODED_ASKPASS_SOCKET);
  });

  // F2 (code review): a plain foreground admin command never touches
  // ShellRegistry at all — `ctx.shells.clearAccepted` is the one signal that
  // tells the per-session ShellRegistry this toolCallId's "accepted" mark
  // (if any) is done, so `acceptedToolCallIds` does not leak one entry per
  // approved sudo for the life of the session.
  it('calls ctx.shells.clearAccepted with this call\'s toolCallId when a foreground command exits normally', async () => {
    const clearAccepted = vi.fn();
    const ctx = makeCtx({ toolCallId: 'call-123', shells: { clearAccepted } as any });
    const r = await BashTool.execute({ command: 'echo hi' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(clearAccepted).toHaveBeenCalledWith('call-123');
  });

  it('calls ctx.shells.clearAccepted even when the foreground command exits non-zero', async () => {
    const clearAccepted = vi.fn();
    const ctx = makeCtx({ toolCallId: 'call-456', shells: { clearAccepted } as any });
    const r = await BashTool.execute({ command: 'exit 3' }, ctx);
    expect(r.isError).toBe(true);
    expect(clearAccepted).toHaveBeenCalledWith('call-456');
  });
});

// F1 (code review): where the password card can never appear (macOS,
// Windows, or a Linux self-test failure), the description must say so
// instead of unconditionally claiming sudo works with a password.
describe('Bash description — reflects whether the password card is actually available (F1)', () => {
  afterEach(() => {
    setAdminPasswordAvailable(false); // restore the default for every other test file
  });

  it('says sudo works with a password card when the feature is available', () => {
    setAdminPasswordAvailable(true);
    const d = BashTool.description;
    expect(d).toContain('`sudo` works: the user types their admin password in a card');
    expect(d).not.toContain('only works here when the command needs no password');
  });

  it('says sudo only works without a password when the card is unavailable — never claims the card exists', () => {
    setAdminPasswordAvailable(false);
    const d = BashTool.description;
    expect(d).toContain('`sudo` only works here when the command needs no password (NOPASSWD)');
    expect(d).not.toContain('the user types their admin password in a card');
  });
});
