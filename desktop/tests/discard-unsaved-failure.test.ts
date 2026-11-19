// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { holdUnsavedEditor, discardUnsaved, unsavedEditsNow, resetUnsavedEditorsForTests } from '../src/renderer/state/unsaved-editors';
import { APP_NOTICE_EVENT } from '../src/renderer/utils/announce';

// R-1 batch 1 (Destin H-2): a discard that fails is logged, never shown — the quit still goes on and the other
// files are still discarded.
afterEach(() => { resetUnsavedEditorsForTests(); vi.restoreAllMocks(); });

describe('discardUnsaved', () => {
  it('logs a failing discard, carries on with the rest, and shows no pop-up', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const toasts: unknown[] = []; const on = (e: Event) => toasts.push(e); window.addEventListener(APP_NOTICE_EVENT, on);
    const second = vi.fn();
    holdUnsavedEditor({ name: 'a.docx', discard: () => Promise.reject(new Error('journal locked')) });
    holdUnsavedEditor({ name: 'b.txt', discard: second });
    await expect(discardUnsaved(unsavedEditsNow())).resolves.toBeUndefined();
    expect(second).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toContain('journal locked');
    expect(toasts).toEqual([]);
    window.removeEventListener(APP_NOTICE_EVENT, on);
  });
});
