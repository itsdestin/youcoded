// @vitest-environment jsdom
// Card #134 round 4: the Connect-your-stuff notices on the marketplace screen:
// "Couldn't connect <name>." and "Couldn't open a setup session." Real MarketplaceScreen + detail page,
// mocked window.claude. Each has a real-failure test and a no-false-alarm test.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen, fireEvent } from '@testing-library/react';

// The stats provider fetches over HTTP; keep its input fixed (same technique as MarketplaceScreen.test.tsx).
const statsState = vi.hoisted(() => ({ value: { loading: false, plugins: {}, themes: {}, error: null as string | null, refresh: () => {}, applyThumbs: () => {}, ensureLoaded: () => {} } }));
vi.mock('../src/renderer/state/marketplace-stats-context', () => {
  const stats = statsState.value;
  return { MarketplaceStatsProvider: ({ children }: { children: React.ReactNode }) => children, useMarketplaceStats: () => stats };
});

import MarketplaceScreen from '../src/renderer/components/marketplace/MarketplaceScreen';
import { MarketplaceProvider } from '../src/renderer/state/marketplace-context';
import { AccountProvider } from '../src/renderer/state/account-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import { installFiringIntersectionObserver } from './helpers/firing-intersection-observer';
import { APP_NOTICE_EVENT } from '../src/renderer/utils/announce';

const toasts = () => { const got: string[] = []; const on = (e: Event) => got.push((e as CustomEvent).detail.message); window.addEventListener(APP_NOTICE_EVENT, on); return { got, off: () => window.removeEventListener(APP_NOTICE_EVENT, on) }; };
let t: ReturnType<typeof toasts>;
const unsupported = Object.assign(new Error('remote-unsupported: integrations:connect'), { code: 'REMOTE_UNSUPPORTED' });
// settle: for negative assertions, let any late toast arrive first.
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

const gmail = (state: Record<string, unknown>) => ({
  slug: 'gmail', displayName: 'Gmail', tagline: 'Your mail', description: 'Mail', status: 'available', iconUrl: '', platforms: [],
  setup: {}, state,
});

function claude(over: { connect?: any; install?: any; create?: any; state?: Record<string, unknown> } = {}) {
  const list = vi.fn().mockResolvedValue([gmail(over.state ?? { installed: true, connected: false })]);
  (window as any).claude = {
    skills: {
      listMarketplace: vi.fn().mockResolvedValue([]), list: vi.fn().mockResolvedValue([]), getFavorites: vi.fn().mockResolvedValue([]),
      getFeatured: vi.fn().mockResolvedValue({ hero: [], rails: [] }), getChips: vi.fn().mockResolvedValue([]), getCuratedDefaults: vi.fn().mockResolvedValue([]),
      setChips: vi.fn(), setOverride: vi.fn(), install: vi.fn(), uninstall: vi.fn(), update: vi.fn(), setFavorite: vi.fn(),
    },
    marketplace: { getPackages: vi.fn().mockResolvedValue({}) },
    account: { signedIn: vi.fn().mockResolvedValue(false), user: vi.fn().mockResolvedValue(null), start: vi.fn(), poll: vi.fn(), signOut: vi.fn() },
    marketplaceApi: { install: vi.fn().mockResolvedValue({ ok: true }) },
    theme: { list: vi.fn().mockResolvedValue([]), marketplace: { list: vi.fn().mockResolvedValue([]), install: vi.fn(), uninstall: vi.fn(), update: vi.fn() } },
    appearance: { getFavoriteThemes: vi.fn().mockResolvedValue([]) },
    integrations: {
      list,
      connect: over.connect ?? vi.fn().mockResolvedValue({}),
      install: over.install ?? vi.fn().mockResolvedValue({}),
      uninstall: vi.fn().mockResolvedValue({}),
    },
    session: { create: over.create ?? vi.fn().mockResolvedValue({ id: 's1' }) },
  };
  return list;
}

async function openGmail() {
  await act(async () => {
    render(
      <AccountProvider pollIntervalMs={10}><SkillProvider><MarketplaceProvider>
        <ArtifactProvider value={{ state: initialArtifactState, dispatch: () => {} }}>
          <MarketplaceScreen onExit={() => {}} settingsOpen={false} onToggleSettings={() => {}} />
        </ArtifactProvider>
      </MarketplaceProvider></SkillProvider></AccountProvider>,
    );
  });
  const card = await vi.waitFor(() => { const c = document.querySelector('[data-marketplace-card="gmail"]'); expect(c).not.toBeNull(); return c as HTMLElement; });
  fireEvent.click(card);
}

beforeEach(() => {
  t = toasts();
  (window as any).matchMedia = (q: string) => ({ matches: false /* wide viewport declared: the integration rail renders */, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  installFiringIntersectionObserver();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { t.off(); cleanup(); delete (window as any).claude; vi.restoreAllMocks(); });

describe('Connect on an integration page', () => {
  it('a rejected connect says "Couldn\'t connect Gmail."', async () => {
    claude({ connect: vi.fn().mockRejectedValue(new Error('oauth broke')) });
    await openGmail();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await vi.waitFor(() => expect(t.got).toEqual(["Couldn't connect Gmail."]));
  });
  it('an answer carrying an error says the same', async () => {
    claude({ connect: vi.fn().mockResolvedValue({ error: 'denied' }) });
    await openGmail();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await vi.waitFor(() => expect(t.got).toEqual(["Couldn't connect Gmail."]));
  });
  it('a connect that works says nothing', async () => {
    const connect = vi.fn().mockResolvedValue({});
    const list = claude({ connect });
    await openGmail();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await vi.waitFor(() => expect(connect).toHaveBeenCalledWith('gmail'));
    await vi.waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2)); // the page re-read the list afterwards
    await settle();
    expect(t.got).toEqual([]);
  });
  it('an "unsupported here" rejection says nothing', async () => {
    const connect = vi.fn().mockRejectedValue(unsupported);
    claude({ connect });
    await openGmail();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());
    await settle();
    expect(t.got).toEqual([]);
  });
});

describe('"Open new setup session" after an install', () => {
  // Install answers with a follow-up command, which shows the setup hint holding the button.
  const withHint = (create: any) => claude({ state: { installed: false, connected: false }, install: vi.fn().mockResolvedValue({ postInstallCommand: '/setup-gmail' }), create });
  async function toHint() {
    await openGmail();
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open new setup session' }));
  }
  it('a rejected create says "Couldn\'t open a setup session."', async () => {
    withHint(vi.fn().mockRejectedValue(new Error('no slots')));
    await toHint();
    await vi.waitFor(() => expect(t.got).toEqual(["Couldn't open a setup session."]));
  });
  it('an answer with no session id says so too', async () => {
    withHint(vi.fn().mockResolvedValue({ error: 'nope' }));
    await toHint();
    await vi.waitFor(() => expect(t.got).toEqual(["Couldn't open a setup session."]));
  });
  it('a created session says nothing', async () => {
    const create = vi.fn().mockResolvedValue({ id: 's9' });
    withHint(create);
    await toHint();
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Set up Gmail' })));
    await settle();
    expect(t.got).toEqual([]);
  });
  it('an "unsupported here" rejection says nothing', async () => {
    const create = vi.fn().mockRejectedValue(unsupported);
    withHint(create);
    await toHint();
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    await settle();
    expect(t.got).toEqual([]);
  });
});
