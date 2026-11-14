// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { announceFailed, APP_NOTICE_EVENT } from '../src/renderer/utils/announce';
import { openExternalUrl } from '../src/renderer/components/DeliverablesCard';

// Card #134 round 4: a button whose action failed says so in the app's toast, with no invented cause.
const toasts = () => { const got: string[] = []; const on = (e: Event) => got.push((e as CustomEvent).detail.message); window.addEventListener(APP_NOTICE_EVENT, on); return { got, off: () => window.removeEventListener(APP_NOTICE_EVENT, on) }; };
afterEach(() => { delete (window as any).claude; vi.restoreAllMocks(); });

describe('announceFailed', () => {
  it('says only the plain fact in the toast and keeps the cause in the console', () => {
    const t = toasts(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    announceFailed('open the link', new Error('ENOENT /home/x'));
    expect(t.got).toEqual(["Couldn't open the link."]);
    expect(warn.mock.calls.flat().join(' ')).toContain('ENOENT /home/x');
    t.off();
  });
});

describe('opening a link', () => {
  it('toasts when the browser could not be opened, and says nothing when it opened', async () => {
    const t = toasts(); vi.spyOn(console, 'warn').mockImplementation(() => {});
    (window as any).claude = { shell: { openExternal: vi.fn().mockRejectedValue(new Error('no browser')) } };
    openExternalUrl('https://example.com');
    await vi.waitFor(() => expect(t.got).toEqual(["Couldn't open the link."]));
    t.got.length = 0;
    (window as any).claude = { shell: { openExternal: vi.fn().mockResolvedValue(undefined) } };
    openExternalUrl('https://example.com');
    // settle: a success must toast nothing
    await new Promise((r) => setTimeout(r, 20));
    expect(t.got).toEqual([]);
    t.off();
  });
});
