// @vitest-environment jsdom
// ThemeScreen's "Build New Theme with Claude" — the M3 handoff calls this "the
// single most visible instance of the gap M3 closes" (§2.3).
//
// It called onSendInput, which App wired straight to guardedPtySend, which
// REFUSES for native sessions — and whose return value was discarded. The button
// did nothing whatsoever: no toast, no message, no session. Routing a COMMAND
// instead reaches the slash dispatcher, which knows how to drive a harness.
//
// Per Q5 (Destin, 2026-07-28) it runs in the CURRENT session, not a new one.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { MarketplaceProvider } from '../src/renderer/state/marketplace-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import ThemeScreen from '../src/renderer/components/ThemeScreen';

beforeEach(() => {
  // jsdom has no ResizeObserver; ThemeScreen's layout hooks construct one.
  (globalThis as any).ResizeObserver ??= class {
    observe() {} unobserve() {} disconnect() {}
  };
  (window as any).claude = {
    skills: {
      list: vi.fn(async () => []), listMarketplace: vi.fn(async () => []),
      getFavorites: vi.fn(async () => []), getChips: vi.fn(async () => []),
      getCuratedDefaults: vi.fn(async () => []), getFeatured: vi.fn(async () => ({ hero: [], rails: [] })),
      install: vi.fn(async () => {}), uninstall: vi.fn(async () => {}), setFavorite: vi.fn(async () => {}),
    },
    commands: { list: vi.fn(async () => []) },
    marketplace: { getPackages: vi.fn(async () => ({})) },
    account: { signedIn: vi.fn(async () => false) },
    marketplaceApi: { install: vi.fn(async () => ({ ok: true, value: {} })) },
    theme: { marketplace: { list: vi.fn(async () => []), install: vi.fn(async () => {}), uninstall: vi.fn(async () => {}) } },
    appearance: { getFavoriteThemes: vi.fn(async () => []), favoriteTheme: vi.fn(async () => {}) },
  };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderScreen(props: Partial<React.ComponentProps<typeof ThemeScreen>>) {
  return render(
    <SkillProvider>
      <MarketplaceProvider>
        <ThemeScreen onClose={() => {}} {...props} />
      </MarketplaceProvider>
    </SkillProvider>,
  );
}

describe('ThemeScreen build button', () => {
  it('routes a COMMAND rather than raw PTY text', () => {
    const onRunCommand = vi.fn();
    const onSendInput = vi.fn();
    renderScreen({ onRunCommand, onSendInput });
    fireEvent.click(screen.getByText(/Build New Theme/i));
    expect(onRunCommand).toHaveBeenCalledWith('/theme-builder');
    // The raw-PTY path must NOT also fire — that is the one native sessions drop.
    expect(onSendInput).not.toHaveBeenCalled();
  });

  it('falls back to onSendInput only when no command handler is wired', () => {
    const onSendInput = vi.fn();
    renderScreen({ onSendInput });
    fireEvent.click(screen.getByText(/Build New Theme/i));
    expect(onSendInput).toHaveBeenCalledWith('/theme-builder ');
  });

  it('still closes the screen either way', () => {
    const onClose = vi.fn();
    renderScreen({ onClose, onRunCommand: vi.fn() });
    fireEvent.click(screen.getByText(/Build New Theme/i));
    expect(onClose).toHaveBeenCalled();
  });
});

// Roadmap (themes, bug 5 of the 2026-07-19 input-migration family): a particle
// preset not in the list showed as unset ("Select…") and was lost on the next
// pick. The theme's own value is now offered as-is, so it stays selected.
describe('particleSelectOptions', () => {
  it('keeps an unlisted preset as a choice, exactly as written', async () => {
    const { particleSelectOptions } = await import('../src/renderer/components/ThemeScreen');
    const opts = particleSelectOptions('sakura');
    expect(opts.map((o) => o.value)).toEqual(['none', 'rain', 'dust', 'ember', 'snow', 'custom', 'sakura']);
    expect(opts.at(-1)).toEqual({ value: 'sakura', label: 'sakura' });
  });
  it('adds nothing for a listed preset or no preset', async () => {
    const { particleSelectOptions } = await import('../src/renderer/components/ThemeScreen');
    expect(particleSelectOptions('snow')).toHaveLength(6);
    expect(particleSelectOptions(undefined)).toHaveLength(6);
    expect(particleSelectOptions('')).toHaveLength(6);
  });
});
