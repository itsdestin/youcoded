// @vitest-environment jsdom
// Remote access, 2026-09-11 phone pass sweep: screens that load once on mount and swallow a
// failure stayed empty or wrong after one request was lost during a drop ("No skills installed
// yet", "Sign in" for a signed-in user, no default project). Each now asks again after a remote
// reconnect, and a failure is no longer remembered as the answer.
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_RECONNECTED_EVENT } from '../src/renderer/remote-events';

const reconnect = async () => { await act(async () => { window.dispatchEvent(new Event(REMOTE_RECONNECTED_EVENT)); }); };
const flush = async () => { await act(async () => {}); };

beforeEach(() => { vi.resetModules(); (window as any).claude = {}; });

describe('useOnRemoteReconnect', () => {
  it('runs the latest callback on a reconnect, and stops after unmount', async () => {
    const { useOnRemoteReconnect } = await import('../src/renderer/hooks/useOnRemoteReconnect');
    const first = vi.fn(); const second = vi.fn();
    const h = renderHook(({ cb }) => useOnRemoteReconnect(cb), { initialProps: { cb: first } });
    h.rerender({ cb: second });
    await reconnect();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    h.unmount();
    await reconnect();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('screens that load once ask again after a reconnect', () => {
  it('skills and the / commands', async () => {
    const skills = { list: vi.fn(async () => []), getFavorites: vi.fn(async () => []), getChips: vi.fn(async () => []), getCuratedDefaults: vi.fn(async () => []) };
    const commands = { list: vi.fn(async () => []) };
    (window as any).claude = { skills, commands };
    const { SkillProvider, useSkills } = await import('../src/renderer/state/skill-context');
    renderHook(() => useSkills(), { wrapper: ({ children }) => <SkillProvider>{children}</SkillProvider> });
    await flush();
    expect(skills.list).toHaveBeenCalledTimes(1);
    expect(commands.list).toHaveBeenCalledTimes(1);
    await reconnect();
    expect(skills.list).toHaveBeenCalledTimes(2);
    expect(commands.list).toHaveBeenCalledTimes(2);
  });

  it('signed-in state', async () => {
    const account = { signedIn: vi.fn(async () => false), user: vi.fn(async () => null), refresh: vi.fn(async () => null) };
    (window as any).claude = { account };
    const { AccountProvider, useAccount } = await import('../src/renderer/state/account-context');
    const h = renderHook(() => useAccount(), { wrapper: ({ children }) => <AccountProvider>{children}</AccountProvider> });
    await flush();
    expect(account.signedIn).toHaveBeenCalledTimes(1);
    account.signedIn.mockResolvedValue(true as never);
    await reconnect();
    expect(account.signedIn).toHaveBeenCalledTimes(2);
    expect(h.result.current.signedIn).toBe(true);
    h.unmount();
  });

  it('tags, keeping the ones shown when a re-read fails', async () => {
    const tag = { id: 't1', label: 'Work', color: 'blue', archived: false };
    const tags = { list: vi.fn().mockResolvedValueOnce([tag]).mockRejectedValue(new Error('lost')) };
    (window as any).claude = { tags, on: {} };
    const { useTagRegistry } = await import('../src/renderer/hooks/useTagRegistry');
    const h = renderHook(() => useTagRegistry());
    await flush();
    expect(h.result.current.tags).toEqual([tag]);
    await reconnect();
    expect(tags.list).toHaveBeenCalledTimes(2);
    expect(h.result.current.tags).toEqual([tag]);
  });

  it("a session's tags and note", async () => {
    const session = { getMeta: vi.fn(async () => ({ tags: [], flags: {}, note: '' })) };
    (window as any).claude = { session, on: {} };
    const { useSessionMeta } = await import('../src/renderer/hooks/useSessionMeta');
    renderHook(() => useSessionMeta('s1'));
    await flush();
    const before = session.getMeta.mock.calls.length;
    await reconnect();
    expect(session.getMeta.mock.calls.length).toBe(before + 1);
  });

  it("a note typed while a re-read is in flight is not overwritten by that read", async () => {
    let answer!: (m: unknown) => void;
    const session = {
      getMeta: vi.fn()
        .mockResolvedValueOnce({ tags: [], flags: {}, note: 'old' })
        .mockImplementationOnce(() => new Promise((r) => { answer = r; })),
      setNote: vi.fn(async () => ({ ok: true })),
    };
    (window as any).claude = { session, on: {} };
    const { useSessionMeta } = await import('../src/renderer/hooks/useSessionMeta');
    const h = renderHook(() => useSessionMeta('s1'));
    await flush();
    expect(h.result.current.note).toBe('old');
    await reconnect();
    act(() => h.result.current.setNote('typed'));
    await act(async () => { answer({ tags: [], flags: {}, note: 'old' }); });
    expect(h.result.current.note).toBe('typed');
  });

  it("a session's tags and note stay when the reconnect re-read fails", async () => {
    const session = { getMeta: vi.fn().mockResolvedValueOnce({ tags: ['t1'], flags: {}, note: 'hi' }).mockRejectedValue(new Error('lost')) };
    (window as any).claude = { session, on: {} };
    const { useSessionMeta } = await import('../src/renderer/hooks/useSessionMeta');
    const h = renderHook(() => useSessionMeta('s1'));
    await flush();
    await reconnect();
    await flush();
    expect([...h.result.current.tags]).toEqual(['t1']);
    expect(h.result.current.note).toBe('hi');
  });

  it('the platform, which no longer remembers a failed read for the page\'s life', async () => {
    const getPlatform = vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValue('linux');
    (window as any).claude = { getPlatform };
    const { useCurrentPlatform } = await import('../src/renderer/state/platform');
    const h = renderHook(() => useCurrentPlatform());
    await flush();
    expect(h.result.current).toBeNull();
    await reconnect();
    await flush();
    expect(h.result.current).toBe('linux');
  });

  it('provider lists: a failed read is not cached as "no providers", and a reconnect reads again', async () => {
    const providers = { list: vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValue([{ id: 'chatgpt', type: 'chatgpt', label: 'ChatGPT', ready: true }]),
      catalog: vi.fn(async () => [{ id: 'gpt-5.5', providerId: 'chatgpt', label: 'GPT-5.5' }]) };
    (window as any).claude = { providers };
    const mod = await import('../src/renderer/hooks/use-provider-type');
    const h = renderHook(() => mod.useModelProviderType('gpt-5.5'));
    await flush();
    expect(mod.resolveProviderType('gpt-5.5')).toBeNull();
    await reconnect();
    await flush();
    expect(providers.list).toHaveBeenCalledTimes(2);
    expect(h.result.current).toBe('chatgpt');
  });

  it("App's session defaults (App cannot be rendered in a unit test; its wiring is pinned here)", () => {
    const app = readFileSync(resolve(__dirname, '../src/renderer/App.tsx'), 'utf8');
    expect(app).toContain('useOnRemoteReconnect(loadSessionDefaults);');
    expect(app).toMatch(/useEffect\(\(\) => \{ loadSessionDefaults\(\); \}, \[settingsOpen, loadSessionDefaults\]\);/);
  });
});
