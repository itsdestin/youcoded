// @vitest-environment jsdom
// local-models-row.test.tsx — pins the unified Local Models row (spec §3.2,
// §3.5, §3.5a, §3.6). Same jsdom + fireEvent shape as the PartialRow test it
// replaced: this repo has no @testing-library/user-event.
//
// The copy asserted here is the copy from Destin's design review (2026-08-27,
// rounds 1–4), which is LATER than the draft strings in the implementation
// plan: the live row's stop button says "Pause" (every downloaded byte is
// kept), removal says "Delete", and the state word lives in the coloured band
// rather than in the progress line.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act, screen, waitFor } from '@testing-library/react';
import { LocalModelRow } from '../src/renderer/components/LocalModelsSection';
import type { DownloadProgress, InstalledLocalModel } from '../src/shared/model-manager-types';

function setupModelsMock(overrides: Record<string, any> = {}) {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = {
    models: {
      resume: vi.fn().mockResolvedValue({ downloadId: 'd1' }),
      delete: vi.fn().mockResolvedValue(true),
      downloadCancel: vi.fn().mockResolvedValue(true),
      onDownloadProgress: vi.fn().mockReturnValue(() => {}),
      ...overrides,
    },
  };
  return (globalThis as any).window.claude.models;
}

// Destin's real 2026-08-26 interruption. The app's gb() is binary, so these
// render as 74.2 GB of 113.0 GB (66%), not Hugging Face's 79.7 of 121.3.
const unfinished: InstalledLocalModel = {
  id: 'Half-UD-Q4_K_XL-00001-of-00004', sizeBytes: 79_674_559_677,
  quant: 'UD-Q4_K_XL', quantDescription: 'Balanced', parts: 4, status: 'unfinished',
  partsPresent: 2, totalSizeBytes: 121_334_654_784, repo: 'unsloth/Half-GGUF',
};
const untraceable: InstalledLocalModel = {
  ...unfinished, id: 'Old-UD-Q4_K_XL-00001-of-00002', status: 'untraceable',
  totalSizeBytes: null, repo: null, parts: 2, partsPresent: 1,
};
const liveOf = (state: DownloadProgress['state'], extra: Partial<DownloadProgress> = {}): DownloadProgress => ({
  downloadId: 'live-1', repo: 'unsloth/Half-GGUF', quant: 'UD-Q4_K_XL', state,
  receivedBytes: 85_000_000_000, totalBytes: 121_334_654_784, parts: 4, currentPart: 3, ...extra,
});

beforeEach(() => { setupModelsMock(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('LocalModelRow', () => {
  it('an unfinished row wears the interrupted banner, shows real progress, and resumes by model id', async () => {
    render(<LocalModelRow model={unfinished} onRefresh={async () => {}} />);
    expect(screen.getByText('Download interrupted')).toBeTruthy();
    expect(screen.getByText('66% — 74.2 of 113.0 GB')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('Resume')); });
    expect(window.claude.models.resume).toHaveBeenCalledWith('Half-UD-Q4_K_XL-00001-of-00004');
  });

  it('a REFUSED resume says why instead of doing nothing visible', async () => {
    const models = setupModelsMock();
    // The message wears Electron's wrapper, because that is how it ARRIVES: a
    // rejected ipcRenderer.invoke is re-thrown as "Error invoking remote method
    // '<channel>': Error: <the real one>". This test used to mock an
    // already-clean string, so it could not tell a stripped message from an
    // unstripped one and passed either way — the whole class went unguarded.
    models.resume.mockRejectedValue(new Error(
      "Error invoking remote method 'models:resume': Error: Not enough free space: this download needs about 40.0 GB but only 5.0 GB is free.",
    ));
    render(<LocalModelRow model={unfinished} onRefresh={async () => {}} />);
    await act(async () => { fireEvent.click(screen.getByText('Resume')); });
    // Exact text, anchored at the start: a substring match would still pass with
    // forty characters of Electron machinery in front of it.
    await waitFor(() => expect(screen.getByText(
      'Not enough free space: this download needs about 40.0 GB but only 5.0 GB is free.',
    )).toBeTruthy());
  });

  // The start-up window this branch deliberately created: over the remote link
  // the host can have no engine wired yet, and its honest answer to both of
  // these is nothing at all. Neither may become developer text or a spinner
  // that never ends.
  it('says so plainly when the engine is not ready to READ a model\u2019s settings', async () => {
    setupModelsMock({ settings: vi.fn().mockResolvedValue(null) });
    render(<LocalModelRow model={{ ...unfinished, status: 'complete' }} onRefresh={async () => {}} />);
    await act(async () => { fireEvent.click(screen.getByText('Settings')); });
    // Not "Cannot read properties of null (reading 'contextLength')".
    await waitFor(() => expect(screen.getByText(
      'This model\u2019s settings are not available yet. Try again in a moment.',
    )).toBeTruthy());
    expect(screen.queryByText(/Cannot read properties/)).toBeNull();
  });

  it('says so plainly when the engine is not ready to SAVE, instead of blanking the dialog', async () => {
    const ready = {
      contextLength: null, keepLoaded: false, gpuLayers: 'auto' as const,
      extraFlags: '', memoryWarningDismissed: null,
    };
    setupModelsMock({
      settings: vi.fn().mockResolvedValue(ready),
      setSettings: vi.fn().mockResolvedValue(null),
    });
    render(<LocalModelRow model={{ ...unfinished, status: 'complete' }} onRefresh={async () => {}} />);
    await act(async () => { fireEvent.click(screen.getByText('Settings')); });
    await waitFor(() => expect(screen.getByLabelText('Keep loaded')).toBeTruthy());

    await act(async () => { fireEvent.click(screen.getByLabelText('Keep loaded')); });

    await waitFor(() => expect(screen.getByText(
      'That did not save \u2014 the engine is not ready yet. Try again in a moment.',
    )).toBeTruthy());
    // The dialog is still a dialog, not "Loading settings…" for ever.
    expect(screen.queryByText('Loading settings…')).toBeNull();
    expect(screen.getByLabelText('Keep loaded')).toBeTruthy();
  });

  it('a refused ADD VISION shows the reason without Electron\u2019s wrapper', async () => {
    const models = setupModelsMock({
      addVision: vi.fn().mockRejectedValue(new Error(
        "Error invoking remote method 'models:add-vision': Error: The model is still busy \u2014 try again in a moment.",
      )),
    });
    render(<LocalModelRow model={{ ...unfinished, status: 'complete', vision: 'available' }} onRefresh={async () => {}} />);
    await act(async () => { fireEvent.click(screen.getByText('Add vision')); });
    expect(models.addVision).toHaveBeenCalledWith(unfinished.id);
    await waitFor(() => expect(screen.getByText(
      'The model is still busy \u2014 try again in a moment.',
    )).toBeTruthy());
  });

  it("a download that FAILED after it started shows the downloader's own message", () => {
    // resume() returns as soon as the download starts; an HTTP error or an
    // integrity failure arrives later as an 'error' progress event. This row is
    // the only place that message reaches the user.
    render(<LocalModelRow model={unfinished}
      progress={liveOf('error', { message: 'Hugging Face responded with HTTP 503.' })}
      onRefresh={async () => {}} />);
    expect(screen.getByText('Hugging Face responded with HTTP 503.')).toBeTruthy();
    expect(screen.getByText('Resume')).toBeTruthy();   // and it can be tried again
  });

  it('a live download shows a progress bar and Pause in place of Resume and Delete', () => {
    render(<LocalModelRow model={unfinished} progress={liveOf('downloading')} onRefresh={async () => {}} />);
    expect(screen.getByText('Downloading')).toBeTruthy();          // the band carries the state word
    expect(screen.getByText('70% — 79.2 of 113.0 GB · part 3 of 4')).toBeTruthy();
    expect(screen.getByLabelText('Download progress')).toBeTruthy();
    expect(screen.queryByText('Resume')).toBeNull();
    // WHY Delete is absent while bytes move: two stop-shaped buttons differing
    // only in whether you lose 74 GB is a mistake waiting to happen (Destin,
    // 2026-08-27). Pause keeps every byte, which is the point of the feature.
    expect(screen.queryByText('Delete')).toBeNull();
    expect(screen.getByText('Pause')).toBeTruthy();
  });

  it('an untraceable row offers no Resume, shows no percentage, and says what to do', () => {
    render(<LocalModelRow model={untraceable} onRefresh={async () => {}} />);
    expect(screen.getByText('Damaged')).toBeTruthy();
    expect(screen.queryByText('Resume')).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();      // no total on disk = no honest percentage
    expect(screen.getByText('74.2 GB downloaded')).toBeTruthy();
    // The way out lives behind the (i) rather than as a permanent paragraph
    // under the least useful row — the trigger must still be reachable.
    expect(screen.getByLabelText('Why this download is damaged')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
  });

  it('the delete confirmation names the real number of bytes at stake', async () => {
    render(<LocalModelRow model={unfinished} onRefresh={async () => {}} />);
    await act(async () => { fireEvent.click(screen.getByText('Delete')); });
    expect(screen.getByText(/Delete 74\.2 GB\? This removes every downloaded piece/)).toBeTruthy();
  });

  it('deleting cancels first and waits for the cancelled event when the stream still shows it live', async () => {
    // WHY this ordering matters: removing the .partial out from under an open
    // write stream races. The row hides Delete while a download is live, so the
    // only way in is a STALE stream — confirm on a stopped row, then a progress
    // event lands before the confirm is pressed. That is exactly the window the
    // guard exists for, and it is what this test drives.
    // Order is recorded in a plain array — vitest has no toHaveBeenCalledBefore
    // without jest-extended, which this repo does not use.
    const models = setupModelsMock();
    const order: string[] = [];
    let emit: ((p: DownloadProgress) => void) | null = null;
    models.onDownloadProgress.mockImplementation((cb: (p: DownloadProgress) => void) => { emit = cb; return () => {}; });
    models.downloadCancel.mockImplementation(async () => {
      order.push('cancel');
      emit?.(liveOf('cancelled'));
      return true;
    });
    models.delete.mockImplementation(async () => { order.push('delete'); return true; });

    const { rerender } = render(<LocalModelRow model={unfinished} onRefresh={async () => {}} />);
    await act(async () => { fireEvent.click(screen.getByText('Delete')); });
    rerender(<LocalModelRow model={unfinished} progress={liveOf('downloading')} onRefresh={async () => {}} />);
    await act(async () => { fireEvent.click(screen.getByText('Delete download')); });
    await waitFor(() => expect(order).toEqual(['cancel', 'delete']));
  });
});
