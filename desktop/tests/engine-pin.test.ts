import { describe, it, expect } from 'vitest';
import {
  ENGINE_VERSION, ENGINE_ASSETS, ARG_ALIASES, pickAsset, assetUrl, defaultBackend,
} from '../src/main/engine/engine-pin';

describe('engine-pin', () => {
  it('every asset row is fully populated (no placeholder checksums or paths)', () => {
    expect(ENGINE_ASSETS.length).toBeGreaterThan(0);
    for (const a of ENGINE_ASSETS) {
      expect(a.assetName).toContain(ENGINE_VERSION);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.binaryRelPath.length).toBeGreaterThan(0);
    }
  });

  it('picks the Vulkan build on Windows x64 and the Metal (default) build on macOS arm64', () => {
    const win = pickAsset('win32', 'x64', 'vulkan');
    expect(win?.assetName).toBe(`llama-${ENGINE_VERSION}-bin-win-vulkan-x64.zip`);
    const mac = pickAsset('darwin', 'arm64', 'metal');
    expect(mac?.assetName).toBe(`llama-${ENGINE_VERSION}-bin-macos-arm64.tar.gz`);
  });

  it('returns null for combinations upstream does not ship (Linux CUDA)', () => {
    expect(pickAsset('linux', 'x64', 'cuda')).toBeNull();
  });

  it('ships a ROCm build for both AMD platforms, with the right archive shape', () => {
    const linux = pickAsset('linux', 'x64', 'rocm')!;
    expect(linux.assetName).toBe(`llama-${ENGINE_VERSION}-bin-ubuntu-rocm-7.14-x64.tar.gz`);
    expect(linux.binaryRelPath).toBe(`llama-${ENGINE_VERSION}/llama-server`);   // tar.gz nests
    const win = pickAsset('win32', 'x64', 'rocm')!;
    expect(win.assetName).toBe(`llama-${ENGINE_VERSION}-bin-win-rocm-7.14-x64.zip`);
    expect(win.binaryRelPath).toBe('llama-server.exe');                         // zip is flat
    // No ROCm build for arm64 or macOS — upstream publishes neither.
    expect(pickAsset('linux', 'arm64', 'rocm')).toBeNull();
    expect(pickAsset('darwin', 'arm64', 'rocm')).toBeNull();
  });

  it('lists the AMD chips each ROCm build actually has kernels for', () => {
    // This machine's Z13 reads gfx1151; if it fell out of the list the app must
    // stop offering ROCm rather than install a build that cannot run on it.
    expect(pickAsset('linux', 'x64', 'rocm')!.gfxTargets).toContain('gfx1151');
    // The Linux build adds the CDNA data-centre parts the Windows one omits.
    expect(pickAsset('linux', 'x64', 'rocm')!.gfxTargets).toContain('gfx908');
    expect(pickAsset('win32', 'x64', 'rocm')!.gfxTargets).not.toContain('gfx908');
    for (const a of ENGINE_ASSETS) {
      expect(a.gfxTargets === undefined).toBe(a.backend !== 'rocm');
      for (const t of a.gfxTargets ?? []) expect(t).toMatch(/^gfx[0-9a-f]+$/);
    }
  });

  it('pairs the Windows CUDA build with the separate CUDA runtime archive', () => {
    // The engine zip carries ggml-cuda.dll but no CUDA runtime, so without this
    // second archive "Switch to CUDA" only boots on a PC that already has the
    // toolkit on PATH.
    const cuda = pickAsset('win32', 'x64', 'cuda')!;
    expect(cuda.runtime?.assetName).toBe('cudart-llama-bin-win-cuda-12.4-x64.zip');
    expect(cuda.runtime?.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const a of ENGINE_ASSETS) {
      expect(a.runtime === undefined).toBe(a.backend !== 'cuda');
    }
  });

  it('ARG_ALIASES resolves every spelling of one option to one long name', () => {
    // llama-server's preset file accepts the short, long and env spelling of an
    // option and treats them as the same key (probed on b10665, 2026-09-05), so
    // anything reasoning about option names has to collapse them first.
    const canonical = (k: string) => ARG_ALIASES[k] ?? k;
    expect(canonical('c')).toBe('ctx-size');
    expect(canonical('ctx-size')).toBe('ctx-size');
    expect(canonical('LLAMA_ARG_CTX_SIZE')).toBe('ctx-size');
    expect(canonical('ngl')).toBe('n-gpu-layers');
    expect(canonical('gpu-layers')).toBe('n-gpu-layers');
    expect(canonical('LLAMA_ARG_N_GPU_LAYERS')).toBe('n-gpu-layers');
    // An OFF switch stays OFF even when its short form hides the "no".
    expect(canonical('nkvo')).toBe('no-kv-offload');
    expect(canonical('kvo')).toBe('kv-offload');
    // An option this feature writes into the preset itself.
    expect(canonical('sleep-idle-seconds')).toBe('sleep-idle-seconds');
    expect(canonical('ctk')).toBe('cache-type-k');
  });

  it('defaultBackend: metal on darwin, vulkan elsewhere', () => {
    expect(defaultBackend('darwin')).toBe('metal');
    expect(defaultBackend('win32')).toBe('vulkan');
    expect(defaultBackend('linux')).toBe('vulkan');
  });

  it('assetUrl points at the pinned ggml-org release', () => {
    const a = pickAsset('win32', 'x64', 'cpu')!;
    expect(assetUrl(a)).toBe(
      `https://github.com/ggml-org/llama.cpp/releases/download/${ENGINE_VERSION}/${a.assetName}`
    );
  });
});
