// @vitest-environment jsdom
// "Show theme background behind pages" (ux review 2, 2026-10-05, U3/U4/U5): when it cannot apply the switch SHOWS off and is
// disabled (never a greyed ON), with a readable note; the saved choice is untouched; and the Pages list pane gets the same glass
// as the page pane while see-through applies.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const theme = vi.hoisted(() => ({ pagesSeeThrough: true, setPagesSeeThrough: vi.fn() }));
// Only the two fields this switch reads are faked; everything else (the page band's colours) stays the real default.
vi.mock('../src/renderer/state/theme-context', async (orig) => {
  const real = await orig<typeof import('../src/renderer/state/theme-context')>();
  return { ...real, useTheme: () => ({ ...real.useTheme(), ...theme }) };
});
const glass = vi.hoisted(() => ({ on: true }));
vi.mock('../src/renderer/components/pages/use-pane-glass', () => ({ usePaneGlass: () => glass.on }));
vi.mock('../src/renderer/components/pages/use-pages', () => ({
  usePages: () => ({ pages: [{ id: 'p1', name: 'Week planner', icon: 'x', pinned: false, home: { kind: 'personal' } }], loaded: true, failed: false }),
  refreshPages: vi.fn().mockResolvedValue(undefined),
  setPagePinned: vi.fn(),
}));

import { GlassSettings } from '../src/renderer/components/appearance/LookSettings';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import { PageHost } from '../src/renderer/components/pages/PageHost';

const wallpaper = { background: { type: 'image', value: 'x.png' }, layout: { 'chrome-style': 'float' } } as any;
const framedWallpaper = { background: { type: 'image', value: 'x.png' } } as any;
const plain = { background: { type: 'solid' } } as any;
function glassRow(active: any, raw: any = active) {
  return render(<GlassSettings active={active} raw={raw} look={{}} set={() => {}} reducedEffects={false} />);
}
const sw = () => screen.getByRole('switch', { name: 'Show theme background behind pages' });

describe('the switch when it cannot apply', () => {
  it('shows saved ON as ON where it works', () => {
    theme.pagesSeeThrough = true;
    glassRow(wallpaper);
    expect(sw()).toBeChecked(); expect(sw()).toBeEnabled();
  });
  it('Framed layout: reads OFF and disabled, says what would work, and leaves the saved choice alone', () => {
    theme.pagesSeeThrough = true; theme.setPagesSeeThrough.mockClear();
    glassRow(framedWallpaper);
    expect(sw()).not.toBeChecked(); expect(sw()).toBeDisabled();
    expect(screen.getByText('Works with the Floating bars or Minimalist layout')).toBeInTheDocument();
    expect(theme.setPagesSeeThrough).not.toHaveBeenCalled();
  });
  it('no wallpaper: reads OFF and disabled with the reason', () => {
    theme.pagesSeeThrough = true;
    glassRow(plain);
    expect(sw()).not.toBeChecked(); expect(sw()).toBeDisabled();
    expect(screen.getAllByText('This theme has no wallpaper').length).toBeGreaterThan(0);
  });
});

describe('the Pages list pane', () => {
  function pane() {
    render(
      <ArtifactProvider value={{ state: { ...initialArtifactState, pageViewOpen: true, pagesViewOpen: false }, dispatch: vi.fn() }}>
        <PageHost settingsOpen={false} onToggleSettings={() => {}} onCreatePage={() => {}} />
      </ArtifactProvider>,
    );
    return document.querySelector('.screen-pane--panel') as HTMLElement;
  }
  it('is glass while see-through applies', () => { glass.on = true; expect(pane()).toHaveClass('panel-glass'); });
  it('stays solid when it does not', () => { glass.on = false; expect(pane()).not.toHaveClass('panel-glass'); });
});
