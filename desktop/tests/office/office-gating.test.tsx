// @vitest-environment jsdom
// Where Office shows up, and what the Office page says when it cannot run (design §5; R28).
// The office namespace exists on desktop, the remote browser and the phone alike, so every
// entry point waits for the desktop's own "available" answer — and the Office page says so
// plainly when there is none.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { OfficeView } from '../../src/renderer/components/office/OfficeView';
import { officeHeaderAction, useOfficeHeaderAction } from '../../src/renderer/components/office/use-office-edit-screen';
import { resetOfficeAvailabilityForTests, useOfficeAvailable } from '../../src/renderer/components/office/office-availability';
import { markFailed, openDoc, resetOfficeStoreForTests } from '../../src/renderer/components/office/office-store';
import { usePages } from '../../src/renderer/components/pages/use-pages';
import { ActiveArtifactView, type ActiveArtifactHandle } from '../../src/renderer/components/artifact-views/ActiveArtifactView';
import { OFFICE_PAGE_SUMMARY } from '../../src/shared/pages-types';
import type { OfficeBridge, OfficeFile, OfficeStatus } from '../../src/shared/office-types';

const FILE: OfficeFile = { path: '/home/you/plan.docx', name: 'plan.docx', kind: 'document', folder: 'you', at: '2026-09-28T00:00:00Z' };
const READY: OfficeStatus = { available: true, recent: [], project: null };

function withOffice(office: Partial<OfficeBridge>) {
  (window as unknown as { claude: unknown }).claude = { office };
}

beforeEach(() => { resetOfficeAvailabilityForTests(); resetOfficeStoreForTests(); });
afterEach(() => {
  cleanup();
  delete (window as unknown as { claude?: unknown }).claude;
});

describe('the Office page', () => {
  it("says Office isn't included when this build has no Office, with nothing to retry", async () => {
    withOffice({ status: async () => ({ ...READY, available: false }) });
    const { findByText, queryByRole } = render(<OfficeView />);
    expect(await findByText("Office isn't included in this build.")).toBeTruthy();
    expect(queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('says the same when the host refuses Office (the remote browser, the phone)', async () => {
    withOffice({ status: () => Promise.reject(new Error('remote-unsupported: office:status')) });
    const { findByText, queryByRole } = render(<OfficeView />);
    expect(await findByText("Office isn't included in this build.")).toBeTruthy();
    expect(queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it("asks for the focused conversation's project", async () => {
    const status = vi.fn(async () => READY);
    withOffice({ status });
    const { findByText } = render(<OfficeView projectRoot="/home/you/Projects/garden" />);
    await findByText('Files you open in Office will show up here.');
    expect(status).toHaveBeenCalledWith('/home/you/Projects/garden');
  });

  it('asks for Recent again each time the page is shown, and not while it is hidden', async () => {
    const status = vi.fn(async () => READY);
    withOffice({ status });
    const { findByText, rerender } = render(<OfficeView visible />);
    await findByText('Files you open in Office will show up here.');
    expect(status).toHaveBeenCalledTimes(1);
    rerender(<OfficeView visible={false} />);
    expect(status).toHaveBeenCalledTimes(1);
    // A file opened meanwhile must show up when the page comes back (the page stays mounted).
    status.mockResolvedValueOnce({ ...READY, recent: [FILE] });
    rerender(<OfficeView visible />);
    expect(await findByText('plan.docx')).toBeTruthy();
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('shows New and Open at once, and Recent without waiting for a slow project list', async () => {
    let answerRecent!: (s: OfficeStatus) => void;
    let answerProject!: (s: OfficeStatus) => void;
    withOffice({
      status: (root) => new Promise<OfficeStatus>((r) => { if (root === null) answerRecent = r; else answerProject = r; }),
    });
    const { findByText, getByText, queryByText } = render(<OfficeView projectRoot="/home/you/Projects/garden" />);
    // Nothing has answered yet: New and Open are already there.
    expect(getByText('Document')).toBeTruthy();
    expect(getByText('Open a file…')).toBeTruthy();
    act(() => answerRecent({ ...READY, recent: [FILE] }));
    expect(await findByText('plan.docx')).toBeTruthy();
    expect(queryByText('In garden')).toBeNull();
    const budget: OfficeFile = { ...FILE, path: '/home/you/Projects/garden/budget.xlsx', name: 'budget.xlsx', kind: 'spreadsheet', folder: 'garden' };
    act(() => answerProject({ ...READY, project: { name: 'garden', files: [budget] } }));
    expect(await findByText('budget.xlsx')).toBeTruthy();
    expect(getByText('In garden')).toBeTruthy();
  });

  it('ignores an older answer that arrives after a newer one', async () => {
    const answers = new Map<string, (s: OfficeStatus) => void>();
    let call = 0;
    // Each request's answers are held under "<request>:<root>", so the test decides their order.
    withOffice({ status: (root) => new Promise<OfficeStatus>((r) => { answers.set(`${Math.floor(call++ / 2)}:${root}`, r); }) });
    const files = (name: string): OfficeStatus => ({ ...READY, project: { name, files: [{ ...FILE, path: `/p/${name}.docx`, name: `${name}.docx` }] } });
    const { findByText, queryByText, rerender } = render(<OfficeView projectRoot="/p/old" />);
    rerender(<OfficeView projectRoot="/p/new" />);
    act(() => {
      answers.get('1:null')!({ ...READY, recent: [{ ...FILE, name: 'newer-recent.docx', path: '/n.docx' }] });
      answers.get('1:/p/new')!(files('new'));
    });
    expect(await findByText('new.docx')).toBeTruthy();
    // The first request, slow, answers last: nothing it says is shown.
    act(() => {
      answers.get('0:null')!({ ...READY, recent: [{ ...FILE, name: 'older-recent.docx', path: '/o.docx' }] });
      answers.get('0:/p/old')!(files('old'));
    });
    await act(async () => { await Promise.resolve(); });
    expect(queryByText('old.docx')).toBeNull();
    expect(queryByText('older-recent.docx')).toBeNull();
    expect(queryByText('newer-recent.docx')).toBeTruthy();
  });

  it("shows main's reason when a new file can't be made, and Retry tries again", async () => {
    const create = vi.fn(async () => ({ ok: false as const, message: "Office can't create files in this protected folder." }));
    withOffice({ status: async () => READY, create });
    const { findByText, getByText, getByRole, queryByRole } = render(<OfficeView />);
    await findByText('Files you open in Office will show up here.');
    fireEvent.click(getByText('Document'));
    expect(await findByText("Office can't create files in this protected folder.")).toBeTruthy();
    // Specific and known: Retry, and no bug report.
    expect(queryByRole('button', { name: /report/i })).toBeNull();
    fireEvent.click(getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenLastCalledWith('document', null);
  });

  it('says New failed without guessing why when the request itself fails, and offers a bug report', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    withOffice({ status: async () => READY, create: async () => { throw new Error('ipc gone'); } });
    const { findByText, getByText, getByRole } = render(<OfficeView />);
    await findByText('Files you open in Office will show up here.');
    fireEvent.click(getByText('Spreadsheet'));
    expect(await findByText("Office couldn't create a new file.")).toBeTruthy();
    expect(getByRole('button', { name: /report/i })).toBeTruthy();
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });

  it('says Open failed when the picker cannot be shown', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    withOffice({ status: async () => READY, pick: async () => { throw new Error('no window'); } });
    const { findByText, getByText, getByRole } = render(<OfficeView />);
    await findByText('Files you open in Office will show up here.');
    fireEvent.click(getByText('Open a file…'));
    expect(await findByText("Office couldn't open the file picker.")).toBeTruthy();
    expect(getByRole('button', { name: /retry/i })).toBeTruthy();
    quiet.mockRestore();
  });

  it("shows a failed save's own reason with Retry, and Retry asks the editor to save", async () => {
    withOffice({
      status: async () => READY,
      open: async () => ({ ok: true as const, token: 't1', origin: 'office://t1' }),
      invoke: async () => null,
      close: async () => {},
    });
    act(() => openDoc(FILE));
    const { container, findByText, getByRole } = render(<OfficeView />);
    const iframe = await waitFor(() => {
      const f = container.querySelector('iframe');
      expect(f?.getAttribute('src')).toBe('office://t1/index.html');
      return f!;
    });
    const posted = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});
    act(() => markFailed(FILE.path, "This file is on a read-only disk, so Office couldn't save it."));
    expect(await findByText("This file is on a read-only disk, so Office couldn't save it.")).toBeTruthy();
    fireEvent.click(getByRole('button', { name: /retry/i }));
    expect(posted).toHaveBeenCalledWith({ type: 'yc:office-save' }, 'office://t1');
  });
});

describe('Office entry points', () => {
  it('stay hidden where the office namespace exists but the host refuses it', async () => {
    const status = vi.fn(() => Promise.reject(new Error('remote-unsupported: office:status')));
    withOffice({ status });
    const { result } = renderHook(() => useOfficeAvailable());
    await waitFor(() => expect(status).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toBe(false);
    expect(officeHeaderAction('/home/you/plan.docx', vi.fn())).toBeNull();
  });

  it('stay hidden where the add-on is not installed', async () => {
    const status = vi.fn(async () => ({ ...READY, available: false }));
    withOffice({ status });
    const { result } = renderHook(() => useOfficeHeaderAction('/home/you/plan.docx', vi.fn()));
    await waitFor(() => expect(status).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toBeNull();
  });

  it('appear once the desktop says Office is available, asking only once', async () => {
    const status = vi.fn(async () => READY);
    withOffice({ status });
    const { result } = renderHook(() => useOfficeHeaderAction('/home/you/plan.docx', vi.fn()));
    await waitFor(() => expect(result.current?.title).toBe('Open in Office'));
    renderHook(() => useOfficeAvailable());
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('never appear for a file Office does not edit', async () => {
    withOffice({ status: async () => READY });
    const { result } = renderHook(() => useOfficeHeaderAction('/home/you/notes.md', vi.fn()));
    await waitFor(() => expect(result.current).toBeNull());
  });

  // Final review, finding 1: main only translates docx/xlsx/pptx, so an older .doc must keep
  // the default-app button and must not offer an Edit that ends in a refusal.
  it('leave an old .doc its default-app button and offer no Office edit for it', async () => {
    const status = vi.fn(async () => READY);
    (window as unknown as { claude: unknown }).claude = {
      office: { status },
      artifacts: { get: vi.fn(), save: vi.fn(), onChanged: () => () => {} },
    };
    const { result } = renderHook(() => useOfficeHeaderAction('/home/you/old.doc', vi.fn()));
    const docx = renderHook(() => useOfficeHeaderAction('/home/you/plan.docx', vi.fn()));
    // The same answer that makes the .docx offer Office leaves the .doc alone.
    await waitFor(() => expect(docx.result.current?.title).toBe('Open in Office'));
    expect(result.current).toBeNull();
    const ref = React.createRef<ActiveArtifactHandle>();
    render(<ActiveArtifactView ref={ref} {...({
      artifact: { id: 'd1', kind: 'external', path: '/home/you/old.doc', absolutePath: '/home/you/old.doc' },
      content: null, contentInfo: { binary: true }, projectRoot: '/home/you', projectId: 'p', projectName: 'you',
      sessionId: 's', onContentChange: vi.fn(),
    } as any)} />);
    expect(ref.current!.isEditable).toBe(false);
  });

  it("keep the Office page out of the pages list until the desktop says it can run it", async () => {
    let answer!: (s: OfficeStatus) => void;
    const own = { ...OFFICE_PAGE_SUMMARY, id: 'personal:timer', name: 'Timer', home: { kind: 'personal' as const } };
    (window as unknown as { claude: unknown }).claude = {
      office: { status: () => new Promise<OfficeStatus>((r) => (answer = r)) },
      pages: { list: async () => [{ ...OFFICE_PAGE_SUMMARY, pinned: true }, own], onChanged: () => () => {} },
    };
    const { result } = renderHook(() => usePages());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.pages.map((p) => p.id)).toEqual(['personal:timer']);
    // Hidden, but its pin still counts toward the pin limit main enforces.
    expect(result.current.pinnedTotal).toBe(1);
    await act(async () => { answer(READY); });
    expect(result.current.pages.map((p) => p.id)).toEqual([OFFICE_PAGE_SUMMARY.id, 'personal:timer']);
  });
});
