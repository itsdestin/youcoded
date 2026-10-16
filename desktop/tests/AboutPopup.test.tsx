// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import AboutPopup from '../src/renderer/components/AboutPopup';

// WHY: the selected one-line header must not silently lose version/build data; the
// version lives in the body's last card, under Licenses (Destin, nothing-bare#NB-2).
afterEach(cleanup);

// WHY: desktop and Android share this popup; exercise the actual click handlers
// for both so neither platform falls back to the GitHub reading experience.
it.each(['desktop', 'android'] as const)('opens the website policies on %s', (platformForTest) => {
  const openExternal = vi.fn().mockResolvedValue(undefined);
  (window as any).claude = {
    analytics: { getOptIn: vi.fn().mockResolvedValue(false) },
    shell: { openExternal },
  };
  render(<AboutPopup open onClose={() => {}} platform={platformForTest} version="1.3.1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Privacy policy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Terms of service' }));
  expect(openExternal.mock.calls).toEqual([
    ['https://youcoded.ai/privacy.html'],
    ['https://youcoded.ai/terms.html'],
  ]);
});
it('shows the version in the body\'s last card, not under the About title', () => {
  (window as any).claude = { analytics: { getOptIn: vi.fn().mockResolvedValue(false) } };
  render(<AboutPopup open onClose={() => {}} platform="desktop" version="1.3.1" build="87" />);
  const dialog = screen.getByRole('dialog', { name: 'About' });
  const header = dialog.querySelector('.dialog-header')!;
  const body = dialog.querySelector('.dialog-scroll')!;
  expect(header.textContent).toBe('About');
  expect(body.textContent).toContain('1.3.1');
  expect(body.textContent!.indexOf('1.3.1')).toBeGreaterThan(body.textContent!.indexOf('Licenses'));
});
