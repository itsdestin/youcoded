// @vitest-environment jsdom
// Card #134 round 4 review: real-failure + no-false-alarm tests for the notices added in the last rounds. No sleeps.
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import InputBar from '../src/renderer/components/InputBar';
import { flushRecoveryDrafts } from '../src/renderer/state/draft-recovery';
import { APP_NOTICE_EVENT } from '../src/renderer/utils/announce';
import { getByHint } from './helpers/hint-queries';
import { queueBrowserStorage } from './helpers/queue-browser-storage';

const toasts = () => { const got: string[] = []; const on = (e: Event) => got.push((e as CustomEvent).detail.message); window.addEventListener(APP_NOTICE_EVENT, on); return { got, off: () => window.removeEventListener(APP_NOTICE_EVENT, on) }; };
let t: ReturnType<typeof toasts>;
const api = (saveClipboardImage: () => Promise<unknown>, openFile: () => Promise<unknown> = async () => []) => {
  (window as any).claude = {
    native: { supported: true, send: vi.fn().mockResolvedValue({ status: 'sent' }) },
    session: { sendInput: vi.fn() },
    dialog: { saveClipboardImage, openFile },
    skills: { list: vi.fn().mockResolvedValue([]), getFavorites: vi.fn().mockResolvedValue([]), getChips: vi.fn().mockResolvedValue([]), getCuratedDefaults: vi.fn().mockResolvedValue([]) },
  };
};
beforeEach(() => {
  t = toasts(); flushRecoveryDrafts(); sessionStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  Object.defineProperty(window, 'localStorage', { value: queueBrowserStorage(), configurable: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { t.off(); cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const bar = () => render(<ChatProvider><SkillProvider><InputBar sessionId="s" provider="native" /></SkillProvider></ChatProvider>);
const pasteImage = () => {
  const box = screen.getByPlaceholderText('Message your assistant...');
  fireEvent.paste(box, { clipboardData: { items: [{ type: 'image/png' }] } });
};

describe('pasting an image into the composer', () => {
  it('says so when the desktop tried and got nothing, or the call failed', async () => {
    api(async () => null);
    bar(); pasteImage();
    await waitFor(() => expect(t.got).toEqual(["Couldn't attach the pasted image."]));
    t.got.length = 0;
    (window as any).claude.dialog.saveClipboardImage = async () => { throw new Error('clipboard busy'); };
    pasteImage();
    await waitFor(() => expect(t.got).toEqual(["Couldn't attach the pasted image."]));
  });
  it('is silent for the phone/browser "unsupported here" answer (undefined) and for a saved image', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    api(save); bar(); pasteImage();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    save.mockResolvedValue('/tmp/paste.png'); pasteImage();
    expect(await screen.findByText('paste.png')).toBeInTheDocument();
    expect(t.got).toEqual([]);
  });
  it('the composer-menu paste behaves the same way', async () => {
    const save = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(undefined);
    api(save); bar();
    act(() => { window.dispatchEvent(new Event('youcoded:composer-paste-image')); });
    await waitFor(() => expect(t.got).toEqual(["Couldn't attach the pasted image."]));
    t.got.length = 0;
    act(() => { window.dispatchEvent(new Event('youcoded:composer-paste-image')); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(t.got).toEqual([]);
  });
});

describe('the Attach button', () => {
  it('says so when the file picker could not open, and is silent when it opens', async () => {
    const openFile = vi.fn().mockRejectedValueOnce(new Error('no portal')).mockResolvedValueOnce([]);
    api(async () => null, openFile); bar();
    fireEvent.click(getByHint(document.body, 'Attach file'));
    await waitFor(() => expect(t.got).toEqual(["Couldn't open the file picker."]));
    t.got.length = 0;
    fireEvent.click(getByHint(document.body, 'Attach file'));
    await waitFor(() => expect(openFile).toHaveBeenCalledTimes(2));
    expect(t.got).toEqual([]);
  });
});

// ── Remote access saves (the Enabled switch and Keep awake) ─────────────────
import { renderHook } from '@testing-library/react';
import { useRemoteSaves } from '../src/renderer/hooks/useRemoteSaves';
import { useState } from 'react';

describe('Remote access: Enabled switch and Keep awake saves', () => {
  const setup = (setConfig: (u: any) => Promise<unknown>, open = true) => {
    (window as any).claude = { remote: { setConfig } };
    return renderHook(({ open }) => {
      const [config, setC] = useState<any>({ enabled: false, keepAwakeHours: 0 });
      const [err, setErr] = useState('');
      const saves = useRemoteSaves(open, config, setC, setErr);
      return { config, err, ...saves };
    }, { initialProps: { open } });
  };
  it('a rejected save shows the box under the control, keeps the last saved value, and Try again works', async () => {
    const setConfig = vi.fn().mockRejectedValueOnce(new Error('EACCES')).mockResolvedValue({ enabled: true });
    const { result } = setup(setConfig);
    await act(async () => { await result.current.toggleEnabled(); });
    await waitFor(() => expect(result.current.enabledNotice).not.toBeNull());
    expect(result.current.config.enabled).toBe(false);
    const box = render(<>{result.current.enabledNotice}</>);
    expect(box.getByText("Couldn't save the remote access setting")).toBeInTheDocument();
    await act(async () => { fireEvent.click(box.getByRole('button', { name: 'Try again' })); });
    await waitFor(() => expect(result.current.config.enabled).toBe(true));
    expect(result.current.enabledNotice).toBeNull();
  });
  it('keep awake: failure shows its box; a good save shows none; closing the panel clears it', async () => {
    const setConfig = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue({ keepAwakeHours: 4 });
    const { result, rerender } = setup(setConfig);
    await act(async () => { await result.current.setKeepAwake(4); });
    await waitFor(() => expect(result.current.keepAwakeNotice).not.toBeNull());
    rerender({ open: false });
    await waitFor(() => expect(result.current.keepAwakeNotice).toBeNull());
    rerender({ open: true });
    await act(async () => { await result.current.setKeepAwake(4); });
    expect(result.current.keepAwakeNotice).toBeNull();
    expect(result.current.config.keepAwakeHours).toBe(4);
  });
  it('an "unsupported here" rejection shows no box', async () => {
    const unsupported = Object.assign(new Error('remote-unsupported: remote:set-config'), { code: 'REMOTE_UNSUPPORTED' });
    const { result } = setup(vi.fn().mockRejectedValue(unsupported));
    await act(async () => { await result.current.toggleEnabled(); });
    expect(result.current.enabledNotice).toBeNull();
  });
});
