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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { EngineManager } from '../src/main/engine/engine-manager';
import { ENGINE_VERSION } from '../src/main/engine/engine-pin';

// Same fake-spawn harness as engine-set-config.test.ts: ensureRunning() spawns a
// real subprocess unless child_process.spawn is replaced.
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
  // WHY the retries (2026-09-07): this threw ENOTEMPTY on the ubuntu CI leg with
  // 9,743 tests already passed — an engine write landing mid-removal fails a run
  // that had nothing wrong with it. Same shape as engine-acquisition.test.ts:154,
  // and what `.claude/rules/test-suite-hygiene.md` prescribes for a real temp root.
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
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

describe('models:set-settings — the save writes config, and NOTHING else (§C2)', () => {
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

describe('the apply waits on the PER-MODEL count, not the engine-wide one (§C2)', () => {
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

describe('a deferred ENGINE-WIDE change cannot ride out on somebody else\'s reload (§B/§C2)', () => {
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

describe('each model\'s bound is its OWN, and a fallback boot applies nothing (§C2)', () => {
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
});

describe('refreshModels() merges pending changes only for IDLE models (§C2)', () => {
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

describe('keep loaded, and deleting a model (§C2, R2-6)', () => {
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

describe('lastLoadError has TWO sources, and both reach the model (§C2)', () => {
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

describe('a fresh engine reads every saved change on its way up (§C2)', () => {
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
