// @vitest-environment jsdom
// T5 (project-plugin-controls) — CommandDrawer's own gated fetch must never
// ask the main process while the drawer is closed (design §5's own demand
// rule, same as the sibling useMarketplace(open)), must ignore a slow
// response once a newer request has started, and must hide chips (return
// null) rather than guess when the backend can't really answer.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSessionAvailability } from './useSessionAvailability';

function stubForSession(impl: (sessionId: string) => Promise<unknown>) {
  (window as any).claude = { projectExtensions: { forSession: vi.fn(impl) } };
}

afterEach(() => { delete (window as any).claude; });

describe('useSessionAvailability', () => {
  it('makes zero calls while the drawer is closed, even across a session switch', () => {
    const forSession = vi.fn().mockResolvedValue({ ok: true, projectKey: '/p', frozenSkillIds: [], frozenMcpIds: [], missing: [], settingsDiffer: false });
    (window as any).claude = { projectExtensions: { forSession } };
    const { rerender } = renderHook(({ sessionId }) => useSessionAvailability(sessionId, false), {
      initialProps: { sessionId: 's1' },
    });
    rerender({ sessionId: 's2' });
    rerender({ sessionId: 's3' });
    expect(forSession).not.toHaveBeenCalled();
  });

  it('fetches once the drawer opens, and again when the session id changes while open', async () => {
    const forSession = vi.fn().mockResolvedValue({ ok: true, projectKey: '/p', frozenSkillIds: ['a'], frozenMcpIds: [], missing: [], settingsDiffer: false });
    (window as any).claude = { projectExtensions: { forSession } };
    const { rerender } = renderHook(({ sessionId, open }) => useSessionAvailability(sessionId, open), {
      initialProps: { sessionId: 's1', open: false },
    });
    expect(forSession).not.toHaveBeenCalled();
    rerender({ sessionId: 's1', open: true });
    await waitFor(() => expect(forSession).toHaveBeenCalledTimes(1));
    expect(forSession).toHaveBeenCalledWith('s1');
    rerender({ sessionId: 's2', open: true });
    await waitFor(() => expect(forSession).toHaveBeenCalledTimes(2));
    expect(forSession).toHaveBeenLastCalledWith('s2');
  });

  it('ignores a slow response once a newer request has already started', async () => {
    let resolveFirst!: (v: unknown) => void;
    const responses: Record<string, Promise<unknown>> = {
      s1: new Promise((res) => { resolveFirst = res; }),
      s2: Promise.resolve({ ok: true, projectKey: '/p2', frozenSkillIds: ['fresh'], frozenMcpIds: [], missing: [], settingsDiffer: false }),
    };
    stubForSession((sessionId) => responses[sessionId]);
    const { result, rerender } = renderHook(({ sessionId }) => useSessionAvailability(sessionId, true), {
      initialProps: { sessionId: 's1' },
    });
    rerender({ sessionId: 's2' });
    await waitFor(() => expect(result.current?.frozenSkillIds).toEqual(['fresh']));
    // The slow s1 response lands AFTER s2's — it must not overwrite it.
    resolveFirst({ ok: true, projectKey: '/p1', frozenSkillIds: ['stale'], frozenMcpIds: [], missing: [], settingsDiffer: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current?.frozenSkillIds).toEqual(['fresh']);
  });

  it('hides chips (returns null) when the backend answers not-implemented-on-mobile', async () => {
    stubForSession(async () => ({ ok: false, error: 'not-implemented-on-mobile' }));
    const { result } = renderHook(() => useSessionAvailability('s1', true));
    await waitFor(() => expect((window as any).claude.projectExtensions.forSession).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('hides chips (returns null) on any other error, never guessing', async () => {
    stubForSession(async () => ({ ok: false, error: 'boom' }));
    const { result } = renderHook(() => useSessionAvailability('s1', true));
    await waitFor(() => expect((window as any).claude.projectExtensions.forSession).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('passes through a real (including empty) frozen set, missing rows and settingsDiffer', async () => {
    stubForSession(async () => ({
      ok: true, projectKey: '/p', frozenSkillIds: [], frozenMcpIds: [],
      missing: [{ key: 'self:writing-helper', displayName: 'Writing helper', kind: 'personal-skill', projectKey: '/p' }],
      settingsDiffer: true,
    }));
    const { result } = renderHook(() => useSessionAvailability('s1', true));
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toEqual({
      frozenSkillIds: [],
      missing: [{ key: 'self:writing-helper', displayName: 'Writing helper', kind: 'personal-skill', projectKey: '/p' }],
      settingsDiffer: true,
    });
  });
});
