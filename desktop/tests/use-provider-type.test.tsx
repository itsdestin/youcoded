// @vitest-environment jsdom
// use-provider-type.test.tsx — the renderer's provider-type lookup (Sign in
// with ChatGPT, design §4.9 / review R3-4, 2026-09-05).
//
// WHY: the status bar's plan chips and the /usage card decide whose windows a
// native session spends through this hook. It used to cache the provider and
// catalog lists ONCE per page and never let go, so a session started right
// after signing in to ChatGPT showed no chips until the app reloaded. And it
// resolved by model id alone, which two providers can share (models.dev's
// openai list carries the plan's ids). Three rules pinned here:
//   - the cache invalidates on a ChatGPT status transition (via the card) and
//     after a provider write (via ProvidersSection), and mounted hooks re-read;
//   - a miss for a real id earns exactly ONE refetch, then stays quiet;
//   - the session's OWN providerType wins, and an id two providers share is
//     reported as unknown rather than guessed;
//   - a read that started before a sign-in cannot overwrite the fresh lists;
//   - a destroyed session stops listening.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, act, waitFor, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('../src/renderer/hooks/use-provider-type', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/hooks/use-provider-type')>();
  // A call-through spy: the card and ProvidersSection must CALL it, and the
  // hook tests need the real behaviour behind it.
  return { ...real, invalidateProviderTypeCache: vi.fn(real.invalidateProviderTypeCache) };
});

import { useModelProviderType, resolveProviderType, invalidateProviderTypeCache } from '../src/renderer/hooks/use-provider-type';
import { ChatGptBlock } from '../src/renderer/components/ModelProvidersPopup';
import ProvidersSection from '../src/renderer/components/ProvidersSection';

const invalidateSpy = invalidateProviderTypeCache as unknown as ReturnType<typeof vi.fn>;

const chatgptProvider = { id: 'chatgpt', type: 'chatgpt', label: 'ChatGPT', ready: true, builtIn: true, enabled: true, hasKey: true };
const openaiProvider = { id: 'p-openai', type: 'openai', label: 'My key', ready: true, builtIn: false, enabled: true, hasKey: true };

let providers: any[] = [];
let catalog: any[] = [];
const list = vi.fn(async () => providers);
const catalogFn = vi.fn(async () => catalog);

beforeEach(() => {
  providers = [];
  catalog = [];
  list.mockClear();
  catalogFn.mockClear();
  // mockImplementation survives mockClear, so a test that deferred the reads
  // would leak its pending promises into the next one.
  list.mockImplementation(async () => providers);
  catalogFn.mockImplementation(async () => catalog);
  invalidateSpy.mockClear();
  // Each test starts from an empty cache — the module is shared across them.
  invalidateProviderTypeCache();
  invalidateSpy.mockClear();
  (window as any).localStorage = {
    _s: {} as Record<string, string>,
    getItem(k: string) { return this._s[k] ?? null; },
    setItem(k: string, v: string) { this._s[k] = v; },
    removeItem(k: string) { delete this._s[k]; },
  };
  (window as any).claude = {
    native: { supported: true },
    providers: { list, catalog: catalogFn, upsert: vi.fn(async () => 'p-openai'), remove: vi.fn(async () => true), setKey: vi.fn(async () => true), test: async () => ({ ok: true, message: 'ok' }) },
    models: { installed: async () => [], curated: async () => [], onDownloadProgress: () => () => {} },
    engine: { status: async () => null, onInstallProgress: () => () => {}, onStatusChanged: () => () => {} },
    on: { statusData: () => () => {} },
    off: () => {},
    firstRun: { getState: async () => ({ authMode: 'oauth', currentStep: 'COMPLETE' }) },
    search: { list: async () => [] },
    shell: { openExternal: () => {} },
    chatgpt: { supported: true, status: vi.fn(async () => ({ state: 'signed-out' })), signIn: vi.fn(async () => true), signOut: vi.fn(async () => true), cancelSignIn: vi.fn(async () => true) },
  };
});
afterEach(() => cleanup());

describe('invalidation', () => {
  it('re-reads the lists and updates a mounted hook once the plan appears', async () => {
    const { result } = renderHook(() => useModelProviderType('gpt-5.6'));
    // Empty lists: the id is a miss → one initial load plus the one refetch.
    await waitFor(() => expect(catalogFn).toHaveBeenCalledTimes(2));
    expect(result.current).toBeNull();

    // The user signs in: the plan's rows now exist.
    providers = [chatgptProvider];
    catalog = [{ id: 'gpt-5.6', providerId: 'chatgpt', label: 'GPT-5.6' }];
    act(() => { invalidateProviderTypeCache(); });
    await waitFor(() => expect(result.current).toBe('chatgpt'));
    expect(catalogFn).toHaveBeenCalledTimes(3);
    expect(resolveProviderType('gpt-5.6')).toBe('chatgpt');
  });

  it('is triggered by the ChatGPT card on a status transition', async () => {
    const status = (window as any).claude.chatgpt.status as ReturnType<typeof vi.fn>;
    status.mockResolvedValueOnce({ state: 'waiting' });
    status.mockResolvedValue({ state: 'signed-in', email: 'd@example.com', plan: 'free', usage: null });
    render(<ChatGptBlock />);
    // First read → 'waiting' (a mount, not a transition: no invalidation yet).
    expect(await screen.findByText('Waiting for the browser…')).toBeInTheDocument();
    expect(invalidateSpy).not.toHaveBeenCalled();
    // The 1 s poll sees 'signed-in' → a transition → the cache is dropped.
    // WHY the generous timeout: this waits on a REAL one-second interval, and
    // the suite runs ~170 files in parallel, so a 3 s budget flaked under load.
    // A genuine regression never transitions at all, so it still fails — just
    // eight seconds later instead of three.
    expect(await screen.findByText('Signed in as d@example.com', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it('is triggered by the card after a sign-out resolves', async () => {
    const status = (window as any).claude.chatgpt.status as ReturnType<typeof vi.fn>;
    status.mockResolvedValue({ state: 'signed-in', email: 'd@example.com', plan: 'plus', usage: null });
    render(<ChatGptBlock />);
    const signOut = await screen.findByText('Sign out');
    status.mockResolvedValue({ state: 'signed-out' });
    fireEvent.click(signOut);
    expect(await screen.findByText('Not signed in')).toBeInTheDocument();
    expect((window as any).claude.chatgpt.signOut).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it('is triggered by ProvidersSection after a successful upsert', async () => {
    providers = [openaiProvider];
    render(<ProvidersSection />);
    const toggle = await screen.findByLabelText('Enable My key');
    fireEvent.click(toggle);
    await waitFor(() => expect((window as any).claude.providers.upsert).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledTimes(1));
  });

  it('is NOT triggered when the write fails', async () => {
    providers = [openaiProvider];
    (window as any).claude.providers.upsert = vi.fn(async () => { throw new Error('nope'); });
    render(<ProvidersSection />);
    fireEvent.click(await screen.findByLabelText('Enable My key'));
    expect(await screen.findByText('nope')).toBeInTheDocument();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe('a miss refetches exactly once', () => {
  it('reads the lists twice for an unknown id, then stops', async () => {
    const { result, rerender } = renderHook(({ id }) => useModelProviderType(id), { initialProps: { id: 'no-such-model' } });
    await waitFor(() => expect(catalogFn).toHaveBeenCalledTimes(2));
    expect(result.current).toBeNull();
    // Re-rendering, re-mounting and re-resolving must not read again.
    rerender({ id: 'no-such-model' });
    const again = renderHook(() => useModelProviderType('no-such-model'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(again.result.current).toBeNull();
    expect(catalogFn).toHaveBeenCalledTimes(2);
  });

  it('does not refetch for a null id (a Claude Code session)', async () => {
    renderHook(() => useModelProviderType(null));
    await waitFor(() => expect(catalogFn).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(catalogFn).toHaveBeenCalledTimes(1);
  });
});

// The configuration this is all about: a personal OpenAI API key AND the
// ChatGPT plan, both offering `gpt-5.5`. Whose usage a conversation spends
// cannot be read off the model name — only the session knows.
const bothProviders = () => {
  providers = [openaiProvider, chatgptProvider];
  catalog = [
    { id: 'gpt-5.5', providerId: 'p-openai', label: 'GPT-5.5' },
    { id: 'gpt-5.5', providerId: 'chatgpt', label: 'GPT-5.5' },
  ];
};

describe('a shared model id', () => {
  it("takes the session's own provider, so an API-key session is never called a plan session", async () => {
    bothProviders();
    const key = renderHook(() => useModelProviderType('gpt-5.5', 'openai'));
    const plan = renderHook(() => useModelProviderType('gpt-5.5', 'chatgpt'));
    expect(key.result.current).toBe('openai');
    expect(plan.result.current).toBe('chatgpt');
    expect(resolveProviderType('gpt-5.5', 'openai')).toBe('openai');
    expect(resolveProviderType('gpt-5.5', 'chatgpt')).toBe('chatgpt');
  });

  it('reports nothing rather than guessing when only the model id is known', async () => {
    bothProviders();
    const { result } = renderHook(() => useModelProviderType('gpt-5.5'));
    await waitFor(() => expect(catalogFn).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // Not 'chatgpt': showing the plan's chips and "measured across your whole
    // ChatGPT plan" for a conversation billed to an API key is a wrong number
    // on screen, which is worse than no number.
    expect(result.current).toBeNull();
    expect(resolveProviderType('gpt-5.5')).toBeNull();
  });

  it('still answers when two providers of the SAME kind list it — two OpenRouter keys', async () => {
    // The regression this guards against: a user with two OpenRouter keys (or
    // two OpenAI keys) sees every model twice in the catalog. "Two rows" must
    // not read as "ambiguous" — both rows are the same kind of provider, so
    // there is nothing to be unsure about, and their chips must keep working.
    providers = [
      { id: 'or-1', type: 'openrouter', label: 'Work key', ready: true },
      { id: 'or-2', type: 'openrouter', label: 'Personal key', ready: true },
    ];
    catalog = [
      { id: 'openai/gpt-5.6', providerId: 'or-1', label: 'GPT-5.6' },
      { id: 'openai/gpt-5.6', providerId: 'or-2', label: 'GPT-5.6' },
    ];
    const { result } = renderHook(() => useModelProviderType('openai/gpt-5.6'));
    await waitFor(() => expect(result.current).toBe('openrouter'));
  });

  it('still answers when only one provider lists the id', async () => {
    providers = [openaiProvider];
    catalog = [{ id: 'gpt-5.5', providerId: 'p-openai', label: 'GPT-5.5' }];
    const { result } = renderHook(() => useModelProviderType('gpt-5.5'));
    await waitFor(() => expect(result.current).toBe('openai'));
  });
});

describe('two reads in the air at once', () => {
  it('a read that started before the sign-in cannot restore the pre-sign-in lists', async () => {
    // One sign-in fires three invalidations in about a second and the catalog
    // read can go to the network, so the reads overlap. If the slowest reply
    // won, the app would quietly go back to the lists from before the sign-in
    // and show no plan chips until it was restarted.
    const resolvers: Array<(rows: any[]) => void> = [];
    catalogFn.mockImplementation(() => new Promise<any[]>((res) => { resolvers.push(res); }));
    providers = [chatgptProvider];

    const { result } = renderHook(() => useModelProviderType('gpt-5.6'));
    await waitFor(() => expect(resolvers).toHaveLength(1)); // the pre-sign-in read

    act(() => { invalidateProviderTypeCache(); });          // the sign-in
    await waitFor(() => expect(resolvers).toHaveLength(2)); // the post-sign-in read

    // The post-sign-in read lands FIRST and is the right answer.
    await act(async () => { resolvers[1]([{ id: 'gpt-5.6', providerId: 'chatgpt', label: 'GPT-5.6' }]); });
    await waitFor(() => expect(result.current).toBe('chatgpt'));

    // The slow pre-sign-in read lands second and must change nothing.
    await act(async () => { resolvers[0]([]); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(resolveProviderType('gpt-5.6')).toBe('chatgpt');
    expect(result.current).toBe('chatgpt');
  });

  it('a miss refetch keeps the old answer readable while the new one is in the air', async () => {
    // The /usage card reads the answer synchronously. Blanking it mid-refetch
    // made a ChatGPT session's card show Claude's windows for one round trip.
    providers = [chatgptProvider];
    catalog = [{ id: 'gpt-5.6', providerId: 'chatgpt', label: 'GPT-5.6' }];
    renderHook(() => useModelProviderType('gpt-5.6'));
    await waitFor(() => expect(resolveProviderType('gpt-5.6')).toBe('chatgpt'));

    const resolvers: Array<(rows: any[]) => void> = [];
    catalogFn.mockImplementation(() => new Promise<any[]>((res) => { resolvers.push(res); }));
    // A second session on an id nobody lists yet — that is what triggers the refetch.
    renderHook(() => useModelProviderType('no-such-model'));
    await waitFor(() => expect(resolvers).toHaveLength(1));
    expect(resolveProviderType('gpt-5.6')).toBe('chatgpt');
  });
});

describe('a session that goes away', () => {
  it('stops being told about invalidations', async () => {
    providers = [chatgptProvider];
    catalog = [{ id: 'gpt-5.6', providerId: 'chatgpt', label: 'GPT-5.6' }];
    const { result, unmount } = renderHook(() => useModelProviderType('gpt-5.6'));
    await waitFor(() => expect(result.current).toBe('chatgpt'));
    const before = catalogFn.mock.calls.length;

    unmount();
    act(() => { invalidateProviderTypeCache(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // Nothing re-read the lists — the dead session's callback is gone. Without
    // this, every chat the user closes leaves one behind and each later sign-in
    // does more pointless work than the last.
    expect(catalogFn.mock.calls.length).toBe(before);
  });
});
