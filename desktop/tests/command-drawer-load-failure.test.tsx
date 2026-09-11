// @vitest-environment jsdom
/**
 * The skills drawer never calls a load it could not finish "No skills installed yet."
 *
 * Error inventory 2026-09-10, false message 10. SkillProvider loads skills.list,
 * getFavorites, getChips and getCuratedDefaults in one Promise.all whose catch only
 * logged — so if any of them failed, `installed` stayed [] for the whole app run and the
 * drawer told someone with skills "No skills installed yet." and sent them to the
 * Marketplace. Nothing retried it short of restarting the app.
 *
 * Drives the REAL SkillProvider and CommandDrawer (command-drawer-add-skills.test.tsx
 * stubs the context, so it cannot see this).
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react';

vi.mock('../src/renderer/state/marketplace-context', () => ({
  useMarketplace: () => ({ skillEntries: [] }),
}));

import CommandDrawer from '../src/renderer/components/CommandDrawer';
import { SkillProvider } from '../src/renderer/state/skill-context';

// jsdom has no ResizeObserver; useScrollFade needs one to mount.
beforeAll(() => {
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  }
});

function stub(list: ReturnType<typeof vi.fn>) {
  (window as any).claude = {
    skills: {
      list,
      getFavorites: vi.fn().mockResolvedValue([]),
      getChips: vi.fn().mockResolvedValue([]),
      getCuratedDefaults: vi.fn().mockResolvedValue([]),
      setFavorite: vi.fn().mockResolvedValue(undefined),
    },
  };
}

async function renderDrawer() {
  await act(async () => {
    render(
      <SkillProvider>
        <CommandDrawer open searchMode={false} onSelect={() => {}} onClose={() => {}} onOpenMarketplace={() => {}} />
      </SkillProvider>,
    );
  });
}

describe('CommandDrawer — a skills load that failed is not "No skills installed yet."', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (window as any).claude;
  });

  it('says it could not load the skills, with Retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stub(vi.fn().mockRejectedValue(new Error("Error invoking remote method 'skills:list': Error: EACCES: permission denied")));
    await renderDrawer();

    expect(await screen.findByText(/couldn.t load your skills/i)).toBeInTheDocument();
    expect(screen.queryByText('No skills installed yet.')).toBeNull();
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
  });

  it('Retry loads again, and a real empty result may then say "No skills installed yet."', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const list = vi.fn().mockRejectedValueOnce(new Error('not readable')).mockResolvedValue([]);
    stub(list);
    await renderDrawer();

    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Retry' })); });
    expect(await screen.findByText('No skills installed yet.')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });
});
