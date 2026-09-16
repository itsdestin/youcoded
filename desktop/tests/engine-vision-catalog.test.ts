// T18 / design §E5 — the join between "llama-server says this model can see
// images" and "the app knows it".
//
// The engine already loads a vision model correctly (it pairs the
// `mmproj-*.gguf` beside the weights and reports the pairing on GET /models —
// test-engine/probe-vision.mjs proves that against the real binary). What was
// missing is everything AFTER that: the router's answer was parsed and thrown
// away, so a user who attached a picture to a local vision model got it
// silently dropped. This file guards the two hops that carry it —
// EngineSupervisor.listModels → EngineManager.catalogModels →
// CatalogModel.supportsVision, which is the exact field the session's vision
// resolver already reads for an OpenRouter model.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { EngineManager } from '../src/main/engine/engine-manager';
import { ENGINE_VERSION } from '../src/main/engine/engine-pin';

// Same fake-spawn harness engine-supervisor.test.ts and
// engine-manager-slot-count.test.ts use: ensureRunning() would otherwise
// spawn a real llama-server.
const mockSpawn = vi.fn();
vi.mock('child_process', async (orig) => ({
  ...(await orig() as any),
  spawn: (...args: any[]) => mockSpawn(...args),
}));

function makeFakeChild(): ChildProcess {
  const ee = new EventEmitter() as any;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.kill = vi.fn(() => { setImmediate(() => ee.emit('exit', 0)); return true; });
  ee.pid = 4242;
  return ee;
}

// A REAL `GET /models` response, captured 2026-09-05 from the PINNED binary
// (b10665) spawned with --models-dir over a directory holding SmolVLM-256M
// twice: once in a folder beside its mmproj-*.gguf (the vision layout design
// §E2 downloads into), once as a lone flat .gguf. Verbatim except for the
// absolute cache path inside status.args/status.preset, shortened for
// readability — nothing this code reads. The live check is
// test-engine/probe-vision.mjs; the schema is pinned in
// docs/engine-dependencies.md.
const REAL_MODELS_RESPONSE = {
  data: [
    {
      id: 'SmolVLM-256M-Instruct-Q8_0',
      aliases: [], tags: [], object: 'model', owned_by: 'llamacpp', created: 1788656122,
      status: {
        value: 'unloaded',
        args: ['/engine/llama-server', '--host', '127.0.0.1', '--jinja', '--port', '0', '--no-webui',
          '--alias', 'SmolVLM-256M-Instruct-Q8_0', '--ctx-size', '4096',
          '--model', '/cache/SmolVLM-256M-Instruct-Q8_0/SmolVLM-256M-Instruct-Q8_0.gguf',
          '--mmproj', '/cache/SmolVLM-256M-Instruct-Q8_0/mmproj-SmolVLM-256M-Instruct-f16.gguf'],
        preset: '[SmolVLM-256M-Instruct-Q8_0]\njinja = 1\nwebui = 0\nctx-size = 4096\n',
      },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      source: 'models_dir', can_remove: false,
    },
    {
      id: 'SmolVLM-256M-TextOnly-Q8_0',
      aliases: [], tags: [], object: 'model', owned_by: 'llamacpp', created: 1788656122,
      status: {
        value: 'unloaded',
        args: ['/engine/llama-server', '--host', '127.0.0.1', '--jinja', '--port', '0', '--no-webui',
          '--alias', 'SmolVLM-256M-TextOnly-Q8_0', '--ctx-size', '4096',
          '--model', '/cache/SmolVLM-256M-TextOnly-Q8_0.gguf'],
        preset: '[SmolVLM-256M-TextOnly-Q8_0]\njinja = 1\nwebui = 0\nctx-size = 4096\n',
      },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      source: 'models_dir', can_remove: false,
    },
  ],
  object: 'list',
};

let root: string;
let userData: string;
let cacheDir: string;
let home: NativeHome;
let mgr: EngineManager | undefined;

beforeEach(async () => {
  mockSpawn.mockReset();
  mockSpawn.mockReturnValue(makeFakeChild());
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-vision-'));
  userData = path.join(root, 'userData');
  cacheDir = path.join(root, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  home = new NativeHome(root);
  await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 8192 } }));
});
afterEach(async () => {
  await mgr?.stopAll();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A usable install so catalogModels() doesn't bail out on "not installed". */
function plantInstall(backend = 'cpu') {
  const dir = path.join(userData, 'engine', `${ENGINE_VERSION}-${backend}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'fake');
  fs.writeFileSync(path.join(dir, '.complete'),
    JSON.stringify({ version: ENGINE_VERSION, backend, binaryRelPath: 'llama-server.exe' }));
}

/** Boots a manager whose router answers GET /models with `payload`, and leaves
 *  the engine RUNNING — catalogModels() only reaches the router when it is
 *  (otherwise listModels answers from the disk scan, which knows no
 *  modalities). `includes('/models')`, never `endsWith`: the router is also
 *  asked `/models?reload=1`, and an endsWith stub stops matching the moment a
 *  query string is involved. */
async function runningManager(payload: unknown) {
  plantInstall();
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/health')) return { ok: true, status: 200, json: async () => ({ status: 'ok' }) } as any;
    if (String(url).includes('/models')) return { ok: true, status: 200, json: async () => payload } as any;
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
  const m = new EngineManager(home, userData, 9999, {
    fetchImpl: fetchImpl as any,
    supervisorOpts: { pidOnPort: () => 4242, readyDeadlineMs: 2_000, readyPollMs: 5 },
  });
  await m.registryHook().ensureRunning();
  return m;
}

describe('EngineManager.catalogModels — supportsVision from the router (T18, design §E5)', () => {
  it('a row reporting ["text","image"] is supportsVision TRUE; ["text"] is FALSE', async () => {
    mgr = await runningManager(REAL_MODELS_RESPONSE);
    const rows = await mgr.catalogModels();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    // `toBe`, not a truthiness check: `false` and `undefined` are DIFFERENT
    // answers here ("cannot see" vs "nobody asked"), and only an exact
    // comparison can tell them apart.
    expect(byId['SmolVLM-256M-Instruct-Q8_0'].supportsVision).toBe(true);
    expect(byId['SmolVLM-256M-TextOnly-Q8_0'].supportsVision).toBe(false);
    // The rest of the row is unchanged — this task adds a field, it does not
    // rebuild the mapping.
    expect(byId['SmolVLM-256M-Instruct-Q8_0']).toMatchObject({
      providerId: 'local', label: 'SmolVLM-256M-Instruct-Q8_0', contextLength: 8192,
    });
  });

  it('a row with no architecture at all leaves supportsVision UNDEFINED — never a guessed false', async () => {
    // An older engine build, or the post-boot disk-scan union inside
    // listModels. "Don't know" has to survive the trip: read as `false` it
    // would tell a vision model it cannot see, with nothing on screen to say
    // why.
    mgr = await runningManager({ object: 'list', data: [{ id: 'no-arch-Q4_K_M', status: { value: 'unloaded' } }] });
    const rows = await mgr.catalogModels();
    expect(rows).toHaveLength(1);
    expect(rows[0].supportsVision).toBeUndefined();
    expect('supportsVision' in rows[0]).toBe(false);
  });

  it('the engine-OFF path (disk scan, no router) also leaves supportsVision undefined and does not throw', async () => {
    // catalogModels() with a stopped engine answers from scanGgufCache, which
    // has no modality data at all. Same "don't know" posture, reached by a
    // completely different code path.
    plantInstall();
    fs.writeFileSync(path.join(cacheDir, 'tiny-Q4_K_M.gguf'), Buffer.alloc(4));
    mgr = new EngineManager(home, userData, 9999);
    const rows = await mgr.catalogModels();
    expect(rows.map((r) => r.id)).toEqual(['tiny-Q4_K_M']);
    expect(rows[0].supportsVision).toBeUndefined();
  });
});
