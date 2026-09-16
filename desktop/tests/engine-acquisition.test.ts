import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import {
  EngineAcquisition, parseDeviceList, isGpuDeviceName, firstGpuDevice,
} from '../src/main/engine/engine-acquisition';
import { ENGINE_VERSION } from '../src/main/engine/engine-pin';
import type { EngineAsset } from '../src/main/engine/engine-pin';
import type { EngineInstallProgress } from '../src/shared/engine-types';

let tmp: string;
let engineRoot: string;
let archivePath: string;
let asset: EngineAsset;

// Same reasoning as production's systemTar(): on Windows a bare `tar` on PATH
// resolves to Git's GNU tar, which reads the colon in `C:\...` as an rsh
// host:path and can't create/read archives at Windows paths. System32 bsdtar
// (libarchive) handles them. Use it for the fixture builder too.
const TAR_BIN = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar';

// ASSERT THE EXACT MESSAGE, not a substring, wherever a failure has more than
// one route to it. Measured here on 2026-09-05: the unkillable-probe test used
// `toMatch(/did not answer/)` and stayed GREEN when killSignal was reverted to
// SIGTERM — the mutation this test exists to catch — because the outer deadline
// produced a DIFFERENT sentence that the loose matcher also accepted. The test
// looked protective and was not. Only `toBe('…did not answer within 0.25s')`
// went red. Same reasoning applies to devicesError generally: "no device list"
// and "the probe could not run" must never be allowed to satisfy one assertion.

// The `--list-devices` block EXACTLY as the pinned b10665 binary prints it on
// this machine (captured 2026-09-05 by running it read-only), so the parser is
// written against reality rather than a guess at the format.
const REAL_ONE_GPU = [
  'Available devices:',
  '  Vulkan0: AMD Radeon 8060S Graphics (RADV STRIX_HALO) (86016 MiB, 83660 MiB free)',
  '',
].join('\n');
// Same binary, same run, with only Mesa's software Vulkan driver visible
// (VK_DRIVER_FILES=lvp_icd + GGML_VK_VISIBLE_DEVICES=0). Note the 124406 MiB:
// that is system RAM, which is why this device must not count as a GPU.
const REAL_LLVMPIPE = [
  'Available devices:',
  '  Vulkan0: llvmpipe (LLVM 22.1.6, 256 bits) (124406 MiB, 80267 MiB free)',
  '',
].join('\n');
// Both drivers at once — the real two-device shape.
const REAL_TWO_DEVICES = [
  'Available devices:',
  '  Vulkan0: AMD Radeon 8060S Graphics (RADV STRIX_HALO) (86016 MiB, 83633 MiB free)',
  '  Vulkan1: llvmpipe (LLVM 22.1.6, 256 bits) (124406 MiB, 80073 MiB free)',
  '',
].join('\n');
// What the same binary prints when it can see nothing (and what a CPU-only
// build prints always).
const REAL_NO_DEVICES = ['Available devices:', '  (none)', ''].join('\n');

const posix = process.platform !== 'win32';

/** A stand-in llama-server: prints `stdout` for any argument. `sideEffect` is
 *  extra shell run first — used to COUNT invocations and to observe whether the
 *  install directory already exists when the probe runs. POSIX only. */
function fakeBinary(stdout: string, sideEffect = ''): string {
  return `#!/bin/sh\n${sideEffect}\ncat <<'YCEOF'\n${stdout}YCEOF\n`;
}

/** Build a real tar.gz containing build/bin/llama-server so the system-tar
 *  unpack path is exercised end to end. */
function makeFixtureArchive(dir: string, script = '#!/bin/sh\necho fake\n', name = 'fixture'): string {
  const stage = path.join(dir, `stage-${name}`);
  fs.mkdirSync(path.join(stage, 'build', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'build', 'bin', 'llama-server'), script);
  const out = path.join(dir, `${name}.tar.gz`);
  execFileSync(TAR_BIN, ['-czf', out, '-C', stage, 'build']);
  return out;
}

/** A second archive standing in for the CUDA runtime zip: a flat payload that
 *  must land NEXT TO the binary, not in a sibling directory. */
function makeRuntimeArchive(dir: string): string {
  const stage = path.join(dir, 'stage-runtime');
  fs.mkdirSync(path.join(stage, 'build', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'build', 'bin', 'cudart64_12.dll'), 'x'.repeat(4096));
  const out = path.join(dir, 'runtime.tar.gz');
  execFileSync(TAR_BIN, ['-czf', out, '-C', stage, 'build']);
  return out;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** fetch mock streaming the fixture file, honoring Range requests. */
function fetchServing(file: string): typeof fetch {
  return (async (_url: any, init?: any) => {
    const buf = fs.readFileSync(file);
    if (init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': String(buf.length) } });
    }
    const range = init?.headers?.Range as string | undefined;
    let start = 0;
    if (range) start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
    if (start >= buf.length) return new Response(null, { status: 416 });
    const body = buf.subarray(start);
    return new Response(new Blob([body]).stream(), {
      status: start > 0 ? 206 : 200,
      headers: { 'content-length': String(body.length) },
    });
  }) as typeof fetch;
}

/** fetch mock that serves a DIFFERENT file per asset name, so the two-archive
 *  install is exercised for real. `noLength` drops Content-Length from the HEAD
 *  answer for that asset — the "size unknown" path. */
function fetchServingMany(files: Record<string, string>, noLength: string[] = []): typeof fetch {
  return (async (url: any, init?: any) => {
    const name = Object.keys(files).find((n) => String(url).includes(n));
    if (!name) return new Response(null, { status: 404 });
    const buf = fs.readFileSync(files[name]);
    if (init?.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: noLength.includes(name) ? {} : { 'content-length': String(buf.length) },
      });
    }
    const range = init?.headers?.Range as string | undefined;
    let start = 0;
    if (range) start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
    if (start >= buf.length) return new Response(null, { status: 416 });
    const body = buf.subarray(start);
    return new Response(new Blob([body]).stream(), {
      status: start > 0 ? 206 : 200,
      headers: { 'content-length': String(body.length) },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-acq-'));
  engineRoot = path.join(tmp, 'engine');
  archivePath = makeFixtureArchive(tmp);
  asset = {
    platform: 'linux', arch: 'x64', backend: 'cpu',
    assetName: `llama-${ENGINE_VERSION}-bin-test-x64.tar.gz`,
    sha256: sha256(archivePath),
    binaryRelPath: path.join('build', 'bin', 'llama-server'),
  };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));

describe('EngineAcquisition', () => {
  it('installs: downloads, verifies, unpacks, writes .complete LAST, reports progress', async () => {
    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath));
    const events: EngineInstallProgress[] = [];
    const installed = await acq.install(asset, (p) => events.push(p));

    expect(fs.existsSync(installed.binaryPath)).toBe(true);
    expect(installed.version).toBe(ENGINE_VERSION);
    expect(installed.backend).toBe('cpu');
    const marker = JSON.parse(fs.readFileSync(path.join(installed.dir, '.complete'), 'utf8'));
    expect(marker.binaryRelPath).toBe(asset.binaryRelPath);
    expect(events.some((e) => e.kind === 'download')).toBe(true);
    expect(events.map((e) => e.kind)).toContain('verify');
    expect(events[events.length - 1]).toEqual({ kind: 'done', version: ENGINE_VERSION, backend: 'cpu' });
    expect(fs.readdirSync(engineRoot).filter((f) => f.endsWith('.download'))).toEqual([]);
  });

  it('installed() finds the usable install and returns null when the binary vanished', async () => {
    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath));
    const installed = await acq.install(asset, () => {});
    expect(acq.installed()?.dir).toBe(installed.dir);
    fs.rmSync(installed.binaryPath);
    expect(acq.installed()).toBeNull();
  });

  it('installed(preferBackend) prefers the matching backend when two builds of the same version coexist', async () => {
    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath));
    // Install the cpu build the normal way.
    await acq.install(asset, () => {});
    // Plant a SECOND usable install of the same version, backend 'vulkan',
    // by hand (simulating a fallback that left both dirs behind).
    const vulkanDir = acq.installDir(ENGINE_VERSION, 'vulkan');
    const vbin = path.join(vulkanDir, 'build', 'bin', 'llama-server');
    fs.mkdirSync(path.dirname(vbin), { recursive: true });
    fs.writeFileSync(vbin, 'fake');
    fs.writeFileSync(path.join(vulkanDir, '.complete'),
      JSON.stringify({ version: ENGINE_VERSION, backend: 'vulkan', binaryRelPath: path.join('build', 'bin', 'llama-server') }));
    expect(acq.installed('cpu')?.backend).toBe('cpu');
    expect(acq.installed('vulkan')?.backend).toBe('vulkan');
    // No preference → still returns a usable pinned-version install (either backend).
    expect(acq.installed()).not.toBeNull();
  });

  it('REFUSES a checksum mismatch and deletes the bad download', async () => {
    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath));
    const bad = { ...asset, sha256: '0'.repeat(64) };
    await expect(acq.install(bad, () => {})).rejects.toThrow(/integrity check/);
    expect(acq.installed()).toBeNull();
    expect(fs.existsSync(path.join(engineRoot, `${asset.assetName}.download`))).toBe(false);
  });

  it('resumes a partial download via a Range request', async () => {
    fs.mkdirSync(engineRoot, { recursive: true });
    const full = fs.readFileSync(archivePath);
    fs.writeFileSync(path.join(engineRoot, `${asset.assetName}.download`), full.subarray(0, 10));
    const fetchImpl = fetchServing(archivePath);
    const acq = new EngineAcquisition(engineRoot, fetchImpl);
    const installed = await acq.install(asset, () => {});
    expect(fs.existsSync(installed.binaryPath)).toBe(true);
  });

  it('never leaves a half-unpacked dir marked usable when the archive lacks the binary', async () => {
    const stage = path.join(tmp, 'empty-stage'); fs.mkdirSync(path.join(stage, 'build'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'build', 'README'), 'nope');
    const emptyArchive = path.join(tmp, 'empty.tar.gz');
    execFileSync(TAR_BIN, ['-czf', emptyArchive, '-C', stage, 'build']);
    const badAsset = { ...asset, sha256: sha256(emptyArchive) };
    const acq = new EngineAcquisition(engineRoot, fetchServing(emptyArchive));
    await expect(acq.install(badAsset, () => {})).rejects.toThrow(/did not contain/);
    expect(acq.installed()).toBeNull();
  });

  it('a write-stream failure rejects the install cleanly (never an unhandled crash)', async () => {
    fs.mkdirSync(engineRoot, { recursive: true });
    // Plant a DIRECTORY where the .download file must be written → the write
    // stream errors (EISDIR/EPERM). The install must reject, not throw an
    // unhandled stream 'error' that would crash the main process.
    fs.mkdirSync(path.join(engineRoot, `${asset.assetName}.download`), { recursive: true });
    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath));
    await expect(acq.install(asset, () => {})).rejects.toThrow();
    expect(acq.installed()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The device list (design §A2). These are what later tells the user how much
// graphics memory a model has to fit into, so every failure shape has to come
// back honest rather than as a confident zero.
// ---------------------------------------------------------------------------

describe('parseDeviceList — against the real b10665 output', () => {
  it('reads the id, the name (parentheses and all) and both memory numbers', () => {
    expect(parseDeviceList(REAL_ONE_GPU)).toEqual([{
      backend: 'Vulkan0',
      name: 'AMD Radeon 8060S Graphics (RADV STRIX_HALO)',
      totalMiB: 86016, freeMiB: 83660, isGpu: true,
    }]);
  });

  it('classifies llvmpipe as CPU, not GPU — its 124406 MiB "VRAM" is system RAM', () => {
    const devices = parseDeviceList(REAL_LLVMPIPE)!;
    expect(devices).toHaveLength(1);
    expect(devices[0].name).toContain('llvmpipe');
    expect(devices[0].isGpu).toBe(false);
    // …and nothing downstream may take it for the graphics pool.
    expect(firstGpuDevice(devices)).toBeNull();
  });

  it('classifies SwiftShader as CPU too', () => {
    expect(isGpuDeviceName('SwiftShader Device (Subzero)')).toBe(false);
    expect(isGpuDeviceName('AMD Radeon 8060S Graphics (RADV STRIX_HALO)')).toBe(true);
  });

  it('keeps several devices in order and picks the first REAL gpu', () => {
    const devices = parseDeviceList(REAL_TWO_DEVICES)!;
    expect(devices.map((d) => d.backend)).toEqual(['Vulkan0', 'Vulkan1']);
    expect(devices.map((d) => d.isGpu)).toEqual([true, false]);
    expect(firstGpuDevice(devices)!.totalMiB).toBe(86016);
  });

  it('"(none)" is an EMPTY list, and unreadable output is NULL — never the same answer', () => {
    expect(parseDeviceList(REAL_NO_DEVICES)).toEqual([]);
    expect(parseDeviceList('error while handling argument "--list-devices"')).toBeNull();
    expect(parseDeviceList('')).toBeNull();
  });

  it('stops at the first unindented line, so a trailing note is not filed as a device', () => {
    const out = [
      'Available devices:',
      '  Vulkan0: AMD Radeon 8060S Graphics (RADV STRIX_HALO) (86016 MiB, 83660 MiB free)',
      'note: built with RPC support',
      '  rpc: some later section',
      '',
    ].join('\n');
    expect(parseDeviceList(out)!.map((d) => d.backend)).toEqual(['Vulkan0']);
  });

  it('a device line in an unknown shape keeps its name and reports NO memory (never 0)', () => {
    const devices = parseDeviceList('Available devices:\n  SYCL0: Some Future Device\n')!;
    expect(devices).toEqual([
      { backend: 'SYCL0', name: 'Some Future Device', totalMiB: null, freeMiB: null, isGpu: true },
    ]);
  });
});

describe('EngineAcquisition — scratch and in-progress directories', () => {
  it('never adopts a half-finished `.unpacking` directory as an install', () => {
    const partial = path.join(engineRoot, `${ENGINE_VERSION}-cpu.unpacking`);
    const bin = path.join(partial, 'build', 'bin', 'llama-server');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, 'fake');
    // A real, valid marker — this directory IS complete for the instant before
    // the rename. It still must not be picked up.
    fs.writeFileSync(path.join(partial, '.complete'), JSON.stringify({
      version: ENGINE_VERSION, backend: 'cpu', binaryRelPath: path.join('build', 'bin', 'llama-server'),
    }));
    expect(new EngineAcquisition(engineRoot, fetchServing(archivePath)).installed()).toBeNull();
  });

  it('sweeps scratch downloads a previous failed install stranded, keeping the one it can resume', async () => {
    fs.mkdirSync(engineRoot, { recursive: true });
    // What a failed CUDA attempt on an older pin leaves behind.
    const stale = path.join(engineRoot, 'llama-b9992-bin-win-cuda-12.4-x64.zip.download');
    fs.writeFileSync(stale, 'x'.repeat(1024));
    // …and a partial of the archive this install is about to fetch, which must
    // survive so the download resumes instead of restarting.
    const mine = path.join(engineRoot, `${asset.assetName}.download`);
    fs.writeFileSync(mine, fs.readFileSync(archivePath).subarray(0, 10));

    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath));
    await acq.install(asset, () => {});
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readdirSync(engineRoot).filter((f) => f.endsWith('.download'))).toEqual([]);
  });
});

describe('EngineAcquisition — the runtime archive (design §A2)', () => {
  it('downloads the runtime, verifies it, and unpacks it into the SAME directory as the engine', async () => {
    const runtime = makeRuntimeArchive(tmp);
    const acq = new EngineAcquisition(
      engineRoot,
      fetchServingMany({ [asset.assetName]: archivePath, 'cudart-fixture.tar.gz': runtime }),
    );
    const withRuntime = {
      ...asset,
      runtime: { assetName: 'cudart-fixture.tar.gz', sha256: sha256(runtime) },
    };
    const installed = await acq.install(withRuntime, () => {});
    // Beside the binary, not in a sibling dir — that is what makes the Windows
    // CUDA build able to load its runtime at all.
    expect(fs.existsSync(path.join(installed.dir, 'build', 'bin', 'cudart64_12.dll'))).toBe(true);
    expect(fs.existsSync(installed.binaryPath)).toBe(true);
    // Both scratch downloads cleaned up.
    expect(fs.readdirSync(engineRoot).filter((f) => f.endsWith('.download'))).toEqual([]);
  });

  it('reports ONE download stream whose total is the SUM of both archives, from the first event', async () => {
    const runtime = makeRuntimeArchive(tmp);
    const sum = fs.statSync(archivePath).size + fs.statSync(runtime).size;
    const acq = new EngineAcquisition(
      engineRoot,
      fetchServingMany({ [asset.assetName]: archivePath, 'cudart-fixture.tar.gz': runtime }),
    );
    const events: EngineInstallProgress[] = [];
    await acq.install(
      { ...asset, runtime: { assetName: 'cudart-fixture.tar.gz', sha256: sha256(runtime) } },
      (p) => events.push(p),
    );
    const downloads = events.filter((e) => e.kind === 'download') as
      Extract<EngineInstallProgress, { kind: 'download' }>[];
    // The very first event already knows the whole size — a caller can say
    // "611 MB" before a byte moves, instead of doubling the number halfway.
    expect(downloads[0].totalBytes).toBe(sum);
    expect(downloads.every((d) => d.totalBytes === sum)).toBe(true);
    // Received bytes never go backwards when the second archive starts, and
    // finish at the total.
    const received = downloads.map((d) => d.receivedBytes);
    expect(received).toEqual([...received].sort((a, b) => a - b));
    expect(received[received.length - 1]).toBe(sum);
  });

  it('probeDownloadSize sums both archives, and says null rather than a partial sum', async () => {
    const runtime = makeRuntimeArchive(tmp);
    const rt = { assetName: 'cudart-fixture.tar.gz', sha256: sha256(runtime) };
    const files = { [asset.assetName]: archivePath, 'cudart-fixture.tar.gz': runtime };
    const sum = fs.statSync(archivePath).size + fs.statSync(runtime).size;

    const ok = new EngineAcquisition(engineRoot, fetchServingMany(files));
    expect((await ok.probeDownloadSize({ ...asset, runtime: rt })).totalBytes).toBe(sum);

    // One size unreadable → the whole answer is "unknown". Half a sum shown as
    // a whole would understate the download the user is agreeing to.
    const blind = new EngineAcquisition(engineRoot, fetchServingMany(files, ['cudart-fixture.tar.gz']));
    const partial = await blind.probeDownloadSize({ ...asset, runtime: rt });
    expect(partial.totalBytes).toBeNull();
    expect(partial.parts.map((p) => p.bytes !== null)).toEqual([true, false]);
  });

  it('REFUSES a runtime whose checksum is wrong, installs nothing, and KEEPS the good engine archive', async () => {
    const runtime = makeRuntimeArchive(tmp);
    const files = { [asset.assetName]: archivePath, 'cudart-fixture.tar.gz': runtime };
    const log: string[] = [];
    const inner = fetchServingMany(files);
    const counting = (async (url: any, init?: any) => {
      log.push(`${init?.method ?? 'GET'} ${String(url).split('/').pop()}`);
      return inner(url, init);
    }) as typeof fetch;
    const acq = new EngineAcquisition(engineRoot, counting);

    await expect(acq.install(
      { ...asset, backend: 'cuda', runtime: { assetName: 'cudart-fixture.tar.gz', sha256: '0'.repeat(64) } },
      () => {},
    )).rejects.toThrow('The CUDA runtime files failed their integrity check — please try installing again.');
    expect(acq.installed()).toBeNull();
    // The corrupt one is gone; the engine archive, which passed its OWN
    // checksum, is kept — it is 239 MB of the user's connection in the real
    // case, and the retry below reuses it.
    expect(fs.readdirSync(engineRoot).filter((f) => f.endsWith('.download')))
      .toEqual([`${asset.assetName}.download`]);

    log.length = 0;
    await acq.install(
      { ...asset, backend: 'cuda', runtime: { assetName: 'cudart-fixture.tar.gz', sha256: sha256(runtime) } },
      () => {},
    );
    // The retry asks the server how big the engine archive is and then does NOT
    // fetch it. Before this, a complete file was Range-requested, answered 416,
    // deleted and pulled again from byte zero.
    expect(log).not.toContain(`GET ${asset.assetName}`);
    expect(log).toContain('GET cudart-fixture.tar.gz');
    expect(acq.installed()).not.toBeNull();
  });
});

describe.skipIf(!posix)('EngineAcquisition — devices in the marker (design §A2)', () => {
  it('runs --list-devices on the unpacked binary and writes the devices BEFORE the rename', async () => {
    const finalDir = path.join(engineRoot, `${ENGINE_VERSION}-cpu`);
    const sawFinalDir = path.join(tmp, 'saw-final-dir');
    // The probe records whether the install directory was already in place when
    // it ran. It must NOT be: the whole point of probing inside `.unpacking` is
    // that no half-described install is ever visible.
    const probeArchive = makeFixtureArchive(
      tmp,
      fakeBinary(REAL_ONE_GPU, `[ -e "${finalDir}" ] && echo yes > "${sawFinalDir}"`),
      'probe',
    );
    const acq = new EngineAcquisition(engineRoot, fetchServing(probeArchive));
    const installed = await acq.install({ ...asset, sha256: sha256(probeArchive) }, () => {});

    expect(fs.existsSync(sawFinalDir)).toBe(false);
    const marker = JSON.parse(fs.readFileSync(path.join(installed.dir, '.complete'), 'utf8'));
    expect(marker.devices).toEqual([{
      backend: 'Vulkan0',
      name: 'AMD Radeon 8060S Graphics (RADV STRIX_HALO)',
      totalMiB: 86016, freeMiB: 83660, isGpu: true,
    }]);
    expect(marker.devicesError).toBeUndefined();
    expect(installed.devices).toEqual(marker.devices);
  });

  it('a binary that cannot answer records WHY, and still installs', async () => {
    // The default fixture binary prints "fake" — no device block at all.
    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath));
    const installed = await acq.install(asset, () => {});
    const marker = JSON.parse(fs.readFileSync(path.join(installed.dir, '.complete'), 'utf8'));
    expect(marker.devices).toEqual([]);
    expect(marker.devicesError).toMatch(/--list-devices/);
    // An engine that will not enumerate devices may still run models, so the
    // install stands.
    expect(acq.installed()?.dir).toBe(installed.dir);
  });

  // The SECOND mechanism, on its own. Before the seam existed this was
  // untestable: a child that survives SIGKILL needs an uninterruptible kernel
  // call, which no fixture can stage. With the caps injectable it is trivial —
  // push the child timeout out of reach and the outer deadline becomes the ONLY
  // thing that can end the wait, so if the race is ever deleted this test hangs
  // until vitest kills it.
  const UNREACHABLE = { timeoutMs: 60_000, deadlineMs: 300 };

  it('the outer deadline alone ends the wait when the child cap cannot', async () => {
    const hang = makeFixtureArchive(
      tmp, "#!/bin/sh\ntrap '' TERM\nwhile true; do sleep 1; done\n", 'hang2',
    );
    const acq = new EngineAcquisition(engineRoot, fetchServing(hang), undefined, UNREACHABLE);
    const started = Date.now();
    const installed = await acq.install({ ...asset, sha256: sha256(hang) }, () => {});
    const took = Date.now() - started;
    const marker = JSON.parse(fs.readFileSync(path.join(installed.dir, '.complete'), 'utf8'));
    // Exact again, and deliberately the OTHER sentence: this one says the
    // process outlived the kill, which is a different thing to tell a reader
    // than "the engine took too long".
    expect(marker.devicesError)
      .toBe(`llama-server --list-devices did not answer within ${UNREACHABLE.deadlineMs / 1000}s and would not stop`);
    expect(marker.devices).toEqual([]);
    // It really used the OVERRIDDEN deadline, not the production one. Measured
    // as a wide band, not a tight one — this separates 0.3s from 17s, which is
    // all it needs to do, and is not a wall-clock budget assertion.
    expect(took).toBeLessThan(5_000);
  });
});

describe.skipIf(!posix)('EngineAcquisition — a probe that will not stop', () => {
  // The cap exists for a binary wedged in a driver call. That is precisely the
  // case where a catchable signal does nothing, so a SIGTERM-only cap would
  // leave install() unsettled forever behind a frozen progress bar. This binary
  // ignores SIGTERM the way a wedged one effectively does.
  //
  // Driven through the production seam at 1/60th of the real numbers: what is
  // under test is the MECHANISM (an untrappable kill, plus an outer deadline in
  // case even that cannot reap it), not the wall-clock size of the cap. At the
  // real 15s this test cost 15s of every `vitest related` run on a subsystem
  // still being changed daily — and a slow suite is how a suite stops being run.
  // 250ms is ~1000x the time `sh` needs to install its trap, so the child is
  // always wedged before the cap fires.
  const PROBE = { timeoutMs: 250, deadlineMs: 750 };

  it('gives up on an unkillable --list-devices and installs anyway, saying why', async () => {
    const hang = makeFixtureArchive(
      tmp, "#!/bin/sh\ntrap '' TERM\nwhile true; do sleep 1; done\n", 'hang',
    );
    const acq = new EngineAcquisition(engineRoot, fetchServing(hang), undefined, PROBE);
    const started = Date.now();
    const installed = await acq.install({ ...asset, sha256: sha256(hang) }, () => {});
    const took = Date.now() - started;

    const marker = JSON.parse(fs.readFileSync(path.join(installed.dir, '.complete'), 'utf8'));
    expect(marker.devices).toEqual([]);
    // EXACT string — see the note at the top of this file. The two escape
    // hatches say different things and only one of them means the child was
    // really killed: this is the child-timeout message, while the outer deadline
    // says "…and would not stop".
    expect(marker.devicesError).toBe(`llama-server --list-devices did not answer within ${PROBE.timeoutMs / 1000}s`);
    // It returned on its own rather than hanging, and the install still stands.
    // Generous: the assertion is "it stopped", not "it stopped in exactly Xms".
    expect(took).toBeLessThan(PROBE.deadlineMs * 8);
    expect(acq.installed()?.dir).toBe(installed.dir);
  });
});

describe.skipIf(!posix)('EngineAcquisition — the lazy backfill (design §A2)', () => {
  /** Plant an install the way the app looked BEFORE this feature: a valid
   *  marker with no `devices` key at all. */
  function plantOldInstall(counter?: string): string {
    const dir = path.join(engineRoot, `${ENGINE_VERSION}-cpu`);
    const bin = path.join(dir, 'build', 'bin', 'llama-server');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, fakeBinary(REAL_ONE_GPU, counter ? `echo x >> "${counter}"` : ''), { mode: 0o755 });
    fs.writeFileSync(path.join(dir, '.complete'), JSON.stringify({
      version: ENGINE_VERSION, backend: 'cpu', binaryRelPath: path.join('build', 'bin', 'llama-server'),
    }));
    return dir;
  }

  it('fills in a pre-feature marker on the first read, and tells the caller', async () => {
    const dir = plantOldInstall();
    let notified = 0;
    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath), () => { notified++; });

    // The first read is synchronous and still knows nothing — status() must not
    // be made to wait on a spawned process.
    expect(acq.installed()?.devices).toBeUndefined();
    await vi.waitFor(() => {
      const m = JSON.parse(fs.readFileSync(path.join(dir, '.complete'), 'utf8'));
      expect(m.devices?.[0]?.name).toBe('AMD Radeon 8060S Graphics (RADV STRIX_HALO)');
    });
    expect(notified).toBe(1);
    // …and the next read serves it straight from the marker.
    expect(acq.installed()?.devices?.[0]?.totalMiB).toBe(86016);
  });

  it('spawns the binary ONCE even when several reads race, and never again after', async () => {
    const counter = path.join(tmp, 'spawns');
    const dir = plantOldInstall(counter);
    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath));
    // status() is called on every engine event; three at once is normal.
    acq.installed(); acq.installed(); acq.installed();
    await vi.waitFor(() => {
      expect(JSON.parse(fs.readFileSync(path.join(dir, '.complete'), 'utf8')).devices).toBeDefined();
    });
    for (let i = 0; i < 5; i++) acq.installed();
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('pressing Install on the build you ALREADY run still leaves a device list behind', async () => {
    // The idempotent early return: install() finds a usable marker and hands it
    // straight back. A pre-feature install reaching this path must still end up
    // with devices, or the post-install check (design §A4) has nothing to read.
    const dir = plantOldInstall();
    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath));
    const again = await acq.install(asset, () => {});
    expect(again.dir).toBe(dir);
    expect(again.devices?.[0]?.totalMiB).toBe(86016);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.complete'), 'utf8')).devices).toHaveLength(1);
  });

  it('a one-off probe failure does not pin a permanent refusal on the install', async () => {
    // The device check (design §A4) REFUSES a GPU build whose marker carries a
    // devicesError, quoting it. Nothing re-probes a directory that already has
    // a `devices` key, so without this a single fifteen-second timeout — a busy
    // driver, a loaded machine — would make that refusal unclearable for the
    // life of the install, in words that stopped being true minutes later.
    const dir = path.join(engineRoot, `${ENGINE_VERSION}-cpu`);
    const bin = path.join(dir, 'build', 'bin', 'llama-server');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, fakeBinary(REAL_ONE_GPU), { mode: 0o755 });   // it answers fine NOW
    fs.writeFileSync(path.join(dir, '.complete'), JSON.stringify({
      version: ENGINE_VERSION, backend: 'cpu', binaryRelPath: path.join('build', 'bin', 'llama-server'),
      devices: [], devicesError: 'llama-server --list-devices did not answer within 15s',
    }));

    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath));
    const again = await acq.install(asset, () => {});
    expect(again.dir).toBe(dir);
    expect(again.devices?.[0]?.name).toBe('AMD Radeon 8060S Graphics (RADV STRIX_HALO)');
    // The stale error must go WITH the re-probe, or the pair keeps saying "we
    // don't know" over a list we now have.
    expect(again.devicesError).toBeUndefined();
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.complete'), 'utf8'));
    expect(marker.devicesError).toBeUndefined();
    expect(marker.devices).toHaveLength(1);
  });

  it('install() JOINS a backfill status() already started, instead of returning before it finished', async () => {
    // The shipping order: status() runs on every engine event, so by the time
    // the user presses Install the background backfill is nearly always already
    // in flight. A single-flight guard that only records "claimed" would let
    // this await return instantly and hand back devices: undefined.
    const dir = plantOldInstall();
    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath));
    acq.installed();                       // starts the backfill
    const again = await acq.install(asset, () => {});
    expect(again.dir).toBe(dir);
    expect(again.devices?.[0]?.totalMiB).toBe(86016);
  });

  it('a binary that cannot answer is retried NEVER, and records the real reason', async () => {
    const dir = path.join(engineRoot, `${ENGINE_VERSION}-cpu`);
    const bin = path.join(dir, 'build', 'bin', 'llama-server');
    const counter = path.join(tmp, 'bad-spawns');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin,
      `#!/bin/sh\necho x >> "${counter}"\necho "libamdhip64.so.7: cannot open shared object file" >&2\nexit 1\n`,
      { mode: 0o755 });
    fs.writeFileSync(path.join(dir, '.complete'), JSON.stringify({
      version: ENGINE_VERSION, backend: 'cpu', binaryRelPath: path.join('build', 'bin', 'llama-server'),
    }));
    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath));
    acq.installed();
    await vi.waitFor(() => {
      const m = JSON.parse(fs.readFileSync(path.join(dir, '.complete'), 'utf8'));
      // The engine's OWN words, not a guess at the cause.
      expect(m.devicesError).toContain('libamdhip64.so.7: cannot open shared object file');
      expect(m.devices).toEqual([]);
    });
    for (let i = 0; i < 5; i++) acq.installed();
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
