// @vitest-environment jsdom
// What PageHost does with the messages a page sends it (2026-11-10 review, finding 10: this handler had
// almost no checks of its own). Pinned here: only this page's own frame is heard; a page's saves are
// written once per pause; and a page opens a website by itself only for a site it is allowed AND only
// when the person just pressed something in it (finding 4) — otherwise the app asks.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import { PageHost } from '../src/renderer/components/pages/PageHost';
import type { PageConnectionStatus } from '../src/shared/pages-types';

const snapshot = vi.hoisted(() => ({ current: { pages: [] as any[], loaded: true, failed: false } }));
vi.mock('../src/renderer/components/pages/use-pages', () => ({
  usePages: () => snapshot.current,
  refreshPages: vi.fn().mockResolvedValue(undefined),
  setPagePinned: vi.fn(),
}));

const FEED: PageConnectionStatus = { id: 'f', kind: 'public', address: 'hnrss.org', approved: true };
const doc = { id: 'p:news', name: 'News', description: '', icon: 'page', home: { kind: 'personal' as const }, pinned: false, updatedAt: '', htmlStamp: 1, connections: [FEED], openSites: [], html: '<p>news</p>', data: null };

let setData: ReturnType<typeof vi.fn>;
let openWebsite: ReturnType<typeof vi.fn>;

function Host() {
  return (
    <ArtifactProvider value={{ state: { ...initialArtifactState, pageViewOpen: true, openPageId: 'p:news' }, dispatch: vi.fn() }}>
      <PageHost settingsOpen={false} onToggleSettings={() => {}} onCreatePage={() => {}} onStartSession={() => true} />
    </ArtifactProvider>
  );
}

function pressed(yes: boolean) {
  Object.defineProperty(window.navigator, 'userActivation', { value: { isActive: yes }, configurable: true });
}

beforeEach(() => {
  snapshot.current.pages = [{ ...doc, html: undefined }];
  setData = vi.fn(async () => ({ ok: true }));
  openWebsite = vi.fn(async () => ({ ok: true, pages: snapshot.current.pages }));
  // This screen can open addresses on its own computer (a phone's browser cannot, and always asks).
  (window as any).claude = { capabilities: { openExternal: true }, pages: { get: vi.fn(async () => ({ ok: true, page: doc })), setData, openWebsite, list: vi.fn(async () => []) } };
});
afterEach(() => { delete (window as any).claude; delete (window.navigator as any).userActivation; });

async function mount() {
  const view = render(<Host />);
  await waitFor(() => expect(document.querySelector('iframe')).toBeTruthy());
  await act(async () => {});
  const frame = document.querySelector('iframe') as HTMLIFrameElement;
  const say = (data: Record<string, unknown>, source: unknown = frame.contentWindow) => {
    act(() => { window.dispatchEvent(new MessageEvent('message', { data, source: source as Window })); });
  };
  return { view, frame, say };
}

describe('what a page tells the app', () => {
  it('saves what this page\'s frame sends, once per pause, and nothing sent from anywhere else', async () => {
    const { view, say } = await mount();
    say({ type: 'youcoded:data:set', data: { from: 'elsewhere' } }, window);
    say({ type: 'youcoded:data:set', data: { n: 1 } });
    say({ type: 'youcoded:data:set', data: { n: 2 } });
    await waitFor(() => expect(setData).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(setData).toHaveBeenCalledWith('p:news', { n: 2 });
    view.unmount();
  });

  it('opens an allowed site by itself when the person just pressed something in the page', async () => {
    pressed(true);
    const { view, frame, say } = await mount();
    frame.focus();
    say({ type: 'youcoded:open', url: 'https://hnrss.org/newest' });
    await waitFor(() => expect(openWebsite).toHaveBeenCalledWith('p:news', 'https://hnrss.org/newest', false, true));
    view.unmount();
  });

  it('asks instead when the page opens a site with no press (a timer in the page)', async () => {
    pressed(false);
    const { view, frame, say } = await mount();
    frame.focus();
    say({ type: 'youcoded:open', url: 'https://hnrss.org/newest' });
    await waitFor(() => expect(document.body.textContent).toMatch(/hnrss\.org/));
    expect(openWebsite).not.toHaveBeenCalled();
    view.unmount();
  });

  it('asks when the press was somewhere other than the page', async () => {
    pressed(true);
    const { view, say } = await mount();
    (document.activeElement as HTMLElement | null)?.blur?.();
    say({ type: 'youcoded:open', url: 'https://hnrss.org/newest' });
    await waitFor(() => expect(document.body.textContent).toMatch(/hnrss\.org/));
    expect(openWebsite).not.toHaveBeenCalled();
    view.unmount();
  });
});
