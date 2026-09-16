import {
  describe, it, expect, vi,
} from 'vitest';

// ---------------------------------------------------------------------------
// INVARIANT UNDER TEST
//
// `session:create` must call `windowRegistry.assignSession(...)` BEFORE the
// SESSION_CREATED event is forwarded to a renderer.
//
// Why it matters: `sendForSession` (ipc-handlers.ts) routes a session-scoped
// event to the window that OWNS the session. If no owner is registered yet it
// takes its ownerless fallback and sends to the primary `mainWindow` — window
// 1. So if SESSION_CREATED goes out before `assignSession`, a session created
// (or resumed) from a SECOND main window is delivered to window 1: the user
// clicks "new chat" / "resume" in window 2 and the conversation pops open in
// window 1 instead.
//
// The forward is already deferred via `process.nextTick` for exactly this
// reason — the comment above the `sessionManager.on('session-created', ...)`
// listener says so. But `nextTick` only buys ordering against work that runs
// to completion synchronously. On the `provider: 'native'` path the handler
// hits several `await`s (notably `nativeHost.resume(...)`) before it reaches
// `assignSession` at the very end of the handler. The moment the handler
// suspends at its first `await`, Node drains the nextTick queue — and nextTick
// outranks the promise microtask queue — so the forward wins the race and the
// ownerless fallback fires.
//
// Claude Code sessions are unaffected: that branch runs straight through to
// `assignSession` with no intervening await.
//
// This test records the real relative order of the two observable effects and
// asserts assign-then-send. It reproduces the bug on today's code.
// ---------------------------------------------------------------------------

// Shared recording buffers. Declared through vi.hoisted so the hoisted
// vi.mock('electron') factory below can close over them.
const rec = vi.hoisted(() => ({
  // Ordered log of the two events we care about, in the order they really ran.
  order: [] as string[],
  // Every send that reached a renderer: which window, which channel, and what
  // rode with it (the payload matters for the session-context block below).
  sends: [] as Array<{ window: string; channel: string; payload?: any }>,
}));

// Mock electron before importing ipc-handlers, which transitively imports
// main.ts (for setPermissionOverrides). main.ts uses protocol.registerSchemesAsPrivileged
// and Menu.setApplicationMenu at module scope, both of which crash without this mock.
vi.mock('electron', () => {
  const BrowserWindowMock: any = vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }));
  BrowserWindowMock.getAllWindows = vi.fn(() => []);
  return {
    // whenReady must never resolve — otherwise main.ts runs its entire init chain
    // (createWindow, RemoteServer, SyncService, etc.) which hits unmocked APIs.
    app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0-test'), whenReady: vi.fn(() => new Promise(() => {})), on: vi.fn(), quit: vi.fn(), setAppUserModelId: vi.fn(), commandLine: { appendSwitch: vi.fn() }, getGPUInfo: vi.fn(() => new Promise(() => {})) },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    BrowserWindow: BrowserWindowMock,
    Menu: { setApplicationMenu: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    dialog: { showOpenDialog: vi.fn() },
    clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) },
    nativeImage: {},
    shell: { openExternal: vi.fn() },
    powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
    // sendForSession resolves an owner's webContents.id through webContents.fromId.
    // Hand back a stub that records what it was sent, tagged with the window id.
    webContents: {
      fromId: vi.fn((id: number) => ({
        isDestroyed: () => false,
        send: (channel: string, ...args: any[]) => {
          rec.sends.push({ window: `wc:${id}`, channel, payload: args[0] });
          if (channel === 'session:created') rec.order.push('SESSION_CREATED send');
        },
      })),
    },
  };
});

// NativeSessionHost is constructed inside registerIpcHandlers. Stub it so the
// native branch is deterministic — and crucially so `resume()` is a REAL async
// suspension point (`async () => true`), which is what lets the nextTick queue
// drain mid-handler. A stub that never suspends would not reproduce the bug.
vi.mock('../src/main/harness/native-session-host', () => {
  class NativeSessionHostStub {
    constructor(..._args: any[]) { void _args; /* ctor deps unused by this test */ }

    async resume(_id: string, _cwd: string, _binding?: any) { return true; }

    async create(_opts: any) { /* no-op */ }

    getHarnessId(_id: string) { return undefined; }

    getBinding(_id: string) { return undefined; }

    modelForSession(_id: string) { return undefined; }

    async destroy(_id: string) { /* no-op */ }

    // Remaining surface registerIpcHandlers touches at registration time (or
    // could touch from a sibling handler) — inert stubs, none of them run on
    // the code path this test exercises.
    setModelReleasedHandler(_fn: any) { /* no-op */ }

    async destroyAll() { /* no-op */ }

    async clear(_id: string) { /* no-op */ }

    async compact(_id: string) { /* no-op */ }

    async quiesce(_id: string) { /* no-op */ }

    async interrupt(_id: string) { /* no-op */ }

    async send(_id: string, _text: string) { /* no-op */ }

    async invokeSkill() { /* no-op */ }

    getHistory(_id: string) { return []; }

    getPermissionMode(_id: string) { return 'normal'; }

    setPermissionMode() { /* no-op */ }

    respondPermission() { /* no-op */ }

    removeQueued() { /* no-op */ }

    setBinding() { /* no-op */ }

    sessionsForModel(_modelId: string) { return [] as string[]; }

    isNativeSessionId(_id: string) { return true; }

    list() { return [] as any[]; }

    on() { return this; }

    off() { return this; }

    removeAllListeners() { return this; }
  }
  return { NativeSessionHost: NativeSessionHostStub };
});

import { EventEmitter } from 'node:events';
import { registerIpcHandlers } from '../src/main/ipc-handlers';
import { IPC } from '../src/shared/types';

/**
 * Build the mock world and run one `session:create` call.
 *
 * `senderWindowId` is deliberately NOT 1 — the primary mainWindow stands in for
 * window 1, so a send that lands there is exactly the misrouting this test is
 * about.
 */
async function runSessionCreate(opts: any, senderWindowId = 2) {
  rec.order.length = 0;
  rec.sends.length = 0;

  const mockIpcMain = { handle: vi.fn(), on: vi.fn() };

  // Real ownership map so `getOwner` only answers once assignSession has run —
  // faking a permanently-known owner would hide the very race under test.
  const owners = new Map<string, number>();

  const sessionInfo = {
    id: 'native-session-under-test',
    name: 'Resuming…',
    cwd: '/tmp',
    // Mirror the caller's provider so the control case really walks the
    // claude-code branch rather than the native one.
    // 'claude' is the real SessionProvider member — NOT 'claude-code', which is
    // what this line said until 2026-09-10. Nothing read it, so the typo was
    // harmless until a test needed the Claude Code branch to actually run.
    provider: (opts?.provider ?? 'native') as 'native' | 'claude',
    status: 'active' as const,
    createdAt: Date.now(),
    permissionMode: 'normal' as const,
    skipPermissions: false,
  };

  // A real EventEmitter whose createSession emits 'session-created'
  // SYNCHRONOUSLY, exactly as session-manager.ts does (native: line ~106).
  // That synchronous emit is the crux of the bug — never fake it with a timer.
  const mockSessionManager: any = new EventEmitter();
  mockSessionManager.createSession = vi.fn(() => {
    mockSessionManager.emit('session-created', sessionInfo);
    return sessionInfo;
  });
  mockSessionManager.destroySession = vi.fn(() => true);
  mockSessionManager.listSessions = vi.fn(() => []);
  mockSessionManager.getSession = vi.fn(() => sessionInfo);
  mockSessionManager.sendInput = vi.fn();
  mockSessionManager.resizeSession = vi.fn();

  const mainWindow: any = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, ...args: any[]) => {
        rec.sends.push({ window: 'mainWindow(window 1 fallback)', channel, payload: args[0] });
        if (channel === IPC.SESSION_CREATED) rec.order.push('SESSION_CREATED send');
      },
    },
  };

  const mockSkillProvider: any = {
    configStore: { getPackages: vi.fn(() => ({})) },
    install: vi.fn(),
    installMany: vi.fn(),
    ensureBundledPluginsInstalled: vi.fn(),
    ensureMigrated: vi.fn(),
  };

  const assignSession = vi.fn((sessionId: string, windowId: number) => {
    owners.set(sessionId, windowId);
    rec.order.push('assignSession');
  });

  const windowRegistry: any = {
    assignSession,
    releaseSession: vi.fn(),
    getOwner: vi.fn((sessionId: string) => owners.get(sessionId)),
    getSubscribers: vi.fn(() => [] as number[]),
    getKind: vi.fn(() => 'main'),
    getLeaderId: vi.fn(() => 1),
    getWindowIds: vi.fn(() => [1, senderWindowId]),
    getDirectory: vi.fn(() => ({ windows: [], sessions: [] })),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    removeAllListeners: vi.fn(),
  };

  registerIpcHandlers(
    mockIpcMain as any,
    mockSessionManager as any,
    mainWindow as any,
    mockSkillProvider as any,
    undefined, // commandProvider
    undefined, // hookRelay
    undefined, // remoteConfig
    undefined, // remoteServer
    windowRegistry as any,
  );

  const handler = (mockIpcMain.handle as any).mock.calls.find(
    (c: any) => c[0] === IPC.SESSION_CREATE,
  )[1];

  // Dispatch the handler from a MACROTASK, not with a bare `await`.
  //
  // This is load-bearing, not ceremony. Electron invokes an `ipcMain.handle`
  // callback from the native event loop, so when the handler suspends at its
  // first `await` the JS stack unwinds all the way out and Node drains the
  // process.nextTick queue before the promise microtask queue — which is
  // exactly the window the bug lives in.
  //
  // Calling `await handler(...)` directly from an async test does NOT model
  // that: the test function is itself running as a microtask continuation, so
  // the microtask queue keeps draining (resuming the handler) before nextTick
  // ever gets a turn. Under that calling convention the bug is invisible and
  // the assertion below passes for the wrong reason. Verified empirically:
  // the same handler shape logs [assign, tick] under a direct await and
  // [tick, assign] under setImmediate dispatch.
  await new Promise<void>((resolve, reject) => {
    setImmediate(() => {
      Promise.resolve(handler({ sender: { id: senderWindowId } }, opts)).then(() => resolve(), reject);
    });
  });

  // Drain the nextTick queue and any trailing microtasks/macrotasks so a send
  // that merely ran LATE isn't mistaken for a send that never happened.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  return { order: [...rec.order], sends: [...rec.sends], assignSession };
}

function assertAssignBeforeCreated(order: string[], sends: Array<{ window: string; channel: string }>, label: string) {
  const assignAt = order.indexOf('assignSession');
  const createdAt = order.indexOf('SESSION_CREATED send');

  // Sanity: both effects must actually have happened, or the ordering claim
  // below would pass vacuously.
  expect(assignAt, `${label}: assignSession was never called — observed order: ${JSON.stringify(order)}`).toBeGreaterThanOrEqual(0);
  expect(createdAt, `${label}: SESSION_CREATED was never sent — observed order: ${JSON.stringify(order)}`).toBeGreaterThanOrEqual(0);

  const createdSend = sends.find((s) => s.channel === IPC.SESSION_CREATED);
  const detail = [
    `${label}:`,
    `SESSION_CREATED was sent BEFORE assignSession — ownership was not set yet, so`,
    `sendForSession took its ownerless fallback and delivered the session to`,
    `${createdSend?.window ?? '<unknown window>'} instead of the window that created it.`,
    `observed order: ${JSON.stringify(order)}`,
    `(expected: assignSession, then SESSION_CREATED send)`,
  ].join('\n  ');

  expect(assignAt < createdAt, detail).toBe(true);
}

describe('session:create — assignSession must precede the SESSION_CREATED forward', () => {
  it('native create: assigns ownership before forwarding SESSION_CREATED', async () => {
    const { order, sends, assignSession } = await runSessionCreate({
      provider: 'native',
      cwd: '/tmp',
      name: 'New chat',
      skipPermissions: false,
      binding: { providerId: 'test-provider', modelId: 'test-model' },
    });

    // Guard: the bug only manifests if the handler actually suspended on the
    // native path. If assignSession never ran the sanity check below catches it.
    expect(assignSession).toHaveBeenCalled();
    assertAssignBeforeCreated(order, sends, 'native create');
  });

  it('native resume: assigns ownership before forwarding SESSION_CREATED', async () => {
    const { order, sends } = await runSessionCreate({
      provider: 'native',
      resumeSessionId: 'native-session-under-test',
      cwd: '/tmp',
      name: 'Resuming…',
      skipPermissions: false,
    });

    assertAssignBeforeCreated(order, sends, 'native resume');
  });

  it('claude-code create: assigns ownership before forwarding SESSION_CREATED (control — this path has no intervening await)', async () => {
    const { order, sends } = await runSessionCreate({
      provider: 'claude-code',
      cwd: '/tmp',
      name: 'New chat',
      skipPermissions: false,
    });

    assertAssignBeforeCreated(order, sends, 'claude-code create');
  });
});

// ---------------------------------------------------------------------------
// A CLAUDE CODE chat still gets its "what the assistant was given" record.
//
// Contract R23 says EVERY chat carries the line above the conversation. The
// native runtime pushes its own record from the harness host; a Claude Code
// chat has no host here, so this branch of session:create is the only thing
// that sends one. Nothing else in the suite walks it, and its absence is
// SILENT — the strip simply never appears, which is indistinguishable from
// "this chat was given nothing".
// ---------------------------------------------------------------------------
describe('session:create — a Claude Code chat is described too', () => {
  it('sends the context record, and it says Claude Code assembled it', async () => {
    const { sends } = await runSessionCreate({ provider: 'claude', cwd: '/tmp' });
    const pushed = sends.find((s) => s.channel === 'native:session-context');
    expect(pushed, `no native:session-context was sent — channels seen: ${JSON.stringify(sends.map((s) => s.channel))}`).toBeTruthy();
    expect(pushed!.payload.context.assembledBy).toBe('claude-code');
  });

  it('claims no tool list, rather than an empty one', async () => {
    // null reads as "Claude Code chooses its own"; [] reads as "this assistant
    // has no tools", which is false in the more alarming direction.
    const { sends } = await runSessionCreate({ provider: 'claude', cwd: '/tmp' });
    const ctx = sends.find((s) => s.channel === 'native:session-context')!.payload.context;
    expect(ctx.tools).toBeNull();
    expect(ctx.systemPrompt).toBeNull();
    expect(ctx.contextWindowTokens).toBeNull();
  });

  it('does NOT send one for a native chat — the harness host owns that', async () => {
    // Two records for one chat would race, and the host's is the one that knows
    // the budget things were sized against.
    const { sends } = await runSessionCreate({ provider: 'native', cwd: '/tmp' });
    expect(sends.find((s) => s.channel === 'native:session-context')).toBeUndefined();
  });
});
