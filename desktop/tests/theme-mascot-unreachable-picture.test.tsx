// @vitest-environment jsdom
// Destin, 2026-09-11: a screenshot of "No Active Session" with a broken-image box where Meadow Mist's
// mascot belongs ("also this happens sometimes"). A theme's mascot picture is a file on the computer,
// addressed as theme-asset://, which a browser connected over remote access cannot load. It happened
// only "sometimes" because the built-in themes draw their own mascot and need no file.
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({ theme: 'meadow-mist', reducedEffects: true, activeTheme: { mascot: { welcome: 'theme-asset://meadow-mist/assets/mascot-welcome.svg' } } }),
}));
vi.mock('../src/renderer/hooks/useThemeMascot', () => ({ useThemeMascot: () => 'theme-asset://meadow-mist/assets/mascot-welcome.svg' }));

import { ThemeMascot, WelcomeAppIcon } from '../src/renderer/components/Icons';
import { setConnectionMode } from '../src/renderer/platform';

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
