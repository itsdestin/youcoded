import { describe, it, expect } from 'vitest';
import {
  parseNvidiaSmiMemory,
  parseRegistryQwMemorySize,
  parseSystemProfilerVram,
} from '../src/main/models/gpu-detector';

const GB = 1024 ** 3;
const MIB = 1024 * 1024;

describe('parseNvidiaSmiMemory', () => {
  it('takes the largest GPU across multi-line MiB output, in bytes', () => {
    // `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`
    // on a dual-GPU box: a 24GB RTX 4090 (24564 MiB) + an 8GB card.
    expect(parseNvidiaSmiMemory('24564\n8192\n')).toBe(24564 * MIB);
  });
  it('handles a single GPU with a trailing newline', () => {
    expect(parseNvidiaSmiMemory('16376\n')).toBe(16376 * MIB);
  });
  it('empty output → null', () => {
    expect(parseNvidiaSmiMemory('')).toBeNull();
  });
  it('non-numeric garbage → null', () => {
    expect(parseNvidiaSmiMemory('garbage')).toBeNull();
    expect(parseNvidiaSmiMemory('N/A\n\n')).toBeNull();
  });
});

describe('parseRegistryQwMemorySize', () => {
  it('takes the max plausible QWORD (bytes) across adapters', () => {
    // ExpandProperty prints one integer per adapter: a 24GB discrete card
    // (25757220864) alongside a small Intel iGPU carve-out (1073741824 = 1GB).
    // The parser returns the max; the iGPU floor is applied by the dispatcher.
    expect(parseRegistryQwMemorySize('25757220864\n1073741824\n')).toBe(25757220864);
  });
  it('single adapter with blank lines around it', () => {
    expect(parseRegistryQwMemorySize('\n8589934592\n\n')).toBe(8 * GB);
  });
  it('ignores implausibly huge / zero / negative junk', () => {
    // A sign-extended-garbage value beyond 1TB is rejected; the real 8GB wins.
    expect(parseRegistryQwMemorySize('999999999999999999\n0\n8589934592\n')).toBe(8 * GB);
  });
  it('empty output → null', () => {
    expect(parseRegistryQwMemorySize('')).toBeNull();
  });
  it('non-numeric garbage → null', () => {
    expect(parseRegistryQwMemorySize('no such property\n')).toBeNull();
  });
});

describe('parseSystemProfilerVram', () => {
  it('parses "VRAM (Total): N GB" to bytes', () => {
    const out = [
      'Graphics/Displays:',
      '    AMD Radeon Pro 5500M:',
      '      Chipset Model: AMD Radeon Pro 5500M',
      '      VRAM (Total): 8 GB',
    ].join('\n');
    expect(parseSystemProfilerVram(out)).toBe(8 * GB);
  });
  it('parses a "VRAM (Dynamic, Max): N MB" figure', () => {
    expect(parseSystemProfilerVram('      VRAM (Dynamic, Max): 1536 MB')).toBe(1536 * MIB);
  });
  it('no VRAM line → null', () => {
    expect(parseSystemProfilerVram('Graphics/Displays:\n    Intel Iris:\n')).toBeNull();
  });
});

// ---------- which chip is it, and what may it be offered? (2026-09-05 §A3) ----------

import {
  parseDrmVendorId,
  pickVendor,
  gfxTargetName,
  parseKfdGfxTargetVersion,
  parseWindowsAdapterVendor,
  backendOptions,
  gpuDeviceName,
} from '../src/main/models/gpu-detector';
import { pickAsset } from '../src/main/engine/engine-pin';

describe('parseDrmVendorId', () => {
  it('reads THIS machine\'s card', () => {
    // /sys/class/drm/card1/device/vendor on this laptop, 2026-09-05. Note there
    // is no card0 at all — card numbering is not dense.
    expect(parseDrmVendorId('0x1002\n')).toBe('amd');
  });
  it('the other two ids we act on', () => {
    expect(parseDrmVendorId('0x10de\n')).toBe('nvidia');
    expect(parseDrmVendorId('0x8086\n')).toBe('intel');
  });
  it('case and whitespace do not matter', () => {
    expect(parseDrmVendorId('  0X1002  ')).toBe('amd');
  });
  it('an id we have no build for → null, never a guess', () => {
    expect(parseDrmVendorId('0x1af4')).toBeNull();   // virtio (a VM display)
    expect(parseDrmVendorId('')).toBeNull();
  });
});

describe('pickVendor — several cards, one answer', () => {
  it('an AMD GPU next to an Intel iGPU picks AMD', () => {
    // The exact laptop shape this exists for. Picking Intel would silently
    // withhold ROCm from a machine that can run it.
    expect(pickVendor(['intel', 'amd'])).toBe('amd');
    expect(pickVendor(['amd', 'intel'])).toBe('amd');
  });
  it('a discrete NVIDIA card next to an Intel iGPU picks NVIDIA', () => {
    expect(pickVendor(['intel', 'nvidia'])).toBe('nvidia');
  });
  it('NVIDIA outranks AMD when both are somehow present', () => {
    expect(pickVendor(['amd', 'nvidia'])).toBe('nvidia');
  });
  it('Intel alone is still reported — "known, nothing to offer" beats "unknown"', () => {
    expect(pickVendor(['intel'])).toBe('intel');
  });
  it('nothing recognised → null', () => {
    expect(pickVendor([])).toBeNull();
    expect(pickVendor([null, null])).toBeNull();
  });
});

describe('gfxTargetName — the kfd integer → the ROCm target', () => {
  it('110501 → gfx1151, which is what THIS machine reads', () => {
    expect(gfxTargetName(110501)).toBe('gfx1151');
  });
  it('the CPU node reads 0 and is not a target', () => {
    // Every AMD machine has one. Treating it as a target would produce a
    // "gfx000" that matches nothing and offers ROCm to no one — and, worse,
    // a non-null gfxTarget makes `backendOptions` believe the chip was read.
    expect(gfxTargetName(0)).toBeNull();
  });
  it('the step is HEX: 90010 → gfx90a, not gfx9010', () => {
    expect(gfxTargetName(90010)).toBe('gfx90a');
  });
  it('the other targets the pinned build lists', () => {
    expect(gfxTargetName(90008)).toBe('gfx908');
    expect(gfxTargetName(90402)).toBe('gfx942');
    expect(gfxTargetName(100300)).toBe('gfx1030');
    expect(gfxTargetName(110000)).toBe('gfx1100');
    expect(gfxTargetName(120001)).toBe('gfx1201');
  });
  it('every name it produces for the pin\'s own targets round-trips into that list', () => {
    // The point of the mapping: what this returns has to be a string the engine
    // archive actually contains kernels for.
    const linux = pickAsset('linux', 'x64', 'rocm');
    expect(linux?.gfxTargets).toContain(gfxTargetName(110501));
    expect(linux?.gfxTargets).toContain(gfxTargetName(90010));
  });
  it('junk → null', () => {
    expect(gfxTargetName(-1)).toBeNull();
    expect(gfxTargetName(NaN)).toBeNull();
    // Anything short of a major number is not a target either.
    expect(gfxTargetName(500)).toBeNull();
    expect(gfxTargetName(9999)).toBeNull();
  });
});

describe('parseKfdGfxTargetVersion', () => {
  // A trimmed copy of this machine's real node properties file, key-value pairs
  // one per line.
  const node1 = [
    'cpu_cores_count 0',
    'simd_count 80',
    'gfx_target_version 110501',
    'max_engine_clk_ccompute 3801',
  ].join('\n');
  const node0 = ['cpu_cores_count 16', 'simd_count 0', 'gfx_target_version 0'].join('\n');

  it('reads the GPU node', () => {
    expect(parseKfdGfxTargetVersion(node1)).toBe(110501);
  });
  it('reads the CPU node as 0 (which gfxTargetName then rejects)', () => {
    expect(parseKfdGfxTargetVersion(node0)).toBe(0);
  });
  it('a properties file without the key → null', () => {
    expect(parseKfdGfxTargetVersion('cpu_cores_count 16')).toBeNull();
  });
  it('does not match a different key that ends in the same word', () => {
    expect(parseKfdGfxTargetVersion('not_gfx_target_version 110501')).toBeNull();
  });
});

describe('parseWindowsAdapterVendor', () => {
  it('NVIDIA driver strings', () => {
    expect(parseWindowsAdapterVendor('NVIDIA GeForce RTX 4090\nNVIDIA\n')).toBe('nvidia');
  });
  it('AMD, by DriverDesc and by ProviderName', () => {
    expect(parseWindowsAdapterVendor('AMD Radeon RX 7900 XTX\n')).toBe('amd');
    expect(parseWindowsAdapterVendor('Advanced Micro Devices, Inc.\n')).toBe('amd');
    expect(parseWindowsAdapterVendor('ATI Radeon HD 5000\n')).toBe('amd');
  });
  it('a laptop listing BOTH an Intel iGPU and an AMD card picks AMD', () => {
    const out = 'Intel(R) UHD Graphics\nIntel Corporation\nAMD Radeon RX 6600M\nAdvanced Micro Devices, Inc.\n';
    expect(parseWindowsAdapterVendor(out)).toBe('amd');
  });
  it('Intel alone', () => {
    expect(parseWindowsAdapterVendor('Intel(R) Iris(R) Xe Graphics\n')).toBe('intel');
  });
  it('a basic display adapter names no vendor we act on', () => {
    expect(parseWindowsAdapterVendor('Microsoft Basic Display Adapter\n')).toBeNull();
    expect(parseWindowsAdapterVendor('')).toBeNull();
  });
});

describe('backendOptions — every gate', () => {
  const base = { installedBackend: 'vulkan' as const, rocmPrereqsSatisfied: true };

  it('NVIDIA on Windows x64 → CUDA, ready', () => {
    const opts = backendOptions({ ...base, platform: 'win32', arch: 'x64', vendor: 'nvidia', gfxTarget: null });
    expect(opts).toEqual([{ backend: 'cuda', label: 'Switch to CUDA (faster on NVIDIA)', state: 'ready' }]);
  });
  it('NVIDIA on LINUX → nothing: upstream publishes no Linux CUDA build', () => {
    expect(backendOptions({ ...base, platform: 'linux', arch: 'x64', vendor: 'nvidia', gfxTarget: null })).toEqual([]);
    // …and that is a fact about the pin, not about this function.
    expect(pickAsset('linux', 'x64', 'cuda')).toBeNull();
  });

  it('AMD gfx1151 on Linux x64 with the libraries → ROCm, ready', () => {
    // This machine.
    const opts = backendOptions({ ...base, platform: 'linux', arch: 'x64', vendor: 'amd', gfxTarget: 'gfx1151' });
    expect(opts).toEqual([{ backend: 'rocm', label: 'Try ROCm (AMD) — reads faster, writes slower', state: 'ready' }]);
  });
  // 2026-09-05, measured on this machine (engine b10665, AMD Strix Halo /
  // Radeon 8060S, Qwen3.5-9B Q8 and Qwen3.8-27B Q8, 200 forced tokens,
  // non-repeating prompt, speculation off): ROCm read the prompt ~20% FASTER
  // and wrote the reply 24–46% SLOWER than Vulkan. The old label said "faster
  // on AMD" — an unmeasured claim, and false for the half a user sits and
  // watches. This pins the retraction: restoring the promise fails here, so a
  // future edit has to confront the numbers first. Table and method:
  // docs/engine-dependencies.md → "ROCm vs Vulkan, measured".
  it('never sells ROCm as simply faster — its label names the trade', () => {
    const opts = backendOptions({ ...base, platform: 'linux', arch: 'x64', vendor: 'amd', gfxTarget: 'gfx1151' });
    expect(opts[0].label).not.toMatch(/faster on amd/i);
    expect(opts[0].label).toMatch(/slower/i);
    // …and CUDA is untouched: nothing here says NVIDIA's build is a trade too.
    const cuda = backendOptions({ ...base, platform: 'win32', arch: 'x64', vendor: 'nvidia', gfxTarget: null });
    expect(cuda[0].label).toMatch(/faster on NVIDIA/i);
  });

  it('the same chip WITHOUT the libraries → ROCm, needs-prereqs', () => {
    const opts = backendOptions({
      ...base, rocmPrereqsSatisfied: false, platform: 'linux', arch: 'x64', vendor: 'amd', gfxTarget: 'gfx1151',
    });
    expect(opts.map((o) => o.state)).toEqual(['needs-prereqs']);
  });

  it('reads the LINUX row\'s list, not "the pin\'s": gfx1153 is Windows-only', () => {
    // The two ROCm rows carry different target lists (T1, verified at b10665).
    // gfx1153 is compiled into the Windows build and NOT the Linux one, so a
    // Linux machine with that chip must be refused — a shared list would offer
    // it a build with no machine code for it, which dies at the first token.
    expect(pickAsset('win32', 'x64', 'rocm')?.gfxTargets).toContain('gfx1153');
    expect(pickAsset('linux', 'x64', 'rocm')?.gfxTargets).not.toContain('gfx1153');
    expect(backendOptions({ ...base, platform: 'linux', arch: 'x64', vendor: 'amd', gfxTarget: 'gfx1153' })).toEqual([]);
  });
  it('…and the reverse: gfx942 is Linux-only, and Windows does not gate on gfx at all', () => {
    expect(pickAsset('linux', 'x64', 'rocm')?.gfxTargets).toContain('gfx942');
    expect(pickAsset('win32', 'x64', 'rocm')?.gfxTargets).not.toContain('gfx942');
    // Windows publishes no gfx target to read, so it offers on vendor alone.
    const opts = backendOptions({ ...base, platform: 'win32', arch: 'x64', vendor: 'amd', gfxTarget: null });
    expect(opts).toEqual([{ backend: 'rocm', label: 'Try ROCm (AMD) — reads faster, writes slower', state: 'ready' }]);
  });
  it('an AMD chip the pin does not list at all → nothing offered', () => {
    // gfx803 (Polaris) is not in either row.
    expect(backendOptions({ ...base, platform: 'linux', arch: 'x64', vendor: 'amd', gfxTarget: 'gfx803' })).toEqual([]);
  });
  it('an AMD chip whose gfx target could NOT be read → nothing offered', () => {
    // No /sys/class/kfd (the compute driver is not loaded, or this is a
    // container). Refusing costs a speed-up; guessing costs a dead engine.
    expect(backendOptions({ ...base, platform: 'linux', arch: 'x64', vendor: 'amd', gfxTarget: null })).toEqual([]);
  });
  it('AMD on linux ARM64 → nothing: the pin ships no ROCm build for it', () => {
    expect(backendOptions({ ...base, platform: 'linux', arch: 'arm64', vendor: 'amd', gfxTarget: 'gfx1151' })).toEqual([]);
  });

  it('never offers the backend that is already installed', () => {
    expect(backendOptions({
      ...base, installedBackend: 'rocm', platform: 'linux', arch: 'x64', vendor: 'amd', gfxTarget: 'gfx1151',
    })).toEqual([]);
    expect(backendOptions({
      ...base, installedBackend: 'cuda', platform: 'win32', arch: 'x64', vendor: 'nvidia', gfxTarget: null,
    })).toEqual([]);
  });

  it('NEVER offers anything to Apple — Metal already is Apple\'s own backend', () => {
    expect(backendOptions({ ...base, installedBackend: 'metal', platform: 'darwin', arch: 'arm64', vendor: 'apple', gfxTarget: null })).toEqual([]);
  });
  it('NEVER offers anything to Intel — there is no Intel-specific build', () => {
    for (const platform of ['win32', 'linux']) {
      expect(backendOptions({ ...base, platform, arch: 'x64', vendor: 'intel', gfxTarget: null })).toEqual([]);
    }
  });
  it('no chip detected → nothing offered', () => {
    expect(backendOptions({ ...base, platform: 'linux', arch: 'x64', vendor: null, gfxTarget: null })).toEqual([]);
  });
});

describe('gpuDeviceName — the marker\'s device list', () => {
  // The shape engine-acquisition writes (T2): the engine's own device id
  // verbatim, the name with its parentheses intact, totalMiB/freeMiB that are
  // null when unmeasured, and the writer's own isGpu classification.
  it('takes the first GPU device and strips the driver\'s parenthetical', () => {
    const devices = [{ backend: 'ROCm0', name: 'AMD Radeon 8060S Graphics (RADV GFX1151)', totalMiB: 65536, freeMiB: 60000, isGpu: true }];
    expect(gpuDeviceName(devices)).toBe('AMD Radeon 8060S Graphics');
  });
  // The exact two-device reading captured from this machine's own
  // `llama-server --list-devices` (engine-acquisition.test.ts, 2026-09-05),
  // parsed into the marker shape. Note the software renderer's 124406 MiB:
  // that is system RAM, not a graphics chip.
  const REAL_GPU = { backend: 'Vulkan0', name: 'AMD Radeon 8060S Graphics (RADV STRIX_HALO)', totalMiB: 86016, freeMiB: 83633, isGpu: true };
  const REAL_LLVMPIPE = { backend: 'Vulkan1', name: 'llvmpipe (LLVM 22.1.6, 256 bits)', totalMiB: 124406, freeMiB: 80073, isGpu: false };

  it('skips a software renderer BY ITS isGpu FLAG, not by its backend id', () => {
    // The bug this pins: llvmpipe is reported as `Vulkan0`/`Vulkan1`, NEVER as
    // `CPU`, so a guess based on the backend id would have shown the user
    // "llvmpipe" as their graphics chip while the processor did all the work.
    expect(gpuDeviceName([REAL_GPU, REAL_LLVMPIPE])).toBe('AMD Radeon 8060S Graphics');
    // …and device order is not a contract, so the reverse must work too.
    expect(gpuDeviceName([REAL_LLVMPIPE, REAL_GPU])).toBe('AMD Radeon 8060S Graphics');
  });
  it('a machine with only a software renderer has no GPU name — "Processor only"', () => {
    expect(gpuDeviceName([REAL_LLVMPIPE])).toBeNull();
  });
  it('a device with unmeasured memory is still a GPU — null MiB is not "absent"', () => {
    expect(gpuDeviceName([{ backend: 'ROCm0', name: 'AMD Radeon 8060S Graphics', totalMiB: null, freeMiB: null, isGpu: true }]))
      .toBe('AMD Radeon 8060S Graphics');
  });
  it('a marker written before the devices field existed degrades to null, not a crash', () => {
    // Installs made before T2 landed simply have no `devices` key.
    expect(gpuDeviceName(undefined)).toBeNull();
    expect(gpuDeviceName(null)).toBeNull();
    expect(gpuDeviceName([])).toBeNull();
  });
  it('a row whose isGpu cannot be read is skipped, never assumed', () => {
    expect(gpuDeviceName([{ backend: 'ROCm0', name: 'Some Card' }])).toBeNull();
    expect(gpuDeviceName([{ backend: 'ROCm0', name: 'Some Card', isGpu: 'yes' }])).toBeNull();
  });
  it('junk in the marker is ignored rather than rendered', () => {
    expect(gpuDeviceName('ROCm0: a card')).toBeNull();
    expect(gpuDeviceName([null, 7, { name: '', isGpu: true }])).toBeNull();
  });
  it('a name that is nothing BUT a parenthetical keeps its original text', () => {
    // Stripping to an empty string would put a blank where a name should be.
    expect(gpuDeviceName([{ backend: 'ROCm0', name: '(unknown device)', isGpu: true }])).toBe('(unknown device)');
  });
});
