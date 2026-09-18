// @vitest-environment jsdom
//
// LocalModelsSection — the Local Models list: one row per downloaded (or
// half-downloaded) model, its size breakdown bubble, and each model's own
// Settings dialog. Same jsdom + fireEvent shape throughout: this repo has no
// @testing-library/user-event.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { render, cleanup, fireEvent, act, screen, waitFor } from '@testing-library/react';
import { SizeLine, LocalModelRow, setModelSettingsPollMs } from '../src/renderer/components/LocalModelsSection';
import type { DownloadProgress, FitEstimate, InstalledLocalModel, StoredModelSettings } from '../src/shared/model-manager-types';

// ── The row ─────────────────────────────────────────────────────────────────
//
// The copy asserted here is the copy from Destin's design review, which is
// LATER than the draft strings in the implementation plan: the live row's stop
// button says "Pause" (every downloaded byte is kept), removal says "Delete",
// and the state word lives in the coloured band rather than in the progress
// line.

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

describe('LocalModelRow', () => {
  beforeEach(() => { setupModelsMock(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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

// ── Fields main computes that the row must draw ─────────────────────────────
//
// WHY THESE EXIST. Every field below was already being produced by the
// backend and thrown away by the renderer, which is invisible in every other
// kind of test: types pass, main's own tests pass, and the user simply never
// finds out. Each guard therefore comes in a PAIR — the text appears when the
// field is set, and it is ABSENT when the field is not there at all. Absence,
// not zero: this feature already shipped a guard that passed because a timeout
// produced the same value as success.

// The exact sentence the contract signs off (R8). It is written ONCE, in
// fit-estimator.ts; the renderer only passes it through. Hard-coded here so a
// reworded estimator has to come past this test.
const ADVICE = "Lower this model's context length in its Settings to shrink this.";

// A 4B-class model at the engine's 32k default: 2.4 GB of weights, 1.6 GB of
// context memory.
const MODEL_BYTES = 2_580_000_000;
const CONTEXT_BYTES = 1_744_830_464;

function quantWith(breakdown: Partial<NonNullable<FitEstimate['breakdown']>>, fit: FitEstimate['fit'] = 'tight') {
  return {
    totalSizeBytes: MODEL_BYTES,
    quant: 'UD-Q4_K_XL',
    fit: {
      fit,
      label: 'Will be tight — close other apps first',
      breakdown: { modelBytes: MODEL_BYTES, contextBytes: CONTEXT_BYTES, contextLength: 32768, ...breakdown },
    } as FitEstimate,
  };
}

/** Hover the dotted number with a MOUSE to open the breakdown bubble.
 *  pointerType matters since 2026-09-06: the bubble ignores the phantom mouse
 *  events a touchscreen replays after a tap (contract R20), so a hover has to
 *  say it came from a mouse. */
function openBubble() {
  fireEvent.pointerEnter(screen.getByLabelText(/is made of$/), { pointerType: 'mouse' });
}

// The dialog's own poll interval, wound down. Every guard below still watches a
// REAL poll happen against the real component — this only shortens the gap
// between them, using the value the dialog itself reads, so no test can drift
// away from the shipped number by keeping a copy of it.
let shippedPollMs = 0;
/** Comfortably longer than one poll tick, so "nothing happened" means the poll
 *  really did get its chance and chose not to act. */
const APOLL = 250;
/** Waiting on something the poll must eventually do. Generous next to a 50 ms
 *  interval, so a loaded machine cannot fail a correct guard. */
const POLLED = { timeout: 3_000, interval: 20 } as const;

// ── A model's own Settings dialog ────────────────────────────────────────────

const COMPLETE: InstalledLocalModel = {
  id: 'gemma-4-E4B-it-UD-Q4_K_XL', sizeBytes: MODEL_BYTES,
  quant: 'UD-Q4_K_XL', quantDescription: 'Balanced', parts: 1, status: 'complete',
  partsPresent: 1, totalSizeBytes: MODEL_BYTES, repo: 'unsloth/gemma-4-E4B-it-GGUF',
};

const SETTINGS: StoredModelSettings = {
  contextLength: null, keepLoaded: false, gpuLayers: 'auto', extraFlags: '', memoryWarningDismissed: null,
};

/** A models API whose reads and saves resolve only when the test says so, so the
 *  order two answers come back in can be driven deliberately. */
function deferredModels(firstRead: StoredModelSettings) {
  const reads: Array<{ resolve: (v: StoredModelSettings) => void; reject: (e: unknown) => void }> = [];
  const saves: Array<{ resolve: (v: StoredModelSettings) => void; reject: (e: unknown) => void }> = [];
  let readCount = 0;
  const models = {
    settings: vi.fn(() => {
      readCount += 1;
      // The first read resolves at once so the dialog can open; every later one
      // is held for the test.
      if (readCount === 1) return Promise.resolve(firstRead);
      return new Promise<StoredModelSettings>((resolve, reject) => { reads.push({ resolve, reject }); });
    }),
    setSettings: vi.fn(() => new Promise<StoredModelSettings>((resolve, reject) => { saves.push({ resolve, reject }); })),
    delete: vi.fn().mockResolvedValue(true),
    downloadCancel: vi.fn().mockResolvedValue(true),
    onDownloadProgress: vi.fn().mockReturnValue(() => {}),
  };
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = { models };
  return { models, reads, saves };
}

/** Open the dialog on a row whose models API is already installed. */
async function openDialog() {
  render(<LocalModelRow model={COMPLETE} onRefresh={async () => {}} />);
  await act(async () => { fireEvent.click(screen.getByLabelText(/^Settings for /)); });
  await waitFor(() => expect(screen.getByText('Context length')).toBeTruthy());
}

/** Mount the row with a stubbed models API and open its Settings dialog.
 *  `later`, when given, is what every fetch AFTER the first one answers — which
 *  is how a pending save landing in the background is driven. */
async function openSettings(settings: StoredModelSettings, later?: StoredModelSettings) {
  (globalThis as any).window = (globalThis as any).window ?? {};
  let calls = 0;
  (globalThis as any).window.claude = {
    models: {
      settings: vi.fn(async () => (later && calls++ > 0 ? later : settings)),
      setSettings: vi.fn().mockResolvedValue(settings),
      delete: vi.fn().mockResolvedValue(true),
      downloadCancel: vi.fn().mockResolvedValue(true),
      onDownloadProgress: vi.fn().mockReturnValue(() => {}),
    },
  };
  render(<LocalModelRow model={COMPLETE} onRefresh={async () => {}} />);
  await act(async () => { fireEvent.click(screen.getByLabelText(/^Settings for /)); });
  // The dialog fetches asynchronously; nothing below is meaningful until the
  // settings have landed and the rows exist.
  await waitFor(() => expect(screen.getByText('Context length')).toBeTruthy());
}

const LOAD_ERROR_TITLE = 'This model failed to load last time';

describe('fields main computes', () => {
  beforeAll(() => { shippedPollMs = setModelSettingsPollMs(50); });
  afterAll(() => { setModelSettingsPollMs(shippedPollMs); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  describe('the size breakdown bubble', () => {
    it('R8: ends with the estimator’s advice when the verdict carries one', () => {
      render(<SizeLine q={quantWith({ advice: ADVICE })} />);
      openBubble();
      expect(screen.getByText(ADVICE)).toBeTruthy();
    });

    it('R8: the advice is the LAST thing in the bubble', () => {
      // The contract says the bubble "ends with" it. Moved above the memory
      // figure, every other assertion in this file still passed.
      render(<SizeLine q={quantWith({ advice: ADVICE })} />);
      openBubble();
      const rows = screen.getByText(ADVICE).parentElement as HTMLElement;
      expect((rows.lastElementChild as HTMLElement).textContent).toBe(ADVICE);
    });

    it('hedges the RUNNING-MEMORY total too, not just the small print', () => {
      // 2.4 GB of weights + 1.6 GB of context = 4.0 GB. The total contains the
      // estimated term, so stating it exactly is the same fake precision one line
      // lower down — and the total is the number a user actually decides on.
      render(<SizeLine q={quantWith({ contextBytesIsUpperBound: true })} />);
      openBubble();
      expect(screen.getByText('up to 4.0 GB')).toBeTruthy();
      cleanup();
      render(<SizeLine q={quantWith({})} />);
      openBubble();
      expect(screen.getByText('4.0 GB')).toBeTruthy();
    });

    it('R8: has NO advice line when the estimator sent none', () => {
      render(<SizeLine q={quantWith({}, 'fits')} />);
      openBubble();
      // The bubble really is open — otherwise "no advice" would pass for a bubble
      // that never rendered anything at all.
      expect(screen.getByText('Model file')).toBeTruthy();
      expect(screen.queryByText(ADVICE)).toBeNull();
    });

    it('says "up to" for the context share when it is an upper bound', () => {
      render(<SizeLine q={quantWith({ contextBytesIsUpperBound: true })} />);
      openBubble();
      expect(screen.getByText('includes up to 1.6 GB for a 32k context')).toBeTruthy();
    });

    it('states the context share exactly when it is a reading', () => {
      render(<SizeLine q={quantWith({})} />);
      openBubble();
      expect(screen.getByText('includes 1.6 GB for a 32k context')).toBeTruthy();
      expect(screen.queryByText(/up to/)).toBeNull();
    });
  });

  describe('a model’s settings dialog', () => {
    it('R26: shows why the model last failed to load, in the ENGINE’S own words', async () => {
      await openSettings({ ...SETTINGS, lastLoadError: 'error: invalid argument: --tempp' });
      // "last time": main clears this only on a SUCCESSFUL load, so the card
      // outlives the problem and must not claim the model is broken right now.
      expect(screen.getByText(LOAD_ERROR_TITLE)).toBeTruthy();
      // Verbatim. A paraphrase would send the user to fix something else.
      const line = screen.getByText('error: invalid argument: --tempp');
      expect(line).toBeTruthy();
      // Engine errors carry long unbroken paths; without this they overflow the
      // dialog and hide everything after them.
      expect(line.className).toContain('break-words');
    });

    it('R26: the load-error card is the FIRST thing in the dialog', async () => {
      // Its own WHY comment argues this at length — the extra-flags box that most
      // often causes it is behind a collapsed Advanced row, and a message under
      // that is a message nobody reads. Nothing enforced the position.
      await openSettings({ ...SETTINGS, lastLoadError: 'error: invalid argument: --tempp' });
      const body = screen.getByTestId('model-settings');
      const first = body.firstElementChild as HTMLElement;
      expect(first.textContent).toContain(LOAD_ERROR_TITLE);
    });

    it('R26: opens Advanced when the model failed to load, and leaves it shut otherwise', async () => {
      // The flags box lives inside Advanced. The card above still does NOT name
      // the flags as the cause — an unreadable file and a machine out of memory
      // arrive in exactly the same field.
      await openSettings({ ...SETTINGS, lastLoadError: "error: option '--tempp' not recognized in preset 'x'" });
      expect(screen.getByLabelText('Extra engine flags')).toBeTruthy();
      cleanup();
      await openSettings(SETTINGS);
      expect(screen.queryByLabelText('Extra engine flags')).toBeNull();
    });

    it('R26: shows no load-error card when the model has not failed', async () => {
      await openSettings(SETTINGS);
      expect(screen.queryByText(LOAD_ERROR_TITLE)).toBeNull();
    });

    it('says a saved change waits for the reply on screen', async () => {
      await openSettings({ ...SETTINGS, keepLoaded: true, pendingApply: true });
      expect(screen.getByText('Applies after the current reply.')).toBeTruthy();
    });

    it('says nothing about waiting once the change is in force', async () => {
      await openSettings({ ...SETTINGS, keepLoaded: true });
      expect(screen.queryByText('Applies after the current reply.')).toBeNull();
    });

    it('the waiting line CLEARS once the change lands, without closing the dialog', async () => {
      // There is no push channel for per-model settings, so the dialog re-asks.
      // Fetched once, it would sit there saying "Applies after the current reply"
      // for as long as it is open — the user closes it, reopens it, and concludes
      // the setting never stuck.
      await openSettings(
        { ...SETTINGS, keepLoaded: true, pendingApply: true },
        { ...SETTINGS, keepLoaded: true },
      );
      expect(screen.getByText('Applies after the current reply.')).toBeTruthy();
      await waitFor(
        () => expect(screen.queryByText('Applies after the current reply.')).toBeNull(),
        POLLED,
      );
    });

    it('re-asking main never wipes what the user is halfway through typing', async () => {
      // The poll re-reads every field. Seeded into the two text drafts on every
      // pass instead of once, a user typing a context length while a save is
      // pending watches it vanish under them two seconds later.
      await openSettings({ ...SETTINGS, contextLength: 8192, pendingApply: true });
      const box = screen.getByLabelText('Context length for this model') as HTMLInputElement;
      fireEvent.change(box, { target: { value: '4096' } });
      await new Promise((r) => setTimeout(r, APOLL));
      expect((screen.getByLabelText('Context length for this model') as HTMLInputElement).value).toBe('4096');
    });

    it('a read already IN FLIGHT cannot undo the switch the user just flipped', async () => {
      // The bug the first version of the poll shipped. Refusing to START a read
      // during a save does nothing about one already in the air: it carries the
      // values main held BEFORE the save and lands after it. What the user saw —
      // "Keep loaded" turns on, flips itself off a moment later, then back on two
      // seconds after that. The setting saved perfectly; only the screen lied.
      const { reads, saves } = deferredModels({ ...SETTINGS, keepLoaded: false });
      await openDialog();
      // A poll goes out, and is still in the air…
      await waitFor(() => expect(reads.length).toBeGreaterThan(0), POLLED);
      // …when the user turns the switch on, and the save comes back first.
      await act(async () => { fireEvent.click(screen.getByLabelText('Keep loaded')); });
      await act(async () => { saves[0].resolve({ ...SETTINGS, keepLoaded: true }); await Promise.resolve(); });
      expect(screen.getByLabelText('Keep loaded').getAttribute('aria-checked')).toBe('true');
      // Now the stale answer lands. It must be thrown away, not drawn.
      await act(async () => { reads[0].resolve({ ...SETTINGS, keepLoaded: false }); await Promise.resolve(); });
      expect(screen.getByLabelText('Keep loaded').getAttribute('aria-checked')).toBe('true');
    });

    it('two reads in the air, and the SLOWER one cannot win by finishing last', async () => {
      // Whenever a read takes longer than the poll interval there are two of them
      // outstanding, and order of arrival is not order of issue.
      const { reads } = deferredModels({ ...SETTINGS, keepLoaded: false });
      await openDialog();
      await waitFor(() => expect(reads.length).toBeGreaterThanOrEqual(2), POLLED);
      // The NEWER read answers first…
      await act(async () => { reads[1].resolve({ ...SETTINGS, keepLoaded: true }); await Promise.resolve(); });
      expect(screen.getByLabelText('Keep loaded').getAttribute('aria-checked')).toBe('true');
      // …and the older one, arriving late, is ignored.
      await act(async () => { reads[0].resolve({ ...SETTINGS, keepLoaded: false }); await Promise.resolve(); });
      expect(screen.getByLabelText('Keep loaded').getAttribute('aria-checked')).toBe('true');
    });

    it('one failed read does not leave a red line under a working dialog', async () => {
      // Before the poll this could not happen: the read failed and the dialog
      // stayed on the failure. Now the next read succeeds two seconds later and
      // draws the whole working dialog — with a stale "could not read" line under
      // it for as long as it is open.
      let calls = 0;
      (globalThis as any).window = (globalThis as any).window ?? {};
      (globalThis as any).window.claude = {
        models: {
          settings: vi.fn(async () => {
            calls += 1;
            if (calls === 1) throw new Error('Could not read this model’s settings.');
            return SETTINGS;
          }),
          setSettings: vi.fn().mockResolvedValue(SETTINGS),
          delete: vi.fn().mockResolvedValue(true),
          downloadCancel: vi.fn().mockResolvedValue(true),
          onDownloadProgress: vi.fn().mockReturnValue(() => {}),
        },
      };
      render(<LocalModelRow model={COMPLETE} onRefresh={async () => {}} />);
      await act(async () => { fireEvent.click(screen.getByLabelText(/^Settings for /)); });
      await waitFor(() => expect(screen.getByText('Could not read this model’s settings.')).toBeTruthy());
      await waitFor(
        () => expect(screen.queryByText('Could not read this model’s settings.')).toBeNull(),
        POLLED,
      );
      expect(screen.getByText('Context length')).toBeTruthy();
    });

    it('a save that FAILS does not freeze the dialog’s live values', async () => {
      // The suppression is released in a `finally`. Left set, one failed save
      // would stop every poll for as long as the dialog stayed open — and the
      // pending line and the load-error card are exactly what the poll is for.
      let calls = 0;
      (globalThis as any).window = (globalThis as any).window ?? {};
      (globalThis as any).window.claude = {
        models: {
          settings: vi.fn(async () => { calls += 1; return calls > 1 ? { ...SETTINGS, lastLoadError: 'error: out of memory' } : SETTINGS; }),
          setSettings: vi.fn().mockRejectedValue(new Error('Disk is full.')),
          delete: vi.fn().mockResolvedValue(true),
          downloadCancel: vi.fn().mockResolvedValue(true),
          onDownloadProgress: vi.fn().mockReturnValue(() => {}),
        },
      };
      await openDialog();
      await act(async () => { fireEvent.click(screen.getByLabelText('Keep loaded')); });
      await waitFor(() => expect(screen.getByText('Disk is full.')).toBeTruthy());
      await waitFor(() => expect(screen.getByText('error: out of memory')).toBeTruthy(), POLLED);
      // …and the save failure is still on screen: it is the user's, not the
      // poll's, and a successful read must not wipe it.
      expect(screen.getByText('Disk is full.')).toBeTruthy();
    });

    it('no read is even ASKED FOR while a save is in flight', async () => {
      // The check inside the answer catches a read that was already in the air.
      // This is the other half: not starting one at all, so an answer that
      // predates the save's write cannot exist in the first place.
      const { models, saves, reads } = deferredModels({ ...SETTINGS, keepLoaded: false });
      await openDialog();
      const before = models.settings.mock.calls.length;
      await act(async () => { fireEvent.click(screen.getByLabelText('Keep loaded')); });
      await new Promise((r) => setTimeout(r, APOLL));     // a poll tick passes
      expect(models.settings.mock.calls.length).toBe(before);
      // …and once the save lands, polling resumes.
      await act(async () => { saves[0].resolve({ ...SETTINGS, keepLoaded: true }); await Promise.resolve(); });
      await waitFor(() => expect(models.settings.mock.calls.length).toBeGreaterThan(before), POLLED);
      expect(reads.length).toBeGreaterThan(0);
    });

    it('two saves in flight — the SLOWER one cannot repaint the older value', async () => {
      // Reachable without contriving anything: saving Extra engine flags makes
      // main RUN the engine binary to check them, which takes seconds, while
      // saving a toggle comes back at once. Type a flag, blur, then hit Keep
      // loaded, and the flags answer lands last carrying the value from before
      // the toggle — the switch turns itself back off under the user's hand.
      const { saves } = deferredModels({ ...SETTINGS, keepLoaded: false, extraFlags: '' });
      await openDialog();
      // The slow save first: a flag, which main validates by running the binary.
      // The flags box lives behind Advanced.
      await act(async () => { fireEvent.click(screen.getByText('Advanced')); });
      const flags = screen.getByLabelText('Extra engine flags');
      await act(async () => { fireEvent.change(flags, { target: { value: '--temp 0.6' } }); fireEvent.blur(flags); });
      // Then the fast one, which answers straight away.
      await act(async () => { fireEvent.click(screen.getByLabelText('Keep loaded')); });
      expect(saves).toHaveLength(2);
      await act(async () => { saves[1].resolve({ ...SETTINGS, extraFlags: '', keepLoaded: true }); await Promise.resolve(); });
      expect(screen.getByLabelText('Keep loaded').getAttribute('aria-checked')).toBe('true');
      // …and now the slow one lands, carrying the world as it was before the click.
      await act(async () => { saves[0].resolve({ ...SETTINGS, extraFlags: '--temp 0.6', keepLoaded: false }); await Promise.resolve(); });
      expect(screen.getByLabelText('Keep loaded').getAttribute('aria-checked')).toBe('true');
    });

    it('two saves REFUSED at once — neither message is swallowed by the other', async () => {
      // Same reachable shape as the ordering bug, on the failure path: a bad
      // extra flag is checked by RUNNING the engine binary and is refused seconds
      // later, while a bad context length is refused at once. One slot means the
      // late refusal overwrites the early one and the user never learns their
      // context length was rejected — and which survives is pure timing.
      const { saves } = deferredModels({ ...SETTINGS, extraFlags: '' });
      await openDialog();
      await act(async () => { fireEvent.click(screen.getByText('Advanced')); });
      const flags = screen.getByLabelText('Extra engine flags');
      await act(async () => { fireEvent.change(flags, { target: { value: '--tempp 0.6' } }); fireEvent.blur(flags); });
      const box = screen.getByLabelText('Context length for this model');
      await act(async () => { fireEvent.change(box, { target: { value: '999999' } }); fireEvent.blur(box); });
      expect(saves).toHaveLength(2);
      // The quick refusal first, then the slow one — the order that loses a
      // message when there is only one slot.
      await act(async () => { saves[1].reject(new Error('Context length must be at most 131072 tokens.')); await Promise.resolve(); });
      await act(async () => { saves[0].reject(new Error("error: option '--tempp' not recognized")); await Promise.resolve(); });
      expect(screen.getByText('Context length must be at most 131072 tokens.')).toBeTruthy();
      expect(screen.getByText("error: option '--tempp' not recognized")).toBeTruthy();
    });

    it('the same refusal twice is one message, not two', async () => {
      // Additive must not mean repetitive: the same sentence twice is noise.
      const { saves } = deferredModels({ ...SETTINGS, extraFlags: '' });
      await openDialog();
      await act(async () => { fireEvent.click(screen.getByText('Advanced')); });
      const flags = screen.getByLabelText('Extra engine flags');
      await act(async () => { fireEvent.change(flags, { target: { value: '--a' } }); fireEvent.blur(flags); });
      await act(async () => { fireEvent.click(screen.getByLabelText('Keep loaded')); });
      await act(async () => { saves[0].reject(new Error('Disk is full.')); await Promise.resolve(); });
      await act(async () => { saves[1].reject(new Error('Disk is full.')); await Promise.resolve(); });
      expect(screen.getAllByText('Disk is full.')).toHaveLength(1);
    });

    it('a fresh attempt clears what the last one said', async () => {
      const { saves } = deferredModels(SETTINGS);
      await openDialog();
      await act(async () => { fireEvent.click(screen.getByLabelText('Keep loaded')); });
      await act(async () => { saves[0].reject(new Error('Disk is full.')); await Promise.resolve(); });
      expect(screen.getByText('Disk is full.')).toBeTruthy();
      await act(async () => { fireEvent.click(screen.getByLabelText('Keep loaded')); });
      expect(screen.queryByText('Disk is full.')).toBeNull();
    });

    it('two overlapping saves — the first one finishing does not unblock the poll', async () => {
      // A flag, rather than a count, would have the first save's cleanup announce
      // that nothing is saving while the second is still in the air.
      const { models, saves } = deferredModels({ ...SETTINGS, keepLoaded: false });
      await openDialog();
      const before = models.settings.mock.calls.length;
      await act(async () => { fireEvent.click(screen.getByLabelText('Keep loaded')); });
      // A second, different save while the first is still in the air.
      const box = screen.getByLabelText('Context length for this model');
      await act(async () => { fireEvent.change(box, { target: { value: '8192' } }); fireEvent.blur(box); });
      expect(saves).toHaveLength(2);
      await act(async () => { saves[0].resolve({ ...SETTINGS, keepLoaded: true }); await Promise.resolve(); });
      await new Promise((r) => setTimeout(r, APOLL));
      expect(models.settings.mock.calls.length).toBe(before);
    });

    it('closing the dialog stops the polling, and a late answer changes nothing', async () => {
      const { reads, models } = deferredModels(SETTINGS);
      await openDialog();
      await waitFor(() => expect(reads.length).toBeGreaterThan(0), POLLED);
      cleanup();
      const after = models.settings.mock.calls.length;
      // A late answer to a closed dialog must not try to draw into it.
      await act(async () => { reads[0].resolve({ ...SETTINGS, lastLoadError: 'too late' }); await Promise.resolve(); });
      await new Promise((r) => setTimeout(r, APOLL));
      expect(models.settings.mock.calls.length).toBe(after);
      expect(screen.queryByText('too late')).toBeNull();
    });

    it('a load error that arrives while the dialog is open reaches the user', async () => {
      // Same staleness, other field: a model fails on its next request, and a
      // dialog that read main once would never say so.
      await openSettings(SETTINGS, { ...SETTINGS, lastLoadError: 'error: out of memory' });
      expect(screen.queryByText(LOAD_ERROR_TITLE)).toBeNull();
      await waitFor(
        () => expect(screen.getByText('error: out of memory')).toBeTruthy(),
        POLLED,
      );
    });
  });
});
