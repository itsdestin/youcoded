// `engine:set-config` — the one write for every engine-wide setting, and the
// wait that keeps it from killing a reply (design §B / §C2 / §C3).
//
// THE FAILURE THESE GUARD AGAINST: `EngineSupervisor.stop()` has no in-flight
// guard of its own — the only `inFlight > 0` check in the whole class is inside
// the idle timer — so restarting the engine the instant a switch is flipped
// SIGTERMs llama-server mid-answer and the streaming reply the user is reading
// dies halfway through a sentence. The signed contract (R19) promises the
// opposite: "a model in use reloads on its next message".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { EngineManager } from '../src/main/engine/engine-manager';
import { ENGINE_VERSION } from '../src/main/engine/engine-pin';

// Same fake-spawn harness as engine-manager-slot-count.test.ts: ensureRunning()
// spawns a real subprocess unless child_process.spawn is replaced.
const mockSpawn = vi.fn();
vi.mock('child_process', async (orig) => ({
  ...(await orig() as any),
  spawn: (...args: any[]) => mockSpawn(...args),
}));

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

describe('engine:set-config — a speed switch waits for the reply to finish (§B, R3-5)', () => {
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

describe('engine:set-config — a context change reloads, it does not restart (§B, R2-24)', () => {
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

describe('engine:set-config — one action per wait, however many changes (R3-5 follow-up)', () => {
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
    mgr = makeManager(fetchImpl, { configApplyMaxWaitMs: 60 });
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
describe('effectiveContextWindow asks the MODEL, not the router (§C3)', () => {
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
