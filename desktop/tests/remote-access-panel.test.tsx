// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type RemoteAccessView } from '../src/renderer/components/remote/preview-types';
import { RemoteAccessMockPanel } from '../src/renderer/components/SettingsPanel';

afterEach(cleanup);
const address = 'https://home-laptop.example-tailnet.ts.net';
function mount(stage: RemoteAccessView['stage'], prerequisite?: RemoteAccessView['prerequisite']) {
  const onAction = vi.fn();
  const view: RemoteAccessView = {
    stage, address, prerequisite,
    devices: [{ id: 'phone', name: 'My phone', online: true }, { id: 'tablet', name: 'My tablet', online: false }],
  };
  render(<RemoteAccessMockPanel view={view} onAction={onAction} />);
  return onAction;
}

it('preserves the panel: enabled, password, keep awake, full-width Add Device and Info', () => {
  mount('ready');
  expect(screen.getByRole('switch', { name: 'Remote access server enabled' })).toBeTruthy();
  const password = screen.getByLabelText('Remote access password');
  fireEvent.change(password, { target: { value: 'preview-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set' }));
  expect((password as HTMLInputElement).value).toBe('');
  for (const name of ['Off', '1h', '4h', '8h', '24h']) expect(screen.getByRole('tab', { name })).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: '8h' }));
  expect(screen.getByRole('tab', { name: '8h' }).getAttribute('aria-selected')).toBe('true');
  const add = screen.getByRole('button', { name: 'Add Device' });
  expect(add.className).toContain('w-full');
  fireEvent.click(add);
  // The address appears in the Tailscale section AND in the Add Device panel, and the two
  // must be the same string. A tester was shown a bare IP in one place and a tailnet
  // hostname in the other, with nothing saying they were the same machine.
  const shown = screen.getAllByText(address);
  expect(shown.length).toBeGreaterThanOrEqual(2);
});

it('draws every setup stage with the banner it already has, never a bespoke panel', () => {
  // WHY these three assertions: round-2 review rejected a replacement screen. A stage is a
  // status strip, a warning callout or an ErrorState — the shapes the banner already uses.
  const setup = mount('setup');
  expect(screen.getByText('Not set up yet.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
  expect(setup).toHaveBeenCalledWith({ type: 'consent' });
  cleanup();

  mount('checking');
  expect(screen.getByText(/Checking this computer/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve and continue' })).toBeNull();
});

it('names the missing prerequisite instead of one generic setup button', () => {
  const install = mount('setup', 'not-installed');
  fireEvent.click(screen.getByRole('button', { name: 'Install Tailscale' }));
  expect(install).toHaveBeenCalledWith({ type: 'prerequisite' });
  cleanup();
  const signIn = mount('setup', 'sign-in-required');
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(signIn).toHaveBeenCalledWith({ type: 'prerequisite' });
});

it('keeps browser encryption behind its own screen, and explains it there', () => {
  // Destin, round 4: "this whole browser protection menu should be hidden behind a second
  // level popup". The main panel shows a row and its state, nothing more.
  const action = mount('ready');
  expect(screen.getByText('Advanced')).toBeTruthy();
  expect(screen.queryByText(/public list of issued certificates/)).toBeNull();

  fireEvent.click(screen.getByText('Browser encryption'));

  // The gain is named concretely, because "more secure" would be false: both levels are
  // encrypted. The cost is stated as permanent, and the website step before it is taken.
  expect(screen.getByText(/already private either way/)).toBeTruthy();
  expect(screen.getByText(/microphone, copy buttons and the font picker/)).toBeTruthy();
  expect(screen.getByText(/cannot be undone/i)).toBeTruthy();
  expect(screen.getByText(/public list of issued certificates/)).toBeTruthy();
  expect(screen.getByText(/YouCoded cannot\s+do that part for you/)).toBeTruthy();

  fireEvent.click(screen.getByRole('switch', { name: 'Browser encryption' }));
  expect(action).toHaveBeenCalledWith({ type: 'advanced' });
});

it('keeps offline devices, marks them, and confirms unpairing before acting', () => {
  const action = mount('ready');
  expect(screen.getByText('Offline')).toBeTruthy();
  // WHY: the shipped row hardcodes a green dot for every connected client. Only the online
  // device and the panel's own ready dot may be green — never the remembered offline device.
  expect(document.querySelectorAll('.bg-green-500').length).toBe(2);
  fireEvent.click(screen.getByRole('button', { name: 'Unpair My tablet' }));
  expect(action).not.toHaveBeenCalled();
  expect(screen.getByText(/pair again/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm unpair' }));
  expect(action).toHaveBeenCalledWith({ type: 'revoke', deviceId: 'tablet' });
  expect(screen.queryByText('Skip password on Tailscale')).toBeNull();
});

it('reports a failed check without inventing a cause', () => {
  const action = mount('conflict');
  expect(screen.getByText(/another service/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(action).toHaveBeenCalledWith({ type: 'check' });
  cleanup();
  mount('error');
  expect(screen.getByRole('button', { name: 'Report bug' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Diagnose with the assistant' })).toBeTruthy();
});
