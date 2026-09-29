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
