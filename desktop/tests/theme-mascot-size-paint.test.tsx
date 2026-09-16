// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ThemeMascot, WelcomeAppIcon } from '../src/renderer/components/Icons';
vi.mock('../src/renderer/state/theme-context', () => ({ useTheme: () => ({ theme: 'light', reducedEffects: true, activeTheme: null }) }));
vi.mock('../src/renderer/hooks/useThemeMascot', () => ({ useThemeMascot: () => null }));
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
