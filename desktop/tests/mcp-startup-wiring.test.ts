// Proves ipc-handlers.ts builds a REAL McpManager / catalog closures and hands the SAME instances into
// NativeSessionHost's constructor (a test that only checked "new McpManager was called" would pass even if
// the manager were discarded). It writes real ~/.youcoded files, captures the constructor args, and calls them.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// WHY mock mcp-client's createConnection (the seam every MCP test fakes): it still proves ipc-handlers wires
// THAT module's export as the manager's connectionFactory, without spawning a subprocess.
const createConnectionMock = vi.fn((server: { id: string }) => ({
  state: 'ready' as const,
  lastError: null,
  connect: async () => {},
  listTools: () => [{ name: 'demo_tool', description: 'd', inputSchema: { type: 'object' } }],
  callTool: async () => ({ text: 'ok', isError: false }),
  close: async () => {},
}));
vi.mock('../src/main/harness/mcp/mcp-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/harness/mcp/mcp-client')>();
  return { ...actual, createConnection: createConnectionMock };
});

// Spies on ModelCatalog.get() (extends + delegates). `catalogRowsOverride` makes get() answer with given rows, so a
// test can prove the row's supportsVision comes back out (a real get() here would answer null, same as an unwired closure).
const modelCatalogGetSpy = vi.fn();
let catalogRowsOverride: unknown[] | null = null;
vi.mock('../src/main/providers/model-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/providers/model-catalog')>();
  class SpyModelCatalog extends actual.ModelCatalog {
    get(...args: Parameters<InstanceType<typeof actual.ModelCatalog>['get']>) {
      modelCatalogGetSpy(...args);
      if (catalogRowsOverride) return Promise.resolve(catalogRowsOverride as any);
      return super.get(...args);
    }
  }
  return { ...actual, ModelCatalog: SpyModelCatalog };
});

// Captures the real args NativeSessionHost's constructor receives (extends + delegates via super()), so the
// positional closures ipc-handlers passes can be inspected without exporting them.
let capturedCtorArgs: unknown[] | undefined;
vi.mock('../src/main/harness/native-session-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/harness/native-session-host')>();
  class SpyNativeSessionHost extends actual.NativeSessionHost {
    constructor(...args: unknown[]) {
      // @ts-expect-error — spread into the real (positional) constructor
      super(...args);
      capturedCtorArgs = args;
    }
  }
  return { ...actual, NativeSessionHost: SpyNativeSessionHost };
});

// WHY: ipc-handlers constructs `new NativeHome()` with no override, so redirecting os.homedir() is what makes
// the test hit the same ~/.youcoded paths production reads.
let testHome: string;
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => testHome };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => testHome),
    getVersion: vi.fn(() => '0.0.0-test'),
    whenReady: vi.fn(() => new Promise(() => {})),
    on: vi.fn(),
    quit: vi.fn(),
    setAppUserModelId: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    getGPUInfo: vi.fn(() => new Promise(() => {})),
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } })),
  Menu: { setApplicationMenu: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) },
  nativeImage: {},
  shell: { openExternal: vi.fn() },
  powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
}));

function makeMockIpcMain() {
  return { handle: vi.fn(), on: vi.fn() };
}
function makeMockSessionManager() {
  return {
    createSession: vi.fn(() => ({ id: '1', name: 'test', cwd: '/tmp', status: 'active' })),
    destroySession: vi.fn(() => true),
    listSessions: vi.fn(() => []),
    sendInput: vi.fn(),
    resizeSession: vi.fn(),
    on: vi.fn(),
  };
}
function makeMockSkillProvider() {
  return {
    configStore: { getPackages: vi.fn(() => ({})) },
    getInstalled: vi.fn(() => []),
    listMarketplace: vi.fn(() => []),
    getSkillDetail: vi.fn(),
    search: vi.fn(() => []),
    install: vi.fn(),
    uninstall: vi.fn(),
    getFavorites: vi.fn(() => []),
    setFavorite: vi.fn(),
    getChips: vi.fn(() => []),
    setChips: vi.fn(),
    getOverrides: vi.fn(() => ({})),
    setOverride: vi.fn(),
    createPromptSkill: vi.fn(),
    deletePromptSkill: vi.fn(),
    publish: vi.fn(),
    generateShareLink: vi.fn(),
    importFromLink: vi.fn(),
    getCuratedDefaults: vi.fn(() => []),
  };
}

// WHY warmed in beforeAll: ipc-handlers is the biggest main-process import (timed out at 30s in a loaded run).
const IPC_HANDLERS_FIRST_IMPORT_BUDGET_MS = 120_000;

type Binding = { providerId: string; modelId: string };
type Closure<T> = (binding: Binding) => Promise<T>;
const LOCAL_PROVIDER = { id: 'local', type: 'local-engine', label: 'Local models (llama.cpp)', enabled: true };
const ANTHROPIC = { id: 'anthropic-test', type: 'anthropic', label: 'Anthropic', enabled: true };

/** A fresh home dir, with providers.json / mcp.json written BEFORE registerIpcHandlers runs (no race with
 *  ProviderRegistry.init()'s fire-and-forget seeding), then the real handlers registered. Returns the
 *  constructor args NativeSessionHost received. The dir is deliberately not removed: that init() writes
 *  into it after the test body returns, and deleting it would surface as a spurious unhandled rejection. */
async function wire(opts: { providers?: Record<string, unknown>[]; mcpServers?: unknown[] } = {}): Promise<unknown[]> {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-wiring-'));
  capturedCtorArgs = undefined;
  createConnectionMock.mockClear();
  modelCatalogGetSpy.mockClear();
  effectiveContextWindowSpy.mockClear();
  if (opts.providers || opts.mcpServers) fs.mkdirSync(path.join(testHome, '.youcoded'), { recursive: true });
  if (opts.providers) fs.writeFileSync(path.join(testHome, '.youcoded', 'providers.json'), JSON.stringify({ v: 1, providers: opts.providers }));
  if (opts.mcpServers) fs.writeFileSync(path.join(testHome, '.youcoded', 'mcp.json'), JSON.stringify({ servers: opts.mcpServers }));
  const { registerIpcHandlers } = await import('../src/main/ipc-handlers');
  const { registerWithRuntime } = await import('./helpers/register-ipc');
  registerWithRuntime(registerIpcHandlers,
    makeMockIpcMain() as any,
    makeMockSessionManager() as any,
    { webContents: { send: vi.fn() }, isDestroyed: () => false } as any,
    makeMockSkillProvider() as any, undefined as any,
  );
  expect(capturedCtorArgs).toBeDefined();
  return capturedCtorArgs!;
}

describe('McpManager startup wiring', () => {
  beforeAll(async () => {
    // The module reads the home folder as it loads, so it needs one to exist.
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-mcp-wiring-'));
    await import('../src/main/ipc-handlers');
  }, IPC_HANDLERS_FIRST_IMPORT_BUDGET_MS);

  type Acquirer = { acquire(sessionId: string): Promise<{ servers: Array<{ id: string; label: string; tools: unknown[] }> }> };

  it('threads a REAL, config-driven McpManager into NativeSessionHost', async () => {
    const args = await wire({ mcpServers: [
      { id: 'demo', label: 'Demo Server', enabled: true, transport: { type: 'stdio', command: 'node' }, origin: { kind: 'user' } },
    ] });
    // WHY not pinning total constructor arity: trailing host dependencies grow independently of MCP.
    expect(typeof args[9]).toBe('function');
    const mcpManager = args[10] as Acquirer;
    expect(typeof mcpManager.acquire).toBe('function');
    // acquire() really reads the hand-written mcp.json (if the wiring were removed this throws or returns []).
    const { servers: ready } = await mcpManager.acquire('test-session');
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe('demo');
    expect(ready[0].label).toBe('Demo Server');
    expect(ready[0].tools).toEqual([{ name: 'demo_tool', description: 'd', inputSchema: { type: 'object' } }]);
    // The wired factory is mcp-client's createConnection, invoked with the server read from disk.
    expect(createConnectionMock).toHaveBeenCalledTimes(1);
    expect(createConnectionMock.mock.calls[0][0]).toMatchObject({ id: 'demo' });
  });

  it('a user with no ~/.youcoded/mcp.json gets a silent no-op manager — no mcp.json, no subprocess, no error', async () => {
    const args = await wire();
    // Construction only READS; (the .youcoded dir may exist from ProviderRegistry's own init, so assert the file).
    expect(fs.existsSync(path.join(testHome, '.youcoded', 'mcp.json'))).toBe(false);
    const { servers: ready } = await (args[10] as Acquirer).acquire('test-session');
    expect(ready).toEqual([]);
    expect(createConnectionMock).not.toHaveBeenCalled();
  });
});

// visionSupportFor is the 5th positional constructor arg. It used to call modelCatalog.get() for every
// provider type (a second full catalog fetch on every cloud session start that can never answer); a LOCAL
// binding now consults it because llama-server's own /models answers vision for a paired projector.
describe('visionSupportFor: which bindings consult the catalog', () => {
  beforeEach(() => { catalogRowsOverride = null; });
  const vision = async (...providers: Record<string, unknown>[]) => (await wire({ providers }))[4] as Closure<boolean | null>;

  it('never calls modelCatalog.get() for an anthropic binding', async () => {
    const visionSupportFor = await vision(ANTHROPIC);
    expect(await visionSupportFor({ providerId: 'anthropic-test', modelId: 'claude-opus-5' })).toBeNull();
    expect(modelCatalogGetSpy).not.toHaveBeenCalled();
  });

  it('reads a LOCAL model\'s supportsVision straight out of the catalog', async () => {
    catalogRowsOverride = [{ id: 'SmolVLM-256M-Instruct-Q8_0', providerId: 'local', label: 'SmolVLM', supportsVision: true }];
    const visionSupportFor = await vision(LOCAL_PROVIDER);
    expect(await visionSupportFor({ providerId: 'local', modelId: 'SmolVLM-256M-Instruct-Q8_0' })).toBe(true);
    expect(modelCatalogGetSpy).toHaveBeenCalled();
  });

  // An enabled OpenRouter is in a local-only user's list too; handing the whole list would put two internet
  // fetches in front of every local session create, resume and swap.
  it('asks the catalog about the BINDING\'S provider only — an enabled OpenRouter is not dragged in', async () => {
    catalogRowsOverride = [{ id: 'some-gguf', providerId: 'local', label: 'g', supportsVision: true }];
    const visionSupportFor = await vision(LOCAL_PROVIDER, { id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true });
    await visionSupportFor({ providerId: 'local', modelId: 'some-gguf' });
    expect(modelCatalogGetSpy).toHaveBeenCalledTimes(1);
    expect((modelCatalogGetSpy.mock.calls[0][0] as Array<{ id: string }>).map((x) => x.id)).toEqual(['local']);
  });

  it('a LOCAL text-only row resolves to false, not to "don\'t know"', async () => {
    catalogRowsOverride = [{ id: 'text-only-Q8_0', providerId: 'local', label: 'Text only', supportsVision: false }];
    const visionSupportFor = await vision(LOCAL_PROVIDER);
    expect(await visionSupportFor({ providerId: 'local', modelId: 'text-only-Q8_0' })).toBe(false);
  });

  it('a LOCAL row the catalog cannot answer for degrades to null, and does not throw', async () => {
    catalogRowsOverride = [{ id: 'other-model', providerId: 'local', label: 'Other' }];
    const visionSupportFor = await vision(LOCAL_PROVIDER);
    expect(await visionSupportFor({ providerId: 'local', modelId: 'missing-model' })).toBeNull();
    expect(await visionSupportFor({ providerId: 'local', modelId: 'other-model' })).toBeNull();
  });
});

// pricingFor is the 6th positional arg. A local-engine binding costs nothing, so it must never pay for a catalog
// read; a hosted binding hands the catalog ONLY its own provider (the whole registry was built and discarded
// on every hosted create/resume/swap).
describe('pricingFor', () => {
  const pricing = async (...providers: Record<string, unknown>[]) => (await wire({ providers }))[5] as Closure<unknown>;

  it('never calls modelCatalog.get() for a local-engine binding', async () => {
    const pricingFor = await pricing(LOCAL_PROVIDER);
    expect(await pricingFor({ providerId: 'local', modelId: 'some-gguf' })).toBeNull();
    expect(modelCatalogGetSpy).not.toHaveBeenCalled();
  });

  it("hands the catalog ONLY the binding's own provider, never the whole registry", async () => {
    const pricingFor = await pricing(
      { id: 'or-a', type: 'openrouter', label: 'OpenRouter A', enabled: true },
      { id: 'or-b', type: 'openrouter', label: 'OpenRouter B', enabled: true },
      ANTHROPIC,
    );
    await pricingFor({ providerId: 'or-b', modelId: 'x' });
    expect(modelCatalogGetSpy).toHaveBeenCalledTimes(1);
    expect((modelCatalogGetSpy.mock.calls[0][0] as Array<{ id: string }>).map((p) => p.id)).toEqual(['or-b']);
  });

  it('returns null — not a guessed zero — for a metered model the catalog does not list', async () => {
    const pricingFor = await pricing(ANTHROPIC);
    expect(await pricingFor({ providerId: 'anthropic-test', modelId: 'not-in-any-catalog' })).toBeNull();
    expect(modelCatalogGetSpy).toHaveBeenCalled();   // a metered binding DOES consult the catalog
  });
});

// contextAndSlotsFor (3rd positional arg): ONE closure returns both values so there is no shared variable
// for an unrelated binding's resolution to stomp (an earlier two-closure design silently floored a local
// session's cap to 1). The overlapping NativeSessionHost.create() race lives in native-session-host.test.ts.
const effectiveContextWindowSpy = vi.fn<(modelId: string) => Promise<{ contextLength: number; totalSlots: number }>>(async () => ({ contextLength: 999, totalSlots: 3 }));
vi.mock('../src/main/engine/engine-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/engine-manager')>();
  class SpyEngineManager extends actual.EngineManager {
    effectiveContextWindow(modelId: string) { return effectiveContextWindowSpy(modelId); }
  }
  return { ...actual, EngineManager: SpyEngineManager };
});

describe('contextAndSlotsFor wiring', () => {
  const slots = async (...providers: Record<string, unknown>[]) =>
    (await wire({ providers }))[2] as Closure<{ contextLength: number | null; totalSlots: number | null }>;

  it('resolves totalSlots: null for a non-local-engine binding without ever touching the engine', async () => {
    const contextAndSlotsFor = await slots(ANTHROPIC);
    expect((await contextAndSlotsFor({ providerId: 'anthropic-test', modelId: 'claude-opus-5' })).totalSlots).toBeNull();
    expect(effectiveContextWindowSpy).not.toHaveBeenCalled();
  });

  it('for a local-engine binding, contextLength and totalSlots both surface the SAME engine reading from ONE call', async () => {
    const contextAndSlotsFor = await slots(LOCAL_PROVIDER);
    expect(await contextAndSlotsFor({ providerId: 'local', modelId: 'some-gguf' })).toEqual({ contextLength: 999, totalSlots: 3 });
    expect(effectiveContextWindowSpy).toHaveBeenCalledTimes(1);
  });

  it('back-to-back calls for two different local bindings never share state', async () => {
    const contextAndSlotsFor = await slots(LOCAL_PROVIDER);
    effectiveContextWindowSpy.mockImplementation(async (modelId: string) => (
      modelId === 'model-a' ? { contextLength: 8192, totalSlots: 2 } : { contextLength: 4096, totalSlots: 4 }
    ));
    const a = await contextAndSlotsFor({ providerId: 'local', modelId: 'model-a' });
    const b = await contextAndSlotsFor({ providerId: 'local', modelId: 'model-b' });
    // Re-reading model-a AFTER model-b must still answer model-a's own reading (what the old shared variable got wrong).
    const aAgain = await contextAndSlotsFor({ providerId: 'local', modelId: 'model-a' });
    expect(a).toEqual({ contextLength: 8192, totalSlots: 2 });
    expect(b).toEqual({ contextLength: 4096, totalSlots: 4 });
    expect(aAgain).toEqual({ contextLength: 8192, totalSlots: 2 });
  });
});
