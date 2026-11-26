// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import ModelPickerPopup from '../src/renderer/components/ModelPickerPopup';
import { APP_NOTICE_EVENT } from '../src/renderer/utils/announce';
import { resetFailureDedupeForTests } from '../src/renderer/utils/report-failure';
import { DESKTOP_WINDOW_CAPABILITIES } from '../src/shared/capabilities';

// R-1 batch 1 (Destin H-3): an effort or Fast-mode switch whose save failed snaps back to the real value, with a message.
const toasts: string[] = [];
const on = (e: Event) => toasts.push((e as CustomEvent).detail.message);
beforeEach(() => { toasts.length = 0; resetFailureDedupeForTests(); window.addEventListener(APP_NOTICE_EVENT, on); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { cleanup(); window.removeEventListener(APP_NOTICE_EVENT, on); delete (window as any).claude; vi.restoreAllMocks(); });

const sent: string[] = [];
function mount(set: ReturnType<typeof vi.fn>, fast = false) {
  sent.length = 0;
  (window as any).claude = {
    capabilities: DESKTOP_WINDOW_CAPABILITIES,
    modes: { get: vi.fn().mockResolvedValue({ fast, effort: 'auto' }), set },
    providers: { list: vi.fn().mockResolvedValue([]), catalog: vi.fn().mockResolvedValue([]) },
  };
  render(<ModelPickerPopup open onClose={() => {}} sessionId={'s1'} currentModel={'opus' as any} onSelectModel={() => {}} sendPtyCommand={(c: string) => { sent.push(c); return true; }} />);
}
const tab = (name: string) => screen.findByRole('tab', { name }).catch(() => screen.findByRole('button', { name }));

describe('effort switch', () => {
  it('snaps back to the real value and says so when the save fails', async () => {
    mount(vi.fn().mockRejectedValue(new Error('disk full')));
    fireEvent.click(await tab('High'));
    await vi.waitFor(() => expect(toasts).toEqual(["Couldn't save the effort level."]));
    await waitFor(async () => expect(await tab('Auto')).toHaveAttribute('aria-selected', 'true'));
    expect(sent).toEqual(['/effort high\r', '/effort auto\r']);
  });
  it('stays on the new value and says nothing when the save works', async () => {
    mount(vi.fn().mockResolvedValue(undefined));
    fireEvent.click(await tab('High'));
    await new Promise((r) => setTimeout(r, 20));
    expect(toasts).toEqual([]);
    expect(await tab('High')).toHaveAttribute('aria-selected', 'true');
  });
});

describe('effort switch, two quick changes', () => {
  it('a late failure of the first save does not overwrite the second choice', async () => {
    let failFirst: (e: Error) => void = () => {};
    const set = vi.fn()
      .mockImplementationOnce(() => new Promise((_, rej) => { failFirst = rej; }))
      .mockResolvedValueOnce(undefined);
    mount(set);
    fireEvent.click(await tab('High'));
    fireEvent.click(await tab('Low'));
    failFirst(new Error('late'));
    await vi.waitFor(() => expect(toasts).toEqual(["Couldn't save the effort level."]));
    expect(await tab('Low')).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Fast mode switch', () => {
  it('turning it off snaps back to ON and says so when the save fails', async () => {
    mount(vi.fn().mockRejectedValue(new Error('disk full')), true);
    const sw = await screen.findByRole('switch', { name: 'Fast mode' });
    await waitFor(() => expect(sw).toBeChecked());
    fireEvent.click(sw);
    await vi.waitFor(() => expect(toasts).toEqual(["Couldn't save Fast mode."]));
    await waitFor(() => expect(sw).toBeChecked());
    expect(sent).toEqual(['/fast off\r', '/fast on\r']);
  });
});
