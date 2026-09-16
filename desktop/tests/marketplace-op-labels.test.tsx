// @vitest-environment jsdom
/**
 * The marketplace footer names the operation that actually ran — and a failure that
 * came back as an ANSWER counts as a failure.
 *
 * Error inventory 2026-09-10, false message 14. marketplace-context recorded uninstall
 * and update exceptions in the same map, under the same key shape, as installs, and
 * InstallingFooterStrip printed every entry as "Failed to install {label}". Its in-flight
 * line said "Installing" for all three operations too. The refreshes that run AFTER a
 * mutation succeeded sat inside the same try, so a failed drawer refresh reported a
 * working install as failed. And install/update/uninstall mostly RESOLVE their failures
 * (`{ status: 'failed', error }`, `{ ok: false, error }`) — the context never read them,
 * so a failed install looked like nothing at all and still posted install telemetry.
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen, fireEvent } from '@testing-library/react';
import InstallingFooterStrip from '../src/renderer/components/marketplace/InstallingFooterStrip';
import { MarketplaceProvider, useMarketplace } from '../src/renderer/state/marketplace-context';
import { SkillProvider } from '../src/renderer/state/skill-context';

let lastAction: Promise<unknown> = Promise.resolve();
let listFails = false;

function setupWindowClaude(overrides: { install?: any; uninstall?: any; update?: any; signedIn?: boolean } = {}) {
  listFails = false;
  (window as any).claude = {
    skills: {
      listMarketplace: vi.fn().mockResolvedValue([{ id: 'notes', displayName: 'Notes', type: 'plugin' }]),
      // Every list after `listFails` flips rejects — the refresh that follows a mutation.
      list: vi.fn(() => (listFails ? Promise.reject(new Error('list unavailable')) : Promise.resolve([]))),
      getFavorites: vi.fn().mockResolvedValue([]),
      getFeatured: vi.fn().mockResolvedValue({ hero: [], rails: [] }),
      install: overrides.install ?? vi.fn().mockResolvedValue({ status: 'installed', type: 'plugin' }),
      uninstall: overrides.uninstall ?? vi.fn().mockResolvedValue({ type: 'plugin' }),
      update: overrides.update ?? vi.fn().mockResolvedValue({ ok: true }),
      setFavorite: vi.fn().mockResolvedValue(undefined),
      getChips: vi.fn().mockResolvedValue([]),
      setChips: vi.fn().mockResolvedValue(undefined),
      getCuratedDefaults: vi.fn().mockResolvedValue([]),
    },
    marketplace: { getPackages: vi.fn().mockResolvedValue({}) },
    account: { signedIn: vi.fn().mockResolvedValue(overrides.signedIn ?? false) },
    marketplaceApi: { install: vi.fn().mockResolvedValue({ ok: true }) },
    theme: { marketplace: { list: vi.fn().mockResolvedValue([]) } },
    appearance: { getFavoriteThemes: vi.fn().mockResolvedValue([]), favoriteTheme: vi.fn().mockResolvedValue(undefined) },
  };
  return (window as any).claude;
}

function Actions() {
  const mp = useMarketplace();
  // The provider re-throws a failed mutation to its caller; swallow it here so the
  // test observes what the USER sees, which is the footer.
  const run = (p: () => Promise<unknown>) => () => { lastAction = p().catch(() => {}); };
  return (
    <>
      <button onClick={run(() => mp.installSkill('notes'))}>install</button>
      <button onClick={run(() => mp.uninstallSkill('notes'))}>uninstall</button>
      <button onClick={run(() => mp.update('notes', 'skill'))}>update</button>
      <InstallingFooterStrip />
    </>
  );
}

async function renderFooter() {
  await act(async () => {
    render(<SkillProvider><MarketplaceProvider><Actions /></MarketplaceProvider></SkillProvider>);
  });
}

async function press(name: string) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); await lastAction; });
}

describe('InstallingFooterStrip — the words match the operation and its result', () => {
  afterEach(() => { cleanup(); delete (window as any).claude; });

  it('a failed uninstall is reported as an uninstall, without the transport wrapper', async () => {
    setupWindowClaude({ uninstall: vi.fn().mockRejectedValue(new Error("Error invoking remote method 'skills:uninstall': Error: EBUSY: resource busy")) });
    await renderFooter();
    await press('uninstall');

    expect(screen.getByText(/couldn.t uninstall Notes/i)).toBeInTheDocument();
    expect(screen.queryByText(/failed to install/i)).toBeNull();
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
  });

  it('a failed update is reported as an update', async () => {
    setupWindowClaude({ update: vi.fn().mockRejectedValue(new Error('git clone failed: repository not found')) });
    await renderFooter();
    await press('update');

    expect(screen.getByText(/couldn.t update Notes/i)).toBeInTheDocument();
    expect(screen.queryByText(/failed to install/i)).toBeNull();
  });

  it('an install that ANSWERED failed is shown as failed, and is not counted as a download', async () => {
    const claude = setupWindowClaude({
      install: vi.fn().mockResolvedValue({ status: 'failed', error: 'git clone failed: repository not found', type: 'plugin' }),
      signedIn: true,
    });
    await renderFooter();
    await press('install');

    expect(screen.getByText(/couldn.t install Notes: git clone failed/i)).toBeInTheDocument();
    expect(claude.marketplaceApi.install).not.toHaveBeenCalled();
  });

  it('an install that worked is not reported as failed because the refresh after it failed', async () => {
    setupWindowClaude();
    await renderFooter();
    listFails = true;
    await press('install');

    expect(screen.queryByText(/couldn.t install/i)).toBeNull();
    expect(screen.queryByText(/failed to install/i)).toBeNull();
  });

  it('an uninstall in progress says "Uninstalling", not "Installing"', async () => {
    setupWindowClaude({ uninstall: vi.fn(() => new Promise(() => {})) });
    await renderFooter();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'uninstall' })); });

    expect(screen.getByText(/uninstalling/i)).toBeInTheDocument();
    expect(screen.queryByText(/^\s*installing/i)).toBeNull();
  });
});
