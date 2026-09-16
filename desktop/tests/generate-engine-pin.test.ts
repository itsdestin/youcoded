// Guards the three tables `scripts/generate-engine-pin.mjs` produces for
// engine-pin.ts. The generator is the only thing standing between an engine
// bump and a hand-transcribed checksum, and two of its three tables are things
// no reviewer can eyeball: a 274-entry alias map and a 22-entry gfx list.
//
// The fixtures below are VERBATIM excerpts of what upstream served for b10665
// (release API JSON, .github/workflows/release.yml, `llama-server --help`), so
// the test also pins that what is committed in engine-pin.ts is what the
// generator actually emits from them — not something edited by hand afterwards.
import { describe, it, expect } from 'vitest';
// A .mjs tool script, imported the way the test tree already imports
// test-engine/*.mjs — tsconfig.tests sets allowJs/checkJs:false for exactly this.
import { parseArgAliases, parseGfxTargets, buildAssetRows, formatAssetRow } from '../scripts/generate-engine-pin.mjs';
import { ENGINE_ASSETS, ARG_ALIASES, pickAsset } from '../src/main/engine/engine-pin';
import type { EngineBackend } from '../src/shared/engine-types';

const TAG = 'b10665';

// The generator is untyped JS, so its return shapes are spelled out once here
// rather than sprayed as `any` across every assertion below.
type GeneratedRow = {
  platform: string; arch: string; backend: string; assetName: string; sha256: string;
  binaryRelPath: string; runtime?: { assetName: string; sha256: string }; gfxTargets?: string[];
};
const gfxTargetsFrom = (yaml: string) => parseGfxTargets(yaml) as Record<string, string[]>;
const assetRowsFrom = (release: unknown, tag: string, gfx: Record<string, string[]>) =>
  buildAssetRows(release, tag, gfx) as { rows: GeneratedRow[]; problems: string[] };
const aliasesFrom = (help: string) => parseArgAliases(help) as Record<string, string>;

// EVERY asset a pinned row is built from, digests verbatim from the b10665
// release API. All of them, not just the new ROCm/CUDA ones: with a partial
// fixture the "emits exactly the rows that are committed" test below silently
// checks only the rows the fixture happens to cover, and a hand-edited Vulkan
// or Metal checksum would ship green.
const RELEASE = {
  assets: [
    { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', digest: 'sha256:8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6' },
    { name: 'llama-b10665-bin-win-vulkan-x64.zip', digest: 'sha256:9bee8af29495148c04c62cd2e254cf6310686d89025f04a4884eb3d7c4031f0d' },
    { name: 'llama-b10665-bin-win-cpu-x64.zip', digest: 'sha256:4b039869c48c2f5842ccc0c005cb36437bac33476be2d661f85e2814a7681af0' },
    { name: 'llama-b10665-bin-win-cpu-arm64.zip', digest: 'sha256:fa296ac9312b894e8ca1c620623a0620907202ae023b957959997b64abf7ec02' },
    { name: 'llama-b10665-bin-win-cuda-12.4-x64.zip', digest: 'sha256:d9b05b81a3f60d30f6625e5561139af505a7ac1fd933c82ee9067ebbada0887a' },
    { name: 'llama-b10665-bin-win-rocm-7.14-x64.zip', digest: 'sha256:081c1a079e7987ee9d36d8cd90a16e0b8e04f1c80c2e5183d694bf31d1c3db61' },
    { name: 'llama-b10665-bin-macos-arm64.tar.gz', digest: 'sha256:bea206745e751cf8957eb729cc8f2950ca5e5340e29aaa9a055a0e4100dabdd1' },
    { name: 'llama-b10665-bin-macos-x64.tar.gz', digest: 'sha256:6c976150c7f74509c60b7cfa04ee31d734d54bcb35fe272cccaa3a2f7f6946aa' },
    { name: 'llama-b10665-bin-ubuntu-vulkan-x64.tar.gz', digest: 'sha256:92f8d63384132e6a70b3b106996a5dce06121bbf770eef68500b1cfb7ff22bcc' },
    { name: 'llama-b10665-bin-ubuntu-x64.tar.gz', digest: 'sha256:7d065b7fe283eac932929bbc92b6e39b58551132a6291d7ab10ea9116997cb4e' },
    { name: 'llama-b10665-bin-ubuntu-rocm-7.14-x64.tar.gz', digest: 'sha256:e5ac52287056b9bd35b6e01e6f5d07210f081313691a7d958944833ab90232e4' },
    { name: 'llama-b10665-bin-ubuntu-vulkan-arm64.tar.gz', digest: 'sha256:746df9199ddfcc11f135f2750d1b38ce73564557642c38bef735fd2f08a9b8f6' },
    { name: 'llama-b10665-bin-ubuntu-arm64.tar.gz', digest: 'sha256:36983c882d7a88cbc02c190a3980cf397e526d588dd66c684b8cd53385a242a6' },
  ],
};

// The two `gpu_targets:` matrix entries of release.yml@b10665, in place.
const WORKFLOW = `
  windows-rocm:
    strategy:
      matrix:
        include:
          - ROCM_VERSION: "7.14.0"
            gpu_targets: "gfx1010;gfx1011;gfx1012;gfx1030;gfx1031;gfx1032;gfx1033;gfx1034;gfx1035;gfx1036;gfx1100;gfx1101;gfx1102;gfx1103;gfx1150;gfx1151;gfx1152;gfx1153;gfx1200;gfx1201"
            build: 'x64'
  ubuntu-24-rocm:
    strategy:
      matrix:
        include:
          - ROCM_VERSION: "7.14.0"
            gpu_targets: "gfx908;gfx90a;gfx942;gfx950;gfx1010;gfx1011;gfx1012;gfx1030;gfx1031;gfx1032;gfx1033;gfx1034;gfx1035;gfx1036;gfx1100;gfx1101;gfx1102;gfx1150;gfx1151;gfx1152;gfx1200;gfx1201"
            build: 'x64'
`;

// Verbatim `llama-server --help` lines from b10665, chosen to cover every shape
// the parser has to survive: a plain short+long, an option with two long forms,
// a boolean pair whose OFF short does NOT start with "no-", a boolean pair with
// no positive short at all, a lone "--no-…" that is not a pair, an env name
// that matches no long form, and a section header.
const HELP = [
  '----- common params -----',
  '',
  '-h,    --help, --usage                  print usage and exit',
  '-c,    --ctx-size N                     size of the prompt context (default: 0, 0 = loaded from model)',
  '                                        (env: LLAMA_ARG_CTX_SIZE)',
  '-ngl,  --gpu-layers, --n-gpu-layers N   max. number of layers to store in VRAM, either an exact number,',
  '                                        or -1 for all',
  '                                        (env: LLAMA_ARG_N_GPU_LAYERS)',
  '-kvo,  --kv-offload, -nkvo, --no-kv-offload',
  '                                        whether to enable KV cache offloading (default: enabled)',
  '                                        (env: LLAMA_ARG_KV_OFFLOAD)',
  '--repack, -nr, --no-repack              whether to enable weight repacking (default: enabled)',
  '                                        (env: LLAMA_ARG_REPACK)',
  '--no-host                               bypass host buffer allowing extra buffers to be used',
  '                                        (env: LLAMA_ARG_NO_HOST)',
  '-b,    --batch-size N                   logical maximum batch size (default: 2048)',
  '                                        (env: LLAMA_ARG_BATCH)',
  '--perf, --no-perf                       whether to enable internal libllama performance timings',
  '                                        (env: LLAMA_ARG_PERF)',
].join('\n');

describe('generate-engine-pin: asset rows', () => {
  it('gives the Windows CUDA row the separate cudart runtime archive', () => {
    const { rows, problems } = assetRowsFrom(RELEASE, TAG, gfxTargetsFrom(WORKFLOW));
    expect(problems.filter((p) => p.includes('cuda'))).toEqual([]);
    const cuda = rows.find((r) => r.backend === 'cuda');
    expect(cuda!.runtime).toEqual({
      assetName: 'cudart-llama-bin-win-cuda-12.4-x64.zip',
      sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
    });
    // Only CUDA needs one: the ROCm archives bundle their own HIP runtime.
    for (const r of rows) if (r.backend !== 'cuda') expect(r.runtime).toBeUndefined();
  });

  it('refuses to emit a CUDA row when the cudart asset is missing, and says which asset', () => {
    const noRuntime = { assets: RELEASE.assets.filter((a) => !a.name.startsWith('cudart-')) };
    const { rows, problems } = assetRowsFrom(noRuntime, TAG, gfxTargetsFrom(WORKFLOW));
    expect(rows.find((r) => r.backend === 'cuda')).toBeUndefined();
    expect(problems.join('\n')).toContain('cudart-llama-bin-win-cuda-12.4-x64.zip');
  });

  it('reads each ROCm build’s gfx target list out of the release workflow at the tag', () => {
    const byJob = gfxTargetsFrom(WORKFLOW);
    expect(byJob['ubuntu-24-rocm']).toEqual([
      'gfx908', 'gfx90a', 'gfx942', 'gfx950',
      'gfx1010', 'gfx1011', 'gfx1012', 'gfx1030', 'gfx1031', 'gfx1032', 'gfx1033', 'gfx1034', 'gfx1035', 'gfx1036',
      'gfx1100', 'gfx1101', 'gfx1102', 'gfx1150', 'gfx1151', 'gfx1152', 'gfx1200', 'gfx1201',
    ]);
    // The Windows build is compiled for a DIFFERENT set — no CDNA (gfx9xx),
    // plus gfx1103/gfx1153. Sharing one list between the two rows would offer
    // ROCm to a chip whose kernels are not in the archive it downloads.
    expect(byJob['windows-rocm']).toContain('gfx1103');
    expect(byJob['windows-rocm']).not.toContain('gfx908');

    const { rows } = assetRowsFrom(RELEASE, TAG, byJob);
    const linux = rows.find((r) => r.platform === 'linux' && r.backend === 'rocm');
    const win = rows.find((r) => r.platform === 'win32' && r.backend === 'rocm');
    expect(linux!.gfxTargets).toEqual(byJob['ubuntu-24-rocm']);
    expect(win!.gfxTargets).toEqual(byJob['windows-rocm']);
    for (const r of rows) if (r.backend !== 'rocm') expect(r.gfxTargets).toBeUndefined();
  });

  it('drops a ROCm row rather than guessing when the workflow lists no targets', () => {
    const { rows, problems } = assetRowsFrom(RELEASE, TAG, {});
    expect(rows.some((r) => r.backend === 'rocm')).toBe(false);
    expect(problems.join('\n')).toContain('re-check the ROCm target list');
  });

  it('emits exactly the rows that are committed in engine-pin.ts', () => {
    const { rows, problems } = assetRowsFrom(RELEASE, TAG, gfxTargetsFrom(WORKFLOW));
    expect(problems).toEqual([]);
    // Both directions, so neither a dropped row nor a hand-added one passes.
    expect(rows.length).toBe(ENGINE_ASSETS.length);
    for (const row of rows) {
      const pinned = pickAsset(row.platform, row.arch, row.backend as EngineBackend)!;
      expect(formatAssetRow(row)).toBe(formatAssetRow(pinned));
    }
  });
});

describe('generate-engine-pin: CLI alias table', () => {
  const table = aliasesFrom(HELP);

  it('collapses the short, long and env spellings of one option to one long name', () => {
    // All three are accepted by the models preset file and resolve to the same
    // option — probed against b10665 on 2026-09-05.
    expect(table['c']).toBe('ctx-size');
    expect(table['LLAMA_ARG_CTX_SIZE']).toBe('ctx-size');
    expect(table['ctx-size']).toBeUndefined();   // canonical names map to themselves by absence
  });

  it('picks the long form the env var is named after when an option has two', () => {
    expect(table['ngl']).toBe('n-gpu-layers');
    expect(table['gpu-layers']).toBe('n-gpu-layers');
    expect(table['LLAMA_ARG_N_GPU_LAYERS']).toBe('n-gpu-layers');
    // LLAMA_ARG_BATCH names no long form, so the last positive long wins.
    expect(table['LLAMA_ARG_BATCH']).toBe('batch-size');
    expect(table['b']).toBe('batch-size');
  });

  it('keeps an OFF switch OFF, including the short spellings that hide it', () => {
    // -nkvo and -nr are the OFF spellings of --kv-offload / --repack. Folding
    // them into the positive would turn a user's "-nr" into "repack = 1".
    expect(table['nkvo']).toBe('no-kv-offload');
    expect(table['kvo']).toBe('kv-offload');
    expect(table['nr']).toBe('no-repack');
    expect(table['no-perf']).toBeUndefined();    // already "no-" + canonical
    expect(table['LLAMA_ARG_PERF']).toBe('perf');
  });

  it('treats a lone --no-… as its own option, not half of a pair', () => {
    expect(table['LLAMA_ARG_NO_HOST']).toBe('no-host');
    expect(table['no-host']).toBeUndefined();
  });

  it('ignores section headers and continuation lines', () => {
    expect(table['-']).toBeUndefined();
    expect(table['size']).toBeUndefined();
    expect(table['whether']).toBeUndefined();
  });

  it('answers an inherited Object member with the key, not with a function', () => {
    // ARG_ALIASES is prototype-less on purpose. On a plain object literal
    // `ARG_ALIASES['valueOf'] ?? 'valueOf'` returns a FUNCTION — not nullish,
    // so the fallback never fires — and that Function goes on to be treated as
    // a canonical option name by whatever normalises through this table.
    const canonical = (k: string) => ARG_ALIASES[k] ?? k;
    for (const k of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf']) {
      expect(canonical(k)).toBe(k);
      expect(typeof canonical(k)).toBe('string');
    }
    expect(Object.getPrototypeOf(ARG_ALIASES)).toBeNull();
  });

  it('the committed ARG_ALIASES agrees with the parser on every fixture line', () => {
    for (const [spelling, canonical] of Object.entries(table)) {
      expect(ARG_ALIASES[spelling]).toBe(canonical);
    }
    // …and is the full b10665 table, not a hand-picked handful.
    expect(Object.keys(ARG_ALIASES).length).toBeGreaterThan(250);
    // One hop is enough: a canonical name is never itself an alias, so
    // `ARG_ALIASES[key] ?? key` never needs to be applied twice.
    for (const canonical of Object.values(ARG_ALIASES)) {
      expect(ARG_ALIASES[canonical]).toBeUndefined();
    }
  });
});

describe('engine-pin tables stay in step', () => {
  it('every ROCm row carries targets and every CUDA row carries a runtime', () => {
    for (const a of ENGINE_ASSETS) {
      if (a.backend === 'rocm') expect(a.gfxTargets?.length).toBeGreaterThan(0);
      if (a.backend === 'cuda') expect(a.runtime?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
