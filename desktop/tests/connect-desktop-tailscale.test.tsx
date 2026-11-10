// @vitest-environment jsdom
// The phone's Connect to Desktop screen and Tailscale (Destin, 2026-11-10): the warning used to be always on (it asked
// the backend, which cannot see the phone's Tailscale) and let a doomed connection be tapped anyway. It now follows the
// phone app's own answer: off → a firm notice alone (the saved computers and add buttons are hidden), with a way past it; on or unknown → no notice.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ConnectToDesktopButton } from '../src/renderer/components/SettingsPanel';

// The saved computer's row is not a <button> (it carries its own Remove button), so "can it be tapped" is asked the
// honest way: tap it and see whether a connection was attempted.
const connectToHost = vi.fn(async () => {});
vi.mock('../src/renderer/remote-shim', () => ({ connectToHost: (...a: unknown[]) => connectToHost(...(a as [])), disconnectFromHost: async () => {} }));

const saved = [{ name: 'Desktop', host: '100.111.147.124', port: 9900, password: 'x' }];

function open(on: boolean | null) {
  const openTailscale = vi.fn(async () => ({ opened: true }));
  (window as any).claude = {
    android: {
      getPairedDevices: async () => ({ devices: saved }),
      tailscaleStatus: async () => ({ on }),
      openTailscale,
    },
  };
  render(<ConnectToDesktopButton />);
  fireEvent.click(screen.getByText('Connect to Desktop'));
  return { openTailscale };
}
const tapSaved = async () => { fireEvent.click(await screen.findByText('100.111.147.124:9900')); };

afterEach(() => { cleanup(); connectToHost.mockClear(); delete (window as any).claude; });

describe('Connect to Desktop: Tailscale off on the phone', () => {
  it('says so, offers the Tailscale app, and shows nothing that connects', async () => {
    const { openTailscale } = open(false);
    await screen.findByText('Turn on Tailscale to connect');
    // Settle: the saved computers load on their own promise; give them the chance to (wrongly) appear.
    await new Promise((r) => setTimeout(r, 0));
    for (const gone of ['100.111.147.124:9900', 'Saved devices', 'Scan QR code', 'Enter manually']) expect(screen.queryByText(gone)).toBeNull();
    fireEvent.click(screen.getByText('Open Tailscale'));
    expect(openTailscale).toHaveBeenCalledTimes(1);
  });

  it('"Try anyway" lifts it, so a wrong reading never locks anyone out', async () => {
    open(false);
    fireEvent.click(await screen.findByText('Try anyway'));
    expect(screen.queryByText('Turn on Tailscale to connect')).toBeNull();
    expect((screen.getByText('Scan QR code').closest('button') as HTMLButtonElement).disabled).toBe(false);
    await tapSaved();
    await waitFor(() => expect(connectToHost).toHaveBeenCalledWith('100.111.147.124', 9900, 'x'));
  });

  it('clears by itself when the person comes back with Tailscale on', async () => {
    open(false);
    await screen.findByText('Turn on Tailscale to connect');
    (window as any).claude.android.tailscaleStatus = async () => ({ on: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(screen.queryByText('Turn on Tailscale to connect')).toBeNull());
  });
});

describe('Connect to Desktop: Tailscale on, or the phone cannot tell', () => {
  for (const on of [true, null]) {
    it(`shows no warning and blocks nothing (${on})`, async () => {
      open(on);
      await tapSaved();
      await waitFor(() => expect(connectToHost).toHaveBeenCalledTimes(1));
      expect(screen.queryByText('Turn on Tailscale to connect')).toBeNull();
      expect(screen.queryByText('Tailscale not connected')).toBeNull();
    });
  }
});
