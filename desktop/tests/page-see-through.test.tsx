// @vitest-environment jsdom
// The host side of "Show theme background" (owner, 2026-10-05): a framed page lets the theme's
// wallpaper show through ONLY while the app's page pane is glass AND the page's switch is on.
// What is pinned: the frame's own opaque class, the document born see-through, the switch (shown
// only on glass, calling the bridge), and the live message when the theme or the switch changes.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import { PageHost } from '../src/renderer/components/pages/PageHost';

const snapshot = vi.hoisted(() => ({ current: { pages: [] as any[], loaded: true, failed: false } }));
const setSee = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/components/pages/use-pages', () => ({
  usePages: () => snapshot.current,
  refreshPages: vi.fn().mockResolvedValue(undefined),
  setPagePinned: vi.fn(),
  setPageSeeThrough: setSee,
}));

const summary = (seeThrough?: boolean) => ({ id: 'personal:p', name: 'P', description: '', icon: 'page', home: { kind: 'personal' }, pinned: false, updatedAt: '', htmlStamp: 1, connections: [], ...(seeThrough === undefined ? {} : { seeThrough }) });
const doc = (seeThrough?: boolean) => ({ ...summary(seeThrough), html: '<p>hi</p>', data: null });

function setPane(wallpaper: boolean, chrome: string | null) {
  if (wallpaper) document.documentElement.setAttribute('data-wallpaper', ''); else document.documentElement.removeAttribute('data-wallpaper');
  if (chrome) document.body.setAttribute('data-chrome-style', chrome); else document.body.removeAttribute('data-chrome-style');
}

function mount(seeThrough?: boolean) {
  snapshot.current.pages = [summary(seeThrough)];
  (window as any).claude = { pages: { get: vi.fn(async () => ({ ok: true, page: doc(seeThrough) })), setData: vi.fn(async () => ({ ok: true })), list: vi.fn(async () => []) } };
  return render(
    <ArtifactProvider value={{ state: { ...initialArtifactState, pageViewOpen: true, openPageId: 'personal:p' }, dispatch: vi.fn() }}>
      <PageHost settingsOpen={false} onToggleSettings={() => {}} onCreatePage={() => {}} />
    </ArtifactProvider>,
  );
}
const frame = async () => (await waitFor(() => { const f = document.querySelector('iframe'); expect(f).toBeTruthy(); return f; })) as HTMLIFrameElement;

beforeEach(() => { setSee.mockClear(); });
afterEach(() => { setPane(false, null); delete (window as any).claude; });

describe('a page on a glass pane', () => {
  it('has no opaque frame of its own, is born see-through, and shows the switch (on)', async () => {
    setPane(true, 'floating');
    mount();
    const f = await frame();
    expect(f.className).not.toContain('bg-canvas');
    // the ONE pane carries the theme-engine glass class (blur follows --panels-blur and Reduced effects)
    expect(document.querySelector('.screen-pane--frame')).toHaveClass('panel-glass');
    expect(f.getAttribute('srcdoc')).toContain('<html data-yc-see-through>');
    expect(screen.getByRole('switch', { name: 'Show theme background' })).toHaveAttribute('aria-checked', 'true');
  });

  it('the switch asks the bridge to turn it off (stored per page)', async () => {
    setPane(true, 'float');
    mount();
    await frame();
    fireEvent.click(screen.getByRole('switch', { name: 'Show theme background' }));
    expect(setSee).toHaveBeenCalledWith('personal:p', false);
  });

  it('a page switched off keeps the opaque frame and is born solid, with the switch showing off', async () => {
    setPane(true, 'floating');
    mount(false);
    const f = await frame();
    expect(f.className).toContain('bg-canvas');
    expect(f.getAttribute('srcdoc')).not.toContain('<html data-yc-see-through');
    expect(screen.getByRole('switch', { name: 'Show theme background' })).toHaveAttribute('aria-checked', 'false');
  });

  it('tells an open page live when the theme stops being glass, without reloading it', async () => {
    setPane(true, 'floating');
    mount();
    const f = await frame();
    const post = vi.fn();
    Object.defineProperty(f, 'contentWindow', { configurable: true, value: { postMessage: post } });
    const srcdoc = f.getAttribute('srcdoc');
    await act(async () => { setPane(true, 'default'); });
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'youcoded:theme', seeThrough: false }), '*'));
    expect(document.querySelector('iframe')!.className).toContain('bg-canvas');
    expect(document.querySelector('iframe')!.getAttribute('srcdoc')).toBe(srcdoc); // same document: working state kept
    expect(screen.queryByRole('switch', { name: 'Show theme background' })).not.toBeInTheDocument();
  });
});

describe('a page where the pane is not glass', () => {
  it.each([[false, 'floating'], [true, 'default'], [true, null], [false, null]] as const)('is exactly as before (wallpaper %s, chrome %s): opaque frame, solid document, no switch', async (wallpaper, chrome) => {
    setPane(wallpaper, chrome);
    mount();
    const f = await frame();
    expect(f.className).toContain('bg-canvas');
    expect(document.querySelector('.screen-pane--frame')).not.toHaveClass('panel-glass');
    expect(f.getAttribute('srcdoc')).not.toContain('<html data-yc-see-through');
    expect(screen.queryByRole('switch', { name: 'Show theme background' })).not.toBeInTheDocument();
  });
});
