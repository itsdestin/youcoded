// Task 7b pinning test: proves the McpManager constructed in ipc-handlers.ts
// is REACHABLE, not just constructed. Task 6 already proved (in
// native-session-host.test.ts) that a WIRED manager's acquire() output
// becomes a session's tools; what was still unproven — the exact gap the
// task-7b brief describes — is that ipc-handlers.ts ever builds a real
// manager, backed by the real registry/nativeHome/secretsStore, and hands
// THAT SAME INSTANCE into NativeSessionHost's constructor. A test that only
// checks "new McpManager was called" would pass even if the manager were
// discarded immediately after construction — this test instead writes a real
// ~/.youcoded/mcp.json, captures the exact manager instance handed to
// NativeSessionHost, and calls its real acquire() to confirm the configured
// server comes back out the other end.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// The connectionFactory is the one seam every existing MCP test fakes
// (mcp-client.test.ts fakes the SDK's clientFactory; mcp-manager.test.ts
// fakes connectionFactory directly) rather than spawning a real subprocess.
// Mocking mcp-client's createConnection here keeps that same convention while
// still proving ipc-handlers wires THAT module's export (not a homemade
// stand-in) as the manager's connectionFactory: the mock only replaces the
// connection's behavior, not which function ipc-handlers imports and passes.
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

// Fix 2 regression seam: spies on ModelCatalog.get() (extends + delegates to
// the real implementation, same pattern as the NativeSessionHost spy below)
// so a test can prove which bindings the ipc-handlers-wired visionSupportFor
// closure consults the catalog for — without needing a real network fetch,
// since super.get() is never reached in the short-circuited paths either.
//
// T18 adds `catalogRowsOverride`: set it and get() answers with those rows
// instead of delegating. That is what lets a test prove the OTHER half — not
// just that the closure READS the catalog for a local binding, but that the
// row's supportsVision is what comes back out of it. Without the override the
// real get() would answer "no local rows" (no engine installed in this
// fixture) and every assertion would be null, which is also what a completely
// unwired closure returns.
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

// Captures the real args NativeSessionHost's constructor receives, WITHOUT
// changing its behavior (extends + delegates to the real class via super()).
// This is the only way to inspect ipc-handlers' positional 10th argument
// (mcpManager, shifted from 9th by Task 6c's new visionSupportFor param)
// without exporting it or refactoring the constructor shape — the brief
// explicitly forbids the latter.
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

// NativeHome defaults to os.homedir() (see native-home.ts) and ipc-handlers.ts
// constructs `new NativeHome()` with no override — so redirecting os.homedir()
// is what makes the test hit the SAME ~/.youcoded/mcp.json path production
// code reads, rather than faking NativeHome's internals.
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

describe('McpManager startup wiring (Task 7b)', () => {
  beforeEach(() => {
    // Deliberately NOT cleaned up in afterEach: ipc-handlers.ts also fires
    // ProviderRegistry.init() fire-and-forget (unrelated to MCP, pre-existing
    // behavior), which writes into this same homedir sometime after the test
    // body returns — removing the directory immediately would race that write
    // and surface as a spurious unhandled rejection. A handful of leftover
    // temp dirs under the OS tmpdir is a fine trade for a deterministic test.
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-mcp-wiring-'));
    capturedCtorArgs = undefined;
    createConnectionMock.mockClear();
  });

  it('threads a REAL, config-driven McpManager into NativeSessionHost', async () => {
    fs.mkdirSync(path.join(testHome, '.youcoded'), { recursive: true });
    fs.writeFileSync(
      path.join(testHome, '.youcoded', 'mcp.json'),
      JSON.stringify({
        servers: [
          { id: 'demo', label: 'Demo Server', enabled: true, transport: { type: 'stdio', command: 'node' }, origin: { kind: 'user' } },
        ],
      }),
    );

    const { registerIpcHandlers } = await import('../src/main/ipc-handlers');
    registerIpcHandlers(
      makeMockIpcMain() as any,
      makeMockSessionManager() as any,
      { webContents: { send: vi.fn() }, isDestroyed: () => false } as any,
      makeMockSkillProvider() as any,
    );

    expect(capturedCtorArgs).toBeDefined();
    // WHY avoid pinning total constructor arity: trailing host dependencies may
    // grow independently of MCP. The semantic contract is that the MCP slot is
    // populated by a working manager, while the preceding optional skill slot
    // remains intentionally empty at this wiring site.
    expect(capturedCtorArgs![9]).toBeUndefined();

    const mcpManager = capturedCtorArgs![10] as {
      acquire(sessionId: string): Promise<{ servers: Array<{ id: string; label: string; tools: unknown[] }> }>;
    };
    expect(mcpManager).toBeDefined();
    expect(typeof mcpManager.acquire).toBe('function');

    // The real test: acquire() actually reads the hand-written mcp.json and
    // returns the configured server — this is the exact call NativeSessionHost
    // makes per-session (Task 6). If the wiring were removed (mcpManager left
    // undefined, or the registry pointed elsewhere), this would throw or
    // return [].
    const { servers: ready } = await mcpManager.acquire('test-session');
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe('demo');
    expect(ready[0].label).toBe('Demo Server');
    expect(ready[0].tools).toEqual([{ name: 'demo_tool', description: 'd', inputSchema: { type: 'object' } }]);

    // Confirms the factory ipc-handlers wired really is mcp-client's
    // createConnection (this file's export, not a duplicate), invoked with
    // the resolved server read from disk.
    expect(createConnectionMock).toHaveBeenCalledTimes(1);
    expect(createConnectionMock.mock.calls[0][0]).toMatchObject({ id: 'demo' });
  });

  it('a user with no ~/.youcoded/mcp.json gets a silent no-op manager — no directory, no subprocess, no error', async () => {
    // Deliberately do NOT create .youcoded/ or mcp.json — this is the normal
    // case for almost every install (brief: "must be silent and
    // side-effect-free for them").
    const { registerIpcHandlers } = await import('../src/main/ipc-handlers');
    registerIpcHandlers(
      makeMockIpcMain() as any,
      makeMockSessionManager() as any,
      { webContents: { send: vi.fn() }, isDestroyed: () => false } as any,
      makeMockSkillProvider() as any,
    );

    // MCP construction alone must not write mcp.json (or create it fresh) —
    // McpRegistry.list()/resolveAllEnabled() only ever READ. (The .youcoded
    // dir itself may already exist because of ProviderRegistry's own
    // fire-and-forget init() write, which is unrelated to MCP and out of
    // this task's scope — so this asserts the MCP-specific file, not the
    // shared directory.)
    expect(fs.existsSync(path.join(testHome, '.youcoded', 'mcp.json'))).toBe(false);

    const mcpManager = capturedCtorArgs![10] as { acquire(sessionId: string): Promise<{ servers: unknown[] }> };
    const { servers: ready } = await mcpManager.acquire('test-session');
    expect(ready).toEqual([]);
    expect(createConnectionMock).not.toHaveBeenCalled();
  });
});

// Fix 2 regression: visionSupportFor (the 5th positional constructor arg —
// see the "3rd closure" test above) used to call modelCatalog.get()
// UNCONDITIONALLY, for every provider type — adding a second full catalog
// fetch/parse to every cloud session start, which can never produce a non-null
// answer (a direct-key or openai-compatible catalog carries no modality data).
// This proves the fix still holds: such a binding's session start never
// reaches the catalog at all.
//
// T18 (design §E5) narrows the short-circuit by one provider: a LOCAL binding
// now DOES consult the catalog, because llama-server's own GET /models answers
// the same question for a model it paired a vision projector with, and that
// answer arrives on the very same CatalogModel.supportsVision field OpenRouter
// uses. The local tests below are the ones that changed direction.
describe('visionSupportFor: which bindings consult the catalog (Fix 2, T18)', () => {
  beforeEach(() => {
    // Same "leave it, don't race ProviderRegistry.init()'s write" reasoning
    // as the describe block above.
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-vision-shortcircuit-'));
    capturedCtorArgs = undefined;
    catalogRowsOverride = null;
    modelCatalogGetSpy.mockClear();
  });

  /** Registers the handlers with a single provider written straight to
   *  providers.json, and hands back the wired visionSupportFor closure. */
  async function wiredVisionResolver(...providers: Record<string, unknown>[]) {
    fs.mkdirSync(path.join(testHome, '.youcoded'), { recursive: true });
    fs.writeFileSync(
      path.join(testHome, '.youcoded', 'providers.json'),
      JSON.stringify({ v: 1, providers }),
    );
    const { registerIpcHandlers } = await import('../src/main/ipc-handlers');
    registerIpcHandlers(
      makeMockIpcMain() as any,
      makeMockSessionManager() as any,
      { webContents: { send: vi.fn() }, isDestroyed: () => false } as any,
      makeMockSkillProvider() as any,
    );
    expect(capturedCtorArgs).toBeDefined();
    return capturedCtorArgs![4] as (binding: { providerId: string; modelId: string }) => Promise<boolean | null>;
  }

  const LOCAL_PROVIDER = { id: 'local', type: 'local-engine', label: 'Local models (llama.cpp)', enabled: true };

  it('never calls modelCatalog.get() for an anthropic binding', async () => {
    // Write providers.json directly (rather than relying on
    // ProviderRegistry.init()'s fire-and-forget built-in seeding) so the
    // 'anthropic-test' provider is present the instant registerIpcHandlers
    // constructs the closures below — no race with this test's assertion.
    fs.mkdirSync(path.join(testHome, '.youcoded'), { recursive: true });
    fs.writeFileSync(
      path.join(testHome, '.youcoded', 'providers.json'),
      JSON.stringify({ v: 1, providers: [{ id: 'anthropic-test', type: 'anthropic', label: 'Anthropic', enabled: true }] }),
    );

    const { registerIpcHandlers } = await import('../src/main/ipc-handlers');
    registerIpcHandlers(
      makeMockIpcMain() as any,
      makeMockSessionManager() as any,
      { webContents: { send: vi.fn() }, isDestroyed: () => false } as any,
      makeMockSkillProvider() as any,
    );

    expect(capturedCtorArgs).toBeDefined();
    const visionSupportFor = capturedCtorArgs![4] as (binding: { providerId: string; modelId: string }) => Promise<boolean | null>;

    const result = await visionSupportFor({ providerId: 'anthropic-test', modelId: 'claude-opus-5' });
    expect(result).toBeNull();
    expect(modelCatalogGetSpy).not.toHaveBeenCalled();
  });

  // T18 — the three local cases, and the reason this task exists: a local
  // vision model has to be read out of the SAME catalog field an OpenRouter
  // vision model is, through the SAME closure. Before T18 this returned null
  // for every local binding without ever looking.
  it('reads a LOCAL model\'s supportsVision straight out of the catalog (T18)', async () => {
    // 'local' is a BUILT_IN id (provider-registry.ts) — write providers.json
    // directly rather than waiting on ProviderRegistry.init().
    catalogRowsOverride = [{ id: 'SmolVLM-256M-Instruct-Q8_0', providerId: 'local', label: 'SmolVLM', supportsVision: true }];
    const visionSupportFor = await wiredVisionResolver(LOCAL_PROVIDER);
    expect(await visionSupportFor({ providerId: 'local', modelId: 'SmolVLM-256M-Instruct-Q8_0' })).toBe(true);
    expect(modelCatalogGetSpy).toHaveBeenCalled();
  });

  // The cost half of the same closure. 'openrouter' ships ENABLED (see
  // provider-registry's BUILT_INS), so a local-only user's provider list still
  // contains it — and ModelCatalog.get() fetches for any consumer in the list
  // it is handed. Passing the whole list here would therefore put two internet
  // fetches (15 s apiece on a hanging network, never memoized on failure) in
  // front of every local session create, resume and model swap. The closure
  // must hand over the BINDING'S provider and nothing else.
  it('asks the catalog about the BINDING\'S provider only — an enabled OpenRouter is not dragged in (T18)', async () => {
    catalogRowsOverride = [{ id: 'some-gguf', providerId: 'local', label: 'g', supportsVision: true }];
    const visionSupportFor = await wiredVisionResolver(LOCAL_PROVIDER, {
      id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true,
    });
    await visionSupportFor({ providerId: 'local', modelId: 'some-gguf' });
    // EXACT shape, not a "contains local" match: the whole point is what is
    // ABSENT. One argument, an array of exactly one provider, and it is 'local'.
    expect(modelCatalogGetSpy).toHaveBeenCalledTimes(1);
    const passed = modelCatalogGetSpy.mock.calls[0][0] as Array<{ id: string }>;
    expect(passed.map((x) => x.id)).toEqual(['local']);
  });

  it('a LOCAL text-only row resolves to false, not to "don\'t know" (T18)', async () => {
    catalogRowsOverride = [{ id: 'text-only-Q8_0', providerId: 'local', label: 'Text only', supportsVision: false }];
    const visionSupportFor = await wiredVisionResolver(LOCAL_PROVIDER);
    expect(await visionSupportFor({ providerId: 'local', modelId: 'text-only-Q8_0' })).toBe(false);
  });

  it('a LOCAL row the catalog cannot answer for degrades to null, and does not throw (T18)', async () => {
    // The engine was stopped when the catalog was built (so the row carries no
    // modality data), or the model is not in the catalog at all. null is the
    // closure's "no source could answer" — resolveProfile then falls back to
    // its registry/provider-type default exactly as before.
    catalogRowsOverride = [{ id: 'other-model', providerId: 'local', label: 'Other' }];
    const visionSupportFor = await wiredVisionResolver(LOCAL_PROVIDER);
    expect(await visionSupportFor({ providerId: 'local', modelId: 'missing-model' })).toBeNull();
    expect(await visionSupportFor({ providerId: 'local', modelId: 'other-model' })).toBeNull();
  });
});

// Task 11: pricingFor is the 6th positional constructor arg — the 4th injected
// closure. Same short-circuit posture as visionSupportFor above: a model
// running on this machine costs nothing to run, so a local-engine binding must
// never pay for a catalog read to learn a price that doesn't exist. The host
// stamps those turns `free` instead of pricing them.
describe('pricingFor (Task 11)', () => {
  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-pricing-wiring-'));
    capturedCtorArgs = undefined;
    modelCatalogGetSpy.mockClear();
  });

  it('never calls modelCatalog.get() for a local-engine binding', async () => {
    fs.mkdirSync(path.join(testHome, '.youcoded'), { recursive: true });
    fs.writeFileSync(
      path.join(testHome, '.youcoded', 'providers.json'),
      JSON.stringify({ v: 1, providers: [{ id: 'local', type: 'local-engine', label: 'Local models (llama.cpp)', enabled: true }] }),
    );

    const { registerIpcHandlers } = await import('../src/main/ipc-handlers');
    registerIpcHandlers(
      makeMockIpcMain() as any,
      makeMockSessionManager() as any,
      { webContents: { send: vi.fn() }, isDestroyed: () => false } as any,
      makeMockSkillProvider() as any,
    );

    const pricingFor = capturedCtorArgs![5] as (binding: { providerId: string; modelId: string }) => Promise<unknown>;
    expect(await pricingFor({ providerId: 'local', modelId: 'some-gguf' })).toBeNull();
    expect(modelCatalogGetSpy).not.toHaveBeenCalled();
  });

  it('returns null — not a guessed zero — for a metered model the catalog does not list', async () => {
    fs.mkdirSync(path.join(testHome, '.youcoded'), { recursive: true });
    fs.writeFileSync(
      path.join(testHome, '.youcoded', 'providers.json'),
      JSON.stringify({ v: 1, providers: [{ id: 'anthropic-test', type: 'anthropic', label: 'Anthropic', enabled: true }] }),
    );

    const { registerIpcHandlers } = await import('../src/main/ipc-handlers');
    registerIpcHandlers(
      makeMockIpcMain() as any,
      makeMockSessionManager() as any,
      { webContents: { send: vi.fn() }, isDestroyed: () => false } as any,
      makeMockSkillProvider() as any,
    );

    const pricingFor = capturedCtorArgs![5] as (binding: { providerId: string; modelId: string }) => Promise<unknown>;
    expect(await pricingFor({ providerId: 'anthropic-test', modelId: 'not-in-any-catalog' })).toBeNull();
    expect(modelCatalogGetSpy).toHaveBeenCalled();   // a metered binding DOES consult the catalog
  });
});

// Task 13: proves the actual GAP the original review found — before the
// first fix, DiscoveredModel.totalSlots was built and tested at the
// capability-profile.ts layer, but no production code ever WROTE it, so
// every local session silently got the conservative floor of 1. This spies
// on EngineManager's effectiveContextWindow (the one place that reads
// /props) to prove ipc-handlers.ts's context/slots closure resolves through
// it for local-engine bindings, and that doing so costs exactly ONE call.
//
// Fix pass 2: the first fix answered this with TWO separately-injected
// closures (contextLengthFor, slotCountFor) sharing one /props reading
// through a module-scoped `lastLocalSlotReading` variable — correct only if
// every caller awaited them back-to-back for the same binding with nothing
// else able to run in between. That did NOT hold: an unrelated cloud
// binding's resolution landing between the two awaits reset the shared
// variable, silently flooring an unrelated local session's cap to 1 (proven
// against the pre-fix-pass-2 wiring by the git history of this file — see
// the fix pass 2 report). This describe block now tests the collapsed
// design: ONE closure (contextAndSlotsFor, the 3rd positional constructor
// arg) returns both values, so there is no shared state left to race.
const effectiveContextWindowSpy = vi.fn(async () => ({ contextLength: 999, totalSlots: 3 }));
vi.mock('../src/main/engine/engine-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/engine/engine-manager')>();
  class SpyEngineManager extends actual.EngineManager {
    effectiveContextWindow(modelId: string) { return effectiveContextWindowSpy(modelId); }
  }
  return { ...actual, EngineManager: SpyEngineManager };
});

describe('contextAndSlotsFor wiring (Task 13, collapsed by fix pass 2)', () => {
  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-slotcount-wiring-'));
    capturedCtorArgs = undefined;
    effectiveContextWindowSpy.mockClear();
  });

  it('resolves totalSlots: null for a non-local-engine binding without ever touching the engine', async () => {
    fs.mkdirSync(path.join(testHome, '.youcoded'), { recursive: true });
    fs.writeFileSync(
      path.join(testHome, '.youcoded', 'providers.json'),
      JSON.stringify({ v: 1, providers: [{ id: 'anthropic-test', type: 'anthropic', label: 'Anthropic', enabled: true }] }),
    );
    const { registerIpcHandlers } = await import('../src/main/ipc-handlers');
    registerIpcHandlers(
      makeMockIpcMain() as any,
      makeMockSessionManager() as any,
      { webContents: { send: vi.fn() }, isDestroyed: () => false } as any,
      makeMockSkillProvider() as any,
    );

    expect(capturedCtorArgs).toBeDefined();
    const contextAndSlotsFor = capturedCtorArgs![2] as (binding: { providerId: string; modelId: string }) => Promise<{ contextLength: number | null; totalSlots: number | null }>;
    const result = await contextAndSlotsFor({ providerId: 'anthropic-test', modelId: 'claude-opus-5' });
    expect(result.totalSlots).toBeNull();
    expect(effectiveContextWindowSpy).not.toHaveBeenCalled();
  });

  it('for a local-engine binding, contextLength and totalSlots both surface the SAME engine reading from ONE call', async () => {
    fs.mkdirSync(path.join(testHome, '.youcoded'), { recursive: true });
    fs.writeFileSync(
      path.join(testHome, '.youcoded', 'providers.json'),
      JSON.stringify({ v: 1, providers: [{ id: 'local', type: 'local-engine', label: 'Local models (llama.cpp)', enabled: true }] }),
    );
    const { registerIpcHandlers } = await import('../src/main/ipc-handlers');
    registerIpcHandlers(
      makeMockIpcMain() as any,
      makeMockSessionManager() as any,
      { webContents: { send: vi.fn() }, isDestroyed: () => false } as any,
      makeMockSkillProvider() as any,
    );

    expect(capturedCtorArgs).toBeDefined();
    const contextAndSlotsFor = capturedCtorArgs![2] as (binding: { providerId: string; modelId: string }) => Promise<{ contextLength: number | null; totalSlots: number | null }>;
    const binding = { providerId: 'local', modelId: 'some-gguf' };

    const result = await contextAndSlotsFor(binding);
    expect(result).toEqual({ contextLength: 999, totalSlots: 3 });
    expect(effectiveContextWindowSpy).toHaveBeenCalledTimes(1);
  });

  // Fix pass 2 concurrency regression, at the wiring layer: two DIFFERENT
  // local bindings resolved through the SAME contextAndSlotsFor closure,
  // back to back, must each get their OWN engine reading — there is no
  // variable in ipc-handlers.ts left for one binding's call to stomp another's,
  // because each call is now a single self-contained round trip with nothing
  // stashed between calls. (The interleaved-in-flight version of this same
  // proof — two overlapping NativeSessionHost.create() calls actually racing
  // — lives in native-session-host.test.ts, "no cross-talk"; this is the
  // equivalent proof one layer down, at the exact closure ipc-handlers.ts
  // constructs.)
  it('back-to-back calls for two different local bindings never share state', async () => {
    fs.mkdirSync(path.join(testHome, '.youcoded'), { recursive: true });
    fs.writeFileSync(
      path.join(testHome, '.youcoded', 'providers.json'),
      JSON.stringify({ v: 1, providers: [{ id: 'local', type: 'local-engine', label: 'Local models (llama.cpp)', enabled: true }] }),
    );
    effectiveContextWindowSpy.mockImplementation(async (modelId: string) => (
      modelId === 'model-a' ? { contextLength: 8192, totalSlots: 2 } : { contextLength: 4096, totalSlots: 4 }
    ));
    const { registerIpcHandlers } = await import('../src/main/ipc-handlers');
    registerIpcHandlers(
      makeMockIpcMain() as any,
      makeMockSessionManager() as any,
      { webContents: { send: vi.fn() }, isDestroyed: () => false } as any,
      makeMockSkillProvider() as any,
    );

    expect(capturedCtorArgs).toBeDefined();
    const contextAndSlotsFor = capturedCtorArgs![2] as (binding: { providerId: string; modelId: string }) => Promise<{ contextLength: number | null; totalSlots: number | null }>;

    const a = await contextAndSlotsFor({ providerId: 'local', modelId: 'model-a' });
    const b = await contextAndSlotsFor({ providerId: 'local', modelId: 'model-b' });
    // Re-reading model-a AFTER model-b resolved must still answer model-a's
    // own reading — the exact case the old shared variable got wrong.
    const aAgain = await contextAndSlotsFor({ providerId: 'local', modelId: 'model-a' });

    expect(a).toEqual({ contextLength: 8192, totalSlots: 2 });
    expect(b).toEqual({ contextLength: 4096, totalSlots: 4 });
    expect(aAgain).toEqual({ contextLength: 8192, totalSlots: 2 });
  });
});
