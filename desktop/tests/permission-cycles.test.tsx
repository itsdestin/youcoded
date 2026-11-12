// @vitest-environment jsdom
// The permission chip's cycle for a chat that is not the one in front (hooks/usePermissionCycles.ts): the page's
// chat shows the status bar's own chip for ITS session (Destin, 2026-11-10 review deck).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { cycleTarget, useNativePermissionCycle, usePageChatPermission, usePermissionLatest } from '../src/renderer/hooks/usePermissionCycles';

afterEach(() => { delete (window as any).claude; });

describe('which chat a press on the chip means', () => {
  it('is the chat in front for a click (which passes its event), and the named chat for an id', () => {
    const latest = { current: { activeId: 'front' } };
    expect(cycleTarget({ type: 'click' }, latest)).toBe('front');
    expect(cycleTarget(undefined, latest)).toBe('front');
    expect(cycleTarget('page-chat', latest)).toBe('page-chat');
  });
});

describe('the native cycle, for a named chat', () => {
  it('moves THAT chat to the next mode and stores what the host applied, leaving the chat in front alone', async () => {
    const setPermissionMode = vi.fn(async (_id: string, mode: string) => mode);
    (window as any).claude = { native: { setPermissionMode } };
    let stored = new Map<string, any>([['front', 'full-auto'], ['page-chat', 'ask']]);
    const set = (u: any) => { stored = typeof u === 'function' ? u(stored) : u; };
    const { result } = renderHook(() => {
      const latest = usePermissionLatest({ activeId: 'front', modes: new Map(), nativeModes: stored, models: new Map() });
      return useNativePermissionCycle({ latest, setNativePermissionModes: set, gateFullAuto: (go) => go(), cycleNativeNow: () => false });
    });
    await act(async () => { await result.current('page-chat'); });
    expect(setPermissionMode).toHaveBeenCalledWith('page-chat', 'auto-edit');
    expect(stored.get('page-chat')).toBe('auto-edit');
    expect(stored.get('front')).toBe('full-auto');
  });

  it('asks the first-time warning before Full auto, and keeps the old mode when the host answers something else', async () => {
    (window as any).claude = { native: { setPermissionMode: vi.fn(async () => ({ ok: false })) } };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let stored = new Map<string, any>([['page-chat', 'auto-edit']]);
    const gate = vi.fn((go: () => void) => go());
    const { result } = renderHook(() => {
      const latest = usePermissionLatest({ activeId: null, modes: new Map(), nativeModes: stored, models: new Map() });
      return useNativePermissionCycle({ latest, setNativePermissionModes: (u: any) => { stored = u(stored); }, gateFullAuto: gate, cycleNativeNow: () => false });
    });
    await act(async () => { await result.current('page-chat'); });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(stored.get('page-chat')).toBe('auto-edit');
    vi.restoreAllMocks();
  });
});

describe('the page chat\'s chip', () => {
  const sessionsRef = { current: [{ id: 'n', provider: 'native' }, { id: 'c', provider: 'claude' }, { id: 'sh', provider: 'shell' }] };
  it('shows each chat\'s own mode and runs the matching cycle with that chat\'s id; nothing for a shell or an unknown chat', () => {
    const cycleNative = vi.fn(); const cycleClaude = vi.fn();
    const { result } = renderHook(() => usePageChatPermission({ sessionsRef, cycleNative, cycleClaude,
      modes: new Map([['c', 'plan' as const]]), nativeModes: new Map([['n', 'auto-edit' as const]]) }));
    expect(result.current('n')?.mode).toBe('auto-edit');
    expect(result.current('c')?.mode).toBe('plan');
    result.current('n')?.cycle(); result.current('c')?.cycle();
    expect(cycleNative).toHaveBeenCalledWith('n');
    expect(cycleClaude).toHaveBeenCalledWith('c');
    expect(result.current('sh')).toBeNull();
    expect(result.current('gone')).toBeNull();
  });
});
