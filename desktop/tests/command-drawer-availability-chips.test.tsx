// @vitest-environment jsdom
// T5 (project-plugin-controls) — the drawer's own availability chips: a
// green/amber chip per installed skill card driven by this conversation's
// FROZEN set (never the project's live setting — Q-2), no chip at all when
// the session has no stored frozen set, the dimmed "missing" card and its
// click-to-Projects route (R14), and the quiet settingsDiffer line (Q-2).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SkillEntry } from '../src/shared/types';

// FavoriteStar renders inside every SkillCard (CommandDrawer always passes a
// `favorite` prop) — counting its renders is the same probe SkillCard.test.tsx
// uses to prove the inner memo actually skipped a render.
const favoriteStarRenders = vi.fn();
vi.mock('../src/renderer/components/marketplace/FavoriteStar', () => ({
  default: (props: { filled: boolean; onToggle: () => void }) => {
    favoriteStarRenders();
    return (
      <button aria-label="favorite" onClick={(e) => { e.stopPropagation(); props.onToggle(); }}>
        {props.filled ? 'filled' : 'empty'}
      </button>
    );
  },
}));

const alpha: SkillEntry = {
  id: 'alpha', displayName: 'Alpha', description: 'a skill', category: 'work',
  prompt: '', source: 'self', type: 'prompt', visibility: 'private',
};
vi.mock('../src/renderer/state/skill-context', () => ({
  useSkills: () => ({
    drawerSkills: [alpha], drawerCommands: [], favorites: [], setFavorite: vi.fn(),
    loadError: null, retryLoad: vi.fn(),
  }),
}));
vi.mock('../src/renderer/state/marketplace-context', () => ({
  useMarketplace: () => ({ skillEntries: [] }),
}));

import CommandDrawer from '../src/renderer/components/CommandDrawer';
import { ArtifactProvider, createArtifactStore } from '../src/renderer/state/ArtifactContext';

beforeAll(() => {
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  }
});
afterEach(() => { cleanup(); delete (window as any).claude; favoriteStarRenders.mockClear(); });

function stubForSession(result: unknown) {
  (window as any).claude = { projectExtensions: { forSession: vi.fn().mockResolvedValue(result) } };
}

const drawerProps = {
  open: true, searchMode: false, sessionId: 's1',
  onSelect: () => {}, onSelectCommand: () => {}, onClose: () => {},
  onOpenManager: () => {}, onOpenMarketplace: () => {},
};

describe('CommandDrawer — availability chips', () => {
  it('shows Automatic for a skill inside the frozen set', async () => {
    stubForSession({ ok: true, projectKey: '/p', frozenSkillIds: ['self:alpha'], frozenMcpIds: [], missing: [], settingsDiffer: false });
    render(<CommandDrawer {...drawerProps} />);
    expect(await screen.findByText('Automatic')).toBeInTheDocument();
  });

  it('shows Manual use for an installed skill outside a real (non-null) frozen set', async () => {
    stubForSession({ ok: true, projectKey: '/p', frozenSkillIds: [], frozenMcpIds: [], missing: [], settingsDiffer: false });
    render(<CommandDrawer {...drawerProps} />);
    expect(await screen.findByText('Manual use')).toBeInTheDocument();
  });

  it('shows no chip at all when the session has no stored frozen set', async () => {
    stubForSession({ ok: true, projectKey: '/p', frozenSkillIds: null, frozenMcpIds: null, missing: [], settingsDiffer: false });
    render(<CommandDrawer {...drawerProps} />);
    await waitFor(() => expect((window as any).claude.projectExtensions.forSession).toHaveBeenCalled());
    expect(screen.queryByText('Automatic')).toBeNull();
    expect(screen.queryByText('Manual use')).toBeNull();
  });

  it('shows the quiet settings-differ line only when the project setting has moved on', async () => {
    stubForSession({ ok: true, projectKey: '/p', frozenSkillIds: ['self:alpha'], frozenMcpIds: [], missing: [], settingsDiffer: true });
    render(<CommandDrawer {...drawerProps} />);
    expect(await screen.findByText(/Project settings changed/)).toBeInTheDocument();
  });

  it('does not show the settings-differ line when settings have not moved on', async () => {
    stubForSession({ ok: true, projectKey: '/p', frozenSkillIds: ['self:alpha'], frozenMcpIds: [], missing: [], settingsDiffer: false });
    render(<CommandDrawer {...drawerProps} />);
    await screen.findByText('Automatic');
    expect(screen.queryByText(/Project settings changed/)).toBeNull();
  });

  it('clicking a missing item card closes the drawer and opens Projects → Skills & tools for its own project', async () => {
    stubForSession({
      ok: true, projectKey: '/p', frozenSkillIds: ['self:alpha'], frozenMcpIds: [], settingsDiffer: false,
      missing: [{ key: 'self:writing-helper', displayName: 'Writing helper', kind: 'personal-skill', projectKey: '/other-project' }],
    });
    const onClose = vi.fn();
    const store = createArtifactStore();
    render(
      <ArtifactProvider store={store}>
        <CommandDrawer {...drawerProps} onClose={onClose} />
      </ArtifactProvider>,
    );
    const card = await screen.findByRole('button', { name: /Writing helper unavailable on this device/ });
    fireEvent.click(card);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(store.getState().projectViewOpen).toBe(true);
    expect(store.getState().openSkillsTabRequest).toEqual({ projectPath: '/other-project', itemKey: 'self:writing-helper' });
  });

  it('a re-render with unchanged availability does not re-render the memoized SkillCard row', async () => {
    stubForSession({ ok: true, projectKey: '/p', frozenSkillIds: ['self:alpha'], frozenMcpIds: [], missing: [], settingsDiffer: false });
    const { rerender } = render(<CommandDrawer {...drawerProps} />);
    await screen.findByText('Automatic');
    favoriteStarRenders.mockClear();
    // CommandDrawer.renderSkillCard always rebuilds `favorite`/`pluginBadge`
    // as fresh closures (SkillCard.tsx's own header comment) — a fresh
    // onSelect below exercises that same instability. `status` must stay a
    // primitive that doesn't reopen it.
    rerender(<CommandDrawer {...drawerProps} onSelect={() => {}} />);
    expect(favoriteStarRenders).not.toHaveBeenCalled();
  });
});
