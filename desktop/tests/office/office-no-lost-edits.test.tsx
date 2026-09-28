// @vitest-environment jsdom
// No Office edit is dropped by an editor going away (C2), and a save that fails is never
// silently thrown away (I1): the paths that used to unmount an editor mid-autosave, and the
// save-failed actions the owner chose — Retry, Save a copy…, Close without saving.
import React, { useRef } from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { ArtifactProvider } from '../../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../../src/renderer/state/artifact-tracker';
import { PageHost } from '../../src/renderer/components/pages/PageHost';
import { OfficeView } from '../../src/renderer/components/office/OfficeView';
import { useUnsavedGuard } from '../../src/renderer/components/artifact-views/UnsavedChangesDialog';
import { markFailed, officeDocFor, openDoc, resetOfficeStoreForTests } from '../../src/renderer/components/office/office-store';
import { resetOfficeAvailabilityForTests } from '../../src/renderer/components/office/office-availability';
import { OFFICE_PAGE_ID, OFFICE_PAGE_SUMMARY } from '../../src/shared/pages-types';
import type { OfficeBridge, OfficeFile, OfficeStatus } from '../../src/shared/office-types';

const snapshot = vi.hoisted(() => ({ current: { pages: [] as unknown[], loaded: true, failed: false } }));
vi.mock('../../src/renderer/components/pages/use-pages', () => ({
  usePages: () => snapshot.current,
  refreshPages: vi.fn().mockResolvedValue(undefined),
  setPagePinned: vi.fn(),
}));

const FILE: OfficeFile = { path: '/home/you/plan.docx', name: 'plan.docx', kind: 'document', folder: 'you', at: '2026-09-28T00:00:00Z' };
const READY: OfficeStatus = { available: true, recent: [], project: null };

function withOffice(over: Partial<OfficeBridge> = {}) {
  const office = {
    status: vi.fn(async () => READY),
    open: vi.fn(async () => ({ ok: true as const, token: 't1', origin: 'office://t1' })),
    invoke: vi.fn(async () => null),
    close: vi.fn(async () => {}),
    saveCopy: vi.fn(async (_t: string, mode: string) => (mode === 'check' ? { ok: true as const, possible: true } : { ok: true as const, folder: 'Documents' })),
    ...over,
  };
  (window as unknown as { claude: unknown }).claude = { office };
  return office;
}

const frameOf = (c: HTMLElement) => c.querySelector('iframe[title="plan.docx"]');

beforeEach(() => { resetOfficeStoreForTests(); resetOfficeAvailabilityForTests(); snapshot.current.pages = [OFFICE_PAGE_SUMMARY]; });
afterEach(() => { cleanup(); delete (window as unknown as { claude?: unknown }).claude; });

describe('an Office editor is not torn down with unsaved work', () => {
  function host(open: boolean, pageId: string | null = OFFICE_PAGE_ID) {
    return (
      <ArtifactProvider value={{ state: { ...initialArtifactState, pageViewOpen: open, openPageId: pageId }, dispatch: vi.fn() }}>
        <PageHost settingsOpen={false} onToggleSettings={() => {}} onCreatePage={() => {}} />
      </ArtifactProvider>
    );
  }

  it('keeps the editor mounted, hidden, when the page view closes, and shows the same one on return', async () => {
    const office = withOffice();
    act(() => openDoc(FILE));
    const { container, rerender } = render(host(true));
    await waitFor(() => expect(frameOf(container)).not.toBeNull());
    const before = frameOf(container);
    rerender(host(false));
    expect(frameOf(container)).toBe(before);
    expect(office.close).not.toHaveBeenCalled();
    // Invisible, not display:none: an editor laid out at zero size came back blank.
    // (From the frame's parent: the frame itself stays invisible until its editor has drawn.)
    expect(before!.parentElement!.closest('[hidden]')).toBeNull();
    expect(before!.parentElement!.closest('.invisible')).not.toBeNull();
    rerender(host(true));
    expect(before!.parentElement!.closest('.invisible')).toBeNull();
    expect(frameOf(container)).toBe(before);
  });

  it('keeps the editor mounted while another page is shown', async () => {
    const office = withOffice();
    act(() => openDoc(FILE));
    const { container, rerender } = render(host(true));
    await waitFor(() => expect(frameOf(container)).not.toBeNull());
    const before = frameOf(container);
    rerender(host(true, 'personal:timer'));
    expect(frameOf(container)).toBe(before);
    expect(office.close).not.toHaveBeenCalled();
  });

  it('renders nothing when the page view is closed and no document is open', () => {
    withOffice();
    const { container } = render(host(false));
    expect(container.querySelector('.screen-view')).toBeNull();
  });

  it('keeps the editor when a status re-fetch fails', async () => {
    let fail = false;
    const office = withOffice({ status: vi.fn(async () => { if (fail) throw new Error('boom'); return READY; }) });
    act(() => openDoc(FILE));
    const { container, rerender } = render(<OfficeView projectRoot="/a" />);
    await waitFor(() => expect(frameOf(container)).not.toBeNull());
    const before = frameOf(container);
    fail = true;
    rerender(<OfficeView projectRoot="/b" />);
    await waitFor(() => expect(office.status).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(frameOf(container)).toBe(before);
    expect(office.close).not.toHaveBeenCalled();
  });

  it('closing a file panel with an in-place Office edit waits for the save, and stays put when it fails', async () => {
    let answer!: (ok: boolean) => void;
    const handle = { autosaves: true, editing: true, dirty: false, saveEdit: vi.fn(() => new Promise<boolean>((r) => (answer = r))), cancelEdit: vi.fn() };
    const { result } = renderHook(() => {
      const ref = useRef(handle);
      return useUnsavedGuard(ref as never, 'plan.docx');
    });
    const close = vi.fn();
    act(() => result.current.guard(close));
    expect(handle.saveEdit).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await act(async () => { answer(false); });
    expect(close).not.toHaveBeenCalled(); // failed: the editor stays, with its error
    act(() => result.current.guard(close));
    await act(async () => { answer(true); });
    expect(close).toHaveBeenCalledTimes(1);
    expect(result.current.dialog).toBeNull(); // no "Unsaved changes" question for Office
  });
});

describe('when an Office save fails', () => {
  async function failedTab(over: Partial<OfficeBridge> = {}) {
    const office = withOffice(over);
    act(() => openDoc(FILE));
    const r = render(<OfficeView />);
    const iframe = await waitFor(() => { const f = frameOf(r.container); expect(f?.getAttribute('src')).toBe('office://t1/index.html'); return f as HTMLIFrameElement; });
    const posted = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});
    act(() => markFailed(FILE.path, "This file is on a read-only disk, so Office couldn't save it."));
    await screen.findByText("This file is on a read-only disk, so Office couldn't save it.");
    return { office, posted, ...r };
  }

  it('offers Retry, Save a copy… and Close without saving', async () => {
    await failedTab();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Save a copy…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close without saving' })).toBeInTheDocument();
  });

  it('does not offer Save a copy… when a copy cannot succeed', async () => {
    const saveCopy = vi.fn(async () => ({ ok: true as const, possible: false }));
    await failedTab({ saveCopy });
    await waitFor(() => expect(saveCopy).toHaveBeenCalledWith('t1', 'check'));
    expect(screen.queryByRole('button', { name: 'Save a copy…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('changes nothing when the copy dialog is cancelled', async () => {
    const saveCopy = vi.fn(async (_t: string, mode: string) => (mode === 'check' ? { ok: true as const, possible: true } : { ok: false as const, cancelled: true as const }));
    await failedTab({ saveCopy });
    fireEvent.click(await screen.findByRole('button', { name: 'Save a copy…' }));
    await waitFor(() => expect(saveCopy).toHaveBeenCalledWith('t1', 'save'));
    expect(screen.getByText("This file is on a read-only disk, so Office couldn't save it.")).toBeInTheDocument();
    expect(officeDocFor(FILE.path)).not.toBeNull();
  });

  it('says where a copy went — the folder name only — and then closes normally', async () => {
    const { office } = await failedTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Save a copy…' }));
    expect(await screen.findByText('Saved a copy to Documents')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /close plan/i }));
    await waitFor(() => expect(officeDocFor(FILE.path)).toBeNull());
    await waitFor(() => expect(office.close).toHaveBeenCalledWith('t1'));
  });

  it('closes without saving only after the person confirms, and discards the changes', async () => {
    const { office, posted } = await failedTab();
    fireEvent.click(screen.getByRole('button', { name: 'Close without saving' }));
    expect(screen.getByText('Your changes since the last save will be lost.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(officeDocFor(FILE.path)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close without saving' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(officeDocFor(FILE.path)).toBeNull());
    await waitFor(() => expect(office.close).toHaveBeenCalledWith('t1'));
    // Discarded: the close did not ask the editor to save again.
    expect(posted.mock.calls.filter((c) => (c[0] as { type?: string }).type === 'yc:office-save')).toHaveLength(0);
  });
});
