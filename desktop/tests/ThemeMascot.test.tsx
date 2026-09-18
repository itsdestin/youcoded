// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

// WHY one switchable fake: the two sections need different themes (the default
// look vs Meadow Mist with a picture mascot), and a file-wide vi.mock can hold
// only one fake per module. Each section sets the values it used to hard-code.
const fake = vi.hoisted(() => ({
  theme: null as unknown as { theme: string; reducedEffects: boolean; activeTheme: unknown },
  mascotUrl: null as string | null,
}));
vi.mock('../src/renderer/state/theme-context', () => ({ useTheme: () => fake.theme }));
vi.mock('../src/renderer/hooks/useThemeMascot', () => ({ useThemeMascot: () => fake.mascotUrl }));

import { ThemeMascot, WelcomeAppIcon } from '../src/renderer/components/Icons';
import { setConnectionMode } from '../src/renderer/platform';

describe('default mascot rim by size', () => {
  beforeEach(() => {
    fake.theme = { theme: 'light', reducedEffects: true, activeTheme: null };
    fake.mascotUrl = null;
  });
  afterEach(cleanup);
  it('keeps the rim for default 24px icons', () => {
    const { container } = render(<ThemeMascot variant="welcome" fallback={WelcomeAppIcon} />);
    expect(container.querySelector('span')?.style.getPropertyValue('--default-mascot-rim')).toBe('#263832');
  });
  it.each(['w-16 h-16', 'w-36 h-36'])('omits the small rim for large %s artwork', className => {
    const { container } = render(<ThemeMascot variant="welcome" fallback={WelcomeAppIcon} className={className} small={false} />);
    expect(container.querySelector('span')?.style.getPropertyValue('--default-mascot-rim')).toBe('none');
    expect(container.querySelector('span')?.style.getPropertyValue('--default-mascot-body')).toBe('#DCE5E2');
  });
});

// A theme's mascot picture is a file on the computer, addressed as theme-asset://,
// which a browser connected over remote access cannot load (it showed a broken-image
// box on "No Active Session"). It happened only "sometimes" because the built-in
// themes draw their own mascot and need no file.
describe('a theme mascot picture that cannot be reached', () => {
  beforeEach(() => {
    fake.theme = { theme: 'meadow-mist', reducedEffects: true, activeTheme: { mascot: { welcome: 'theme-asset://meadow-mist/assets/mascot-welcome.svg' } } };
    fake.mascotUrl = 'theme-asset://meadow-mist/assets/mascot-welcome.svg';
  });
  afterEach(() => { cleanup(); setConnectionMode('local'); (window as any).__PLATFORM__ = undefined; });

  const mount = () => render(<ThemeMascot variant="welcome" fallback={WelcomeAppIcon} className="w-36 h-36" small={false} />);

  it('a browser connected to a computer shows the default mascot, not a picture it cannot load', () => {
    setConnectionMode('remote');
    const { container } = mount();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-default-mascot]')).toBeTruthy();
  });

  it('a mascot picture that fails to load falls back to the default mascot, on any platform', () => {
    const { container } = mount();
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('theme-asset://meadow-mist/assets/mascot-welcome.svg');
    fireEvent.error(img!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-default-mascot]')).toBeTruthy();
  });

  it('the Android app still tries the picture: it serves theme files from the phone itself', () => {
    (window as any).__PLATFORM__ = 'android';
    setConnectionMode('remote');
    const { container } = mount();
    expect(container.querySelector('img')).toBeTruthy();
  });
});
