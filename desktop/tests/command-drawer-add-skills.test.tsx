// @vitest-environment jsdom
// Skills drawer browse mode — "Add skills" placement and the empty states
// (UI review P-9 #3, 2026-08-27), plus the chip row's shape (P-9 #1).
//
// Before: <AddSkillsCard/> always lived in its OWN grid after the two sections,
// so it started a new row even when the row above had a spare slot — and when
// nothing was installed, that lone dashed card at the far left WAS the empty
// state. Now it is the last card of the last section that is showing, and an
// <EmptyState> with a "Browse the Marketplace" button covers the nothing case.
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import React from 'react';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import type { SkillEntry, CommandEntry } from '../src/shared/types';

// The drawer reads two contexts; stub both so the test owns exactly what is
// installed and what is starred, with no window.claude plumbing.
const ctx = {
  drawerSkills: [] as SkillEntry[],
  favorites: [] as string[],
  drawerCommands: [] as CommandEntry[],
};
vi.mock('../src/renderer/state/skill-context', () => ({
  useSkills: () => ({
    drawerSkills: ctx.drawerSkills,
    drawerCommands: ctx.drawerCommands,
    favorites: ctx.favorites,
    setFavorite: vi.fn(),
  }),
}));
vi.mock('../src/renderer/state/marketplace-context', () => ({
  useMarketplace: () => ({ skillEntries: [] }),
}));

import CommandDrawer from '../src/renderer/components/CommandDrawer';

// jsdom has no ResizeObserver; useScrollFade needs one to mount.
beforeAll(() => {
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});
afterEach(cleanup);

function skill(id: string, category: SkillEntry['category'] = 'work'): SkillEntry {
  return {
    id, displayName: id, description: `${id} description`, category,
    prompt: '', source: 'self', type: 'prompt', visibility: 'private',
  };
}

function renderDrawer() {
  const onClose = vi.fn();
  const onOpenMarketplace = vi.fn();
  const utils = render(
    <CommandDrawer
      open
      searchMode={false}
      onSelect={() => {}}
      onSelectCommand={() => {}}
      onClose={onClose}
      onOpenManager={() => {}}
      onOpenMarketplace={onOpenMarketplace}
    />,
  );
  return { ...utils, onClose, onOpenMarketplace };
}

const addSkillsCard = () => screen.queryByRole('button', { name: /Add skills/ });
// A SkillCard's accessible name starts with its FavoriteStar's label, so find
// the card by its title text and climb to the role=button root.
const skillCard = (name: string) => screen.getByText(name).closest('[role="button"]') as HTMLElement;

describe('CommandDrawer — Add skills joins the grid', () => {
  it('sits in the same grid as the last "All installed" card', () => {
    ctx.drawerSkills = [skill('alpha'), skill('beta'), skill('gamma')];
    ctx.favorites = ['alpha'];
    renderDrawer();
    const add = addSkillsCard()!;
    expect(add).toBeTruthy();
    // gamma sorts last among the non-favorites; Add skills must be its sibling
    // AND the final child of that grid.
    const grid = skillCard('gamma').parentElement!;
    expect(grid.className).toContain('grid');
    expect(add.parentElement).toBe(grid);
    expect(grid.lastElementChild).toBe(add);
    // …and NOT a sibling of the favorites grid.
    expect(skillCard('alpha').parentElement).not.toBe(grid);
    expect(screen.getAllByRole('button', { name: /Add skills/ })).toHaveLength(1);
  });

  it('moves into the Favorites grid when that is the last section showing', () => {
    ctx.drawerSkills = [skill('alpha'), skill('beta')];
    ctx.favorites = ['alpha'];
    renderDrawer();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Favorites only' }));
    const grid = skillCard('alpha').parentElement!;
    expect(addSkillsCard()!.parentElement).toBe(grid);
    expect(grid.lastElementChild).toBe(addSkillsCard());
    expect(screen.queryByText('All installed')).toBeNull();
  });

  it('shows the standard empty state, not a lone card, when nothing is installed', () => {
    ctx.drawerSkills = [];
    ctx.favorites = [];
    const { onClose, onOpenMarketplace } = renderDrawer();
    expect(addSkillsCard()).toBeNull();
    expect(screen.getByText('No skills installed yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Browse the Marketplace' }));
    // Same behaviour Add skills had: close the drawer, open the marketplace.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenMarketplace).toHaveBeenCalledTimes(1);
  });

  it('says "No favorites yet." when favorites-only is on and nothing is starred', () => {
    ctx.drawerSkills = [skill('alpha')];
    ctx.favorites = [];
    renderDrawer();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Favorites only' }));
    expect(screen.getByText('No favorites yet.')).toBeTruthy();
    expect(addSkillsCard()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Browse the Marketplace' })).toBeNull();
  });

  it('names the category when a filter matches nothing, with the marketplace as the way out', () => {
    ctx.drawerSkills = [skill('alpha', 'work')];
    ctx.favorites = [];
    renderDrawer();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Admin' }));
    expect(screen.getByText('No admin skills installed yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Browse the Marketplace' })).toBeTruthy();
    expect(addSkillsCard()).toBeNull();
  });
});

describe('CommandDrawer — chip row (P-9 #1)', () => {
  it('draws the five categories and Favorites-only as one row of FilterChips, Favorites last', () => {
    ctx.drawerSkills = [skill('alpha')];
    ctx.favorites = [];
    renderDrawer();
    const chips = screen.getAllByRole('checkbox');
    expect(chips.map((c) => c.textContent)).toEqual([
      'Personal', 'Work', 'Development', 'Admin', 'Other', '★ Favorites only',
    ]);
    const row = chips[0].parentElement!;
    expect(row.className).toContain('flex-wrap');
    // All six share one parent; Favorites is simply the last chip, not pushed
    // to the far edge with ml-auto.
    for (const c of chips) expect(c.parentElement).toBe(row);
    expect(chips[5].className).not.toContain('ml-auto');
  });

  it('lights Favorites-only exactly like a lit category chip', () => {
    ctx.drawerSkills = [skill('alpha')];
    ctx.favorites = ['alpha'];
    renderDrawer();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Work' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Favorites only' }));
    const work = screen.getByRole('checkbox', { name: 'Work' });
    const fav = screen.getByRole('checkbox', { name: 'Favorites only' });
    expect(work.getAttribute('aria-checked')).toBe('true');
    expect(fav.getAttribute('aria-checked')).toBe('true');
    expect(fav.className).toBe(work.className);
  });
});


// What the drawer leaves out or greys for the kind of chat it is open in (waiting-notice T5).
describe('CommandDrawer — a built-in (YouCoded-runtime) chat', () => {
  const cmd = (name: string, runsIn?: CommandEntry['runsIn']): CommandEntry => ({ name, description: `${name} does a thing`, source: 'youcoded', clickable: true, ...(runsIn ? { runsIn } : {}) });
  const slashSearch = (provider: string | undefined, onSelect = vi.fn(), onSelectCommand = vi.fn()) => render(
    <CommandDrawer open searchMode externalFilter="" provider={provider} onSelect={onSelect} onSelectCommand={onSelectCommand}
      onClose={() => {}} onOpenManager={() => {}} onOpenMarketplace={() => {}} />,
  );

  it('does not offer Claude Code-only commands in a built-in chat, but offers them in a Claude Code chat', () => {
    ctx.drawerCommands = [cmd('/compact', 'both'), cmd('/doctor', 'claude-code'), cmd('/ship')];
    ctx.drawerSkills = [];
    // The drawer lists commands only for a typed search, so type "/does" (each description holds that word).
    const search = (provider: string) => render(
      <CommandDrawer open searchMode externalFilter="does" provider={provider} onSelect={() => {}} onSelectCommand={() => {}}
        onClose={() => {}} onOpenManager={() => {}} onOpenMarketplace={() => {}} />,
    );
    const native = search('native');
    expect(screen.queryByText('/doctor')).toBeNull();
    expect(screen.getByText('/compact')).toBeTruthy();
    expect(screen.getByText('/ship')).toBeTruthy();     // found on disk: unknown until run, so still offered
    native.unmount();
    search('claude');
    expect(screen.getByText('/doctor')).toBeTruthy();
  });

  it('greys a skill that only has plain words to start from, with its reason, and pressing it does nothing', () => {
    ctx.drawerCommands = [];
    ctx.drawerSkills = [
      { ...skill('journal'), prompt: "let's journal" },
      { ...skill('civic'), prompt: '/civic' },
    ];
    const onSelect = vi.fn();
    slashSearch('native', onSelect);
    // browse mode would show both; here the empty search lists everything
    const journal = screen.getByText('journal').closest('[role="button"]') as HTMLElement;
    expect(journal.getAttribute('aria-disabled')).toBe('true');
    expect(journal.textContent).toContain('Not available in YouCoded-runtime sessions yet.');
    fireEvent.click(journal);
    expect(onSelect).not.toHaveBeenCalled();
    const civic = screen.getByText('civic').closest('[role="button"]') as HTMLElement;
    expect(civic.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(civic);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('the same plain-words skill is startable in a Claude Code chat', () => {
    ctx.drawerCommands = [];
    ctx.drawerSkills = [{ ...skill('journal'), prompt: "let's journal" }];
    slashSearch('claude');
    expect((screen.getByText('journal').closest('[role="button"]') as HTMLElement).getAttribute('aria-disabled')).toBeNull();
  });

  it('marks a skill whose instructions can not be read, in either kind of chat, and does not start it', () => {
    ctx.drawerCommands = [];
    ctx.drawerSkills = [{ ...skill('notes'), prompt: '/notes', unreadable: true }];
    for (const provider of ['native', 'claude']) {
      const onSelect = vi.fn();
      const { unmount } = slashSearch(provider, onSelect);
      const card = screen.getByText('notes').closest('[role="button"]') as HTMLElement;
      expect(card.textContent).toContain("Its instructions can't be read. Reinstall it from the marketplace.");
      fireEvent.click(card);
      expect(onSelect).not.toHaveBeenCalled();
      unmount();
    }
  });
});
