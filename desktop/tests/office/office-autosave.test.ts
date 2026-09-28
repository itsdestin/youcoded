// The Office store's side of autosave and of "one editor per file" (design §4, §5): each
// file's save state for the strip, a closed tab that keeps its editor until it has saved, and
// the in-place editor that gives a file up when the file opens in an Office tab.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOME_TAB, cancelClose, closeDoc, finishClose, flushOffice, holdInline, markChanged, markFailed, markSaved, markSaving,
  officeDocFor, officeTabsNow, openDoc, registerFlush, resetOfficeStoreForTests, saveStateFor, selectTab,
} from '../../src/renderer/components/office/office-store';
import type { OfficeFile } from '../../src/shared/office-types';

const file = (name: string): OfficeFile => ({ path: `/docs/${name}`, name, kind: 'document', folder: 'docs', at: '2026-09-28T00:00:00Z' });
const A = file('a.docx');
const B = file('b.docx');

// The store is module state; each test starts from none.
beforeEach(() => resetOfficeStoreForTests());

describe('save state per file', () => {
  it('reads as saved for a file nothing has happened to', () => {
    expect(saveStateFor(A.path)).toEqual({ phase: 'saved' });
  });

  it('goes unsaved, saving, then saved with the time it landed', () => {
    markChanged(A.path);
    expect(saveStateFor(A.path).phase).toBe('unsaved');
    markSaving(A.path);
    expect(saveStateFor(A.path).phase).toBe('saving');
    markSaved(A.path);
    expect(saveStateFor(A.path).phase).toBe('saved');
    expect(Date.parse(saveStateFor(A.path).savedAt!)).not.toBeNaN();
  });

  it("keeps main's reason for a failed save, and the last good save time", () => {
    markSaved(A.path);
    const at = saveStateFor(A.path).savedAt;
    markFailed(A.path, 'The disk is full, so Office couldn\'t save this file.');
    expect(saveStateFor(A.path)).toEqual({ phase: 'failed', savedAt: at, message: "The disk is full, so Office couldn't save this file." });
  });

  it('keeps one file\'s state apart from another\'s', () => {
    markChanged(A.path);
    expect(saveStateFor(B.path).phase).toBe('saved');
  });
});

describe('closing a tab', () => {
  it('takes it off the strip at once but keeps its editor until it has saved', () => {
    openDoc(A); openDoc(B);
    closeDoc(B.path);
    expect(officeDocFor(B.path)).toMatchObject({ closing: true });
    finishClose(B.path);
    expect(officeDocFor(B.path)).toBeNull();
  });

  it("forgets the closed file's save state", () => {
    openDoc(A);
    markFailed(A.path, 'x');
    closeDoc(A.path);
    finishClose(A.path);
    expect(saveStateFor(A.path).phase).toBe('saved');
  });

  it('reopening a file that is still closing takes the same tab back instead of a second one', () => {
    openDoc(A);
    closeDoc(A.path);
    openDoc(A);
    expect(officeDocFor(A.path)).toMatchObject({ closing: false });
    // Its late "done saving" must not remove the tab the person just opened again.
    finishClose(A.path);
    expect(officeDocFor(A.path)).not.toBeNull();
  });

  it('shows the neighbour when the front tab closes, and Home after the last', () => {
    openDoc(A); openDoc(B);
    selectTab(B.path);
    closeDoc(B.path);
    expect(officeTabsNow().active).toBe(A.path);
    closeDoc(A.path);
    expect(officeTabsNow().active).toBe(HOME_TAB);
  });
});

describe('one editor per file', () => {
  it('saves an in-place editor first, then ends it, when that file opens in an Office tab', async () => {
    let saved!: (r: { ok: true }) => void;
    registerFlush(A.path, () => new Promise((r) => (saved = r)));
    const release = vi.fn();
    holdInline(A.path, release);
    openDoc(A);
    await Promise.resolve();
    // Not yet: its last changes are still being saved.
    expect(release).not.toHaveBeenCalled();
    expect(officeDocFor(A.path)).toBeNull();
    saved({ ok: true });
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(officeDocFor(A.path)).not.toBeNull();
  });

  it('keeps a file in place, with its error showing, when its save fails during the hand-off', async () => {
    registerFlush(A.path, async () => ({ ok: false, message: "Office doesn't have permission to save this file." }));
    const release = vi.fn();
    holdInline(A.path, release);
    openDoc(A);
    await new Promise((r) => setTimeout(r, 0));
    expect(release).not.toHaveBeenCalled();
    expect(officeDocFor(A.path)).toBeNull();
  });

  it('leaves the in-place editor of another file alone', () => {
    const release = vi.fn();
    holdInline(A.path, release);
    openDoc(B);
    expect(release).not.toHaveBeenCalled();
  });

  it('ends an older in-place editor of the same file when a newer one starts', () => {
    const first = vi.fn();
    holdInline(A.path, first);
    holdInline(A.path, vi.fn());
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('forgets an in-place editor that has gone', () => {
    const release = vi.fn();
    const stop = holdInline(A.path, release);
    stop();
    openDoc(A);
    expect(release).not.toHaveBeenCalled();
  });

  it("waits for the file's editor to save before a caller moves on, and resolves at once without one", async () => {
    let saved!: (r: { ok: true }) => void;
    const flush = vi.fn(() => new Promise<{ ok: true }>((r) => (saved = r)));
    registerFlush(A.path, flush);
    let done = false;
    const p = flushOffice(A.path).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    saved({ ok: true });
    await p;
    expect(done).toBe(true);
    await expect(flushOffice(B.path)).resolves.toEqual({ ok: true });
  });

  it("reports a failed save's own reason to the caller", async () => {
    registerFlush(A.path, async () => ({ ok: false, message: 'The disk is full, so Office couldn\'t save this file.' }));
    await expect(flushOffice(A.path)).resolves.toEqual({ ok: false, message: "The disk is full, so Office couldn't save this file." });
  });

  it('brings a tab whose closing save failed back to the front instead of dropping it', () => {
    openDoc(A); openDoc(B);
    closeDoc(B.path);
    cancelClose(B.path);
    expect(officeDocFor(B.path)).toMatchObject({ closing: false });
    expect(officeTabsNow().active).toBe(B.path);
  });
});
