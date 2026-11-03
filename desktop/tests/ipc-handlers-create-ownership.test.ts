import {
  describe, it, expect, vi,
} from 'vitest';

// INVARIANT: `session:create` must call `windowRegistry.assignSession(...)` BEFORE SESSION_CREATED is forwarded to a renderer.
// WHY: sendForSession routes to the window that OWNS the session and falls back to window 1 when none is registered, so a session created or
// resumed from a SECOND window would pop open in window 1. The forward is deferred with process.nextTick, but on the `native` path the handler
// hits several awaits (nativeHost.resume) before assignSession, and nextTick outranks the promise microtask queue, so the forward wins the race.
// Claude Code sessions run straight through with no await. This records the real relative order of the two effects.

// Shared recording buffers (vi.hoisted so the electron mock factory can close over them).
const rec = vi.hoisted(() => ({
  // Ordered log of assignSession / SESSION_CREATED send, as they really ran.
  order: [] as string[],
  // Every send that reached a renderer: window, channel, payload.
  sends: [] as Array<{ window: string; channel: string; payload?: any }>,
}));

// Mock electron before importing ipc-handlers (which imports main.ts, whose module-scope protocol/Menu calls crash without it).
vi.mock('electron', () => {
  const BrowserWindowMock: any = vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }));
  BrowserWindowMock.getAllWindows = vi.fn(() => []);
  // A reused writer's focus request focuses its window (ipc-handlers createSession).
  BrowserWindowMock.fromWebContents = vi.fn(() => ({ focus: vi.fn() }));
  return {
    // whenReady must never resolve, or main.ts runs its whole init chain against unmocked APIs.
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
    // sendForSession resolves an owner through webContents.fromId; the stub records what it was sent, tagged with the window id.
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

// WHY: createRuntime starts an unawaited init on EVERY registration, so real providers.json writes could outlive the test (Linux CI hit an unhandled temp-rename ENOENT); provider-registry.test.ts tests the real initializer.
vi.mock('../src/main/providers/provider-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/providers/provider-registry')>();
  return {
    ...actual,
    ProviderRegistry: class extends actual.ProviderRegistry {
      override async init(): Promise<void> { /* storage is outside this fixture */ }
    },
  };
});

// Worker lifecycle is covered by session-discovery.test.ts; this fixture runs the real context builder behind an async boundary.
vi.mock('../src/main/session-discovery', async () => {
  const { buildClaudeCodeContext } = await import('../src/main/claude-code-context');
  return { sessionDiscovery: { claudeContext: vi.fn(async (cwd: string, model: string | null) => buildClaudeCodeContext(cwd, model)) } };
});

// NativeSessionHost is constructed inside registerIpcHandlers. Stubbed so the native branch is deterministic, and so `resume()` is a REAL async
// suspension point (a stub that never suspends would not reproduce the bug).
vi.mock('../src/main/harness/native-session-host', () => {
  // Inert stubs for everything registerIpcHandlers touches at registration time; only resume() matters here.
  class NativeSessionHostStub {
    async resume(_id: string, _cwd: string, _binding?: any) { return true; }
    async create(_opts: any) { /* no-op */ }
    getHarnessId(_id: string) { return undefined; }
    getBinding(_id: string) { return undefined; }
    modelForSession(_id: string) { return undefined; }
    async destroy(_id: string) { /* no-op */ }
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
import { registerWithRuntime } from './helpers/register-ipc';
import { IPC } from '../src/shared/types';
import { NativeHome } from '../src/main/native-home';

/** Build the mock world and run one `session:create`. `senderWindowId` is deliberately NOT 1: window 1 is the primary mainWindow, where a misrouted send lands. */
async function runSessionCreate(opts: any, senderWindowId = 2, liveSessions: any[] = [], managerExtras: Record<string, unknown> = {}) {
  rec.order.length = 0;
  rec.sends.length = 0;

  const mockIpcMain = { handle: vi.fn(), on: vi.fn() };

  // Real ownership map: `getOwner` answers only once assignSession has run (a permanently-known owner would hide the race).
  const owners = new Map<string, number>();

  const sessionInfo = {
    id: 'native-session-under-test',
    name: 'Resuming…',
    cwd: '/tmp',
    // Mirror the caller's provider so the control case walks the claude-code branch; 'claude' is the real SessionProvider member.
    provider: (opts?.provider ?? 'native') as 'native' | 'claude',
    status: 'active' as const,
    createdAt: Date.now(),
    permissionMode: 'normal' as const,
    skipPermissions: false,
  };

  // createSession emits 'session-created' SYNCHRONOUSLY, as session-manager.ts does; that is the crux of the bug (never fake it with a timer).
  const mockSessionManager: any = new EventEmitter();
  mockSessionManager.createSession = vi.fn(() => {
    mockSessionManager.emit('session-created', sessionInfo);
    return sessionInfo;
  });
  mockSessionManager.destroySession = vi.fn(() => true);
  mockSessionManager.listSessions = vi.fn(() => liveSessions);
  mockSessionManager.getSession = vi.fn(() => sessionInfo);
  mockSessionManager.sendInput = vi.fn();
  mockSessionManager.resizeSession = vi.fn();
  Object.assign(mockSessionManager, managerExtras);

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
    // The real registry's answer for this fake: the owner, else the primary-window fallback (one-core R5-1).
    resolveAudience: vi.fn((sessionId: string) => {
      const owner = owners.get(sessionId);
      const windowIds = owner != null ? [owner] : [];
      return { windowIds, socketIds: [] as number[], fallbackToPrimary: windowIds.length === 0 };
    }),
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

  registerWithRuntime(registerIpcHandlers, 
    mockIpcMain as any,
    mockSessionManager as any,
    mainWindow as any,
    mockSkillProvider as any,
    undefined as any, // commandProvider (required by the signature; this test passes none)
    undefined, // hookRelay
    undefined, // remoteConfig
    undefined, // remoteServer
    windowRegistry as any,
  );

  const handler = (mockIpcMain.handle as any).mock.calls.find(
    (c: any) => c[0] === IPC.SESSION_CREATE,
  )[1];

  // Dispatch the handler from a MACROTASK, not a bare `await`: Electron invokes ipcMain.handle from the native event loop, so when the handler
  // suspends the stack unwinds fully and nextTick drains BEFORE the microtask queue (the bug's window). Awaiting directly from an async test
  // keeps draining microtasks first and hides the bug (verified: [assign, tick] direct vs [tick, assign] under setImmediate).
  let result: any;
  await new Promise<void>((resolve, reject) => {
    setImmediate(() => {
      Promise.resolve(handler({ sender: { id: senderWindowId } }, opts)).then((r) => { result = r; resolve(); }, reject);
    });
  });

  // Drain nextTick and trailing tasks so a LATE send isn't mistaken for no send.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  if (opts?.provider === 'claude' && mockSessionManager.createSession.mock.calls.length) {
    await vi.waitFor(() => expect(rec.sends.some((s) => s.channel === IPC.NATIVE_SESSION_CONTEXT)).toBe(true));
  }
  return { order: [...rec.order], sends: [...rec.sends], assignSession, result, createSession: mockSessionManager.createSession };
}

function assertAssignBeforeCreated(order: string[], sends: Array<{ window: string; channel: string }>, label: string) {
  const assignAt = order.indexOf('assignSession');
  const createdAt = order.indexOf('SESSION_CREATED send');
  // Non-vacuity: both effects must have happened.
  expect(assignAt, `${label}: assignSession was never called — observed order: ${JSON.stringify(order)}`).toBeGreaterThanOrEqual(0);
  expect(createdAt, `${label}: SESSION_CREATED was never sent — observed order: ${JSON.stringify(order)}`).toBeGreaterThanOrEqual(0);
  const createdSend = sends.find((s) => s.channel === IPC.SESSION_CREATED);
  expect(assignAt < createdAt,
    `${label}: SESSION_CREATED was sent BEFORE assignSession, so sendForSession took its ownerless fallback and delivered to ${createdSend?.window ?? '<unknown window>'}. observed order: ${JSON.stringify(order)}`,
  ).toBe(true);
}

describe('session:create — assignSession must precede the SESSION_CREATED forward', () => {
  it('the ownership fixture starts no background provider persistence', async () => {
    const writes = vi.spyOn(NativeHome.prototype, 'mutateJson');
    try {
      await runSessionCreate({ provider: 'claude', cwd: '/tmp' });
      expect(writes.mock.calls.filter(([file]) => file === 'providers.json')).toEqual([]);
    } finally { writes.mockRestore(); }
  });

  it.each([
    ['native create', { provider: 'native', cwd: '/tmp', name: 'New chat', skipPermissions: false, binding: { providerId: 'test-provider', modelId: 'test-model' } }],
    ['native resume', { provider: 'native', resumeSessionId: 'native-session-under-test', cwd: '/tmp', name: 'Resuming…', skipPermissions: false }],
    // Control: the claude-code path has no intervening await.
    ['claude-code create', { provider: 'claude-code', cwd: '/tmp', name: 'New chat', skipPermissions: false }],
  ])('%s: assigns ownership before forwarding SESSION_CREATED', async (label, opts) => {
    const { order, sends } = await runSessionCreate(opts);
    assertAssignBeforeCreated(order, sends, label);
  });
});

// WHY: contract R23 says EVERY chat carries the "what the assistant was given" line; a Claude Code chat has no host, so this branch of session:create is the only sender, and its absence is SILENT.
describe('session:create — a Claude Code chat is described too', () => {
  it('announces ownership before a delayed context discovery finishes', async () => {
    const { sessionDiscovery } = await import('../src/main/session-discovery');
    const { buildClaudeCodeContext } = await import('../src/main/claude-code-context');
    let release!: (context: ReturnType<typeof buildClaudeCodeContext>) => void;
    vi.mocked(sessionDiscovery.claudeContext).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const creating = runSessionCreate({ provider: 'claude', cwd: '/tmp' });
    await vi.waitFor(() => expect(rec.order).toContain('SESSION_CREATED send'));
    expect(rec.sends.some((s) => s.channel === IPC.NATIVE_SESSION_CONTEXT)).toBe(false);
    release(buildClaudeCodeContext('/tmp', null));
    const result = await creating;
    assertAssignBeforeCreated(result.order, result.sends, 'delayed context');
    expect(result.sends.find((s) => s.channel === IPC.NATIVE_SESSION_CONTEXT)?.window).toBe('wc:2');
  });
  it('sends the context record, and it says Claude Code assembled it', async () => {
    const { sends } = await runSessionCreate({ provider: 'claude', cwd: '/tmp' });
    const pushed = sends.find((s) => s.channel === 'native:session-context');
    expect(pushed, `no native:session-context was sent — channels seen: ${JSON.stringify(sends.map((s) => s.channel))}`).toBeTruthy();
    expect(pushed!.payload.context.assembledBy).toBe('claude-code');
  });

  it('claims no tool list, rather than an empty one', async () => {
    // WHY: null reads as "Claude Code chooses its own"; [] would falsely read as "no tools".
    const { sends } = await runSessionCreate({ provider: 'claude', cwd: '/tmp' });
    const ctx = sends.find((s) => s.channel === 'native:session-context')!.payload.context;
    expect(ctx.tools).toBeNull();
    expect(ctx.systemPrompt).toBeNull();
    expect(ctx.contextWindowTokens).toBeNull();
  });

  it('does NOT send one for a native chat — the harness host owns that', async () => {
    // WHY: two records for one chat would race, and the host's knows the budget.
    const { sends } = await runSessionCreate({ provider: 'native', cwd: '/tmp', binding: { providerId: 'p', modelId: 'm' } });
    expect(sends.find((s) => s.channel === 'native:session-context')).toBeUndefined();
  });
});

// Resuming a conversation that is already open does not open it twice (answered through resume admission, `reused: true`).
describe('session:create — a conversation already open is not resumed a second time', () => {
  it('answers with the open session instead of creating a second one', async () => {
    const open = {
      id: 'native-open', name: 'My chat', cwd: '/tmp', provider: 'native', status: 'active',
      createdAt: 1, permissionMode: 'normal', skipPermissions: false,
    };
    const { result, createSession, sends } = await runSessionCreate({
      provider: 'native', resumeSessionId: 'native-open', cwd: '/tmp', name: 'Resuming…', skipPermissions: false,
    }, 2, [open]);
    expect(createSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'native-open', reused: true });
    // An already-open session nobody owns is still brought forward: the focus request goes to the leader window.
    expect(sends.some((x) => x.channel === 'session:focus-request' && x.payload === 'native-open')).toBe(true);
    expect(sends.find((s) => s.channel === IPC.SESSION_CREATED)).toBeUndefined();
  });

  it('catches a second resume before Claude Code has reported the first one in', async () => {
    // WHY: the desktop->Claude id map fills in only at the first hook; until then the session manager alone knows which conversation it holds.
    const pending = {
      id: 'desk-9', name: 'Resuming…', cwd: '/tmp', provider: 'claude', status: 'active',
      createdAt: 1, permissionMode: 'normal', skipPermissions: false,
    };
    const { result, createSession } = await runSessionCreate({
      provider: 'claude', resumeSessionId: 'claude-X', cwd: '/tmp', name: 'Resuming…', skipPermissions: false,
    }, 2, [pending], { resumedConversationOf: (id: string) => (id === 'desk-9' ? 'claude-X' : undefined) });
    expect(createSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'desk-9', reused: true });
  });

  it('still resumes when no open session holds the conversation', async () => {
    const other = {
      id: 'some-other', name: 'x', cwd: '/tmp', provider: 'native', status: 'active',
      createdAt: 1, permissionMode: 'normal', skipPermissions: false,
    };
    const { result, createSession } = await runSessionCreate({
      provider: 'native', resumeSessionId: 'native-session-under-test', cwd: '/tmp', name: 'Resuming…', skipPermissions: false,
    }, 2, [other]);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(result?.reused).toBeUndefined();
  });
});
