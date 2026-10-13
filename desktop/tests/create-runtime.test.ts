// createRuntime — the assistant runtime builds and runs with NO Electron in reach.
//
// WHY (2026-09-29 one-core R1, first proof point for the Android core): create-runtime.ts used to
// be an inline block of registerIpcHandlers and reached Electron directly (app.getPath, shell,
// safeStorage, BrowserWindow via the sync service). Two guards, because each catches what the
// other cannot:
//   1. STATIC — walk every file create-runtime.ts imports (relative imports, require(), dynamic
//      import()) and fail on any `electron` import, naming the file. Catches a new leak the moment
//      it is written, even in a branch no test executes.
//   2. RUNTIME — replace the `electron` module with one that THROWS when loaded, then build a real
//      runtime in a temp profile folder with a fake Platform and use it. Catches an Electron call
//      that hides behind a global or a computed require, which a text scan cannot see.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

vi.mock('electron', () => {
  throw new Error('the runtime core must not load Electron');
});

// Only the four conversation-store calls the title path makes are stubbed (an "auto name is on file"
// record), so the test can drive applyAutomaticTitle end to end without a synced store on disk.
vi.mock('../src/main/conversations/service', async (importActual) => ({
  ...(await importActual<typeof import('../src/main/conversations/service')>()),
  getConversationStore: () => null,
  getNamingRecord: async () => ({ auto: 'Hello there', autoAt: 'stamp-1' }),
  mutateNamingRecord: async () => ({ auto: 'Hello there', autoAt: 'stamp-1' }),
  noteTitleChanged: async () => ({ ok: true }),
}));

const MAIN_DIR = fileURLToPath(new URL('../src/main/', import.meta.url));

function resolveRelative(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** Every file reachable from `entry`, and the ones among them that import `electron`. */
function walkImports(entry: string): { files: Set<string>; electronImporters: string[] } {
  const files = new Set<string>();
  const electronImporters: string[] = [];
  const queue = [entry];
  // Value imports only: `import type` is erased at build time, so it can never load Electron.
  const re = /(?:^|\n)\s*(?:import|export)\s(?!type\s)[^;'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g;
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const src = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
    for (const m of src.matchAll(re)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec) continue;
      if (spec === 'electron') electronImporters.push(path.relative(MAIN_DIR, file));
      const next = resolveRelative(file, spec);
      if (next) queue.push(next);
    }
  }
  return { files, electronImporters };
}

describe('create-runtime has no Electron behind it', () => {
  it('nothing create-runtime.ts imports (transitively) imports electron', () => {
    const { files, electronImporters } = walkImports(path.join(MAIN_DIR, 'create-runtime.ts'));
    // A sanity floor: if the walk found a handful of files, it is not scanning the real graph.
    expect(files.size).toBeGreaterThan(100);
    expect(electronImporters).toEqual([]);
  });

  it('electron-platform.ts is the only bridge: it is not reachable from create-runtime.ts', () => {
    const { files } = walkImports(path.join(MAIN_DIR, 'create-runtime.ts'));
    const reached = [...files].map((f) => path.relative(MAIN_DIR, f));
    expect(reached).not.toContain('electron-platform.ts');
    expect(reached).not.toContain(path.join('providers', 'secret-storage.ts'));
  });
});

describe('createRuntime with a temp folder and a fake platform', () => {
  let userData: string;
  let runtime: Awaited<ReturnType<typeof build>>;
  const opened: string[] = [];
  // Reversible fake "encryption", like the app's test stub, so the test can prove the runtime's
  // secrets went through the PLATFORM it was given and not through anything Electron.
  const encrypted: string[] = [];
  const platform = {
    openExternal: vi.fn(async (url: string) => { opened.push(url); }),
    secretStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => { encrypted.push(s); return Buffer.from(`fake:${s}`, 'utf8'); },
      decryptString: (b: Buffer) => b.toString('utf8').slice('fake:'.length),
    },
    resolveAskpassPaths: async () => null,
  };

  async function build() {
    const { createRuntime } = await import('../src/main/create-runtime');
    return createRuntime({
      userDataDir: userData,
      appVersion: '0.0.0-test',
      platform,
      chatgptAuth: null,
      sessionManager: { getSession: () => undefined },
    });
  }

  beforeAll(async () => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-runtime-'));
    // A first import of the whole native stack is a one-time cost (see test-suite-hygiene):
    // pay it here, under the hook's budget, not inside the first test.
    runtime = await build();
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5 });
  });

  it('builds every object both doors read', () => {
    for (const key of [
      'nativeHost', 'providerRegistry', 'modelCatalog', 'engineManager', 'modelManager', 'searchKeyStore',
      'searchService', 'permissionStore', 'stepGuardSettings', 'contextSettings', 'specialistCatalog',
      'claudeAccount', 'openRouterSignIn', 'sessionNamer', 'applyAutomaticTitle', 'sessionState',
    ] as const) {
      expect(runtime[key], key).toBeTruthy();
    }
    // The phone door's slice is a subset of the same object — one runtime, two doors.
    expect(typeof runtime.cleanup).toBe('function');
  });

  it('keeps API keys through the platform it was given, in the folder it was given', async () => {
    const ref = await runtime.secretsStore.set('sk-fake-key');
    expect(encrypted).toContain('sk-fake-key');
    expect(await runtime.secretsStore.get(ref)).toBe('sk-fake-key');
    expect(fs.existsSync(path.join(userData, 'native-secrets.json'))).toBe(true);
    expect(fs.readFileSync(path.join(userData, 'native-secrets.json'), 'utf8')).not.toContain('sk-fake-key');
  });

  it('publishes the naming mode file under the given folder', () => {
    runtime.publishNamingMode();
    expect(fs.existsSync(path.join(userData, 'naming-mode'))).toBe(true);
  });

  it('owns ONE set of shared session maps', () => {
    const state = runtime.sessionState;
    state.sessionIdMap.set('desktop-1', 'claude-1');
    // The namer resolves ids through the same map the handlers write to.
    expect(runtime.sessionState.sessionIdMap.get('desktop-1')).toBe('claude-1');
    state.dispose();
    expect(state.sessionIdMap.size).toBe(0);
  });

  it('tells a subscribed door when an automatic title lands (the core never paints windows)', async () => {
    const heard: Array<[string, string]> = [];
    runtime.onTitleApplied((id, title) => heard.push([id, title]));
    const applied = await runtime.applyAutomaticTitle('desktop-1', 'store-1', 'native', 'Hello there', 'stamp-1');
    expect(applied).toBe(true);
    expect(heard).toEqual([['desktop-1', 'Hello there']]);
  });
});
