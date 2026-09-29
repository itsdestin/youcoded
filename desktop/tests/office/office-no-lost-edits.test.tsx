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
import { EditorFrame, type EditorFrameHandle } from '../../src/renderer/components/office/EditorFrame';
import { useUnsavedGuard } from '../../src/renderer/components/artifact-views/UnsavedChangesDialog';
import { markFailed, officeDocFor, openDoc, resetOfficeStoreForTests, saveStateFor } from '../../src/renderer/components/office/office-store';
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
    saveCopy: vi.fn(async (_t: string, mode: string) => (mode === 'check' ? { ok: true as const, possible: true } : { ok: true as const, folder: 'Documents', path: '/home/you/Documents/plan (copy).docx', unchanged: true })),
    ...over,
  };
  (window as unknown as { claude: unknown }).claude = { office };
  return office;
}

const frameOf = (c: HTMLElement) => c.querySelector('iframe[title="plan.docx"]');

beforeEach(() => { resetOfficeStoreForTests(); resetOfficeAvailabilityForTests(); snapshot.current.pages = [OFFICE_PAGE_SUMMARY]; });
afterEach(() => { vi.useRealTimers(); cleanup(); delete (window as unknown as { claude?: unknown }).claude; });

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
    const { posted, container } = await failedTab({
      saveCopy,
      invoke: vi.fn(async (_t: string, cmd: string) => { if (cmd === 'save_file') throw new Error("This file is on a read-only disk, so Office couldn't save it."); return null; }),
    });
    // The editor's side of the save that runs before the copy (bytes, then save_file).
    const iframe = frameOf(container) as HTMLIFrameElement;
    posted.mockImplementation((msg: unknown) => {
      if ((msg as { type?: string }).type !== 'yc:office-save') return;
      queueMicrotask(() => act(() => {
        for (const cmd of ['write_editor_bin', 'save_file']) window.dispatchEvent(new MessageEvent('message', { data: { yc: 'rpc', id: Math.random(), cmd, args: {} }, origin: 'office://t1', source: iframe.contentWindow }));
      }));
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Save a copy…' }));
    await waitFor(() => expect(saveCopy).toHaveBeenCalledWith('t1', 'save'));
    expect(await screen.findByText("This file is on a read-only disk, so Office couldn't save it.")).toBeInTheDocument();
    expect(officeDocFor(FILE.path)).not.toBeNull();
  });

  it('after Save a copy the tab edits the copy: typing then lands in the copy, not the original', async () => {
    const COPY = '/home/you/Documents/plan (copy).docx';
    const invoke = vi.fn(async () => 'ok');
    const { office, container, posted } = await failedTab({
      open: vi.fn(async (p: string) => (p === COPY ? { ok: true as const, token: 't2', origin: 'office://t2' } : { ok: true as const, token: 't1', origin: 'office://t1' })),
      invoke,
      saveCopy: vi.fn(async (_t: string, mode: string) => (mode === 'check' ? { ok: true as const, possible: true } : { ok: true as const, folder: 'Documents', path: COPY, unchanged: true })),
    });
    // The editor answers each save with its bytes, then save_file (fix round 5: a copy needs them).
    const iframe = frameOf(container) as HTMLIFrameElement;
    posted.mockImplementation((msg: unknown) => {
      if ((msg as { type?: string }).type !== 'yc:office-save') return;
      queueMicrotask(() => act(() => {
        for (const cmd of ['write_editor_bin', 'save_file']) window.dispatchEvent(new MessageEvent('message', { data: { yc: 'rpc', id: Math.random(), cmd, args: {} }, origin: 'office://t1', source: iframe.contentWindow }));
      }));
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Save a copy…' }));
    expect(await screen.findByText('Saved a copy to Documents — now editing the copy.')).toBeInTheDocument();
    // Same tab, now the copy; the original's session is handed back with nothing to save.
    expect(officeDocFor(FILE.path)).toBeNull();
    expect(officeDocFor(COPY)).not.toBeNull();
    await waitFor(() => expect(office.close).toHaveBeenCalledWith('t1'));
    invoke.mockClear(); // the copy's own saves went to the original; what follows must not
    const copyFrame = await waitFor(() => { const f = container.querySelector('iframe[title="plan (copy).docx"]') as HTMLIFrameElement; expect(f?.getAttribute('src')).toBe('office://t2/index.html'); return f; });
    vi.spyOn(copyFrame.contentWindow!, 'postMessage').mockImplementation(() => {});
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { yc: 'rpc', id: 9, cmd: 'save_file', args: { data: '' } }, origin: 'office://t2', source: copyFrame.contentWindow })); });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('t2', 'save_file', { data: '' }));
    expect(invoke).not.toHaveBeenCalledWith('t1', 'save_file', expect.anything());
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

describe('the header briefcase ("Open in Office") on an in-place edit', () => {
  it("does nothing while the in-place edit's save is failing: no cancel, no Office tab", async () => {
    withOffice();
    const { officeHeaderAction } = await import('../../src/renderer/components/office/use-office-edit-screen');
    const { resetOfficeAvailabilityForTests: reset, useOfficeAvailable } = await import('../../src/renderer/components/office/office-availability');
    reset();
    const { result } = renderHook(() => useOfficeAvailable());
    await waitFor(() => expect(result.current).toBe(true));
    const { registerFlush } = await import('../../src/renderer/components/office/office-store');
    registerFlush(FILE.path, async () => ({ ok: false, message: "Office doesn't have permission to save this file." }));
    const dispatch = vi.fn();
    const beforeOpen = vi.fn();
    const action = officeHeaderAction(FILE.path, dispatch, beforeOpen)!;
    act(() => action.onClick());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(beforeOpen).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(officeDocFor(FILE.path)).toBeNull();
  });
});

describe('closing the window or quitting with a document whose save failed', () => {
  function host(open: boolean, dispatch = vi.fn()) {
    return (
      <ArtifactProvider value={{ state: { ...initialArtifactState, pageViewOpen: open, openPageId: open ? OFFICE_PAGE_ID : null }, dispatch }}>
        <PageHost settingsOpen={false} onToggleSettings={() => {}} onCreatePage={() => {}} />
      </ArtifactProvider>
    );
  }
  async function askedToFlush(open: boolean, dispatch = vi.fn()) {
    let request!: (id: string, reason: string) => void;
    let prompt!: (p: { count: number; firstPath: string }) => void;
    const flushDone = vi.fn();
    const proceedClose = vi.fn();
    withOffice({
      onFlushRequest: vi.fn((cb: (id: string, reason: string) => void) => { request = cb; return () => {}; }),
      onUnsavedPrompt: vi.fn((cb: (p: { count: number; firstPath: string }) => void) => { prompt = cb; return () => {}; }),
      flushDone, proceedClose,
    } as Partial<OfficeBridge>);
    act(() => openDoc(FILE));
    const r = render(host(open, dispatch));
    await waitFor(() => expect(frameOf(r.container)).not.toBeNull());
    // The document's save fails, then main asks this window to save before closing.
    const { registerFlush } = await import('../../src/renderer/components/office/office-store');
    registerFlush(FILE.path, async () => ({ ok: false, message: "Office doesn't have permission to save this file." }));
    await act(async () => { request('flush-1', 'close'); await new Promise((res) => setTimeout(res, 0)); });
    // Main held the close and asks the person (the count covers every window).
    act(() => prompt({ count: 1, firstPath: FILE.path }));
    return { flushDone, proceedClose, dispatch, ...r };
  }

  it('answers main that it failed, and shows main\'s prompt — even with the Office page closed', async () => {
    const { flushDone, container } = await askedToFlush(false);
    expect(flushDone).toHaveBeenCalledWith('flush-1', { failed: 1, firstPath: FILE.path });
    expect(await screen.findByText("1 Office document couldn't be saved.")).toBeInTheDocument();
    // Not taken down: the document is still there to Review.
    expect(frameOf(container)).not.toBeNull();
  });

  it('Close anyway lets main go ahead, and keeps the documents (edits and failed state) in case the window survives', async () => {
    const { proceedClose, container } = await askedToFlush(false);
    const before = frameOf(container);
    fireEvent.click(await screen.findByRole('button', { name: 'Close anyway' }));
    expect(proceedClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("1 Office document couldn't be saved.")).toBeNull();
    // A text-file veto kept the window open: the Office document is exactly as it was.
    expect(frameOf(container)).toBe(before);
    expect(officeDocFor(FILE.path)).not.toBeNull();
  });

  it('Review opens the Office page on the tab that could not be saved, and does not close', async () => {
    const dispatch = vi.fn();
    const { proceedClose } = await askedToFlush(false, dispatch);
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'PAGE_OPENED', pageId: OFFICE_PAGE_ID, focus: true });
    expect(proceedClose).not.toHaveBeenCalled();
  });

  it("answers main within its 5 s cap even when a document's save hangs (each is capped at 4 s)", async () => {
    let request!: (id: string, reason: string) => void;
    const flushDone = vi.fn();
    withOffice({ onFlushRequest: vi.fn((cb: (id: string, reason: string) => void) => { request = cb; return () => {}; }), flushDone } as Partial<OfficeBridge>);
    act(() => openDoc(FILE));
    render(host(true));
    const { registerFlush } = await import('../../src/renderer/components/office/office-store');
    const caps: Array<number | undefined> = [];
    registerFlush('/hang-a.docx', (capMs) => { caps.push(capMs); return new Promise((r) => setTimeout(() => r({ ok: false, message: 'x' }), capMs)); });
    registerFlush('/hang-b.docx', (capMs) => { caps.push(capMs); return new Promise((r) => setTimeout(() => r({ ok: false, message: 'x' }), capMs)); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      act(() => request('f-cap', 'close'));
      await act(async () => { vi.advanceTimersByTime(4_000); await Promise.resolve(); await Promise.resolve(); });
      expect(caps.filter((c) => c === 4_000).length).toBeGreaterThanOrEqual(2);
      expect(flushDone).toHaveBeenCalledWith('f-cap', expect.objectContaining({ failed: expect.any(Number) }));
    } finally { vi.useRealTimers(); }
  });

  it('keeps a dirty text-file edit\'s own guard: nothing of Office overrides the window\'s unload veto', async () => {
    // The veto is the text editor's beforeunload (ActiveArtifactView); Office never touches it.
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    const { proceedClose } = await askedToFlush(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Close anyway' }));
    await waitFor(() => expect(proceedClose).toHaveBeenCalled());
    const ev = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    window.removeEventListener('beforeunload', handler);
  });

});

describe('the kept, hidden Office view', () => {
  function host(open: boolean) {
    return (
      <ArtifactProvider value={{ state: { ...initialArtifactState, pageViewOpen: open, openPageId: OFFICE_PAGE_ID }, dispatch: vi.fn() }}>
        <PageHost settingsOpen={false} onToggleSettings={() => {}} onCreatePage={() => {}} />
      </ArtifactProvider>
    );
  }

  it('takes no focus or keyboard while hidden, and lets go of a focused editor', async () => {
    withOffice();
    act(() => openDoc(FILE));
    const { container, rerender } = render(host(true));
    const frame = await waitFor(() => { const f = frameOf(container) as HTMLIFrameElement; expect(f).not.toBeNull(); return f; });
    frame.focus();
    expect(document.activeElement).toBe(frame);
    rerender(host(false));
    expect(frame.closest('[inert]')).not.toBeNull();
    expect(document.activeElement).not.toBe(frame);
    rerender(host(true));
    expect(frame.closest('[inert]')).toBeNull();
  });

  it('does not show (or hold Escape for) its Versions window while hidden', async () => {
    withOffice({ versions: vi.fn(async () => []) });
    act(() => openDoc(FILE));
    const { rerender } = render(host(true));
    const { showVersions } = await import('../../src/renderer/components/office/office-store');
    act(() => showVersions(FILE));
    expect(await screen.findByText('No earlier versions yet.')).toBeInTheDocument();
    rerender(host(false));
    expect(screen.queryByText('No earlier versions yet.')).toBeNull();
    rerender(host(true));
    expect(await screen.findByText('No earlier versions yet.')).toBeInTheDocument();
  });

  it('says so outside the page when a tab closed while hidden could not save', async () => {
    withOffice({ invoke: vi.fn(async (_t: string, cmd: string) => { if (cmd === 'save_file') throw new Error("Office doesn't have permission to save this file."); return null; }) });
    act(() => openDoc(FILE));
    const { container, rerender } = render(host(true));
    await waitFor(() => { const f = frameOf(container) as HTMLIFrameElement; expect(f?.getAttribute('src')).toBe('office://t1/index.html'); return f; });
    // WHY re-read the frame's window each time: jsdom can swap it after the src is set (see
    // editor-frame-relay.test.tsx), and under load that happens after this point.
    const win = () => { const w = (frameOf(container) as HTMLIFrameElement).contentWindow!; if (!vi.isMockFunction(w.postMessage)) vi.spyOn(w, 'postMessage').mockImplementation(() => {}); return w; };
    const send = (data: unknown) => act(() => { window.dispatchEvent(new MessageEvent('message', { data, origin: 'office://t1', source: win() })); });
    // WHY resend until it registers: the frame's message listener is attached in an effect after
    // the render that set the src, and under a loaded suite it can land later — a change sent
    // before it was simply lost, so the close had nothing to save and no toast came.
    const { closeDoc, saveStateFor } = await import('../../src/renderer/components/office/office-store');
    await waitFor(() => {
      send({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } });
      expect(saveStateFor(FILE.path).phase).toBe('unsaved');
    });
    rerender(host(false));
    act(() => closeDoc(FILE.path));
    send({ yc: 'rpc', id: 2, cmd: 'save_file', args: { data: '' } });
    expect(await screen.findByText("An Office document couldn't be saved.")).toBeInTheDocument();
    expect(officeDocFor(FILE.path)).toMatchObject({ closing: false });
  });
});

describe('Save a copy while the editor could still change', () => {
  const COPY = '/home/you/Documents/plan (copy).docx';
  async function failedWith(opts: { againUnchanged?: boolean; writeFails?: boolean; handsOver?: (n: number) => boolean } = {}) {
    const saveCopy = vi.fn(async (_t: string, mode: string) => {
      if (mode === 'check') return { ok: true as const, possible: true };
      if (mode === 'save') return { ok: true as const, folder: 'Documents', path: COPY };
      return { ok: true as const, folder: 'Documents', path: COPY, unchanged: opts.againUnchanged ?? true };
    });
    const office = withOffice({
      saveCopy,
      invoke: vi.fn(async (_t: string, cmd: string) => {
        if (cmd === 'save_file') throw new Error("Office doesn't have permission to save this file.");
        if (cmd === 'write_editor_bin' && opts.writeFails) throw new Error("The disk is full, so Office couldn't save this file.");
        return null;
      }),
    });
    act(() => openDoc(FILE));
    const r = render(<OfficeView />);
    const iframe = await waitFor(() => { const f = frameOf(r.container) as HTMLIFrameElement; expect(f?.getAttribute('src')).toBe('office://t1/index.html'); return f; });
    const from = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data, origin: 'office://t1', source: iframe.contentWindow }));
    let overlaySeen = false;
    let asked = 0;
    vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation((msg: unknown) => {
      if ((msg as { type?: string }).type !== 'yc:office-save') return;
      if (r.container.querySelector('[aria-busy="true"]')) overlaySeen = true;
      const n = ++asked;
      queueMicrotask(() => act(() => {
        // An editor that skips the hand-over sends only save_file (fix round 5).
        if (opts.handsOver?.(n) ?? true) from({ yc: 'rpc', id: Math.random(), cmd: 'write_editor_bin', args: { data: 'x' } });
        from({ yc: 'rpc', id: Math.random(), cmd: 'save_file', args: { data: '' } });
      }));
    });
    act(() => markFailed(FILE.path, "Office doesn't have permission to save this file."));
    return { office, saveCopy, overlay: () => overlaySeen, ...r };
  }

  it('blocks the editor with "Saving a copy…" while it runs, checks once more, then switches', async () => {
    const { saveCopy, overlay, container } = await failedWith();
    fireEvent.click(await screen.findByRole('button', { name: 'Save a copy…' }));
    await waitFor(() => expect(officeDocFor(COPY)).not.toBeNull());
    expect(overlay()).toBe(true);
    expect(saveCopy.mock.calls.map((c) => c[1]).filter((m) => m !== 'check')).toEqual(['save', 'again']);
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("shows main's refusal of a copy target that is open in Office, on the strip, and does not switch", async () => {
    const { saveCopy } = await failedWith();
    saveCopy.mockImplementation(async (_t: string, mode: string) => (mode === 'check' ? { ok: true as const, possible: true } : { ok: false as const, message: 'That file is open in Office. Close it or choose another name.' }) as never);
    fireEvent.click(await screen.findByRole('button', { name: 'Save a copy…' }));
    expect(await screen.findByText('That file is open in Office. Close it or choose another name.')).toBeInTheDocument();
    expect(officeDocFor(COPY)).toBeNull();
  });

  it('does not switch when handing the editor\'s bytes to main failed before the copy (I3)', async () => {
    const { saveCopy } = await failedWith({ writeFails: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Save a copy…' }));
    expect(await screen.findByText("Office couldn't save a copy of this file.")).toBeInTheDocument();
    expect(saveCopy.mock.calls.map((c) => c[1])).not.toContain('save');
    expect(officeDocFor(COPY)).toBeNull();
    expect(officeDocFor(FILE.path)).not.toBeNull();
  });
  // Fix round 5: the copy is made only from bytes the editor handed over for THIS request —
  // not from an older Editor.bin when no hand-over came.
  it('does not copy or switch when the editor hands nothing over before the copy', async () => {
    const { saveCopy } = await failedWith({ handsOver: () => false });
    fireEvent.click(await screen.findByRole('button', { name: 'Save a copy…' }));
    expect(await screen.findByText("Office couldn't save a copy of this file.")).toBeInTheDocument();
    expect(saveCopy.mock.calls.map((c) => c[1])).not.toContain('save');
    expect(officeDocFor(COPY)).toBeNull();
    expect(officeDocFor(FILE.path)).not.toBeNull();
  });

  it('does not switch when the final check gets no hand-over', async () => {
    const { saveCopy } = await failedWith({ handsOver: (n) => n === 1 });
    fireEvent.click(await screen.findByRole('button', { name: 'Save a copy…' }));
    // The copy from 'save' is kept and called older, never deleted (M5).
    expect(await screen.findByText('An older copy was saved to Documents. Your newest changes are still only here.')).toBeInTheDocument();
    expect(saveCopy.mock.calls.map((c) => c[1]).filter((m) => m !== 'check')).toEqual(['save']);
    expect(officeDocFor(COPY)).toBeNull();
    expect(officeDocFor(FILE.path)).not.toBeNull();
  });

  it('disables the strip and makes the editor inert while the copy runs', async () => {
    const { container, saveCopy } = await failedWith();
    let release!: () => void;
    saveCopy.mockImplementation(async (_t: string, mode: string) => {
      if (mode === 'check') return { ok: true as const, possible: true };
      if (mode === 'save') { await new Promise<void>((r) => (release = r)); return { ok: true as const, folder: 'Documents', path: COPY }; }
      return { ok: true as const, folder: 'Documents', path: COPY, unchanged: true };
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Save a copy…' }));
    await waitFor(() => expect(saveCopy).toHaveBeenCalledWith('t1', 'save'));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close without saving' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Versions' })).toBeDisabled();
    expect(frameOf(container)!.hasAttribute('inert')).toBe(true);
    await act(async () => { release(); });
    await waitFor(() => expect(officeDocFor(COPY)).not.toBeNull());
  });
});

describe('small follow-ups', () => {
  it('the briefcase opens the copy after an in-place Save a copy', async () => {
    const COPY = '/home/you/Documents/plan (copy).docx';
    withOffice();
    const { officeHeaderAction } = await import('../../src/renderer/components/office/use-office-edit-screen');
    const { useOfficeAvailable } = await import('../../src/renderer/components/office/office-availability');
    const { result } = renderHook(() => useOfficeAvailable());
    await waitFor(() => expect(result.current).toBe(true));
    const { noteInlineCopy } = await import('../../src/renderer/components/office/office-store');
    noteInlineCopy(FILE.path, COPY);
    const dispatch = vi.fn();
    act(() => officeHeaderAction(FILE.path, dispatch)!.onClick());
    await waitFor(() => expect(officeDocFor(COPY)).not.toBeNull());
    expect(officeDocFor(FILE.path)).toBeNull();
  });

  it('counts a failed document once, though its in-place slot also answers for it', async () => {
    let request!: (id: string, reason: string) => void;
    const flushDone = vi.fn();
    withOffice({ onFlushRequest: vi.fn((cb: (id: string, reason: string) => void) => { request = cb; return () => {}; }), flushDone } as Partial<OfficeBridge>);
    const { registerFlush } = await import('../../src/renderer/components/office/office-store');
    const failing = async () => ({ ok: false as const, message: 'x' });
    registerFlush('/copy.docx', failing);
    registerFlush('/original.docx', failing, { alias: true });
    await act(async () => { request('f', 'close'); await new Promise((r) => setTimeout(r, 0)); });
    expect(flushDone).toHaveBeenCalledWith('f', { failed: 1, firstPath: '/copy.docx' });
  });

  it('Review of a document edited in place brings that editor forward, not the Office page', async () => {
    const dispatch = vi.fn();
    withOffice();
    const { registerInlineReveal, registerFlush } = await import('../../src/renderer/components/office/office-store');
    const reveal = vi.fn();
    registerInlineReveal('/in-place.docx', reveal);
    render(
      <ArtifactProvider value={{ state: { ...initialArtifactState, pageViewOpen: false }, dispatch }}>
        <PageHost settingsOpen={false} onToggleSettings={() => {}} onCreatePage={() => {}} />
      </ArtifactProvider>,
    );
    // Main's prompt, naming the in-place document as the first that could not be saved.
    let prompt!: (p: { count: number; firstPath: string }) => void;
    (window as unknown as { claude: { office: Partial<OfficeBridge> } }).claude.office.onUnsavedPrompt = (cb) => { prompt = cb; return () => {}; };
    (window as unknown as { claude: { office: Partial<OfficeBridge> } }).claude.office.onFlushRequest = () => () => {};
    (window as unknown as { claude: { office: Partial<OfficeBridge> } }).claude.office.flushDone = () => {};
    registerFlush('/in-place.docx', async () => ({ ok: true }));
    act(() => prompt({ count: 1, firstPath: '/in-place.docx' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'PAGE_OPENED' }));
  });

});

// The window's own guard: nothing that reloads or leaves the page (a Retry that reloads, a
// navigation) drops unsaved Office work — only main's close and quit, once answered, or the
// person's Close anyway let the unload through.
describe('the window unload guard', () => {
  const unloadBlocked = () => {
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  async function withEditor(opts: { unsaved?: boolean; flush?: 'ok' | 'failed' } = {}) {
    const store = await import('../../src/renderer/components/office/office-store');
    let ask!: (id: string, reason: 'close' | 'quit' | 'final') => void;
    let prompt!: (p: { count: number; firstPath: string }) => void;
    const office = {
      onFlushRequest: vi.fn((cb: typeof ask) => { ask = cb; }),
      flushDone: vi.fn(),
      onUnsavedPrompt: vi.fn((cb: typeof prompt) => { prompt = cb; }),
      proceedClose: vi.fn(),
    };
    (window as unknown as { claude: unknown }).claude = { office };
    const state = { unsaved: opts.unsaved ?? true };
    const flush = vi.fn(async () => (opts.flush === 'failed' ? { ok: false as const, message: 'no' } : { ok: true as const }));
    const unregister = store.registerFlush(FILE.path, flush, { unsaved: () => state.unsaved });
    const answer = async (reason: 'close' | 'quit' | 'final') => { await act(async () => { ask('f1', reason); await Promise.resolve(); await Promise.resolve(); }); };
    return { store, office, state, flush, unregister, answer, prompt: () => prompt };
  }

  it('blocks an unload while an Office document has unsaved work, and only then', async () => {
    const { state, unregister } = await withEditor();
    expect(unloadBlocked()).toBe(true);
    state.unsaved = false;
    expect(unloadBlocked()).toBe(false);
    state.unsaved = true;
    unregister();
    expect(unloadBlocked()).toBe(false); // no editor, nothing to lose
  });

  it("lets exactly one unload through after main's close was answered, and a new change withdraws it", async () => {
    const { store, answer } = await withEditor();
    await answer('close');
    expect(unloadBlocked()).toBe(false); // main's close goes ahead
    expect(unloadBlocked()).toBe(true); // used up: a close vetoed by something else does not leave it open
    await answer('close');
    act(() => store.markChanged(FILE.path));
    expect(unloadBlocked()).toBe(true);
  });

  it("keeps blocking when main's close found a document that could not be saved, until Close anyway", async () => {
    const { store, office, answer } = await withEditor({ flush: 'failed' });
    await answer('close');
    expect(office.flushDone).toHaveBeenCalledWith('f1', { failed: 1, firstPath: FILE.path });
    expect(unloadBlocked()).toBe(true);
    act(() => store.closeAnyway());
    expect(office.proceedClose).toHaveBeenCalled();
    expect(unloadBlocked()).toBe(false);
  });

  it("never stops quit's final pass, however often the window is asked", async () => {
    const { store, answer } = await withEditor({ flush: 'failed' });
    await answer('final');
    act(() => store.markChanged(FILE.path));
    expect(unloadBlocked()).toBe(false);
    expect(unloadBlocked()).toBe(false);
  });

  it('a reload saves first, then reloads past the guard', async () => {
    const { store, flush } = await withEditor();
    const reload = vi.fn(() => { expect(unloadBlocked()).toBe(false); });
    await act(async () => { store.reloadAfterOfficeSave(reload); await Promise.resolve(); await Promise.resolve(); });
    expect(flush).toHaveBeenCalledWith(4_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a reload whose save fails asks first, and reloads only on Close anyway', async () => {
    const { store, office } = await withEditor({ flush: 'failed' });
    const reload = vi.fn();
    const { result } = renderHook(() => store.useOfficeAlerts());
    await act(async () => { store.reloadAfterOfficeSave(reload); await Promise.resolve(); await Promise.resolve(); });
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.unsaved).toEqual({ count: 1, firstPath: FILE.path, reload: true });
    act(() => store.closeAnyway());
    expect(reload).toHaveBeenCalledTimes(1);
    expect(office.proceedClose).not.toHaveBeenCalled(); // this prompt was the reload's, not main's
  });

  it('a change to a document whose save failed withdraws Close anyway\'s approval', async () => {
    withOffice({ invoke: vi.fn(async (_t: string, cmd: string) => { if (cmd === 'save_file') throw new Error("Office doesn't have permission to save this file."); return null; }) });
    const store = await import('../../src/renderer/components/office/office-store');
    act(() => openDoc(FILE));
    const r = render(<OfficeView />);
    await waitFor(() => expect(frameOf(r.container)?.getAttribute('src')).toBe('office://t1/index.html'));
    const from = (data: unknown) => act(() => { window.dispatchEvent(new MessageEvent('message', { data, origin: 'office://t1', source: (frameOf(r.container) as HTMLIFrameElement).contentWindow })); });
    vi.spyOn((frameOf(r.container) as HTMLIFrameElement).contentWindow!, 'postMessage').mockImplementation(() => {});
    await waitFor(() => { from({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } }); expect(store.saveStateFor(FILE.path).phase).toBe('unsaved'); });
    from({ yc: 'rpc', id: 2, cmd: 'save_file', args: { data: '' } });
    await waitFor(() => expect(store.saveStateFor(FILE.path).phase).toBe('failed'));
    act(() => store.closeAnyway()); // approves one unload…
    from({ yc: 'rpc', id: 3, cmd: 'set_document_modified', args: { modified: true } }); // …then more typing
    expect(unloadBlocked()).toBe(true);
  });

  it('a reload\'s prompt says "Reload anyway"', async () => {
    const { store } = await withEditor({ flush: 'failed' });
    const { OfficeAlerts } = await import('../../src/renderer/components/office/OfficeAlerts');
    render(<OfficeAlerts onReview={() => {}} />);
    await act(async () => { store.reloadAfterOfficeSave(vi.fn()); await Promise.resolve(); await Promise.resolve(); });
    expect(await screen.findByRole('button', { name: 'Reload anyway' })).toBeInTheDocument();
    expect(screen.getByText(/Reloading anyway loses/)).toBeInTheDocument();
  });

  it('a reload treats a save that threw as not saved', async () => {
    const store = await import('../../src/renderer/components/office/office-store');
    store.registerFlush(FILE.path, () => Promise.reject(new Error('boom')), { unsaved: () => true });
    const reload = vi.fn();
    await act(async () => { store.reloadAfterOfficeSave(reload); await Promise.resolve(); await Promise.resolve(); });
    expect(reload).not.toHaveBeenCalled();
  });

  it('after a reload, a save the last page let go of that then failed is told on the new page', async () => {
    let nudge!: () => void;
    const lists = [['/home/you/plan.docx'], [], ['/home/you/notes.docx']];
    (window as unknown as { claude: unknown }).claude = { office: { lostSaves: vi.fn(async () => lists.shift() ?? []), onSavesLost: vi.fn((cb: () => void) => { nudge = cb; return () => {}; }) } };
    const store = await import('../../src/renderer/components/office/office-store');
    const { result } = renderHook(() => store.useOfficeAlerts());
    const { OfficeAlerts } = await import('../../src/renderer/components/office/OfficeAlerts');
    render(<OfficeAlerts onReview={() => {}} />);
    expect(await screen.findByText("An Office document couldn't be saved.")).toBeInTheDocument();
    expect(result.current.closeFailed).toBe('/home/you/plan.docx');
    act(() => store.clearCloseFailed());
    await act(async () => { nudge(); await Promise.resolve(); await Promise.resolve(); }); // nothing new
    expect(result.current.closeFailed).toBeNull();
    await act(async () => { nudge(); await Promise.resolve(); await Promise.resolve(); }); // failed while this page is up
    expect(result.current.closeFailed).toBe('/home/you/notes.docx');
  });

  it('an open editor with a change blocks the unload', async () => {
    withOffice();
    act(() => openDoc(FILE));
    const r = render(<OfficeView />);
    const iframe = await waitFor(() => { const f = frameOf(r.container) as HTMLIFrameElement; expect(f?.getAttribute('src')).toBe('office://t1/index.html'); return f; });
    vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});
    expect(unloadBlocked()).toBe(false);
    // Resent until the frame's listener (attached in an effect) has it — see the hidden-close test.
    await waitFor(() => {
      act(() => { window.dispatchEvent(new MessageEvent('message', { data: { yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } }, origin: 'office://t1', source: (frameOf(r.container) as HTMLIFrameElement).contentWindow })); });
      expect(unloadBlocked()).toBe(true);
    });
  });
});

// A restore replaces the file under an open editor. The editor's unsaved typing is saved first
// (kept by main as "Kept before a restore"), and the editor then reopens the restored file.
describe('restoring a kept version of an open document', () => {
  const V1 = { id: '2026-09-28T090000.000Z-abcd', at: '2026-09-28T09:00:00.000Z', reason: 'opened' as const, bytes: 37_000 };

  async function editing(over: Partial<OfficeBridge> = {}) {
    let pushChanged: ((p: { path: string; token: string }) => void) | null = null;
    let opens = 0;
    const office = withOffice({
      open: vi.fn(async () => { opens += 1; return { ok: true as const, token: `t${opens}`, origin: `office://t${opens}` }; }),
      invoke: vi.fn(async () => 'ok'),
      versions: vi.fn(async () => [V1]),
      onChanged: vi.fn((cb) => { pushChanged = cb; return () => {}; }),
      restore: vi.fn(async () => { pushChanged?.({ path: FILE.path, token: 't1' }); return { ok: true as const }; }),
      ...over,
    });
    act(() => openDoc(FILE));
    const r = render(<OfficeView />);
    const iframe = await waitFor(() => { const f = frameOf(r.container) as HTMLIFrameElement; expect(f?.getAttribute('src')).toBe('office://t1/index.html'); return f; });
    const from = (data: unknown) => act(() => { window.dispatchEvent(new MessageEvent('message', { data, origin: 'office://t1', source: iframe.contentWindow })); });
    // The editor answers "save now" as it really does: its bytes, then save_file.
    vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation((msg: unknown) => {
      if ((msg as { type?: string }).type !== 'yc:office-save') return;
      queueMicrotask(() => { for (const cmd of ['write_editor_bin', 'save_file']) from({ yc: 'rpc', id: Math.random(), cmd, args: {} }); });
    });
    const { saveStateFor, showVersions } = await import('../../src/renderer/components/office/office-store');
    // Typing autosave has not written yet (resent until the frame's listener is attached).
    await waitFor(() => { from({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } }); expect(saveStateFor(FILE.path).phase).toBe('unsaved'); });
    act(() => showVersions(FILE));
    await screen.findByText('When you opened it');
    return { office, from, ...r };
  }

  it('saves the unsaved typing first, then restores, then reopens the editor on the restored file', async () => {
    const { office, container } = await editing();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(office.restore).toHaveBeenCalledWith(FILE.path, V1.id));
    const invoke = vi.mocked(office.invoke);
    const saved = invoke.mock.calls.findIndex((c) => c[1] === 'save_file');
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(invoke.mock.invocationCallOrder[saved]).toBeLessThan(vi.mocked(office.restore!).mock.invocationCallOrder[0]);
    // The old editor lets go of its token and a fresh one opens the restored file.
    await waitFor(() => expect(office.close).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(frameOf(container)?.getAttribute('src')).toBe('office://t2/index.html'));
    expect(office.open).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByText('When you opened it')).toBeNull());
  });

  it('restores nothing when the unsaved typing cannot be saved, and says why', async () => {
    const { office } = await editing({ invoke: vi.fn(async (_t: string, cmd: string) => { if (cmd === 'save_file') throw new Error("This file is on a read-only disk, so Office couldn't save it."); return 'ok'; }) });
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText("Your latest changes couldn't be saved, so nothing was restored.")).toBeInTheDocument();
    expect(office.restore).not.toHaveBeenCalled();
    expect(office.close).not.toHaveBeenCalled();
  });

  it("shows main's reason when a restore is refused, and keeps the editor as it is", async () => {
    const { office } = await editing({ restore: vi.fn(async () => ({ ok: false as const, message: 'That version is no longer kept.' })) });
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('That version is no longer kept.')).toBeInTheDocument();
    expect(office.close).not.toHaveBeenCalled();
  });

  it('cannot be dismissed while a restore runs, and keeps its state when the page is hidden and shown again', async () => {
    let finish!: () => void;
    const { office, rerender } = await editing({ restore: vi.fn(() => new Promise<{ ok: true }>((r) => { finish = () => r({ ok: true }); })) });
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(office.restore).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Restoring…' })).toBeDisabled();
    // Escape, the ✕ and a click outside do nothing while it runs.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Close Versions' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Close Versions' }));
    expect(screen.getByText('When you opened it')).toBeInTheDocument();
    // Hidden mid-restore: not shown, but still there — and still restoring when shown again.
    rerender(<OfficeView visible={false} />);
    expect(screen.queryByText('When you opened it')).toBeNull();
    rerender(<OfficeView visible />);
    expect(screen.getByRole('button', { name: 'Restoring…' })).toBeInTheDocument();
    await act(async () => { finish(); });
    await waitFor(() => expect(screen.queryByText('When you opened it')).toBeNull());
  });

  it('keeps typing that slipped in after the save, instead of reloading over it', async () => {
    let fromFrame!: (d: unknown) => void;
    const { office } = await editing({
      restore: vi.fn(async () => {
        // A change reaches the editor after its save and before the restore's answer.
        fromFrame({ yc: 'rpc', id: 77, cmd: 'set_document_modified', args: { modified: true } });
        const onChanged = vi.mocked(office.onChanged!).mock.calls[0][0];
        onChanged({ path: FILE.path, token: 't1' });
        return { ok: true as const };
      }),
    }).then((r) => { fromFrame = r.from; return r; });
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('This file was restored while you had unsaved changes here. Save a copy to keep them.')).toBeInTheDocument();
    expect(office.close).not.toHaveBeenCalled();
    expect(office.open).toHaveBeenCalledTimes(1);
  });

  it('offers no Retry for kept typing, and Save a copy writes only the copy, never the restored file', async () => {
    let fromFrame!: (d: unknown) => void;
    const saveCopy = vi.fn(async (_t: string, mode: string, _bin?: string) => (mode === 'check'
      ? { ok: true as const, possible: false }
      : { ok: true as const, folder: 'Documents', path: '/home/you/Documents/plan (copy).docx', unchanged: true }));
    const { office, container } = await editing({
      saveCopy,
      restore: vi.fn(async () => {
        fromFrame({ yc: 'rpc', id: 77, cmd: 'set_document_modified', args: { modified: true } });
        vi.mocked(office.onChanged!).mock.calls[0][0]({ path: FILE.path, token: 't1' });
        return { ok: true as const };
      }),
    }).then((r) => { fromFrame = r.from; return r; });
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await screen.findByText('This file was restored while you had unsaved changes here. Save a copy to keep them.');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close without saving' })).toBeInTheDocument();
    const invoke = vi.mocked(office.invoke);
    const savesBefore = invoke.mock.calls.filter((c) => c[1] === 'save_file' || c[1] === 'write_editor_bin').length;
    // The editor answers "save now" with its bytes, then save_file — as it really does.
    const iframe = frameOf(container) as HTMLIFrameElement;
    vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation((msg: unknown) => {
      if ((msg as { type?: string }).type !== 'yc:office-save') return;
      queueMicrotask(() => {
        fromFrame({ yc: 'rpc', id: 'w', cmd: 'write_editor_bin', args: { data: 'VFlQSU5H' } });
        fromFrame({ yc: 'rpc', id: 's', cmd: 'save_file', args: {} });
      });
    });
    // A late main refusal of an earlier save must not replace the strip's message either.
    act(() => markFailed(FILE.path, 'This file was restored from a kept version, so Office is reloading it.'));
    expect(screen.getByText('This file was restored while you had unsaved changes here. Save a copy to keep them.')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Save a copy…' }));
    await waitFor(() => expect(saveCopy).toHaveBeenCalledWith('t1', 'save', 'VFlQSU5H'));
    expect(await screen.findByText('Saved a copy to Documents — now editing the copy.')).toBeInTheDocument();
    // Nothing of the kept typing reached main as a save or as the session's Editor.bin.
    expect(invoke.mock.calls.filter((c) => c[1] === 'save_file' || c[1] === 'write_editor_bin').length).toBe(savesBefore);
  });
});

// Two editors holding one document token (the same file named two ways in one window): a
// restore is decided per editor. The clean one reloads; the one with typing keeps it, and
// nothing it holds may reach the file or the session the reloaded one saves from.
describe('two editors on one document when a restore lands', () => {
  it('reloads the clean one, and the one with typing never saves or hands its bytes to main', async () => {
    let push: ((p: { path: string; token: string }) => void) | null = null;
    const saveCopy = vi.fn(async () => ({ ok: true as const, folder: 'Documents', path: '/home/you/Documents/b (copy).docx', unchanged: true }));
    const office = withOffice({
      invoke: vi.fn(async () => 'ok'),
      onChanged: vi.fn((cb) => { push = cb; return () => {}; }),
      saveCopy,
    });
    const A: OfficeFile = { ...FILE, path: '/home/you/plan.docx', name: 'plan.docx' };
    const B: OfficeFile = { ...FILE, path: '/home/you/link-to-plan.docx', name: 'link-to-plan.docx' };
    const bRef = React.createRef<EditorFrameHandle>();
    const { container } = render(<><EditorFrame file={A} /><EditorFrame ref={bRef} file={B} /></>);
    const frames = await waitFor(() => {
      const fa = container.querySelector('iframe[title="plan.docx"]') as HTMLIFrameElement;
      const fb = container.querySelector('iframe[title="link-to-plan.docx"]') as HTMLIFrameElement;
      expect(fa?.getAttribute('src')).toBe('office://t1/index.html');
      expect(fb?.getAttribute('src')).toBe('office://t1/index.html');
      return { fa, fb };
    });
    const fromB = (data: unknown) => act(() => { window.dispatchEvent(new MessageEvent('message', { data, origin: 'office://t1', source: frames.fb.contentWindow })); });
    vi.spyOn(frames.fa.contentWindow!, 'postMessage').mockImplementation(() => {});
    vi.spyOn(frames.fb.contentWindow!, 'postMessage').mockImplementation((msg: unknown) => {
      if ((msg as { type?: string }).type !== 'yc:office-save') return;
      queueMicrotask(() => {
        fromB({ yc: 'rpc', id: 'w', cmd: 'write_editor_bin', args: { data: 'T0xE' } });
        fromB({ yc: 'rpc', id: 's', cmd: 'save_file', args: {} });
      });
    });
    await waitFor(() => { fromB({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } }); expect(saveStateFor(B.path).phase).toBe('unsaved'); });
    act(() => push!({ path: A.path, token: 't1' }));
    // A (clean) lets go of t1 and opens again; B keeps its typing and says so.
    await waitFor(() => expect(office.close).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(office.open).toHaveBeenCalledTimes(3));
    expect(saveStateFor(B.path)).toMatchObject({ phase: 'failed', keptAfterRestore: true });
    const invoke = vi.mocked(office.invoke);
    invoke.mockClear();
    // B's Retry does nothing; B's editor saving on its own is answered by the host.
    act(() => bRef.current!.save());
    fromB({ yc: 'rpc', id: 2, cmd: 'write_editor_bin', args: { data: 'T0xE' } });
    fromB({ yc: 'rpc', id: 3, cmd: 'save_file', args: {} });
    // B's Save a copy hands its own bytes to the copy only.
    await act(async () => { await bRef.current!.saveCopy(); });
    expect(saveCopy).toHaveBeenCalledWith('t1', 'save', 'T0xE');
    expect(invoke.mock.calls.filter((c) => c[1] === 'save_file' || c[1] === 'write_editor_bin')).toEqual([]);
  });

  it('after Close without saving, the editor that kept its typing sends nothing to main and main drops its pictures', async () => {
    let push: ((p: { path: string; token: string }) => void) | null = null;
    const saveCopy = vi.fn(async () => ({ ok: true as const, released: true as const }));
    const office = withOffice({ invoke: vi.fn(async () => 'ok'), onChanged: vi.fn((cb) => { push = cb; return () => {}; }), saveCopy });
    const ref = React.createRef<EditorFrameHandle>();
    const { container } = render(<EditorFrame ref={ref} file={FILE} />);
    const iframe = await waitFor(() => { const f = frameOf(container) as HTMLIFrameElement; expect(f?.getAttribute('src')).toBe('office://t1/index.html'); return f; });
    vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});
    const from = (data: unknown) => act(() => { window.dispatchEvent(new MessageEvent('message', { data, origin: 'office://t1', source: iframe.contentWindow })); });
    await waitFor(() => { from({ yc: 'rpc', id: 1, cmd: 'set_document_modified', args: { modified: true } }); expect(saveStateFor(FILE.path).phase).toBe('unsaved'); });
    act(() => push!({ path: FILE.path, token: 't1' }));
    expect(saveStateFor(FILE.path)).toMatchObject({ keptAfterRestore: true });
    act(() => ref.current!.discard());
    expect(saveCopy).toHaveBeenCalledWith('t1', 'release');
    const invoke = vi.mocked(office.invoke);
    invoke.mockClear();
    // Still the old document until it goes away: anything it sends is answered here.
    for (const cmd of ['set_document_modified', 'write_editor_bin', 'save_file', 'js_log']) from({ yc: 'rpc', id: cmd, cmd, args: { modified: true, data: 'T0xE' } });
    expect(invoke).not.toHaveBeenCalled();
  });
});
