// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { APP_NOTICE_EVENT } from '../src/renderer/utils/announce';
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
    // the next row after the failed one is the notice, before "Show per-turn metadata"
    const all = Array.from(document.querySelectorAll('section.space-y-2 > *'));
    const rowIdx = all.findIndex((el) => el.contains(screen.getByRole('switch', { name: 'Show turn duration' })));
    expect(all[rowIdx + 1].contains(notice)).toBe(true);
  });

  // Second review: text typed inside the pause is not lost when the popup closes, the app closes, or it is reopened quickly.
  describe('text still pending when the popup goes away', () => {
    const notices = () => { const got: string[] = []; const on = (e: Event) => got.push((e as CustomEvent).detail.message); window.addEventListener(APP_NOTICE_EVENT, on); return { got, off: () => window.removeEventListener(APP_NOTICE_EVENT, on) }; };
    const typeAndClose = async (set: ReturnType<typeof vi.fn>) => {
      setup(set);
      const view = open();
      const box = await screen.findByRole('textbox', { name: 'System prompt' });
      fireEvent.change(box, { target: { value: 'be brief' } });             // inside the pause: not sent yet
      expect(set).not.toHaveBeenCalled();
      view.rerender(<PreferencesPopup open={false} onClose={() => {}} onOpenAdvanced={() => {}} />);
      return view;
    };

    it('sends it once when the popup closes, with no toast when that works', async () => {
      const n = notices();
      const set = vi.fn().mockResolvedValue(true);
      await typeAndClose(set);
      await waitFor(() => expect(set).toHaveBeenCalledWith('systemPrompt', 'be brief'));
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(n.got).toEqual([]);
      n.off();
    });

    it.each([
      ['rejects', () => Promise.reject(new Error('locked'))],
      ['answers false', () => Promise.resolve(false)],
      ['answers ok:false', () => Promise.resolve({ ok: false })],
    ])('says so in a toast when the close-time save %s (no invented cause)', async (_n, answer) => {
      const n = notices();
      await typeAndClose(vi.fn(answer as () => Promise<unknown>));
      await waitFor(() => expect(n.got).toEqual(["Couldn't save your system prompt."]));
      n.off();
    });

    it('reopening waits for the close-time write before reading settings back, and a slow earlier load cannot overwrite a later one', async () => {
      let finishWrite!: (v: boolean) => void;
      const order: string[] = [];
      const set = vi.fn(() => new Promise<boolean>((r) => { finishWrite = (v) => { order.push('write done'); r(v); }; }));
      const get = vi.fn(async () => { order.push('get'); return undefined; });
      (window as any).claude = { settings: { get, set } };
      const view = open();
      fireEvent.change(await screen.findByRole('textbox', { name: 'System prompt' }), { target: { value: 'x' } });
      get.mockClear(); order.length = 0;
      view.rerender(<PreferencesPopup open={false} onClose={() => {}} onOpenAdvanced={() => {}} />);   // close: write starts, still running
      view.rerender(<PreferencesPopup open onClose={() => {}} onOpenAdvanced={() => {}} />);            // reopen at once
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
      expect(get).not.toHaveBeenCalled();                                                               // waiting for the write
      await act(async () => { finishWrite(true); });
      await waitFor(() => expect(get).toHaveBeenCalled());
      expect(order.indexOf('write done')).toBeLessThan(order.indexOf('get'));
    });

    it('a slow earlier load cannot overwrite a later one', async () => {
      let releaseOld!: () => void;
      const slow = new Promise<void>((r) => { releaseOld = r; });
      let calls = 0;
      const get = vi.fn(async (k: string) => {
        if (k !== 'systemPrompt') return undefined;
        const mine = ++calls;
        if (mine === 1) { await slow; return 'OLD'; }
        return 'NEW';
      });
      (window as any).claude = { settings: { get, set: vi.fn().mockResolvedValue(true) } };
      const view = open();                                                                              // first load: slow
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });                          // its reads have started
      view.rerender(<PreferencesPopup open={false} onClose={() => {}} onOpenAdvanced={() => {}} />);
      view.rerender(<PreferencesPopup open onClose={() => {}} onOpenAdvanced={() => {}} />);            // second load: fast
      const box = await screen.findByRole('textbox', { name: 'System prompt' }) as HTMLTextAreaElement;
      await waitFor(() => expect(box.value).toBe('NEW'));
      await act(async () => { releaseOld(); await new Promise((r) => setTimeout(r, 20)); });
      expect((screen.getByRole('textbox', { name: 'System prompt' }) as HTMLTextAreaElement).value).toBe('NEW');
    });

    it('the window going away inside the pause sends the pending text (pagehide, listened to only while open)', async () => {
      const set = vi.fn().mockResolvedValue(true);
      setup(set);
      const view = open();
      fireEvent.change(await screen.findByRole('textbox', { name: 'Output style' }), { target: { value: 'kind' } });
      expect(set).not.toHaveBeenCalled();
      window.dispatchEvent(new Event('pagehide'));
      expect(set).toHaveBeenCalledWith('outputStyle', 'kind');
      // closed: no listener left, so a later pagehide sends nothing more
      view.rerender(<PreferencesPopup open={false} onClose={() => {}} onOpenAdvanced={() => {}} />);
      set.mockClear();
      window.dispatchEvent(new Event('pagehide'));
      expect(set).not.toHaveBeenCalled();
    });
  });
});
