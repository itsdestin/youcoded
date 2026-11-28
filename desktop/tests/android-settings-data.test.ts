// @vitest-environment jsdom
// Android Settings must not flash "Loading..." each time it opens (Destin, 2026-11-04): its readings are taken once
// at startup, while the panel is still closed, and later opens refresh them quietly (components/android-settings-data.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAndroidSettingsData } from '../src/renderer/components/android-settings-data';

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

describe('Android settings readings', () => {
  let getTier: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    getTier = vi.fn().mockResolvedValue({ tier: 'CORE' });
    (window as any).claude = {
      android: { getTier, getAbout: vi.fn().mockResolvedValue({ version: '1.3.0', build: '21' }) },
      defaults: { get: vi.fn().mockResolvedValue({ skipPermissions: false, model: 'sonnet', projectFolder: '' }) },
    };
  });
  afterEach(() => { vi.useRealTimers(); delete (window as any).claude; });

  it('reads while closed, so the first open is already loaded', async () => {
    const { result, rerender } = renderHook(({ open }) => useAndroidSettingsData(open), { initialProps: { open: false } });
    await flush();
    expect(result.current.loading).toBe(false);
    expect(result.current.aboutInfo).toEqual({ version: '1.3.0', build: '21' });
    rerender({ open: true });
    expect(result.current.loading).toBe(false);
    expect(getTier).toHaveBeenCalledTimes(1);
  });

  it('refreshes on a later open without going back to loading', async () => {
    const { result, rerender } = renderHook(({ open }) => useAndroidSettingsData(open), { initialProps: { open: false } });
    await flush();
    rerender({ open: true }); rerender({ open: false }); rerender({ open: true });
    expect(result.current.loading).toBe(false);
    await act(async () => { vi.advanceTimersByTime(400); });
    await flush();
    expect(getTier).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(false);
  });

  it('stops loading even when a reading fails', async () => {
    getTier.mockRejectedValue(new Error('no answer'));
    const { result } = renderHook(() => useAndroidSettingsData(false));
    await flush();
    expect(result.current.loading).toBe(false);
  });
});
