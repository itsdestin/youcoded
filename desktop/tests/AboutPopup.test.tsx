// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import AboutPopup from '../src/renderer/components/AboutPopup';

// WHY: the selected one-line header must not silently lose version/build data; the
// version lives in the body's last card, under Licenses (Destin, nothing-bare#NB-2).
afterEach(cleanup);
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
