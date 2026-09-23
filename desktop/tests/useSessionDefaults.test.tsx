// @vitest-environment jsdom
// The saved new-session defaults a window shows (default model, project folder, …).
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_RECONNECTED_EVENT } from '../src/renderer/remote-events';

const flush = async () => { await act(async () => {}); };

beforeEach(() => { vi.resetModules(); });

describe('useSessionDefaults', () => {
  it('a window that comes back into focus shows defaults another window saved meanwhile', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ skipPermissions: false, model: 'sonnet', projectFolder: '/a' })
      .mockResolvedValue({ skipPermissions: false, model: 'opus', projectFolder: '/b' });
    (window as any).claude = { defaults: { get } };
    const { useSessionDefaults } = await import('../src/renderer/hooks/useSessionDefaults');
    const h = renderHook(() => useSessionDefaults(false));
    await flush();
    expect(h.result.current.projectFolder).toBe('/a');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await flush();
    expect(h.result.current).toMatchObject({ model: 'opus', projectFolder: '/b' });
    h.unmount();
    window.dispatchEvent(new Event('focus'));
    expect(get).toHaveBeenCalledTimes(2);                 // nothing listens after unmount
  });

  it('reads again when Settings closes and after a remote reconnect, and keeps what it had when a read fails', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ skipPermissions: true, model: 'opus', projectFolder: '/a' })
      .mockRejectedValue(new Error('lost'));
    (window as any).claude = { defaults: { get } };
    const { useSessionDefaults } = await import('../src/renderer/hooks/useSessionDefaults');
    const h = renderHook(({ open }) => useSessionDefaults(open), { initialProps: { open: true } });
    await flush();
    h.rerender({ open: false });
    await flush();
    await act(async () => { window.dispatchEvent(new Event(REMOTE_RECONNECTED_EVENT)); });
    await flush();
    expect(get).toHaveBeenCalledTimes(3);
    expect(h.result.current).toMatchObject({ skipPermissions: true, model: 'opus', projectFolder: '/a' });
    h.unmount();
  });

  it('a focus that finds nothing new does not redraw', async () => {
    const same = { skipPermissions: false, model: 'sonnet', projectFolder: '/a' };
    const get = vi.fn(async () => ({ ...same }));
    (window as any).claude = { defaults: { get } };
    const { useSessionDefaults } = await import('../src/renderer/hooks/useSessionDefaults');
    let renders = 0;
    const h = renderHook(() => { renders++; return useSessionDefaults(false); });
    await flush();
    const before = renders;
    const shown = h.result.current;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await flush();
    expect(get).toHaveBeenCalledTimes(2);
    expect(renders).toBe(before);
    expect(h.result.current).toBe(shown);
    h.unmount();
  });
});
