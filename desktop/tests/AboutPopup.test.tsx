// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

// Destin's N1: a failed save of the usage-stats switch is said inside the popup and the switch goes back.
it('says so, with Try again, when saving the usage stats setting fails, and the switch goes back', async () => {
  const setOptIn = vi.fn().mockRejectedValueOnce(new Error('settings file locked')).mockResolvedValue(undefined);
  (window as any).claude = { analytics: { getOptIn: vi.fn().mockResolvedValue(true), setOptIn } };
  render(<AboutPopup open onClose={() => {}} platform="desktop" version="1.3.1" />);
  const toggle = await screen.findByRole('switch', { name: 'Share anonymous usage stats' });
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(toggle);
  expect(await screen.findByText("Couldn't save the usage stats setting")).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'Share anonymous usage stats' })).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(screen.queryByText(/Couldn't save/)).toBeNull());
  expect(setOptIn).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('switch', { name: 'Share anonymous usage stats' })).toHaveAttribute('aria-checked', 'false');
});

// Review item 3: two quick clicks that both fail must leave the switch at what is really saved.
it('after two quick clicks that both fail, the switch shows the saved value, not the opposite of the last click', async () => {
  const setOptIn = vi.fn().mockRejectedValue(new Error('locked'));
  (window as any).claude = { analytics: { getOptIn: vi.fn().mockResolvedValue(true), setOptIn } };
  render(<AboutPopup open onClose={() => {}} platform="desktop" version="1.3.1" />);
  const name = 'Share anonymous usage stats';
  fireEvent.click(await screen.findByRole('switch', { name }));
  fireEvent.click(screen.getByRole('switch', { name }));
  expect(await screen.findByText("Couldn't save the usage stats setting")).toBeInTheDocument();
  expect(screen.getByRole('switch', { name })).toHaveAttribute('aria-checked', 'true');
});

// Card #134 round 4: a failed READ of the setting used to leave the row missing with no word.
it('says so with Try again when the usage stats setting cannot be read, and the switch appears once it can', async () => {
  const getOptIn = vi.fn().mockRejectedValueOnce(new Error('no answer')).mockResolvedValue(true);
  (window as any).claude = { analytics: { getOptIn, setOptIn: vi.fn() } };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  render(<AboutPopup open onClose={() => {}} platform="desktop" version="1.3.1" />);
  expect(await screen.findByText("Couldn't load the usage stats setting.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('switch', { name: 'Share anonymous usage stats' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.queryByText(/Couldn't load/)).toBeNull();
});
it('shows no read notice when the setting reads fine', async () => {
  (window as any).claude = { analytics: { getOptIn: vi.fn().mockResolvedValue(false) } };
  render(<AboutPopup open onClose={() => {}} platform="desktop" version="1.3.1" />);
  await screen.findByRole('switch', { name: 'Share anonymous usage stats' });
  expect(screen.queryByText(/Couldn't/)).toBeNull();
});
