// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import PreferencesPopup from '../src/renderer/components/PreferencesPopup';

afterEach(cleanup);

// Destin's N1 on the preferences popup: a write that did not happen is said beside its control and the control goes back.
function setup(set: ReturnType<typeof vi.fn>) {
  (window as any).claude = { settings: { get: vi.fn().mockResolvedValue(undefined), set } };
}
const open = (props: Partial<React.ComponentProps<typeof PreferencesPopup>> = {}) =>
  render(<PreferencesPopup open onClose={() => {}} onOpenAdvanced={() => {}} {...(props as any)} />);

describe('PreferencesPopup failed saves', () => {
  it('a write answered false snaps the toggle back and shows Couldn\'t save, with Try again', async () => {
    const set = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    setup(set);
    open();
    const toggle = await screen.findByRole('switch', { name: 'Show turn duration' });
    const before = toggle.getAttribute('aria-checked');
    await act(async () => { fireEvent.click(toggle); });
    expect(await screen.findByText("Couldn't save the turn duration setting")).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Show turn duration' }).getAttribute('aria-checked')).toBe(before);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    await waitFor(() => expect(screen.queryByText(/Couldn't save/)).toBeNull());
    expect(screen.getByRole('switch', { name: 'Show turn duration' }).getAttribute('aria-checked')).not.toBe(before);
  });

  it('shows nothing when the write succeeds or is only slow', async () => {
    let finish!: (v: boolean) => void;
    setup(vi.fn(() => new Promise<boolean>((r) => { finish = r; })));
    open();
    await act(async () => { fireEvent.click(await screen.findByRole('switch', { name: 'Show turn duration' })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByText(/Couldn't save/)).toBeNull();
    await act(async () => { finish(true); });
    expect(screen.queryByText(/Couldn't save/)).toBeNull();
  });

  it('the notice is gone when the popup is closed and reopened', async () => {
    setup(vi.fn().mockRejectedValue(new Error('locked')));
    const { rerender } = open();
    await act(async () => { fireEvent.click(await screen.findByRole('switch', { name: 'Show turn duration' })); });
    await screen.findByText("Couldn't save the turn duration setting");
    rerender(<PreferencesPopup open={false} onClose={() => {}} onOpenAdvanced={() => {}} />);
    rerender(<PreferencesPopup open onClose={() => {}} onOpenAdvanced={() => {}} />);
    await screen.findByRole('switch', { name: 'Show turn duration' });
    expect(screen.queryByText(/Couldn't save/)).toBeNull();
  });
});
