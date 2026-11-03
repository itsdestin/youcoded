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
import { REAL_MODELS_RESPONSE } from './helpers/engine-models-response';

// Same fake-spawn harness engine-supervisor.test.ts uses — EngineManager's
// ensureRunning() (reached from effectiveContextWindow, set-config, catalog)
// spawns a real llama-server unless child_process.spawn is replaced.
const mockSpawn = vi.fn();
vi.mock('child_process', async (orig) => ({
  ...(await orig() as any),
  spawn: (...args: any[]) => mockSpawn(...args),
}));

// Shared fake-llama-server fixtures for every section below (each section used to carry its own copy).
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
let mgr: EngineManager = undefined as never; // assigned by each test; reset after

beforeEach(() => {
  mockSpawn.mockReset();
  children.length = 0;
  mockSpawn.mockImplementation(() => makeFakeChild());
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-mgr-router-'));
  userData = path.join(root, 'userData');
  cacheDir = path.join(root, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  home = new NativeHome(root);
});
afterEach(async () => {
  await mgr?.stopAll();
  // No retries on purpose: stopAll() abandons every pending apply, so nothing writes here after it. If ENOTEMPTY
  // ever returns, the cancellation regressed — fix that, do not add retries.
  fs.rmSync(root, { recursive: true, force: true });
  mgr = undefined as never;
});

/** A usable install, so the manager doesn't bail out on "not installed" before reaching the router. */
function plantInstall(backend = 'cpu') {
  const dir = path.join(userData, 'engine', `${ENGINE_VERSION}-${backend}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'fake');
  fs.writeFileSync(path.join(dir, '.complete'),
    JSON.stringify({ version: ENGINE_VERSION, backend, binaryRelPath: 'llama-server.exe' }));
}

/** Boot the engine and start a tracked streaming chat request that stays open until finish(). `modelId` is named in the
 *  body (where trackedFetch reads the model); null sends no body at all. Returns what the caller actually received, so a
 *  test proves the reply survived rather than that nothing crashed. */
async function startStreamingReply(m: EngineManager, fetchImpl: any, modelId: string | null = null) {
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
  const res = await hook.fetchImpl()(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
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

// WHY this section exists: DiscoveredModel.totalSlots (capability-profile.ts's local concurrency cap) was once written by NO
// production code, so every local session fell back to ONE helper. The slot count rides the SAME /props response as the
// context window, and ONLY when the request names a model (`total_slots`, not `n_slots`; a bare /props answers a dummy
// n_ctx 0 with no slot field). Naming a model autoloads it, so effectiveContextWindow checks GET /models first and
// names the model only when it is already `loaded`.
describe('the slot count', () => {
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
    const BODY = { default_generation_settings: { n_ctx: 16_384 }, total_slots: 4 };
    /** Boot against a router whose /models lists `models` and whose named /props answers `body`. */
    async function ask(id: string, body: unknown, models: unknown[], contextSize = 16_384) {
      const urls: string[] = [];
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize } }));
      plantInstall();
      mgr = plantedManager(fetchWithProps(body, { models, urls }), cacheDir);
      return { result: await mgr.effectiveContextWindow(id), urls };
    }

    // The app's real spawn shape has no --parallel, so b10665 keeps a unified KV cache: n_ctx is the FULL -c and the four
    // slots share it. With an explicit --parallel 4 the engine reports -c/4 per slot; that number is passed through, not
    // second-guessed. ONE named /props read yields both fields (no second round trip).
    it.each([
      ['the full -c under the real spawn shape', 16_384],
      ['whatever the engine reports under --parallel 4 (-c/4)', 4096],
    ])('a LOADED model: asks /props?model=<id> once; n_ctx is %s, 4 slots', async (_n, nCtx) => {
      const { result, urls } = await ask('Qwen3.5-2B-Q8_0', { default_generation_settings: { n_ctx: nCtx }, total_slots: 4 },
        [routerRow('Qwen3.5-2B-Q8_0', 'loaded')]);
      expect(result).toEqual({ contextLength: nCtx, totalSlots: 4 });
      expect(propsUrls(urls)).toEqual([namedProps('Qwen3.5-2B-Q8_0')]);
    });

    // Naming a model in /props AUTOLOADS it on b10665 (gigabytes into memory, and at --models-max 2 it can evict the
    // model a live conversation uses). So only a `loaded` model is named; unloaded, SLEEPING (naming would wake it) and
    // never-listed models take the model-less /props: the configured -c, unknown slots. The numbers prove the path too:
    // had the model been named, the stub would have answered the loaded body.
    it.each([
      ['an UNLOADED model', [routerRow('Qwen3.5-2B-Q8_0', 'unloaded')], 'Qwen3.5-2B-Q8_0'],
      ['a SLEEPING model', [routerRow('Qwen3.5-2B-Q8_0', 'sleeping')], 'Qwen3.5-2B-Q8_0'],
      ['a model the router never listed', [routerRow('some-other-model', 'loaded')], 'never-scanned'],
    ])('%s: the model-param URL is NEVER fetched, the model-less /props is', async (_n, models, id) => {
      const { result, urls } = await ask(id, BODY, models, 128_000);
      expect(result).toEqual({ contextLength: 128_000, totalSlots: null });
      expect(propsUrls(urls)).toEqual([BARE_PROPS]);
      expect(urls).not.toContain(namedProps(id));
    });

    it('never polls with ?reload=1 on either path (the engine rule forbids it — it forces a disk rescan)', async () => {
      const { urls } = await ask('a', BODY, [routerRow('a', 'loaded'), routerRow('b', 'unloaded')]);
      await mgr!.effectiveContextWindow('b');
      expect(urls.filter((u) => new URL(u).searchParams.has('reload'))).toEqual([]);
    });

    it('URL-encodes the model id in the query (router ids can carry characters a query string cannot)', async () => {
      const { urls } = await ask('odd model&id', BODY, [routerRow('odd model&id', 'loaded')]);
      expect(propsUrls(urls)).toEqual([namedProps('odd model&id')]);
    });

    // Slot field: `total_slots` (n_slots on older builds, total_slots wins when both); absent, 0, or a non-number is
    // unknown (null), never a guess — mirroring n_ctx's own 0-means-unknown handling.
    it.each([
      ['an OLDER build answering n_slots', { default_generation_settings: { n_ctx: 32_768 }, n_slots: 2 }, 32_768, 2, 32_768],
      ['total_slots winning over a stray n_slots', { default_generation_settings: { n_ctx: 16_384 }, total_slots: 4, n_slots: 1 }, 16_384, 4, 16_384],
      ['no slot field at all', { default_generation_settings: { n_ctx: 64_000 } }, 64_000, null, 64_000],
      ['a literal total_slots: 0', { model_path: 'none', n_ctx: 0, total_slots: 0 }, 128_000, null, 128_000],
    ])('slot count from %s', async (_n, body, contextSize, slots, ctx) => {
      const { result } = await ask('some-model', body, [routerRow('some-model', 'loaded')], contextSize);
      expect(result.totalSlots).toBe(slots);
      expect(result.contextLength).toBe(ctx);
    });

    // An unloaded/unlisted model is sized by ITS OWN configured length, else the engine-wide one (sizing a model the user
    // set to 128k as if on the default is the under-count that empties the window); a live reading wins over both (the
    // server clamped the request to what the VRAM allowed). The router reports residency in `status` — a string on some
    // builds, an object on others — so the live row uses the string form.
    it.each([
      ['an unloaded model uses its own configured length', 'big-context-model', 32_768, { 'big-context-model': { contextLength: 131_072 } }, [], 131_072],
      ['a model with no setting of its own uses the engine-wide length', 'plain-model', 64_000, { 'some-other-model': { contextLength: 131_072 } }, [], 64_000],
      ['a live reading from the model wins over what was configured', 'clamped-model', 32_768, { 'clamped-model': { contextLength: 131_072 } },
        [{ id: 'clamped-model', status: 'loaded' }], 8_192],
    ])('%s', async (_n, id, contextSize, models, rows, expected) => {
      await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize, models } }));
      plantInstall();
      mgr = plantedManager(fetchWithProps({ default_generation_settings: { n_ctx: 8_192 } }, { models: rows }), cacheDir);
      expect((await mgr.effectiveContextWindow(id)).contextLength).toBe(expected);
    });

    it('no engine installed yet: both fields are the conservative "unknown" default', async () => {
      mgr = new EngineManager(home, userData, 9999);
      const result = await mgr.effectiveContextWindow('some-model');
      expect(result.contextLength).toBe(32_768);
      expect(result.totalSlots).toBeNull();
    });
  });
});

// Per-model engine settings: saving them, and landing them without disturbing a reply (contract R26).
// models.ini is ONE file shared by every local model and `GET /models?reload=1` unloads every model whose section changed,
// so writing settings at save time (or applying them on somebody else's reload) drops a model mid-answer. "This model is
// quiet" is read from the per-model count trackedFetch keeps (the engine-wide inFlight and the session ref-count are the
// wrong question).
describe('per-model settings', () => {
  beforeEach(() => {
    // Two models on disk: the question here is "does an apply wait for THIS model, or for the engine?"
    fs.writeFileSync(path.join(cacheDir, 'alpha.gguf'), 'x');
    fs.writeFileSync(path.join(cacheDir, 'beta.gguf'), 'x');
  });

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

  /** Plant an install + config (optionally with per-model entries) and build the manager; returns the fetch stub. */
  async function bootPM(models: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    plantInstall();
    await plantConfig(models);
    const fetchImpl = makeFetch();
    mgr = makeManager(fetchImpl, extra);
    return fetchImpl;
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
      await bootPM();

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
      await bootPM();

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
      await bootPM();

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
      await bootPM();

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
      const fetchImpl = await bootPM({}, { configApplyMaxWaitMs: BOUND_MS });
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
      await bootPM();
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
      // A short bound, so an abandoned waiter's deadline passes INSIDE this test
      // and would land its write if stopAll had not cancelled it.
      const fetchImpl = await bootPM({}, { configApplyMaxWaitMs: 150 });
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
      // settle (negative assertion): past the deadline nothing may write, reload or spawn.
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
      // The waiter is asleep for the whole test, so what lands is what
      // refreshModels() itself merged — not a poll tick that raced it.
      const fetchImpl = await bootPM({}, { configApplyPollMs: 60_000, configApplyMaxWaitMs: 60_000 });

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
      // The waiter sleeps for the whole test, so the queued change is still queued
      // when the delete arrives — which is the state this probe is about.
      const fetchImpl = await bootPM({}, { configApplyPollMs: 60_000, configApplyMaxWaitMs: 60_000 });

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
  /** Every URL the manager or the supervisor fetched, in order. */
  let urls: string[];

  /** /health answers ok; everything else an empty JSON body. `streamFor` (set by startStreamingReply) can hand back its own
   *  Response for one URL; `reloadFails` makes the reload fail the way the engine really does (500, still serving OLD presets). */
  function makeFetch() {
    urls = [];
    const f: any = vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      urls.push(url);
      const own = f.streamFor?.(url, init);
      if (own) return own as any;
      if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ status: 'ok' }) } as any;
      if (url.includes('reload=1') && f.reloadFails) return f.reloadFails as any;
      return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
    });
    return f;
  }

  function makeManager(fetchImpl: any, extra: Record<string, unknown> = {}) {
    return new EngineManager(home, userData, PORT, {
      fetchImpl,
      probeChip: async () => ({ vendor: null, gfxTarget: null }), // the real one shells out to nvidia-smi / ldconfig
      supervisorOpts: { pidOnPort: () => 4242, readyDeadlineMs: 2_000, readyPollMs: 5 },
      configApplyPollMs: 2,
      configApplyMaxWaitMs: 5_000, // a suite cannot spend the real ten minutes proving the bound exists
      ...extra,
    });
  }

  /** Plant an install and the config, then build the manager. */
  async function boot(extra: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
    plantInstall();
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 32_768, ...config } }));
    const fetchImpl = makeFetch();
    mgr = makeManager(fetchImpl, extra);
    return fetchImpl;
  }
  const bootRunning = async () => { const f = await boot(); await mgr!.registryHook().ensureRunning(); return f; };
  const bootWithStream = async (extra: Record<string, unknown> = {}) => {
    const f = await boot(extra);
    return { fetchImpl: f, reply: await startStreamingReply(mgr!, f) };
  };
  const applied = () => vi.waitFor(() => { expect(mgr!.status().configApplyPending).toBe(false); });

  // Spelled out rather than imported from model-presets: reusing the function under test to say where to look would
  // make the assertion vacuous.
  const presetPath = () => path.join(root, '.youcoded', 'engine', 'models.ini');
  const readPreset = () => fs.readFileSync(presetPath(), 'utf8');
  const engineSection = () => ((home.readJson('config.json') as any)?.engine ?? {});
  const settled = () => new Promise((r) => setTimeout(r, 40));
  const preset = (ctx: number) => `[*]\nctx-size = ${ctx}\nsleep-idle-seconds = 900\n`;
  const RELOAD = `http://127.0.0.1:${PORT}/models?reload=1`; // `/models` without the query does NOT re-read the preset

  describe('engine:set-config — a speed switch waits for the reply to finish', () => {
    it('does not kill a streaming reply, and restarts the moment it ends', async () => {
      const { reply } = await bootWithStream();
      expect(children).toHaveLength(1);
      const firstChild = children[0];

      await mgr!.setConfig({ speed: { speculative: false } });
      // The VALUE is saved immediately — waiting to apply it is not waiting to save it, or a crash would lose the answer.
      expect(engineSection().speed).toEqual({ speculative: false, compressCache: true });
      expect(mgr!.status().configApplyPending).toBe(true);
      expect(mgr!.status().speed).toEqual({ speculative: false, compressCache: true });

      await settled();
      expect(firstChild.kill).not.toHaveBeenCalled();
      expect(mgr!.status().configApplyPending).toBe(true);

      await reply.finish();
      expect(reply.received()).toBe('the first half and the second.'); // the thing the restart would have cut

      await applied();
      expect(firstChild.kill).toHaveBeenCalled();
      // It was RUNNING, so it comes back: the user's next message must not pay for a boot they did not ask for.
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(mgr!.status().state).toBe('running');
      expect(mgr!.status().configApplyError).toBeNull();
    });

    it('applies anyway once the wait runs out — a stream that never ends cannot park a setting forever', async () => {
      await bootWithStream({ configApplyMaxWaitMs: 30 }); // 30 ms stands in for the shipped ten minutes; never finished
      const firstChild = children[0];
      await mgr!.setConfig({ speed: { compressCache: false } });
      await applied();
      expect(firstChild.kill).toHaveBeenCalled();
    });

    it('an engine that was NOT running is left stopped — a setting does not boot one', async () => {
      await boot();
      await mgr!.setConfig({ speed: { speculative: false } });
      await applied();
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(engineSection().speed).toEqual({ speculative: false, compressCache: true });
    });
  });

  describe('engine:set-config — a context change reloads, it does not restart', () => {
    it("rewrites the preset's [*] section and asks the router to re-read it, with no new process", async () => {
      await bootRunning();
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const firstChild = children[0];
      urls.length = 0;

      await mgr!.setConfig({ contextSize: 8_192 });
      await applied();

      expect(engineSection().contextSize).toBe(8_192);
      expect(readPreset()).toBe(preset(8_192)); // the whole file: a leftover key or the wrong section would pass "contains 8192"
      expect(urls).toContain(RELOAD);
      expect(firstChild.kill).not.toHaveBeenCalled(); // NO restart: the serving process is still serving
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('writes a section for a model that has its own settings, and none for a model that does not', async () => {
      fs.writeFileSync(path.join(cacheDir, 'tuned-model.gguf'), 'x');
      fs.writeFileSync(path.join(cacheDir, 'untouched-model.gguf'), 'x');
      await boot({}, { models: {
        'tuned-model': { contextLength: 16_384, keepLoaded: true, gpuLayers: 24, extraFlags: '' },
        // settings but NOT on disk: a section would resurrect a deleted model as a row that can never load
        'deleted-model': { contextLength: 4_096 },
      } });
      await mgr!.setConfig({ contextSize: 65_536 });
      await applied();
      expect(readPreset()).toBe(`${preset(65_536)}\n[tuned-model]\nctx-size = 16384\nn-gpu-layers = 24\nsleep-idle-seconds = -1\n`);
    });

    it("refuses a context length below the engine's floor, in the words the card shows", async () => {
      plantInstall();
      mgr = makeManager(makeFetch());
      await expect(mgr.setConfig({ contextSize: 512 })).rejects.toThrow('Context length must be at least 1024 tokens.');
      expect(engineSection().contextSize).toBeUndefined(); // nothing was written
    });
  });

  describe('engine:set-context — the alias every existing caller still goes through', () => {
    it('does exactly what set-config({contextSize}) does', async () => {
      await bootRunning();
      urls.length = 0;
      await mgr!.setContext(65_536); // the card, the remote shim and the WS handler all call this with a bare number
      await applied();
      expect(engineSection().contextSize).toBe(65_536);
      expect(mgr!.status().contextSize).toBe(65_536);
      expect(readPreset()).toBe(preset(65_536));
      expect(urls).toContain(RELOAD);
      expect(children[0].kill).not.toHaveBeenCalled();
    });

    it('keeps the same refusal it always had', async () => {
      plantInstall();
      mgr = makeManager(makeFetch());
      await expect(mgr.setContext(1_023)).rejects.toThrow('Context length must be at least 1024 tokens.');
    });
  });

  describe('engine:set-config — one action per wait, however many changes', () => {
    it('a switch toggled off and back on during one reply costs ONE restart, not two', async () => {
      const { reply } = await bootWithStream();
      expect(mockSpawn).toHaveBeenCalledTimes(1); // the boot

      await mgr!.setConfig({ speed: { speculative: false } });
      await mgr!.setConfig({ speed: { speculative: true } });
      await settled();
      expect(mockSpawn).toHaveBeenCalledTimes(1); // still nothing, the reply is streaming

      await reply.finish();
      await applied();
      await settled(); // a SECOND waiter would clear the flag the first set and its restart would land just after
      expect(mockSpawn).toHaveBeenCalledTimes(2); // two clicks, one teardown-and-respawn
      expect(children[0].kill).toHaveBeenCalledTimes(1);
      expect(engineSection().speed).toEqual({ speculative: true, compressCache: true });
    });

    it('a context length and a switch in ONE patch cost one restart and NO reload', async () => {
      const { reply } = await bootWithStream();
      urls.length = 0;
      await mgr!.setConfig({ contextSize: 8_192, speed: { compressCache: false } });
      await reply.finish();
      await applied();
      await settled();
      expect(readPreset()).toBe(preset(8_192));
      // the fresh process reads the preset on the way up, so asking the doomed router to re-read it is work for nothing
      expect(urls.filter((u) => u.includes('reload=1'))).toEqual([]);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(engineSection()).toMatchObject({ contextSize: 8_192, speed: { compressCache: false, speculative: true } });
    });

    // One waiter, one deadline (the oldest change's). The per-call-job version timed each from its own start, so the
    // second change behind a never-ending stream waited 2x the bound. Pins that a second change JOINS the wait.
    it('changes made while the wait is still running join it, so the bound is not paid twice', async () => {
      // WHY 1 s, not 60 ms: the 20 ms pause must land INSIDE the first change's wait; under load a 20 ms sleep can take
      // longer than 60 ms, the first wait expires alone and the second gets its own (three spawns; failed on Windows CI).
      await bootWithStream({ configApplyMaxWaitMs: 1_000 }); // never finished
      await mgr!.setConfig({ speed: { speculative: false } });
      await new Promise((r) => setTimeout(r, 20));
      await mgr!.setConfig({ contextSize: 8_192 }); // joins the SAME wait
      await applied();
      await settled();
      expect(mockSpawn).toHaveBeenCalledTimes(2); // both landed together, in the one pass
      expect(readPreset()).toBe(preset(8_192));
    });
  });

  describe('engine:set-config — a refused reload is REPORTED', () => {
    it("surfaces the engine's own status, because nothing else would look wrong", async () => {
      const fetchImpl = await bootRunning();
      // what the router does when it cannot apply a preset: 500, and it goes on serving the OLD settings
      fetchImpl.reloadFails = { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) };
      await mgr!.setConfig({ contextSize: 8_192 });
      await applied();
      expect(mgr!.status().configApplyError).toBe(
        'The engine would not re-read its settings (HTTP 500 Internal Server Error). It is still running with the previous ones.');
    });

    it('a reload that a network error kills reports THAT, not a guess', async () => {
      const fetchImpl = await bootRunning();
      const inner = fetchImpl.getMockImplementation();
      fetchImpl.mockImplementation(async (input: any, init?: any) => {
        if (String(input).includes('reload=1')) throw new Error('connect ECONNREFUSED 127.0.0.1:9999');
        return inner(input, init);
      });
      await mgr!.setConfig({ contextSize: 8_192 });
      await applied();
      expect(mgr!.status().configApplyError).toBe('connect ECONNREFUSED 127.0.0.1:9999');
    });

    it('a change made after a failure clears the old message', async () => {
      const fetchImpl = await bootRunning();
      fetchImpl.reloadFails = { ok: false, status: 503, statusText: '', json: async () => ({}) };
      await mgr!.setConfig({ contextSize: 8_192 });
      await vi.waitFor(() => { expect(mgr!.status().configApplyError).toBe(
        'The engine would not re-read its settings (HTTP 503). It is still running with the previous ones.'); });
      fetchImpl.reloadFails = undefined;
      await mgr!.setConfig({ contextSize: 16_384 });
      await applied();
      expect(mgr!.status().configApplyError).toBeNull();
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
  // A REAL `GET /models` response, captured 2026-09-05 from the PINNED binary
  // (b10665) spawned with --models-dir over a directory holding SmolVLM-256M
  // twice: once in a folder beside its mmproj-*.gguf (the vision layout design
  // §E2 downloads into), once as a lone flat .gguf. Verbatim except for the
  // absolute cache path inside status.args/status.preset, shortened for
  // readability — nothing this code reads. The live check is
  // test-engine/probe-vision.mjs; the schema is pinned in
  // docs/engine-dependencies.md.

  beforeEach(async () => {
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 8192 } }));
  });

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
