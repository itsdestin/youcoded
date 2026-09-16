import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import {
  EngineSupervisor,
  parseSsListenerPid,
  parseLsofPid,
  parseNetstatListenerPid,
  sumLoadedModelBytes,
  rejectedPresetModel,
  isPresetStartupFailure,
  presetErrorLine,
  requestModelId,
} from '../src/main/engine/engine-supervisor';

const mockSpawn = vi.fn();
vi.mock('child_process', async (orig) => ({
  ...(await orig() as any),
  spawn: (...args: any[]) => mockSpawn(...args),
}));

// fs is partially mocked: mkdirSync is a spy (the supervisor creates the models
// cache dir before spawning) so tests don't create stray dirs from 'C:/fake/cache'.
const mockMkdir = vi.fn();
vi.mock('fs', async (orig) => ({
  ...(await orig() as any),
  mkdirSync: (...args: any[]) => mockMkdir(...args),
}));

function makeFakeChild(): ChildProcess {
  const ee = new EventEmitter() as any;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.kill = vi.fn(() => { setImmediate(() => ee.emit('exit', 0)); return true; });
  ee.pid = 4242;
  return ee;
}

/** fetch that starts refusing, then answers /health ok after delayMs. */
function healthAfter(delayMs: number): ReturnType<typeof vi.fn> {
  const start = Date.now();
  return vi.fn(async (url: string) => {
    if (Date.now() - start < delayMs) throw new Error('ECONNREFUSED');
    if (String(url).endsWith('/health')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok' }) } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
}

const PRESET_PATH = 'C:/fake/home/.youcoded/engine/models.ini';

/** The preset file, in memory. The supervisor's real writer would hit the disk,
 *  and fs.mkdirSync is a no-op spy in this suite, so every test that does not
 *  care about the preset still gets a working one. */
let presetStore: Map<string, string>;

/** `extra` accepts the CONFIG values (cacheDir, contextSize, speed, models…) as
 *  well as supervisor options: readConfig is a callback now, so a test that
 *  wants a spawn to see different values on its second attempt passes its own. */
function makeSupervisor(fetchImpl: any, extra: Record<string, any> = {}) {
  const { cacheDir, contextSize, sleepIdleSeconds, speed, models, ...opts } = extra;
  return new EngineSupervisor({
    binaryPath: 'C:/fake/llama-server.exe',
    port: 9999,
    readConfig: () => ({
      cacheDir: cacheDir ?? 'C:/fake/cache',
      contextSize: contextSize ?? 32768,
      sleepIdleSeconds,
      speed,
      models,
    }),
    presetPath: PRESET_PATH,
    writePresetImpl: (p: string, c: string) => { presetStore.set(p, c); },
    readPresetImpl: (p: string) => {
      const v = presetStore.get(p);
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return v;
    },
    fetchImpl,
    readyDeadlineMs: 2_000,
    readyPollMs: 10,
    idleMs: 25 * 60_000,
    idleCheckMs: 60_000,
    ...opts,
  });
}

/** Read a tracked response to completion — the supervisor releases its counts
 *  when the BODY ends, not when the first chunk arrives. */
async function drain(res: Response): Promise<void> {
  const reader = res.body!.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) { const { done } = await reader.read(); if (done) return; }
}

/** The args of the Nth spawn (0-based). */
const spawnArgs = (n = 0): string[] => mockSpawn.mock.calls[n][1];

let sup: EngineSupervisor;
beforeEach(() => { mockSpawn.mockReset(); mockMkdir.mockReset(); presetStore = new Map(); });
afterEach(async () => { await sup?.stop(); });

describe('EngineSupervisor', () => {
  it('creates the models cache dir BEFORE spawning (router mode fatals on a missing --models-dir)', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(healthAfter(0));
    await sup.ensureRunning();
    expect(mockMkdir).toHaveBeenCalledWith('C:/fake/cache', { recursive: true });
    // mkdir must precede the spawn, else the fresh-install verify-boot dies.
    expect(mockMkdir.mock.invocationCallOrder[0]).toBeLessThan(mockSpawn.mock.invocationCallOrder[0]);
  });

  it('reports a SPECIFIC error (not a bad-build guess) when the cache dir cannot be created, and does not spawn', async () => {
    mockMkdir.mockImplementationOnce(() => { throw new Error('EACCES: permission denied'); });
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(healthAfter(0));
    await expect(sup.ensureRunning()).rejects.toThrow(/model folder could not be created.*EACCES/i);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(sup.status()).toBe('stopped');
  });

  it('surfaces the child\'s OWN output (the real cause) when it exits during startup', async () => {
    // Every spawn gets a fresh child that dies the same way. This message comes
    // through llama-server's `failed to initialize router models: %s` wrapper —
    // the same wrapper a bad preset uses — so the supervisor spends ONE retry
    // without the preset before giving up. That wasted second is deliberate: the
    // wrapper is what makes the preset fallback track the binary instead of a
    // list of sentences transcribed from it (see isPresetStartupFailure).
    mockSpawn.mockImplementation(() => {
      const child = makeFakeChild();
      setImmediate(() => {
        child.stderr!.emit('data', Buffer.from(
          "failed to initialize router models: error: '/home/x/.cache/llama.cpp' does not exist or is not a directory"
        ));
        child.emit('exit', 1);
      });
      return child;
    });
    sup = makeSupervisor(vi.fn(async () => { throw new Error('ECONNREFUSED'); }), { readyDeadlineMs: 5_000 });
    // The thrown error carries the engine's real message, NOT a hardware guess.
    await expect(sup.ensureRunning()).rejects.toThrow(/does not exist or is not a directory/i);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[1][1]).not.toContain('--models-preset');
  });

  it('ensureRunning spawns router-mode llama-server (no -m) with the pinned flag set and LLAMA_CACHE', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(healthAfter(20));
    const base = await sup.ensureRunning();
    expect(base).toBe('http://127.0.0.1:9999/v1');
    expect(sup.status()).toBe('running');
    const [bin, args, opts] = mockSpawn.mock.calls[0];
    expect(bin).toBe('C:/fake/llama-server.exe');
    expect(args).toEqual([
      '--host', '127.0.0.1', '--port', '9999',
      '--no-webui', '--jinja',
      '--models-dir', 'C:/fake/cache', // discovers dropped GGUFs (LLAMA_CACHE alone doesn't)
      '--models-max', '2',
      '--spec-default',              // draft-free speculative decoding (2026-09-04)
      '--cache-type-k', 'q8_0',      // 8-bit KEY cache only — see the WHY in the supervisor
      '--models-preset', PRESET_PATH, // per-model settings (design §C2)
    ]);
    expect(args).not.toContain('-m'); // router mode = no model arg
    // -c and --sleep-idle-seconds moved INTO the preset's [*] section. The
    // router's own command line is merged OVER every preset, so either of them
    // left here would outrank — and silently defeat — every per-model override.
    expect(args).not.toContain('-c');
    expect(args).not.toContain('--ctx-size');
    expect(args).not.toContain('--sleep-idle-seconds');
    // A quantized VALUE cache refuses to load whenever flash attention is off
    // (verified b10665: "quantized V cache requires flash_attn"), and -fa is auto.
    // Pin its absence so a future "match K and V" tidy-up can't brick CPU fallbacks.
    expect(args).not.toContain('--cache-type-v');
    expect(args).not.toContain('-ctv');
    expect(opts.env.LLAMA_CACHE).toBe('C:/fake/cache');
  });

  it('ensureRunning is single-flight: two concurrent calls spawn once', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(healthAfter(30));
    const [a, b] = await Promise.all([sup.ensureRunning(), sup.ensureRunning()]);
    expect(a).toBe(b);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('rejects with a plain-language error when /health never comes up, and kills the child', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    sup = makeSupervisor(vi.fn(async () => { throw new Error('ECONNREFUSED'); }), { readyDeadlineMs: 100 });
    await expect(sup.ensureRunning()).rejects.toThrow(/did not start/i);
    expect(child.kill).toHaveBeenCalled();
    expect(sup.status()).toBe('stopped');
  });

  it('rejects when the child exits during startup', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    sup = makeSupervisor(vi.fn(async () => { throw new Error('ECONNREFUSED'); }), { readyDeadlineMs: 5_000 });
    const p = sup.ensureRunning();
    setImmediate(() => child.emit('exit', 1));
    await expect(p).rejects.toThrow(/exited/i);
    expect(sup.status()).toBe('stopped');
  });

  it('emits "crashed" on unexpected exit; the NEXT ensureRunning respawns', async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    sup = makeSupervisor(healthAfter(0));
    await sup.ensureRunning();
    const crashSpy = vi.fn();
    sup.on('crashed', crashSpy);
    first.emit('exit', 137);
    expect(crashSpy).toHaveBeenCalledWith({ exitCode: 137 });
    expect(sup.status()).toBe('stopped');
    await sup.ensureRunning();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('strikes out after 3 crashes in 5 minutes: ensureRunning refuses until resetStrikes()', async () => {
    mockSpawn.mockImplementation(() => makeFakeChild());
    sup = makeSupervisor(healthAfter(0));
    for (let i = 0; i < 3; i++) {
      await sup.ensureRunning();
      (mockSpawn.mock.results[mockSpawn.mock.calls.length - 1].value as any).emit('exit', 1);
    }
    expect(sup.status()).toBe('error');
    await expect(sup.ensureRunning()).rejects.toThrow(/keeps crashing/i);
    sup.resetStrikes();
    await sup.ensureRunning();
    expect(sup.status()).toBe('running');
  });

  it('idle shutdown: stops after idleMs with no requests, but NEVER mid-stream', async () => {
    vi.useFakeTimers();
    try {
      mockSpawn.mockImplementation(() => makeFakeChild());
      let releaseStream!: () => void;
      const held = new Promise<void>((r) => { releaseStream = r; });
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
        const body = new ReadableStream<Uint8Array>({
          async pull(c) { await held; c.enqueue(new TextEncoder().encode('x')); c.close(); },
        });
        return new Response(body, { status: 200 });
      });
      sup = makeSupervisor(fetchImpl, { idleMs: 1_000, idleCheckMs: 100, readyPollMs: 1 });
      await sup.ensureRunning();

      const res = await sup.trackedFetch('http://127.0.0.1:9999/v1/chat/completions', {});
      await vi.advanceTimersByTimeAsync(3_000);
      expect(sup.status()).toBe('running');

      releaseStream();
      await res.body!.getReader().read(); // drain
      await vi.advanceTimersByTimeAsync(3_000);
      expect(sup.status()).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('listModels: GET /models when running; cache scan shape when stopped', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      if (String(url).endsWith('/models')) {
        // Real b9992 shape: status is an OBJECT {value}, not a bare string.
        // Pinned by probe-models.mjs + docs/engine-dependencies.md.
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'foo-Q4_K_M', status: { value: 'loaded' } }], object: 'list' }) } as any;
      }
      return { ok: false, status: 404 } as any;
    });
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    const models = await sup.listModels();
    expect(models).toEqual([{ id: 'foo-Q4_K_M', sizeBytes: null, loaded: true, state: 'loaded' }]);
  });

  it('listModels drops split-GGUF follower parts — one four-part set is ONE row', async () => {
    // --models-dir lists one row per FILE, so a four-part download arrives as
    // four rows. Parts 2..4 have no architecture header; selecting one 500'd
    // (2026-08-27, Qwen3.8-Flash-Next). Only part 00001 is a real model.
    mockSpawn.mockReturnValue(makeFakeChild());
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      if (String(url).endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [
          { id: 'Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004', status: { value: 'unloaded' } },
          { id: 'Qwen3.8-Flash-Next-UD-Q4_K_XL-00002-of-00004', status: { value: 'unloaded' } },
          { id: 'Qwen3.8-Flash-Next-UD-Q4_K_XL-00003-of-00004', status: { value: 'unloaded' } },
          { id: 'Qwen3.8-Flash-Next-UD-Q4_K_XL-00004-of-00004', status: { value: 'unloaded' } },
          { id: 'single-file-Q8_0', status: { value: 'unloaded' } },
        ] }) } as any;
      }
      return { ok: false, status: 404 } as any;
    });
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    expect((await sup.listModels()).map((m) => m.id)).toEqual([
      'Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004',
      'single-file-Q8_0',
    ]);
  });

  it('listModels UNIONS the disk scan into GET /models — a GGUF downloaded after boot is listed without a restart (Amendment K2)', async () => {
    // Real temp cache dir: fs.readdirSync/statSync are NOT mocked (only
    // mkdirSync is), so scanGgufCache reads real files dropped here.
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    const os = await import('os');
    const path = await import('path');
    const cacheDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'k2-cache-'));
    try {
      mockSpawn.mockReturnValue(makeFakeChild());
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
        if (String(url).endsWith('/models')) {
          // The router only knows what it discovered at BOOT.
          return { ok: true, status: 200, json: async () => ({ data: [{ id: 'boot-model-Q4_K_M', status: { value: 'loaded' } }] }) } as any;
        }
        return { ok: false, status: 404 } as any;
      });
      sup = makeSupervisor(fetchImpl, { cacheDir });
      await sup.ensureRunning();
      // Simulate a download finishing AFTER boot: the file just appears on disk.
      realFs.writeFileSync(path.join(cacheDir, 'boot-model-Q4_K_M.gguf'), Buffer.alloc(4));
      realFs.writeFileSync(path.join(cacheDir, 'downloaded-later-Q4_K_M.gguf'), Buffer.alloc(8));
      const byId = Object.fromEntries((await sup.listModels()).map((m) => [m.id, m]));
      // The router's row wins for the model it knows (live residency state)…
      expect(byId['boot-model-Q4_K_M']).toMatchObject({ state: 'loaded', sizeBytes: 4 });
      // …and the post-boot download is unioned in from the scan as 'unloaded'.
      expect(byId['downloaded-later-Q4_K_M']).toMatchObject({ state: 'unloaded', loaded: false, sizeBytes: 8 });
    } finally {
      realFs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('listModels maps /models status.value → EngineModelState (unknown → unloaded)', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      if (String(url).endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [
          { id: 'a', status: { value: 'loaded' } },
          { id: 'b', status: { value: 'sleeping' } },
          { id: 'c', status: { value: 'loading' } },
          { id: 'd', status: { value: 'unloaded' } },
          { id: 'e', status: { value: 'some-future-state' } },
        ] }) } as any;
      }
      return { ok: false, status: 404 } as any;
    });
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    const byId = Object.fromEntries((await sup.listModels()).map((m) => [m.id, m.state]));
    expect(byId).toEqual({ a: 'loaded', b: 'sleeping', c: 'loading', d: 'unloaded', e: 'unloaded' });
  });

  // ---- input_modalities: how a local model says it can look at a picture ----
  //
  // Design §E5. The two rows below are a REAL `GET /models` response, captured
  // 2026-09-05 from the PINNED binary (b10665, the vulkan build under
  // ~/.config/youcoded-dev) spawned with --models-dir over a directory holding
  // SmolVLM-256M twice: once in a folder beside its mmproj-*.gguf, and once as
  // a lone flat .gguf. Verbatim except for the absolute cache path inside
  // `status.args` / `status.preset`, shortened to keep the fixture readable —
  // nothing this code reads. If this shape ever drifts, probe-vision.mjs is the
  // live check and docs/engine-dependencies.md is where the schema is pinned.
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

  /** Boots a supervisor whose router answers `GET /models` with `payload`.
   *  The URL test is `includes('/models')`, NOT `endsWith` — refreshModels asks
   *  `/models?reload=1`, and an endsWith stub silently stops matching the day a
   *  query string is added (the exact trap engine-manager-slot-count.test.ts
   *  documents for /props). */
  async function supervisorServing(payload: unknown) {
    mockSpawn.mockReturnValue(makeFakeChild());
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      if (String(url).includes('/models')) return { ok: true, status: 200, json: async () => payload } as any;
      return { ok: false, status: 404 } as any;
    });
    const s = makeSupervisor(fetchImpl);
    await s.ensureRunning();
    return s;
  }

  it('listModels keeps architecture.input_modalities off a REAL /models response (design §E5)', async () => {
    sup = await supervisorServing(REAL_MODELS_RESPONSE);
    const byId = Object.fromEntries((await sup.listModels()).map((m) => [m.id, m.inputModalities]));
    // Exact arrays, not "contains image": the whole list is what the app keeps,
    // and a matcher that only looked for 'image' would pass on a row that had
    // lost 'text' too.
    expect(byId['SmolVLM-256M-Instruct-Q8_0']).toEqual(['text', 'image']);
    expect(byId['SmolVLM-256M-TextOnly-Q8_0']).toEqual(['text']);
  });

  it('listModels leaves inputModalities UNSET when the row carries no architecture — no throw', async () => {
    // Every pre-§E5 fixture in this file looks like this, and so does a row
    // from an older llama.cpp build. "Don't know" must NOT collapse into
    // "text only", or a vision model would be told it cannot see.
    sup = await supervisorServing({ object: 'list', data: [{ id: 'no-arch-Q4_K_M', status: { value: 'loaded' } }] });
    const models = await sup.listModels();
    expect(models).toEqual([{ id: 'no-arch-Q4_K_M', sizeBytes: null, loaded: true, state: 'loaded' }]);
    expect('inputModalities' in models[0]).toBe(false);
  });

  it.each([
    ['architecture: null', { architecture: null }],
    ['architecture: a string', { architecture: 'image' }],
    ['architecture: an array', { architecture: ['image'] }],
    ['architecture with no input_modalities', { architecture: { output_modalities: ['text'] } }],
    ['input_modalities: not an array', { architecture: { input_modalities: 'image' } }],
    ['input_modalities: an array of non-strings', { architecture: { input_modalities: [1, 2] } }],
  ])('listModels leaves inputModalities UNSET for a malformed shape: %s', async (_label, extra) => {
    sup = await supervisorServing({ object: 'list', data: [{ id: 'malformed-Q4_K_M', status: { value: 'unloaded' }, ...extra }] });
    const models = await sup.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].inputModalities).toBeUndefined();
  });

  it('emits models-changed after boot with the live model set (drives the per-session banner)', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      if (String(url).endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'a', status: { value: 'loaded' } }] }) } as any;
      }
      return { ok: false, status: 404 } as any;
    });
    sup = makeSupervisor(fetchImpl);
    const changed: any[] = [];
    sup.on('models-changed', (m) => changed.push(m));
    await sup.ensureRunning();
    await new Promise((r) => setTimeout(r, 30)); // let the initial poll tick resolve
    expect(changed.length).toBeGreaterThan(0);
    expect(changed[changed.length - 1][0]).toMatchObject({ id: 'a', state: 'loaded' });
  });

  // ---- T19: how much memory the loaded models are using -------------------
  //
  // The engine card prints this as "8.9 GB loaded". A `sleeping` model has had
  // its weights FREED by --sleep-idle-seconds and reloads on the next request,
  // so counting it would tell the user their machine is holding memory it has
  // already handed back (R1-14).

  /** Router rows spanning every residency state, with sizes that make each
   *  wrong rule produce a DIFFERENT total (loaded-only 1e9; +sleeping 3e9;
   *  +loading 3.4e9; everything 11.4e9) — so an exact assertion below can only
   *  pass for one rule. */
  const RESIDENCY_ROWS = [
    { id: 'awake-Q8_0', size: 1_000_000_000, status: { value: 'loaded' } },
    { id: 'napping-Q8_0', size: 2_000_000_000, status: { value: 'sleeping' } },
    { id: 'arriving-Q8_0', size: 400_000_000, status: { value: 'loading' } },
    { id: 'cold-Q8_0', size: 8_000_000_000, status: { value: 'unloaded' } },
    { id: 'awake-but-unmeasured-Q8_0', status: { value: 'loaded' } },   // no size anywhere
  ];

  function residencyFetch() {
    return vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      if (String(url).endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ data: RESIDENCY_ROWS }) } as any;
      }
      return { ok: false, status: 404 } as any;
    });
  }

  it('loadedModelsBytes sums the LOADED rows only — a sleeping model contributes nothing', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(residencyFetch());
    await sup.ensureRunning();
    await sup.pollModelsNow();
    // Exactly the one loaded row with a known size. Not 3e9 (loaded+sleeping),
    // not 3.4e9 (+loading), not 11.4e9 (everything).
    expect(sup.loadedModelsBytes()).toBe(1_000_000_000);
  });

  it('loadedModelsBytes is UNDEFINED until the engine has actually been asked', async () => {
    // Not zero. Zero is a claim ("nothing loaded") about an engine nobody has
    // polled yet, and the card prints it as one.
    sup = makeSupervisor(residencyFetch());
    expect(sup.loadedModelsBytes()).toBeUndefined();
  });

  it('loadedModelsBytes goes back to undefined once the engine stops', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(residencyFetch());
    await sup.ensureRunning();
    await sup.pollModelsNow();
    expect(sup.loadedModelsBytes()).toBe(1_000_000_000);
    await sup.stop();
    // The reading described a process that no longer exists.
    expect(sup.loadedModelsBytes()).toBeUndefined();
  });

  it('sumLoadedModelBytes: every state, and an unmeasurable loaded row', () => {
    const rows = [
      { id: 'a', sizeBytes: 1_000_000_000, loaded: true, state: 'loaded' as const },
      { id: 'b', sizeBytes: 2_000_000_000, loaded: false, state: 'sleeping' as const },
      { id: 'c', sizeBytes: 400_000_000, loaded: false, state: 'loading' as const },
      { id: 'd', sizeBytes: 8_000_000_000, loaded: false, state: 'unloaded' as const },
      { id: 'e', sizeBytes: null, loaded: true, state: 'loaded' as const },
    ];
    expect(sumLoadedModelBytes(rows)).toBe(1_000_000_000);
    // A set with nothing resident is a real zero, not an absence.
    expect(sumLoadedModelBytes(rows.filter((r) => r.state !== 'loaded'))).toBe(0);
    expect(sumLoadedModelBytes([])).toBe(0);
    // Two loaded rows add up; the sleeping one still never joins in.
    expect(sumLoadedModelBytes([...rows, { id: 'f', sizeBytes: 500_000_000, loaded: true, state: 'loaded' as const }]))
      .toBe(1_500_000_000);
  });

  it('ensureRunning during an in-flight stop WAITS for it, then respawns (no URL to the dying server)', async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    // Make the first child's kill NOT exit immediately, so stop() stays
    // in-flight and we can probe ensureRunning during the teardown window.
    let releaseExit!: () => void;
    (first as any).kill = vi.fn(() => {
      new Promise<void>((r) => { releaseExit = r; }).then(() => first.emit('exit', 0));
      return true;
    });
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    sup = makeSupervisor(healthAfter(0));
    await sup.ensureRunning();
    expect(sup.status()).toBe('running');

    const stopP = sup.stop();          // in-flight until releaseExit()
    const ensureP = sup.ensureRunning(); // must NOT resolve with the old URL yet
    let ensured = false;
    void ensureP.then(() => { ensured = true; });
    await Promise.resolve();
    expect(ensured).toBe(false);        // still waiting for the stop to finish

    releaseExit();                      // stop completes → ensureRunning respawns
    await stopP;
    await ensureP;
    expect(mockSpawn).toHaveBeenCalledTimes(2); // spawned a fresh server, didn't reuse the dying one
    expect(sup.status()).toBe('running');
  });

  // ---- engine-lifecycle fix (2026-07-20): no adopting orphans, real quit kill ----

  it('does NOT adopt a foreign process answering /health on our port (orphan guard)', async () => {
    const child = makeFakeChild();
    (child as any).pid = 4242;
    mockSpawn.mockReturnValue(child);
    // /health answers ok immediately, but the port is held by a DIFFERENT pid (9999) —
    // an orphaned engine. The supervisor must NOT mark running against it; our child
    // (which couldn't bind) exits, so we surface the startup failure instead.
    sup = makeSupervisor(healthAfter(0), {
      pidOnPort: () => 9999, // foreign listener
      readyDeadlineMs: 500, readyPollMs: 10,
    });
    const p = sup.ensureRunning();
    setImmediate(() => child.emit('exit', 1)); // bind-failed child dies
    await expect(p).rejects.toThrow();          // never resolves a URL to the orphan
    expect(sup.status()).toBe('stopped');
  });

  it('DOES mark running when the /health listener IS our spawned child', async () => {
    const child = makeFakeChild();
    (child as any).pid = 4242;
    mockSpawn.mockReturnValue(child);
    sup = makeSupervisor(healthAfter(0), { pidOnPort: () => 4242 }); // our own child
    const base = await sup.ensureRunning();
    expect(base).toBe('http://127.0.0.1:9999/v1');
    expect(sup.status()).toBe('running');
  });

  it('reaps a stale llama-server squatting on the port BEFORE spawning', async () => {
    const child = makeFakeChild();
    (child as any).pid = 4242;
    mockSpawn.mockReturnValue(child);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      // Port is held by orphan pid 9999 (a llama-server). After the reaper SIGKILLs it,
      // our spawned child (4242) takes the port — pidOnPort reflects the handoff.
      let portHolder: number | null = 9999;
      killSpy.mockImplementation(((pid: number, sig: string) => {
        if (pid === 9999 && sig === 'SIGKILL') portHolder = 4242;
        return true;
      }) as any);
      sup = makeSupervisor(healthAfter(0), {
        pidOnPort: () => portHolder,
        exeForPid: (pid: number) => (pid === 9999 ? '/x/engine/llama-b9992/llama-server' : null),
      });
      const base = await sup.ensureRunning();
      expect(killSpy).toHaveBeenCalledWith(9999, 'SIGKILL'); // orphan reaped before spawn
      expect(base).toBe('http://127.0.0.1:9999/v1');          // then our child is adopted
      expect(sup.status()).toBe('running');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('never kills a NON-llama process holding the port (reaper is conservative)', async () => {
    const child = makeFakeChild();
    (child as any).pid = 4242;
    mockSpawn.mockReturnValue(child);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      // Port held by pid 9999, but it's some other app (not llama-server) — must NOT kill.
      sup = makeSupervisor(vi.fn(async () => { throw new Error('ECONNREFUSED'); }), {
        pidOnPort: () => 9999,
        exeForPid: () => '/usr/bin/nginx',
        readyDeadlineMs: 100, readyPollMs: 10,
      });
      await expect(sup.ensureRunning()).rejects.toThrow();
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('stop() escalates SIGTERM → SIGKILL when the child ignores TERM', async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      // Child ignores SIGTERM entirely (never exits on it) — simulates a wedged server.
      const killCalls: string[] = [];
      (child as any).kill = vi.fn((sig: string) => {
        killCalls.push(sig);
        if (sig === 'SIGKILL') setImmediate(() => child.emit('exit', 137));
        return true;
      });
      mockSpawn.mockReturnValue(child);
      sup = makeSupervisor(healthAfter(0));
      await sup.ensureRunning();
      expect(sup.status()).toBe('running');

      const stopP = sup.stop();
      await vi.advanceTimersByTimeAsync(1_600); // past the TERM grace window
      await vi.advanceTimersByTimeAsync(100);   // let the KILL exit land
      await stopP;
      expect(killCalls).toEqual(['SIGTERM', 'SIGKILL']);
      expect(sup.status()).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });
});


// ---------------------------------------------------------------------------
// Settings at every spawn, and the preset file (design §B, §C2).
//
// Two things are being defended here. (1) The supervisor used to freeze its
// configuration in the constructor, so changing a setting and restarting the
// engine respawned it with the OLD values. (2) Per-model settings live in
// `models.ini`, and llama-server treats ANY defect in that file as a FATAL
// startup error for the WHOLE router — so a spawn has to survive both a file it
// could not write and a file the engine refuses, or one bad setting on one model
// takes every local model down with no way back from inside the app.
// ---------------------------------------------------------------------------
/** The router-only flags every spawn carries, whatever the settings say. */
const BASE_ARGS_FOR = (cacheDir: string): string[] => ([
  '--host', '127.0.0.1', '--port', '9999',
  '--no-webui', '--jinja',
  '--models-dir', cacheDir,
  '--models-max', '2',
]);
const BASE_ARGS = [
  '--host', '127.0.0.1', '--port', '9999',
  '--no-webui', '--jinja',
  '--models-dir', 'C:/fake/cache',
  '--models-max', '2',
];

describe('EngineSupervisor — spawn config and the preset file', () => {

  it('re-reads config at EVERY spawn: a switch flipped between runs reaches the second command line', async () => {
    mockSpawn.mockImplementation(() => makeFakeChild());
    // What config.json says right now. readConfig builds a FRESH object from it
    // every call, exactly as the real one re-reads the file — a fixture that
    // handed back one shared, mutable object would look the same to a supervisor
    // that read it once and cached it, and this test would then prove nothing.
    let onDisk = { contextSize: 32768, speed: { speculative: true, compressCache: true } };
    sup = makeSupervisor(healthAfter(0), {
      readConfig: () => ({
        cacheDir: 'C:/fake/cache',
        contextSize: onDisk.contextSize,
        speed: { ...onDisk.speed },
      }),
    });
    await sup.ensureRunning();
    expect(spawnArgs(0)).toEqual([...BASE_ARGS, '--spec-default', '--cache-type-k', 'q8_0', '--models-preset', PRESET_PATH]);

    await sup.stop();
    onDisk = { contextSize: 8192, speed: { speculative: false, compressCache: true } };
    await sup.ensureRunning();
    // The whole point: the second spawn is built from the file as it is NOW.
    expect(spawnArgs(1)).toEqual([...BASE_ARGS, '--cache-type-k', 'q8_0', '--models-preset', PRESET_PATH]);
    // …and the new context length reached the preset's [*] section, not the CLI.
    expect(presetStore.get(PRESET_PATH)).toContain('ctx-size = 8192');
  });

  it('speed switches OFF drop both flags — and nothing else', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(healthAfter(0), { speed: { speculative: false, compressCache: false } });
    await sup.ensureRunning();
    expect(spawnArgs()).toEqual([...BASE_ARGS, '--models-preset', PRESET_PATH]);
  });

  it('the two speed switches are independent: compress-cache off keeps --spec-default', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(healthAfter(0), { speed: { speculative: true, compressCache: false } });
    await sup.ensureRunning();
    expect(spawnArgs()).toEqual([...BASE_ARGS, '--spec-default', '--models-preset', PRESET_PATH]);
  });

  it('a config with no speed section spawns exactly what shipped before the switches existed', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(healthAfter(0)); // speed: undefined
    await sup.ensureRunning();
    expect(spawnArgs()).toEqual([...BASE_ARGS, '--spec-default', '--cache-type-k', 'q8_0', '--models-preset', PRESET_PATH]);
  });

  it('writes [*] ctx-size and sleep-idle-seconds into the preset — the values that came OFF the command line', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(healthAfter(0), { contextSize: 16384, sleepIdleSeconds: 77 });
    await sup.ensureRunning();
    expect(presetStore.get(PRESET_PATH)).toBe('[*]\nctx-size = 16384\nsleep-idle-seconds = 77\n');
  });

  // R3-2. A missing or unreadable --models-preset is ITSELF a fatal startup
  // error (probed: `preset file does not exist` → exit 1), so a supervisor that
  // pointed the engine at a file it failed to write would produce a DEAD engine
  // rather than an engine without per-model settings.
  it('falls back to the -c / --sleep-idle-seconds command line when the preset cannot be WRITTEN', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(healthAfter(0), {
      writePresetImpl: () => { throw new Error('EACCES: permission denied'); },
      contextSize: 4096,
      sleepIdleSeconds: 42,
    });
    await sup.ensureRunning();
    expect(spawnArgs()).toEqual([
      ...BASE_ARGS, '--spec-default', '--cache-type-k', 'q8_0',
      '--sleep-idle-seconds', '42', '-c', '4096',
    ]);
    expect(spawnArgs()).not.toContain('--models-preset');
    expect(sup.presetInForce()).toBe(false); // the card tells the user settings are not in force
  });

  it('falls back the same way when the preset cannot be READ BACK', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(healthAfter(0), {
      writePresetImpl: () => { /* pretends to succeed, writes nothing */ },
      readPresetImpl: () => '',
      contextSize: 4096,
      sleepIdleSeconds: 42,
    });
    await sup.ensureRunning();
    expect(spawnArgs()).toEqual([
      ...BASE_ARGS, '--spec-default', '--cache-type-k', 'q8_0',
      '--sleep-idle-seconds', '42', '-c', '4096',
    ]);
    expect(sup.presetInForce()).toBe(false);
  });

  it('a healthy preset run reports presetInForce() true', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(healthAfter(0));
    await sup.ensureRunning();
    expect(sup.presetInForce()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The section-omitting retry (R3-1). llama-server refuses to initialise on an
// unrecognised key in ANY section and exits 1 before serving anything, naming
// the section in its own error. Without this retry, one bad flag on one model
// means every local model is gone at the next launch.
// ---------------------------------------------------------------------------
describe('EngineSupervisor — a model the engine refuses', () => {
  const REJECTION = "0.00.050.247 E srv    llama_server: failed to initialize router models: "
    + "option 'not-a-real-flag' not recognized in preset 'bad-model-Q4_K_M'";

  /** A real cache dir holding two complete models, so the preset really gets a
   *  section for each (readdirSync/statSync are NOT mocked in this suite). */
  async function twoModelCacheDir(): Promise<{ dir: string; cleanup: () => void }> {
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    const os = await import('os');
    const path = await import('path');
    const dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'preset-retry-'));
    realFs.writeFileSync(path.join(dir, 'good-model-Q4_K_M.gguf'), Buffer.alloc(4));
    realFs.writeFileSync(path.join(dir, 'bad-model-Q4_K_M.gguf'), Buffer.alloc(4));
    return { dir, cleanup: () => realFs.rmSync(dir, { recursive: true, force: true }) };
  }

  /** A fake llama-server that behaves like the real one: it reads the preset the
   *  supervisor just wrote and exits 1 naming the FIRST section in the file that
   *  carries a key it does not know. With no preset — or none of those sections
   *  left — it comes up. `badKeys` maps model id → the flag that build refuses. */
  function fakeEngineRefusing(_cacheDir: string, badKeys: Record<string, string>) {
    let up = false;
    mockSpawn.mockImplementation((_bin: string, args: string[]) => {
      const child = makeFakeChild();
      const ini = args.includes('--models-preset') ? (presetStore.get(PRESET_PATH) ?? '') : '';
      const offending = Object.entries(badKeys)
        .map(([id, flag]) => ({ id, flag, at: ini.indexOf(`[${id}]`) }))
        .filter((e) => e.at >= 0)
        .sort((a, b) => a.at - b.at)[0];
      if (offending) {
        setImmediate(() => {
          child.stderr!.emit('data', Buffer.from(
            'E srv llama_server: failed to initialize router models: '
            + `option '${offending.flag}' not recognized in preset '${offending.id}'`
          ));
          child.emit('exit', 1);
        });
      } else {
        up = true; // nothing left for it to refuse
      }
      return child;
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (!up) throw new Error('ECONNREFUSED');
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
    });
    return { fetchImpl };
  }

  const settings = {
    'good-model-Q4_K_M': { contextLength: 8192 },
    'bad-model-Q4_K_M': { extraFlags: '--not-a-real-flag 7' },
  };

  it('retries ONCE with the named model\'s section omitted, and every other model keeps its settings', async () => {
    const { dir, cleanup } = await twoModelCacheDir();
    try {
      const first = makeFakeChild();
      const second = makeFakeChild();
      mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
      // /health never answers for the first child — it dies on the preset.
      let firstDead = false;
      const fetchImpl = vi.fn(async (url: string) => {
        if (!firstDead) throw new Error('ECONNREFUSED');
        if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
        return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
      });
      sup = makeSupervisor(fetchImpl, { cacheDir: dir, models: settings, readyDeadlineMs: 5_000 });
      const rejected: any[] = [];
      sup.on('preset-model-rejected', (e) => rejected.push(e));

      const p = sup.ensureRunning();
      setImmediate(() => {
        first.stderr!.emit('data', Buffer.from(REJECTION));
        firstDead = true;
        first.emit('exit', 1);
      });
      await p;

      expect(mockSpawn).toHaveBeenCalledTimes(2);
      const retryPreset = presetStore.get(PRESET_PATH)!;
      // The offending model's section is gone…
      expect(retryPreset).not.toContain('[bad-model-Q4_K_M]');
      expect(retryPreset).not.toContain('not-a-real-flag');
      // …and the innocent model still has its own.
      expect(retryPreset).toContain('[good-model-Q4_K_M]\nctx-size = 8192');
      // The engine is still driven by the preset, so the other models' settings hold.
      expect(spawnArgs(1)).toContain('--models-preset');
      // The rejection is reported with the engine's OWN sentence, never a guess —
      // this becomes that model's lastLoadError, and it never got a router row
      // to fail on, so this is the only place its failure is visible.
      expect(rejected).toEqual([{
        modelId: 'bad-model-Q4_K_M',
        message: "failed to initialize router models: option 'not-a-real-flag' not recognized in preset 'bad-model-Q4_K_M'",
      }]);
    } finally {
      cleanup();
    }
  });

  it('boots WITHOUT the preset when the engine rejects the file as a whole (no model to drop)', async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    let firstDead = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (!firstDead) throw new Error('ECONNREFUSED');
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
    });
    sup = makeSupervisor(fetchImpl, { readyDeadlineMs: 5_000, contextSize: 4096, sleepIdleSeconds: 42 });
    const p = sup.ensureRunning();
    setImmediate(() => {
      first.stderr!.emit('data', Buffer.from(
        '0.00.050.247 E srv    llama_server: failed to parse server config file: /home/x/.youcoded/engine/models.ini'
      ));
      firstDead = true;
      first.emit('exit', 1);
    });
    await p;
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    // A dead engine is not an option: the second attempt drops the preset and
    // brings the two engine-wide values back onto the command line.
    expect(spawnArgs(1)).toEqual([
      ...BASE_ARGS, '--spec-default', '--cache-type-k', 'q8_0',
      '--sleep-idle-seconds', '42', '-c', '4096',
    ]);
    expect(sup.presetInForce()).toBe(false);
  });

  // THE case the nesting exists for. The binary names only the FIRST bad
  // section, so two bad models means the omit-retry drops one and dies on the
  // other. If that retry merely CONSUMED the one recovery attempt, the result
  // would be a permanently dead engine — the exact outcome this whole path is
  // here to prevent, reached by its own recovery.
  it('two rejected models still end in a booted engine: omit one, then boot without the preset', async () => {
    const { dir, cleanup } = await twoModelCacheDir();
    try {
      // BOTH models carry a flag this engine build does not know — which is what
      // one renamed option at the next engine bump looks like on a real machine.
      // The fake engine reads the file the supervisor ACTUALLY wrote and refuses
      // the first bad section in it, exactly as the binary does, so the test
      // cannot pass on a preset that still contains the offending model.
      const engine = fakeEngineRefusing(dir, { 'bad-model-Q4_K_M': 'flag-two', 'good-model-Q4_K_M': 'flag-one' });
      sup = makeSupervisor(engine.fetchImpl, {
        cacheDir: dir,
        models: {
          'good-model-Q4_K_M': { extraFlags: '--flag-one 7' },
          'bad-model-Q4_K_M': { extraFlags: '--flag-two 7' },
        },
        contextSize: 4096,
        sleepIdleSeconds: 42,
        readyDeadlineMs: 5_000,
      });
      await sup.ensureRunning();

      expect(mockSpawn).toHaveBeenCalledTimes(3);
      expect(sup.status()).toBe('running');
      // The engine is UP, on the pre-preset command line.
      expect(spawnArgs(2)).toEqual([
        ...BASE_ARGS_FOR(dir), '--spec-default', '--cache-type-k', 'q8_0',
        '--sleep-idle-seconds', '42', '-c', '4096',
      ]);
      expect(spawnArgs(2)).not.toContain('--models-preset');
      expect(sup.presetInForce()).toBe(false);
    } finally {
      cleanup();
    }
  });

  // The guard that makes the retry safe in the presence of the OTHER instance
  // sharing ~/.youcoded: if the error names a section we did not write, omitting
  // it changes nothing and the second attempt would fail identically. Boot
  // without the preset instead.
  it('boots without the preset when the rejected section is not one WE wrote', async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    let alive = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (!alive) throw new Error('ECONNREFUSED');
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
    });
    // No models on disk, so our preset has NO model sections at all — the id the
    // engine names can only have come from a file another instance wrote.
    sup = makeSupervisor(fetchImpl, { readyDeadlineMs: 5_000, contextSize: 4096, sleepIdleSeconds: 42 });
    const rejected: any[] = [];
    sup.on('preset-model-rejected', (e) => rejected.push(e));
    const p = sup.ensureRunning();
    setImmediate(() => {
      first.stderr!.emit('data', Buffer.from(
        "E srv llama_server: failed to initialize router models: option 'x' not recognized in preset 'someone-elses-model-Q4_K_M'"
      ));
      alive = true;
      first.emit('exit', 1);
    });
    await p;
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(spawnArgs(1)).not.toContain('--models-preset');
    expect(spawnArgs(1)).toEqual([
      ...BASE_ARGS, '--spec-default', '--cache-type-k', 'q8_0',
      '--sleep-idle-seconds', '42', '-c', '4096',
    ]);
    // And no model is blamed for a section we never wrote.
    expect(rejected).toEqual([]);
  });

  it('does NOT retry a startup failure that has nothing to do with the preset', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    sup = makeSupervisor(vi.fn(async () => { throw new Error('ECONNREFUSED'); }), { readyDeadlineMs: 5_000 });
    const p = sup.ensureRunning();
    setImmediate(() => {
      child.stderr!.emit('data', Buffer.from('ggml_vulkan: Device memory allocation of 4294967296 bytes failed'));
      child.emit('exit', 1);
    });
    await expect(p).rejects.toThrow(/Device memory allocation/);
    // One spawn, not two: a retry here would fail identically AND silently drop
    // every per-model setting on the way.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Per-model in-flight counting, and "keep loaded" vs the engine-wide idle stop.
// ---------------------------------------------------------------------------
describe('EngineSupervisor — per-model activity', () => {
  it('trackedFetch counts requests PER MODEL, read from the request body', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const fetchImpl = vi.fn(async (url: string) => {
      // The background model poll must NOT go through the held stream, or its
      // res.json() would block on it and the counts under test would be the
      // poll's rather than the chat's.
      if (String(url).includes('/models')) return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      const body = new ReadableStream<Uint8Array>({
        async pull(c) { await held; c.enqueue(new TextEncoder().encode('x')); c.close(); },
      });
      return new Response(body, { status: 200 });
    });
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();

    const res = await sup.trackedFetch('http://127.0.0.1:9999/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'a-Q4_K_M', messages: [] }),
    });
    expect(sup.inFlightFor('a-Q4_K_M')).toBe(1);
    // The engine being busy says nothing about ANOTHER model — that is the whole
    // reason this count exists instead of reading the engine-wide inFlight.
    expect(sup.inFlightFor('b-Q4_K_M')).toBe(0);

    release();
    await drain(res);
    expect(sup.inFlightFor('a-Q4_K_M')).toBe(0);
  });

  it('counts two concurrent requests for one model, and releases each', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const gates: Array<() => void> = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/models')) return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      const held = new Promise<void>((r) => gates.push(r));
      return new Response(new ReadableStream<Uint8Array>({
        async pull(c) { await held; c.close(); },
      }), { status: 200 });
    });
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    const init = { method: 'POST', body: JSON.stringify({ model: 'a-Q4_K_M' }) };
    const one = await sup.trackedFetch('http://127.0.0.1:9999/v1/chat/completions', init as any);
    const two = await sup.trackedFetch('http://127.0.0.1:9999/v1/chat/completions', init as any);
    expect(sup.inFlightFor('a-Q4_K_M')).toBe(2);
    gates[0]!(); await drain(one);
    expect(sup.inFlightFor('a-Q4_K_M')).toBe(1);
    gates[1]!(); await drain(two);
    expect(sup.inFlightFor('a-Q4_K_M')).toBe(0);
  });

  it('a request that fails outright releases its per-model count', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    let up = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) { up = true; return { ok: true, status: 200 } as any; }
      if (up) throw new Error('ECONNRESET');
      throw new Error('ECONNREFUSED');
    });
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    await expect(sup.trackedFetch('http://127.0.0.1:9999/v1/chat/completions', {
      method: 'POST', body: JSON.stringify({ model: 'a-Q4_K_M' }),
    })).rejects.toThrow(/ECONNRESET/);
    expect(sup.inFlightFor('a-Q4_K_M')).toBe(0);
  });

  it('the idle stop is SKIPPED while a keep-loaded model is resident, and resumes when it is not', async () => {
    vi.useFakeTimers();
    try {
      mockSpawn.mockImplementation(() => makeFakeChild());
      // A fresh object per call, for the reason spelled out in the readConfig
      // test above: a shared one cannot tell a re-read apart from a cached read.
      let keepLoaded = true;
      const readConfig = () => ({
        cacheDir: 'C:/fake/cache', contextSize: 32768,
        models: { 'a-Q4_K_M': { keepLoaded } },
      });
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'a-Q4_K_M', status: { value: 'loaded' } }] }) } as any;
      });
      sup = makeSupervisor(fetchImpl, {
        readConfig, idleMs: 1_000, idleCheckMs: 100, modelPollMs: 10, readyPollMs: 1,
      });
      await sup.ensureRunning();
      await vi.advanceTimersByTimeAsync(5_000);
      // "Keep loaded" means keep loaded: tearing the engine down would take the
      // model with it and make the setting a lie.
      expect(sup.status()).toBe('running');

      // The setting is read fresh, so turning it off lets the engine idle out.
      keepLoaded = false;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sup.status()).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  // The idle check reads config.json on a TIMER, and NativeHome deliberately
  // rethrows a non-ENOENT I/O error (EACCES, EIO). An exception out of a timer
  // callback is uncaught: it would take the whole Electron main process down, so
  // the app would vanish because a config read failed.
  it('an unreadable config.json does not kill the app from inside the idle timer', async () => {
    vi.useFakeTimers();
    try {
      mockSpawn.mockImplementation(() => makeFakeChild());
      let broken = false;
      const readConfig = () => {
        if (broken) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return { cacheDir: 'C:/fake/cache', contextSize: 32768 };
      };
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
        return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
      });
      sup = makeSupervisor(fetchImpl, {
        readConfig, idleMs: 1_000, idleCheckMs: 100, modelPollMs: 10, readyPollMs: 1,
      });
      await sup.ensureRunning();
      broken = true;
      // The tick still completes, and an engine whose settings cannot be read
      // has no visible keep-loaded model — so it idles out exactly as before.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sup.status()).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a keep-loaded model that is NOT resident does not hold the engine open', async () => {
    vi.useFakeTimers();
    try {
      mockSpawn.mockImplementation(() => makeFakeChild());
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
        // Configured keep-loaded, but the router has it unloaded.
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'a-Q4_K_M', status: { value: 'unloaded' } }] }) } as any;
      });
      sup = makeSupervisor(fetchImpl, {
        models: { 'a-Q4_K_M': { keepLoaded: true } },
        idleMs: 1_000, idleCheckMs: 100, modelPollMs: 10, readyPollMs: 1,
      });
      await sup.ensureRunning();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sup.status()).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- pure parsers for the preset failure path and the per-model count ----
describe('preset failure parsers', () => {
  it('rejectedPresetModel names the section the engine refused', () => {
    expect(rejectedPresetModel(
      "E srv llama_server: option 'not-a-real-flag' not recognized in preset 'gemma-4-E2B-it-Q8_0'"
    )).toBe('gemma-4-E2B-it-Q8_0');
  });

  it('rejectedPresetModel keeps a model id that contains a quote (ids are FILENAMES)', () => {
    expect(rejectedPresetModel(
      "option 'x' not recognized in preset 'it's-a-model-Q4_K_M'"
    )).toBe("it's-a-model-Q4_K_M");
  });

  it('rejectedPresetModel returns null for the global section — there is no model to drop', () => {
    expect(rejectedPresetModel("option 'x' not recognized in preset '*'")).toBeNull();
  });

  it('rejectedPresetModel returns null when the output says nothing about a preset', () => {
    expect(rejectedPresetModel('ggml_vulkan: Device memory allocation failed')).toBeNull();
  });

  it('isPresetStartupFailure recognises the three sentences that mean the preset, and nothing else', () => {
    expect(isPresetStartupFailure("option 'x' not recognized in preset 'y'")).toBe(true);
    expect(isPresetStartupFailure('failed to parse server config file: /x/models.ini')).toBe(true);
    expect(isPresetStartupFailure('preset file does not exist: /x/models.ini')).toBe(true);
    expect(isPresetStartupFailure('ggml_vulkan: Device memory allocation failed')).toBe(false);
    expect(isPresetStartupFailure("error: invalid argument: --models-dir")).toBe(false);
  });

  it('presetErrorLine strips only llama-server\'s log prefix', () => {
    expect(presetErrorLine(
      "0.00.050.247 E srv    llama_server: option 'q' not recognized in preset 'm-Q4_K_M'"
    )).toBe("option 'q' not recognized in preset 'm-Q4_K_M'");
  });

  it('requestModelId reads the model out of an OpenAI-compatible body', () => {
    expect(requestModelId({ body: JSON.stringify({ model: 'a-Q4_K_M', messages: [] }) })).toBe('a-Q4_K_M');
  });

  it('requestModelId returns null rather than guessing when there is no model to read', () => {
    expect(requestModelId({ body: JSON.stringify({ messages: [] }) })).toBeNull();
    expect(requestModelId({ body: 'not json' })).toBeNull();
    expect(requestModelId({ body: '{ broken' })).toBeNull();
    expect(requestModelId({})).toBeNull();
    expect(requestModelId(undefined)).toBeNull();
    expect(requestModelId({ body: JSON.stringify({ model: 42 }) })).toBeNull();
  });
});

// ---- cross-platform port→PID parsers (pure; no shell) ----
// These pin the output shapes of the per-platform tools the orphan-guard and
// stale-engine reaper rely on, so a parsing regression can't silently re-open
// the "adopt a foreign engine" hole on macOS/Windows.
describe('port→PID parsers', () => {
  it('parseSsListenerPid: Linux ss -ltnp output → PID', () => {
    const out = [
      'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
      'LISTEN 0      511    127.0.0.1:9920      0.0.0.0:*     users:(("llama-server",pid=111523,fd=20))',
      'LISTEN 0      511    127.0.0.1:9900      0.0.0.0:*     users:(("node",pid=777,fd=25))',
    ].join('\n');
    expect(parseSsListenerPid(out, 9920)).toBe(111523);
    expect(parseSsListenerPid(out, 9900)).toBe(777);
    expect(parseSsListenerPid(out, 1234)).toBeNull(); // not listening
    // Exact-match: a query for a PREFIX port must not match a longer listening port.
    expect(parseSsListenerPid(out, 992)).toBeNull();  // ':992' ≠ ':9920'
    expect(parseSsListenerPid(out, 99)).toBeNull();   // ':99'  ≠ ':9900'/':9920'
  });

  it('parseLsofPid: macOS lsof -F p output → PID', () => {
    expect(parseLsofPid('p4821\nf3\n')).toBe(4821);
    expect(parseLsofPid('')).toBeNull();
    expect(parseLsofPid('COMMAND  PID USER\n')).toBeNull();
  });

  it('parseNetstatListenerPid: Windows netstat -ano → PID of LISTENING socket', () => {
    const out = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:9920         0.0.0.0:0              LISTENING       22234',
      '  TCP    127.0.0.1:9920         127.0.0.1:55000        ESTABLISHED     999', // not LISTENING — ignored
      '  TCP    0.0.0.0:9900           0.0.0.0:0              LISTENING       5555',
    ].join('\n');
    expect(parseNetstatListenerPid(out, 9920)).toBe(22234);
    expect(parseNetstatListenerPid(out, 9900)).toBe(5555);
    expect(parseNetstatListenerPid(out, 4321)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Router rescan (GET /models?reload=1). The router discovers GGUFs at BOOT and
// re-scans --models-dir ONLY when asked: its need_reload dirty flag is set just
// for downloads the ROUTER itself started, and ours are app-side. Verified
// against b9992 (libllama-server-impl.so + upstream tools/server/server-models.cpp)
// on 2026-08-16, after a real send 400'd on a model that had been on disk for
// half an hour. Depth: docs/engine-dependencies.md.
// ---------------------------------------------------------------------------
describe('EngineSupervisor — router rescan', () => {
  /** fetch stub whose router-known model set can be swapped mid-test. */
  function routerWith(known: string[]) {
    const state = { known: [...known] };
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u.slice(u.indexOf('/', 8))}`);
      if (u.endsWith('/health')) return { ok: true, status: 200 } as any;
      if (u.includes('/models')) {
        return {
          ok: true, status: 200,
          json: async () => ({ data: state.known.map((id) => ({ id, status: { value: 'unloaded' } })) }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });
    return { fetchImpl, calls, state };
  }

  const reloadCalls = (calls: string[]) => calls.filter((c) => c.includes('reload'));

  it('refreshModels asks the router to re-scan: GET /models?reload=1', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const { fetchImpl, calls } = routerWith(['boot-model-Q4_K_M']);
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    await sup.refreshModels();
    expect(reloadCalls(calls)).toEqual(['GET /models?reload=1']);
  });

  it('refreshModels is a no-op when the engine is not running (the next boot scans the dir anyway)', async () => {
    const { fetchImpl, calls } = routerWith([]);
    sup = makeSupervisor(fetchImpl);
    await sup.refreshModels();
    expect(calls).toEqual([]);
  });

  // The load-bearing guard. reload=1 is a WRITE: upstream load_models() unloads a
  // running model whose source changed or vanished. On a 1.5s poll that would be a
  // reconciliation pass every tick, forever.
  it('the background model poll NEVER sends reload=1', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const { fetchImpl, calls } = routerWith(['a-Q4_K_M']);
    sup = makeSupervisor(fetchImpl, { modelPollMs: 5, modelPollLoadingMs: 5 });
    await sup.ensureRunning();
    await new Promise((r) => setTimeout(r, 60)); // several poll ticks
    expect(calls.filter((c) => c.includes('/models')).length).toBeGreaterThan(1); // it really did poll
    expect(reloadCalls(calls)).toEqual([]);
  });

  it('ensureServable does NOT re-scan when the router already serves the model', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const { fetchImpl, calls } = routerWith(['boot-model-Q4_K_M']);
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    expect(await sup.ensureServable('boot-model-Q4_K_M')).toBe(true);
    expect(reloadCalls(calls)).toEqual([]);
  });

  it('ensureServable re-scans when the model is on disk but unknown to the router, and reports it servable', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const { fetchImpl, calls, state } = routerWith(['boot-model-Q4_K_M']);
    // The rescan is what makes the post-boot download visible to the router.
    fetchImpl.mockImplementation((async (url: string, init?: any) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u.slice(u.indexOf('/', 8))}`);
      if (u.endsWith('/health')) return { ok: true, status: 200 } as any;
      if (u.includes('/models')) {
        if (u.includes('reload')) state.known.push('downloaded-later-Q4_K_M');
        return {
          ok: true, status: 200,
          json: async () => ({ data: state.known.map((id) => ({ id, status: { value: 'unloaded' } })) }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    }) as any);
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    expect(await sup.ensureServable('downloaded-later-Q4_K_M')).toBe(true);
    expect(reloadCalls(calls)).toEqual(['GET /models?reload=1']);
  });

  it('ensureServable reports FALSE when even a re-scan does not surface the model', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const { fetchImpl } = routerWith(['boot-model-Q4_K_M']);
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    // No lie: the caller needs a real answer so it can say something accurate.
    expect(await sup.ensureServable('never-existed-Q4_K_M')).toBe(false);
  });

  it('ensureServable re-scans at most once for concurrent callers (single-flight)', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const { fetchImpl, calls, state } = routerWith(['boot-model-Q4_K_M']);
    fetchImpl.mockImplementation((async (url: string, init?: any) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u.slice(u.indexOf('/', 8))}`);
      if (u.endsWith('/health')) return { ok: true, status: 200 } as any;
      if (u.includes('/models')) {
        if (u.includes('reload')) {
          await new Promise((r) => setTimeout(r, 20)); // a real scan takes a beat
          if (!state.known.includes('downloaded-later-Q4_K_M')) state.known.push('downloaded-later-Q4_K_M');
        }
        return {
          ok: true, status: 200,
          json: async () => ({ data: state.known.map((id) => ({ id, status: { value: 'unloaded' } })) }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    }) as any);
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    const all = await Promise.all([
      sup.ensureServable('downloaded-later-Q4_K_M'),
      sup.ensureServable('downloaded-later-Q4_K_M'),
      sup.ensureServable('downloaded-later-Q4_K_M'),
    ]);
    expect(all).toEqual([true, true, true]);
    expect(reloadCalls(calls)).toEqual(['GET /models?reload=1']);
  });

  it('ensureServable does not block a send when the router is unreachable — it assumes servable', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      throw new Error('ECONNRESET');
    });
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    // Failing OPEN is deliberate: a probe that can't answer must not be the thing
    // that stops a send the engine would have served fine.
    expect(await sup.ensureServable('boot-model-Q4_K_M')).toBe(true);
  });
});

// The one reading "Add vision" renames a user's model on the strength of
// (design §E4). Every branch here is the difference between "the child has let
// go of the file" and "we could not find out" — read the second as the first and
// the rename lands on an open file.
describe('EngineSupervisor — routerModelState', () => {
  /** A router answering /models with exactly these rows. */
  function routerRows(rows: any[], ok = true) {
    return vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      if (String(url).includes('/models')) return { ok, status: ok ? 200 : 500, json: async () => ({ data: rows }) } as any;
      return { ok: false, status: 404 } as any;
    });
  }

  it("reads b10665's status OBJECT, and an older bare string too", async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(routerRows([
      { id: 'obj-Q4_K_M', status: { value: 'loaded' } },
      { id: 'str-Q4_K_M', status: 'sleeping' },
    ]));
    await sup.ensureRunning();
    expect(await sup.routerModelState('obj-Q4_K_M')).toBe('loaded');
    expect(await sup.routerModelState('str-Q4_K_M')).toBe('sleeping');
  });

  it('a model the router does not list at all IS unloaded — it cannot be resident', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    sup = makeSupervisor(routerRows([{ id: 'other-Q4_K_M', status: { value: 'loaded' } }]));
    await sup.ensureRunning();
    expect(await sup.routerModelState('mine-Q4_K_M')).toBe('unloaded');
  });

  it('polls a PLAIN GET — never reload=1, which is a write', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const fetchImpl = routerRows([{ id: 'a-Q4_K_M', status: { value: 'unloaded' } }]);
    sup = makeSupervisor(fetchImpl);
    await sup.ensureRunning();
    await sup.routerModelState('a-Q4_K_M');
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes('reload'))).toEqual([]);
  });

  const dontKnow: Array<[string, () => any]> = [
    ['the router answers an error', () => routerRows([], false)],
    ['the router cannot be reached', () => vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as any;
      throw new Error('ECONNRESET');
    })],
    ['the status word is one nothing here recognises', () =>
      routerRows([{ id: 'a-Q4_K_M', status: { value: 'evicting' } }])],
  ];
  for (const [what, impl] of dontKnow) {
    it(`answers null — "do not know", never "unloaded" — when ${what}`, async () => {
      mockSpawn.mockReturnValue(makeFakeChild());
      sup = makeSupervisor(impl());
      await sup.ensureRunning();
      expect(await sup.routerModelState('a-Q4_K_M')).toBe(null);
    });
  }

  it('answers null when no engine is running (there is nobody to ask)', async () => {
    sup = makeSupervisor(routerRows([]));
    expect(await sup.routerModelState('a-Q4_K_M')).toBe(null);
  });
});
