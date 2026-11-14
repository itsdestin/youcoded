// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { usePerformanceConfig } from '../src/renderer/hooks/usePerformanceConfig';

afterEach(() => { cleanup(); delete (window as any).claude; });

const snapshot = { preferPowerSaving: false, appliedAtLaunch: false, multiGpuDetected: true, gpuList: ['a'] };
const deferred = () => { let resolve!: () => void; let reject!: (e: unknown) => void; const promise = new Promise<void>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

describe('usePerformanceConfig toggles', () => {
  it('two quick toggles that both fail put the toggle back at the value that is really saved', async () => {
    (window as any).claude = { performance: { get: vi.fn().mockResolvedValue(snapshot), set: vi.fn().mockRejectedValue(new Error('locked')) } };
    const { result } = renderHook(() => usePerformanceConfig());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      const a = result.current.setPreferPowerSaving(true).catch(() => {});
      const b = result.current.setPreferPowerSaving(false).catch(() => {});
      await Promise.all([a, b]);
    });
    expect(result.current.saved).toBe(false); // the old code reverted to "the opposite of the last request" and could land on true
  });

  it('an older save that succeeds after a newer one failed leaves the toggle at what is on disk', async () => {
    const first = deferred();
    const set = vi.fn().mockReturnValueOnce(first.promise).mockRejectedValue(new Error('locked'));
    (window as any).claude = { performance: { get: vi.fn().mockResolvedValue(snapshot), set } };
    const { result } = renderHook(() => usePerformanceConfig());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    let a!: Promise<void>; let b!: Promise<void>;
    await act(async () => {
      a = result.current.setPreferPowerSaving(true);
      b = result.current.setPreferPowerSaving(false).catch(() => {}) as Promise<void>;
      await b;
    });
    await act(async () => { first.resolve(); await a; });
    expect(result.current.saved).toBe(true); // disk says true
  });
});
