import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import {
  EngineManager, selectInstallAsset, backendDeviceRefusal, isDeviceClassLoadError,
  smallestCompleteModel, routerErrorText,
} from '../src/main/engine/engine-manager';
import { ENGINE_VERSION } from '../src/main/engine/engine-pin';
import { updateEngineConfig, readEngineConfig } from '../src/main/engine/engine-config';

// The ROCm prerequisite reading decides whether a faster-engine row is 'ready'
// or 'needs-prereqs', and the real one asks THIS machine — so whether the
// row-state gate below is exercised at all would otherwise depend on whether
// the developer happens to have AMD's libraries installed. Both states have to
// be drivable for that gate to be under test.
const prereqState = vi.hoisted(() => ({ satisfied: true }));
vi.mock('../src/main/engine/rocm-prereqs', () => ({
  checkRocmPrereqs: () => ({
    backend: 'rocm', satisfied: prereqState.satisfied, distro: 'Arch Linux',
    command: prereqState.satisfied ? null : 'sudo pacman -S --needed rocm-hip-runtime hipblas rocblas',
    docsUrl: 'https://rocm.docs.amd.com/', explainer: 'AMD\'s software for its graphics chips.',
  }),
}));

// §E3's manifest backfill starts a Hugging Face lookup for every COMPLETE model
// on disk that has no manifest — and this file plants a dozen of them. Its real
// lookups fetch raw.githubusercontent.com and huggingface.co, which would make
// this suite depend on the network and take 45s per model when offline. Only
// the DEFAULT lookups are replaced: the real ManifestBackfill still runs, so
// the wiring under test here is the shipping one. Its own behaviour is pinned
// in tests/manifest-backfill.test.ts, which injects lookups instead.
vi.mock('../src/main/models/manifest-backfill', async (importActual) => ({
  ...(await importActual<typeof import('../src/main/models/manifest-backfill')>()),
  defaultBackfillLookups: () => ({
    curated: async () => [],
    search: async () => { throw new Error('the engine-manager suite must not reach the network'); },
    quantOptions: async () => { throw new Error('the engine-manager suite must not reach the network'); },
    now: () => 0,
  }),
}));

let root: string;
let userData: string;
let home: NativeHome;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-mgr-'));
  userData = path.join(root, 'userData');
  home = new NativeHome(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Plant a fake usable install so status()/hook tests need no download. */
function plantInstall(backend = 'cpu') {
  const dir = path.join(userData, 'engine', `${ENGINE_VERSION}-${backend}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'fake');
  fs.writeFileSync(path.join(dir, '.complete'),
    JSON.stringify({ version: ENGINE_VERSION, backend, binaryRelPath: 'llama-server.exe' }));
}

describe.skipIf(process.platform === 'win32')('EngineManager — the device-list backfill reaches the UI', () => {
  it('emits status-changed once acquisition fills in a pre-feature marker', async () => {
    // status() is pull-only. An engine installed before the device list existed
    // gets it filled in by a background probe, so without this push the user
    // keeps seeing the wrong "runs on" line until some unrelated engine event
    // happens to refetch. Guards the third EngineAcquisition constructor
    // argument, which knip cannot see is unwired.
    const dir = path.join(userData, 'engine', `${ENGINE_VERSION}-cpu`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'llama-server'),
      "#!/bin/sh\ncat <<'EOF'\nAvailable devices:\n  Vulkan0: AMD Radeon 8060S Graphics (RADV STRIX_HALO) (86016 MiB, 83660 MiB free)\nEOF\n",
      { mode: 0o755 });
    fs.writeFileSync(path.join(dir, '.complete'),
      JSON.stringify({ version: ENGINE_VERSION, backend: 'cpu', binaryRelPath: 'llama-server' }));

    const mgr = new EngineManager(home, userData, 9999, {
      // The graphics-chip probe pushes 'status-changed' on its own tick as
      // well, and a test that cannot tell the two pushes apart certifies
      // nothing: MEASURED 2026-09-05, this assertion stayed green with the
      // marker push deleted from BOTH ends (acquisition's onMarkerUpdated call
      // and the manager's wiring of it). Parking the chip probe on a promise
      // that never settles leaves the device-list backfill as the only thing
      // in the process that can emit — so a push here IS the backfill's.
      probeChip: () => new Promise(() => { /* never settles */ }),
    });
    let changed = 0;
    mgr.on('status-changed', () => { changed++; });
    expect(mgr.status().installed).toBe(true);   // starts the backfill
    await vi.waitFor(() => { expect(changed).toBeGreaterThan(0); });
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.complete'), 'utf8')).devices[0].totalMiB).toBe(86016);
  });
});

describe('selectInstallAsset (Fix: platforms without the preferred backend)', () => {
  it('falls back to CPU when the preferred backend has no asset for this platform/arch (win arm64)', () => {
    const sel = selectInstallAsset('win32', 'arm64', 'vulkan'); // no win-arm64 vulkan asset ships
    expect(sel?.backend).toBe('cpu');
    expect(sel?.asset.backend).toBe('cpu');
  });
  it('uses the preferred backend when it ships an asset', () => {
    expect(selectInstallAsset('win32', 'x64', 'vulkan')?.backend).toBe('vulkan');
  });
  it('returns null when neither the preferred backend nor CPU ships an asset', () => {
    expect(selectInstallAsset('sunos', 'mips', 'vulkan')).toBeNull();
  });
});

// The graphics-chip probe runs OFF the first status() call, so `backendOptions`
// arrives on a 'status-changed' push rather than in the answer that triggered
// it. That push is the only delivery there is — if it can be missed, the card
// waits forever for a second status that never comes. Everything that CAN
// change during a run is recomputed on every status() instead of cached.
// (2026-09-05 local-engine upgrades §A3.)
describe('EngineManager — the deferred chip probe and the live device line', () => {
  const settled = () => new Promise((r) => setTimeout(r, 0));
  const AMD_CHIP = { vendor: 'amd' as const, gfxTarget: 'gfx1151' };
  // WHY: these cases assert an AMD machine is OFFERED ROCm, but EngineManager
  // reads process.platform/arch straight from the runner (currentBackendOptions
  // → backendOptions), and backendOptions correctly offers Apple nothing. Left
  // to the real machine the expectations only hold on linux/win32 x64, so the
  // macOS leg went red the moment this landed. Same pin, and the same reason,
  // as the 'faster engine row' block below.
  const realPlatform = process.platform;
  const realArch = process.arch;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
  });
  // The real two-device reading from this machine (engine-acquisition.test.ts):
  // the software renderer reports 124406 MiB of system RAM and is not a GPU.
  const REAL_DEVICES = [
    { backend: 'Vulkan0', name: 'AMD Radeon 8060S Graphics (RADV STRIX_HALO)', totalMiB: 86016, freeMiB: 83633, isGpu: true },
    { backend: 'Vulkan1', name: 'llvmpipe (LLVM 22.1.6, 256 bits)', totalMiB: 124406, freeMiB: 80073, isGpu: false },
  ];

  /** Plant an install whose marker carries a device list, the way T2 writes it. */
  function plantInstallWithDevices(backend: string, devices: unknown) {
    const dir = path.join(userData, 'engine', `${ENGINE_VERSION}-${backend}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'fake');
    fs.writeFileSync(path.join(dir, '.complete'),
      JSON.stringify({ version: ENGINE_VERSION, backend, binaryRelPath: 'llama-server.exe', devices }));
  }

  it('status() answers immediately without backendOptions, then pushes them', async () => {
    // A marker that ALREADY carries devices, so T2's lazy backfill does not run
    // and emit a second 'status-changed' — this test counts the chip probe's push.
    plantInstallWithDevices('vulkan', REAL_DEVICES);
    const mgr = new EngineManager(home, userData, 9999, { probeChip: async () => AMD_CHIP });
    let pushes = 0;
    mgr.on('status-changed', () => { pushes += 1; });

    // The first answer must not block on the probe, so it cannot carry it.
    expect(mgr.status().backendOptions).toBeUndefined();

    await settled();
    expect(pushes).toBe(1);
    expect(mgr.status().backendOptions?.map((o) => o.backend)).toEqual(['rocm']);
  });

  it('a probe that THROWS still pushes, and settles on "nothing to offer"', async () => {
    // Devices already in the marker, for the same reason as above.
    plantInstallWithDevices('vulkan', REAL_DEVICES);
    const mgr = new EngineManager(home, userData, 9999, {
      probeChip: async () => { throw new Error('nvidia-smi wedged'); },
    });
    let pushes = 0;
    mgr.on('status-changed', () => { pushes += 1; });

    mgr.status();
    await settled();
    // The push fired on the failure path — this is what keeps the card from
    // hanging when a graphics driver misbehaves.
    expect(pushes).toBe(1);
    expect(mgr.status().backendOptions).toEqual([]);
  });

  // Both halves of this feature push independently: the chip probe (T3) and the
  // lazy device backfill (T2), which fills in a marker written before devices
  // were recorded. A user upgrading from an older install gets BOTH, and the
  // card must end up with the chip AND the device name. This is the case the
  // two tests above deliberately exclude so their counts stay meaningful.
  it('an older install with no device list gets both pushes, and ends up complete', async () => {
    plantInstall('vulkan'); // no `devices` key — every install made before T2
    const mgr = new EngineManager(home, userData, 9999, { probeChip: async () => AMD_CHIP });
    let pushes = 0;
    mgr.on('status-changed', () => { pushes += 1; });

    mgr.status();
    await settled();
    expect(pushes).toBeGreaterThanOrEqual(1);
    expect(mgr.status().backendOptions?.map((o) => o.backend)).toEqual(['rocm']);
  });

  it('asks the machine ONCE, however many times status() is called', async () => {
    plantInstall();
    let calls = 0;
    const mgr = new EngineManager(home, userData, 9999, {
      probeChip: async () => { calls += 1; return { vendor: null, gfxTarget: null }; },
    });
    mgr.status(); mgr.status(); mgr.status();
    await settled();
    mgr.status();
    await settled();
    expect(calls).toBe(1);
  });

  // The path every new user walks: the Local Models panel is where the Install
  // button lives, so the panel — and the first status() — happens BEFORE there
  // is any engine. An answer computed then and cached would say "Processor
  // only" forever on a machine that is using its graphics chip.
  it('the device name appears on the FIRST status after an install, not the next app run', async () => {
    const mgr = new EngineManager(home, userData, 9999, { probeChip: async () => AMD_CHIP });
    // Nothing installed yet: not known, which is NOT the same as "no GPU".
    expect(mgr.status().deviceName).toBeUndefined();
    await settled();
    expect(mgr.status().deviceName).toBeUndefined();

    plantInstallWithDevices('vulkan', REAL_DEVICES);
    expect(mgr.status().deviceName).toBe('AMD Radeon 8060S Graphics');
  });

  it('a switch to another backend shows THAT build\'s device, not the old one\'s', async () => {
    plantInstallWithDevices('vulkan', REAL_DEVICES);
    const mgr = new EngineManager(home, userData, 9999, { probeChip: async () => AMD_CHIP });
    mgr.status();          // kicks the probe
    await settled();
    expect(mgr.status().deviceName).toBe('AMD Radeon 8060S Graphics');
    // A ROCm install names its device differently, and the config now prefers it.
    plantInstallWithDevices('rocm', [{ backend: 'ROCm0', name: 'AMD Radeon Graphics (gfx1151)', totalMiB: 65536, freeMiB: 60000, isGpu: true }]);
    await updateEngineConfig(home, { backend: 'rocm' });
    const s = mgr.status();
    expect(s.backend).toBe('rocm');
    expect(s.deviceName).toBe('AMD Radeon Graphics');
    // …and the switch it is already on is no longer offered.
    expect(s.backendOptions).toEqual([]);
  });

  it('an engine that reports only a software renderer says "no GPU", not "not known"', () => {
    plantInstallWithDevices('vulkan', [REAL_DEVICES[1]]);
    const mgr = new EngineManager(home, userData, 9999, { probeChip: async () => AMD_CHIP });
    expect(mgr.status().deviceName).toBeNull();
  });

  it('a marker with no device list at all is "not known", never "no GPU"', () => {
    // Every install made before the device list existed. T2 backfills these
    // lazily; until it does, the card must not claim the processor is the answer.
    plantInstall('vulkan');
    const mgr = new EngineManager(home, userData, 9999, { probeChip: async () => AMD_CHIP });
    expect(mgr.status().deviceName).toBeUndefined();
  });

  it('a corrupt marker degrades to "not known" rather than throwing', () => {
    const dir = path.join(userData, 'engine', `${ENGINE_VERSION}-vulkan`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'fake');
    fs.writeFileSync(path.join(dir, '.complete'),
      JSON.stringify({ version: ENGINE_VERSION, backend: 'vulkan', binaryRelPath: 'llama-server.exe' }));
    const mgr = new EngineManager(home, userData, 9999, { probeChip: async () => AMD_CHIP });
    // Corrupt it AFTER the install is discovered, so we exercise the read path.
    fs.writeFileSync(path.join(dir, '.complete'), '{not json');
    expect(() => mgr.status()).not.toThrow();
    expect(mgr.status().deviceName).toBeUndefined();
  });

  it('a machine with no AMD or NVIDIA chip is offered nothing', async () => {
    plantInstall('vulkan');
    const mgr = new EngineManager(home, userData, 9999, {
      probeChip: async () => ({ vendor: 'intel' as const, gfxTarget: null }),
    });
    mgr.status();          // kicks the probe — nothing asks the machine unprompted
    await settled();
    expect(mgr.status().backendOptions).toEqual([]);
  });
});

describe('EngineManager', () => {
  it('status(): not-installed before any install; installed afterwards', () => {
    const mgr = new EngineManager(home, userData, 9999);
    expect(mgr.status().state).toBe('not-installed');
    expect(mgr.status().installed).toBe(false);
    plantInstall();
    const s = mgr.status();
    expect(s.installed).toBe(true);
    expect(s.installedVersion).toBe(ENGINE_VERSION);
    expect(s.backend).toBe('cpu');
    expect(s.state).toBe('stopped');
    expect(s.pinnedVersion).toBe(ENGINE_VERSION);
  });

  it('registryHook(): installed() false → ensureRunning throws install guidance', async () => {
    const mgr = new EngineManager(home, userData, 9999);
    const hook = mgr.registryHook();
    expect(hook.installed()).toBe(false);
    await expect(hook.ensureRunning()).rejects.toThrow(/Settings/);
  });

  it('catalogModels(): cache-scan models become providerId "local" CatalogModel rows carrying the CONFIGURED context size', async () => {
    plantInstall();
    const cacheDir = path.join(root, 'gguf-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'tiny-Q4_K_M.gguf'), Buffer.alloc(4));
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 8192 } }));
    const mgr = new EngineManager(home, userData, 9999);
    const models = await mgr.catalogModels();
    expect(models).toEqual([{
      id: 'tiny-Q4_K_M',
      providerId: 'local',
      label: 'tiny-Q4_K_M',
      contextLength: 8192, // the -c we spawn with, NOT the model's trained max
      local: { sizeBytes: 4, quant: 'unknown', installed: true, state: 'unloaded' },
    }]);
  });

  it('installedModels(): quant parsing + summed multi-part size + parts', async () => {
    plantInstall();
    const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'M-UD-Q4_K_XL-00001-of-00002.gguf'), Buffer.alloc(2));
    fs.writeFileSync(path.join(cacheDir, 'M-UD-Q4_K_XL-00002-of-00002.gguf'), Buffer.alloc(3));
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir } }));
    const mgr = new EngineManager(home, userData, 9999);
    const models = await mgr.installedModels();
    // sizeBytes is summed across the set's published parts. The row also
    // carries the download state (2026-08-27): both parts are present, so this
    // one is complete, and a complete row needs no manifest fields.
    expect(models).toEqual([{
      id: 'M-UD-Q4_K_XL-00001-of-00002', sizeBytes: 5,
      quant: 'UD-Q4_K_XL', quantDescription: expect.stringMatching(/unsloth/i),
      parts: 2, partsPresent: 2, status: 'complete',
      // No manifest at all, so nothing knows this model's repo — and a flat set
      // with no projector beside it is text-only (T15).
      totalSizeBytes: null, repo: null, vision: 'none', visionBytes: null,
    }]);
  });

  it('deleteModel(): removes every part + partials', async () => {
    plantInstall();
    const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
    for (const n of ['M-UD-Q4_K_XL-00001-of-00002.gguf', 'M-UD-Q4_K_XL-00002-of-00002.gguf']) {
      fs.writeFileSync(path.join(cacheDir, n), Buffer.alloc(1));
    }
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir } }));
    const mgr = new EngineManager(home, userData, 9999);
    await mgr.deleteModel('M-UD-Q4_K_XL-00001-of-00002');
    expect(fs.readdirSync(cacheDir)).toEqual([]);
  });
});

describe('EngineManager — local downloads', () => {
  let cacheDir: string;
  let manager: EngineManager;

  beforeEach(async () => {
    // A real cache dir under the per-test tmp root. Without this the manager
    // reads ~/.cache/llama.cpp — the developer's actual models.
    cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    await updateEngineConfig(home, { cacheDir });
    manager = new EngineManager(home, userData, 9999);
  });

  const manifest = (repo: string, files: string[], totalSizeBytes: number) => JSON.stringify({
    v: 1, repo, quant: 'UD-Q4_K_XL', files, totalSizeBytes, sha256ByFile: {}, startedAt: 1,
  });
  /** A manifest for a download that FINISHED — the state every completed
   *  download is left in since 2026-09-05. */
  const doneManifest = (repo: string, files: string[], totalSizeBytes: number) => JSON.stringify({
    v: 1, repo, quant: 'UD-Q4_K_XL', files, totalSizeBytes, sha256ByFile: {},
    startedAt: 1, completedAt: 2,
    visionFile: { path: 'mmproj-F16.gguf', size: 900, sha256: null },
  });

  it('reports a complete model, an unfinished one with its manifest, and an untraceable one', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Whole-Q4_K_M.gguf'), Buffer.alloc(50));
    fs.writeFileSync(path.join(cacheDir, 'Half-UD-Q4_K_XL-00001-of-00004.gguf'), Buffer.alloc(10));
    fs.writeFileSync(path.join(cacheDir, 'Half-UD-Q4_K_XL-00003-of-00004.gguf.partial'), Buffer.alloc(5));
    fs.writeFileSync(path.join(cacheDir, 'Half-UD-Q4_K_XL-00001-of-00004.gguf.download.json'),
      manifest('unsloth/Half-GGUF', ['Half-UD-Q4_K_XL-00001-of-00004.gguf'], 100));
    fs.writeFileSync(path.join(cacheDir, 'Old-UD-Q4_K_XL-00001-of-00002.gguf'), Buffer.alloc(20));

    const rows = await manager.installedModels();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(byId['Whole-Q4_K_M']).toMatchObject({
      status: 'complete', sizeBytes: 50, parts: 1, partsPresent: 1,
      totalSizeBytes: null, repo: null,
    });
    expect(byId['Half-UD-Q4_K_XL-00001-of-00004']).toMatchObject({
      status: 'unfinished', sizeBytes: 15, parts: 4, partsPresent: 1,
      totalSizeBytes: 100, repo: 'unsloth/Half-GGUF', quant: 'UD-Q4_K_XL',
    });
    expect(byId['Old-UD-Q4_K_XL-00001-of-00002']).toMatchObject({
      status: 'untraceable', sizeBytes: 20, parts: 2, partsPresent: 1,
      totalSizeBytes: null, repo: null,
    });
  });

  it('a download that stopped before its first byte is an unfinished row at 0 bytes', async () => {
    fs.writeFileSync(path.join(cacheDir, 'New-Q4_K_M.gguf.download.json'),
      manifest('unsloth/New-GGUF', ['New-Q4_K_M.gguf'], 100));
    const rows = await manager.installedModels();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'New-Q4_K_M', status: 'unfinished', sizeBytes: 0, totalSizeBytes: 100, repo: 'unsloth/New-GGUF',
    });
  });

  it('an unreadable manifest with no bytes is nothing the user can act on — dropped and removed', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Junk-Q4_K_M.gguf.download.json'), '{not json');
    expect(await manager.installedModels()).toEqual([]);
    expect(fs.existsSync(path.join(cacheDir, 'Junk-Q4_K_M.gguf.download.json'))).toBe(false);
  });

  // Was: 'removes a stale manifest left beside a COMPLETE set'. The manifest now
  // OUTLIVES the download — it is the only record of the repo a finished model
  // came from — so a complete set keeps it, and completedAt (not presence) is
  // what says the download is over.
  it('KEEPS a finished manifest beside a complete set, and never calls it unfinished', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Whole-Q4_K_M.gguf'), Buffer.alloc(50));
    fs.writeFileSync(path.join(cacheDir, 'Whole-Q4_K_M.gguf.download.json'),
      doneManifest('a/b', ['Whole-Q4_K_M.gguf'], 50));
    const rows = await manager.installedModels();
    expect(rows[0].status).toBe('complete');
    expect(fs.existsSync(path.join(cacheDir, 'Whole-Q4_K_M.gguf.download.json'))).toBe(true);
    const kept = JSON.parse(fs.readFileSync(path.join(cacheDir, 'Whole-Q4_K_M.gguf.download.json'), 'utf8'));
    expect(kept.completedAt).toBe(2);                       // untouched
    expect(kept.visionFile.path).toBe('mmproj-F16.gguf');   // what §E needs later
  });

  it('a complete set whose manifest was never stamped is HEALED, not thrown away', async () => {
    // The crash window: the last part published, the app died before the stamp.
    fs.writeFileSync(path.join(cacheDir, 'Whole-Q4_K_M.gguf'), Buffer.alloc(50));
    fs.writeFileSync(path.join(cacheDir, 'Whole-Q4_K_M.gguf.download.json'),
      manifest('a/b', ['Whole-Q4_K_M.gguf'], 50));
    const rows = await manager.installedModels();
    expect(rows[0].status).toBe('complete');
    const healed = JSON.parse(fs.readFileSync(path.join(cacheDir, 'Whole-Q4_K_M.gguf.download.json'), 'utf8'));
    expect(typeof healed.completedAt).toBe('number');
    expect(healed.repo).toBe('a/b');
  });

  it("keeps §E3's repo: null miss record — sweeping it would make the lookup repeat forever", async () => {
    // "We searched Hugging Face for this model and found nothing" is a REAL
    // record: it is what stops the search running again on every render.
    fs.writeFileSync(path.join(cacheDir, 'Mystery-Q4_K_M.gguf'), Buffer.alloc(50));
    fs.writeFileSync(path.join(cacheDir, 'Mystery-Q4_K_M.gguf.download.json'), JSON.stringify({
      v: 1, repo: null, quant: 'Q4_K_M', files: ['Mystery-Q4_K_M.gguf'],
      totalSizeBytes: 50, sha256ByFile: {}, startedAt: 1, completedAt: 2,
    }));
    const rows = await manager.installedModels();
    expect(rows[0]).toMatchObject({ id: 'Mystery-Q4_K_M', status: 'complete', repo: null });
    expect(fs.existsSync(path.join(cacheDir, 'Mystery-Q4_K_M.gguf.download.json'))).toBe(true);
    const kept = JSON.parse(fs.readFileSync(path.join(cacheDir, 'Mystery-Q4_K_M.gguf.download.json'), 'utf8'));
    expect(kept.repo).toBeNull();
    expect(kept.completedAt).toBe(2);   // not re-stamped either
  });

  it('a stamped manifest with no bytes at all is a leftover, not an unfinished row', async () => {
    // The files were deleted from under a finished download: nothing to resume,
    // nothing to show, so the record goes with them.
    fs.writeFileSync(path.join(cacheDir, 'Gone-Q4_K_M.gguf.download.json'),
      doneManifest('a/b', ['Gone-Q4_K_M.gguf'], 50));
    expect(await manager.installedModels()).toEqual([]);
    expect(fs.existsSync(path.join(cacheDir, 'Gone-Q4_K_M.gguf.download.json'))).toBe(false);
  });

  // ── The three vision states (design §E2) ─────────────────────────────────
  // 'ready'     — the projector is on disk beside the weights, so the engine
  //               loads this model with --mmproj and it can look at images.
  // 'available' — the repo HAS a projector this copy does not: the download's
  //               second leg failed, or the app died between the two. Same row,
  //               same fix ("Add vision"), so the same state.
  // 'none'      — this model family has no projector at all.
  const visionFolder = (id: string, opts: { projector: boolean }) => {
    const folder = path.join(cacheDir, id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${id}.gguf`), Buffer.alloc(60));
    if (opts.projector) fs.writeFileSync(path.join(folder, 'mmproj-F16.gguf'), Buffer.alloc(7));
    fs.writeFileSync(path.join(folder, `${id}.gguf.download.json`), JSON.stringify({
      v: 1, repo: 'unsloth/V-GGUF', quant: 'Q4_K_M', files: [`${id}.gguf`],
      totalSizeBytes: 60, sha256ByFile: {}, startedAt: 1, completedAt: 2,
      visionFile: { path: 'mmproj-F16.gguf', size: 900, sha256: null },
    }));
    return folder;
  };

  it("vision 'ready': the projector is on disk, and the row's size admits to it", async () => {
    visionFolder('V-Q4_K_M', { projector: true });
    const rows = await manager.installedModels();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'V-Q4_K_M', status: 'complete', vision: 'ready',
      // The projector's REAL size on disk, not the manifest's remote figure.
      visionBytes: 7,
      // Weights + projector: this is what deleting the folder gives back.
      sizeBytes: 67,
      // Flipped by T15 — the row needs it to match its own download's progress.
      repo: 'unsloth/V-GGUF',
    });
  });

  it('a complete row admits to a projector still arriving, because Delete removes it too', async () => {
    // deleteModel removes the folder recursively — .partial files included — so
    // a complete row that reported published bytes only understated what the
    // confirmation was about to throw away.
    const folder = visionFolder('V-Q4_K_M', { projector: false });
    fs.writeFileSync(path.join(folder, 'mmproj-F16.gguf.partial'), Buffer.alloc(11));
    const rows = await manager.installedModels();
    expect(rows[0]).toMatchObject({ id: 'V-Q4_K_M', status: 'complete', sizeBytes: 71 });
  });

  it("vision 'available': the manifest names a projector that is not on disk", async () => {
    // Both the failed-second-leg case and the crash-recovery case (R1-11).
    visionFolder('V-Q4_K_M', { projector: false });
    const rows = await manager.installedModels();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'V-Q4_K_M', status: 'complete', vision: 'available',
      // The size the row's "Add vision (0.9 GB)" label has to quote, which can
      // only come from the manifest — nothing of it is on disk.
      visionBytes: 900,
      sizeBytes: 60,
    });
  });

  it("vision 'none': a model whose repo ships no projector", async () => {
    fs.writeFileSync(path.join(cacheDir, 'Plain-Q4_K_M.gguf'), Buffer.alloc(50));
    fs.writeFileSync(path.join(cacheDir, 'Plain-Q4_K_M.gguf.download.json'),
      manifest('a/b', ['Plain-Q4_K_M.gguf'], 50));
    const rows = await manager.installedModels();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'Plain-Q4_K_M', vision: 'none', visionBytes: null });
  });

  it('deleteModel removes the whole folder AND the model\'s own settings', async () => {
    visionFolder('V-Q4_K_M', { projector: true });
    fs.writeFileSync(path.join(cacheDir, 'V-Q4_K_M', 'mmproj-F16.gguf.partial'), Buffer.alloc(3));
    await home.mutateJson('config.json', (cur: any) => ({
      ...cur,
      engine: { ...(cur?.engine ?? {}), models: { 'V-Q4_K_M': { contextLength: 4096 }, 'Other': { keepLoaded: true } } },
    }));
    await manager.deleteModel('V-Q4_K_M');
    expect(fs.existsSync(path.join(cacheDir, 'V-Q4_K_M'))).toBe(false);
    expect(fs.readdirSync(cacheDir)).toEqual([]);
    // Pruned — a section for a model that no longer exists renders a ghost row
    // in the router's preset file, and a re-download would inherit its context.
    const cfg = home.readJson('config.json') as any;
    expect(Object.keys(cfg.engine.models)).toEqual(['Other']);
  });

  it('deleteModel removes the manifest along with the parts', async () => {
    fs.writeFileSync(path.join(cacheDir, 'M-Q4_K_M.gguf.partial'), Buffer.alloc(10));
    fs.writeFileSync(path.join(cacheDir, 'M-Q4_K_M.gguf.download.json'), '{}');
    // No supervisor is running in this fixture, so refreshModels() is a no-op
    // — deleteModel needs no engine.
    await manager.deleteModel('M-Q4_K_M');
    expect(fs.readdirSync(cacheDir)).toEqual([]);
  });

  // T17: the move into a folder is more than one syscall, so a crash can land
  // between them. The ordering makes that harmless for what the engine SERVES;
  // this is what makes it harmless for the user.
  it('undoes an Add-vision move a crash stopped half way, instead of sweeping the record away', async () => {
    // Steps 1-2 of the move done (folder made, record moved), step 3 not.
    fs.writeFileSync(path.join(cacheDir, 'Half-UD-Q4_K_XL.gguf'), Buffer.alloc(10));
    fs.mkdirSync(path.join(cacheDir, 'Half-UD-Q4_K_XL'));
    fs.writeFileSync(
      path.join(cacheDir, 'Half-UD-Q4_K_XL', 'Half-UD-Q4_K_XL.gguf.download.json'),
      doneManifest('unsloth/Half-GGUF', ['Half-UD-Q4_K_XL.gguf'], 10));

    const rows = await manager.installedModels();

    // ONE model, whole, with its repo and its Add-vision link — not two broken
    // halves. Before this healing existed the folder row was read as "a record
    // of nothing" and REMOVED, which left an empty folder that made every later
    // Add-vision attempt fail at mkdir for ever.
    expect(rows.map((r) => [r.id, r.status, r.repo, r.vision]))
      .toEqual([['Half-UD-Q4_K_XL', 'complete', 'unsloth/Half-GGUF', 'available']]);
    expect(fs.existsSync(path.join(cacheDir, 'Half-UD-Q4_K_XL.gguf.download.json'))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, 'Half-UD-Q4_K_XL'))).toBe(false);
  });

});

// ---------------------------------------------------------------------------
// T19 — the engine card's "last reply N read / M write per second" fact.
// ---------------------------------------------------------------------------
describe('EngineManager — the last reply\'s speed', () => {
  /** The exact reading b10665 reported for a real streamed reply, 2026-09-05
   *  (pasted from the capture in prefill-progress.test.ts). */
  const REAL_READING = { promptPerSecond: 84.05715886803026, generatePerSecond: 37.821109441135555 };

  it('is ABSENT until a reply has actually been measured — never a zero', () => {
    plantInstall();
    const mgr = new EngineManager(home, userData, 9999);
    // The card reads `if (status.lastReply)`, so a `{0, 0}` here would print
    // "last reply 0 read / 0 write per second" to every user who has not sent a
    // message yet. Absence is the only honest answer before the first reply.
    expect(mgr.status().lastReply).toBeUndefined();
    // Same three-state rule as deviceName: not asked yet is not an answer.
    expect(mgr.status().loadedModelsBytes).toBeUndefined();
  });

  it('status() reports the supervisor\'s loaded-model total, not a fixed absence', () => {
    // Deliberately white-box: getting a REAL supervisor into a running state
    // means spawning llama-server, which this suite cannot do. Standing a stub
    // in its place is what makes this test bite — asserting only that the field
    // is `undefined` on a stopped engine passes just as happily when the field
    // is not wired into status() at all (measured: that mutation stayed green).
    plantInstall();
    const mgr = new EngineManager(home, userData, 9999);
    (mgr as any).supervisor = { status: () => 'running', presetInForce: () => true, presetProblem: () => null, loadedModelsBytes: () => 9_527_502_048 };
    expect(mgr.status().loadedModelsBytes).toBe(9_527_502_048);
    // And a supervisor that has not been asked yet passes its absence through.
    (mgr as any).supervisor = { status: () => 'running', presetInForce: () => true, presetProblem: () => null, loadedModelsBytes: () => undefined };
    expect(mgr.status().loadedModelsBytes).toBeUndefined();
  });

  it('T23: reports per-model settings for a RUNNING engine only, never a starting one', () => {
    // A supervisor that is still coming up has not written its preset yet, so
    // `presetInForce()` is false — the value left over from the PREVIOUS run.
    // Reported during 'starting', the card would show a stale answer, and the
    // one moment the user is most likely to be looking at it is a restart.
    plantInstall();
    const mgr = new EngineManager(home, userData, 9999);
    (mgr as any).supervisor = { status: () => 'starting', presetInForce: () => false, presetProblem: () => null, loadedModelsBytes: () => undefined };
    expect(mgr.status().modelSettingsInForce).toBeUndefined();
    (mgr as any).supervisor = { status: () => 'running', presetInForce: () => false, presetProblem: () => null, loadedModelsBytes: () => undefined };
    expect(mgr.status().modelSettingsInForce).toBe(false);
  });

  it('T23: "waiting for a reply" means the ENGINE IS BUSY, not merely that a change is queued', () => {
    // `configApplyPending` goes true the moment a change is queued, including a
    // restart on a machine with nothing running at all — where it lands a poll
    // interval later. Read as "a reply is holding this up", the card would tell
    // most users to wait for a reply nobody is reading.
    plantInstall();
    const mgr = new EngineManager(home, userData, 9999);
    const sup: any = { status: () => 'running', presetInForce: () => true, presetProblem: () => null, loadedModelsBytes: () => undefined, busy: () => false };
    (mgr as any).supervisor = sup;
    (mgr as any).applyWaiter = Promise.resolve();
    expect(mgr.status().configApplyPending).toBe(true);
    expect(mgr.status().configApplyWaitingForReply).toBe(false);
    sup.busy = () => true;
    expect(mgr.status().configApplyWaitingForReply).toBe(true);
  });

  it('recordReply stores the exact rates and pushes status-changed', () => {
    plantInstall();
    const mgr = new EngineManager(home, userData, 9999);
    let pushes = 0;
    mgr.on('status-changed', () => { pushes++; });
    mgr.recordReply(REAL_READING);
    // Exact, not rounded and not a range: the card divides these two numbers
    // between "read" and "write", and swapping them is a silent wrong fact.
    expect(mgr.status().lastReply).toEqual(REAL_READING);
    // status() is pull-only. Without the push the card keeps the old number.
    expect(pushes).toBeGreaterThan(0);
  });

  it('recordReply(null) CLEARS the reading rather than leaving a stale one', () => {
    plantInstall();
    const mgr = new EngineManager(home, userData, 9999);
    mgr.recordReply(REAL_READING);
    expect(mgr.status().lastReply).toEqual(REAL_READING);
    // A reply whose final frame carried no timings must not leave the PREVIOUS
    // reply's speed on screen labelled "last reply".
    mgr.recordReply(null);
    expect(mgr.status().lastReply).toBeUndefined();
  });

  it('registryHook() exposes recordReply, so the provider tap can reach it', () => {
    plantInstall();
    const mgr = new EngineManager(home, userData, 9999);
    mgr.registryHook().recordReply(REAL_READING);
    expect(mgr.status().lastReply).toEqual(REAL_READING);
  });
});

// setBackend: the checks that stand between "Switch to ROCm" and a user whose
// local models silently stop working (design §A4, task T4).
//
// The download here is 204 MB (Linux ROCm) to 612 MB (Windows CUDA), and the
// build can be perfectly valid and still be unable to run on THIS chip. So the
// rule is: prove it, or put the machine back exactly as it was and say why in
// the engine's own words.
//
// Every message below is asserted with toBe, not a substring match. Three of
// these failures differ only in their sentence — "the binary would not start",
// "your chip is not one this build has code for" and "the model is broken" —
// so a substring assertion would stay green under precisely the mix-up these
// tests exist to catch.
// ---------------------------------------------------------------------------
describe('EngineManager.setBackend — the device check, the real load, and what gets thrown away', () => {
  const ROCM_DIR = () => path.join(userData, 'engine', `${ENGINE_VERSION}-rocm`);
  const realPlatform = process.platform;
  const realArch = process.arch;

  // Pinned to linux/x64 so the suite runs the same everywhere: that is a
  // platform the pin ships a ROCm asset for (engine-pin.ts), and without this
  // the whole thing would skip on a macOS or arm64 runner — i.e. exactly where
  // a regression would go unnoticed.
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
    vi.restoreAllMocks();
  });

  const ROCM_DEVICE = { backend: 'ROCm0', name: 'AMD Radeon Graphics (gfx1151)', totalMiB: 65536, freeMiB: 60000, isGpu: true };
  const SOFTWARE_ONLY = [{ backend: 'Vulkan0', name: 'llvmpipe (LLVM 22.1.6, 256 bits)', totalMiB: 124406, freeMiB: 80073, isGpu: false }];

  /** Write a ROCm install's directory + marker exactly as engine-acquisition
   *  would after a successful unpack + device probe. */
  function writeRocmInstall(marker: { devices?: unknown; devicesError?: string }) {
    const dir = ROCM_DIR();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'llama-server'), 'fake');
    fs.writeFileSync(path.join(dir, '.complete'), JSON.stringify({
      version: ENGINE_VERSION, backend: 'rocm', binaryRelPath: 'llama-server',
      devices: marker.devices ?? [],
      ...(marker.devicesError ? { devicesError: marker.devicesError } : {}),
    }));
    return {
      version: ENGINE_VERSION, backend: 'rocm' as const,
      binaryPath: path.join(dir, 'llama-server'), dir,
      devices: (marker.devices ?? []) as any,
      ...(marker.devicesError ? { devicesError: marker.devicesError } : {}),
    };
  }

  /** Stand in for the 204 MB download. The directory must NOT exist before the
   *  call — `preexisting` is read off disk before install() runs, and it is
   *  what decides whether a failed switch may delete anything. */
  function stubDownload(mgr: EngineManager, marker: { devices?: unknown; devicesError?: string }) {
    vi.spyOn((mgr as any).acquisition, 'install').mockImplementation(async () => writeRocmInstall(marker));
  }

  /** The build boots — that check has its own coverage; these tests are about
   *  everything on either side of it. */
  function stubBoots(mgr: EngineManager) {
    vi.spyOn(mgr as unknown as { verifyBoot: () => Promise<void> }, 'verifyBoot').mockResolvedValue(undefined);
  }

  /** The exact message of a rejected switch. `rejects.toThrow` matches on a
   *  SUBSTRING, which is worthless here — the three refusals share most of
   *  their text and differ exactly where the bug would be. */
  async function refusalOf(p: Promise<unknown>): Promise<string> {
    try { await p; } catch (e: any) { return e.message; }
    throw new Error('expected setBackend to reject, but it resolved');
  }

  /** One completed model in the cache, so the real-load step has something to
   *  load. Returns the id the router would be asked for. */
  async function plantModel(): Promise<string> {
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'tiny-Q4_K_M.gguf'), Buffer.alloc(4));
    await updateEngineConfig(home, { cacheDir });
    return 'tiny-Q4_K_M';
  }

  /** A router that answers one completion with the given failure. */
  function failingRouter(status: number, body: string) {
    const calls: string[] = [];
    const fetchImpl = (async (url: any) => {
      calls.push(String(url));
      return new Response(body, { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it('a build that lists no matching device is thrown away, and the sentence names what it DID report', async () => {
    plantInstall('vulkan');
    const mgr = new EngineManager(home, userData, 9999);
    stubDownload(mgr, { devices: SOFTWARE_ONLY });
    stubBoots(mgr);

    expect(await refusalOf(mgr.setBackend('rocm'))).toBe(
      'Kept the current engine: the ROCm build found no graphics chip it can use — '
      + 'it reported: llvmpipe (LLVM 22.1.6, 256 bits). Nothing was changed.'
    );
    // The 204 MB that cannot run is gone, and the working engine is back.
    expect(fs.existsSync(ROCM_DIR())).toBe(false);
    expect(mgr.status().backend).toBe('vulkan');
    expect(readEngineConfig(home).backend ?? null).not.toBe('rocm');
  });

  it('a build that reports nothing at all says so, rather than naming a device it never mentioned', async () => {
    plantInstall('vulkan');
    const mgr = new EngineManager(home, userData, 9999);
    stubDownload(mgr, { devices: [] });
    stubBoots(mgr);
    expect(await refusalOf(mgr.setBackend('rocm'))).toBe(
      'Kept the current engine: the ROCm build found no graphics chip it can use — '
      + 'it reported no devices at all. Nothing was changed.'
    );
  });

  // The reason `devicesError` exists (T2 handoff). A missing ROCm library and a
  // machine with no supported chip BOTH leave the device list empty, and they
  // ask the user for completely different things. Reading the list first would
  // tell someone who only needs to install a package that their graphics card
  // is unsupported.
  it('a binary that will not START gets its own sentence, quoting the loader — never the "no graphics chip" one', async () => {
    plantInstall('vulkan');
    const mgr = new EngineManager(home, userData, 9999);
    const loaderError = 'llama-server --list-devices failed: llama-server: error while loading shared libraries: '
      + 'libamdhip64.so.7: cannot open shared object file: No such file or directory';
    stubDownload(mgr, { devices: [], devicesError: loaderError });
    stubBoots(mgr);

    const msg = await refusalOf(mgr.setBackend('rocm'));
    expect(msg).toBe(
      `Kept the current engine: the ROCm build could not be asked which graphics chip it would use — "${loaderError}". Nothing was changed.`
    );
    expect(msg).not.toContain('found no graphics chip');
    expect(fs.existsSync(ROCM_DIR())).toBe(false);
  });

  it('a load that fails on the kernel image throws the build away and quotes the router', async () => {
    plantInstall('vulkan');
    await plantModel();
    const router = failingRouter(500, JSON.stringify({
      error: { message: 'HIP error: no kernel image is available for execution on the device' },
    }));
    const mgr = new EngineManager(home, userData, 9999, { fetchImpl: router.fetchImpl });
    stubDownload(mgr, { devices: [ROCM_DEVICE] });   // it DOES list a ROCm device
    stubBoots(mgr);                                   // and it DOES boot

    expect(await refusalOf(mgr.setBackend('rocm'))).toBe(
      'Kept the current engine: the ROCm build found no graphics chip it can use — '
      + '"HIP error: no kernel image is available for execution on the device". Nothing was changed.'
    );
    expect(router.calls).toEqual(['http://127.0.0.1:9999/v1/chat/completions']);
    expect(fs.existsSync(ROCM_DIR())).toBe(false);
    expect(readEngineConfig(home).backend ?? null).not.toBe('rocm');
  });

  it('a load that fails on the MODEL keeps the switch, keeps the build, and still says what happened', async () => {
    plantInstall('vulkan');
    const modelId = await plantModel();
    const router = failingRouter(500, JSON.stringify({
      error: { message: "failed to load model: unknown model architecture 'qwen4exp'" },
    }));
    const mgr = new EngineManager(home, userData, 9999, { fetchImpl: router.fetchImpl });
    stubDownload(mgr, { devices: [ROCM_DEVICE] });
    stubBoots(mgr);

    expect(await refusalOf(mgr.setBackend('rocm'))).toBe(
      'Switched to ROCm. The engine started and found your graphics chip, '
      + `but the model "${modelId}" did not load — "failed to load model: unknown model architecture 'qwen4exp'".`
    );
    // Nothing was thrown away and the switch stands: one broken file is not a
    // reason to delete a working engine.
    expect(fs.existsSync(ROCM_DIR())).toBe(true);
    expect(readEngineConfig(home).backend).toBe('rocm');
  });

  it('an install that was ALREADY on disk is never deleted, however the check fails', async () => {
    plantInstall('vulkan');
    // Here the real acquisition.install() runs: it finds this marker, sees a
    // device list already recorded and returns it untouched. Pressing Switch on
    // a build that is already downloaded must not be able to delete it.
    writeRocmInstall({ devices: SOFTWARE_ONLY });
    const mgr = new EngineManager(home, userData, 9999);
    stubBoots(mgr);

    expect(await refusalOf(mgr.setBackend('rocm'))).toContain('found no graphics chip it can use');
    expect(fs.existsSync(path.join(ROCM_DIR(), '.complete'))).toBe(true);
    // …and, because the directory survives, WHICH ENGINE IS NOW CURRENT is the
    // assertion that matters. Without the config pin below, installed() falls
    // through to raw readdir order — where `b10665-rocm` sorts before
    // `b10665-vulkan` — and the refused build becomes the engine every model
    // loads on, under a message reading "Nothing was changed".
    expect(readEngineConfig(home).backend).toBe('vulkan');
    expect(mgr.status().backend).toBe('vulkan');
  });

  it('a refusal whose directory could NOT be deleted still leaves the old engine current', async () => {
    // discard() is documented to return false when a caller may still hold the
    // binary open — the Windows case right after verifyBoot ran that very exe.
    // Its return value is not actionable, so the config pin is what has to
    // survive it.
    plantInstall('vulkan');
    const mgr = new EngineManager(home, userData, 9999);
    stubDownload(mgr, { devices: SOFTWARE_ONLY });
    stubBoots(mgr);
    vi.spyOn((mgr as any).acquisition, 'discard').mockReturnValue(false);

    await refusalOf(mgr.setBackend('rocm'));
    expect(fs.existsSync(path.join(ROCM_DIR(), '.complete'))).toBe(true);   // it really is still there
    expect(readEngineConfig(home).backend).toBe('vulkan');
    expect(mgr.status().backend).toBe('vulkan');
  });

  it('the engine the user is running is pinned BEFORE the download, not after the refusal', async () => {
    // The third route to a surviving directory is a quit or a crash between the
    // install and the config write — a window this task widened from "boot a
    // server" to "download up to 612 MB, boot, and load a whole model". Nothing
    // runs on that path to clean up, so the pin has to be on disk before the
    // first byte moves.
    plantInstall('vulkan');
    const mgr = new EngineManager(home, userData, 9999);
    let backendAtDownload: string | null = null;
    vi.spyOn((mgr as any).acquisition, 'install').mockImplementation(async () => {
      backendAtDownload = readEngineConfig(home).backend ?? null;
      return writeRocmInstall({ devices: SOFTWARE_ONLY });
    });
    stubBoots(mgr);
    await refusalOf(mgr.setBackend('rocm'));
    expect(backendAtDownload).toBe('vulkan');
  });

  it('a marker whose binary is missing is NOT "already on disk" — install() reinstalls over it', async () => {
    plantInstall('vulkan');
    // The half-install: a marker, no binary. acquisition.install() treats this
    // as a fresh install, so the directory that exists afterwards IS this
    // call's — and refusing to discard it would strand the refused build.
    const dir = ROCM_DIR();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.complete'), JSON.stringify({
      version: ENGINE_VERSION, backend: 'rocm', binaryRelPath: 'llama-server', devices: [],
    }));
    const mgr = new EngineManager(home, userData, 9999);
    stubDownload(mgr, { devices: SOFTWARE_ONLY });
    stubBoots(mgr);

    await refusalOf(mgr.setBackend('rocm'));
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('the device check does NOT stop the engine the user is running', async () => {
    // Nothing has touched the supervisor at this point: it is still the old,
    // working engine, possibly mid-reply, and stop() has no in-flight guard.
    // Tearing it down here would kill a streaming answer and unload the
    // resident model, under a message saying nothing changed.
    plantInstall('vulkan');
    const mgr = new EngineManager(home, userData, 9999);
    const stop = vi.fn(async () => {});
    (mgr as any).supervisor = { status: () => 'running', presetInForce: () => true, presetProblem: () => null, stop };
    (mgr as any).supervisorBinary = path.join(userData, 'engine', `${ENGINE_VERSION}-vulkan`, 'llama-server.exe');
    stubDownload(mgr, { devices: SOFTWARE_ONLY });
    stubBoots(mgr);

    await refusalOf(mgr.setBackend('rocm'));
    expect(stop).not.toHaveBeenCalled();
    expect((mgr as any).supervisor).not.toBeNull();
  });

  it('…but DOES drop a supervisor pointing at the binary being deleted', async () => {
    plantInstall('vulkan');
    const mgr = new EngineManager(home, userData, 9999);
    const stop = vi.fn(async () => {});
    stubDownload(mgr, { devices: [ROCM_DEVICE] });
    // verifyBoot is what repoints the supervisor at the new build; when the
    // boot then fails, that binary is about to be deleted underneath it.
    vi.spyOn(mgr as unknown as { verifyBoot: () => Promise<void> }, 'verifyBoot')
      .mockImplementation(async () => {
        (mgr as any).supervisor = { status: () => 'running', presetInForce: () => true, presetProblem: () => null, stop };
        (mgr as any).supervisorBinary = path.join(ROCM_DIR(), 'llama-server');
        throw new Error('port busy');
      });

    await refusalOf(mgr.setBackend('rocm'));
    expect(stop).toHaveBeenCalledTimes(1);
    expect((mgr as any).supervisor).toBeNull();
  });

  it('an engine that cannot be reached at all is a BUILD problem — the switch is refused, not kept', async () => {
    // A GPU build compiled for the wrong chip commonly aborts the child rather
    // than answering with an error document. Filing that as "the model is
    // broken" would keep the switch and leave every future model failing.
    plantInstall('vulkan');
    await plantModel();
    const fetchImpl = (async () => { throw new Error('fetch failed'); }) as unknown as typeof fetch;
    const mgr = new EngineManager(home, userData, 9999, { fetchImpl });
    stubDownload(mgr, { devices: [ROCM_DEVICE] });
    stubBoots(mgr);

    expect(await refusalOf(mgr.setBackend('rocm'))).toBe(
      'Kept the current engine: the ROCm build stopped answering while loading a model — "fetch failed". Nothing was changed.'
    );
    expect(fs.existsSync(ROCM_DIR())).toBe(false);
    expect(readEngineConfig(home).backend).toBe('vulkan');
  });

  it('a load that never finishes is bounded, and reported as the engine not answering', async () => {
    plantInstall('vulkan');
    await plantModel();
    // Honours the abort signal, like undici does — the timeout is what ends it.
    const fetchImpl = ((_url: any, init: any) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(new Error('This operation was aborted')));
    })) as unknown as typeof fetch;
    const mgr = new EngineManager(home, userData, 9999, { fetchImpl, loadProbeTimeoutMs: 5 });
    stubDownload(mgr, { devices: [ROCM_DEVICE] });
    stubBoots(mgr);

    expect(await refusalOf(mgr.setBackend('rocm'))).toBe(
      'Kept the current engine: the ROCm build stopped answering while loading a model '
      + '— "the engine did not finish loading a model within 5 ms". Nothing was changed.'
    );
    expect(readEngineConfig(home).backend).toBe('vulkan');
  });

  it("a ROCm-prefixed device error is caught, and a CUDA out-of-memory is not", async () => {
    // Both arrive through the same ggml error macro; only one is a verdict on
    // the build. Driven end to end, because the consequence is opposite:
    // one deletes a 204 MB download, the other must not.
    plantInstall('vulkan');
    await plantModel();
    const rocmMgr = new EngineManager(home, userData, 9999, {
      fetchImpl: failingRouter(500, JSON.stringify({ error: { message: 'ROCm error: hipErrorNoDevice' } })).fetchImpl,
    });
    stubDownload(rocmMgr, { devices: [ROCM_DEVICE] });
    stubBoots(rocmMgr);
    expect(await refusalOf(rocmMgr.setBackend('rocm'))).toBe(
      'Kept the current engine: the ROCm build found no graphics chip it can use — "ROCm error: hipErrorNoDevice". Nothing was changed.'
    );
    expect(fs.existsSync(ROCM_DIR())).toBe(false);

    const oomMgr = new EngineManager(home, userData, 9999, {
      fetchImpl: failingRouter(500, JSON.stringify({ error: { message: 'CUDA error: out of memory' } })).fetchImpl,
    });
    stubDownload(oomMgr, { devices: [ROCM_DEVICE] });
    stubBoots(oomMgr);
    // A model that does not fit is not a broken build: the download stays and
    // the switch stands, and the message never claims a cause.
    expect(await refusalOf(oomMgr.setBackend('rocm'))).toContain('did not load — "CUDA error: out of memory"');
    expect(fs.existsSync(ROCM_DIR())).toBe(true);
    expect(readEngineConfig(home).backend).toBe('rocm');
  });

  it('with no model on disk the load step is SKIPPED, and the switch is still kept', async () => {
    plantInstall('vulkan');
    const cacheDir = path.join(root, 'empty-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    await updateEngineConfig(home, { cacheDir });
    // Any request at all is a failure: there is nothing to load, so asking the
    // router to load it would 400 and be read as a broken switch.
    const router = failingRouter(500, '{"error":{"message":"no kernel image"}}');
    const mgr = new EngineManager(home, userData, 9999, { fetchImpl: router.fetchImpl });
    stubDownload(mgr, { devices: [ROCM_DEVICE] });
    stubBoots(mgr);

    await expect(mgr.setBackend('rocm')).resolves.toBeUndefined();
    expect(router.calls).toEqual([]);
    expect(readEngineConfig(home).backend).toBe('rocm');
  });

  it('and the faster-engine row says the check is still to come while the cache is empty', async () => {
    plantInstall('vulkan');
    const cacheDir = path.join(root, 'empty-cache-2');
    fs.mkdirSync(cacheDir, { recursive: true });
    await updateEngineConfig(home, { cacheDir });
    const mgr = new EngineManager(home, userData, 9999, {
      probeChip: async () => ({ vendor: 'amd' as const, gfxTarget: 'gfx1151' }),
    });
    mgr.status();                                   // kicks the deferred chip probe
    await new Promise((r) => setTimeout(r, 0));
    expect(mgr.status().backendOptions?.map((o) => o.state)).toEqual(['ready']);
    expect(mgr.status().backendOptions?.map((o) => o.note))
      .toEqual(['Checked when your first model loads.']);

    // One completed download and the note is gone — the check can run now.
    fs.writeFileSync(path.join(cacheDir, 'tiny-Q4_K_M.gguf'), Buffer.alloc(4));
    expect(mgr.status().backendOptions?.map((o) => o.note)).toEqual([undefined]);
  });

  it('but a row that is still asking for AMD\'s software gets no second instruction', async () => {
    // "ROCm needs AMD's software installed first. Checked when your first model
    // loads." is two unrelated instructions in one line, on the one row where
    // the user already has something else to do.
    prereqState.satisfied = false;
    try {
      plantInstall('vulkan');
      const cacheDir = path.join(root, 'empty-cache-3');
      fs.mkdirSync(cacheDir, { recursive: true });
      await updateEngineConfig(home, { cacheDir });
      const mgr = new EngineManager(home, userData, 9999, {
        probeChip: async () => ({ vendor: 'amd' as const, gfxTarget: 'gfx1151' }),
      });
      mgr.status();
      await new Promise((r) => setTimeout(r, 0));
      expect(mgr.status().backendOptions?.map((o) => o.state)).toEqual(['needs-prereqs']);
      expect(mgr.status().backendOptions?.map((o) => o.note)).toEqual([undefined]);
    } finally { prereqState.satisfied = true; }
  });

  it('a successful switch writes the config only after every check has passed', async () => {
    plantInstall('vulkan');
    await plantModel();
    const calls: string[] = [];
    // The config must still be untouched at the LAST check — that is what
    // "written only after every check passes" means, and a write placed one
    // line too early leaves a user switched to a build that then failed its
    // load. Sampled inside the two checks themselves, not before them.
    let backendAtBoot: string | null = null;
    let backendAtLoad: string | null = null;
    const fetchImpl = (async (url: any) => {
      calls.push(String(url));
      backendAtLoad = readEngineConfig(home).backend ?? null;
      return new Response('{"choices":[{"message":{"content":"hi"}}]}', { status: 200 });
    }) as unknown as typeof fetch;
    const mgr = new EngineManager(home, userData, 9999, { fetchImpl });
    stubDownload(mgr, { devices: [ROCM_DEVICE] });
    vi.spyOn(mgr as unknown as { verifyBoot: () => Promise<void> }, 'verifyBoot')
      .mockImplementation(async () => { backendAtBoot = readEngineConfig(home).backend ?? null; });

    await expect(mgr.setBackend('rocm')).resolves.toBeUndefined();
    expect(backendAtBoot).not.toBe('rocm');
    expect(backendAtLoad).not.toBe('rocm');
    expect(calls).toEqual(['http://127.0.0.1:9999/v1/chat/completions']);
    expect(readEngineConfig(home).backend).toBe('rocm');
  });
});

// The pure halves of the rules above, exercised directly — the orchestration
// tests drive them through a stubbed download, so these are what pin the
// wording and the classification themselves.
describe('setBackend rules', () => {
  it('reads devicesError BEFORE the device list', () => {
    // Both are the "empty list" shape; only the error tells them apart.
    expect(backendDeviceRefusal('rocm', [], 'boom')).toBe(
      'Kept the current engine: the ROCm build could not be asked which graphics chip it would use — "boom". Nothing was changed.'
    );
    expect(backendDeviceRefusal('rocm', [], undefined)).toBe(
      'Kept the current engine: the ROCm build found no graphics chip it can use — it reported no devices at all. Nothing was changed.'
    );
  });

  it('matches on the engine\'s printed device id prefix, not on our backend name', () => {
    const rocm = [{ backend: 'ROCm0', name: 'AMD Radeon Graphics', totalMiB: 1, freeMiB: 1, isGpu: true }];
    const cuda = [{ backend: 'CUDA0', name: 'NVIDIA GeForce RTX 4090', totalMiB: 1, freeMiB: 1, isGpu: true }];
    expect(backendDeviceRefusal('rocm', rocm, undefined)).toBeNull();
    expect(backendDeviceRefusal('cuda', cuda, undefined)).toBeNull();
    // …and each build refuses the other's device.
    expect(backendDeviceRefusal('cuda', rocm, undefined)).toContain('found no graphics chip');
    expect(backendDeviceRefusal('rocm', cuda, undefined)).toContain('found no graphics chip');
  });

  it('never refuses a build whose CPU fallback is by design', () => {
    // install() RELIES on Vulkan falling back to the processor. Refusing it
    // here would break first install on every machine without a graphics card.
    for (const b of ['vulkan', 'cpu', 'metal'] as const) {
      expect(backendDeviceRefusal(b, [], 'anything at all')).toBeNull();
    }
  });

  it('a marker with no device list is "we could not ask", never "you have no chip"', () => {
    expect(backendDeviceRefusal('rocm', undefined, undefined)).toBe(
      'Kept the current engine: the ROCm build could not be asked which graphics chip it would use — it recorded no device list. Nothing was changed.'
    );
  });

  it('separates a build that cannot run on this chip from a model that cannot be read', () => {
    for (const deviceClass of [
      'HIP error: no kernel image is available for execution on the device',
      'CUDA error: invalid device function',
      'hipErrorNoBinaryForGpu',
      'ggml_cuda_compute_forward: ROCm error: invalid configuration argument',
    ]) expect(isDeviceClassLoadError(deviceClass)).toBe(true);

    for (const modelClass of [
      "failed to load model: unknown model architecture 'qwen4exp'",
      'llama_model_load: error loading model: invalid split file',
      'failed to allocate buffer of size 12884901888',
    ]) expect(isDeviceClassLoadError(modelClass)).toBe(false);
  });

  it("catches every vendor's spelling of a device error, not just CUDA's", () => {
    // ggml stamps each checked GPU failure with its backend's name, and that
    // name is not always 'CUDA' — T2's own device ids are the in-repo proof
    // (`ROCm0`, not `CUDA0`; the same upstream rename). Listing only CUDA's
    // spelling would let a real ROCm failure through as a model problem, keep
    // the switch, and blame the user's file — on this machine's backend.
    expect(isDeviceClassLoadError('ROCm error: hipErrorNoDevice')).toBe(true);
    expect(isDeviceClassLoadError('HIP error: hipErrorInvalidDevice')).toBe(true);
    expect(isDeviceClassLoadError('CUDA error: an illegal memory access was encountered')).toBe(true);
  });

  it('never blames the hardware for running out of memory, whatever prefix it wears', () => {
    // ggml_cuda_error() prints `CUDA error: <msg>` for EVERY checked failure,
    // out of memory included. Treating that as "found no graphics chip it can
    // use" deletes a perfectly good build and states a cause we never
    // established — which the error-message standard forbids outright.
    for (const oom of [
      'CUDA error: out of memory',
      'ROCm error: out of memory',
      'HIP error: failed to allocate 12 GiB on device 0',
      'cudaMalloc failed: out of memory',
    ]) expect(isDeviceClassLoadError(oom)).toBe(false);
  });

  it('proves the switch with the SMALLEST complete model — a 1-token load reads the whole file', () => {
    const m = (id: string, sizeBytes: number | null) => ({ id, sizeBytes, loaded: false, state: 'unloaded' as const });
    expect(smallestCompleteModel([m('big', 30_000), m('small', 900), m('mid', 4_000)])?.id).toBe('small');
    expect(smallestCompleteModel([])).toBeNull();
    // A row with no size cannot be compared; it is never the answer while a
    // measurable one exists, and never invented into one when it does not.
    expect(smallestCompleteModel([m('unknown', null)])).toBeNull();
  });

  it('quotes the router\'s own message, and says only the status when there is none', () => {
    expect(routerErrorText(500, '{"error":{"message":"no kernel image"}}')).toBe('no kernel image');
    expect(routerErrorText(400, '{"message":"model not found"}')).toBe('model not found');
    expect(routerErrorText(502, '<html><body>Bad gateway</body></html>\nmore'))
      .toBe('<html><body>Bad gateway</body></html>');
    expect(routerErrorText(503, '   ')).toBe('the engine answered HTTP 503 with no message');
  });
});
