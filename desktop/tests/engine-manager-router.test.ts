// EngineManager against a running router — per-model settings, engine-wide
// config switches, the slot count and the vision flag, all read off a faked
// llama-server. Every section here needs child_process.spawn replaced, which is
// why this file is separate from tests/engine-manager.test.ts (real spawn).
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { EngineManager, resolveSlotCount } from '../src/main/engine/engine-manager';
import { ENGINE_VERSION } from '../src/main/engine/engine-pin';

// Same fake-spawn harness engine-supervisor.test.ts uses — EngineManager's
// ensureRunning() (reached from effectiveContextWindow, set-config, catalog)
// spawns a real llama-server unless child_process.spawn is replaced.
const mockSpawn = vi.fn();
vi.mock('child_process', async (orig) => ({
  ...(await orig() as any),
  spawn: (...args: any[]) => mockSpawn(...args),
}));

// The review found that DiscoveredModel.totalSlots (the
// field capability-profile.ts's local concurrency cap reads) was written by
// NO production code: native-session-host.ts's resolveContextAndProfile never
// threaded a live engine reading through it, so every local session silently
// fell back to the conservative floor of 1 concurrent specialist — a
// regression from the earlier flat cap of 4.
//
// This section proves the piece that closes that gap: EngineManager actually
// reads llama-server's slot count off the SAME /props response that already
// supplies the context window (no second HTTP round trip), with the same
// defensive "absent/zero/non-numeric = unknown" posture n_ctx already gets
// (see engine-manager.test.ts's clampContextWindow sections for the identical n_ctx bug —
// this mirrors that fix rather than reinventing the parsing strategy).
//
// Correction (measured live against the pinned b10665 in router
// mode): the field is `total_slots`, NOT `n_slots`, and it only appears when
// the request names a model — `GET /props` with no `?model=` answers
// `{model_path:"none", default_generation_settings.n_ctx: 0}` and NO slot
// field at all, while `GET /props?model=<id>` answers `total_slots: 4` plus
// the n_ctx the engine holds for THAT model. What that n_ctx is depends on the
// spawn shape: under the app's real args (no `--parallel`) b10665 turns on a
// unified KV cache and reports the FULL `-c` (all slots share one pool); only
// with an explicit `--parallel N` does it become `-c` / N. The earlier version
// of this section pinned the wrong field name and the model-less URL, which is
// exactly why the bug shipped with every test green: totalSlots was ALWAYS
// null in production, so every local model was capped at ONE helper while
// the engine had four slots.
//
// Review fix: naming a model in `/props?model=` is NOT a
// status read on b10665 — the router AUTOLOADS the named model and blocks,
// with no timeout, until gigabytes are in memory (and, at --models-max 2, can
// evict the model a live conversation is using). effectiveContextWindow runs
// on every session create/resume/model swap, before the user has sent a word,
// so it must ask `GET /models` for the model's status FIRST and name the model
// only when it is already `loaded`. Every other status (unloaded, sleeping —
// a sleeping model would be woken by the same autoload — or a model the
// router has never heard of) takes the model-less `/props` master always
// used: instant, n_ctx 0 → the configured -c, no slot field → totalSlots
// null → the conservative one-helper cap until the first real send loads it.
describe('the slot count', () => {
  function makeFakeChild(): ChildProcess {
    const ee = new EventEmitter() as any;
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.kill = vi.fn(() => { setImmediate(() => ee.emit('exit', 0)); return true; });
    ee.pid = 4242;
    return ee;
  }

  let root: string;
  let userData: string;
  let home: NativeHome;
  let mgr: EngineManager | undefined;

  beforeEach(() => {
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(makeFakeChild());
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-mgr-slots-'));
    userData = path.join(root, 'userData');
    home = new NativeHome(root);
  });
  afterEach(async () => {
    await mgr?.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Plant a fake usable install so effectiveContextWindow doesn't bail out on
   *  "not installed" before ever reaching /props — mirrors engine-manager.test.ts's
   *  own plantInstall() helper. */
  function plantInstall(backend = 'cpu') {
    const dir = path.join(userData, 'engine', `${ENGINE_VERSION}-${backend}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'fake');
    fs.writeFileSync(path.join(dir, '.complete'),
      JSON.stringify({ version: ENGINE_VERSION, backend, binaryRelPath: 'llama-server.exe' }));
  }

  /** The exact body b10665's router answers to a MODEL-LESS `GET /props`
   *  (measured 2026-09-04): nothing described, n_ctx 0, no slot field. The stub
   *  below always answers this for the bare URL, so a test that expects the
   *  model-less path is proven by the numbers too, not only by the URL spy. */
  const ROUTER_IDLE_PROPS = { model_path: 'none', default_generation_settings: { n_ctx: 0 } };

  /** One `GET /models` row in b10665's shape — `status` is an OBJECT
   *  (`{value: 'loaded' | 'unloaded' | 'loading' | 'sleeping'}`), which is what
   *  the supervisor's listModels parses. */
  function routerRow(id: string, status: 'loaded' | 'unloaded' | 'loading' | 'sleeping') {
    return { id, status: { value: status } };
  }

  /** fetch stub: /health answers ok immediately (our fake child never really
   *  binds a port, so ensureRunning's identity guard needs pidOnPort wired to
   *  match); /models answers `{data: opts.models}` (default: an EMPTY router —
   *  no model is loaded unless a test says so, because the safe default under
   *  test is the one that must never autoload); `/props?model=<id>` answers
   *  `namedBody`; a bare `/props` answers ROUTER_IDLE_PROPS; anything else {}.
   *  Every URL fetched is recorded in `opts.urls` so a test can assert on the
   *  exact strings — including that a URL was NEVER requested. */
  function fetchWithProps(
    namedBody: unknown,
    opts: { models?: unknown[]; urls?: string[] } = {},
  ): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string) => {
      const u = new URL(String(url));
      opts.urls?.push(String(url));
      if (u.pathname === '/health') return { ok: true, status: 200, json: async () => ({ status: 'ok' }) } as any;
      if (u.pathname === '/models') return { ok: true, status: 200, json: async () => ({ data: opts.models ?? [] }) } as any;
      if (u.pathname === '/props') {
        const body = u.searchParams.has('model') ? namedBody : ROUTER_IDLE_PROPS;
        return { ok: true, status: 200, json: async () => body } as any;
      }
      return { ok: true, status: 200, json: async () => ({}) } as any;
    });
  }

  function plantedManager(fetchImpl: ReturnType<typeof vi.fn>, cacheDir: string) {
    return new EngineManager(home, userData, 9999, {
      fetchImpl: fetchImpl as any,
      // pidOnPort matches the fake child's pid so ensureRunning's "is this
      // really our child on the port" identity guard passes; short deadline/poll
      // so a broken test fails fast instead of waiting out the real 30s default.
      supervisorOpts: { pidOnPort: () => 4242, readyDeadlineMs: 2_000, readyPollMs: 5 },
    });
  }

  /** Everything this manager fetched under /props (the exact URL strings). */
  const propsUrls = (urls: string[]) => urls.filter((u) => new URL(u).pathname === '/props');

  const BARE_PROPS = 'http://127.0.0.1:9999/props';
  const namedProps = (id: string) => `http://127.0.0.1:9999/props?model=${encodeURIComponent(id)}`;

  describe('resolveSlotCount — /props total_slots parsing', () => {
    it('reads a positive integer straight through', () => {
      expect(resolveSlotCount(4)).toBe(4);
      expect(resolveSlotCount(1)).toBe(1);
    });

    it('treats an absent field as unknown, not zero slots', () => {
      expect(resolveSlotCount(undefined)).toBeNull();
    });

    it('treats a literal 0 as unknown (router mode with nothing resident)', () => {
      expect(resolveSlotCount(0)).toBeNull();
    });

    it('treats a non-numeric or negative reading as unknown, never a guessed count', () => {
      expect(resolveSlotCount('4')).toBeNull();
      expect(resolveSlotCount(NaN)).toBeNull();
      expect(resolveSlotCount(null)).toBeNull();
      expect(resolveSlotCount(-1)).toBeNull();
    });
  });

  describe('EngineManager.effectiveContextWindow — never loads a model to read a number', () => {
    it('a LOADED model: asks /props?model=<id> once and both numbers come through (the app\'s real spawn shape: full -c, 4 slots)', async () => {
      const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
      const urls: string[] = [];
      // Measured 2026-09-04 on b10665 with the supervisor's EXACT args (`-c 16384`,
      // no `--parallel`): kv_unified is on, so n_ctx is the full -c and the four
      // auto slots share that one pool — total_slots: 4, n_ctx: 16384.
      const fetchImpl = fetchWithProps({ default_generation_settings: { n_ctx: 16_384 }, total_slots: 4 },
        { models: [routerRow('Qwen3.5-2B-Q8_0', 'loaded')], urls });
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 16_384 } }));
      plantInstall();
      mgr = plantedManager(fetchImpl, cacheDir);

      const result = await mgr.effectiveContextWindow('Qwen3.5-2B-Q8_0');
      expect(result).toEqual({ contextLength: 16_384, totalSlots: 4 });
      // ONE /props read produced BOTH fields — the "no second HTTP round trip"
      // property — and it named the model, because a model-less /props carries
      // no slot field on this build at all. The status check rode /models, which
      // the supervisor was already fetching; it is not a second /props.
      expect(propsUrls(urls)).toEqual([namedProps('Qwen3.5-2B-Q8_0')]);
    });

    it('a LOADED model under an explicit --parallel 4 (kv_unified off): n_ctx is whatever the engine reports — -c/4 here — and is passed through, not second-guessed', async () => {
      const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
      const urls: string[] = [];
      // Measured 2026-09-04 on b10665 with the app's args PLUS `--parallel 4`:
      // kv_unified turns off, each slot gets its own 16384/4 window, and the
      // router reports that per-slot number. The supervisor does NOT pass
      // --parallel today; this pins that if someone adds it, the app follows the
      // engine's number rather than the -c it asked for.
      const fetchImpl = fetchWithProps({ default_generation_settings: { n_ctx: 4096 }, total_slots: 4 },
        { models: [routerRow('Qwen3.5-2B-Q8_0', 'loaded')], urls });
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 16_384 } }));
      plantInstall();
      mgr = plantedManager(fetchImpl, cacheDir);

      const result = await mgr.effectiveContextWindow('Qwen3.5-2B-Q8_0');
      expect(result).toEqual({ contextLength: 4096, totalSlots: 4 });
      expect(propsUrls(urls)).toEqual([namedProps('Qwen3.5-2B-Q8_0')]);
    });

    it('an UNLOADED model: the model-param URL is NEVER fetched; the model-less /props is; result is the configured -c with unknown slots', async () => {
      const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
      const urls: string[] = [];
      // If the code wrongly named the model, the stub would hand back this
      // loaded body and BOTH assertions below would fail — the numbers prove
      // the path, not only the URL spy.
      const fetchImpl = fetchWithProps({ default_generation_settings: { n_ctx: 16_384 }, total_slots: 4 },
        { models: [routerRow('Qwen3.5-2B-Q8_0', 'unloaded')], urls });
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 128_000 } }));
      plantInstall();
      mgr = plantedManager(fetchImpl, cacheDir);

      const result = await mgr.effectiveContextWindow('Qwen3.5-2B-Q8_0');
      expect(result).toEqual({ contextLength: 128_000, totalSlots: null });
      expect(propsUrls(urls)).toEqual([BARE_PROPS]);
      expect(urls).not.toContain(namedProps('Qwen3.5-2B-Q8_0'));
    });

    it('a SLEEPING model is treated exactly like an unloaded one (naming it would wake it) — F4', async () => {
      const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
      const urls: string[] = [];
      const fetchImpl = fetchWithProps({ default_generation_settings: { n_ctx: 16_384 }, total_slots: 4 },
        { models: [routerRow('Qwen3.5-2B-Q8_0', 'sleeping')], urls });
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 128_000 } }));
      plantInstall();
      mgr = plantedManager(fetchImpl, cacheDir);

      const result = await mgr.effectiveContextWindow('Qwen3.5-2B-Q8_0');
      expect(result).toEqual({ contextLength: 128_000, totalSlots: null });
      expect(propsUrls(urls)).toEqual([BARE_PROPS]);
      expect(urls).not.toContain(namedProps('Qwen3.5-2B-Q8_0'));
    });

    it('a model the router has never listed (absent from /models) also takes the model-less path', async () => {
      const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
      const urls: string[] = [];
      const fetchImpl = fetchWithProps({ default_generation_settings: { n_ctx: 16_384 }, total_slots: 4 },
        { models: [routerRow('some-other-model', 'loaded')], urls });
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 128_000 } }));
      plantInstall();
      mgr = plantedManager(fetchImpl, cacheDir);

      const result = await mgr.effectiveContextWindow('never-scanned');
      expect(result).toEqual({ contextLength: 128_000, totalSlots: null });
      expect(propsUrls(urls)).toEqual([BARE_PROPS]);
    });

    it('never polls with ?reload=1 on either path (the engine rule forbids it — it forces a disk rescan)', async () => {
      const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
      const urls: string[] = [];
      const fetchImpl = fetchWithProps({ default_generation_settings: { n_ctx: 16_384 }, total_slots: 4 },
        { models: [routerRow('a', 'loaded'), routerRow('b', 'unloaded')], urls });
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 16_384 } }));
      plantInstall();
      mgr = plantedManager(fetchImpl, cacheDir);

      await mgr.effectiveContextWindow('a');
      await mgr.effectiveContextWindow('b');
      expect(urls.filter((u) => new URL(u).searchParams.has('reload'))).toEqual([]);
    });

    it('URL-encodes the model id in the query (router ids can carry characters a query string cannot)', async () => {
      const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
      const urls: string[] = [];
      const fetchImpl = fetchWithProps({ default_generation_settings: { n_ctx: 16_384 }, total_slots: 4 },
        { models: [routerRow('odd model&id', 'loaded')], urls });
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 16_384 } }));
      plantInstall();
      mgr = plantedManager(fetchImpl, cacheDir);

      await mgr.effectiveContextWindow('odd model&id');
      expect(propsUrls(urls)).toEqual([`http://127.0.0.1:9999/props?model=${encodeURIComponent('odd model&id')}`]);
    });

    it('an OLDER build that still answers n_slots (no total_slots) is read through the fallback name', async () => {
      const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
      const fetchImpl = fetchWithProps({ default_generation_settings: { n_ctx: 32_768 }, n_slots: 2 },
        { models: [routerRow('some-model', 'loaded')] });
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
      plantInstall();
      mgr = plantedManager(fetchImpl, cacheDir);

      const result = await mgr.effectiveContextWindow('some-model');
      expect(result).toEqual({ contextLength: 32_768, totalSlots: 2 });
    });

    it('total_slots wins over a stray n_slots when a body somehow carries both', async () => {
      const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
      const fetchImpl = fetchWithProps({ default_generation_settings: { n_ctx: 16_384 }, total_slots: 4, n_slots: 1 },
        { models: [routerRow('some-model', 'loaded')] });
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 16_384 } }));
      plantInstall();
      mgr = plantedManager(fetchImpl, cacheDir);

      const result = await mgr.effectiveContextWindow('some-model');
      expect(result.totalSlots).toBe(4);
    });

    it('a loaded model whose body has no slot field at all resolves to unknown (null), not a guessed count, while context still resolves normally', async () => {
      const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
      const fetchImpl = fetchWithProps({ default_generation_settings: { n_ctx: 64_000 } }, // neither total_slots nor n_slots
        { models: [routerRow('some-model', 'loaded')] });
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 64_000 } }));
      plantInstall();
      mgr = plantedManager(fetchImpl, cacheDir);

      const result = await mgr.effectiveContextWindow('some-model');
      expect(result.contextLength).toBe(64_000);
      expect(result.totalSlots).toBeNull();
    });

    it('a literal total_slots: 0 resolves to unknown, mirroring n_ctx\'s own 0-means-unknown handling', async () => {
      const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
      const fetchImpl = fetchWithProps({ model_path: 'none', n_ctx: 0, total_slots: 0 },
        { models: [routerRow('some-model', 'loaded')] });
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 128_000 } }));
      plantInstall();
      mgr = plantedManager(fetchImpl, cacheDir);

      const result = await mgr.effectiveContextWindow('some-model');
      expect(result.contextLength).toBe(128_000);
      expect(result.totalSlots).toBeNull();
    });

    it('no engine installed yet: both fields are the conservative "unknown" default', async () => {
      mgr = new EngineManager(home, userData, 9999);
      const result = await mgr.effectiveContextWindow('some-model');
      expect(result.contextLength).toBe(32_768);
      expect(result.totalSlots).toBeNull();
    });
  });
});

// Per-model engine settings: saving them, and landing them without disturbing
// a reply (design §C1 / §C2, contract R26).
//
// THE FAILURE THESE GUARD AGAINST: `~/.youcoded/engine/models.ini` is ONE file
// shared by every local model, and `GET /models?reload=1` makes the router diff
// it and unload every model whose section changed. Downloads, deletes and
// refreshes all send that reload. So writing a model's new settings at save
// time — or applying them on somebody else's reload — drops the model in the
// middle of the answer the user is reading, which is the one thing contract R26
// promises will not happen.
//
// The other half is WHICH count says "this model is quiet". The engine-wide
// `inFlight` says the ENGINE is busy (a reply to a different model would hold
// this one's settings hostage), and the session ref-count never drops while a
// chat tab is open on the model. Only the per-model count `trackedFetch` keeps,
// read out of the request body's `model`, answers the question that is asked.
describe('per-model settings', () => {
  const children: any[] = [];
  function makeFakeChild(): ChildProcess {
    const ee = new EventEmitter() as any;
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.kill = vi.fn(() => { setImmediate(() => ee.emit('exit', 0)); return true; });
    ee.pid = 4242;
    children.push(ee);
    return ee;
  }

  const PORT = 9998;
  let root: string;
  let userData: string;
  let cacheDir: string;
  let home: NativeHome;
  let mgr: EngineManager | undefined;

  beforeEach(() => {
    mockSpawn.mockReset();
    children.length = 0;
    mockSpawn.mockImplementation(() => makeFakeChild());
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-model-settings-'));
    userData = path.join(root, 'userData');
    cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    // Two models on disk. Both are needed for the question this file exists to
    // answer: "does an apply wait for THIS model, or for the engine?"
    fs.writeFileSync(path.join(cacheDir, 'alpha.gguf'), 'x');
    fs.writeFileSync(path.join(cacheDir, 'beta.gguf'), 'x');
    home = new NativeHome(root);
  });
  afterEach(async () => {
    await mgr?.stopAll();
    // No retries on purpose: stopAll() now abandons every pending apply, so nothing
    // writes here after it (CI follow-ups Plan A, Task 3). If ENOTEMPTY ever returns,
    // the cancellation regressed — fix that, do not put the retries back.
    fs.rmSync(root, { recursive: true, force: true });
  });

  function plantInstall(backend = 'cpu') {
    const dir = path.join(userData, 'engine', `${ENGINE_VERSION}-${backend}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'fake');
    fs.writeFileSync(path.join(dir, '.complete'),
      JSON.stringify({ version: ENGINE_VERSION, backend, binaryRelPath: 'llama-server.exe' }));
  }

  /** Every URL fetched, in order, and the model id of every /models/unload. */
  let urls: string[];
  let unloaded: string[];

  function makeFetch() {
    urls = [];
    unloaded = [];
    const f: any = vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      urls.push(url);
      const own = f.streamFor?.(url, init);
      if (own) return own as any;
      if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ status: 'ok' }) } as any;
      if (url.includes('/models/unload')) {
        try { unloaded.push(JSON.parse(String(init?.body)).model); } catch { unloaded.push('?'); }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }
      // Both models listed, so ensureServable is satisfied and never fires a
      // rescan of its own — a stray reload would be counted as ours.
      if (url.includes('/models')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [
            { id: 'alpha', status: { value: 'unloaded' } },
            { id: 'beta', status: { value: 'unloaded' } },
          ] }),
        } as any;
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
    });
    return f;
  }

  function makeManager(fetchImpl: any, extra: Record<string, unknown> = {}) {
    return new EngineManager(home, userData, PORT, {
      fetchImpl,
      probeChip: async () => ({ vendor: null, gfxTarget: null }),
      supervisorOpts: { pidOnPort: () => 4242, readyDeadlineMs: 2_000, readyPollMs: 5 },
      configApplyPollMs: 2,
      // FAR longer than any wait in this file, deliberately. `vi.waitFor`'s
      // suite-wide default is 15 seconds (tests/setup-waitfor.ts), so a short
      // bound would make "it applied" true for a probe that meant "it applied
      // WITHOUT waiting" — measured: with a 5s bound, swapping the per-model count
      // for the engine-wide one left this file green. The one test that is about
      // the bound sets its own.
      configApplyMaxWaitMs: 60_000,
      // The real save-time flag check SPAWNS llama-server; there is no binary here.
      checkFlags: async () => ({ ok: true as const }),
      ...extra,
    });
  }

  // Spelled out rather than imported from model-presets: this file asserts WHERE
  // the preset lands, and reusing the function under test to say where to look
  // would make that assertion vacuous.
  const presetPath = () => path.join(root, '.youcoded', 'engine', 'models.ini');
  const readPreset = () => { try { return fs.readFileSync(presetPath(), 'utf8'); } catch { return ''; } };
  const engineSection = () => ((home.readJson('config.json') as any)?.engine ?? {});
  const storedFor = (id: string) => engineSection().models?.[id];
  const settled = () => new Promise((r) => setTimeout(r, 40));
  const reloads = () => urls.filter((u) => u.includes('reload=1'));

  /** The preset a freshly booted engine writes when no model has settings yet. */
  const BARE_PRESET = '[*]\nctx-size = 32768\nsleep-idle-seconds = 900\n';

  async function plantConfig(models: Record<string, unknown> = {}) {
    await home.mutateJson('config.json', () => ({
      v: 1, engine: { cacheDir, contextSize: 32_768, models },
    }));
  }

  // ---------------------------------------------------------------------------
  // A reply that is streaming right now, for a NAMED model, held open by the test.
  // ---------------------------------------------------------------------------
  /** Start a tracked streaming request that names `modelId` in its body — which is
   *  where `trackedFetch` reads the model from — and stays open until `finish()`.
   *  Pass `modelId: null` for a request that names no model at all. */
  async function startStreamingReply(m: EngineManager, fetchImpl: any, modelId: string | null) {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const prior = fetchImpl.streamFor;
    fetchImpl.streamFor = (url: string, init: any) => (url.includes('/chat/completions')
      && String(init?.body ?? '').includes(modelId === null ? '' : `"model":"${modelId}"`)
      ? new Response(source, { status: 200 })
      : prior?.(url, init));

    const hook = m.registryHook();
    await hook.ensureRunning();
    const tracked = hook.fetchImpl();
    const res = await tracked(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      // No body at all when the caller asked for an anonymous request: that is the
      // shape `requestModelId` cannot read a model out of.
      ...(modelId === null ? {} : { body: JSON.stringify({ model: modelId, messages: [] }) }),
    } as any);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = '';
    const decoder = new TextDecoder();
    const drain = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        text += decoder.decode(value);
      }
    })();
    controller.enqueue(encoder.encode('the first half '));
    await vi.waitFor(() => { expect(text).toBe('the first half '); });
    return {
      received: () => text,
      finish: async () => {
        controller.enqueue(encoder.encode('and the second.'));
        controller.close();
        await drain;
      },
    };
  }

  /** Boot with both models on disk and a reply streaming for `modelId`. */
  async function bootWithStream(modelId: string | null, extra: Record<string, unknown> = {}) {
    plantInstall();
    await plantConfig();
    const fetchImpl = makeFetch();
    mgr = makeManager(fetchImpl, extra);
    const reply = await startStreamingReply(mgr, fetchImpl, modelId);
    return { fetchImpl, reply, mgr: mgr! };
  }

  describe('models:set-settings — the save writes config, and NOTHING else', () => {
    it('leaves the preset file byte-for-byte as it was, and marks the change pending', async () => {
      const { reply } = await bootWithStream('alpha');
      // The engine wrote this on its way up, before any model had settings.
      expect(readPreset()).toBe(BARE_PRESET);
      urls.length = 0;

      const saved = await mgr!.setModelSettings('alpha', { contextLength: 8_192, keepLoaded: true });

      // The VALUE is saved at once — waiting to APPLY it is not waiting to save
      // it, or a crash in between would lose the user's answer.
      expect(saved).toMatchObject({ contextLength: 8_192, keepLoaded: true, pendingApply: true });
      expect(storedFor('alpha')).toMatchObject({ contextLength: 8_192, keepLoaded: true, pendingApply: true });
      // The whole file, not a substring: a section written into the wrong place,
      // or an extra key, would both pass a "does not contain 8192" check.
      expect(readPreset()).toBe(BARE_PRESET);
      expect(reloads()).toEqual([]);
      expect(unloaded).toEqual([]);

      await reply.finish();
      // …and only now does it land.
      await vi.waitFor(() => {
        expect(readPreset()).toBe(`${BARE_PRESET}\n[alpha]\nctx-size = 8192\nsleep-idle-seconds = -1\n`);
      }, { timeout: 2_000 });
      expect(storedFor('alpha').pendingApply).toBeUndefined();
      expect(reloads()).toHaveLength(1);
      expect(unloaded).toEqual(['alpha']);
      // The reply the wait exists to protect arrived whole.
      expect(reply.received()).toBe('the first half and the second.');
    });

    it('a save that changes nothing the engine reads never marks anything pending', async () => {
      plantInstall();
      await plantConfig({ alpha: { contextLength: 8_192, keepLoaded: false, gpuLayers: 'auto', extraFlags: '' } });
      mgr = makeManager(makeFetch());

      // The same values again, and a dismissal — neither is a reason to unload a
      // model and make the user pay for the load again.
      const saved = await mgr.setModelSettings('alpha', { contextLength: 8_192, keepLoaded: false });
      expect(saved.pendingApply).toBeUndefined();
      await settled();
      expect(readPreset()).toBe('');       // never booted, never written
      expect(reloads()).toEqual([]);
    });

    it('saving one model never touches another model\'s settings', async () => {
      plantInstall();
      await plantConfig();
      mgr = makeManager(makeFetch());

      await mgr.setModelSettings('alpha', { contextLength: 4_096 });
      await mgr.setModelSettings('beta', { keepLoaded: true });

      // WHY this is a test and not an obvious truth: the only writer that existed
      // before this task replaced the WHOLE `engine.models` section, so writing
      // one model through it would delete every other model's settings on every
      // save. The merge has to happen inside the file lock, per model.
      expect(storedFor('alpha')).toMatchObject({ contextLength: 4_096 });
      expect(storedFor('beta')).toMatchObject({ keepLoaded: true });
    });

    it('a dismissed memory warning records the RESOLVED context length, which main computes', async () => {
      plantInstall();
      await plantConfig();
      mgr = makeManager(makeFetch());

      // No per-model length yet: the effective length is the engine-wide one.
      await mgr.setModelSettings('beta', { dismissMemoryWarning: true });
      expect(storedFor('beta').memoryWarningDismissed).toMatchObject({ contextLength: 32_768 });
      // A dismissal changes nothing the engine reads, so it must not cost a reload
      // and an unload.
      expect(storedFor('beta').pendingApply).toBeUndefined();

      // With one, THAT is the effective length — and the stored `contextLength`
      // field alone could not have said so, because it is null for a model on the
      // engine-wide default.
      await mgr.setModelSettings('alpha', { contextLength: 8_192, dismissMemoryWarning: true });
      expect(storedFor('alpha').memoryWarningDismissed).toMatchObject({ contextLength: 8_192 });

      await mgr.setModelSettings('alpha', { dismissMemoryWarning: false });
      expect(storedFor('alpha').memoryWarningDismissed).toBeNull();
    });

    it('refuses a context length under the engine\'s floor and a bad extra flag, in the words the dialog shows', async () => {
      plantInstall();
      await plantConfig();
      mgr = makeManager(makeFetch());

      await expect(mgr.setModelSettings('alpha', { contextLength: 512 }))
        .rejects.toThrow('Context length must be at least 1024 tokens.');
      await expect(mgr.setModelSettings('alpha', { extraFlags: 'not-a-flag' }))
        .rejects.toThrow('"not-a-flag" does not follow an option. Write each one as --name or --name value.');
      await expect(mgr.setModelSettings('alpha', { extraFlags: '--ctx-size 999' }))
        .rejects.toThrow('--ctx-size is set from the controls above. Change it there instead.');
      expect(storedFor('alpha')).toBeUndefined();   // nothing was written
    });

    it('refuses an extra flag the BINARY does not recognise, quoting the engine', async () => {
      plantInstall();
      await plantConfig();
      mgr = makeManager(makeFetch(), {
        // Stands in for running llama-server against a throwaway preset. Only a
        // non-zero exit rejects; this is that case.
        checkFlags: async () => ({ ok: false as const, message: "option 'not-a-real-flag' not recognized in preset 'alpha'" }),
      });

      await expect(mgr.setModelSettings('alpha', { extraFlags: '--not-a-real-flag 7' }))
        .rejects.toThrow("option 'not-a-real-flag' not recognized in preset 'alpha'");
      expect(storedFor('alpha')).toBeUndefined();
    });

    it('ignores the two fields the app owns, even when a caller sends them', async () => {
      plantInstall();
      await plantConfig();
      mgr = makeManager(makeFetch());

      // WHY this is a test and not left to TypeScript: TypeScript stops at the
      // process boundary. A remote client is a browser on the network, and
      // remote-server passes the patch it receives straight through — so a
      // hand-written WebSocket message can carry anything at all. `pendingApply`
      // forged true would make the dialog say "Applies after the current reply"
      // forever, and a forged `lastLoadError` would show the user an engine
      // failure that never happened.
      const saved = await mgr.setModelSettings('alpha', {
        keepLoaded: true,
        pendingApply: true,
        lastLoadError: 'the engine never said this',
        memoryWarningDismissed: { at: 1, contextLength: 999_999 },
      } as never);

      expect(saved.lastLoadError).toBeUndefined();
      expect(storedFor('alpha').lastLoadError).toBeUndefined();
      // A dismissal can only be made by asking for one, and main stamps the
      // number — a caller cannot post its own.
      expect(saved.memoryWarningDismissed).toBeNull();
      expect(storedFor('alpha').memoryWarningDismissed).toBeNull();
      // keepLoaded IS a field the dialog owns, so it lands, and pendingApply is
      // true here because keepLoaded genuinely changed — not because it was sent.
      expect(saved.keepLoaded).toBe(true);
    });

    it('hands the settings dialog the two fields the app maintains (T23 reads these)', async () => {
      plantInstall();
      // A model whose last load failed and whose save has not reached the engine.
      await plantConfig({
        alpha: {
          contextLength: 8_192, keepLoaded: false, gpuLayers: 'auto', extraFlags: '',
          pendingApply: true, lastLoadError: 'failed to load model: out of device memory',
        },
      });
      mgr = makeManager(makeFetch());

      // WHY pinned: the renderer's declared type says the read returns the STORED
      // record, and the dialog draws a line from each of these. If the read ever
      // narrowed to the four user-settable fields, both lines would go blank in
      // the shipped app with every test still green.
      const read = mgr.modelSettings('alpha');
      expect(read.pendingApply).toBe(true);
      expect(read.lastLoadError).toBe('failed to load model: out of device memory');
    });
  });

  describe('the apply waits on the PER-MODEL count, not the engine-wide one', () => {
    it('applies a quiet model\'s change while a DIFFERENT model is streaming', async () => {
      const { reply } = await bootWithStream('beta');
      urls.length = 0;

      await mgr!.setModelSettings('alpha', { contextLength: 4_096 });

      // The engine is busy — `supervisor.busy()` is true this whole time — but
      // ALPHA is not, and alpha is the model whose settings changed. An apply
      // gated on the engine-wide count would still be waiting here, and the
      // EXPLICIT budget is what says so: the bound is a minute away, and the
      // suite-wide waitFor default is fifteen seconds.
      await vi.waitFor(() => {
        expect(readPreset()).toBe(`${BARE_PRESET}\n[alpha]\nctx-size = 4096\n`);
      }, { timeout: 2_000 });
      expect(unloaded).toEqual(['alpha']);
      expect(storedFor('alpha').pendingApply).toBeUndefined();

      // …and beta, which never asked for anything, was not unloaded and its reply
      // is intact.
      await reply.finish();
      expect(reply.received()).toBe('the first half and the second.');
      expect(unloaded).not.toContain('beta');
    });

    it('waits when the streaming reply IS this model\'s', async () => {
      const { reply } = await bootWithStream('alpha');
      urls.length = 0;

      await mgr!.setModelSettings('alpha', { contextLength: 4_096 });
      await settled();   // ~20 poll intervals

      expect(readPreset()).toBe(BARE_PRESET);
      expect(storedFor('alpha').pendingApply).toBe(true);
      expect(unloaded).toEqual([]);

      await reply.finish();
      await vi.waitFor(() => { expect(unloaded).toEqual(['alpha']); }, { timeout: 2_000 });
    });

    it('a request that names no model holds nothing — its own body is where the model is read', async () => {
      // The engine-wide count is 1 for this request; the per-model count for alpha
      // is 0, because `requestModelId` found no `model` in the body. So alpha's
      // change lands. This is the same discrimination as the first probe, from the
      // other side: an apply gated on `busy()` would hang here for the full bound.
      const { reply } = await bootWithStream(null);
      urls.length = 0;

      await mgr!.setModelSettings('alpha', { contextLength: 4_096 });
      await vi.waitFor(() => {
        expect(readPreset()).toBe(`${BARE_PRESET}\n[alpha]\nctx-size = 4096\n`);
      }, { timeout: 2_000 });
      await reply.finish();
      expect(reply.received()).toBe('the first half and the second.');
    });

    it('applies anyway once the bound runs out — a stream that never ends cannot park a setting forever', async () => {
      // 30 ms stands in for the shipped ten minutes (design §C2).
      await bootWithStream('alpha', { configApplyMaxWaitMs: 30 });
      urls.length = 0;

      await mgr!.setModelSettings('alpha', { contextLength: 4_096 });
      // Deliberately never finished.
      await vi.waitFor(() => { expect(unloaded).toEqual(['alpha']); });
      expect(readPreset()).toBe(`${BARE_PRESET}\n[alpha]\nctx-size = 4096\n`);
      expect(storedFor('alpha').pendingApply).toBeUndefined();
    });

    it('two saves to one model during one reply cost ONE apply, not two', async () => {
      const { reply } = await bootWithStream('alpha');
      urls.length = 0;

      await mgr!.setModelSettings('alpha', { keepLoaded: true });
      await mgr!.setModelSettings('alpha', { keepLoaded: false });
      await settled();
      expect(reloads()).toEqual([]);        // still nothing — the reply is streaming

      await reply.finish();
      await vi.waitFor(() => { expect(reloads()).toHaveLength(1); }, { timeout: 2_000 });
      // …and then keep watching: a SECOND apply would land just after the first,
      // and "one reload so far" is not on its own proof that there is only one.
      await settled();

      expect(reloads()).toHaveLength(1);
      expect(unloaded).toEqual(['alpha']);
      // Toggled off and on again: the net-zero change costs one unload, not three.
      expect(storedFor('alpha')).toMatchObject({ keepLoaded: false });
      expect(storedFor('alpha').pendingApply).toBeUndefined();
      expect(readPreset()).toBe(BARE_PRESET);   // back to no section at all
    });
  });

  describe('a deferred ENGINE-WIDE change cannot ride out on somebody else\'s reload', () => {
    it('a finished download does not apply a context length the user is still waiting on', async () => {
      const { reply } = await bootWithStream('alpha');
      expect(readPreset()).toBe(BARE_PRESET);

      // Destin raises the engine-wide context while a reply is streaming. This is
      // CORRECTLY deferred — the card says "Applies after the current reply".
      await mgr!.setConfig({ contextSize: 65_536 });
      expect(engineSection().contextSize).toBe(65_536);   // saved at once
      expect(mgr!.status().configApplyPending).toBe(true); // not applied
      urls.length = 0;

      // A model he started downloading earlier finishes; ipc-handlers calls this.
      await mgr!.refreshModels();

      // `[*]` is what every model with no section of its own inherits. Rendering
      // it from config here would put the new length in the file, and the reload
      // this call makes would cut the reply he is reading — with nothing
      // connecting it to the setting he changed. The whole file, exactly.
      expect(readPreset()).toBe(BARE_PRESET);
      expect(reloads()).toHaveLength(1);   // the refresh's own reload still happened
      expect(unloaded).toEqual([]);

      // The reply survives whole…
      await reply.finish();
      expect(reply.received()).toBe('the first half and the second.');
      // …and only then does the context change land.
      await vi.waitFor(() => {
        expect(readPreset()).toBe('[*]\nctx-size = 65536\nsleep-idle-seconds = 900\n');
      }, { timeout: 2_000 });
    });

    it('a per-model apply carries the OLD engine-wide value while that one is still queued', async () => {
      // Two deferred changes at once, one engine-wide and one per-model, with only
      // the per-model one ready to land: beta is quiet, so its section is written
      // and reloaded — and that write must not smuggle `[*]` out with it.
      const { reply } = await bootWithStream('alpha');
      await mgr!.setConfig({ contextSize: 65_536 });
      urls.length = 0;

      await mgr!.setModelSettings('beta', { contextLength: 4_096 });
      await vi.waitFor(() => { expect(unloaded).toEqual(['beta']); }, { timeout: 2_000 });

      expect(readPreset()).toBe(`${BARE_PRESET}\n[beta]\nctx-size = 4096\n`);
      await reply.finish();
      expect(reply.received()).toBe('the first half and the second.');
    });
  });

  describe('each model\'s bound is its OWN, and a fallback boot applies nothing', () => {
    // Long enough that a MISSING per-id deadline is what fails these, not the
    // machine's speed: the two saves are a second apart and the bound is two, so
    // one model landing before the other is an ordering fact, never a clock
    // reading (`.claude/rules/test-suite-hygiene.md` — never assert wall time).
    const BOUND_MS = 2_000;
    const GAP_MS = 1_000;

    /** Both models wedged: two streams that are never finished. */
    async function twoWedgedReplies() {
      plantInstall();
      await plantConfig();
      const fetchImpl = makeFetch();
      mgr = makeManager(fetchImpl, { configApplyMaxWaitMs: BOUND_MS });
      await startStreamingReply(mgr, fetchImpl, 'alpha');
      await startStreamingReply(mgr, fetchImpl, 'beta');
      return fetchImpl;
    }

    it('a second model\'s change gets its own full wait, not what is left of the first\'s', async () => {
      await twoWedgedReplies();

      await mgr!.setModelSettings('alpha', { contextLength: 4_096 });
      await new Promise((r) => setTimeout(r, GAP_MS));
      await mgr!.setModelSettings('beta', { contextLength: 8_192 });

      // Alpha's bound runs out first because alpha's change is older.
      await vi.waitFor(() => { expect(unloaded).toContain('alpha'); }, { timeout: 5_000 });
      // And beta is NOT swept in with it. This is the whole point: with one shared
      // deadline, beta's reply would be cut a second after it was saved, on a
      // bound that is supposed to be the full wait.
      expect(unloaded).not.toContain('beta');
      // It still lands, on its own clock.
      await vi.waitFor(() => { expect(unloaded).toContain('beta'); }, { timeout: 5_000 });
    });

    it('saving the same model twice does not push its own deadline out', async () => {
      await twoWedgedReplies();

      await mgr!.setModelSettings('alpha', { contextLength: 4_096 });
      await new Promise((r) => setTimeout(r, GAP_MS));
      // The second save to alpha joins the wait the first one bought. Beta, saved
      // at the same moment, starts its own — so alpha must still land first.
      await mgr!.setModelSettings('alpha', { contextLength: 5_120 });
      await mgr!.setModelSettings('beta', { contextLength: 8_192 });

      await vi.waitFor(() => { expect(unloaded).toContain('alpha'); }, { timeout: 5_000 });
      expect(unloaded).not.toContain('beta');
      // One apply for the two alpha saves, carrying the LAST value.
      expect(readPreset()).toContain('[alpha]\nctx-size = 5120');
    });

    /** Boot an engine that refuses the preset file outright, so it falls back to
     *  the old command line (T7) and `presetInForce()` is false. */
    async function bootWithoutPreset(models: Record<string, unknown> = {}) {
      plantInstall();
      await plantConfig(models);
      const first = makeFakeChild();
      const second = makeFakeChild();
      mockSpawn.mockReset();
      mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
      let firstDead = false;
      urls = [];
      unloaded = [];
      const fetchImpl: any = vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        urls.push(url);
        if (!firstDead) throw new Error('ECONNREFUSED');
        if (url.endsWith('/health')) return { ok: true, status: 200 } as any;
        if (url.includes('/models/unload')) {
          try { unloaded.push(JSON.parse(String(init?.body)).model); } catch { unloaded.push('?'); }
          return { ok: true, status: 200, json: async () => ({}) } as any;
        }
        return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
      });
      mgr = makeManager(fetchImpl, { supervisorOpts: { pidOnPort: () => 4242, readyDeadlineMs: 5_000, readyPollMs: 5 } });
      const booting = mgr.registryHook().ensureRunning();
      setImmediate(() => {
        // The engine's own words for "I could not read that file at all" — no
        // model is named, so there is no section to drop and T7 boots without it.
        first.stderr!.emit('data', Buffer.from(
          '0.00.050.247 E srv    llama_server: failed to parse server config file: models.ini'
        ));
        firstDead = true;
        first.emit('exit', 1);
      });
      await booting;
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      return fetchImpl;
    }

    it('an engine running WITHOUT its preset does not reload or unload to apply a change', async () => {
      await bootWithoutPreset();
      urls.length = 0;

      // Nothing is streaming, so the apply would normally run at once.
      await mgr!.setModelSettings('alpha', { contextLength: 4_096 });
      await settled();

      // This engine never opened models.ini. A reload could not read the change,
      // and the unload after it would cost a full model load for nothing.
      expect(reloads()).toEqual([]);
      expect(unloaded).toEqual([]);
      // …and the change is still honestly marked as not in force.
      expect(storedFor('alpha').pendingApply).toBe(true);
    });

    it('T23: the CARD is told — status reports per-model settings NOT in force', async () => {
      // WHY this has to be on the status and not only inside the supervisor: the
      // fallback exists so a settings file the engine cannot use produces a
      // working engine rather than a dead one, and until this field reached the
      // renderer that rescue was completely silent. The user's per-model context
      // length and extra flags are being ignored for this whole run.
      await bootWithoutPreset();
      expect(mgr!.status().modelSettingsInForce).toBe(false);
    });

    it('T23: the status carries the ENGINE\'S OWN reason, not just the bad news', async () => {
      // `engine-supervisor.ts` used to drop this in a bare `catch {}` / an
      // unexamined startup output, which left the card able to say only that
      // something had gone wrong — the exact shape
      // docs/error-message-standards.md exists to stop.
      await bootWithoutPreset();
      expect(mgr!.status().modelSettingsError).toBe('failed to parse server config file: models.ini');
    });

    it('T23: a preset the app could not WRITE carries the OS\'s own error to the card', async () => {
      // The other route to a settings-less run, and the one design §J names: this
      // failure used to land in a bare `catch {}`, so the reason a user's
      // per-model settings were being ignored was destroyed at the moment it was
      // known.
      plantInstall();
      await plantConfig();
      mgr = makeManager(makeFetch(), {
        supervisorOpts: {
          pidOnPort: () => 4242, readyDeadlineMs: 2_000, readyPollMs: 5,
          writePresetImpl: () => { throw new Error("EACCES: permission denied, open '/home/you/.youcoded/engine/models.ini'"); },
        },
      });
      await mgr.registryHook().ensureRunning();
      expect(mgr.status().modelSettingsInForce).toBe(false);
      expect(mgr.status().modelSettingsError).toBe("EACCES: permission denied, open '/home/you/.youcoded/engine/models.ini'");
    });

    it('T23: a normal boot reports them in force, and a stopped engine reports NOTHING', async () => {
      plantInstall();
      await plantConfig();
      mgr = makeManager(makeFetch());
      // Not `false`. Nobody has asked the engine anything yet, and `false` here
      // would tell every user with a stopped engine that their settings are being
      // ignored — a claim about a run that has not happened.
      expect(mgr.status().modelSettingsInForce).toBeUndefined();
      await mgr.registryHook().ensureRunning();
      expect(mgr.status().modelSettingsInForce).toBe(true);
      expect(mgr.status().modelSettingsError).toBeNull();
    });

    it('a fallback boot does NOT clear a pending change — nothing was read to put it in force', async () => {
      // The gate that makes this true is `presetInForce()` in notePresetInForce.
      // Its sibling — only acting on the TRANSITION into running — has no test:
      // the supervisor emits no status-changed while it is already running, so the
      // only way to reach a second one is restart(), and the check is there as
      // insurance rather than for a path that exists today.
      await bootWithoutPreset({ alpha: { contextLength: 4_096, pendingApply: true } });
      await settled();

      expect(storedFor('alpha').pendingApply).toBe(true);
    });

    it('stopAll() abandons pending applies: nothing is written, reloaded or spawned after it returns', async () => {
      plantInstall();
      await plantConfig();
      const fetchImpl = makeFetch();
      // A short bound, so an abandoned waiter's deadline passes INSIDE this test
      // and would land its write if stopAll had not cancelled it.
      mgr = makeManager(fetchImpl, { configApplyMaxWaitMs: 150 });
      await startStreamingReply(mgr, fetchImpl, 'alpha');      // alpha is busy: both saves wait
      // WHY the clock is frozen (Date only — timers stay real, so the waiters'
      // polls keep running): both deadlines are read off Date.now(). On the real
      // clock, a runner that took over 150ms between setConfig() and the pending
      // check saw the engine-wide waiter hit its deadline and apply BEFORE stopAll,
      // so `configApplyPending` read false (ubuntu CI run 35326015829; a 200ms
      // pause there reproduces it). Frozen, no deadline passes until we move it.
      vi.useFakeTimers({ toFake: ['Date'] });
      onTestFinished(() => { vi.useRealTimers(); });
      // Both waiters: an engine-wide change (requestApply) and a per-model one
      // (noteModelApply) — they are separate loops and each must stop.
      await mgr.setConfig({ contextSize: 65_536 });
      await mgr.setModelSettings('alpha', { contextLength: 4_096 });
      expect(mgr.status().configApplyPending).toBe(true);
      expect(storedFor('alpha').pendingApply).toBe(true);

      await mgr.stopAll();
      // Past both deadlines at once, and only now that stop has returned.
      vi.setSystemTime(Date.now() + 60 * 60_000);
      const presetAfterStop = readPreset();
      const spawnsAfterStop = mockSpawn.mock.calls.length;
      const urlsAfterStop = urls.length;
      expect(mgr.status().configApplyPending).toBe(false);

      // Past the deadline: an un-cancelled waiter would write models.ini, reload
      // and unload here.
      await new Promise((r) => setTimeout(r, 400));
      expect(readPreset()).toBe(presetAfterStop);
      expect(mockSpawn.mock.calls.length).toBe(spawnsAfterStop);
      expect(urls.length).toBe(urlsAfterStop);
      expect(unloaded).toEqual([]);
      // The saved change stays marked pending on disk: the next launch's engine
      // reads it on its way up (notePresetInForce), so abandoning loses nothing.
      expect(storedFor('alpha').pendingApply).toBe(true);
      // And the temp root can be removed with NO retries — the ENOTEMPTY this file
      // carried a retry band-aid for cannot happen once nothing writes after stop.
      expect(() => fs.rmSync(root, { recursive: true })).not.toThrow();
      fs.mkdirSync(root, { recursive: true }); // afterEach removes it again
    });
  });

  describe('refreshModels() merges pending changes only for IDLE models', () => {
    it('lands the quiet model\'s change and leaves the busy model\'s alone', async () => {
      plantInstall();
      await plantConfig();
      const fetchImpl = makeFetch();
      // The waiter is asleep for the whole test, so what lands is what
      // refreshModels() itself merged — not a poll tick that raced it.
      mgr = makeManager(fetchImpl, { configApplyPollMs: 60_000, configApplyMaxWaitMs: 60_000 });

      const alphaReply = await startStreamingReply(mgr, fetchImpl, 'alpha');
      const betaReply = await startStreamingReply(mgr, fetchImpl, 'beta');
      await mgr.setModelSettings('alpha', { contextLength: 4_096 });
      await mgr.setModelSettings('beta', { contextLength: 16_384 });
      expect(readPreset()).toBe(BARE_PRESET);

      // Beta goes quiet; alpha is still answering.
      await betaReply.finish();
      urls.length = 0;
      unloaded.length = 0;

      // What a finished download, or a delete, does.
      await mgr.refreshModels();

      // Beta's change rode along on the reload that was happening anyway…
      expect(storedFor('beta').pendingApply).toBeUndefined();
      expect(unloaded).toEqual(['beta']);
      // …and alpha's did not: its section is absent from the file exactly as it
      // was before, so the router's diff has nothing to unload it for.
      expect(readPreset()).toBe(`${BARE_PRESET}\n[beta]\nctx-size = 16384\n`);
      expect(storedFor('alpha').pendingApply).toBe(true);
      expect(unloaded).not.toContain('alpha');

      await alphaReply.finish();
      expect(alphaReply.received()).toBe('the first half and the second.');
    });
  });

  describe('keep loaded, and deleting a model', () => {
    it('the last-session release skips a keep-loaded model and frees any other', async () => {
      plantInstall();
      await plantConfig({
        alpha: { keepLoaded: true },
        beta: { keepLoaded: false },
      });
      const fetchImpl = makeFetch();
      mgr = makeManager(fetchImpl);
      await mgr.registryHook().ensureRunning();
      unloaded.length = 0;

      // The last chat on alpha closed. Keeping it loaded is the whole setting: if
      // this freed it, the next message would pay the full load again.
      await mgr.releaseModel('alpha');
      expect(unloaded).toEqual([]);

      await mgr.releaseModel('beta');
      expect(unloaded).toEqual(['beta']);

      // An explicit unload still means it — releaseModel is the only caller that
      // honours the setting.
      await mgr.unloadModel('alpha');
      expect(unloaded).toEqual(['beta', 'alpha']);
    });

    it('deleting a model with a change still queued does not write the entry back', async () => {
      plantInstall();
      await plantConfig();
      const fetchImpl = makeFetch();
      // The waiter sleeps for the whole test, so the queued change is still queued
      // when the delete arrives — which is the state this probe is about.
      mgr = makeManager(fetchImpl, { configApplyPollMs: 60_000, configApplyMaxWaitMs: 60_000 });

      const reply = await startStreamingReply(mgr, fetchImpl, 'alpha');
      await mgr.setModelSettings('alpha', { contextLength: 4_096 });
      expect(storedFor('alpha').pendingApply).toBe(true);
      await reply.finish();   // alpha is now idle, but the waiter is asleep

      await mgr.deleteModel('alpha');

      // deleteModel prunes the entry and THEN refreshes the router. The refresh
      // folds in pending changes for idle models — so without dropping alpha from
      // the queue first, it would clear a flag on the model just deleted and
      // recreate the whole entry a line after removing it.
      expect(storedFor('alpha')).toBeUndefined();
    });

    it('deleting a model takes its settings with it', async () => {
      plantInstall();
      await plantConfig({
        alpha: { contextLength: 4_096, keepLoaded: true },
        beta: { contextLength: 8_192 },
      });
      mgr = makeManager(makeFetch());
      await mgr.registryHook().ensureRunning();

      await mgr.deleteModel('alpha');

      // Gone, so a re-download of the same model cannot silently inherit it, and
      // the preset cannot carry a section naming a model that is not on disk.
      expect(storedFor('alpha')).toBeUndefined();
      expect(storedFor('beta')).toMatchObject({ contextLength: 8_192 });
      expect(readPreset()).toBe(`${BARE_PRESET}\n[beta]\nctx-size = 8192\n`);
    });
  });

  describe('lastLoadError has TWO sources, and both reach the model', () => {
    it('source 1 — the router\'s own message when a load of that model fails', async () => {
      plantInstall();
      await plantConfig();
      const fetchImpl = makeFetch();
      let failing = true;
      fetchImpl.streamFor = (url: string) => (url.includes('/chat/completions')
        ? (failing
          ? { ok: false, status: 500, text: async () => '{"error":{"message":"failed to load model: unable to allocate buffer"}}' }
          : { ok: true, status: 200, text: async () => '' })
        : undefined);
      mgr = makeManager(fetchImpl);

      await mgr.loadModel('alpha');
      await vi.waitFor(() => {
        // The engine's own sentence, exactly — never a paraphrase and never a
        // guessed cause.
        expect(storedFor('alpha')?.lastLoadError).toBe('failed to load model: unable to allocate buffer');
      });
      // Only the model that failed.
      expect(storedFor('beta')).toBeUndefined();

      // And it clears when that model is LOADED again — an explicit load, which is
      // what pressing Reload Model and what resuming a session both do. A plain
      // chat send does not clear it; it would otherwise be on screen for ever
      // after one bad afternoon.
      failing = false;
      await mgr.loadModel('alpha');
      await vi.waitFor(() => { expect(storedFor('alpha').lastLoadError).toBeUndefined(); });
    });

    it('source 2 — the startup rejection, for a model that never got a router row to fail on', async () => {
      plantInstall();
      // This model's saved flag is one llama-server does not know. The engine
      // refuses to initialise on it, T7 retries with alpha's section dropped, and
      // alpha therefore never appears as a router row that could fail a load —
      // this event is the only place its failure is visible at all.
      await plantConfig({ alpha: { extraFlags: '--not-a-real-flag 7' } });

      const first = makeFakeChild();
      const second = makeFakeChild();
      mockSpawn.mockReset();
      mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
      let firstDead = false;
      const fetchImpl: any = vi.fn(async (input: any) => {
        const url = String(input);
        if (!firstDead) throw new Error('ECONNREFUSED');
        if (url.endsWith('/health')) return { ok: true, status: 200 } as any;
        return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
      });
      mgr = makeManager(fetchImpl, { supervisorOpts: { pidOnPort: () => 4242, readyDeadlineMs: 5_000, readyPollMs: 5 } });

      const booting = mgr.registryHook().ensureRunning();
      setImmediate(() => {
        first.stderr!.emit('data', Buffer.from(
          '0.00.050.247 E srv    llama_server: failed to initialize router models: '
          + "option 'not-a-real-flag' not recognized in preset 'alpha'"
        ));
        firstDead = true;
        first.emit('exit', 1);
      });
      await booting;

      expect(mockSpawn).toHaveBeenCalledTimes(2);   // refused, then retried without alpha
      await vi.waitFor(() => {
        expect(storedFor('alpha')?.lastLoadError).toBe(
          "failed to initialize router models: option 'not-a-real-flag' not recognized in preset 'alpha'",
        );
      });
    });
  });

  describe('a fresh engine reads every saved change on its way up', () => {
    it('clears pendingApply once it is running with the preset in force', async () => {
      plantInstall();
      // What an app restart looks like: a change saved during a reply, and the
      // process gone before the wait ended. The flag lives in config.json, so
      // without this it would promise "Applies after the current reply" for ever.
      await plantConfig({ alpha: { contextLength: 4_096, pendingApply: true } });
      const fetchImpl = makeFetch();
      mgr = makeManager(fetchImpl);

      await mgr.registryHook().ensureRunning();

      // The spawn wrote the file from config — alpha's change IS what the engine
      // is running.
      expect(readPreset()).toBe(`${BARE_PRESET}\n[alpha]\nctx-size = 4096\n`);
      await vi.waitFor(() => { expect(storedFor('alpha').pendingApply).toBeUndefined(); });
      expect(storedFor('alpha')).toMatchObject({ contextLength: 4_096 });
      // Nothing was unloaded to achieve it: the process that just started has the
      // settings already.
      expect(unloaded).toEqual([]);
    });
  });
});

// `engine:set-config` — the one write for every engine-wide setting, and the
// wait that keeps it from killing a reply (design §B / §C2 / §C3).
//
// THE FAILURE THESE GUARD AGAINST: `EngineSupervisor.stop()` has no in-flight
// guard of its own — the only `inFlight > 0` check in the whole class is inside
// the idle timer — so restarting the engine the instant a switch is flipped
// SIGTERMs llama-server mid-answer and the streaming reply the user is reading
// dies halfway through a sentence. The signed contract (R19) promises the
// opposite: "a model in use reloads on its next message".
describe('engine:set-config', () => {
  const children: any[] = [];
  function makeFakeChild(): ChildProcess {
    const ee = new EventEmitter() as any;
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.kill = vi.fn(() => { setImmediate(() => ee.emit('exit', 0)); return true; });
    ee.pid = 4242;
    children.push(ee);
    return ee;
  }

  const PORT = 9999;
  let root: string;
  let userData: string;
  let cacheDir: string;
  let home: NativeHome;
  let mgr: EngineManager | undefined;

  beforeEach(() => {
    mockSpawn.mockReset();
    children.length = 0;
    mockSpawn.mockImplementation(() => makeFakeChild());
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-set-config-'));
    userData = path.join(root, 'userData');
    cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    home = new NativeHome(root);
  });
  afterEach(async () => {
    await mgr?.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function plantInstall(backend = 'cpu') {
    const dir = path.join(userData, 'engine', `${ENGINE_VERSION}-${backend}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'fake');
    fs.writeFileSync(path.join(dir, '.complete'),
      JSON.stringify({ version: ENGINE_VERSION, backend, binaryRelPath: 'llama-server.exe' }));
  }

  /** Every URL the manager or the supervisor fetched, in order. */
  let urls: string[];

  /** /health answers ok; everything else answers an empty JSON body. A caller can
   *  hand back its own Response for one URL prefix (the streaming reply below). */
  function makeFetch(special?: (url: string) => Response | undefined) {
    urls = [];
    const f: any = vi.fn(async (input: any, _init?: any) => {
      const url = String(input);
      urls.push(url);
      const own = special?.(url);
      if (own) return own as any;
      if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ status: 'ok' }) } as any;
      // A test can make the reload fail the way the engine really fails it: the
      // router answers 500 and goes on serving the OLD presets.
      if (url.includes('reload=1') && f.reloadFails) return f.reloadFails as any;
      return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
    });
    return f;
  }

  function makeManager(fetchImpl: any, extra: Record<string, unknown> = {}) {
    return new EngineManager(home, userData, PORT, {
      fetchImpl,
      // A chip probe that answers instantly: status() warms it, and the real one
      // shells out to nvidia-smi / ldconfig.
      probeChip: async () => ({ vendor: null, gfxTarget: null }),
      supervisorOpts: { pidOnPort: () => 4242, readyDeadlineMs: 2_000, readyPollMs: 5 },
      // A suite cannot spend the real ten minutes proving the bound exists.
      configApplyPollMs: 2,
      configApplyMaxWaitMs: 5_000,
      ...extra,
    });
  }

  // Spelled out rather than imported from model-presets: this test is asserting
  // WHERE the engine's preset file lands, and reusing the function under test to
  // say where to look would make that assertion vacuous.
  const presetPath = () => path.join(root, '.youcoded', 'engine', 'models.ini');
  const engineSection = () => ((home.readJson('config.json') as any)?.engine ?? {});
  const settled = () => new Promise((r) => setTimeout(r, 40));

  // ---------------------------------------------------------------------------
  // A reply that is streaming right now, held open by the test.
  // ---------------------------------------------------------------------------
  /** Boot the engine and start a tracked streaming request that stays open until
   *  `finish()` is called. Returns the text the caller actually received, so the
   *  test can prove the reply survived rather than merely that nothing crashed. */
  async function startStreamingReply(m: EngineManager, fetchImpl: any) {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    // The chat request answers with that stream; everything else keeps the
    // default behaviour above.
    (fetchImpl as any).streamFor = (url: string) => (url.includes('/chat/completions')
      ? new Response(source, { status: 200 })
      : undefined);

    const hook = m.registryHook();
    await hook.ensureRunning();
    const tracked = hook.fetchImpl();
    const res = await tracked(`http://127.0.0.1:${PORT}/v1/chat/completions`, { method: 'POST' } as any);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = '';
    const decoder = new TextDecoder();
    const drain = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        text += decoder.decode(value);
      }
    })();
    controller.enqueue(encoder.encode('the first half '));
    await vi.waitFor(() => { expect(text).toBe('the first half '); });
    return {
      received: () => text,
      finish: async () => {
        controller.enqueue(encoder.encode('and the second.'));
        controller.close();
        await drain;
      },
    };
  }

  describe('engine:set-config — a speed switch waits for the reply to finish', () => {
    it('does not kill a streaming reply, and restarts the moment it ends', async () => {
      plantInstall();
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
      let stream: ((url: string) => Response | undefined) | undefined;
      const fetchImpl: any = makeFetch((url) => stream?.(url));
      stream = (url) => (fetchImpl.streamFor ? fetchImpl.streamFor(url) : undefined);
      mgr = makeManager(fetchImpl);

      const reply = await startStreamingReply(mgr, fetchImpl);
      expect(children).toHaveLength(1);
      const firstChild = children[0];

      await mgr.setConfig({ speed: { speculative: false } });

      // The VALUE is saved immediately — waiting to apply it is not waiting to
      // save it, or a crash in between would lose the user's answer.
      expect(engineSection().speed).toEqual({ speculative: false, compressCache: true });
      expect(mgr.status().configApplyPending).toBe(true);
      expect(mgr.status().speed).toEqual({ speculative: false, compressCache: true });

      // Long enough for ~20 poll intervals to have passed.
      await settled();
      expect(firstChild.kill).not.toHaveBeenCalled();
      expect(mgr.status().configApplyPending).toBe(true);

      // The reply arrives whole — this is the thing the restart would have cut.
      await reply.finish();
      expect(reply.received()).toBe('the first half and the second.');

      await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });
      expect(firstChild.kill).toHaveBeenCalled();
      // It was RUNNING, so it comes back — the user's next message must not pay
      // for a boot they did not ask for.
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(mgr.status().state).toBe('running');
      expect(mgr.status().configApplyError).toBeNull();
    });

    it('applies anyway once the wait runs out — a stream that never ends cannot park a setting forever', async () => {
      plantInstall();
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
      let stream: ((url: string) => Response | undefined) | undefined;
      const fetchImpl: any = makeFetch((url) => stream?.(url));
      stream = (url) => (fetchImpl.streamFor ? fetchImpl.streamFor(url) : undefined);
      // 30 ms stands in for the shipped ten minutes (design §C2's bound).
      mgr = makeManager(fetchImpl, { configApplyMaxWaitMs: 30 });

      await startStreamingReply(mgr, fetchImpl);   // deliberately never finished
      const firstChild = children[0];

      await mgr.setConfig({ speed: { compressCache: false } });
      await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });
      expect(firstChild.kill).toHaveBeenCalled();
    });

    it('an engine that was NOT running is left stopped — a setting does not boot one', async () => {
      plantInstall();
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
      mgr = makeManager(makeFetch());

      await mgr.setConfig({ speed: { speculative: false } });
      await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(engineSection().speed).toEqual({ speculative: false, compressCache: true });
    });
  });

  describe('engine:set-config — a context change reloads, it does not restart', () => {
    it('rewrites the preset\'s [*] section and asks the router to re-read it, with no new process', async () => {
      plantInstall();
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
      const fetchImpl = makeFetch();
      mgr = makeManager(fetchImpl);

      const hook = mgr.registryHook();
      await hook.ensureRunning();
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const firstChild = children[0];
      urls.length = 0;

      await mgr.setConfig({ contextSize: 8_192 });
      await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });

      expect(engineSection().contextSize).toBe(8_192);
      // The whole file, not a substring: a `[*]` section that also carried a
      // leftover key, or a ctx-size written into the wrong section, would both
      // pass a "contains 8192" check while meaning something different.
      expect(fs.readFileSync(presetPath(), 'utf8')).toBe('[*]\nctx-size = 8192\nsleep-idle-seconds = 900\n');
      // Exactly the reload URL — `/models` without the query does NOT re-read the
      // preset, and that is the whole difference between the change landing and
      // the change being invisible until the next launch.
      expect(urls).toContain(`http://127.0.0.1:${PORT}/models?reload=1`);
      // NO restart: the process that was serving is the process still serving.
      expect(firstChild.kill).not.toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('writes a section for a model that has its own settings, and none for a model that does not', async () => {
      plantInstall();
      fs.writeFileSync(path.join(cacheDir, 'tuned-model.gguf'), 'x');
      fs.writeFileSync(path.join(cacheDir, 'untouched-model.gguf'), 'x');
      await home.mutateJson('config.json', () => ({
        v: 1,
        engine: {
          cacheDir,
          contextSize: 32_768,
          models: {
            'tuned-model': { contextLength: 16_384, keepLoaded: true, gpuLayers: 24, extraFlags: '' },
            // A model with settings but NOT on disk: a section for it would
            // resurrect a deleted model as a row that can never load (probed).
            'deleted-model': { contextLength: 4_096 },
          },
        },
      }));
      mgr = makeManager(makeFetch());

      await mgr.setConfig({ contextSize: 65_536 });
      await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });

      expect(fs.readFileSync(presetPath(), 'utf8')).toBe(
        '[*]\nctx-size = 65536\nsleep-idle-seconds = 900\n\n'
        + '[tuned-model]\nctx-size = 16384\nn-gpu-layers = 24\nsleep-idle-seconds = -1\n',
      );
    });

    it('refuses a context length below the engine\'s floor, in the words the card shows', async () => {
      plantInstall();
      mgr = makeManager(makeFetch());
      await expect(mgr.setConfig({ contextSize: 512 })).rejects.toThrow('Context length must be at least 1024 tokens.');
      expect(engineSection().contextSize).toBeUndefined();   // nothing was written
    });
  });

  describe('engine:set-context — the alias every existing caller still goes through', () => {
    it('does exactly what set-config({contextSize}) does', async () => {
      plantInstall();
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
      const fetchImpl = makeFetch();
      mgr = makeManager(fetchImpl);

      const hook = mgr.registryHook();
      await hook.ensureRunning();
      urls.length = 0;

      // The engine card, the remote browser shim and the WS handler all call this
      // one method with a bare number.
      await mgr.setContext(65_536);
      await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });

      expect(engineSection().contextSize).toBe(65_536);
      expect(mgr.status().contextSize).toBe(65_536);
      expect(fs.readFileSync(presetPath(), 'utf8')).toBe('[*]\nctx-size = 65536\nsleep-idle-seconds = 900\n');
      expect(urls).toContain(`http://127.0.0.1:${PORT}/models?reload=1`);
      expect(children[0].kill).not.toHaveBeenCalled();
    });

    it('keeps the same refusal it always had', async () => {
      plantInstall();
      mgr = makeManager(makeFetch());
      await expect(mgr.setContext(1_023)).rejects.toThrow('Context length must be at least 1024 tokens.');
    });
  });

  describe('engine:set-config — one action per wait, however many changes', () => {
    /** Boot, hold a reply open, and hand back the fixtures the probes need. */
    async function bootWithStream() {
      plantInstall();
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
      let stream: ((url: string) => Response | undefined) | undefined;
      const fetchImpl: any = makeFetch((url) => stream?.(url));
      stream = (url) => (fetchImpl.streamFor ? fetchImpl.streamFor(url) : undefined);
      mgr = makeManager(fetchImpl);
      const reply = await startStreamingReply(mgr, fetchImpl);
      return { fetchImpl, reply };
    }

    it('a switch toggled off and back on during one reply costs ONE restart, not two', async () => {
      const { reply } = await bootWithStream();
      expect(mockSpawn).toHaveBeenCalledTimes(1);   // the boot

      await mgr!.setConfig({ speed: { speculative: false } });
      await mgr!.setConfig({ speed: { speculative: true } });
      await settled();
      expect(mockSpawn).toHaveBeenCalledTimes(1);   // still nothing, the reply is streaming

      await reply.finish();
      await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });
      // …and then keep watching. `configApplyPending` false is not on its own
      // proof that the work is over: a SECOND waiter would clear the flag the
      // first one set, and its restart would land just after this assertion.
      await settled();

      // Two clicks, one teardown-and-respawn — every restart is a full model
      // reload the user waits through.
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(children[0].kill).toHaveBeenCalledTimes(1);
      expect(engineSection().speed).toEqual({ speculative: true, compressCache: true });
    });

    it('a context length and a switch in ONE patch cost one restart and NO reload', async () => {
      const { reply } = await bootWithStream();
      urls.length = 0;

      await mgr!.setConfig({ contextSize: 8_192, speed: { compressCache: false } });
      await reply.finish();
      await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });
      await settled();      // same reason as the probe above

      // The preset carries the new context length…
      expect(fs.readFileSync(presetPath(), 'utf8')).toBe('[*]\nctx-size = 8192\nsleep-idle-seconds = 900\n');
      // …and the fresh process reads it on the way up, so asking the router that
      // is about to be torn down to re-read it would be work for nothing.
      expect(urls.filter((u) => u.includes('reload=1'))).toEqual([]);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(engineSection()).toMatchObject({ contextSize: 8_192, speed: { compressCache: false, speculative: true } });
    });

    it('changes made while the wait is still running join it, so the bound is not paid twice', async () => {
      // With ONE waiter there is one deadline — the oldest pending change's. The
      // job-per-call version this replaced timed each job from its own start, so
      // the second change behind a stream that never ends waited 2x the bound.
      plantInstall();
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
      let stream: ((url: string) => Response | undefined) | undefined;
      const fetchImpl: any = makeFetch((url) => stream?.(url));
      stream = (url) => (fetchImpl.streamFor ? fetchImpl.streamFor(url) : undefined);
      // WHY 1 s and not 60 ms: the 20 ms pause below has to land INSIDE the first
      // change's wait for the second change to join it. Under a full parallel run
      // a 20 ms sleep can take longer than 60 ms, the first wait expires alone,
      // the second gets its own — three spawns, and this failed on Windows CI
      // (2026-09-16). The stream never finishes, so the test pays the whole
      // bound either way; 1 s buys a 50× margin for one second of runtime.
      mgr = makeManager(fetchImpl, { configApplyMaxWaitMs: 1_000 });
      await startStreamingReply(mgr, fetchImpl);    // never finished

      await mgr.setConfig({ speed: { speculative: false } });
      await new Promise((r) => setTimeout(r, 20));
      await mgr.setConfig({ contextSize: 8_192 });   // joins the SAME wait

      await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });
      await settled();
      // Both landed together, in the one pass the first change's deadline bought.
      // NOTE what this does and does not pin, measured rather than assumed: it
      // pins that a second change JOINS the wait. That is what makes a doubled
      // bound impossible — one waiter, one deadline — but it is not a direct test
      // of the deadline's assignment site, and it is not the test that fails if
      // per-call jobs come back (the toggle probe above is). Moving the deadline
      // into the waiter leaves every test in this file green while coalescing
      // holds, because with one pass the two placements are the same thing.
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(presetPath(), 'utf8')).toBe('[*]\nctx-size = 8192\nsleep-idle-seconds = 900\n');
    });
  });

  describe('engine:set-config — a refused reload is REPORTED (should-fix 1)', () => {
    it('surfaces the engine\'s own status, because nothing else would look wrong', async () => {
      plantInstall();
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
      const fetchImpl: any = makeFetch();
      mgr = makeManager(fetchImpl);
      await mgr.registryHook().ensureRunning();
      // What the router really does when it cannot apply a preset: 500, and it
      // goes on serving with the OLD settings (model-presets.ts's header).
      fetchImpl.reloadFails = { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) };

      await mgr.setConfig({ contextSize: 8_192 });
      await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });

      // The exact sentence, not a substring: the whole value of this message is
      // that it says what the engine said and what state the user is left in.
      expect(mgr.status().configApplyError).toBe(
        'The engine would not re-read its settings (HTTP 500 Internal Server Error). It is still running with the previous ones.',
      );
    });

    it('a reload that a network error kills reports THAT, not a guess', async () => {
      plantInstall();
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
      const fetchImpl: any = makeFetch();
      mgr = makeManager(fetchImpl);
      await mgr.registryHook().ensureRunning();
      const boom = new Error('connect ECONNREFUSED 127.0.0.1:9999');
      fetchImpl.reloadFails = undefined;
      const inner = fetchImpl.getMockImplementation();
      fetchImpl.mockImplementation(async (input: any, init?: any) => {
        if (String(input).includes('reload=1')) throw boom;
        return inner(input, init);
      });

      await mgr.setConfig({ contextSize: 8_192 });
      await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });
      expect(mgr.status().configApplyError).toBe('connect ECONNREFUSED 127.0.0.1:9999');
    });

    it('a change made after a failure clears the old message', async () => {
      plantInstall();
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
      const fetchImpl: any = makeFetch();
      mgr = makeManager(fetchImpl);
      await mgr.registryHook().ensureRunning();
      fetchImpl.reloadFails = { ok: false, status: 503, statusText: '', json: async () => ({}) };

      await mgr.setConfig({ contextSize: 8_192 });
      await vi.waitFor(() => { expect(mgr!.status().configApplyError).toBe(
        'The engine would not re-read its settings (HTTP 503). It is still running with the previous ones.') });

      fetchImpl.reloadFails = undefined;
      await mgr.setConfig({ contextSize: 16_384 });
      await vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });
      expect(mgr.status().configApplyError).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // §C3 — which /props answers the question
  // ---------------------------------------------------------------------------
  describe('effectiveContextWindow asks the MODEL, not the router', () => {
    /** /props answers `body` only when asked about a named model; the bare /props
     *  answers what the router really answers — a dummy with n_ctx 0. */
    //  `loadedId` matters: the manager only NAMES a model in /props when GET /models
    //  already reports it `loaded`, because on this build naming an unloaded model
    //  autoloads it — a status read that pulls gigabytes into memory and, at
    //  --models-max 2, can evict the model a live conversation is using. A stub that
    //  reports nothing loaded therefore exercises the model-LESS path, which is what
    //  the fallback cases below want and what the named cases must opt out of.
    function fetchProps(body: unknown, loadedId?: string) {
      urls = [];
      return vi.fn(async (input: any) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ status: 'ok' }) } as any;
        if (url.includes('/props')) {
          const named = url.includes('?model=');
          return { ok: true, status: 200, json: async () => (named ? body : { model_path: 'none', n_ctx: 0 }) } as any;
        }
        // The router reports residency in `status` (a string on b10665, an object on
        //  b9992) — NOT `state`, which is the manager's own mapped field. A stub using
        //  `state` reports nothing loaded and silently exercises the model-less path.
        const data = loadedId ? [{ id: loadedId, status: 'loaded' }] : [];
        return { ok: true, status: 200, json: async () => ({ data }) } as any;
      });
    }

    it('names the model in the query, url-encoded', async () => {
      plantInstall();
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768 } }));
      mgr = makeManager(fetchProps({ default_generation_settings: { n_ctx: 16_384 }, n_slots: 4 }, 'gemma 4/E2B-it-Q8_0'));

      const result = await mgr.effectiveContextWindow('gemma 4/E2B-it-Q8_0');
      // The exact URL: a bare /props answers `n_ctx: 0` even with a model loaded
      // (probed 2026-09-05), so the query string is the whole point — and a model
      // id is a filename, which can hold characters a URL cannot.
      expect(urls).toContain(`http://127.0.0.1:${PORT}/props?model=gemma%204%2FE2B-it-Q8_0`);
      expect(result.contextLength).toBe(16_384);
      expect(result.totalSlots).toBe(4);
    });

    it('an unloaded model falls back to ITS OWN configured length, not the engine-wide one', async () => {
      plantInstall();
      await home.mutateJson('config.json', () => ({
        v: 1,
        engine: { cacheDir, contextSize: 32_768, models: { 'big-context-model': { contextLength: 131_072 } } },
      }));
      // No child for an unloaded model, so even the named /props answers the
      // router's dummy zero.
      mgr = makeManager(fetchProps({ model_path: 'none', n_ctx: 0 }));

      // 131072, NOT 32768: sizing a model the user set to 128k as if it were on
      // the engine's default is the under-count that empties the window.
      expect((await mgr.effectiveContextWindow('big-context-model')).contextLength).toBe(131_072);
    });

    it('a model with no setting of its own still falls back to the engine-wide length', async () => {
      plantInstall();
      await home.mutateJson('config.json', () => ({
        v: 1,
        engine: { cacheDir, contextSize: 64_000, models: { 'some-other-model': { contextLength: 131_072 } } },
      }));
      mgr = makeManager(fetchProps({ model_path: 'none', n_ctx: 0 }));

      expect((await mgr.effectiveContextWindow('plain-model')).contextLength).toBe(64_000);
    });

    it('a live reading from the model still wins over what was configured', async () => {
      plantInstall();
      await home.mutateJson('config.json', () => ({
        v: 1,
        engine: { cacheDir, contextSize: 32_768, models: { 'clamped-model': { contextLength: 131_072 } } },
      }));
      // The server clamped the request down to what the VRAM allowed: believe it.
      mgr = makeManager(fetchProps({ default_generation_settings: { n_ctx: 8_192 } }, 'clamped-model'));

      expect((await mgr.effectiveContextWindow('clamped-model')).contextLength).toBe(8_192);
    });
  });
});

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
describe('the vision catalog', () => {
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

  describe('EngineManager.catalogModels — supportsVision from the router', () => {
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

    // Roadmap (local-models, 2026-09-05): a vision model downloaded while the
    // app runs was told to the assistant as text-only when the session started
    // before the router re-scanned. The files on disk now answer too.
    function plantVisionFolder(id: string, { projector = 'mmproj-F16.gguf' } = {}) {
      const dir = path.join(cacheDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.gguf`), Buffer.alloc(8));
      if (projector) fs.writeFileSync(path.join(dir, projector), Buffer.alloc(4));
    }

    it('a just-downloaded vision folder the router has not re-scanned yet reads supportsVision TRUE', async () => {
      plantVisionFolder('gemma-3-4b-it-Q4_K_M');
      // The router still lists only the OLD model — the post-boot download
      // arrives through listModels' disk union, with no modalities.
      mgr = await runningManager({ object: 'list', data: [{ id: 'older-Q4_K_M', status: { value: 'unloaded' } }] });
      const byId = Object.fromEntries((await mgr.catalogModels()).map((r) => [r.id, r]));
      expect(byId['gemma-3-4b-it-Q4_K_M'].supportsVision).toBe(true);
      expect(byId['older-Q4_K_M'].supportsVision).toBeUndefined();
    });

    it('an explicit router "text only" answer is honoured even with a projector on disk', async () => {
      plantVisionFolder('gemma-3-4b-it-Q4_K_M');
      mgr = await runningManager({ object: 'list', data: [{
        id: 'gemma-3-4b-it-Q4_K_M', status: { value: 'unloaded' }, architecture: { input_modalities: ['text'] },
      }] });
      const [row] = await mgr.catalogModels();
      expect(row.supportsVision).toBe(false);
    });

    it('the engine-OFF path sees the projector too', async () => {
      plantInstall();
      plantVisionFolder('gemma-3-4b-it-Q4_K_M');
      mgr = new EngineManager(home, userData, 9999);
      const [row] = await mgr.catalogModels();
      expect(row.supportsVision).toBe(true);
    });

    it('a projector still downloading is not a yes', async () => {
      plantInstall();
      plantVisionFolder('gemma-3-4b-it-Q4_K_M', { projector: 'mmproj-F16.gguf.partial' });
      mgr = new EngineManager(home, userData, 9999);
      const rows = await mgr.catalogModels();
      for (const r of rows) expect(r.supportsVision).not.toBe(true);
    });
  });
});
