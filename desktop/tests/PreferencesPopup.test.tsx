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

  // Review item 2: text fields never snap back while the person is typing, and are saved on blur or after a pause.
  it('typing in a text field during a failing save keeps the typed text; Try again sends the text as it is NOW', async () => {
    const set = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(true);
    setup(set);
    open();
    const box = await screen.findByRole('textbox', { name: 'Output style' }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'concise' } });
    await act(async () => { fireEvent.blur(box); });                       // blur saves at once
    expect(await screen.findByText("Couldn't save the output style")).toBeInTheDocument();
    expect((screen.getByRole('textbox', { name: 'Output style' }) as HTMLInputElement).value).toBe('concise'); // not wiped
    fireEvent.change(screen.getByRole('textbox', { name: 'Output style' }), { target: { value: 'concise and kind' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    await waitFor(() => expect(screen.queryByText(/Couldn't save/)).toBeNull());
    expect(set).toHaveBeenLastCalledWith('outputStyle', 'concise and kind');
  });

  it('saves text after a pause, not on every keystroke', async () => {
    vi.useFakeTimers();
    try {
      const set = vi.fn().mockResolvedValue(true);
      setup(set);
      open();
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      const box = screen.getByRole('textbox', { name: 'System prompt' });
      for (const v of ['a', 'ab', 'abc']) fireEvent.change(box, { target: { value: v } });
      expect(set).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(900); });
      expect(set).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledWith('systemPrompt', 'abc');
    } finally { vi.useRealTimers(); }
  });

  // Review item 4: Try again sends the control's CURRENT value.
  it('Try again after a failed toggle sends the value the switch is showing now, not the old failed one', async () => {
    const set = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    setup(set);
    open();
    const toggle = await screen.findByRole('switch', { name: 'Reduced motion' });
    await act(async () => { fireEvent.click(toggle); });                    // fails, snaps back to off
    await screen.findByText("Couldn't save the reduced motion setting");
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    expect(set).toHaveBeenLastCalledWith('preferReducedMotion', true);
  });

  // Review item 6: the notice sits directly under the control that failed.
  it('puts a failed toggle\'s notice directly under that toggle, not at the end of the group', async () => {
    setup(vi.fn().mockResolvedValue(false));
    open();
    await act(async () => { fireEvent.click(await screen.findByRole('switch', { name: 'Show turn duration' })); });
    const notice = await screen.findByText("Couldn't save the turn duration setting");
    const row = screen.getByRole('switch', { name: 'Show turn duration' }).closest('[class]')!;
    // the next row after the failed one is the notice, before "Show per-turn metadata"
    const all = Array.from(document.querySelectorAll('section.space-y-2 > *'));
    const rowIdx = all.findIndex((el) => el.contains(screen.getByRole('switch', { name: 'Show turn duration' })));
    expect(all[rowIdx + 1].contains(notice)).toBe(true);
    void row;
  });
});
