// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import AboutPopup from '../src/renderer/components/AboutPopup';

// WHY: the selected one-line header must not silently lose version/build data.
afterEach(cleanup);
it('shows the version above the disclaimer in the body, not under the About title', () => {
  (window as any).claude = { analytics: { getOptIn: vi.fn().mockResolvedValue(false) } };
  render(<AboutPopup open onClose={() => {}} platform="desktop" version="1.3.1" build="87" />);
  const dialog = screen.getByRole('dialog', { name: 'About' });
  const header = dialog.querySelector('.dialog-header')!;
  const body = dialog.querySelector('.dialog-scroll')!;
  expect(header.textContent).toBe('About');
  expect(body.textContent).toContain('1.3.1');
  expect(body.textContent!.indexOf('1.3.1')).toBeLessThan(body.textContent!.indexOf('Disclaimer'));
});
