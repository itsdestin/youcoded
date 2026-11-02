// @vitest-environment jsdom
// WHY: The first-run explanation belongs on the Pages landing screen, not behind Manage pages.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ArtifactProvider, createArtifactStore } from '../src/renderer/state/ArtifactContext';
import { NARROW_VIEWPORT_QUERY } from '../src/renderer/hooks/use-narrow-viewport';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import { PageHost } from '../src/renderer/components/pages/PageHost';
import { PagesView } from '../src/renderer/components/pages/PagesView';

const snapshot = vi.hoisted(() => ({ current: { pages: [] as any[], loaded: true, failed: false } }));
vi.mock('../src/renderer/components/pages/use-pages', () => ({
  usePages: () => snapshot.current,
  refreshPages: vi.fn().mockResolvedValue(undefined),
  setPagePinned: vi.fn(),
}));

const onCreatePage = vi.fn();
const state = { ...initialArtifactState, pageViewOpen: true, pagesViewOpen: false };
function mount(pagesViewOpen = false) {
  return render(
    <ArtifactProvider value={{ state: { ...state, pagesViewOpen }, dispatch: vi.fn() }}>
      <PageHost settingsOpen={false} onToggleSettings={() => {}} onCreatePage={onCreatePage} />
      <PagesView onMakePage={onCreatePage} onEditPage={() => {}} />
    </ArtifactProvider>,
  );
}

function viewport(narrow: boolean) {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query === NARROW_VIEWPORT_QUERY && narrow, media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
}
beforeEach(() => viewport(false));
afterEach(() => vi.unstubAllGlobals());

describe('PageHost navigation', () => {
  function navigation(narrow: boolean) {
    viewport(narrow);
    const pages = ['Home', 'Finance'].map((name) => ({ id: `personal:${name}`, name, description: '', icon: 'page', home: { kind: 'personal' }, pinned: false, updatedAt: '', htmlStamp: 1, connections: [], html: '<p>Demo page</p>', data: null }));
    snapshot.current = { pages, loaded: true, failed: false };
    vi.stubGlobal('claude', { pages: { get: vi.fn(async (id) => ({ ok: true, page: pages.find((p) => p.id === id) })) } });
    const store = createArtifactStore(state);
    render(<ArtifactProvider store={store}><PageHost settingsOpen={false} onToggleSettings={() => {}} onCreatePage={onCreatePage} /></ArtifactProvider>);
    const pick = (name: string) => fireEvent.click(document.querySelector(`[data-rail-page="personal:${name}"]`)!);
    return { store, pick };
  }

  // WHY (owner, 2026-11-01): on a phone the list and the page are two full-width screens that slide; picking a page
  // slides the list away (it stays mounted but inert), and the toggle buttons bring it back.
  it('slides between the list and the page on a phone and keeps Back to chat', async () => {
    const { store, pick } = navigation(true);
    const list = () => document.querySelector('.screen-pane--panel') as HTMLElement;
    expect(list().style.transform).toBe('translateX(0)');
    pick('Home');
    expect(store.getState()).toMatchObject({ pageViewOpen: true, pageFocus: false, openPageId: 'personal:Home' });
    expect(list().style.transform).toContain('calc(-100%');
    await waitFor(() => expect(document.querySelector('iframe')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Show the page list' }));
    expect(list().style.transform).toBe('translateX(0)');
    pick('Finance');
    expect(list().style.transform).toContain('calc(-100%');
    await waitFor(() => expect(document.querySelector('iframe')?.title).toBe('Finance'));
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(store.getState()).toMatchObject({ pageViewOpen: false, pageFocus: false, openPageId: null });
  });

  it('opens a requested public-demo page at full phone width', async () => {
    window.history.replaceState({}, '', '/?mode=workbench&openPage=personal%3AHome');
    try {
      const { store } = navigation(true);
      await waitFor(() => expect(store.getState()).toMatchObject({ pageFocus: true, openPageId: 'personal:Home' }));
      expect(document.querySelector('.screen-pane--panel')).not.toBeInTheDocument();
    } finally { window.history.replaceState({}, '', '/'); }
  });

  it('keeps the desktop sidebar beside a selected page', async () => {
    const { store, pick } = navigation(false);
    pick('Home');
    expect(store.getState()).toMatchObject({ pageViewOpen: true, pageFocus: false, openPageId: 'personal:Home' });
    await waitFor(() => expect(document.querySelector('iframe')).toBeInTheDocument());
    expect(document.querySelector('.screen-pane--panel')).toBeInTheDocument();
    pick('Finance');
    expect(store.getState()).toMatchObject({ pageFocus: false, openPageId: 'personal:Finance' });
    expect(document.querySelector('.screen-pane--panel')).toBeInTheDocument();
  });
});

describe('Pages first-run placement', () => {
  it('explains pages on the landing screen and creates from its card', async () => {
    snapshot.current.pages = [];
    onCreatePage.mockClear();
    mount();
    expect(await screen.findByText('Pages are little apps you describe')).toBeInTheDocument();
    expect(screen.queryByText('No page selected')).not.toBeInTheDocument();
    expect(screen.queryByText('No pages yet. Create one below.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Make a page' }));
    expect(onCreatePage).toHaveBeenCalledOnce();
  });

  it('hides the empty sidebar and offers only Make a page', async () => {
    snapshot.current.pages = [];
    mount();
    await screen.findByText('Pages are little apps you describe');
    expect(document.querySelector('.screen-pane--panel')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Make a page' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Manage pages' })).not.toBeInTheDocument();
  });

  it('keeps the selected-page prompt when pages exist', async () => {
    snapshot.current.pages = [{ id: 'personal:test', name: 'Test', description: '', icon: 'sparkles', home: { kind: 'personal' }, updatedAt: new Date().toISOString(), pinned: false }];
    mount();
    expect(await screen.findByText('No page selected')).toBeInTheDocument();
    expect(document.querySelector('.screen-pane--panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage pages' })).toBeInTheDocument();
    expect(screen.queryByText('Pages are little apps you describe')).not.toBeInTheDocument();
  });

  it('does not put a second first-run card behind Manage pages', async () => {
    snapshot.current.pages = [];
    mount(true);
    const manager = screen.getByRole('heading', { name: 'Manage pages' }).closest('.fixed')!;
    expect(manager).not.toHaveTextContent('Pages are little apps you describe');
    expect(manager).toHaveTextContent('Make a page');
  });
});

describe('a page deleted while it is open', () => {
  it('falls back to "No page selected" once the list no longer has it', async () => {
    // Deleted through chat: the host's list drops it, but the view still held
    // its id and kept the old page in the frame until another was picked.
    snapshot.current.pages = [{ id: 'personal:other', name: 'Other', description: '', icon: 'sparkles', home: { kind: 'personal' }, updatedAt: new Date().toISOString(), pinned: false }];
    const dispatch = vi.fn();
    (window as any).claude = { pages: { get: vi.fn(() => new Promise(() => {})) } };
    render(
      <ArtifactProvider value={{ state: { ...state, openPageId: 'personal:gone', pageFocus: true }, dispatch }}>
        <PageHost settingsOpen={false} onToggleSettings={() => {}} onCreatePage={onCreatePage} />
      </ArtifactProvider>,
    );
    expect(dispatch).toHaveBeenCalledWith({ type: 'PAGE_CLOSED' });
    delete (window as any).claude;
  });

  it('leaves an open page alone while the list still has it', () => {
    snapshot.current.pages = [{ id: 'personal:here', name: 'Here', description: '', icon: 'sparkles', home: { kind: 'personal' }, updatedAt: new Date().toISOString(), pinned: false }];
    const dispatch = vi.fn();
    (window as any).claude = { pages: { get: vi.fn(() => new Promise(() => {})) } };
    render(
      <ArtifactProvider value={{ state: { ...state, openPageId: 'personal:here' }, dispatch }}>
        <PageHost settingsOpen={false} onToggleSettings={() => {}} onCreatePage={onCreatePage} />
      </ArtifactProvider>,
    );
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'PAGE_CLOSED' });
    delete (window as any).claude;
  });

  it('does not close the page on a list that has not loaded, or failed to', () => {
    snapshot.current = { pages: [], loaded: false, failed: false };
    const dispatch = vi.fn();
    (window as any).claude = { pages: { get: vi.fn(() => new Promise(() => {})) } };
    render(
      <ArtifactProvider value={{ state: { ...state, openPageId: 'personal:here' }, dispatch }}>
        <PageHost settingsOpen={false} onToggleSettings={() => {}} onCreatePage={onCreatePage} />
      </ArtifactProvider>,
    );
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'PAGE_CLOSED' });
    snapshot.current = { pages: [], loaded: true, failed: false };
    delete (window as any).claude;
  });
});

describe('an open page fades at the edges where it hides more', () => {
  // The page's kit reports its document's edges (page-kit.ts PAGE_EDGES_MESSAGE); the frame wears the
  // app's one scroll fade there (scroll-mask.css .scroll-mask-frame), as every other scroll area does.
  it('sets the frame\'s fade flags from the page, and ignores the same message from anywhere else', async () => {
    const page = { id: 'personal:long', name: 'Long', description: '', icon: 'page', home: { kind: 'personal' }, updatedAt: '', htmlStamp: 1, connections: [], html: '<p>x</p>', data: null, pinned: false };
    snapshot.current = { pages: [{ ...page, html: undefined }], loaded: true, failed: false };
    (window as any).claude = { pages: { get: vi.fn(async () => ({ ok: true, page })), setData: vi.fn(async () => ({ ok: true })), list: vi.fn(async () => []) } };
    const view = render(
      <ArtifactProvider value={{ state: { ...state, openPageId: 'personal:long' }, dispatch: vi.fn() }}>
        <PageHost settingsOpen={false} onToggleSettings={() => {}} onCreatePage={onCreatePage} />
      </ArtifactProvider>,
    );
    await waitFor(() => expect(document.querySelector('iframe')).toBeTruthy());
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    expect(frame).toHaveClass('scroll-mask-frame');
    const post = (data: unknown, source: Window | null) => act(() => { window.dispatchEvent(new MessageEvent('message', { data, source })); });
    // The host starts listening once the page's document is ready, so the first report may need a retry.
    await waitFor(() => {
      post({ type: 'youcoded:edges', top: false, bottom: true }, frame.contentWindow);
      expect(frame.dataset).toMatchObject({ fadeTop: 'false', fadeBottom: 'true' });
    });
    post({ type: 'youcoded:edges', top: true, bottom: false }, window);
    expect(frame.dataset).toMatchObject({ fadeTop: 'false', fadeBottom: 'true' });
    post({ type: 'youcoded:edges', top: true, bottom: false }, frame.contentWindow);
    expect(frame.dataset).toMatchObject({ fadeTop: 'true', fadeBottom: 'false' });
    view.unmount();
    delete (window as any).claude;
  });
});

