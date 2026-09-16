// Voice asset acquisition (src/main/voice/voice-assets.ts).
//
// What this file is defending, in plain words:
//   1. A folder that was only half-unpacked is NEVER reported as ready.
//   2. A download whose fingerprint is wrong says exactly what it expected and
//      exactly what it got — in BOTH fingerprint shapes, because npm publishes
//      SHA-512/base64 and the model release publishes SHA-256/hex.
//   3. If an archive stops containing the file voice-pin.ts says it contains,
//      the install fails loudly instead of leaving a directory that cannot load.
//   4. The progress the card renders reaches "unpacking" BEFORE "ready".
//
//   5. Nothing in the install runs another program — no `tar`, no `bzip2`. The
//      npm tarballs are un-gzipped and un-tarred in process, and the model's
//      four files arrive as they are. That is what makes the install behave the
//      same on the two platforms this machine cannot test.
//
// Nothing here downloads anything: fetch is stubbed with real (tiny) archives
// built on the fly. The .tgz fixtures ARE real gzipped tars, so the unpacker is
// exercised for real rather than mocked away.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { execFileSync } from 'child_process';

// The fixture pins, built fresh for each test. `vi.hoisted` because the mock
// factory below is hoisted above every import, but the archives (and therefore
// their real digests) cannot exist until beforeEach has run — so the mock reads
// them through getters instead of capturing values.
const fixtures = vi.hoisted(() => ({
  runtime: null as any,
  wrappers: null as any,
  model: null as any,
  /** Flip to make pickRuntime() answer null, i.e. Windows-on-ARM. */
  unsupported: false,
}));

vi.mock('../src/main/voice/voice-pin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/voice/voice-pin')>();
  return {
    ...actual,
    get VOICE_RUNTIMES() { return [fixtures.runtime]; },
    get VOICE_WRAPPERS() { return fixtures.wrappers; },
    get VOICE_MODEL_FILES() { return fixtures.model.files; },
    get VOICE_MODEL_BYTES() { return fixtures.model.bytes; },
    get VOICE_MODEL_ID() { return fixtures.model.id; },
    get MODEL_REQUIRED_REL_PATHS() { return fixtures.model.requiredRelPaths; },
    pickRuntime: () => (fixtures.unsupported ? null : fixtures.runtime),
    totalDownloadBytes: (r: { bytes: number }) => r.bytes + fixtures.wrappers.bytes + fixtures.model.bytes,
  };
});

import { VoiceAssets } from '../src/main/voice/voice-assets';
import type { VoiceAssetProgress, VoiceFetch } from '../src/main/voice/voice-assets';
import { MODEL_DIR_NAME, SHERPA_VERSION } from '../src/main/voice/voice-pin';

/** A one-file .tgz whose entry is named EXACTLY `name`, traversal and all.
 *
 *  This used to be `tar --transform`, which is GNU-only: macOS ships BSD tar and
 *  Windows ships bsdtar, and both answer "Option --transform is not supported",
 *  so two thirds of the release matrix went red the day this test landed. Writing
 *  the 512-byte header here needs no tar at all, and says out loud what the test
 *  is actually about — an archive entry whose name escapes the folder. */
function tarballWithEntry(name: string, content: string): Buffer {
  const body = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  const put = (text: string, at: number, len: number) => header.write(text.slice(0, len - 1), at, 'utf8');
  const octal = (n: number, at: number, len: number) => put(n.toString(8).padStart(len - 1, '0'), at, len);
  put(name, 0, 100);
  octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
  octal(body.length, 124, 12); octal(Math.floor(Date.now() / 1000), 136, 12);
  header[156] = '0'.charCodeAt(0);            // typeflag: a regular file
  put('ustar', 257, 6); header.write('00', 263);
  // The checksum is computed with its own field read as eight spaces.
  header.fill(0x20, 148, 156);
  let sum = 0; for (const b of header) sum += b;
  put(sum.toString(8).padStart(6, '0'), 148, 7); header[154] = 0; header[155] = 0x20;
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  // Two zero blocks end the archive.
  return zlib.gzipSync(Buffer.concat([header, body, pad, Buffer.alloc(1024)]));
}

const TAR_BIN = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar';

let tmp: string;
let userData: string;
let served: Map<string, string>;

function digestOf(file: string, algo: 'sha256' | 'sha512', encoding: 'hex' | 'base64'): string {
  return crypto.createHash(algo).update(fs.readFileSync(file)).digest(encoding);
}

/** A real .tgz rooted at `package/`, like every npm tarball. */
function makeTgz(dir: string, name: string, files: Record<string, string>): string {
  const stage = path.join(dir, `stage-${name}`);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(stage, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(stage, rel), body);
  }
  const out = path.join(dir, `${name}.tgz`);
  execFileSync(TAR_BIN, ['-czf', out, '-C', stage, 'package']);
  return out;
}

/** One plain model file, served as itself — no archive of any kind. */
function makeModelFile(dir: string, name: string, body: string): string {
  const out = path.join(dir, `model-${name}`);
  fs.writeFileSync(out, body);
  return out;
}

/** fetch stub serving the fixture files by URL, honouring Range resume. */
const fetchServing: VoiceFetch = async (url, init) => {
  const file = served.get(url);
  if (!file) return new Response(null, { status: 404 });
  const buf = fs.readFileSync(file);
  const range = init?.headers?.Range;
  const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
  if (start >= buf.length) return new Response(null, { status: 416 });
  const body = buf.subarray(start);
  return new Response(new Blob([body]).stream(), {
    status: start > 0 ? 206 : 200,
    headers: { 'content-length': String(body.length) },
  });
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-assets-'));
  userData = path.join(tmp, 'userData');
  fixtures.unsupported = false;

  const runtimeTgz = makeTgz(tmp, 'runtime', {
    'package/sherpa-onnx.node': 'not-really-an-addon',
    'package/libonnxruntime.so': 'shared-library',
    'package/package.json': '{"name":"sherpa-onnx-linux-x64"}',
  });
  const wrapperTgz = makeTgz(tmp, 'wrappers', {
    'package/sherpa-onnx.js': 'module.exports = {};',
    'package/non-streaming-asr.js': 'module.exports = {};',
    'package/addon.js': 'module.exports = require("./sherpa-onnx.node");',
    'package/package.json': '{"name":"sherpa-onnx-node","main":"sherpa-onnx.js"}',
  });
  const modelBodies: Record<string, string> = {
    'encoder.int8.onnx': 'encoder', 'decoder.int8.onnx': 'decoder',
    'joiner.int8.onnx': 'joiner', 'tokens.txt': 'tokens',
  };
  const modelPaths = Object.fromEntries(
    Object.entries(modelBodies).map(([name, body]) => [name, makeModelFile(tmp, name, body)]),
  );

  fixtures.runtime = {
    platform: process.platform, arch: process.arch, npmPackage: 'sherpa-onnx-test',
    label: 'the speech runtime',
    url: 'https://registry.test/runtime.tgz',
    // npm's shape: SHA-512 in base64.
    digest: { algo: 'sha512', encoding: 'base64', digest: digestOf(runtimeTgz, 'sha512', 'base64') },
    bytes: fs.statSync(runtimeTgz).size,
    requiredRelPaths: ['package/sherpa-onnx.node'],
  };
  fixtures.wrappers = {
    npmPackage: 'sherpa-onnx-node',
    label: 'the speech runtime',
    url: 'https://registry.test/wrappers.tgz',
    digest: { algo: 'sha512', encoding: 'base64', digest: digestOf(wrapperTgz, 'sha512', 'base64') },
    bytes: fs.statSync(wrapperTgz).size,
    requiredRelPaths: ['package/sherpa-onnx.js', 'package/non-streaming-asr.js', 'package/addon.js'],
  };
  const modelFiles = Object.keys(modelBodies).map((name) => ({
    name,
    url: `https://models.test/${name}`,
    // The model's shape: SHA-256 in hex.
    digest: { algo: 'sha256', encoding: 'hex', digest: digestOf(modelPaths[name], 'sha256', 'hex') },
    bytes: fs.statSync(modelPaths[name]).size,
  }));
  fixtures.model = {
    files: modelFiles,
    bytes: modelFiles.reduce((n, f) => n + f.bytes, 0),
    id: modelFiles[0].digest.digest,
    requiredRelPaths: Object.keys(modelBodies).map((n) => `${MODEL_DIR_NAME}/${n}`),
  };

  served = new Map<string, string>([
    [fixtures.runtime.url, runtimeTgz],
    [fixtures.wrappers.url, wrapperTgz],
    ...modelFiles.map((f) => [f.url, modelPaths[f.name]] as [string, string]),
  ]);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));

describe('VoiceAssets — installing', () => {
  it('downloads both halves, unpacks them, and reports unpacking BEFORE ready', async () => {
    const assets = new VoiceAssets(userData, fetchServing);
    const events: VoiceAssetProgress[] = [];
    const installed = await assets.install((p) => events.push(p));

    // Both halves really landed, at the paths voice-pin.ts promises.
    expect(fs.existsSync(installed.addonPath)).toBe(true);
    expect(fs.existsSync(installed.wrapperEntryPath)).toBe(true);
    expect(fs.readFileSync(path.join(installed.modelDir, 'tokens.txt'), 'utf8')).toBe('tokens');
    // The wrappers were unpacked ON TOP of the runtime, in the same folder —
    // which is what makes their relative require('./sherpa-onnx.node') resolve.
    expect(path.dirname(installed.addonPath)).toBe(path.dirname(installed.wrapperEntryPath));

    // Phase order: downloading… → unpacking → ready, never the other way round.
    const phases = events.map((e) => e.phase);
    expect(phases).toContain('downloading');
    expect(phases.indexOf('unpacking')).toBeGreaterThan(-1);
    expect(phases.indexOf('unpacking')).toBeLessThan(phases.indexOf('ready'));
    expect(phases[phases.length - 1]).toBe('ready');

    // The percentage is over BOTH halves combined and ends at 100.
    const downloads = events.filter((e): e is Extract<VoiceAssetProgress, { phase: 'downloading' }> => e.phase === 'downloading');
    const total = fixtures.runtime.bytes + fixtures.wrappers.bytes + fixtures.model.bytes;
    expect(downloads[0].totalBytes).toBe(total);
    expect(downloads[downloads.length - 1].percent).toBe(100);

    // Scratch and part-files are gone; the markers are in place.
    expect(fs.readdirSync(installed.voiceRoot).sort()).toEqual(['model', 'runtime']);
    expect(assets.installed()).not.toBeNull();
  });

  // WHY: each unpack DELETES its scratch directory on the way in, and every exit
  // deletes both scratch dirs. Two installs racing therefore used to delete each
  // other's work mid-unpack and BOTH fail, leaving the user with no download and a
  // message naming `tar` and a temp path. Found reviewing T2, 2026-09-05.
  it('a second Download while one is running joins it instead of racing it', async () => {
    const assets = new VoiceAssets(userData, fetchServing);
    const [a, b] = await Promise.all([assets.install(() => {}), assets.install(() => {})]);
    // Both callers got a real install, and there is exactly one of everything.
    expect(fs.existsSync(a.addonPath)).toBe(true);
    expect(b.addonPath).toBe(a.addonPath);
    expect(fs.readdirSync(a.voiceRoot).sort()).toEqual(['model', 'runtime']);
    expect(assets.installed()).not.toBeNull();
  });

  // WHY: a crash or a quit between an archive's last byte and its fingerprint check
  // used to cost the whole download again — the resume request 416s, the file is
  // deleted, and it starts from zero. On the real model that is 639 MB.
  it('reuses a part-file that is already complete instead of fetching it again', async () => {
    const assets = new VoiceAssets(userData, fetchServing);
    await assets.install(() => {});               // one clean install to get the bytes
    const served: string[] = [];
    const counting: typeof fetchServing = (url, init) => { served.push(String(url)); return fetchServing(url, init); };

    // Wipe only the unpacked halves, and leave the model's part-files behind, whole.
    const root = assets.paths().voiceRoot;
    fs.mkdirSync(root, { recursive: true });
    for (const f of fixtures.model.files) {
      // The whole file, straight from the same stub the installer would use.
      const whole = Buffer.from(await (await fetchServing(f.url)).arrayBuffer());
      fs.writeFileSync(path.join(root, `${f.name}.download`), whole);
    }
    fs.rmSync(path.join(root, 'model'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'runtime'), { recursive: true, force: true });

    await new VoiceAssets(userData, counting).install(() => {});
    // The runtime halves were fetched; not one model file was, because they
    // were all already here — on the real model that is 639 MB not re-fetched.
    for (const f of fixtures.model.files) {
      expect(served, `${f.name} was fetched again`).not.toContain(f.url);
    }
  });

  it('is idempotent — a second install returns straight away with ready', async () => {
    const assets = new VoiceAssets(userData, fetchServing);
    await assets.install(() => {});
    const events: VoiceAssetProgress[] = [];
    await assets.install((p) => events.push(p));
    expect(events).toEqual([{ phase: 'ready' }]);
  });
});

describe('VoiceAssets — a half-unpacked folder is never ready', () => {
  it('answers null while an unpack is still in its .unpacking scratch folder', () => {
    // Exactly the on-disk state a crash mid-unpack leaves: every file present,
    // but under the scratch name and with no marker. The real folder is absent.
    const scratch = path.join(userData, 'voice', 'runtime.unpacking', 'package');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'sherpa-onnx.node'), 'x');
    expect(new VoiceAssets(userData, fetchServing).installed()).toBeNull();
  });

  it('answers null when the marker is there but a promised file is gone', async () => {
    const assets = new VoiceAssets(userData, fetchServing);
    const installed = await assets.install(() => {});
    expect(assets.installed()).not.toBeNull();
    fs.rmSync(path.join(installed.modelDir, 'encoder.int8.onnx'));
    expect(assets.installed()).toBeNull();
  });

  it('answers null when the marker itself is missing', async () => {
    const assets = new VoiceAssets(userData, fetchServing);
    const installed = await assets.install(() => {});
    fs.rmSync(path.join(path.dirname(path.dirname(installed.addonPath)), '.complete'));
    expect(assets.installed()).toBeNull();
  });

  it('writes the marker with the pinned version, so a pin bump reinstalls', async () => {
    const assets = new VoiceAssets(userData, fetchServing);
    await assets.install(() => {});
    const marker = JSON.parse(
      fs.readFileSync(path.join(userData, 'voice', 'model', '.complete'), 'utf8'),
    );
    expect(marker.sherpaVersion).toBe(SHERPA_VERSION);
    expect(marker.requiredRelPaths).toContain(`${MODEL_DIR_NAME}/tokens.txt`);
  });
});

describe('VoiceAssets — a bad fingerprint names both numbers', () => {
  it('reports the exact mismatch for npm\'s SHA-512/base64 shape', async () => {
    const realDigest = fixtures.runtime.digest.digest;
    const wrong = 'AAAA' + realDigest.slice(4);
    fixtures.runtime.digest = { algo: 'sha512', encoding: 'base64', digest: wrong };

    const assets = new VoiceAssets(userData, fetchServing);
    await expect(assets.install(() => {})).rejects.toThrow(/SHA-512 fingerprint \(base64\)/);
    // Both numbers, spelled out: what was expected and what actually arrived.
    await expect(assets.install(() => {})).rejects.toThrow(new RegExp(escapeRe(wrong)));
    await expect(assets.install(() => {})).rejects.toThrow(new RegExp(escapeRe(realDigest)));
    expect(assets.installed()).toBeNull();
  });

  it('reports the exact mismatch for the model\'s SHA-256/hex shape', async () => {
    // Corrupt the LAST model file, so the three before it have already landed.
    const bad = fixtures.model.files[fixtures.model.files.length - 1];
    const realDigest = bad.digest.digest;
    const wrong = 'dead' + realDigest.slice(4);
    bad.digest = { algo: 'sha256', encoding: 'hex', digest: wrong };

    const assets = new VoiceAssets(userData, fetchServing);
    const events: VoiceAssetProgress[] = [];
    await expect(assets.install((p) => events.push(p))).rejects.toThrow(/SHA-256 fingerprint \(hex\)/);
    const failure = events.find((e) => e.phase === 'error') as Extract<VoiceAssetProgress, { phase: 'error' }>;
    expect(failure.message).toContain(wrong);
    expect(failure.message).toContain(realDigest);
    // The CORRUPT file is discarded — otherwise a retry would "resume" it forever
    // and never recover. Every good part-file is deliberately kept, so a retry
    // does not re-download what already arrived intact.
    const parts = fs.readdirSync(path.join(userData, 'voice')).filter((f) => f.endsWith('.download'));
    expect(parts).not.toContain(`${bad.name}.download`);
    // two runtime archives + the three model files that were fine
    expect(parts).toHaveLength(2 + fixtures.model.files.length - 1);
  });
});

describe('VoiceAssets — a stale pinned layout is caught', () => {
  it('fails with the pinned path when the runtime archive lost its addon', async () => {
    fixtures.runtime.requiredRelPaths = ['package/sherpa-onnx-renamed.node'];
    const assets = new VoiceAssets(userData, fetchServing);
    await expect(assets.install(() => {})).rejects.toThrow(
      /did not contain package\/sherpa-onnx-renamed\.node — the pinned layout in voice-pin\.ts is stale/,
    );
    // And nothing half-installed survives the failure.
    expect(assets.installed()).toBeNull();
    expect(fs.existsSync(path.join(userData, 'voice', 'runtime'))).toBe(false);
    expect(fs.existsSync(path.join(userData, 'voice', 'runtime.unpacking'))).toBe(false);
  });

  it('fails with the pinned path when the model no longer has a file it promised', async () => {
    fixtures.model.requiredRelPaths = [`${MODEL_DIR_NAME}/encoder.fp16.onnx`];
    const assets = new VoiceAssets(userData, fetchServing);
    await expect(assets.install(() => {})).rejects.toThrow(
      /did not contain .*encoder\.fp16\.onnx — the pinned layout in voice-pin\.ts is stale/,
    );
    expect(fs.existsSync(path.join(userData, 'voice', 'model'))).toBe(false);
  });
});

describe('VoiceAssets — a computer voice cannot run on', () => {
  it('says so instead of failing a download nobody could have won', async () => {
    fixtures.unsupported = true;
    const assets = new VoiceAssets(userData, fetchServing);
    const events: VoiceAssetProgress[] = [];
    await expect(assets.install((p) => events.push(p))).rejects.toThrow(/not available on this computer/);
    expect(events).toEqual([{ phase: 'error', message: expect.stringContaining('not available on this computer') }]);
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

describe('the install runs no other program', () => {
  // Destin, 2026-09-05: "we do need to fix the install flow, so users don't have
  // to enter terminal commands or download things externally. Should be
  // seamless." This is that promise, as something a machine checks.
  //
  // WHY it is a source scan and not a behaviour test: the failure it guards
  // against is a future edit reaching for `tar` or `bzip2` again because that is
  // the obvious way to unpack something. Nothing would break HERE — it would
  // break on a stranger's computer that does not have the program, which is
  // exactly the class of bug no test on this machine can see.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'voice', 'voice-assets.ts'), 'utf8',
  );

  it('never reaches for child_process', () => {
    expect(source).not.toMatch(/from 'child_process'/);
    expect(source).not.toMatch(/\b(execFile|execFileSync|spawn|spawnSync|exec)\s*\(/);
  });

  it('names no external unpacking program', () => {
    // In code, that is. The comments explain at length why these are gone.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const program of ['bzip2', 'lbzip2', 'pbzip2', 'tar.exe', 'System32']) {
      expect(code, `${program} is named in voice-assets.ts`).not.toContain(program);
    }
  });

  it('unpacks the npm tarball itself, correctly', async () => {
    // The real proof that dropping `tar` did not drop the unpacking: install
    // against real gzipped tars and read the files back out.
    const assets = new VoiceAssets(userData, fetchServing);
    await assets.install(() => {});
    const runtime = path.join(userData, 'voice', 'runtime', 'package');
    expect(fs.readFileSync(path.join(runtime, 'sherpa-onnx.node'), 'utf8')).toBe('not-really-an-addon');
    expect(fs.readFileSync(path.join(runtime, 'libonnxruntime.so'), 'utf8')).toBe('shared-library');
    // The wrappers were unpacked ON TOP: their package.json wins, which is what
    // makes `require('./sherpa-onnx.node')` resolve with no node_modules around.
    expect(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8')).toContain('sherpa-onnx-node');
  });

  it('refuses an archive that tries to write outside the folder', async () => {
    // A pinned digest says the bytes are the ones that were published; it does
    // not say the publisher meant well. Path traversal is refused regardless.
    const stage = path.join(tmp, 'evil-stage');
    fs.mkdirSync(path.join(stage, 'package'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'package', 'x'), 'x');
    const evil = path.join(tmp, 'evil.tgz');
    fs.writeFileSync(evil, tarballWithEntry('../../escaped', 'x'));

    fixtures.wrappers.url = 'https://registry.test/evil.tgz';
    fixtures.wrappers.digest = { algo: 'sha512', encoding: 'base64', digest: digestOf(evil, 'sha512', 'base64') };
    fixtures.wrappers.bytes = fs.statSync(evil).size;
    fixtures.wrappers.requiredRelPaths = [];
    served.set(fixtures.wrappers.url, evil);

    await expect(new VoiceAssets(userData, fetchServing).install(() => {}))
      .rejects.toThrow(/points outside the folder being installed into/);
    expect(fs.existsSync(path.join(userData, 'voice', 'escaped'))).toBe(false);
  });
});
