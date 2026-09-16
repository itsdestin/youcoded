// The ONE place voice prompting's two downloads are pinned — the sherpa-onnx
// native runtime (from npm) and the Parakeet speech model (from a GitHub
// release). Same discipline as engine-pin.ts: a bump is a PR that re-runs the
// commands recorded beside each digest.
//
// TWO things are pinned per platform, not one (design: "Main — src/main/voice/"):
//   1. the integrity DIGEST, so a tampered or truncated download is refused, and
//   2. the IN-ARCHIVE RELATIVE PATH of the file we need out of it, so a layout
//      change upstream fails loudly at unpack time instead of installing a
//      directory that looks complete and cannot load.
// engine-pin.ts pins an engine asset's binaryRelPath for exactly that reason and
// engine-acquisition's post-unpack existence check enforces it; voice-assets.ts
// reuses that check verbatim.
//
// WHY the digests come in two shapes: npm publishes `dist.integrity`, which is
// SHA-512 in base64 (the SSRI "sha512-…" form); the sherpa-onnx release
// publishes SHA-256 in hex in its checksum.txt. Rather than convert one into the
// other by hand — and lose the ability to re-check a pin against its source with
// one command — each pin carries {algo, encoding, digest} and the verifier reads
// it. The command that produced each value is recorded above the table.
import * as path from 'path';

/** sherpa-onnx npm packages: the native addon and the JS wrappers move together. */
export const SHERPA_VERSION = '1.13.7';

/** Shown to the user as the engine's name (VoiceReadiness carries it). */
export const VOICE_ENGINE_LABEL = 'Parakeet TDT 0.6B v3';

/** How a file's expected fingerprint is written down. See the header for WHY
 *  this is a shape rather than a bare hex string. */
export interface DigestPin {
  algo: 'sha256' | 'sha512';
  encoding: 'hex' | 'base64';
  digest: string;
}

/** One downloadable archive: where it lives, what it must hash to, how big it
 *  is (the denominator of the download percentage), and what must exist inside
 *  it once unpacked. */
export interface VoiceArchive {
  /** Plain-language name, used in error messages the user actually reads. */
  label: string;
  url: string;
  digest: DigestPin;
  /** Exact size of the DOWNLOAD in bytes, measured with the command below.
   *  Pinned rather than read from Content-Length because the combined
   *  percentage has to be known before the first byte arrives. */
  bytes: number;
  /** Paths inside the archive that MUST exist after unpacking. Empty is not
   *  allowed — this is the stale-layout tripwire. */
  requiredRelPaths: string[];
}

export interface VoiceRuntimePin extends VoiceArchive {
  platform: 'win32' | 'darwin' | 'linux';
  arch: 'x64' | 'arm64' | 'ia32';
  npmPackage: string;
  /** The native addon inside the archive. Verified 2026-09-05 by listing all
   *  six tarballs: every one is rooted at `package/` with the addon and its
   *  sibling shared libraries (.so/.dylib/.dll) flat beside it. */
}

/** npm serves every tarball from the same predictable path. */
export function npmTarballUrl(pkg: string, version: string): string {
  return `https://registry.npmjs.org/${pkg}/-/${pkg}-${version}.tgz`;
}

// Digests below: `curl -s https://registry.npmjs.org/<pkg>/1.13.7 | python3 -c
//   'import sys,json;d=json.load(sys.stdin);print(d["dist"]["integrity"])'`
// Sizes below: `curl -s -r 0-0 -D - -o /dev/null <tarball url>` → Content-Range
//   total. Both read 2026-09-05.
//
// `win-arm64` IS ABSENT and that is not an oversight: sherpa-onnx publishes no
// such package (the registry answers 404, checked 2026-09-05 alongside the six
// below). A Windows-on-ARM machine gets `unsupportedReason()`'s sentence, not a
// failed download. `win-ia32` (32-bit Windows) DOES exist and is supported.
export const VOICE_RUNTIMES: VoiceRuntimePin[] = [
  {
    platform: 'linux', arch: 'x64', npmPackage: 'sherpa-onnx-linux-x64',
    label: 'the speech runtime',
    url: npmTarballUrl('sherpa-onnx-linux-x64', SHERPA_VERSION),
    digest: { algo: 'sha512', encoding: 'base64', digest: 'npmxn5WwmAmlthgBhmbZ33t3i2j4mJwQt46dMEb3j7d41y1/uJrjrVAfa/DkvV+vn49ZWfcQ2UEWDipaZBVhuw==' },
    bytes: 10810981,
    requiredRelPaths: ['package/sherpa-onnx.node'],
  },
  {
    platform: 'linux', arch: 'arm64', npmPackage: 'sherpa-onnx-linux-arm64',
    label: 'the speech runtime',
    url: npmTarballUrl('sherpa-onnx-linux-arm64', SHERPA_VERSION),
    digest: { algo: 'sha512', encoding: 'base64', digest: 'TFCVpXyTh69buhOtTS8KIfkRXOVKY4Y1qjAktSItrKS4A0chnnrlXO5bKWoNAPeI6fMxTF/uvMYbYgcvjEMfNg==' },
    bytes: 13605393,
    requiredRelPaths: ['package/sherpa-onnx.node'],
  },
  {
    platform: 'win32', arch: 'x64', npmPackage: 'sherpa-onnx-win-x64',
    label: 'the speech runtime',
    url: npmTarballUrl('sherpa-onnx-win-x64', SHERPA_VERSION),
    digest: { algo: 'sha512', encoding: 'base64', digest: 'wBV1o+/zgsMrOjfCFIgGrH6S28xq6CqRCLSavCOjTZ6cqr80yGc07DUHxqsHFPZvfoJU+2JF5L2l3gyWFWoWdQ==' },
    bytes: 8705089,
    requiredRelPaths: ['package/sherpa-onnx.node'],
  },
  {
    platform: 'win32', arch: 'ia32', npmPackage: 'sherpa-onnx-win-ia32',
    label: 'the speech runtime',
    url: npmTarballUrl('sherpa-onnx-win-ia32', SHERPA_VERSION),
    digest: { algo: 'sha512', encoding: 'base64', digest: 'sTwtpxPQ76XLn0giAbvknIDEDKD3XXi2mo2AVROEucf1pIK1DjQl+LjLkalTeFoQqbC4J3xGx/g+xgcHQD1dsw==' },
    bytes: 7572131,
    requiredRelPaths: ['package/sherpa-onnx.node'],
  },
  {
    platform: 'darwin', arch: 'x64', npmPackage: 'sherpa-onnx-darwin-x64',
    label: 'the speech runtime',
    url: npmTarballUrl('sherpa-onnx-darwin-x64', SHERPA_VERSION),
    digest: { algo: 'sha512', encoding: 'base64', digest: 'N3o+T+wn9WaQmsKV5DD8bTHdo+WN2+sXwmZcGJZiDjtOMR2zFz7uVCZnYCmEAMgvChC+oHcF5RvEEKcRCAu6Pw==' },
    bytes: 11151181,
    requiredRelPaths: ['package/sherpa-onnx.node'],
  },
  {
    platform: 'darwin', arch: 'arm64', npmPackage: 'sherpa-onnx-darwin-arm64',
    label: 'the speech runtime',
    url: npmTarballUrl('sherpa-onnx-darwin-arm64', SHERPA_VERSION),
    digest: { algo: 'sha512', encoding: 'base64', digest: '5NCE50hAvr3n2pdett0SgfPBJXaFZE0bqHwbHyiq+IKZ8Ids0l4M0VrG+ImGYIafCwie+oC3uAJ+pKj9xg/k+w==' },
    bytes: 10015211,
    requiredRelPaths: ['package/sherpa-onnx.node'],
  },
];

/** The platform-independent JS half of sherpa-onnx.
 *
 *  WHY it is a SECOND download unpacked ON TOP of the runtime: the native
 *  addon alone is a bag of C functions; `OfflineRecognizer` and friends are
 *  plain JavaScript in this package. Its loader (`addon.js`) tries five paths
 *  for the addon, and the fifth is `./sherpa-onnx.node` — the same directory —
 *  so unpacking these files beside the addon is what makes the pair resolve
 *  with no `node_modules` anywhere in sight. Read out of the published
 *  addon.js, 2026-09-05.
 *
 *  Both tarballs are rooted at `package/`, so this one is unpacked SECOND and
 *  its package.json (whose `main` is sherpa-onnx.js) deliberately wins. */
export const VOICE_WRAPPERS: VoiceArchive & { npmPackage: string } = {
  npmPackage: 'sherpa-onnx-node',
  label: 'the speech runtime',
  url: npmTarballUrl('sherpa-onnx-node', SHERPA_VERSION),
  digest: { algo: 'sha512', encoding: 'base64', digest: '0XGV7arGngBCnol0m8OLyqlnaUm19Q1KmetVj1DDBdymXa1upmAHZDwNdN47gjsEhqE5hXUEyc1vRQoXrNhNVg==' },
  bytes: 11954,
  requiredRelPaths: ['package/sherpa-onnx.js', 'package/non-streaming-asr.js', 'package/addon.js'],
};

/** The directory the model's files live in on disk. */
export const MODEL_DIR_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';

/** Where the model's files are published individually. Hugging Face is the
 *  model's own upstream home — the .tar.bz2 on the GitHub release is built FROM
 *  this directory, and each file here was checked byte for byte against a copy
 *  unpacked from that sha256-pinned archive (2026-09-05). */
const MODEL_BASE_URL =
  'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main';

/** The four files the recogniser opens, named ONCE. The archive's contents and
 *  the engine's config are the same four names, and spelling them in two places
 *  means a re-pinned model archive passes every test and then fails at load with
 *  the engine's own words about a missing file. */
export const MODEL_FILES = {
  encoder: 'encoder.int8.onnx',
  decoder: 'decoder.int8.onnx',
  joiner: 'joiner.int8.onnx',
  tokens: 'tokens.txt',
} as const;

/** One file of the speech model, fetched on its own.
 *
 *  WHY not the single .tar.bz2 the model is published as, which is 175 MB
 *  smaller: unpacking it needs a bzip2 program that is NOT part of the app.
 *  Linux `tar` shells out to one (it prefers `lbzip2`, which almost nobody has,
 *  and falls back to `bzip2`), so a slim install simply fails; and the claim
 *  that Windows' and macOS' tar decompress bzip2 themselves could never be
 *  tested from this machine, which meant shipping a first-run experience on two
 *  platforms on the strength of a belief. Four plain downloads behave the same
 *  way on every operating system, need no program that might be missing, and
 *  have no unpacking step at all. Destin, 2026-09-05: "should be seamless."
 *
 *  These are the SAME BYTES as the ones inside the release archive — verified
 *  file by file against a copy unpacked from the sha256-pinned archive. */
export interface VoiceModelFile {
  /** Filename inside the model directory. */
  name: string;
  url: string;
  digest: DigestPin;
  bytes: number;
}

/** Sizes and digests: `curl -sSL <url> | sha256sum` and the Content-Range total,
 *  both taken 2026-09-05 and both cross-checked against the archive's contents. */
export const VOICE_MODEL_FILES: VoiceModelFile[] = [
  {
    name: MODEL_FILES.encoder,
    url: `${MODEL_BASE_URL}/${MODEL_FILES.encoder}`,
    digest: { algo: 'sha256', encoding: 'hex', digest: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247' },
    bytes: 652184281,
  },
  {
    name: MODEL_FILES.decoder,
    url: `${MODEL_BASE_URL}/${MODEL_FILES.decoder}`,
    digest: { algo: 'sha256', encoding: 'hex', digest: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e' },
    bytes: 11845275,
  },
  {
    name: MODEL_FILES.joiner,
    url: `${MODEL_BASE_URL}/${MODEL_FILES.joiner}`,
    digest: { algo: 'sha256', encoding: 'hex', digest: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3' },
    bytes: 6355277,
  },
  {
    name: MODEL_FILES.tokens,
    url: `${MODEL_BASE_URL}/${MODEL_FILES.tokens}`,
    digest: { algo: 'sha256', encoding: 'hex', digest: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
    bytes: 93939,
  },
];

/** What the model directory must contain when the install finishes. */
export const MODEL_REQUIRED_REL_PATHS = VOICE_MODEL_FILES.map((f) => `${MODEL_DIR_NAME}/${f.name}`);

/** Every byte of the model, added up. */
export const VOICE_MODEL_BYTES = VOICE_MODEL_FILES.reduce((n, f) => n + f.bytes, 0);

/** Identity of the model on disk, for the "is this the model I pinned?" marker.
 *  The encoder is the model — the other three are tiny and change with it. */
export const VOICE_MODEL_ID = VOICE_MODEL_FILES[0].digest.digest;

/** Every byte the first-run download has to move. The progress percentage is
 *  over this, so the bar never restarts between the three archives. */
export function totalDownloadBytes(runtime: VoiceRuntimePin): number {
  return runtime.bytes + VOICE_WRAPPERS.bytes + VOICE_MODEL_BYTES;
}

export function pickRuntime(platform: NodeJS.Platform | string, arch: string): VoiceRuntimePin | null {
  return VOICE_RUNTIMES.find((r) => r.platform === platform && r.arch === arch) ?? null;
}

/** The user-facing sentence for a machine voice cannot run on, or null if it
 *  can. Specific and true (docs/error-message-standards.md): it names the
 *  actual machine, because the only case today is Windows on ARM, where the
 *  speech runtime is simply not published. */
export function unsupportedReason(platform: NodeJS.Platform | string, arch: string): string | null {
  if (pickRuntime(platform, arch)) return null;
  return `Voice typing is not available on this computer (${platform} ${arch}) — the speech engine is not published for it.`;
}

// ---------------------------------------------------------------------------
// Where it all lands on disk. Everything below is a pure path function so the
// worker (a separate process) and the service agree without either hardcoding a
// directory name — voice-worker.ts imports addonPath() rather than rebuilding it.
// ---------------------------------------------------------------------------

/** `<userData>/voice` — per-machine, never synced (it is hundreds of MB of
 *  machine-specific binaries). Listed in docs/MAP.md's on-disk state table. */
export function voiceRoot(userDataPath: string): string {
  return path.join(userDataPath, 'voice');
}

/** `<userData>/voice/runtime` — the unpacked native addon + JS wrappers. */
export function runtimeDir(userDataPath: string): string {
  return path.join(voiceRoot(userDataPath), 'runtime');
}

/** Absolute path of the native addon. THE export voice-worker.ts require()s;
 *  nothing else may rebuild this string. */
export function addonPath(userDataPath: string): string {
  return path.join(runtimeDir(userDataPath), 'package', 'sherpa-onnx.node');
}

/** Absolute path of the JS wrapper entry (`OfflineRecognizer` lives behind it). */
export function wrapperEntryPath(userDataPath: string): string {
  return path.join(runtimeDir(userDataPath), 'package', 'sherpa-onnx.js');
}

/** Absolute path of the unpacked model directory (the one holding
 *  encoder/decoder/joiner/tokens), which sherpa's recognizer config wants. */
export function modelDir(userDataPath: string): string {
  return path.join(voiceRoot(userDataPath), 'model', MODEL_DIR_NAME);
}
