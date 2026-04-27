// @vitest-environment jsdom
// Fix: pin jsdom here because vitest.config.ts only auto-applies jsdom to
// tests under `tests/**/*.tsx`; this file lives under `src/**/*.test.ts`
// and would otherwise run in the default `node` env with no `window`.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePerformanceConfig } from './usePerformanceConfig';

const mockGet = vi.fn();
const mockSet = vi.fn();
const mockRestart = vi.fn();

beforeEach(() => {
  mockGet.mockReset();
  mockSet.mockReset();
  mockRestart.mockReset();
  // Fix: use Object.defineProperty to add window.claude to the existing jsdom
  // window rather than replacing the entire window object. The plan's
  // `(globalThis).window = { claude: ... }` pattern destroys document.body,
  // which breaks @testing-library/react's waitFor container checks.
  Object.defineProperty(window, 'claude', {
    value: {
      performance: { get: mockGet, set: mockSet },
      app: { restart: mockRestart },
    },
    writable: true,
    configurable: true,
  });
});

describe('usePerformanceConfig', () => {
  it('loads config on mount', async () => {
    mockGet.mockResolvedValue({
      preferPowerSaving: false,
      appliedAtLaunch: false,
      multiGpuDetected: true,
      gpuList: ['Intel Iris Xe', 'NVIDIA RTX 4070'],
    });
    const { result } = renderHook(() => usePerformanceConfig());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.saved).toBe(false);
    expect(result.current.appliedAtLaunch).toBe(false);
    expect(result.current.multiGpuDetected).toBe(true);
    expect(result.current.gpuList).toEqual(['Intel Iris Xe', 'NVIDIA RTX 4070']);
  });

  it('setPreferPowerSaving updates saved optimistically and persists', async () => {
    mockGet.mockResolvedValue({
      preferPowerSaving: false, appliedAtLaunch: false,
      multiGpuDetected: true, gpuList: ['A', 'B'],
    });
    mockSet.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => usePerformanceConfig());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    await act(async () => { await result.current.setPreferPowerSaving(true); });

    expect(result.current.saved).toBe(true);
    expect(mockSet).toHaveBeenCalledWith(true);
  });

  it('setPreferPowerSaving reverts saved on persistence failure', async () => {
    mockGet.mockResolvedValue({
      preferPowerSaving: false, appliedAtLaunch: false,
      multiGpuDetected: true, gpuList: ['A', 'B'],
    });
    mockSet.mockRejectedValue(new Error('disk full'));
    const { result } = renderHook(() => usePerformanceConfig());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    await act(async () => {
      await expect(result.current.setPreferPowerSaving(true)).rejects.toThrow();
    });

    expect(result.current.saved).toBe(false);
  });

  it('needsRestart is true when saved !== appliedAtLaunch', async () => {
    mockGet.mockResolvedValue({
      preferPowerSaving: true, appliedAtLaunch: false,
      multiGpuDetected: true, gpuList: ['A', 'B'],
    });
    const { result } = renderHook(() => usePerformanceConfig());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.needsRestart).toBe(true);
  });

  it('restart() calls window.claude.app.restart', async () => {
    mockGet.mockResolvedValue({
      preferPowerSaving: false, appliedAtLaunch: false,
      multiGpuDetected: true, gpuList: ['A', 'B'],
    });
    const { result } = renderHook(() => usePerformanceConfig());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => { await result.current.restart(); });
    expect(mockRestart).toHaveBeenCalled();
  });
});
