// Task 13 fix pass — the review found that DiscoveredModel.totalSlots (the
// field capability-profile.ts's local concurrency cap reads) was written by
// NO production code: native-session-host.ts's resolveContextAndProfile never
// threaded a live engine reading through it, so every local session silently
// fell back to the conservative floor of 1 concurrent specialist — a
// regression from the pre-Task-13 flat cap of 4.
//
// This file proves the piece that closes that gap: EngineManager actually
// reads llama-server's slot count off the SAME /props response that already
// supplies the context window (no second HTTP round trip), with the same
// defensive "absent/zero/non-numeric = unknown" posture n_ctx already gets
// (see engine-context-router-fallback.test.ts for the identical n_ctx bug —
// this mirrors that fix rather than reinventing the parsing strategy).
//
// 2026-09-04 correction (measured live against the pinned b10665 in router
// mode): the field is `total_slots`, NOT `n_slots`, and it only appears when
// the request names a model — `GET /props` with no `?model=` answers
// `{model_path:"none", default_generation_settings.n_ctx: 0}` and NO slot
// field at all, while `GET /props?model=<id>` answers `total_slots: 4` plus
// the n_ctx the engine holds for THAT model. What that n_ctx is depends on the
// spawn shape: under the app's real args (no `--parallel`) b10665 turns on a
// unified KV cache and reports the FULL `-c` (all slots share one pool); only
// with an explicit `--parallel N` does it become `-c` / N. The earlier version
// of this file pinned the wrong field name and the model-less URL, which is
// exactly why the bug shipped with every test green: totalSlots was ALWAYS
// null in production, so every local model was capped at ONE helper while
// the engine had four slots.
//
// 2026-09-04 review fix (F1): naming a model in `/props?model=` is NOT a
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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { EngineManager, resolveSlotCount } from '../src/main/engine/engine-manager';
import { ENGINE_VERSION } from '../src/main/engine/engine-pin';

// Same fake-spawn harness engine-supervisor.test.ts uses — EngineManager's
// effectiveContextWindow() calls supervisor.ensureRunning(), which spawns a
// real subprocess unless child_process.spawn is replaced.
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
