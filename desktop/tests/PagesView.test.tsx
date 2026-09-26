// @vitest-environment jsdom
// WHY: The first-run explanation belongs on the Pages landing screen, not behind Manage pages.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
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

