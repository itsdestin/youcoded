// @vitest-environment jsdom
// "Install updates automatically" store (#183): what the switch shows when the host says no, fails,
// or answers out of order.
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { useAutoInstall, resetAutoInstallStoreForTests } from '../src/renderer/components/BetaChannelToggle';

function Probe() {
  const [enabled, flip] = useAutoInstall();
  return <button onClick={flip}>{enabled === null ? 'hidden' : enabled ? 'on' : 'off'}</button>;
}

function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('useAutoInstall', () => {
  let update: { getAutoInstall: ReturnType<typeof vi.fn>; setAutoInstall: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    cleanup();
    resetAutoInstallStoreForTests();
    update = { getAutoInstall: vi.fn(), setAutoInstall: vi.fn() };
    (window as unknown as { claude: unknown }).claude = { update };
  });

  it('hides the row on supported:false and asks the host only once per page load', async () => {
    update.getAutoInstall.mockResolvedValue({ supported: false });
    const first = render(<Probe />);
    await waitFor(() => expect(update.getAutoInstall).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(screen.getByRole('button').textContent).toBe('hidden');
    first.unmount();
    render(<Probe />);
    await Promise.resolve();
    expect(update.getAutoInstall).toHaveBeenCalledTimes(1);
  });

  it('puts the switch back when a save is rejected', async () => {
    update.getAutoInstall.mockResolvedValue({ supported: true, enabled: true });
    update.setAutoInstall.mockRejectedValue(new Error('config locked'));
    render(<Probe />);
    await screen.findByText('on');
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('on'));
  });

  it('puts the switch back (does not hide it) when a phone gets a reply without supported', async () => {
    update.getAutoInstall.mockResolvedValue({ supported: true, enabled: true });
    update.setAutoInstall.mockResolvedValue({ ok: false, error: 'config locked' });
    render(<Probe />);
    await screen.findByText('on');
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(update.setAutoInstall).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('on'));
  });

  it('ignores an older reply that lands after a newer flip', async () => {
    update.getAutoInstall.mockResolvedValue({ supported: true, enabled: true });
    const slow = deferred<unknown>();
    update.setAutoInstall.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ supported: true, enabled: true });
    render(<Probe />);
    await screen.findByText('on');
    fireEvent.click(screen.getByRole('button'));          // → off, reply pending
    await screen.findByText('off');
    fireEvent.click(screen.getByRole('button'));          // → on, answered at once
    await screen.findByText('on');
    slow.resolve({ supported: true, enabled: false });    // the old flip's reply arrives last
    await Promise.resolve(); await Promise.resolve();
    expect(screen.getByRole('button').textContent).toBe('on');
  });
});
