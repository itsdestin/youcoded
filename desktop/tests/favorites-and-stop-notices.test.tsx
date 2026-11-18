// @vitest-environment jsdom
// Card #134 round 4: marketplace star ("Couldn't change your favorites.") and background-task Stop
// ("Couldn't stop this task."). Real components, mocked window.claude. Each has a real-failure test
// and a no-false-alarm test (success, and an "unsupported here" rejection).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen, fireEvent, waitFor } from '@testing-library/react';
import MarketplaceCard from '../src/renderer/components/marketplace/MarketplaceCard';
import ToolCard from '../src/renderer/components/ToolCard';
import { MarketplaceProvider } from '../src/renderer/state/marketplace-context';
import { MarketplaceStatsProvider, __resetStatsCacheForTests } from '../src/renderer/state/marketplace-stats-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { APP_NOTICE_EVENT } from '../src/renderer/utils/announce';
import type { SkillEntry, ToolCallState, ShellRunView } from '../src/shared/types';

const toasts = () => { const got: string[] = []; const on = (e: Event) => got.push((e as CustomEvent).detail.message); window.addEventListener(APP_NOTICE_EVENT, on); return { got, off: () => window.removeEventListener(APP_NOTICE_EVENT, on) }; };
let t: ReturnType<typeof toasts>;
const unsupported = Object.assign(new Error('remote-unsupported: skills:set-favorite'), { code: 'REMOTE_UNSUPPORTED' });
// settle: for negative assertions, let any late toast arrive first. Awaited promises are already flushed by act().
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

beforeEach(() => { t = toasts(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { t.off(); cleanup(); __resetStatsCacheForTests(); delete (window as any).claude; vi.restoreAllMocks(); });

describe('marketplace card star', () => {
  const skill: SkillEntry = {
    id: 'sample-skill', displayName: 'Sample Skill', description: 'A sample', tagline: 'Quick', author: 'T', category: 'productivity',
    prompt: '/sample', source: 'marketplace', type: 'plugin', visibility: 'published', sourceType: 'url', sourceRef: 'https://github.com/o/r.git',
    components: null, lifeArea: [], tags: [],
  } as any;
  const theme: any = { slug: 'dusk', name: 'Dusk', description: 'd', author: 'T', version: '1.0.0', dark: true, source: 'marketplace', preview: '', tags: [] };

  function claude(over: { setFavorite?: any; favoriteTheme?: any } = {}) {
    (window as any).claude = {
      skills: {
        listMarketplace: vi.fn().mockResolvedValue([]), list: vi.fn().mockResolvedValue([]), getFavorites: vi.fn().mockResolvedValue([]),
        getFeatured: vi.fn().mockResolvedValue({ hero: [], rails: [] }), install: vi.fn().mockResolvedValue({}), uninstall: vi.fn().mockResolvedValue({}),
        setFavorite: over.setFavorite ?? vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue({}),
        getChips: vi.fn().mockResolvedValue([]), setChips: vi.fn().mockResolvedValue(undefined), setOverride: vi.fn().mockResolvedValue(undefined),
        getCuratedDefaults: vi.fn().mockResolvedValue([]),
      },
      marketplace: { getPackages: vi.fn().mockResolvedValue({}) },
      account: { signedIn: vi.fn().mockResolvedValue(false) },
      marketplaceApi: { install: vi.fn().mockResolvedValue({ ok: true }) },
      theme: { marketplace: { list: vi.fn().mockResolvedValue([]), install: vi.fn(), uninstall: vi.fn(), update: vi.fn().mockResolvedValue({ ok: true }) } },
      appearance: { getFavoriteThemes: vi.fn().mockResolvedValue([]), favoriteTheme: over.favoriteTheme ?? vi.fn().mockResolvedValue(undefined) },
    };
  }
  async function card(item: any) {
    await act(async () => {
      render(<SkillProvider><MarketplaceProvider><MarketplaceStatsProvider>
        <MarketplaceCard item={item} onOpen={() => {}} installed={{ id: 'x' } as any} />
      </MarketplaceStatsProvider></MarketplaceProvider></SkillProvider>);
    });
  }
  const star = () => screen.getByLabelText('Favorite');

  it('a plugin star the host refuses says "Couldn\'t change your favorites."', async () => {
    claude({ setFavorite: vi.fn().mockRejectedValue(new Error('disk full')) });
    await card({ kind: 'skill', entry: skill });
    fireEvent.click(star());
    await vi.waitFor(() => expect(t.got).toEqual(["Couldn't change your favorites."]));
  });
  it('a theme star the host refuses says the same', async () => {
    claude({ favoriteTheme: vi.fn().mockRejectedValue(new Error('disk full')) });
    await card({ kind: 'theme', entry: theme });
    fireEvent.click(star());
    await vi.waitFor(() => expect(t.got).toEqual(["Couldn't change your favorites."]));
  });
  it('a star that saves shows nothing', async () => {
    const setFavorite = vi.fn().mockResolvedValue(undefined);
    claude({ setFavorite });
    await card({ kind: 'skill', entry: skill });
    fireEvent.click(star());
    await vi.waitFor(() => expect(setFavorite).toHaveBeenCalledWith('sample-skill', true));
    await vi.waitFor(() => expect(screen.getByLabelText('Unfavorite')).toBeInTheDocument());
    await settle();
    expect(t.got).toEqual([]);
  });
  it('an "unsupported here" rejection shows nothing (the remote shim has its own notice)', async () => {
    const setFavorite = vi.fn().mockRejectedValue(unsupported);
    claude({ setFavorite });
    await card({ kind: 'skill', entry: skill });
    fireEvent.click(star());
    await vi.waitFor(() => expect(setFavorite).toHaveBeenCalled());
    await settle();
    expect(t.got).toEqual([]);
  });
});

describe('background task Stop', () => {
  const run: ShellRunView = { toolUseId: 'toolu_1', shellId: 'sh-1', status: 'running', startedAt: Date.now() - 5000, tail: 'x', logPath: '/tmp/l.txt' };
  const tool = { id: 'x', toolUseId: 'toolu_1', toolName: 'Bash', status: 'complete', input: { command: 'npm run dev', description: 'dev', run_in_background: true }, response: 'ok', shellRun: run } as ToolCallState;
  function open(killShell: () => Promise<unknown>) {
    (window as any).claude = { native: { killShell }, on: {} };
    render(<ChatProvider><ToolCard tool={tool} sessionId="s1" /></ChatProvider>);
    fireEvent.click(screen.getByTestId('tool-card-chevron').closest('button')!);
    fireEvent.click(screen.getByText('Stop'));
  }
  it('a request that fails says "Couldn\'t stop this task." and puts the Stop button back', async () => {
    open(async () => { throw new Error('socket closed'); });
    await vi.waitFor(() => expect(t.got).toEqual(["Couldn't stop this task."]));
    await vi.waitFor(() => expect(screen.getByText('Stop')).toBeInTheDocument());
  });
  it('a host refusal (already finished) is silent and returns the button', async () => {
    const killShell = vi.fn(async () => ({ ok: false, reason: 'not-running' }));
    open(killShell);
    await vi.waitFor(() => expect(killShell).toHaveBeenCalled());
    await vi.waitFor(() => expect(screen.getByText('Stop')).toBeInTheDocument());
    await settle();
    expect(t.got).toEqual([]);
  });
  it('an "unsupported here" rejection is silent', async () => {
    const killShell = vi.fn(async () => { throw unsupported; });
    open(killShell);
    await vi.waitFor(() => expect(killShell).toHaveBeenCalled());
    await vi.waitFor(() => expect(screen.getByText('Stop')).toBeInTheDocument());
    await settle();
    expect(t.got).toEqual([]);
  });
  it('a successful stop request is silent', async () => {
    const killShell = vi.fn(async () => ({ ok: true }));
    open(killShell);
    await vi.waitFor(() => expect(killShell).toHaveBeenCalled());
    await settle();
    expect(t.got).toEqual([]);
  });
});
