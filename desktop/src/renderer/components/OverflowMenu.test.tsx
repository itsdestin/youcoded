// @vitest-environment jsdom
//
// Pins the reachability guarantee this component exists to provide. The bug it
// replaces: the gamepad button was `hidden sm:block` and TOGGLE_PANEL had
// exactly ONE caller in the entire renderer, so below 640px Games was
// unreachable — an incoming challenge could never be answered on a phone.
// Any future change that drops a row from this menu without adding another
// entry point for it should fail here.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import OverflowMenu from './OverflowMenu';
import { ArtifactContext } from '../state/ArtifactContext';

function renderMenu(props: Partial<React.ComponentProps<typeof OverflowMenu>> = {}, dispatch = vi.fn()) {
  // sessionArtifacts / drawerOpenBySession are read by the artifacts row.
  const value = { state: { sessionArtifacts: {}, drawerOpenBySession: {} } as any, dispatch };
  return {
    dispatch,
    ...render(
      <ArtifactContext.Provider value={value as any}>
        <OverflowMenu
          activeSessionId="s1"
          onToggleSettings={vi.fn()}
          onToggleGamePanel={vi.fn()}
          gamePanelOpen={false}
          {...props}
        />
      </ArtifactContext.Provider>,
    ),
  };
}

const openMenu = () => fireEvent.click(screen.getByLabelText('Open menu'));

describe('OverflowMenu', () => {
  beforeEach(() => cleanup());

  it('is collapsed until the ||| button is clicked', () => {
    renderMenu();
    expect(screen.queryByRole('menu')).toBeNull();
    openMenu();
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('exposes all four collapsed destinations', () => {
    renderMenu();
    openMenu();
    const labels = screen.getAllByRole('menuitem').map((b) => b.textContent ?? '');
    expect(labels.some((l) => l.includes('Settings'))).toBe(true);
    expect(labels.some((l) => l.includes('Projects'))).toBe(true);
    // The reachability regression this file guards.
    // Renamed with the arcade (§4.1): the row opens a four-game pane now.
    expect(labels.some((l) => l.includes('Games'))).toBe(true);
    // Joined the menu when the toggle took over the right cluster.
    expect(labels.some((l) => l.includes('Session Files'))).toBe(true);
  });

  it('toggles the session-artifacts drawer for the active session', () => {
    const dispatch = vi.fn();
    renderMenu({ activeSessionId: 's1' }, dispatch);
    openMenu();
    fireEvent.click(screen.getByText(/Session Files/).closest('button')!);
    expect(dispatch).toHaveBeenCalledWith({ type: 'DRAWER_OPENED', sessionId: 's1' });
  });

  // Inverted 2026-07-23: this used to pin "Session artifacts" and forbid the
  // word "Files". Destin renamed it to "Session Files", so the guard now runs
  // the other way — the rename shouldn't silently drift back.
  it('says "Session Files", not the older "Session artifacts" wording', () => {
    renderMenu();
    openMenu();
    const labels = screen.getAllByRole('menuitem').map((b) => b.textContent ?? '');
    expect(labels.some((l) => /Session Files/.test(l))).toBe(true);
    expect(labels.some((l) => /artifacts/i.test(l))).toBe(false);
  });

  it('reaches the game panel — the toggle that had no other caller on narrow', () => {
    const onToggleGamePanel = vi.fn();
    renderMenu({ onToggleGamePanel });
    openMenu();
    fireEvent.click(screen.getByText(/Games/).closest('button')!);
    expect(onToggleGamePanel).toHaveBeenCalledTimes(1);
  });

  it('opens the project view via PROJECT_VIEW_OPENED', () => {
    const dispatch = vi.fn();
    renderMenu({}, dispatch);
    openMenu();
    fireEvent.click(screen.getByText('Projects').closest('button')!);
    expect(dispatch).toHaveBeenCalledWith({ type: 'PROJECT_VIEW_OPENED' });
  });

  it('closes after choosing an item', () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByText('Settings').closest('button')!);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  // Collapsing the header must not swallow the "something needs attention"
  // signal that the cog and the gamepad each carried on their own.
  it('surfaces a collapsed danger badge on the ||| button', () => {
    const { container } = renderMenu({ settingsDangerBadge: true });
    expect(container.querySelector('.bg-red-500')).toBeTruthy();
  });

  it('surfaces a pending challenge on the ||| button', () => {
    const { container } = renderMenu({ challengePending: true });
    expect(container.querySelector('.bg-amber-700')).toBeTruthy();
  });

  it('prefers the danger badge over a pending challenge', () => {
    const { container } = renderMenu({ settingsDangerBadge: true, challengePending: true });
    expect(container.querySelector('.bg-red-500')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Open menu"] .bg-orange-400')).toBeNull();
  });
});
